// Variant promote (designer-workflow-parity spec §4.3) — PURE swap + payload
// apply for promoting a parked variant to the active design.
//
// The swap semantics (per dispatch):
//   1. Find the parked section on the Explorations page (by section id).
//   2. Extract its single child (the variant root).
//   3. Replace the active page's children with [variantRoot].
//   4. Wrap the previous active-page roots in ONE labeled section node
//      ("Previous — applied design") appended to Explorations.
//   5. Remove the promoted section from Explorations.
//   6. Return the payload for the journal row.
//
// The payload is designed for fold-replayability: `applyVariantPromotePayload`
// reconstructs the identical document WITHOUT re-running search logic, so the
// fold and the route can't drift.
//
// Idempotence vs document_restore: the client's subsequent `document:restore`
// emission journals a `document_restore` row AFTER the `variant_promote` row.
// The fold replays both — the swap case must be idempotent (restore lands last
// carrying the identical final state). Both orders produce correct state:
//   - variant_promote then document_restore: swap applies, then restore
//     overwrites with the same swapped state (idempotent).
//   - document_restore alone (no variant_promote): restore loads the swapped
//     state directly (also correct).

import type { CanvasDocument } from './types';
import type { PenChild, PenPage } from '../pen/types';

/// The parking page name (must match variant-parking.ts).
const EXPLORATIONS_PAGE_NAME = 'Explorations';

export interface VariantPromotePayload {
  /// The promoted section's id (removed from Explorations).
  promotedSectionId: string;
  /// The variant root (now the active page's only child).
  promotedRoot: PenChild;
  /// The previous active-page roots (wrapped in a "Previous" section).
  previousMainRoots: PenChild[];
  /// All ids removed from the canvas: promoted section + previous main roots'
  /// subtree ids. The fold adds these to tombstones.
  removedSectionIds: string[];
}

/// Find the Explorations page index (case-insensitive substring match, mirroring
/// variant-parking.ts's findExplorationsPageIndex).
function findExplorationsPageIndex(doc: CanvasDocument): number {
  const pages = doc.pages ?? [];
  const needle = EXPLORATIONS_PAGE_NAME.toLowerCase();
  return pages.findIndex((p) => typeof p.name === 'string' && p.name.toLowerCase().includes(needle));
}

/// Collect all node ids in a subtree (depth-first).
function collectSubtreeIds(node: PenChild): string[] {
  const ids: string[] = [];
  const walk = (n: { id: string; children?: unknown }) => {
    ids.push(n.id);
    if (Array.isArray(n.children)) {
      for (const c of n.children as Array<{ id: string; children?: unknown }>) {
        walk(c);
      }
    }
  };
  walk(node as { id: string; children?: unknown });
  return ids;
}

/**
 * PURE swap: find the parked section on Explorations, extract its variant root,
 * replace the active page's children with it, wrap the previous roots in a
 * "Previous" section on Explorations. Returns null when the section isn't
 * parked or the document shape is unexpected (no throw).
 */
export function swapVariantWithMain(
  doc: CanvasDocument,
  sectionId: string,
): { document: CanvasDocument; payload: VariantPromotePayload } | null {
  try {
    const pages = doc.pages;
    if (!Array.isArray(pages) || pages.length === 0) return null;
    const activeIdx = doc.activePageIndex ?? 0;
    if (activeIdx < 0 || activeIdx >= pages.length) return null;

    const explorationsIdx = findExplorationsPageIndex(doc);
    if (explorationsIdx < 0) return null;

    const explorationsPage = pages[explorationsIdx];
    const promotedSection = explorationsPage.children.find((c) => c.id === sectionId);
    if (!promotedSection) return null;
    if (promotedSection.type !== 'section') return null;

    const sectionChildren = (promotedSection as { children?: PenChild[] }).children;
    if (!Array.isArray(sectionChildren) || sectionChildren.length !== 1) return null;
    const variantRoot = sectionChildren[0];

    const activePage = pages[activeIdx];
    const previousMainRoots = structuredClone(activePage.children) as PenChild[];

    // Build the "Previous — applied design" section wrapping the old roots.
    // Deterministic id so swapVariantWithMain and applyVariantPromotePayload
    // produce identical output (the fold replays the payload against the same
    // pre-swap document and must land on the same tree).
    const previousSectionId = `prev-applied-${sectionId}`;
    const previousSection: PenChild = {
      id: previousSectionId,
      type: 'section',
      name: 'Previous — applied design',
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      children: previousMainRoots,
    } as unknown as PenChild;

    // Explorations page: remove the promoted section, append the previous section.
    const newExplorationsChildren = explorationsPage.children
      .filter((c) => c.id !== sectionId)
      .concat([previousSection]);

    // Build the new pages array.
    const newPages: PenPage[] = pages.map((p, i) => {
      if (i === activeIdx) {
        return { ...p, children: [structuredClone(variantRoot)] as PenChild[] };
      }
      if (i === explorationsIdx) {
        return { ...p, children: newExplorationsChildren };
      }
      return p;
    });

    // Collect removed ids: promoted section + all subtree ids of previous main roots.
    const removedIds: string[] = [sectionId];
    for (const root of previousMainRoots) {
      removedIds.push(...collectSubtreeIds(root));
    }

    const payload: VariantPromotePayload = {
      promotedSectionId: sectionId,
      promotedRoot: structuredClone(variantRoot),
      previousMainRoots,
      removedSectionIds: removedIds,
    };

    const newActiveChildren = newPages[activeIdx].children;
    const newDoc: CanvasDocument = {
      ...doc,
      pages: newPages,
      children: newActiveChildren,
    };

    return { document: newDoc, payload };
  } catch {
    return null;
  }
}

/**
 * Fold primitive: reconstruct the swapped document from the payload
 * deterministically. The route uses `swapVariantWithMain`; the fold uses this
 * function — both in this module so they can't drift. Returns null when the
 * payload is malformed or the document shape is unexpected.
 */
export function applyVariantPromotePayload(
  doc: CanvasDocument,
  payload: VariantPromotePayload,
): CanvasDocument | null {
  try {
    const pages = doc.pages;
    if (!Array.isArray(pages) || pages.length === 0) return null;
    const activeIdx = doc.activePageIndex ?? 0;
    if (activeIdx < 0 || activeIdx >= pages.length) return null;

    const explorationsIdx = findExplorationsPageIndex(doc);
    if (explorationsIdx < 0) return null;

    const explorationsPage = pages[explorationsIdx];

    // Build the "Previous — applied design" section.
    const previousSectionId = `prev-applied-${payload.promotedSectionId}`;
    const previousSection: PenChild = {
      id: previousSectionId,
      type: 'section',
      name: 'Previous — applied design',
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      children: structuredClone(payload.previousMainRoots),
    } as unknown as PenChild;

    // Explorations page: remove the promoted section, append the previous section.
    const newExplorationsChildren = explorationsPage.children
      .filter((c) => c.id !== payload.promotedSectionId)
      .concat([previousSection]);

    // Build the new pages array.
    const newPages: PenPage[] = pages.map((p, i) => {
      if (i === activeIdx) {
        return { ...p, children: [structuredClone(payload.promotedRoot)] as PenChild[] };
      }
      if (i === explorationsIdx) {
        return { ...p, children: newExplorationsChildren };
      }
      return p;
    });

    const newActiveChildren = newPages[activeIdx].children;
    const newDoc: CanvasDocument = {
      ...doc,
      pages: newPages,
      children: newActiveChildren,
    };

    return newDoc;
  } catch {
    return null;
  }
}
