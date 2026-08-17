// POST /api/pen/import
//
// Parses a .pen JSON file and converts it into AgentCanvas CanvasPatch ops
// that the client applies to its store. Since the runtime model is now a
// .pen tree, import is straightforward: we emit a `clear` (in replace mode)
// then a single `bulk_add` carrying the imported `children` tree, plus
// `tokens`/`set_theme_axis` patches for the variables/themes.
//
// Request body:
//   { "pen": PenDocument, "documentId"?: string, "mode"?: "replace"|"merge" }
// Response:
//   { "document": CanvasDocument, "patches": CanvasPatch[] }

import { NextRequest, NextResponse } from 'next/server';
import type { CanvasDocument, CanvasPatch } from '@/lib/canvas/types';
import { penToCanvas } from '@/lib/pen/converters';
import { resolvePenTree } from '@/lib/pen/resolve';
import { variablesToTokens } from '@/lib/canvas/patch';
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
    // Recompute the derived caches so the response includes the resolved
    // shape count (for the toast notification).
    canvas.shapes = resolvePenTree(canvas);
    canvas.tokens = variablesToTokens(canvas.variables);
    const patches: CanvasPatch[] = [];

    if (mode === 'replace') {
      patches.push({ op: 'clear', shapeIds: [], summary: 'Cleared canvas for .pen import' });
    }

    // Bulk-add the imported .pen tree (children). The patch applier inserts
    // each top-level node into the document tree.
    if (canvas.children.length > 0) {
      const nodeShapes = canvas.children.map((node) => {
        const copy: Record<string, unknown> = { ...node };
        copy.id = node.id;
        return copy as any;
      });
      patches.push({
        op: 'bulk_add',
        shapes: nodeShapes,
        summary: `Imported ${canvas.children.length} top-level node(s), ${canvas.shapes.length} resolved, from .pen file`,
      });
    }

    // Import variables as tokens.
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

    // Import theme axes.
    if (canvas.themes) {
      for (const [axis, values] of Object.entries(canvas.themes)) {
        patches.push({
          op: 'set_theme_axis',
          themeAxis: axis,
          themeValues: values,
          summary: `Imported theme axis "${axis}": [${values.join(', ')}]`,
        });
      }
    }

    return NextResponse.json({ document: canvas, patches });
  } catch (err: any) {
    return NextResponse.json(
      { error: `Import failed: ${err?.message ?? 'unknown error'}` },
      { status: 500 },
    );
  }
}
