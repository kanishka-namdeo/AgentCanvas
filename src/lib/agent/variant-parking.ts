// Variant parking (designer-workflow-parity spec §4.1/§4.2) — PURE patch
// builder for `pen_generate_variants`.
//
// After the dispatch applies the judged winner to the canvas, the runner-up
// designs are PARKED on a dedicated "Explorations" page instead of being
// discarded: each runner-up's node tree is wrapped in a labeled `section`
// node ("Variant B — 7") and inserted into the Explorations page via the
// page-target `add_subtree` op. Sections prune FIFO at 5 per document.
// Thumbnails ride the return value as `data:image/png;base64,…` within a
// 150KB-per-variant budget (over-budget → omitted, never a failure).
//
// This module is PURE: it takes the current document as an argument and
// returns the patch list + parked metadata. No imports from tools.ts, no
// store access, no I/O, no input mutation (specs are structuredClone'd).
//
// Applier realities this builder models (src/lib/canvas/patch.ts):
//   - `add_page` UNCONDITIONALLY appends a page and switches activePageIndex
//     to it — the builder scans doc.pages first and emits `add_page` only
//     when no Explorations page exists (case-insensitive substring match,
//     mirroring the applier's findPageIndex).
//   - `add_subtree` with a `pageName` target inserts into the NAMED page and
//     leaves the active tree untouched when that page is not the active one.
//   - `remove` honors the same page target: a `pageName` on the patch prunes
//     from THAT page's children (no active-page switch needed — the FIFO
//     prune is a plain targeted remove; controller ruling on the Task 4
//     review).
//
// Note: `add_page` switching the active page means the FIRST parking run on a
// page-less document leaves the viewer on the (freshly parked) Explorations
// page — accepted per the controller ruling; the chat card (Task 5), not a
// viewport restore, is the return affordance.

import type { CanvasDocument, CanvasPatch } from '../canvas/types';
import type { VariantSpec, VariantJudgeResult } from './subagents/variant-generator';

/// The parking page (created on first parking via `add_page`).
const EXPLORATIONS_PAGE_NAME = 'Explorations';
/// FIFO cap: at most 5 parked sections per document (spec §4.1).
const MAX_PARKED_SECTIONS = 5;
/// Thumbnails above this many bytes are omitted (spec §4.2 budget ≈ 3×100 KB;
/// over-budget drops thumbnails, never the trees).
const THUMBNAIL_MAX_BYTES = 150_000;

/// One parked alternative — `id` is the SECTION node id (the promote route's
/// key), `label` is the section name, `thumbnail` the optional data URL.
export interface ParkedAlternative {
  id: string;
  label: string;
  score: number;
  thumbnail?: string;
}

export interface BuildParkingPatchesArgs {
  /// The CURRENT document (post winner application) — read-only; never mutated.
  doc: CanvasDocument;
  variants: VariantSpec[];
  judge: VariantJudgeResult | null;
  winnerIndex: number;
  /// Name of the applied design (shown as "In use" on the promote card).
  mainDesignName?: string;
}

export interface ParkingPlan {
  patches: CanvasPatch[];
  parked: ParkedAlternative[];
}

/// First page whose name contains "Explorations" case-insensitively — the
/// SAME first-substring-match semantics the applier's `findPageIndex` uses
/// to resolve `pageName: 'Explorations'`, so the builder and the applier
/// always agree on the target page.
function findExplorationsPageIndex(doc: CanvasDocument): number {
  const pages = doc.pages ?? [];
  const needle = EXPLORATIONS_PAGE_NAME.toLowerCase();
  return pages.findIndex((p) => typeof p.name === 'string' && p.name.toLowerCase().includes(needle));
}

/// Mirror of tools.ts `hydrateSubtreeChildren` (inlined to keep this module
/// pure): variant specs went through the loose schema pipeline, so a
/// string-encoded `children` field must be parsed into a real array before
/// the tree is wrapped.
function hydrateChildren(node: Record<string, unknown>): void {
  let kids = node.children;
  if (typeof kids === 'string') {
    try {
      kids = JSON.parse(kids);
    } catch {
      kids = undefined;
    }
  }
  if (Array.isArray(kids)) {
    node.children = kids;
    for (const k of kids) {
      if (k && typeof k === 'object') hydrateChildren(k as Record<string, unknown>);
    }
  } else {
    delete node.children;
  }
}

/**
 * Build the parking patch sequence + parked metadata for a successful,
 * judged variant dispatch (spec §4.1/§4.2).
 *
 * Patch sequence:
 *   1. `add_page 'Explorations'` — ONLY when no Explorations page exists
 *      (the applier's add_page appends unconditionally).
 *   2. One `add_subtree` per runner-up, targeted at the Explorations page,
 *      wrapping the spec tree in a labeled `section` node with fresh ids.
 *   3. FIFO prune at 5: `{ op: 'remove', shapeIds, pageName }` dropping the
 *      OLDEST parked sections once the new set pushes the total past the
 *      cap — a page-targeted remove that works regardless of which page is
 *      active.
 *
 * The fatal path (no judge / invalid winnerIndex) parks NOTHING — parking
 * happens only on a successful judged dispatch.
 */
export function buildParkingPatches({ doc, variants, judge, winnerIndex }: BuildParkingPatchesArgs): ParkingPlan {
  const patches: CanvasPatch[] = [];
  const parked: ParkedAlternative[] = [];

  if (!judge || !Array.isArray(judge.scores)) return { patches, parked };
  if (!Number.isInteger(winnerIndex) || winnerIndex < 0 || winnerIndex >= variants.length) {
    return { patches, parked };
  }
  // Single-candidate dispatch (no runner-ups): nothing to park — not even an
  // empty Explorations page.
  if (variants.length <= 1) return { patches, parked };

  const pages = doc.pages ?? [];
  const explorationsIdx = findExplorationsPageIndex(doc);
  const createdPage = explorationsIdx < 0;
  if (createdPage) {
    patches.push({
      op: 'add_page',
      pageName: EXPLORATIONS_PAGE_NAME,
      summary: 'Created the Explorations page for parked variants',
    });
  }

  // ---- Runner-ups → labeled section wrappers ------------------------------
  variants.forEach((variant, i) => {
    if (i === winnerIndex) return;
    const rawScore = Number(judge.scores?.[i]);
    const score = Number.isFinite(rawScore) ? Math.round(rawScore) : 0;
    // Index-based letter — the winner's letter is skipped because it is not
    // parked (winner index 0 = 'A', so runner-ups are 'B', 'C', …).
    const letter = String.fromCharCode(65 + i);
    const label = `Variant ${letter} — ${score}`;
    const sectionId = crypto.randomUUID();
    // Fresh id on the spec root: the winner was applied from the same spec
    // pool, so reusing the original id could collide with applied nodes.
    const specRoot = structuredClone(variant.spec) as Record<string, unknown>;
    hydrateChildren(specRoot);
    specRoot.id = crypto.randomUUID();
    delete specRoot.parentId;
    const section = {
      id: sectionId,
      type: 'section',
      name: label,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      children: [specRoot],
    };
    patches.push({
      op: 'add_subtree',
      shapeId: sectionId,
      shape: section as unknown as CanvasPatch['shape'],
      pageName: EXPLORATIONS_PAGE_NAME,
      summary: `Parked variant ${letter} on the Explorations page`,
    });
    // Thumbnail budget (spec §4.2): within 150KB → data URL; over-budget or
    // missing → omitted. Parking NEVER fails over thumbnails.
    const png = variant.png;
    const thumbnail =
      png && png.length > 0 && png.length <= THUMBNAIL_MAX_BYTES
        ? `data:image/png;base64,${png.toString('base64')}`
        : undefined;
    parked.push({ id: sectionId, label, score, ...(thumbnail ? { thumbnail } : {}) });
  });

  // ---- FIFO prune at 5 (spec §4.1) ----------------------------------------
  // Existing parked sections = the Explorations page's `section` children,
  // oldest FIRST (children order). After adding K new sections, drop the
  // (existing + K) - 5 oldest via a PAGE-TARGETED remove — the applier prunes
  // that page's children directly (no active-page switch, no restore; the
  // active tree and its derived `shapes` cache stay untouched).
  const existingSections = createdPage
    ? []
    : (pages[explorationsIdx]?.children ?? []).filter((c) => c.type === 'section');
  const pruneCount = Math.max(0, existingSections.length + parked.length - MAX_PARKED_SECTIONS);
  if (pruneCount > 0) {
    patches.push({
      op: 'remove',
      shapeIds: existingSections.slice(0, pruneCount).map((c) => c.id),
      pageName: EXPLORATIONS_PAGE_NAME,
      summary:
        pruneCount === 1
          ? 'Pruned the oldest parked variant from the Explorations page'
          : `Pruned ${pruneCount} oldest parked variants from the Explorations page`,
    });
  }

  return { patches, parked };
}
