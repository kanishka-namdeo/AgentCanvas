// Bug-hunt probes for canvas patch edge cases. Each describe block targets a
// suspected defect found by code review; they are written to FAIL against the
// buggy behavior and PASS once fixed.

import { describe, it, expect } from 'vitest';
import { applyPatchToCanvas } from '../../src/lib/canvas/patch';
import { createEmptyCanvasDocument } from '../../src/lib/canvas/types';
import type { CanvasDocument, CanvasPatch, Shape } from '../../src/lib/canvas/types';
import { resolvePenTree } from '../../src/lib/pen/resolve';
import type { PenChild } from '../../src/lib/pen/types';

// ---- fixtures ----------------------------------------------------------------

function seedDoc(): CanvasDocument {
  let doc = createEmptyCanvasDocument('probe', 'Probe');
  const add = (patch: CanvasPatch) => { doc = applyPatchToCanvas(doc, patch); };
  // Frame at (100, 100) 400x300 — a container with non-zero origin.
  add({ op: 'add', shapeId: 'frame1', shape: { type: 'frame', name: 'Frame', x: 100, y: 100, width: 400, height: 300 }, summary: '' });
  // Two children INSIDE the frame, stored relative: (20,40) and (220,40).
  add({ op: 'add', shapeId: 'child-a', shape: { type: 'rectangle', name: 'A', x: 20, y: 40, width: 100, height: 60, parentId: 'frame1' }, summary: '' });
  add({ op: 'add', shapeId: 'child-b', shape: { type: 'rectangle', name: 'B', x: 220, y: 40, width: 100, height: 60, parentId: 'frame1' }, summary: '' });
  return doc;
}

const byId = (doc: CanvasDocument, id: string): Shape | undefined =>
  (doc.shapes ?? []).find((s) => s.id === id);

// ---- probes ------------------------------------------------------------------

describe('BUG 1: update op must descend into ALL container types', () => {
  it('updates a node inside a section', () => {
    let doc = createEmptyCanvasDocument('probe', 'Probe');
    doc = applyPatchToCanvas(doc, { op: 'add', shapeId: 'sec1', shape: { type: 'section', name: 'Sec', x: 0, y: 0, width: 500, height: 400 }, summary: '' });
    doc = applyPatchToCanvas(doc, { op: 'add', shapeId: 'inner', shape: { type: 'rectangle', name: 'Inner', x: 10, y: 10, width: 50, height: 50, parentId: 'sec1' }, summary: '' });
    doc = applyPatchToCanvas(doc, { op: 'update', shapeId: 'inner', shape: { fill: '#ff0000' }, summary: '' });
    expect(byId(doc, 'inner')?.fill).toBe('#ff0000');
  });

  it('updates a node inside a component', () => {
    let doc = createEmptyCanvasDocument('probe', 'Probe');
    doc = applyPatchToCanvas(doc, { op: 'add', shapeId: 'cmp1', shape: { type: 'component', name: 'Cmp', x: 0, y: 0, width: 500, height: 400 }, summary: '' });
    doc = applyPatchToCanvas(doc, { op: 'add', shapeId: 'inner2', shape: { type: 'rectangle', name: 'Inner', x: 10, y: 10, width: 50, height: 50, parentId: 'cmp1' }, summary: '' });
    doc = applyPatchToCanvas(doc, { op: 'update', shapeId: 'inner2', shape: { fill: '#00ff00' }, summary: '' });
    expect(byId(doc, 'inner2')?.fill).toBe('#00ff00');
  });
});

describe('BUG 2: align must write RELATIVE coords for nested targets', () => {
  it('align-left keeps nested children inside their frame (no jump)', () => {
    const doc = seedDoc();
    const out = applyPatchToCanvas(doc, {
      op: 'align', shapeIds: ['child-a', 'child-b'], alignKind: 'left', summary: '',
    });
    // doc.shapes carries RESOLVED ABSOLUTE coords. Both children must share
    // the same ABSOLUTE left edge (120 = frame 100 + stored 20) after align.
    // Pre-fix: stored x was overwritten with the absolute value, so child-b
    // (abs 320) stayed put while child-a jumped — and nested targets shifted
    // by their parent's offset.
    const a = byId(out, 'child-a');
    const b = byId(out, 'child-b');
    expect(Math.round(a?.x ?? -1)).toBe(120);
    expect(Math.round(b?.x ?? -1)).toBe(120);
    expect(a?.parentId).toBe('frame1');
    expect(b?.parentId).toBe('frame1');
  });
});

describe('BUG 3: group must remap children coords into group space', () => {
  it('grouping nested children keeps their absolute positions', () => {
    const doc = seedDoc();
    const out = applyPatchToCanvas(doc, {
      op: 'group', shapeIds: ['child-a', 'child-b'], groupId: 'grp1', summary: '',
    });
    // child-a absolute was (120, 140); child-b absolute was (320, 140).
    const a = byId(out, 'child-a');
    const b = byId(out, 'child-b');
    expect(a ? Math.round(a.x) : -1).toBe(120);
    expect(a ? Math.round(a.y) : -1).toBe(140);
    expect(b ? Math.round(b.x) : -1).toBe(320);
    expect(b ? Math.round(b.y) : -1).toBe(140);
  });

  it('grouping top-level children keeps their absolute positions', () => {
    let doc = createEmptyCanvasDocument('probe', 'Probe');
    doc = applyPatchToCanvas(doc, { op: 'add', shapeId: 't1', shape: { type: 'rectangle', name: 'T1', x: 300, y: 200, width: 100, height: 80 }, summary: '' });
    doc = applyPatchToCanvas(doc, { op: 'add', shapeId: 't2', shape: { type: 'rectangle', name: 'T2', x: 500, y: 260, width: 120, height: 90 }, summary: '' });
    const out = applyPatchToCanvas(doc, { op: 'group', shapeIds: ['t1', 't2'], groupId: 'g2', summary: '' });
    expect(Math.round(byId(out, 't1')?.x ?? -1)).toBe(300);
    expect(Math.round(byId(out, 't1')?.y ?? -1)).toBe(200);
    expect(Math.round(byId(out, 't2')?.x ?? -1)).toBe(500);
    expect(Math.round(byId(out, 't2')?.y ?? -1)).toBe(260);
  });
});

describe('BUG 4: duplicate of a NESTED node must stay in its parent (or remap)', () => {
  it('duplicating a nested child keeps it inside the same frame, offset by 24', () => {
    const doc = seedDoc();
    const out = applyPatchToCanvas(doc, {
      op: 'duplicate', shapeIds: ['child-a'], summary: '',
    });
    const clone = (out.shapes ?? []).find((s) => s.id !== 'child-a' && s.name === 'A copy');
    expect(clone).toBeDefined();
    // Must remain INSIDE frame1 (not teleported to root).
    expect(clone?.parentId).toBe('frame1');
    // ABSOLUTE position = original absolute (120,140) + 24.
    expect(clone && Math.round(clone.x)).toBe(144);
    expect(clone && Math.round(clone.y)).toBe(164);
  });
});

describe('BUG 5: ungroup is the inverse of group (roundtrip stability)', () => {
  it('group then ungroup restores original absolute positions', () => {
    const doc = seedDoc();
    const grouped = applyPatchToCanvas(doc, { op: 'group', shapeIds: ['child-a', 'child-b'], groupId: 'grp1', summary: '' });
    // Group lives INSIDE frame1 (common parent) — Figma semantics.
    const g = byId(grouped, 'grp1');
    expect(g?.parentId).toBe('frame1');
    const ungrouped = applyPatchToCanvas(grouped, { op: 'ungroup', shapeIds: ['grp1'], summary: '' });
    const a = byId(ungrouped, 'child-a');
    const b = byId(ungrouped, 'child-b');
    // Children return to frame1 at their ORIGINAL absolute positions.
    expect(a?.parentId).toBe('frame1');
    expect(Math.round(a?.x ?? -1)).toBe(120);
    expect(Math.round(a?.y ?? -1)).toBe(140);
    expect(b?.parentId).toBe('frame1');
    expect(Math.round(b?.x ?? -1)).toBe(320);
  });
});
