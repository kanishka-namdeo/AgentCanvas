// Tests for the 5 hierarchy gap fixes:
//   Fix 1: layoutPosition:'absolute' support in layoutChildren()
//   Fix 2: Layout constraints enforcement in resolve pass
//   Fix 3: Clip enforcement on frames (surfaced on Shape)
//   Fix 4: Group auto-sizing fallback (0×0 instead of 100×100)
//   Fix 5: Nested fill_container + fit_content sizing cycle

import { describe, it, expect } from 'vitest';
import { resolvePenTree } from '@/lib/pen/resolve';
import type { CanvasDocument } from '@/lib/canvas/types';
import { PEN_FORMAT_VERSION } from '@/lib/pen/types';

// ---- Helpers --------------------------------------------------------------

function makeDoc(children: any[]): CanvasDocument {
  return {
    id: 'doc',
    name: 'test',
    version: PEN_FORMAT_VERSION,
    children,
    viewport: { zoom: 1, panX: 0, panY: 0 },
    background: '#f8fafc',
    shapes: [],
    tokens: { colors: [], textStyles: [] },
  };
}

function makeRect(id: string, x = 0, y = 0, w = 100, h = 100, overrides: any = {}) {
  return { id, type: 'rectangle', x, y, width: w, height: h, fill: '#e2e8f0', ...overrides };
}

function makeFrame(id: string, children: any[], overrides: any = {}) {
  return {
    id,
    type: 'frame',
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    width: overrides.width ?? 400,
    height: overrides.height ?? 300,
    fill: '#ffffff',
    children,
    ...overrides,
  };
}

function makeGroup(id: string, children: any[] = [], overrides: any = {}) {
  return { id, type: 'group', x: 0, y: 0, children, ...overrides };
}

// ========================================================================
// Fix 1: layoutPosition:'absolute' — absolute children opt out of flex
// ========================================================================

describe('Fix 1: layoutPosition absolute', () => {
  it('absolute child keeps its own x/y inside a horizontal layout', () => {
    const doc = makeDoc([
      makeFrame('frame1', [
        makeRect('flow-a', 0, 0, 80, 40),
        makeRect('abs-b', 250, 10, 60, 30, { layoutPosition: 'absolute' }),
        makeRect('flow-c', 0, 0, 80, 40),
      ], { layout: 'horizontal', gap: 10, padding: 0 }),
    ]);

    const shapes = resolvePenTree(doc);
    const flowA = shapes.find((s) => s.id === 'flow-a')!;
    const absB = shapes.find((s) => s.id === 'abs-b')!;
    const flowC = shapes.find((s) => s.id === 'flow-c')!;

    // Flow children should be laid out horizontally (ignoring abs-b).
    // flow-a at x=0, flow-c at x=80+10=90. No gap before abs-b.
    expect(flowA.x).toBe(0);
    expect(flowA.y).toBe(0);
    expect(flowC.x).toBe(90);
    expect(flowC.y).toBe(0);

    // Absolute child should be at its own x/y relative to parent.
    expect(absB.x).toBe(250);
    expect(absB.y).toBe(10);
  });

  it('absolute child in vertical layout is excluded from flow', () => {
    const doc = makeDoc([
      makeFrame('frame1', [
        makeRect('flow-a', 0, 0, 80, 40),
        makeRect('abs-b', 100, 200, 50, 50, { layoutPosition: 'absolute' }),
      ], { layout: 'vertical', gap: 0, padding: 0 }),
    ]);

    const shapes = resolvePenTree(doc);
    const flowA = shapes.find((s) => s.id === 'flow-a')!;
    const absB = shapes.find((s) => s.id === 'abs-b')!;

    expect(flowA.x).toBe(0);
    expect(flowA.y).toBe(0);
    expect(absB.x).toBe(100);
    expect(absB.y).toBe(200);
  });
});

// ========================================================================
// Fix 2: Layout constraints enforcement
// ========================================================================

describe('Fix 2: Layout constraints', () => {
  it('right constraint positions child from parent right edge', () => {
    const doc = makeDoc([
      makeFrame('frame1', [
        makeRect('child1', 20, 10, 60, 40, {
          constraints: { horizontal: 'right', vertical: 'top' },
        }),
      ], { width: 400, height: 300 }),
    ]);

    const shapes = resolvePenTree(doc);
    const child = shapes.find((s) => s.id === 'child1')!;

    // right: x = contentW - childW - storedX = 400 - 60 - 20 = 320
    expect(child.x).toBe(320);
    expect(child.y).toBe(10); // top: y as-is
  });

  it('center constraint centers child in parent', () => {
    const doc = makeDoc([
      makeFrame('frame1', [
        makeRect('child1', 0, 0, 60, 40, {
          constraints: { horizontal: 'center', vertical: 'center' },
        }),
      ], { width: 400, height: 300 }),
    ]);

    const shapes = resolvePenTree(doc);
    const child = shapes.find((s) => s.id === 'child1')!;

    // center: x = (400 - 60) / 2 = 170
    // center: y = (300 - 40) / 2 = 130
    expect(child.x).toBe(170);
    expect(child.y).toBe(130);
  });

  it('bottom constraint positions child from parent bottom', () => {
    const doc = makeDoc([
      makeFrame('frame1', [
        makeRect('child1', 10, 30, 60, 40, {
          constraints: { horizontal: 'left', vertical: 'bottom' },
        }),
      ], { width: 400, height: 300 }),
    ]);

    const shapes = resolvePenTree(doc);
    const child = shapes.find((s) => s.id === 'child1')!;

    // bottom: y = contentH - childH - storedY = 300 - 40 - 30 = 230
    expect(child.x).toBe(10);
    expect(child.y).toBe(230);
  });

  it('scale constraint scales stored position by parent size', () => {
    const doc = makeDoc([
      makeFrame('frame1', [
        makeRect('child1', 0.25, 0.5, 60, 40, {
          constraints: { horizontal: 'scale', vertical: 'scale' },
        }),
      ], { width: 400, height: 300 }),
    ]);

    const shapes = resolvePenTree(doc);
    const child = shapes.find((s) => s.id === 'child1')!;

    // scale: x = 0.25 * 400 = 100
    // scale: y = 0.5 * 300 = 150
    expect(child.x).toBe(100);
    expect(child.y).toBe(150);
  });

  it('no constraint falls back to left/top (default)', () => {
    const doc = makeDoc([
      makeFrame('frame1', [
        makeRect('child1', 50, 75, 60, 40),
      ], { width: 400, height: 300 }),
    ]);

    const shapes = resolvePenTree(doc);
    const child = shapes.find((s) => s.id === 'child1')!;
    expect(child.x).toBe(50);
    expect(child.y).toBe(75);
  });
});

// ========================================================================
// Fix 3: Clip property surfaced from .pen to Shape
// ========================================================================

describe('Fix 3: Clip property', () => {
  it('frame with clip:true surfaces clip=true on resolved shape', () => {
    const doc = makeDoc([
      makeFrame('clip-frame', [
        makeRect('child1', 10, 10, 200, 200),
      ], { clip: true }),
    ]);

    const shapes = resolvePenTree(doc);
    const frame = shapes.find((s) => s.id === 'clip-frame')!;
    const child = shapes.find((s) => s.id === 'child1')!;

    expect(frame.clip).toBe(true);
    expect(child.parentId).toBe('clip-frame');
  });

  it('frame without clip has clip=undefined', () => {
    const doc = makeDoc([
      makeFrame('no-clip-frame', [
        makeRect('child1', 10, 10, 200, 200),
      ]),
    ]);

    const shapes = resolvePenTree(doc);
    const frame = shapes.find((s) => s.id === 'no-clip-frame')!;
    expect(frame.clip).toBeUndefined();
  });

  it('nested clipping: child inside clip frame gets clip=true ancestor', () => {
    const doc = makeDoc([
      makeFrame('outer', [
        makeFrame('clip-frame', [
          makeRect('deep-child', 500, 500, 50, 50),
        ], { clip: true, width: 200, height: 200 }),
      ]),
    ]);

    const shapes = resolvePenTree(doc);
    const clipFrame = shapes.find((s) => s.id === 'clip-frame')!;
    const deepChild = shapes.find((s) => s.id === 'deep-child')!;

    expect(clipFrame.clip).toBe(true);
    expect(deepChild.parentId).toBe('clip-frame');
    // The deep child is at 500,500 which is outside the 200x200 clip frame.
    // The renderer should clip it via SVG clipPath.
    expect(deepChild.x).toBe(500);
  });
});

// ========================================================================
// Fix 4: Group auto-sizing fallback — 0×0 for empty groups
// ========================================================================

describe('Fix 4: Empty group sizing', () => {
  it('empty group resolves to 0x0', () => {
    const doc = makeDoc([
      makeGroup('empty-group'),
    ]);

    const shapes = resolvePenTree(doc);
    const group = shapes.find((s) => s.id === 'empty-group')!;

    expect(group.width).toBe(0);
    expect(group.height).toBe(0);
  });

  it('empty section resolves to 0x0', () => {
    const doc = makeDoc([
      { id: 'empty-section', type: 'section', children: [] },
    ]);

    const shapes = resolvePenTree(doc);
    const section = shapes.find((s) => s.id === 'empty-section')!;

    expect(section.width).toBe(0);
    expect(section.height).toBe(0);
  });

  it('empty frame with explicit size keeps its size', () => {
    const doc = makeDoc([
      makeFrame('empty-frame', []),
    ]);

    const shapes = resolvePenTree(doc);
    const frame = shapes.find((s) => s.id === 'empty-frame')!;

    // makeFrame sets width:400, height:300 explicitly.
    expect(frame.width).toBe(400);
    expect(frame.height).toBe(300);
  });

  it('group with children sizes to fit children', () => {
    const doc = makeDoc([
      makeGroup('grp', [
        makeRect('a', 0, 0, 50, 30),
        makeRect('b', 60, 0, 40, 20),
      ]),
    ]);

    const shapes = resolvePenTree(doc);
    const group = shapes.find((s) => s.id === 'grp')!;

    // Group with no explicit size + no layout: fit to bounding box of children.
    // The resolve engine fits to children's absolute positions.
    // Children are positioned at their own x/y (no layout = absolute).
    // The bounding box of (0,0,50,30) and (60,0,40,20) is x=0..100, y=0..30.
    // With pad=0: width=100, height=30.
    expect(group.width).toBe(100);
    expect(group.height).toBe(30);
  });
});

// ========================================================================
// Fix 5: Nested fill_container + fit_content sizing cycle
// ========================================================================

describe('Fix 5: fill_container inside fit_content parent', () => {
  it('fill_container child gets parent computed size, not 0', () => {
    const doc = makeDoc([
      makeFrame('parent', [
        makeRect('fill-child', 0, 0, 0, 0, { width: 'fill_container', height: 'fill_container' }),
      ], {
        // Parent is fit_content — its size derives from children.
        width: 'fit_content',
        height: 'fit_content',
        padding: 10,
      }),
    ]);

    const shapes = resolvePenTree(doc);
    const fillChild = shapes.find((s) => s.id === 'fill-child')!;

    // All children are fill_container, so Phase A finds no non-fill kids.
    // Parent falls back to 100×100 (frame default). Phase B runs:
    // contentW = 100 - 10 - 10 = 80.
    expect(fillChild.width).toBe(80);
    expect(fillChild.height).toBe(80);
  });

  it('fill_container child coexists with fixed-size siblings', () => {
    const doc = makeDoc([
      makeFrame('parent', [
        makeRect('fixed-a', 0, 0, 100, 50),
        makeRect('fill-child', 0, 0, 0, 0, { width: 'fill_container', height: 50 }),
      ], {
        width: 'fit_content',
        height: 'fit_content',
        layout: 'vertical',
        gap: 10,
        padding: 0,
      }),
    ]);

    const shapes = resolvePenTree(doc);
    const parent = shapes.find((s) => s.id === 'parent')!;
    const fixedA = shapes.find((s) => s.id === 'fixed-a')!;
    const fillChild = shapes.find((s) => s.id === 'fill-child')!;

    // Phase A: parent width = max(100, fill_width_ignored) = 100
    //           parent height = 50 + 10 + fill_height_ignored → fill ignored → fallback 100
    // Actually, fill_container child is excluded from Phase A for the axis it fills.
    // So vertical main axis: only fixed-a contributes 50. fill_child contributes 0.
    // parent height = 50 + 0(gap, only 1 non-fill kid) = 50 → but fit_content h was 0 for non-fill, so fallback to 100.
    // Wait, let me reconsider: there IS a non-fill child (fixed-a, height=50).
    // Phase A: parent height = 50 (only non-fill kids). Not 0, so no fallback.
    // Phase B: fill_child height = 50 (fixed value, not fill_container on h axis).
    // fill_child width = parent.width - pad = 100 - 0 = 100.
    expect(parent.width).toBe(100);
    expect(fillChild.width).toBe(100);
  });

  it('deeply nested fill_container resolves correctly', () => {
    const doc = makeDoc([
      makeFrame('outer', [
        makeFrame('inner', [
          makeRect('deep-fill', 0, 0, 0, 0, {
            width: 'fill_container',
            height: 'fill_container',
          }),
        ], {
          width: 200,
          height: 150,
          padding: 10,
        }),
      ]),
    ]);

    const shapes = resolvePenTree(doc);
    const deepFill = shapes.find((s) => s.id === 'deep-fill')!;

    // Inner is 200×150 with padding 10. Content area = 180×130.
    expect(deepFill.width).toBe(180);
    expect(deepFill.height).toBe(130);
  });
});
