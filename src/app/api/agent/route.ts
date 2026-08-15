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

import { NextRequest } from 'next/server';
import { runAgent } from '@/lib/agent/runner';
import type { CanvasDocument } from '@/lib/canvas/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const documentId: string = body.documentId ?? 'default';
  const prompt: string = body.prompt ?? '';
  const canvas: CanvasDocument = body.canvasState ?? {
    id: documentId,
    name: 'Untitled',
    background: '#f8fafc',
    viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes: [],
  };

  if (!prompt.trim()) {
    return new Response(JSON.stringify({ error: 'prompt is required' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
      };

      try {
        for await (const ev of runAgent({ documentId, prompt, canvas })) {
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
