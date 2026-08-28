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
import { classifyAgentError, agentErrorMessage } from '@/lib/agent-error';
import { sanitizeAgentPatch } from '@/lib/canvas/patch-sanitizer';
import { applyPatchToCanvas } from '@/lib/canvas/patch';
import type { CanvasDocument } from '@/lib/canvas/types';
import type { AgentRunSettings } from '@/lib/settings/types';
import { DEFAULT_SETTINGS } from '@/lib/settings/types';

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
      let lastActivity = Date.now();
      const watchdog = setInterval(() => {
        if (closed || runAbort.signal.aborted) return;
        if (Date.now() - lastActivity > WATCHDOG_MS) {
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
          close();
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

      const iterator = runAgent({
        documentId,
        prompt,
        canvas,
        settings,
        images,
        selection,
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
          } else {
            send({ type: 'agent_event', event: ev.event });
            journalAgentEvent(documentId, ev);
            if (
              ev.event.type === 'agent:turn_end' ||
              ev.event.type === 'agent:turn_cancelled' ||
              ev.event.type === 'agent:error' ||
              ev.event.type === 'agent:stuck'
            ) {
              sawTerminalOnWire = true;
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
      } finally {
        clearInterval(watchdog);
        req.signal.removeEventListener('abort', onClientAbort);
        // Terminate the generator (runs its finally blocks → session dispose)
        // even when we exited the loop early (watchdog / client disconnect).
        try { await iterator.return?.(); } catch { /* already finished */ }
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
        close();
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
