// AgentSessionEvent → SyncEvent translator.
//
// The pi-coding-agent SDK emits `AgentSessionEvent`s (defined in
// `@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts`) with a
// vocabulary designed for a terminal coding harness (bash_execution_update,
// queue_update, compaction_start/end, entry_appended, …).
//
// AgentCanvas emits `SyncEvent`s (defined in `../canvas/types.ts`) with a
// vocabulary designed for a web design tool (agent:message_delta,
// agent:tool_call_start/end, agent:turn_end, …) that the React UI and
// Socket.IO service already consume.
//
// This module is the bridge. It subscribes to AgentSessionEvents and yields
// AgentStreamEvents (which wrap SyncEvents + patches). The new runner uses
// this to translate the SDK's event stream into the shape the rest of the
// app expects — keeping the UI / WebSocket / session-store code unchanged
// even though the agent loop underneath is now the native Pi Agent SDK.
//
// ---- Why a generator (not a callback) -------------------------------------
//
// The runner is an `async function*` that yields AgentStreamEvents as the
// agent runs. To integrate the SDK's callback-based `session.subscribe()`
// API with the runner's generator shape, we use an async queue: the
// subscribe listener pushes events onto the queue; the generator drains
// them. This avoids the back-pressure issues of a callback-based approach
// (the UI's NDJSON stream is much slower than the SDK can emit).

import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { CanvasPatch, SyncEvent } from '../canvas/types';
import type { AgentStreamEvent } from './runner-types';

// ---- Public types -----------------------------------------------------------

/// Output of the translator: zero or more AgentStreamEvents per SDK event.
export type TranslatedEvents = AgentStreamEvent[];

// ---- Patch extraction ------------------------------------------------------
//
// Our 88 tools return their patches inside `AgentToolResult.details`:
//
//   {
//     content: [{ type: 'text', text: 'Created rectangle with id abc.' }],
//     details: { shapeId: 'abc', patch: { op: 'add', shapeId: 'abc', shape: {...}, summary: '...' } }
//   }
//
// or for multi-patch tools (e.g. pen_update_shape with a `parent` arg emits
// both an `update` and a `reparent` patch):
//
//   {
//     content: [...],
//     details: { patches: [patch1, patch2], ... }
//   }
//
// The SDK passes the full AgentToolResult back to us in the
// `tool_execution_end` event's `result` field. We extract the patches here
// and yield them as separate `patch` events so the UI / socket.io fans
// them out to all viewers.
//
// The `details` field is typed as `unknown` in the SDK (it's generic on
// TDetails), so we cast to `any` to read `patch` / `patches` off it.

function extractPatchesFromToolResult(result: unknown): { patches: CanvasPatch[]; summary: string } {
  if (!result || typeof result !== 'object') return { patches: [], summary: '' };
  const r = result as any;
  const details = r.details ?? {};
  const patch = details.patch as CanvasPatch | undefined;
  const patches = Array.isArray(details.patches) ? (details.patches as CanvasPatch[]) : undefined;
  const all = patches && patches.length > 0 ? patches : (patch ? [patch] : []);
  const summary = (all.at(-1)?.summary as string | undefined) ?? '';
  return { patches: all, summary };
}

// ---- The translator --------------------------------------------------------
//
// `translate(event)` returns an array of AgentStreamEvents. The runner
// iterates the array and yields each one. Some events translate to nothing
// (e.g. `session_info_changed` — we don't surface session names in the UI);
// others translate to multiple events (e.g. `tool_execution_end` yields both
// `patch` events for each patch AND an `agent:tool_call_end` event).
//
// ---- Duplicate-event suppression -------------------------------------------
//
// The SDK can emit closing events redundantly: a normal turn fires BOTH
// `message_end` AND `agent_end` (which used to re-emit `message_end` +
// `turn_end` unconditionally), and retry loops fire multiple
// message_start/message_end pairs. The UI / session store treats each
// `agent:message_end` / `agent:turn_end` as a state transition, so duplicates
// double-finalize runs. Pass a TranslatorState (see subscribeAndTranslate)
// to suppress duplicates: message_end is emitted only when a message is open,
// and turn_end exactly once per prompt cycle.

export interface TranslatorState {
  /// True between message_start and message_end (a message is streaming).
  messageOpen: boolean;
  /// True once agent_end has been translated for this prompt cycle.
  turnEnded: boolean;
}

export function createTranslatorState(): TranslatorState {
  return { messageOpen: false, turnEnded: false };
}

export function translateAgentSessionEvent(event: AgentSessionEvent, state?: TranslatorState): TranslatedEvents {
  const out: TranslatedEvents = [];

  switch (event.type) {
    // ---- Message streaming ----
    case 'message_start': {
      // Defensive: if a previous message never closed (e.g. mid-stream error),
      // close it first so the UI's message state machine stays balanced.
      if (state?.messageOpen) {
        out.push({ kind: 'agent_event', event: { type: 'agent:message_end' } });
      }
      state && (state.messageOpen = true);
      out.push({ kind: 'agent_event', event: { type: 'agent:message_start', role: 'assistant' } });
      break;
    }

    case 'message_update': {
      // AssistantMessageEvent is a discriminated union — text_delta | thinking_delta | tool_call_start | tool_call_delta | tool_call_end | usage | image | ...
      const ame = (event as any).assistantMessageEvent;
      if (!ame) break;
      if (ame.type === 'text_delta' && typeof ame.delta === 'string') {
        out.push({ kind: 'agent_event', event: { type: 'agent:message_delta', text: ame.delta } });
      } else if (ame.type === 'thinking_delta' && typeof ame.delta === 'string') {
        out.push({ kind: 'agent_event', event: { type: 'agent:thinking_delta', text: ame.delta } });
      }
      // Other assistantMessageEvent types (tool_call_start/delta/end, usage, image)
      // don't need separate SyncEvents — we emit our own tool_call_start/end
      // from the SDK's tool_execution_start/end events below.
      break;
    }

    case 'message_end': {
      // Suppress duplicate closes: only emit when a message is actually open.
      if (!state || state.messageOpen) {
        out.push({ kind: 'agent_event', event: { type: 'agent:message_end' } });
        state && (state.messageOpen = false);
      }
      break;
    }

    // ---- Tool execution ----
    case 'tool_execution_start': {
      const e = event as any;
      const toolCallId: string = e.toolCallId ?? '';
      const toolName: string = e.toolName ?? '';
      // The SDK doesn't expose a pre-formatted args preview; we render a short
      // JSON snapshot from the args object.
      let argsPreview = '';
      try {
        argsPreview = JSON.stringify(e.args ?? {}).slice(0, 120);
      } catch {
        argsPreview = '(unserializable args)';
      }
      out.push({
        kind: 'agent_event',
        event: { type: 'agent:tool_call_start', toolCallId, toolName, argsPreview },
      });
      break;
    }

    case 'tool_execution_end': {
      const e = event as any;
      const toolCallId: string = e.toolCallId ?? '';
      const isError: boolean = e.isError === true;
      // Extract canvas patches from the tool result's `details` field.
      const { patches, summary } = extractPatchesFromToolResult(e.result);
      for (const patch of patches) {
        out.push({ kind: 'patch', patch, toolCallId });
      }
      // Render a short result summary for the UI's tool-call card.
      let resultPreview = summary;
      if (!resultPreview) {
        try {
          const content = (e.result as any)?.content;
          if (Array.isArray(content)) {
            resultPreview = content.map((c: any) => c?.text ?? '').join('\n').slice(0, 160);
          }
        } catch {
          resultPreview = '';
        }
      }
      out.push({
        kind: 'agent_event',
        event: {
          type: 'agent:tool_call_end',
          toolCallId,
          success: !isError,
          summary: resultPreview,
        },
      });
      break;
    }

    // ---- Turn / agent lifecycle ----
    case 'turn_end': {
      // Don't emit agent:turn_end here — we emit it from agent_end instead,
      // because the SDK sometimes emits turn_end events for sub-turns
      // (e.g. after a compaction retry). The agent:turn_end SyncEvent should
      // fire exactly once per top-level prompt() call.
      break;
    }

    case 'agent_end': {
      // The SDK emits message_end separately; only emit it here if the message
      // is still open (error mid-stream closed it without a message_end).
      // turn_end must fire exactly ONCE per prompt cycle — suppress if the
      // state already recorded one (retry loops can re-fire agent_end).
      if (!state || state.messageOpen) {
        out.push({ kind: 'agent_event', event: { type: 'agent:message_end' } });
        state && (state.messageOpen = false);
      }
      if (!state || !state.turnEnded) {
        out.push({ kind: 'agent_event', event: { type: 'agent:turn_end' } });
        state && (state.turnEnded = true);
      }
      break;
    }

    // ---- Compaction ----
    case 'compaction_start': {
      // We don't have a "compaction_start" SyncEvent; we'll emit a
      // context_update event after compaction_end (below) when we know
      // the new token count. Could emit a `agent:message_delta` notice
      // here, but that would pollute the chat — keep it silent.
      break;
    }

    case 'compaction_end': {
      const e = event as any;
      const result = e.result;
      const tokensBefore: number = result?.tokensBefore ?? 0;
      const tokensAfter: number = result?.estimatedTokensAfter ?? 0;
      out.push({
        kind: 'agent_event',
        event: {
          type: 'agent:context_update',
          tokenCount: tokensAfter,
          contextWindow: 128_000, // GLM-4.6 default; SDK doesn't expose per-model window here
          compacted: true,
        },
      });
      // Surface a small chat notice so the user sees what happened.
      const saved = Math.max(0, tokensBefore - tokensAfter);
      if (saved > 0) {
        out.push({
          kind: 'agent_event',
          event: {
            type: 'agent:message_delta',
            text: `\n\n_[Context compacted: ~${saved} tokens saved]_`,
          },
        });
      }
      break;
    }

    // ---- Context usage ----
    case 'entry_appended': {
      // The SDK appends an entry to the session journal after each turn.
      // We could surface this as a context_update event, but it fires
      // too frequently to be useful as UI feedback. Skip — compaction_end
      // above is the user-visible context event.
      break;
    }

    // ---- Things we deliberately drop ----
    case 'agent_start':
    case 'agent_settled':
    case 'session_info_changed':
    case 'thinking_level_changed':
    case 'queue_update':
    case 'auto_retry_start':
    case 'auto_retry_end':
    case 'summarization_retry_scheduled':
    case 'summarization_retry_attempt_start':
    case 'summarization_retry_finished':
    case 'bash_execution_update':
      // These are TUI/CLI-oriented events that have no Web UI equivalent.
      // Bash execution doesn't apply (we have noTools:'all' so the bash
      // tool is never registered). Auto-retry is silent (the llm-retry
      // module already handles user-visible backoff for the OpenAI-shaped
      // LLM calls; the SDK's own retry is internal and shouldn't surface
      // in chat). Queue updates (steer/followUp) are handled separately
      // by the runner's own steer() integration.
      break;

    default: {
      // Unknown event — log and drop. We use a runtime check on `event.type`
      // so future SDK additions don't crash the translator.
      // (No `console.log` per AGENTS.md — the runner can subscribe to
      // `unknown` events separately if it wants telemetry.)
      break;
    }
  }

  return out;
}

// ---- Async queue bridge ----------------------------------------------------
//
// The SDK's `session.subscribe(listener)` is callback-based. The runner is
// generator-based. We bridge the two with an async queue.
//
// Usage in the runner:
//
//   const queue = createEventQueue();
//   const unsubscribe = session.subscribe(queue.push);
//   try {
//     await session.prompt(text);
//     // Drain any remaining events.
//     for await (const ev of queue.drain()) { yield ev; }
//   } finally {
//     unsubscribe();
//     queue.close();
//   }
//
// The `done` flag tells the queue that no more events will be pushed (because
// prompt() resolved). Drain yields anything still buffered, then exits.

export interface EventQueue {
  /// Push a translated event array onto the queue. Called by the SDK subscribe listener.
  push: (events: TranslatedEvents) => void;
  /// Async iterator that yields AgentStreamEvents one at a time. Exits when
  /// `close()` has been called AND the buffer is empty.
  drain: () => AsyncIterable<AgentStreamEvent>;
  /// Mark the queue as closed. No more pushes accepted; drain will exit
  /// after yielding everything currently buffered.
  close: () => void;
}

export function createEventQueue(): EventQueue {
  const buffer: AgentStreamEvent[] = [];
  let waiters: Array<() => void> = [];
  let closed = false;

  const push = (events: TranslatedEvents) => {
    if (closed) return;
    for (const ev of events) buffer.push(ev);
    // Wake up any pending drain() iterators.
    const woken = waiters;
    waiters = [];
    for (const w of woken) w();
  };

  const drain = async function* (): AsyncGenerator<AgentStreamEvent> {
    while (true) {
      while (buffer.length > 0) {
        yield buffer.shift()!;
      }
      if (closed) return;
      // Wait for the next push or close().
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    }
  };

  const close = () => {
    closed = true;
    const woken = waiters;
    waiters = [];
    for (const w of woken) w();
  };

  return { push, drain, close };
}

// ---- Convenience: subscribe + translate in one call -----------------------

/// Subscribe to an AgentSession and translate events into AgentStreamEvents
/// on the returned queue. Caller is responsible for unsubscribing via the
/// returned function and for closing the queue.
export function subscribeAndTranslate(
  subscribe: (listener: (event: AgentSessionEvent) => void) => () => void,
): { queue: EventQueue; unsubscribe: () => void } {
  const queue = createEventQueue();
  // One state per prompt cycle → duplicate closing events are suppressed.
  const state = createTranslatorState();
  const listener = (event: AgentSessionEvent) => {
    const translated = translateAgentSessionEvent(event, state);
    queue.push(translated);
  };
  const unsubscribe = subscribe(listener);
  return { queue, unsubscribe };
}
