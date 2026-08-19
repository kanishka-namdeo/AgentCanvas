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
 *
 * IMPORTANT: preserves `pages` + `activePageIndex` so multi-page docs
 * round-trip correctly. (Without this, a multi-page document exported
 * then re-imported would lose all pages except the active one.)
 */
export function canvasToPen(canvas: CanvasDocument): PenDocument {
  const pen: PenDocument = {
    version: canvas.version,
    themes: canvas.themes,
    imports: (canvas as any).imports,
    variables: canvas.variables,
    children: canvas.children,
  };
  // Preserve multi-page structure (added in the Figma ontology alignment).
  if (canvas.pages && canvas.pages.length > 0) {
    pen.pages = canvas.pages;
    pen.activePageIndex = canvas.activePageIndex ?? 0;
  }
  return pen;
}

/**
 * Convert a .pen PenDocument into an AgentCanvas CanvasDocument.
 * The derived caches (shapes, tokens, background) are left empty here —
 * they are recomputed by resolvePenTree() + variablesToTokens() when the
 * store applies the document. We set sensible runtime defaults.
 *
 * IMPORTANT: restores `pages` + `activePageIndex` if present in the source
 * .pen doc — so multi-page documents survive the round-trip.
 */
export function penToCanvas(doc: PenDocument, documentId: string): CanvasDocument {
  const canvas: CanvasDocument = {
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
  // Restore multi-page structure if present in the source .pen doc.
  if (doc.pages && doc.pages.length > 0) {
    canvas.pages = doc.pages;
    canvas.activePageIndex = doc.activePageIndex ?? 0;
    // Sync the active page's children into the top-level `children` field
    // so the rest of the app (which reads `canvas.children`) sees the
    // right tree.
    const activePage = doc.pages[canvas.activePageIndex];
    if (activePage) {
      canvas.children = activePage.children;
      if (activePage.viewport) canvas.viewport = activePage.viewport;
    }
  }
  return canvas;
}

/** Serialize a PenDocument to a pretty JSON string (for file download). */
export function serializePenDocument(doc: PenDocument): string {
  return JSON.stringify(doc, null, 2) + '\n';
}
