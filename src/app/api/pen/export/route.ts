// POST /api/pen/export
//
// Converts an AgentCanvas CanvasDocument (sent in the request body) into a
// .pen PenDocument and returns it as a downloadable .pen JSON file.
//
// Request body:
//   { "document": CanvasDocument, "filename"?: string }
// Response:
//   - 200: application/json (the PenDocument) — the client triggers download
//   - 400: invalid request
//
// We return JSON rather than a file attachment so the client can both preview
// the structure and trigger a download via a Blob. The Content-Disposition
// header is also set so a direct fetch can save the file.

import { NextRequest, NextResponse } from 'next/server';
import type { CanvasDocument } from '@/lib/canvas/types';
import { canvasToPen, serializePenDocument } from '@/lib/pen/converters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const document: CanvasDocument | undefined = body.document;
  const filename: string = (body.filename ?? document?.name ?? 'canvas') + '.pen';

  if (!document || !Array.isArray(document.shapes)) {
    return NextResponse.json(
      { error: 'document (CanvasDocument) is required' },
      { status: 400 },
    );
  }

  try {
    const pen = canvasToPen(document);
    const json = serializePenDocument(pen);
    return new NextResponse(json, {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
        'cache-control': 'no-cache',
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: `Export failed: ${err?.message ?? 'unknown error'}` },
      { status: 500 },
    );
  }
}
