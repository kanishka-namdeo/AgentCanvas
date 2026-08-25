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
//
// ---- .pen v3 (spec Phase 6 part 1) -----------------------------------------
//
//   - EXPORT (canvasToPen): migrated to the Figma-canonical v3 form —
//     `version: '3.0'` + canonical fields — while KEEPING the legacy
//     dual-carry fields, so files stay loadable by old code.
//   - IMPORT (penToCanvas): migrate-on-read — any 2.x (or version-less)
//     document upgrades through pen/migrate.ts, forever.

import type { CanvasDocument } from '../canvas/types';
import type { PenDocument } from './types';
import { migratePenDocument, isV3Document } from './migrate';

/**
 * Convert an AgentCanvas CanvasDocument into a .pen PenDocument.
 * Strips runtime + derived caches; keeps the canonical .pen tree.
 *
 * The exported file carries the v3 (Figma-canonical) vocabulary: the document
 * is migrated when its version is below 3.0 — `version: '3.0'`, canonical
 * enum spellings, `variableCollections`/`variableRecords` — while every
 * legacy field stays in place (dual-carry), so pre-Phase-6 code can still
 * load the file.
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
    variableCollections: canvas.variableCollections,
    variableRecords: canvas.variableRecords,
  };
  // Preserve multi-page structure (added in the Figma ontology alignment).
  if (canvas.pages && canvas.pages.length > 0) {
    pen.pages = canvas.pages;
    pen.activePageIndex = canvas.activePageIndex ?? 0;
  }
  // Write v3 (spec Phase 6): no-op for already-migrated documents.
  return isV3Document(pen) ? pen : migratePenDocument(pen);
}

/**
 * Convert a .pen PenDocument into an AgentCanvas CanvasDocument.
 * The derived caches (shapes, tokens, background) are left empty here —
 * they are recomputed by resolvePenTree() + variablesToTokens() when the
 * store applies the document. We set sensible runtime defaults.
 *
 * MIGRATE-ON-READ (spec §9.3 #2): a 2.x (or version-less) document is
 * upgraded to the v3 Figma-canonical form via pen/migrate.ts —
 * deterministically and dual-carry (legacy fields kept) — so importing old
 * files never errors and never loses data. v3 documents pass through
 * unchanged.
 *
 * IMPORTANT: restores `pages` + `activePageIndex` if present in the source
 * .pen doc — so multi-page documents survive the round-trip.
 */
export function penToCanvas(doc: PenDocument, documentId: string): CanvasDocument {
  // Parse-boundary normalization: upgrade legacy spellings to the v3 form
  // (idempotent — v3 docs skip migration entirely).
  const migrated = isV3Document(doc) ? doc : migratePenDocument(doc);

  const canvas: CanvasDocument = {
    id: documentId,
    name: 'Imported .pen',
    version: migrated.version,
    themes: migrated.themes,
    variables: migrated.variables,
    variableCollections: migrated.variableCollections,
    variableRecords: migrated.variableRecords,
    children: migrated.children ?? [],
    viewport: { zoom: 1, panX: 120, panY: 80 },
    background: '#f8fafc',
    shapes: [], // recomputed by the store via resolvePenTree
    tokens: { colors: [], textStyles: [] }, // recomputed by variablesToTokens
  } as CanvasDocument;
  // Restore multi-page structure if present in the source .pen doc.
  if (migrated.pages && migrated.pages.length > 0) {
    canvas.pages = migrated.pages;
    canvas.activePageIndex = migrated.activePageIndex ?? 0;
    // Sync the active page's children into the top-level `children` field
    // so the rest of the app (which reads `canvas.children`) sees the
    // right tree.
    const activePage = migrated.pages[canvas.activePageIndex];
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
