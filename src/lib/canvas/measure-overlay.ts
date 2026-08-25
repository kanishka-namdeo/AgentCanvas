// measure-overlay.ts — Phase 7 §H.2 (spec docs/html-dom-renderer.md Appendix
// H.2) geometry helper. Pure math, no React — jsdom-safe and unit-testable.
//
// Given a pointer position (canvas space), the flat layer list, and the
// current selection, computes the set of distance redlines to paint: for
// each selected layer, the gap to each of its siblings (same `parentId`)
// — horizontal gap when their y-ranges overlap, vertical gap when their
// x-ranges overlap — plus, when the selected layer is inside a frame, the
// four edge-to-edge distances to that containing frame's edges.
//
// All gaps are filtered to a configurable maxDistance (default 200 canvas
// px), zero/negative distances are dropped (overlapping rects), and the
// final result is sorted ascending by distance and capped at 12 guides so
// the overlay doesn't get noisy on dense layouts.
//
// The renderer (MeasureOverlay.tsx) consumes the resulting MeasureGuide[]
// and paints red lines + labels at the guide midpoints, transforming each
// canvas-space endpoint to screen via `screen = canvas * zoom + pan`.
//
// The `pointerCanvas` parameter is accepted (per the spec signature) but
// currently unused inside the helper — the overlay component gates the
// call on `pointerCanvas != null`, and a future iteration can filter
// guides to those near the pointer without changing the call sites.

/// A canvas-space rectangle (subset of Layer — what the helper needs).
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/// Layer subset accepted by the helper. Any object with these fields works
/// (Layer satisfies it; so do ad-hoc test fixtures).
export interface LayerLike {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  parentId?: string | null;
}

/// Which edge of a rect a guide endpoint sits on. The renderer uses this
/// to compute the line's start/end coordinates along the guide's axis.
export type Edge = 'left' | 'right' | 'top' | 'bottom';

/// A single redline measurement between two rects along one axis. The
/// spec's base shape is `{ from, to, distance, axis }`; we extend with
/// `fromEdge` / `toEdge` so the renderer can paint the line unambiguously
/// in the parent-frame-edge case (where the two rects overlap and the
/// "facing edges" rule alone wouldn't disambiguate left-vs-right or
/// top-vs-bottom).
export interface MeasureGuide {
  from: Rect;
  to: Rect;
  distance: number;
  axis: 'h' | 'v';
  fromEdge: Edge;
  toEdge: Edge;
}

/// Default maxDistance (canvas px) — siblings / parent edges farther than
/// this are not painted (matches Figma's "nearby" behavior).
const DEFAULT_MAX_DISTANCE = 200;

/// Cap on the number of guides returned, to keep the overlay legible on
/// dense layouts (Figma shows ~3-5 in practice; 12 is a generous ceiling).
const MAX_GUIDES = 12;

/// Length of the y-range intersection of two rects (0 if disjoint).
function yOverlap(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
}

/// Length of the x-range intersection of two rects (0 if disjoint).
function xOverlap(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
}

export interface ComputeMeasureOverlayOptions {
  maxDistance?: number;
}

/**
 * Compute the set of measure-overlay guides for the current selection.
 *
 * @param pointerCanvas - Reserved for future "near pointer" filtering. The
 *   overlay component gates the call on this being non-null, but the
 *   helper currently returns all valid guides regardless of pointer
 *   position (the spec only requires "nearby" by distance, which the
 *   maxDistance filter handles).
 * @param layers - Flat list of canvas layers (Layer[] from the store works
 *   directly — only id/x/y/width/height/parentId are read).
 * @param selection - Selected layer ids. Guides are computed per selected
 *   layer.
 * @param opts.maxDistance - Maximum canvas-px gap to include (default 200).
 * @returns Sorted, capped MeasureGuide[] (ascending by distance, max 12).
 */
export function computeMeasureOverlay(
  pointerCanvas: { x: number; y: number },
  layers: ReadonlyArray<LayerLike>,
  selection: ReadonlyArray<string>,
  opts?: ComputeMeasureOverlayOptions,
): MeasureGuide[] {
  // Mark pointerCanvas as intentionally unused — the parameter exists per
  // the spec signature so future "near pointer" filtering can be added
  // without changing call sites. (Mark with a void expression so eslint
  // doesn't flag it and the parameter name stays discoverable.)
  void pointerCanvas;

  if (selection.length === 0) return [];

  const maxDistance = opts?.maxDistance ?? DEFAULT_MAX_DISTANCE;
  const selectedSet = new Set(selection);
  const byId = new Map<string, LayerLike>();
  for (const l of layers) byId.set(l.id, l);

  const guides: MeasureGuide[] = [];

  for (const selId of selection) {
    const S = byId.get(selId);
    if (!S) continue;
    const pid = S.parentId ?? null;

    // ---- Sibling gaps (same parentId, not selected, not S itself) ----
    // For each (S, X) pair, compute horizontal gap (when y-ranges overlap)
    // AND vertical gap (when x-ranges overlap). The "from" rect is always
    // the lesser-positioned one (left / top) so the renderer can draw the
    // line from from's right/bottom edge to to's left/top edge without
    // ambiguity.
    for (const X of layers) {
      if (X.id === S.id) continue;
      if (selectedSet.has(X.id)) continue;
      if ((X.parentId ?? null) !== pid) continue;

      // Horizontal gap — y-ranges must overlap (otherwise the gap is
      // diagonal, which Figma doesn't show as a single redline).
      if (yOverlap(S, X) > 0) {
        if (S.x + S.width <= X.x) {
          // S is left of X.
          const gap = X.x - (S.x + S.width);
          if (gap > 0 && gap <= maxDistance) {
            guides.push({ from: S, to: X, distance: gap, axis: 'h', fromEdge: 'right', toEdge: 'left' });
          }
        } else if (X.x + X.width <= S.x) {
          // X is left of S.
          const gap = S.x - (X.x + X.width);
          if (gap > 0 && gap <= maxDistance) {
            guides.push({ from: X, to: S, distance: gap, axis: 'h', fromEdge: 'right', toEdge: 'left' });
          }
        }
        // else: rects overlap in x — no positive horizontal gap.
      }

      // Vertical gap — x-ranges must overlap.
      if (xOverlap(S, X) > 0) {
        if (S.y + S.height <= X.y) {
          // S is above X.
          const gap = X.y - (S.y + S.height);
          if (gap > 0 && gap <= maxDistance) {
            guides.push({ from: S, to: X, distance: gap, axis: 'v', fromEdge: 'bottom', toEdge: 'top' });
          }
        } else if (X.y + X.height <= S.y) {
          // X is above S.
          const gap = S.y - (X.y + X.height);
          if (gap > 0 && gap <= maxDistance) {
            guides.push({ from: X, to: S, distance: gap, axis: 'v', fromEdge: 'bottom', toEdge: 'top' });
          }
        }
      }
    }

    // ---- Parent-frame edges (S's parentId is in the layers list) ----
    // Four edge-to-edge measurements: S.left ↔ P.left, S.right ↔ P.right,
    // S.top ↔ P.top, S.bottom ↔ P.bottom. `from` is always the rect whose
    // edge is the "from" of the line — for the left/top edges that's the
    // parent (parent's edge is at a lesser coord than S's); for the
    // right/bottom edges that's S (S's edge is at a lesser coord than
    // parent's).
    if (pid != null) {
      const P = byId.get(pid);
      if (P) {
        const leftGap = S.x - P.x;
        if (leftGap > 0 && leftGap <= maxDistance) {
          guides.push({ from: P, to: S, distance: leftGap, axis: 'h', fromEdge: 'left', toEdge: 'left' });
        }
        const rightGap = P.x + P.width - (S.x + S.width);
        if (rightGap > 0 && rightGap <= maxDistance) {
          guides.push({ from: S, to: P, distance: rightGap, axis: 'h', fromEdge: 'right', toEdge: 'right' });
        }
        const topGap = S.y - P.y;
        if (topGap > 0 && topGap <= maxDistance) {
          guides.push({ from: P, to: S, distance: topGap, axis: 'v', fromEdge: 'top', toEdge: 'top' });
        }
        const bottomGap = P.y + P.height - (S.y + S.height);
        if (bottomGap > 0 && bottomGap <= maxDistance) {
          guides.push({ from: S, to: P, distance: bottomGap, axis: 'v', fromEdge: 'bottom', toEdge: 'bottom' });
        }
      }
    }
  }

  // Sort ascending by distance (stable for ties so test fixtures are
  // deterministic), then cap at MAX_GUIDES.
  guides.sort((a, b) => a.distance - b.distance);
  return guides.slice(0, MAX_GUIDES);
}

const MINUS = '\u2212'; // U+2212 unicode minus sign (Figma redline convention)

/**
 * Format a canvas-px distance for the overlay label. Uses the unicode
 * minus (U+2212) for negative values to match Figma's redline typography
 * (the ASCII hyphen-minus reads as a tiny dash and is harder to see
 * against the red label color).
 *
 *   0     → "0"
 *   12    → "12"
 *   -4    → "−4"   (U+2212)
 *   1234  → "1234"
 *
 * Non-integer values are rounded to the nearest integer — the overlay
 * paints in canvas-space px, which is always an integer for snapped
 * geometry; rounding avoids a "-12.4999" label flicker during drags.
 */
export function formatDistance(d: number): string {
  if (!Number.isFinite(d)) return d > 0 ? '∞' : '−∞';
  const rounded = Math.round(d);
  if (rounded < 0) return MINUS + String(Math.abs(rounded));
  return String(rounded);
}
