// CanvasDocument <-> PenDocument converters.
//
// After the Phase C tree-model migration, CanvasDocument IS essentially a
// PenDocument (it extends PenDocument + adds runtime/derived fields). So
// conversion is now near-identity:
//
//   - canvasToPen: strip the runtime (id, name, viewport) and derived
//     (shapes, tokens, background) caches. Keep version, themes, imports,
//     variables, children — the canonical .pen fields.
//   - penToCanvas: wrap a .pen doc with runtime + derived caches (the
//     derived caches are recomputed lazily by the store / resolvePenTree).
//
// This module is kept for the /api/pen/export and /api/pen/import routes
// and for the pen_export_pen agent tool.

import type { CanvasDocument } from '../canvas/types';
import type { PenDocument } from './types';

/**
 * Convert an AgentCanvas CanvasDocument into a .pen PenDocument.
 * Strips runtime + derived caches; keeps the canonical .pen tree.
 */
export function canvasToPen(canvas: CanvasDocument): PenDocument {
  return {
    version: canvas.version,
    themes: canvas.themes,
    imports: (canvas as any).imports,
    variables: canvas.variables,
    children: canvas.children,
  };
}

/**
 * Convert a .pen PenDocument into an AgentCanvas CanvasDocument.
 * The derived caches (shapes, tokens, background) are left empty here —
 * they are recomputed by resolvePenTree() + variablesToTokens() when the
 * store applies the document. We set sensible runtime defaults.
 */
export function penToCanvas(doc: PenDocument, documentId: string): CanvasDocument {
  return {
    id: documentId,
    name: 'Imported .pen',
    version: doc.version,
    themes: doc.themes,
    variables: doc.variables,
    children: doc.children ?? [],
    viewport: { zoom: 1, panX: 120, panY: 80 },
    background: '#f8fafc',
    shapes: [], // recomputed by the store via resolvePenTree
    tokens: { colors: [], textStyles: [] }, // recomputed by variablesToTokens
  } as CanvasDocument;
}

/** Serialize a PenDocument to a pretty JSON string (for file download). */
export function serializePenDocument(doc: PenDocument): string {
  return JSON.stringify(doc, null, 2) + '\n';
}
