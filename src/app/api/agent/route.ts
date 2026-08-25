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
        skillSelectionMode: body.settings.skillSelectionMode ?? DEFAULT_SETTINGS.skillSelectionMode,
        llmProvider: body.settings.llmProvider ?? DEFAULT_SETTINGS.llmProvider,
        apiKey: typeof body.settings.apiKey === 'string' ? body.settings.apiKey : DEFAULT_SETTINGS.apiKey,
        modelName: typeof body.settings.modelName === 'string' ? body.settings.modelName : DEFAULT_SETTINGS.modelName,
        apiBaseUrl: typeof body.settings.apiBaseUrl === 'string' ? body.settings.apiBaseUrl : DEFAULT_SETTINGS.apiBaseUrl,
        // Plugin configuration (Phase 5).
        enabledPlugins: Array.isArray(body.settings.enabledPlugins) ? body.settings.enabledPlugins : undefined,
        mcpServers: Array.isArray(body.settings.mcpServers) ? body.settings.mcpServers : undefined,
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

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
      };

      try {
        for await (const ev of runAgent({ documentId, prompt, canvas, settings, images })) {
          if (ev.kind === 'patch') {
            send({ type: 'patch', patch: ev.patch, toolCallId: ev.toolCallId });
          } else {
            send({ type: 'agent_event', event: ev.event });
          }
        }
      } catch (err: any) {
        send({ type: 'agent_event', event: { type: 'agent:error', message: err?.message ?? 'unknown error' } });
      } finally {
        controller.close();
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
