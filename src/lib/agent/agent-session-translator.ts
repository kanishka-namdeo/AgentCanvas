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
  /// The resolved model's context window (tokens). Used to fill
  /// `agent:context_update.contextWindow` with the REAL window instead of
  /// the old hardcoded 128K. Set by the runner via subscribeAndTranslate()
  /// after resolveModel() (it can differ per attempt — sandbox fallback swaps
  /// the model, and with it the window).
  contextWindow: number;
}

export function createTranslatorState(contextWindow = 128_000): TranslatorState {
  return { messageOpen: false, turnEnded: false, contextWindow };
}

// ---- toolcall_delta → throttled agent:tool_progress (watchdog feed) ---------
//
// Module-scoped throttle state (toolCallIds are unique per call, so a plain
// map is safe; entries are cleared when the call completes or the turn ends).
// Emits at most one progress event per call per THROTTLE_MS with the tool
// name + accumulated argument size — enough to feed the route's 120s stream
// watchdog on every chunk of a multi-minute argument generation, without
// flooding the wire/UI with per-token events.
const TOOLCALL_PROGRESS_THROTTLE_MS = 2_000;
const toolCallProgressState = new Map<string, { bytes: number; lastEmitAt: number }>();

function toolCallDeltaProgress(
  contentIndex: number,
  delta: string,
  partial: unknown,
): { type: 'agent:tool_progress'; toolCallId: string; text: string } | null {
  // Resolve the toolCall block (name + id) from the partial AssistantMessage.
  let toolName = '';
  let toolCallId = '';
  try {
    const block = (partial as any)?.content?.[contentIndex];
    if (block && block.type === 'toolCall') {
      toolName = typeof block.name === 'string' ? block.name : '';
      toolCallId = typeof block.id === 'string' ? block.id : '';
    }
  } catch {
    // Malformed partial — fall through with empty identifiers.
  }
  // Id may be empty until the provider streams it; key by index+name instead.
  const key = toolCallId || `idx-${contentIndex}-${toolName}`;
  const now = Date.now();
  const prev = toolCallProgressState.get(key);
  const bytes = (prev?.bytes ?? 0) + (typeof delta === 'string' ? delta.length : 0);
  if (prev && now - prev.lastEmitAt < TOOLCALL_PROGRESS_THROTTLE_MS) {
    toolCallProgressState.set(key, { bytes, lastEmitAt: prev.lastEmitAt });
    return null;
  }
  toolCallProgressState.set(key, { bytes, lastEmitAt: now });
  const kb = (bytes / 1024).toFixed(1);
  const label = toolName || 'tool call';
  return {
    type: 'agent:tool_progress',
    toolCallId: toolCallId || key,
    text: `Composing ${label} arguments… ${kb} KB`,
  };
}

/// Derive the "current context fill" token count from a pi-ai `Usage`
/// payload. Mirrors the SDK's `calculateContextTokens`: the input of the last
/// LLM call plus its output (and cache reads/writes) is the size of the
/// context the model just saw — i.e. how full the window is now.
function contextTokensFromUsage(usage: {
  input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number;
}): number {
  if (typeof usage.totalTokens === 'number' && usage.totalTokens > 0) return usage.totalTokens;
  return (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
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
      if (state) state.messageOpen = true;
      out.push({ kind: 'agent_event', event: { type: 'agent:message_start', role: 'assistant' } });
      break;
    }

    case 'message_update': {
      // AssistantMessageEvent is a discriminated union — text_delta | thinking_delta | toolcall_start | toolcall_delta | toolcall_end | usage | image | ...
      const ame = (event as any).assistantMessageEvent;
      if (!ame) break;
      if (ame.type === 'text_delta' && typeof ame.delta === 'string') {
        out.push({ kind: 'agent_event', event: { type: 'agent:message_delta', text: ame.delta } });
      } else if (ame.type === 'thinking_delta' && typeof ame.delta === 'string') {
        out.push({ kind: 'agent_event', event: { type: 'agent:thinking_delta', text: ame.delta } });
      } else if (ame.type === 'toolcall_delta' && typeof ame.delta === 'string') {
        // Watchdog feed (2026-08-30 modes E2E, live-verified failure): a
        // giant tool-call argument (a whole screen as one pen_create_subtree /
        // pen_insert_html payload) can take >120s of pure argument streaming.
        // toolcall_delta events were dropped here, so NOTHING reached the wire
        // for 2 minutes — the route's stream watchdog killed the run mid-
        // generation ("Agent stream stalled"), leaving an empty canvas.
        // Throttled agent:tool_progress keeps the watchdog fed AND shows the
        // user the agent is composing a large call (pending tool card).
        const progress = toolCallDeltaProgress(ame.contentIndex, ame.delta, ame.partial);
        if (progress) {
          out.push({ kind: 'agent_event', event: progress });
        }
      }
      // Other assistantMessageEvent types (toolcall_start/end, usage, image)
      // don't need separate SyncEvents — we emit our own tool_call_start/end
      // from the SDK's tool_execution_start/end events below.
      break;
    }

    case 'message_end': {
      // A completed message closes all its tool calls — drop the throttle
      // state so a new message's calls start from zero bytes.
      toolCallProgressState.clear();
      // Extract the LLM usage payload from the completed AssistantMessage.
      // `event.message` is the full AssistantMessage (pi-ai types): it carries
      // `usage` (input/output/cacheRead/cacheWrite tokens + cost), `model`,
      // and `provider`. This fires once per LLM iteration — each tool-call
      // round is one LLM call — which is exactly the granularity a context
      // usage bar wants (Cline / Claude Code update per iteration too).
      const msg = (event as any).message;
      const usage = msg?.usage;
      if (usage && typeof usage.input === 'number') {
        const cost =
          typeof usage.cost?.total === 'number' ? usage.cost.total :
          typeof msg.cost === 'number' ? msg.cost : 0;
        out.push({
          kind: 'agent_event',
          event: {
            type: 'agent:context_update',
            tokenCount: contextTokensFromUsage(usage),
            contextWindow: state?.contextWindow ?? 128_000,
            usage: {
              input: usage.input ?? 0,
              output: usage.output ?? 0,
              cacheRead: usage.cacheRead ?? 0,
              cacheWrite: usage.cacheWrite ?? 0,
              cost,
            },
            model: typeof msg.model === 'string' ? msg.model : undefined,
          },
        });
      }
      // Suppress duplicate closes: only emit when a message is actually open.
      // stopReason rides along (additive, optional) so the runner can detect
      // token-limit truncation ('length') and auto-continue the turn.
      if (!state || state.messageOpen) {
        const stopReason =
          typeof (event as any).message?.stopReason === 'string'
            ? (event as any).message.stopReason as string
            : undefined;
        out.push({
          kind: 'agent_event',
          event: {
            type: 'agent:message_end',
            ...(stopReason ? { stopReason } : {}),
          },
        });
        if (state) state.messageOpen = false;
      }
      break;
    }

    // ---- Tool execution ----
    case 'tool_execution_start': {
      const e = event as any;
      const toolCallId: string = e.toolCallId ?? '';
      const toolName: string = e.toolName ?? '';
      // The SDK doesn't expose a pre-formatted args preview; we render a JSON
      // snapshot from the args object. Cap is generous (2K chars) so the chat
      // UI can pretty-print the full args (Cursor-style tool cards show real
      // arguments, not a 120-char stub); these travel the same NDJSON/socket
      // path as canvas patches, which are routinely far larger.
      let argsPreview = '';
      try {
        argsPreview = JSON.stringify(e.args ?? {}).slice(0, 2000);
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

    case 'tool_execution_update': {
      // Long-running tools (variant explorer, design audit) stream partial
      // results through the SDK's onUpdate callback. Translate to a
      // lightweight agent:tool_progress — it feeds the route's stream
      // watchdog (any wire event resets the 120s silence timer, so a
      // legitimately slow tool is never killed mid-flight) and updates the
      // pending tool card in the chat. Text extracted from the partial
      // result's text content parts; empty/whitespace updates are dropped.
      const e = event as any;
      const updateToolCallId: string = e.toolCallId ?? '';
      let text = '';
      try {
        const content = (e.partialResult as any)?.content;
        if (Array.isArray(content)) {
          text = content
            .map((c: any) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : ''))
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 200);
        }
      } catch {
        text = '';
      }
      if (updateToolCallId && text) {
        out.push({
          kind: 'agent_event',
          event: { type: 'agent:tool_progress', toolCallId: updateToolCallId, text },
        });
      }
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
        if (state) state.messageOpen = false;
      }
      if (!state || !state.turnEnded) {
        out.push({ kind: 'agent_event', event: { type: 'agent:turn_end' } });
        if (state) state.turnEnded = true;
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
          // Real resolved-model window when the runner provided one (via
          // subscribeAndTranslate); 128K fallback keeps old callers working.
          contextWindow: state?.contextWindow ?? 128_000,
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
  options?: { contextWindow?: number },
): { queue: EventQueue; unsubscribe: () => void } {
  const queue = createEventQueue();
  // One state per prompt cycle → duplicate closing events are suppressed.
  // The context window comes from the RESOLVED model so context_update
  // events report the real window (see runner-native.ts).
  const state = createTranslatorState(options?.contextWindow ?? 128_000);
  const listener = (event: AgentSessionEvent) => {
    const translated = translateAgentSessionEvent(event, state);
    queue.push(translated);
  };
  const unsubscribe = subscribe(listener);
  return { queue, unsubscribe };
}
