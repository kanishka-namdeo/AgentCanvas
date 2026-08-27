// Measure overlay — Phase 7 §H.2 (spec docs/html-dom-renderer.md Appendix H.2).
//
// Pure-math coverage of the `computeMeasureOverlay` geometry helper +
// `formatDistance` label formatter. The overlay React component itself
// (src/components/canvas/dom/MeasureOverlay.tsx) is a thin renderer that
// transforms canvas-space guide endpoints to screen space and emits SVG —
// the geometry + sorting + capping logic all lives in the pure helper and
// is what these tests cover.
//
// Coverage matrix (per the implementation plan):
//   - computeMeasureOverlay:
//     - empty selection → []
//     - no siblings (single selected layer, no parent) → []
//     - horizontal gap between two side-by-side siblings
//     - vertical gap between two stacked siblings
//     - overlapping rects filtered out (zero/negative gap)
//     - siblings farther than maxDistance filtered out
//     - parent-frame edge measurements included when parentId matches a layer
//     - cap at 12 guides (30 valid pairs → 12 returned)
//     - results sorted ascending by distance
//   - formatDistance:
//     - 0 → "0", 12 → "12", -4 → "−4" (U+2212), 1234 → "1234"

import { describe, it, expect } from 'vitest';
import {
  computeMeasureOverlay,
  formatDistance,
  type LayerLike,
} from '@/lib/canvas/measure-overlay';

const PTR = { x: 0, y: 0 }; // pointer position — currently unused by the helper

describe('computeMeasureOverlay — selection / sibling existence', () => {
  it('returns empty array when selection is empty', () => {
    const layers: LayerLike[] = [
      { id: 'A', x: 0, y: 0, width: 10, height: 10 },
      { id: 'B', x: 20, y: 0, width: 10, height: 10 },
    ];
    const guides = computeMeasureOverlay(PTR, layers, []);
    expect(guides).toEqual([]);
  });

  it('returns empty array when no siblings exist (single selected layer, no parent)', () => {
    const layers: LayerLike[] = [
      { id: 'S', x: 0, y: 0, width: 10, height: 10 },
    ];
    const guides = computeMeasureOverlay(PTR, layers, ['S']);
    expect(guides).toEqual([]);
  });

  it('returns empty array when other layers exist but are not siblings (different parents)', () => {
    const layers: LayerLike[] = [
      { id: 'S', x: 0, y: 0, width: 10, height: 10, parentId: null },
      { id: 'X', x: 20, y: 0, width: 10, height: 10, parentId: 'frame1' },
    ];
    const guides = computeMeasureOverlay(PTR, layers, ['S']);
    expect(guides).toEqual([]);
  });

  it('returns empty array when the selected layer is not in the layers list', () => {
    const layers: LayerLike[] = [
      { id: 'A', x: 0, y: 0, width: 10, height: 10 },
    ];
    const guides = computeMeasureOverlay(PTR, layers, ['does-not-exist']);
    expect(guides).toEqual([]);
  });
});

describe('computeMeasureOverlay — sibling gaps', () => {
  it('returns horizontal gap measurement between two side-by-side siblings', () => {
    const S: LayerLike = { id: 'S', x: 0, y: 0, width: 10, height: 10, parentId: null };
    const X: LayerLike = { id: 'X', x: 20, y: 0, width: 10, height: 10, parentId: null };
    const guides = computeMeasureOverlay(PTR, [S, X], ['S']);
    expect(guides).toHaveLength(1);
    const g = guides[0]!;
    expect(g.axis).toBe('h');
    expect(g.distance).toBe(10);
    // S is to the LEFT of X — line goes from S's right edge to X's left edge.
    expect(g.from).toBe(S);
    expect(g.to).toBe(X);
    expect(g.fromEdge).toBe('right');
    expect(g.toEdge).toBe('left');
  });

  it('normalizes from/to so `from` is always the lesser-positioned rect (left for horizontal)', () => {
    // Select the RIGHT sibling — `from` should still be the LEFT one.
    const S: LayerLike = { id: 'S', x: 20, y: 0, width: 10, height: 10, parentId: null };
    const X: LayerLike = { id: 'X', x: 0, y: 0, width: 10, height: 10, parentId: null };
    const guides = computeMeasureOverlay(PTR, [S, X], ['S']);
    expect(guides).toHaveLength(1);
    const g = guides[0]!;
    expect(g.from).toBe(X); // X is the left one
    expect(g.to).toBe(S);
    expect(g.fromEdge).toBe('right');
    expect(g.toEdge).toBe('left');
    expect(g.distance).toBe(10);
  });

  it('returns vertical gap measurement between two stacked siblings', () => {
    const S: LayerLike = { id: 'S', x: 0, y: 0, width: 10, height: 10, parentId: null };
    const X: LayerLike = { id: 'X', x: 0, y: 20, width: 10, height: 10, parentId: null };
    const guides = computeMeasureOverlay(PTR, [S, X], ['S']);
    expect(guides).toHaveLength(1);
    const g = guides[0]!;
    expect(g.axis).toBe('v');
    expect(g.distance).toBe(10);
    expect(g.from).toBe(S); // S is above X
    expect(g.to).toBe(X);
    expect(g.fromEdge).toBe('bottom');
    expect(g.toEdge).toBe('top');
  });

  it('returns both horizontal AND vertical gap when siblings are diagonal', () => {
    // S at (0,0,10,10), X at (20,30,10,10) — neither y nor x ranges overlap.
    // The horizontal gap requires y-range overlap; vertical requires x-range
    // overlap. Here NEITHER overlaps → no guides (gap is purely diagonal).
    const S: LayerLike = { id: 'S', x: 0, y: 0, width: 10, height: 10, parentId: null };
    const X: LayerLike = { id: 'X', x: 20, y: 30, width: 10, height: 10, parentId: null };
    const guides = computeMeasureOverlay(PTR, [S, X], ['S']);
    expect(guides).toEqual([]);
  });

  it('returns both horizontal AND vertical gap when sibling is offset in both axes but still overlaps', () => {
    // S at (0,0,30,30), X at (40,40,30,30) — y ranges [0,30] vs [40,70]: NO
    // overlap. x ranges [0,30] vs [40,70]: NO overlap. Wait that's diagonal
    // again — let me make them overlap in BOTH:
    // S at (0,0,30,30), X at (40,40,5,5) — y [0,30] vs [40,45]: no overlap;
    // x [0,30] vs [40,45]: no overlap. Still diagonal.
    //
    // Real overlap-in-both case: S at (0,0,30,30), X at (40,10,5,5) — y [0,30]
    // vs [10,15]: overlap [10,15] (len 5); x [0,30] vs [40,45]: no overlap.
    // → horizontal gap (y overlaps, x doesn't) but NO vertical gap (x doesn't
    //   overlap).
    //
    // To get BOTH h and v gaps simultaneously from one pair, the rects would
    // need to overlap in BOTH x and y AND be separated in both — impossible.
    // So a single (S,X) pair contributes AT MOST one guide (either h OR v).
    // Document that invariant.
    const S: LayerLike = { id: 'S', x: 0, y: 0, width: 30, height: 30, parentId: null };
    const X: LayerLike = { id: 'X', x: 40, y: 10, width: 5, height: 5, parentId: null };
    const guides = computeMeasureOverlay(PTR, [S, X], ['S']);
    expect(guides).toHaveLength(1);
    expect(guides[0]!.axis).toBe('h');
  });
});

describe('computeMeasureOverlay — overlap + distance filtering', () => {
  it('filters out overlapping rects (zero horizontal gap when rects overlap in x)', () => {
    // S and X overlap in x and overlap in y → no horizontal gap (x ranges
    // overlap → no positive x-distance) AND no vertical gap (y ranges
    // overlap → no positive y-distance). Should produce zero guides.
    const S: LayerLike = { id: 'S', x: 0, y: 0, width: 20, height: 20, parentId: null };
    const X: LayerLike = { id: 'X', x: 10, y: 10, width: 20, height: 20, parentId: null };
    const guides = computeMeasureOverlay(PTR, [S, X], ['S']);
    expect(guides).toEqual([]);
  });

  it('filters out siblings farther than maxDistance (default 200)', () => {
    const S: LayerLike = { id: 'S', x: 0, y: 0, width: 1, height: 1, parentId: null };
    const X1: LayerLike = { id: 'X1', x: 50, y: 0, width: 1, height: 1, parentId: null };
    // 299 canvas px gap — exceeds the 200 default.
    const X2: LayerLike = { id: 'X2', x: 300, y: 0, width: 1, height: 1, parentId: null };
    const guides = computeMeasureOverlay(PTR, [S, X1, X2], ['S']);
    expect(guides).toHaveLength(1);
    expect(guides[0]!.to).toBe(X1);
    expect(guides[0]!.distance).toBe(49);
  });

  it('respects a custom maxDistance option', () => {
    const S: LayerLike = { id: 'S', x: 0, y: 0, width: 1, height: 1, parentId: null };
    const X1: LayerLike = { id: 'X1', x: 50, y: 0, width: 1, height: 1, parentId: null };
    const X2: LayerLike = { id: 'X2', x: 100, y: 0, width: 1, height: 1, parentId: null };
    // maxDistance 60: X1 (gap 49) included, X2 (gap 99) excluded.
    const guides = computeMeasureOverlay(PTR, [S, X1, X2], ['S'], { maxDistance: 60 });
    expect(guides).toHaveLength(1);
    expect(guides[0]!.to).toBe(X1);
  });

  it('does not count the selected layer against itself (no self-gap)', () => {
    const S: LayerLike = { id: 'S', x: 0, y: 0, width: 10, height: 10, parentId: null };
    const guides = computeMeasureOverlay(PTR, [S], ['S']);
    expect(guides).toEqual([]);
  });

  it('does not produce sibling gaps to other selected layers', () => {
    // Two selected siblings — neither should produce sibling-gap guides
    // against the other (both are in the selection). No parent → no
    // parent-edge guides either. → [].
    const S: LayerLike = { id: 'S', x: 0, y: 0, width: 10, height: 10, parentId: null };
    const X: LayerLike = { id: 'X', x: 20, y: 0, width: 10, height: 10, parentId: null };
    const guides = computeMeasureOverlay(PTR, [S, X], ['S', 'X']);
    expect(guides).toEqual([]);
  });
});

describe('computeMeasureOverlay — parent-frame edges', () => {
  it('includes measurements to parent frame edges when parentId matches a layer in the list', () => {
    const P: LayerLike = { id: 'P', x: 0, y: 0, width: 100, height: 100, parentId: null };
    const S: LayerLike = { id: 'S', x: 10, y: 10, width: 20, height: 20, parentId: 'P' };
    const guides = computeMeasureOverlay(PTR, [P, S], ['S']);
    // 4 parent-edge guides: left=10, top=10, right=70, bottom=70.
    expect(guides).toHaveLength(4);
    const distances = guides.map((g) => g.distance).sort((a, b) => a - b);
    expect(distances).toEqual([10, 10, 70, 70]);
    // Each guide should reference the parent P (either as `from` or `to`).
    for (const g of guides) {
      expect(g.from === P || g.to === P).toBe(true);
    }
  });

  it('parent-edge left guide: from=parent, to=child, axis=h, fromEdge=left, toEdge=left', () => {
    const P: LayerLike = { id: 'P', x: 0, y: 0, width: 100, height: 100, parentId: null };
    const S: LayerLike = { id: 'S', x: 10, y: 10, width: 20, height: 20, parentId: 'P' };
    const guides = computeMeasureOverlay(PTR, [P, S], ['S']);
    const left = guides.find((g) => g.axis === 'h' && g.fromEdge === 'left' && g.toEdge === 'left');
    expect(left).toBeDefined();
    expect(left!.from).toBe(P);
    expect(left!.to).toBe(S);
    expect(left!.distance).toBe(10);
  });

  it('parent-edge right guide: from=child, to=parent, axis=h, fromEdge=right, toEdge=right', () => {
    const P: LayerLike = { id: 'P', x: 0, y: 0, width: 100, height: 100, parentId: null };
    const S: LayerLike = { id: 'S', x: 10, y: 10, width: 20, height: 20, parentId: 'P' };
    const guides = computeMeasureOverlay(PTR, [P, S], ['S']);
    const right = guides.find((g) => g.axis === 'h' && g.fromEdge === 'right' && g.toEdge === 'right');
    expect(right).toBeDefined();
    expect(right!.from).toBe(S);
    expect(right!.to).toBe(P);
    expect(right!.distance).toBe(70);
  });

  it('parent-edge top guide: from=parent, to=child, axis=v, fromEdge=top, toEdge=top', () => {
    const P: LayerLike = { id: 'P', x: 0, y: 0, width: 100, height: 100, parentId: null };
    const S: LayerLike = { id: 'S', x: 10, y: 10, width: 20, height: 20, parentId: 'P' };
    const guides = computeMeasureOverlay(PTR, [P, S], ['S']);
    const top = guides.find((g) => g.axis === 'v' && g.fromEdge === 'top' && g.toEdge === 'top');
    expect(top).toBeDefined();
    expect(top!.from).toBe(P);
    expect(top!.to).toBe(S);
    expect(top!.distance).toBe(10);
  });

  it('parent-edge bottom guide: from=child, to=parent, axis=v, fromEdge=bottom, toEdge=bottom', () => {
    const P: LayerLike = { id: 'P', x: 0, y: 0, width: 100, height: 100, parentId: null };
    const S: LayerLike = { id: 'S', x: 10, y: 10, width: 20, height: 20, parentId: 'P' };
    const guides = computeMeasureOverlay(PTR, [P, S], ['S']);
    const bottom = guides.find((g) => g.axis === 'v' && g.fromEdge === 'bottom' && g.toEdge === 'bottom');
    expect(bottom).toBeDefined();
    expect(bottom!.from).toBe(S);
    expect(bottom!.to).toBe(P);
    expect(bottom!.distance).toBe(70);
  });

  it('does not crash when parentId does not match any layer (orphan)', () => {
    // S claims a parentId that's not in layers — no parent-edge guides.
    const S: LayerLike = { id: 'S', x: 0, y: 0, width: 10, height: 10, parentId: 'ghost' };
    const guides = computeMeasureOverlay(PTR, [S], ['S']);
    expect(guides).toEqual([]);
  });

  it('skips parent-edge guide when the corresponding distance is 0 (child flush with edge)', () => {
    // Child touches parent's left + top edges (gaps 0). Only the right +
    // bottom parent-edge guides should be produced (distances 80 + 80).
    const P: LayerLike = { id: 'P', x: 0, y: 0, width: 100, height: 100, parentId: null };
    const S: LayerLike = { id: 'S', x: 0, y: 0, width: 20, height: 20, parentId: 'P' };
    const guides = computeMeasureOverlay(PTR, [P, S], ['S']);
    expect(guides).toHaveLength(2);
    expect(guides.every((g) => g.distance === 80)).toBe(true);
  });
});

describe('computeMeasureOverlay — sorting + cap', () => {
  it('sorts results ascending by distance', () => {
    const S: LayerLike = { id: 'S', x: 0, y: 0, width: 1, height: 1, parentId: null };
    const X1: LayerLike = { id: 'X1', x: 200, y: 0, width: 1, height: 1, parentId: null }; // gap 199
    const X2: LayerLike = { id: 'X2', x: 50, y: 0, width: 1, height: 1, parentId: null }; // gap 49
    const X3: LayerLike = { id: 'X3', x: 100, y: 0, width: 1, height: 1, parentId: null }; // gap 99
    const guides = computeMeasureOverlay(PTR, [S, X1, X2, X3], ['S']);
    expect(guides.map((g) => g.distance)).toEqual([49, 99, 199]);
  });

  it('caps at 12 guides (synth 30 valid pairs → 12 returned)', () => {
    // 1 selected + 30 siblings, all horizontally laid out with valid
    // (positive, <= 200) gaps. Sort + slice(0, 12) → 12 returned.
    const S: LayerLike = { id: 'S', x: 0, y: 0, width: 1, height: 1, parentId: null };
    const layers: LayerLike[] = [S];
    // Siblings at x = 1 + i*6, width 1, height 1, y 0 (so all share y-range).
    // Gap for sibling i = (1 + i*6) - 1 = i*6, for i = 1..30 → gaps 6..180
    // (all <= 200 default maxDistance). 30 valid horizontal-gap guides total.
    for (let i = 1; i <= 30; i++) {
      layers.push({ id: `X${i}`, x: 1 + i * 6, y: 0, width: 1, height: 1, parentId: null });
    }
    const guides = computeMeasureOverlay(PTR, layers, ['S']);
    expect(guides).toHaveLength(12);
    // First 12 after ascending sort: gaps 6, 12, 18, ..., 72.
    expect(guides.map((g) => g.distance)).toEqual([6, 12, 18, 24, 30, 36, 42, 48, 54, 60, 66, 72]);
  });

  it('does not cap below 12 when fewer guides exist (returns all valid)', () => {
    const S: LayerLike = { id: 'S', x: 0, y: 0, width: 1, height: 1, parentId: null };
    const X1: LayerLike = { id: 'X1', x: 50, y: 0, width: 1, height: 1, parentId: null };
    const X2: LayerLike = { id: 'X2', x: 100, y: 0, width: 1, height: 1, parentId: null };
    const guides = computeMeasureOverlay(PTR, [S, X1, X2], ['S']);
    expect(guides).toHaveLength(2);
  });
});

describe('computeMeasureOverlay — multi-selection', () => {
  it('produces guides for each selected layer', () => {
    // S1 (selected, left) and S2 (selected, right) are siblings of X (not
    // selected). Each selected layer produces one guide to X.
    const S1: LayerLike = { id: 'S1', x: 0, y: 0, width: 10, height: 10, parentId: null };
    const S2: LayerLike = { id: 'S2', x: 30, y: 0, width: 10, height: 10, parentId: null };
    const X: LayerLike = { id: 'X', x: 60, y: 0, width: 10, height: 10, parentId: null };
    const guides = computeMeasureOverlay(PTR, [S1, S2, X], ['S1', 'S2']);
    expect(guides).toHaveLength(2);
    // Both guides have axis 'h' (horizontal gaps to X on the right).
    expect(guides.every((g) => g.axis === 'h')).toBe(true);
    // Distances: S1→X = 50, S2→X = 20. Sorted: [20, 50].
    expect(guides.map((g) => g.distance)).toEqual([20, 50]);
  });
});

describe('formatDistance', () => {
  it('0 → "0"', () => {
    expect(formatDistance(0)).toBe('0');
  });

  it('12 → "12"', () => {
    expect(formatDistance(12)).toBe('12');
  });

  it('-4 → "−4" (U+2212 unicode minus, not ASCII hyphen)', () => {
    const s = formatDistance(-4);
    expect(s).toBe('−4');
    expect(s.charCodeAt(0)).toBe(0x2212);
    expect(s).not.toBe('-4'); // ASCII hyphen-minus would be charCode 0x2d
  });

  it('1234 → "1234"', () => {
    expect(formatDistance(1234)).toBe('1234');
  });

  it('rounds non-integer distances to nearest integer', () => {
    expect(formatDistance(12.4)).toBe('12');
    expect(formatDistance(12.5)).toBe('13'); // Math.round ties → up
    expect(formatDistance(-4.4)).toBe('−4');
    expect(formatDistance(-4.5)).toBe('−4'); // Math.round(-4.5) = -4 (ties toward +Infinity)
  });

  it('returns "∞" for +Infinity and "−∞" for -Infinity', () => {
    expect(formatDistance(Number.POSITIVE_INFINITY)).toBe('∞');
    expect(formatDistance(Number.NEGATIVE_INFINITY)).toBe('−∞');
  });

  it('returns "0" for -0 (does not produce "−0")', () => {
    expect(formatDistance(-0)).toBe('0');
  });
});
