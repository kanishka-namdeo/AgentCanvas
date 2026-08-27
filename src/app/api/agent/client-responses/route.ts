// POST /api/agent/client-responses
//
// Resolves a pending client round-trip tool call (spec §5.2 / §5.4, Phase 3 —
// M2-c). The frontend POSTs here when it answers an `agent:computed_request`
// or `agent:screenshot_request` SyncEvent, and when it pushes its
// measured-bounds runtime cache (spec §3.8). Same shape as /api/agent/answers.
//
// Body:
//   { kind: 'computed', toolCallId: string, results: ComputedResult[] }
//   { kind: 'screenshot', toolCallId: string, dataUrl?: string, error?: string }
//   { kind: 'extract_html', toolCallId: string, children?: PenChild[], warnings?: string[], error?: string }
//   { kind: 'measured_bounds', documentId: string, bounds: Record<id, {width,height}> }
//     — measured-bounds pushes may ALSO piggyback on a computed response via
//       the optional `documentId` + `bounds` fields.

import { NextRequest } from 'next/server';
import {
  resolveComputedResponse,
  resolveScreenshotResponse,
  resolveExtractedHtmlResponse,
  setMeasuredBounds,
} from '@/lib/agent/client-roundtrip';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function jsonOk(payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const toolCallId: string = typeof body.toolCallId === 'string' ? body.toolCallId : '';
  const kind: string = typeof body.kind === 'string' ? body.kind : '';

  // Piggybacked measured-bounds update (rides on any response shape).
  if (typeof body.documentId === 'string' && body.documentId && body.bounds && typeof body.bounds === 'object') {
    setMeasuredBounds(body.documentId, body.bounds);
  }

  if (kind === 'measured_bounds') {
    // Pure measured-bounds push — no toolCallId needed.
    if (typeof body.documentId !== 'string' || !body.documentId) {
      return jsonError('documentId is required for measured_bounds', 400);
    }
    return jsonOk({ ok: true, stored: true });
  }

  if (!toolCallId) {
    return jsonError('toolCallId is required', 400);
  }

  switch (kind) {
    case 'computed': {
      const results = Array.isArray(body.results) ? body.results : [];
      const resolved = resolveComputedResponse(toolCallId, results);
      return jsonOk({ ok: true, resolved });
    }
    case 'screenshot': {
      const dataUrl = typeof body.dataUrl === 'string' ? body.dataUrl : undefined;
      const error = typeof body.error === 'string' ? body.error : undefined;
      const resolved = resolveScreenshotResponse(toolCallId, dataUrl, error);
      return jsonOk({ ok: true, resolved });
    }
    case 'extract_html': {
      const children = Array.isArray(body.children) ? body.children : undefined;
      const warnings = Array.isArray(body.warnings) ? body.warnings : undefined;
      const error = typeof body.error === 'string' ? body.error : undefined;
      const resolved = resolveExtractedHtmlResponse(toolCallId, children, warnings, error);
      return jsonOk({ ok: true, resolved });
    }
    default:
      return jsonError("kind must be 'computed', 'screenshot', 'extract_html' or 'measured_bounds'", 400);
  }
}
