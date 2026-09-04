// POST /api/agent
//
// Drives the Pi Agent SDK canvas tools via the z-ai-web-dev-sdk LLM driver.
// Streams newline-delimited JSON (NDJSON) back to the caller — each line is
// either:
//   { "type": "patch", "patch": CanvasPatch, "toolCallId"?: string }
//   { "type": "agent_event", "event": SyncEvent }
//
// The WebSocket mini-service (mini-services/canvas-sync) calls this route
// and re-emits the events as socket.io `sync` messages so every viewer
// sees the agent work in real time.
//
// Settings (Phase 1+2+3 of the settings workflow) are passed in the request
// body as `settings`. The runner reads them to override the previous
// hard-coded defaults (temperature 0.4, maxIterations 20, planFirst true,
// defaultPalette 'slate', skillSelectionMode 'auto', LLM provider config).
// When `settings` is omitted (e.g. legacy callers), the runner falls back
// to those defaults — keeping the existing test suite green.

import { NextRequest } from 'next/server';
import { runAgent } from '@/lib/agent/runner';
import { journalAgentEvent, appendSyntheticJournalEvent } from '@/lib/agent/event-journal';
import { patchToOpRecord, summarizeTurnDiff, formatDiffSummary, type PatchOpRecord } from '@/lib/agent/turn-diff';
import { classifyAgentError, agentErrorMessage } from '@/lib/agent-error';
import { sanitizeAgentPatch } from '@/lib/canvas/patch-sanitizer';
import { applyPatchToCanvas } from '@/lib/canvas/patch';
import type { CanvasDocument } from '@/lib/canvas/types';
import type { AgentRunSettings } from '@/lib/settings/types';
import { DEFAULT_SETTINGS } from '@/lib/settings/types';
import { registerActiveRun, unregisterActiveRun } from '@/lib/canvas/run-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const documentId: string = body.documentId ?? 'default';
  const prompt: string = body.prompt ?? '';
  const canvas: CanvasDocument = body.canvasState ?? {
    id: documentId,
    name: 'Untitled',
    version: '2.17',
    children: [],
    variables: undefined,
    themes: undefined,
    background: '#f8fafc',
    viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes: [],
    tokens: { colors: [], textStyles: [] },
  };

  // Settings — extract only the agent-run-relevant subset. Unknown fields
  // are ignored. If `settings` is missing (legacy callers), fall back to the
  // app defaults so the runner sees the previous hard-coded values.
  const settings: AgentRunSettings | undefined = body.settings
    ? {
        temperature: typeof body.settings.temperature === 'number' ? body.settings.temperature : DEFAULT_SETTINGS.temperature,
        maxIterations: typeof body.settings.maxIterations === 'number' ? body.settings.maxIterations : DEFAULT_SETTINGS.maxIterations,
        // Task 7-b bug fix: mandatory-critique-loop budget MUST pass through.
        // This field was previously missing from this allowlist, so callers
        // sending maxDesignCritiqueIterations (e.g. the eval harness with
        // EVAL_CRITIQUES=0) were silently ignored and the runner's
        // `settings?.maxDesignCritiqueIterations ?? 2` always defaulted to 2
        // — the critique-fix loop ran even when explicitly disabled.
        // 0 = hard off-switch; valid range integer 0..5; invalid/absent →
        // undefined so the runner default (2) applies.
        maxDesignCritiqueIterations:
          typeof body.settings.maxDesignCritiqueIterations === 'number' &&
          Number.isInteger(body.settings.maxDesignCritiqueIterations) &&
          body.settings.maxDesignCritiqueIterations >= 0 &&
          body.settings.maxDesignCritiqueIterations <= 5
            ? body.settings.maxDesignCritiqueIterations
            : undefined,
        planFirst: typeof body.settings.planFirst === 'boolean' ? body.settings.planFirst : DEFAULT_SETTINGS.planFirst,
        thinkingLevel: body.settings.thinkingLevel ?? DEFAULT_SETTINGS.thinkingLevel,
        defaultPalette: body.settings.defaultPalette ?? DEFAULT_SETTINGS.defaultPalette,
        // Destructive-op approval gate ('destructive' gates clear/delete
        // tools on a human Allow/Deny; 'review' lets them run freely with
        // a per-turn restore action; 'off' disables both).
        approvalMode: body.settings.approvalMode ?? DEFAULT_SETTINGS.approvalMode,
        // Tools the user has permanently allowed via the approval dialog's
        // "Always allow this tool" checkbox. Seeded into the gate's
        // in-memory allow-set at the start of every run.
        alwaysAllowTools: Array.isArray(body.settings.alwaysAllowTools)
          ? body.settings.alwaysAllowTools.filter((t: unknown) => typeof t === 'string')
          : DEFAULT_SETTINGS.alwaysAllowTools,
        skillSelectionMode: body.settings.skillSelectionMode ?? DEFAULT_SETTINGS.skillSelectionMode,
        llmProvider: body.settings.llmProvider ?? DEFAULT_SETTINGS.llmProvider,
        apiKey: typeof body.settings.apiKey === 'string' ? body.settings.apiKey : DEFAULT_SETTINGS.apiKey,
        modelName: typeof body.settings.modelName === 'string' ? body.settings.modelName : DEFAULT_SETTINGS.modelName,
        apiBaseUrl: typeof body.settings.apiBaseUrl === 'string' ? body.settings.apiBaseUrl : DEFAULT_SETTINGS.apiBaseUrl,
        // Plugin configuration (Phase 5).
        enabledPlugins: Array.isArray(body.settings.enabledPlugins) ? body.settings.enabledPlugins : undefined,
        mcpServers: Array.isArray(body.settings.mcpServers) ? body.settings.mcpServers : undefined,
        // Design-System Registry pack (e.g. 'shadcn-default', 'vercel-geist',
        // 'mantine-default'). Forwarded as-is; the runner uses it to append
        // the design-system prompt fragment so the agent references
        // `var(--color-accent)` etc. from the chosen pack. The Canvas
        // component injects the pack's tokens.css on the world root so
        // those variables resolve at render time.
        pack: typeof body.settings.pack === 'string' ? body.settings.pack : undefined,
        // Agent mode (Cursor-style, 2026-08-30): 'build' | 'ask' | 'plan'.
        // Structurally enforced by the runner at tool-registry assembly —
        // ask/plan physically cannot see mutating tools. Unknown values
        // drop to undefined (the runner defaults to 'build').
        mode:
          body.settings.mode === 'ask' || body.settings.mode === 'plan' || body.settings.mode === 'build'
            ? body.settings.mode
            : undefined,
      }
    : undefined;

  if (!prompt.trim()) {
    return new Response(JSON.stringify({ error: 'prompt is required' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Image attachments — compact data URLs staged by the chat input
  // (paste / drop / paperclip). Validated defensively: only entries whose
  // dataUrl parses as a base64 image reach the runner.
  const images: Array<{ id?: string; name?: string; dataUrl: string }> = Array.isArray(body.images)
    ? body.images
        .filter(
          (a: any) =>
            a && typeof a.dataUrl === 'string' && a.dataUrl.startsWith('data:image/'),
        )
        .slice(0, 4)
        .map((a: any) => ({
          ...(typeof a.id === 'string' ? { id: a.id } : {}),
          ...(typeof a.name === 'string' ? { name: a.name } : {}),
          dataUrl: a.dataUrl,
        }))
    : [];

  // Canvas-selection targeting context — the layers the user had selected
  // when sending (names capped at 16 server-side).
  const selection: { count: number; names: string[] } | undefined =
    body.selection && typeof body.selection.count === 'number' && Array.isArray(body.selection.names)
      ? {
          count: body.selection.count,
          names: body.selection.names
            .filter((n: unknown): n is string => typeof n === 'string')
            .slice(0, 16),
        }
      : undefined;

  // Delta LLM context (Phase C, R9a) — the socket service's driveAgent
  // computes which nodes changed since the last settled turn (journal fold
  // watermark) and threads it here. `nodeIds: null` (global op / too big to
  // enumerate) and absent (HTTP-fallback direct fetch) both mean FULL
  // snapshot; the runner treats them identically. Same defensive-validation
  // idiom as `selection` above.
  const canvasDelta: { sinceSeq: number; nodeIds: string[] | null } | undefined =
    body.canvasDelta && typeof body.canvasDelta.sinceSeq === 'number'
      && (body.canvasDelta.nodeIds === null || Array.isArray(body.canvasDelta.nodeIds))
      ? {
          sinceSeq: body.canvasDelta.sinceSeq,
          nodeIds: body.canvasDelta.nodeIds === null
            ? null
            : body.canvasDelta.nodeIds
                .filter((id: unknown): id is string => typeof id === 'string')
                .slice(0, 3000),
        }
      : undefined;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (obj: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
        } catch {
          // Consumer disconnected (client Stop / network drop) — the run's
          // abort propagation below tears the generator down; enqueue failures
          // are expected and harmless.
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
      };

      // ---- Turn identity (R3) + active-run registry (R4) --------------------
      //
      // The client threads its session/run/message ids on the prompt so the
      // journaled user_message / turn_final rows can be adopted IDEMPOTENTLY
      // by reconnect catch-up replay. Registration in the run registry makes
      // the run visible to GET /api/documents/[id]/agent/status for every
      // OTHER viewer (and the returning client) while it is live — this route
      // is the single choke point for WS-driven AND HTTP-fallback runs.
      const sessionId: string | undefined =
        typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : undefined;
      const runId: string | undefined =
        typeof body.runId === 'string' && body.runId ? body.runId : undefined;
      const userMessageId: string | undefined =
        typeof body.userMessageId === 'string' && body.userMessageId ? body.userMessageId : undefined;
      const assistantMessageId: string | undefined =
        typeof body.assistantMessageId === 'string' && body.assistantMessageId
          ? body.assistantMessageId
          : undefined;
      const runToken = registerActiveRun(documentId, {
        sessionId,
        runId,
        promptPreview: prompt.slice(0, 120),
      });

      // Journal the user's prompt message at run start (R1: the journal
      // becomes a true replication log — user half AND agent half of every
      // turn). The payload IS the SyncEvent so catch-up replayRow can
      // dispatch it verbatim; the live fanout is canvas-sync's
      // agent:user_message broadcast (single journal writer stays here).
      appendSyntheticJournalEvent(documentId, 'agent:user_message', undefined, {
        type: 'agent:user_message',
        text: prompt,
        ...(sessionId ? { sessionId } : {}),
        ...(runId ? { runId } : {}),
        ...(userMessageId ? { messageId: userMessageId } : {}),
        // Agent mode rides the journaled payload (additive — replay consumers
        // ignore unknown fields) so run forensics can attribute turns to modes.
        ...(settings?.mode ? { mode: settings.mode } : {}),
      });

      // ---- Server-side Stop + watchdog wiring (durability fixes) ----------
      //
      // One AbortController governs the whole run: the runner receives its
      // signal (AgentRunOptions.signal) and aborts the pi session when it
      // fires — so a client disconnect (HTTP fallback Stop, canvas-sync
      // agent:stop aborting its fetch) actually STOPS token spend server-side
      // instead of burning to completion. The watchdog fires the same
      // controller after WATCHDOG_MS of zero stream output (bolt.diy
      // StreamRecoveryManager pattern), bounding a hung provider stream.
      const runAbort = new AbortController();
      const onClientAbort = () => runAbort.abort();
      req.signal.addEventListener('abort', onClientAbort, { once: true });

      const WATCHDOG_MS = 120_000;
      // After runAbort fires (client Stop / disconnect / watchdog), the
      // generator gets a GRACE window to unwind on its own (session.abort()
      // → runner tail events → normal finally). If it is still streaming
      // past the grace — a hung provider socket that ignores the abort —
      // the watchdog FORCE-finalizes: turn_final + synthetic terminal are
      // journaled, the run registry is freed, and the wire closes. Without
      // this the whole teardown used to hang at `await iterator.return()`
      // and the run stayed in_progress in the DB forever (observed live:
      // the pinggy tunnel half-died mid-SSE; session.abort() was a no-op
      // against the dead socket; the run never finalized).
      const ABORT_GRACE_MS = 30_000;
      let abortedAt: number | undefined;
      let lastActivity = Date.now();
      const watchdog = setInterval(() => {
        if (closed || turnFinalEmitted) return;
        const now = Date.now();
        if (runAbort.signal.aborted) {
          if (abortedAt === undefined) abortedAt = now;
          if (now - abortedAt > ABORT_GRACE_MS) {
            console.warn(
              '[agent-route] run did not unwind within the abort grace period — force-finalizing turn_final + terminal journal rows',
            );
            emitTurnFinalAndClose();
            // Best-effort unwind in the background — when/if the hung
            // generator eventually completes, its finally block re-runs the
            // (now idempotent-guarded) teardown. It must not block the
            // route any further.
            try { void iterator.return?.(undefined).catch(() => {}); } catch { /* already finished */ }
          }
          return;
        }
        if (now - lastActivity > WATCHDOG_MS) {
          runAbort.abort();
          const event = {
            type: 'agent:error' as const,
            message:
              'Agent stream stalled — no output for 2 minutes. The run was closed to avoid hanging; resend the prompt to retry.',
            code: 'timeout',
            retryable: true,
          };
          send({ type: 'agent_event', event });
          // JOURNAL the terminal event HERE, not just on the wire: the
          // finally-block closure guarantee below only runs when the main
          // loop's `await iterator.next()` resolves — but the very reason
          // the watchdog fired is that the generator is suspended (e.g. a
          // tool call hanging past every abort signal). Without this write
          // the journal ends at the last tool_call_start forever, and a
          // client that reconnects replays an unterminated turn (found by
          // live verification: watchdog closed the run, wire got the error,
          // journal never did).
          journalAgentEvent(documentId, { kind: 'agent_event', event });
          sawTerminalOnWire = true;
          sawErrorOnWire = true;
          // The runner now has ABORT_GRACE_MS to emit its own tail
          // (turn_cancelled etc.). The aborted-branch above force-finalizes
          // if it stays silent past the grace.
          abortedAt = Date.now();
        }
      }, 15_000);

      // Evolving canvas copy: the sanitizer validates agent patches against
      // the canvas state the PRECEDING patches produced (a create-then-update
      // sequence must not have its update dropped because the initial canvas
      // didn't know the new id yet).
      let liveCanvas = canvas;

      // Whether a terminal agent event (turn_end / turn_cancelled /
      // agent:error / agent:stuck) reached the wire from the runner itself.
      // The finally block synthesizes one in the journal when a hard
      // teardown bypassed the runner's tail emissions.
      let sawTerminalOnWire = false;
      // Idempotency guard for the turn-final emission — exactly ONE
      // turn_final + synthetic terminal + unregister per run, whether the
      // normal finally or the watchdog force path gets there first.
      let turnFinalEmitted = false;

      // ---- Turn-final content accumulation (R3) -----------------------------
      //
      // Deltas are deliberately ephemeral on the wire, but the FINAL text is
      // durable: turn_final carries it so a client that missed the stream
      // (or only part of it) reconstructs the turn WITH content — the
      // OpenHands `agent_final_response` / LibreChat `aggregatedContent`
      // pattern. Accumulated across LLM iterations (the client appends every
      // delta to the same turn), capped well under the journal's row limit.
      let finalText = '';
      const FINAL_TEXT_CAP = 20_000;
      let sawErrorOnWire = false;
      let sawCancelledOnWire = false;
      // Turn-level diff records (2026-09-05 multi-shot): every SANITIZED patch
      // that lands on the canvas is folded into a compact op record
      // ("38 created · 5 updated"). The summary rides agent:turn_final so the
      // cross-turn conversation history can replay WHAT each prior turn
      // changed — the model then targets those regions in follow-ups without
      // re-reading the whole canvas tree.
      let turnPatchRecords: PatchOpRecord[] = [];

      // ---- Turn-final emission (shared by the normal finally and the ------
      //      watchdog force path).
      //
      // Exactly ONE turn_final + synthetic terminal + unregister per run —
      // whichever teardown path reaches it first (the idempotency guard
      // absorbs the second call). The watchdog force path exists because
      // `await iterator.return()` in the finally can hang forever when the
      // provider socket half-died and ignores session.abort(); without the
      // shared function the turn_final (and therefore the DB run
      // finalization) never happens and the run is stuck in_progress.
      const emitTurnFinalAndClose = () => {
        if (turnFinalEmitted) return;
        turnFinalEmitted = true;
        clearInterval(watchdog);
        const finalStatus = runAbort.signal.aborted || sawCancelledOnWire
          ? 'cancelled'
          : sawErrorOnWire
            ? 'error'
            : 'complete';
        const turnFinalEvent = {
          type: 'agent:turn_final' as const,
          text: finalText,
          status: finalStatus,
          diffSummary: formatDiffSummary(summarizeTurnDiff(turnPatchRecords)),
          ...(sessionId ? { sessionId } : {}),
          ...(runId ? { runId } : {}),
          ...(assistantMessageId ? { messageId: assistantMessageId } : {}),
        };
        send({ type: 'agent_event', event: turnFinalEvent });
        appendSyntheticJournalEvent(documentId, 'agent:turn_final', undefined, turnFinalEvent);
        // Journal-closure guarantee: the runner's tail emits a terminal
        // event, but a HARD generator termination (iterator.return above —
        // client disconnect / canvas-sync agent:stop while a tool call is
        // mid-execution) unwinds at the suspension point and the tail never
        // runs. Without this backstop the journal ends at the last
        // tool_call_start forever — replay consumers would see an
        // unterminated turn. Synthesize the honest terminal event instead.
        if (!sawTerminalOnWire) {
          appendSyntheticJournalEvent(
            documentId,
            runAbort.signal.aborted ? 'agent:turn_cancelled' : 'agent:turn_end',
            undefined,
            {
              type: runAbort.signal.aborted ? 'agent:turn_cancelled' : 'agent:turn_end',
              synthetic: true,
              note: runAbort.signal.aborted
                ? 'Run aborted (client Stop / disconnect / stream watchdog) — terminal event synthesized at stream teardown.'
                : 'Run ended without a terminal event — synthesized at stream teardown.',
            },
          );
        }
        // Status-route visibility: the run is over (identity-checked — an
        // aborted older run never unregisters a newer one).
        unregisterActiveRun(documentId, runToken);
        close();
      };

      const iterator = runAgent({
        documentId,
        prompt,
        canvas,
        settings,
        images,
        selection,
        ...(canvasDelta ? { canvasDelta } : {}),
        signal: runAbort.signal,
      })[Symbol.asyncIterator]();

      try {
        while (true) {
          const result = await iterator.next();
          if (result.done) break;
          const ev = result.value;

          if (ev.kind === 'patch') {
            // Validate → sanitize → apply (tldraw's action-sanitization layer):
            // the append-only canvas model can never edit a bad patch out, so
            // malformed patches are caught HERE, before they reach any client.
            const { patch: sanitized, warnings } = sanitizeAgentPatch(ev.patch, liveCanvas);
            if (warnings.length > 0) {
              console.warn(`[agent-route] sanitized patch on ${documentId}: ${warnings.join('; ')}`);
            }
            if (!sanitized) {
              // Dropped (unknown op / missing target / duplicate id) — journal
              // the drop for auditability, never stream it.
              appendSyntheticJournalEvent(documentId, 'patch_dropped', ev.toolCallId, {
                reason: warnings,
                patch: ev.patch,
              });
              continue;
            }
            try {
              liveCanvas = applyPatchToCanvas(liveCanvas, sanitized);
            } catch {
              // Applier rejected it after all — treat as a dropped patch.
              appendSyntheticJournalEvent(documentId, 'patch_dropped', ev.toolCallId, {
                reason: ['applier threw'],
                patch: sanitized,
              });
              continue;
            }
            send({ type: 'patch', patch: sanitized, toolCallId: ev.toolCallId });
            journalAgentEvent(documentId, { kind: 'patch', patch: sanitized, toolCallId: ev.toolCallId });
            const diffRec = patchToOpRecord(sanitized);
            if (diffRec) turnPatchRecords.push(diffRec);
          } else {
            send({ type: 'agent_event', event: ev.event });
            journalAgentEvent(documentId, ev);
            if (ev.event.type === 'agent:message_delta') {
              // Accumulate for turn_final (R3). Never resets on message_start:
              // a turn's transcript text spans every LLM iteration, matching
              // the client's append-every-delta behavior.
              if (finalText.length < FINAL_TEXT_CAP) {
                finalText = (finalText + ev.event.text).slice(0, FINAL_TEXT_CAP);
              }
            }
            if (
              ev.event.type === 'agent:turn_end' ||
              ev.event.type === 'agent:turn_cancelled' ||
              ev.event.type === 'agent:error' ||
              ev.event.type === 'agent:stuck'
            ) {
              sawTerminalOnWire = true;
              if (ev.event.type === 'agent:error' || ev.event.type === 'agent:stuck') sawErrorOnWire = true;
              if (ev.event.type === 'agent:turn_cancelled') sawCancelledOnWire = true;
            }
          }
          lastActivity = Date.now();
        }
      } catch (err: any) {
        const message = agentErrorMessage(err);
        const cls = classifyAgentError(message);
        const event = {
          type: 'agent:error' as const,
          message,
          code: cls.code,
          retryable: cls.retryable,
        };
        send({ type: 'agent_event', event });
        journalAgentEvent(documentId, { kind: 'agent_event', event });
        sawTerminalOnWire = true;
        sawErrorOnWire = true;
      } finally {
        clearInterval(watchdog);
        req.signal.removeEventListener('abort', onClientAbort);
        // Terminate the generator (runs its finally blocks → session dispose)
        // even when we exited the loop early (watchdog / client disconnect).
        //
        // ⚠️ This await CAN hang forever (provider socket half-died mid-SSE,
        // session.abort() is a no-op against the dead socket) — which is
        // exactly why emitTurnFinalAndClose() is shared with the watchdog's
        // abort-grace force path: turn_final + the synthetic terminal +
        // unregisterActiveRun must not depend on THIS await completing.
        // When the force path already ran, the guarded call below is a
        // no-op and the stream was closed from the watchdog tick.
        try { await iterator.return?.(undefined); } catch { /* already finished */ }
        // ---- Turn-final content event (R3) ----------------------------------
        //
        // ONE row per turn with the full final assistant text + the honest
        // terminal status + the client-threaded identity. Sent on the wire
        // TOO (before any synthetic terminal): live viewers use it to
        // HEAL a turn whose delta stream dropped chunks (the text REPLACES,
        // so a fully-caught-up viewer is unaffected); reconnecting catch-up
        // replay uses it to reconstruct the whole turn. Bounded by the
        // journal's 65K row cap regardless. Idempotent — see
        // emitTurnFinalAndClose above.
        emitTurnFinalAndClose();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}
