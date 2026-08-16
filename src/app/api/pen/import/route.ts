// POST /api/pen/import
//
// Parses a .pen JSON file and converts it into an AgentCanvas CanvasDocument.
// Returns a list of CanvasPatch ops that the client can apply to its store,
// so importing behaves like any other canvas mutation (undoable, broadcastable).
//
// Request body:
//   { "pen": PenDocument, "documentId"?: string, "mode"?: "replace"|"merge" }
//     - pen: parsed .pen document (JSON object)
//     - documentId: target document id (default "default")
//     - mode: "replace" (default) clears the canvas first; "merge" appends.
// Response:
//   { "document": CanvasDocument, "patches": CanvasPatch[] }
//
// The client is responsible for reading the file and JSON.parsing it before
// POSTing — this keeps the API simple and testable.

import { NextRequest, NextResponse } from 'next/server';
import type { CanvasDocument, CanvasPatch } from '@/lib/canvas/types';
import { penToCanvas } from '@/lib/pen/converters';
import { isPenDocument } from '@/lib/pen/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const pen = body.pen;
  const documentId: string = body.documentId ?? 'default';
  const mode: 'replace' | 'merge' = body.mode === 'merge' ? 'merge' : 'replace';

  if (!isPenDocument(pen)) {
    return NextResponse.json(
      {
        error:
          'Invalid .pen document. Expected an object with a `version` string and a `children` array of nodes.',
      },
      { status: 400 },
    );
  }

  try {
    const canvas: CanvasDocument = penToCanvas(pen, documentId);
    const patches: CanvasPatch[] = [];

    if (mode === 'replace') {
      patches.push({ op: 'clear', shapeIds: [], summary: 'Cleared canvas for .pen import' });
    }

    // Bulk-add all imported shapes.
    if (canvas.shapes.length > 0) {
      patches.push({
        op: 'bulk_add',
        shapes: canvas.shapes.map((s) => ({ ...s })),
        summary: `Imported ${canvas.shapes.length} shape(s) from .pen file`,
      });
    }

    // Update tokens if present.
    if (canvas.tokens.colors.length > 0 || canvas.tokens.textStyles.length > 0) {
      patches.push({
        op: 'tokens',
        tokens: {
          colors: canvas.tokens.colors,
          textStyles: canvas.tokens.textStyles,
        },
        summary: `Imported ${canvas.tokens.colors.length} color variable(s) from .pen file`,
      });
    }

    // Update background if non-default.
    if (canvas.background && canvas.background !== '#f8fafc') {
      patches.push({
        op: 'background',
        background: canvas.background,
        summary: `Set canvas background from .pen file (${canvas.background})`,
      });
    }

    return NextResponse.json({ document: canvas, patches });
  } catch (err: any) {
    return NextResponse.json(
      { error: `Import failed: ${err?.message ?? 'unknown error'}` },
      { status: 500 },
    );
  }
}
