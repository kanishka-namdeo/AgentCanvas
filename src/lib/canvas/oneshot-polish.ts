// Deterministic one-shot patch polish.
//
// Applied by the /api/agent route ONLY on empty-canvas (first-creation)
// turns: geometry fixes that cost zero LLM tokens and catch the two most
// common "AI slop" geometry defects before they reach any client:
//   1. GRID SNAP - x/y/width/height rounded to the 4px (half-8pt) grid.
//   2. DUPLICATE DEDUPE - fully-identical sibling nodes (same type, name,
//      text, fill, geometry) collapse to their first occurrence.
// Multi-shot turns are never routed through here (the canvas is non-empty
// at turn start), so follow-up behavior is byte-identical to before.

import type { CanvasPatch } from './types';

const GRID = 4;

const snap = (v: number): number => Math.round(v / GRID) * GRID;
const snapNum = (v: unknown): unknown =>
  typeof v === 'number' && Number.isFinite(v) ? snap(v) : v;

interface AnyShape {
  type?: unknown;
  name?: unknown;
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
  text?: unknown;
  fill?: unknown;
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

function polishShape(s: AnyShape): void {
  s.x = snapNum(s.x);
  s.y = snapNum(s.y);
  s.width = snapNum(s.width);
  s.height = snapNum(s.height);
  if (Array.isArray(s.children)) {
    dedupeIdentical(s.children as AnyShape[]);
    for (const c of s.children as AnyShape[]) polishShape(c);
  }
}

/// Snap create/update patch payloads to the 4px grid and collapse
/// fully-identical duplicate nodes. Mutates and returns the same patch.
export function polishOneShotPatch(patch: CanvasPatch): CanvasPatch {
  const op = patch.op;
  if (op === 'add' || op === 'add_subtree' || op === 'update') {
    if (patch.shape) polishShape(patch.shape as AnyShape);
  } else if (op === 'bulk_add') {
    if (Array.isArray(patch.shapes)) {
      dedupeIdentical(patch.shapes as AnyShape[]);
      for (const s of patch.shapes as AnyShape[]) polishShape(s);
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
