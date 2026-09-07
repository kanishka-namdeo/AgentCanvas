// Deterministic one-shot patch polish.
//
// Applied by the /api/agent route ONLY on empty-canvas (first-creation)
// turns: geometry fixes that cost zero LLM tokens and catch the most common
// "AI slop" geometry defects before they reach any client:
//   1. GRID SNAP - x/y/width/height rounded to the 4px (half-8pt) grid.
//   2. DUPLICATE DEDUPE - fully-identical sibling nodes (same type, name,
//      text, fill, geometry) collapse to their first occurrence.
//   3. GLASS-STACK COLLAPSE - sibling rectangles with near-identical geometry
//      where at least one is translucent collapse to the most opaque one
//      (the classic "broken header: overlapping translucent gray rects"
//      artifact). VLM-judged defect class from the 2026-09-07 one-shot eval.
// Multi-shot turns are never routed through here (the canvas is non-empty
// at turn start), so follow-up behavior is byte-identical to before.

import type { CanvasPatch } from './types';

const GRID = 4;

const snap = (v: number): number => Math.round(v / GRID) * GRID;
const snapNum = (v: unknown): unknown =>
  typeof v === 'number' && Number.isFinite(v) ? snap(v) : v;
/// Hairline guard: 1px dividers/gridlines/axes are INTENTIONAL sub-grid
/// geometry — snapping them to the 4px grid rounds 1 → 0 and erases the
/// line entirely (2026-09-07 eval: chart gridlines + x-axis baseline
/// vanished after polish). Keep any dimension ≤ 2px exactly as authored.
const snapDim = (v: unknown): unknown => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return v;
  if (Math.abs(v) > 0 && Math.abs(v) <= 2) return v;
  return snap(v);
};

interface AnyShape {
  type?: unknown;
  name?: unknown;
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
  text?: unknown;
  fill?: unknown;
  opacity?: unknown;
  children?: unknown;
  [k: string]: unknown;
}

function dedupeIdentical(shapes: AnyShape[]): void {
  const seen = new Set<string>();
  const keep: AnyShape[] = [];
  for (const s of shapes) {
    const key = [s.type, s.name, s.text, s.fill, s.x, s.y, s.width, s.height]
      .map((v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : String(v ?? '')))
      .join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    keep.push(s);
  }
  if (keep.length !== shapes.length) {
    shapes.length = 0;
    shapes.push(...keep);
  }
}

// ---- glass-stack collapse ---------------------------------------------------
//
// Effective opacity of a childless rect/frame: 8-digit-hex alpha × opacity.
// Returns -1 for nodes we cannot judge (variables, gradients, 'none') —
// those never participate in collapsing.

function effectiveOpacity(s: AnyShape): number {
  let alpha = 1;
  const fill = s.fill;
  if (typeof fill === 'string') {
    if (fill === 'none' || fill === 'transparent') return -1;
    if (/^#[0-9a-fA-F]{8}$/.test(fill)) alpha = parseInt(fill.slice(6, 8), 16) / 255;
    else if (fill.startsWith('$')) return -1; // unresolved variable — assume opaque
  } else if (fill && typeof fill === 'object') {
    return -1; // gradient object — cannot judge translucency
  }
  const op = typeof s.opacity === 'number' && Number.isFinite(s.opacity as number) ? (s.opacity as number) : 1;
  return alpha * op;
}

const isStackableRect = (s: AnyShape): boolean =>
  (s.type === 'rectangle' || s.type === 'frame') &&
  !(Array.isArray(s.children) && (s.children as AnyShape[]).length > 0);

const nearIdenticalGeometry = (a: AnyShape, b: AnyShape): boolean =>
  Math.abs(Number(a.x ?? 0) - Number(b.x ?? 0)) <= 2 &&
  Math.abs(Number(a.y ?? 0) - Number(b.y ?? 0)) <= 2 &&
  Math.abs(Number(a.width ?? 0) - Number(b.width ?? 0)) <= 2 &&
  Math.abs(Number(a.height ?? 0) - Number(b.height ?? 0)) <= 2;

function collapseGlassStacks(shapes: AnyShape[]): void {
  const remove = new Set<number>();
  for (let i = 0; i < shapes.length; i++) {
    if (remove.has(i) || !isStackableRect(shapes[i])) continue;
    const oi = effectiveOpacity(shapes[i]);
    if (oi < 0) continue;
    let iRemoved = false;
    for (let j = i + 1; j < shapes.length; j++) {
      if (remove.has(j) || !isStackableRect(shapes[j])) continue;
      if (!nearIdenticalGeometry(shapes[i], shapes[j])) continue;
      const oj = effectiveOpacity(shapes[j]);
      if (oj < 0) continue;
      // Only fire when at least one of the pair is translucent — two opaque
      // same-geometry rects may be an intentional (if sloppy) z-order trick.
      if (oi >= 0.96 && oj >= 0.96) continue;
      if (oi >= oj) {
        remove.add(j); // keep i, keep scanning for more stacked copies
      } else {
        remove.add(i); // keep j (more opaque)
        iRemoved = true;
        break;
      }
    }
    if (iRemoved) continue;
  }
  if (remove.size === 0) return;
  const keep = shapes.filter((_, idx) => !remove.has(idx));
  shapes.length = 0;
  shapes.push(...keep);
}

function polishShape(s: AnyShape): void {
  s.x = snapNum(s.x);
  s.y = snapNum(s.y);
  s.width = snapDim(s.width);
  s.height = snapDim(s.height);
  if (Array.isArray(s.children)) {
    const kids = s.children as AnyShape[];
    dedupeIdentical(kids);
    collapseGlassStacks(kids);
    fitFrameToChildren(s, kids);
    for (const c of kids) polishShape(c);
  }
}

// ---- frame fit-to-children ---------------------------------------------------
//
// 2026-09-07 complex eval r1: the model ships PAGE-LEVEL frames at the 100px
// default fixed height while their content flows 300-1400px below — the
// frame's fill then paints a short tinted band across the top of the design
// ("broken header" VLM defect) and the CONTAINER SIZING RULE prompt alone
// didn't stop it. Deterministic fix: when a frame's children extend past its
// fixed height by a clear margin, grow the frame to wrap them. Guards:
//   - only frames with a CONCRETE numeric height (never 'fit_content' /
//     'fill_container' strings — those already hug/fill);
//   - children must have concrete y + height numbers;
//   - growth is one-directional (never shrink — small fixed chrome like
//     buttons with overflowing labels keeps its authored size);
//   - needs >= 24px of overflow: sub-pixel/rounding deltas don't count.
function fitFrameToChildren(parent: AnyShape, kids: AnyShape[]): void {
  if (typeof parent.height !== 'number' || !Number.isFinite(parent.height)) return;
  let maxBottom = -Infinity;
  for (const c of kids) {
    const y = Number(c.y);
    const h = Number(c.height);
    if (!Number.isFinite(y) || !Number.isFinite(h)) continue;
    maxBottom = Math.max(maxBottom, y + h);
  }
  if (!Number.isFinite(maxBottom)) return;
  const overflow = maxBottom - (parent.height as number);
  if (overflow >= 24) {
    parent.height = snap(maxBottom);
  }
}

/// Snap create/update patch payloads to the 4px grid, collapse
/// fully-identical duplicate nodes, and collapse translucent glass-stacks.
/// Mutates and returns the same patch.
export function polishOneShotPatch(patch: CanvasPatch): CanvasPatch {
  const op = patch.op;
  if (op === 'add' || op === 'add_subtree' || op === 'update') {
    if (patch.shape) polishShape(patch.shape as AnyShape);
  } else if (op === 'bulk_add') {
    if (Array.isArray(patch.shapes)) {
      const shapes = patch.shapes as AnyShape[];
      dedupeIdentical(shapes);
      collapseGlassStacks(shapes);
      for (const s of shapes) polishShape(s);
    }
  } else if (op === 'update_many') {
    if (Array.isArray(patch.updates)) {
      for (const u of patch.updates as Array<{ id: string; changes?: AnyShape }>) {
        if (u && u.changes) polishShape(u.changes);
      }
    }
  }
  return patch;
}
