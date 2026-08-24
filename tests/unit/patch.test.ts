// Tests for the patch layer — the pure heart of canvas mutation.
//
// We focus on the new ops added in Phase 1+2+5:
//   - zorder (front / back / forward / backward)
//   - reorder (move to specific zIndex)
//   - undo / redo (no-ops at the patch layer; intercepted by the store)
//   - normalizeShape handling of new Shape fields:
//     points, closed, src, radii, gradient, shadow, blur, maskId
//
// All other ops (add / update / remove / bulk_add / etc.) were already
// in production; we cover them lightly for regression purposes.

import { describe, it, expect } from 'vitest';
import { applyPatchToCanvas } from '@/lib/canvas/patch';
import type { CanvasDocument, CanvasPatch, Shape } from '@/lib/canvas/types'
import type { PenChild } from '@/lib/pen/types';

// ---- Fixtures ----------------------------------------------------------------

function makeShape(overrides: Partial<Shape> = {}): Shape {
  return {
    id: overrides.id ?? 's1',
    type: overrides.type ?? 'rectangle',
    name: overrides.name ?? 'Shape',
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    width: overrides.width ?? 100,
    height: overrides.height ?? 100,
    rotation: overrides.rotation ?? 0,
    opacity: overrides.opacity ?? 1,
    fill: overrides.fill ?? '#e2e8f0',
    stroke: overrides.stroke ?? '#0f172a',
    strokeWidth: overrides.strokeWidth ?? 0,
    radius: overrides.radius ?? 0,
    fontSize: overrides.fontSize ?? 16,
    textColor: overrides.textColor ?? '#0f172a',
    parentId: overrides.parentId ?? null,
    zIndex: overrides.zIndex ?? 0,
    locked: overrides.locked ?? false,
    visible: overrides.visible ?? true,
    autoLayout: overrides.autoLayout ?? null,
    tokenBinding: overrides.tokenBinding ?? null,
    componentId: overrides.componentId ?? null,
    points: overrides.points ?? null,
    closed: overrides.closed ?? false,
    src: overrides.src ?? null,
    radii: overrides.radii ?? null,
    gradient: overrides.gradient ?? null,
    shadow: overrides.shadow ?? null,
    blur: overrides.blur ?? 0,
    maskId: overrides.maskId ?? null,
    constraints: overrides.constraints ?? null,
  };
}

function makeDoc(shapes: Shape[] = []): CanvasDocument {
  return {
    id: 'doc-1',
    name: 'Test doc',
    background: '#ffffff',
    version: '2.17',
    children: shapes as unknown as PenChild[],
    viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes,
    tokens: { colors: [], textStyles: [] },
  };
}

/**
 * Build a doc with a proper NESTED .pen tree from a flat shape list (using
 * each shape's `parentId` to assemble the tree). The flat `makeDoc` helper
 * above leaves everything at the top level — that's fine for tests that don't
 * care about nesting, but tests that exercise the patch applier's tree-aware
 * ops (reparent cycle detection, ungroup with nested groups) need a real tree.
 *
 * Containers (frame / group) get their `children` array populated from the
 * shapes whose `parentId` points at them. Leaves are inserted as-is.
 */
function makeNestedDoc(shapes: Shape[]): CanvasDocument {
  const childrenOf = (parentId: string | null) =>
    shapes.filter((s) => (s.parentId ?? null) === parentId);

  const buildNode = (s: Shape): PenChild => {
    const base: any = { ...s };
    if (s.type === 'frame' || s.type === 'group') {
      const kids = childrenOf(s.id);
      base.children = kids.map(buildNode);
    }
    return base as PenChild;
  };

  const topLevel = childrenOf(null).map(buildNode);
  return {
    id: 'doc-1',
    name: 'Test doc (nested)',
    background: '#ffffff',
    version: '2.17',
    children: topLevel,
    viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes,
    tokens: { colors: [], textStyles: [] },
  };
}

function patch(op: Partial<CanvasPatch> & { op: CanvasPatch['op'] }): CanvasPatch {
  return { summary: 'test', ...op };
}

// ---- zorder ------------------------------------------------------------------

describe('patch: zorder', () => {
  it('brings a shape to the front', () => {
    const a = makeShape({ id: 'a', zIndex: 0 });
    const b = makeShape({ id: 'b', zIndex: 1 });
    const c = makeShape({ id: 'c', zIndex: 2 });
    const doc = makeDoc([a, b, c]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'zorder',
      shapeIds: ['a'],
      zorderKind: 'front',
    }));
    // After: b, c, a (a is at top).
    expect(out.shapes.map((s) => s.id)).toEqual(['b', 'c', 'a']);
    expect(out.shapes.map((s) => s.zIndex)).toEqual([0, 1, 2]);
  });

  it('sends a shape to the back', () => {
    const a = makeShape({ id: 'a', zIndex: 0 });
    const b = makeShape({ id: 'b', zIndex: 1 });
    const c = makeShape({ id: 'c', zIndex: 2 });
    const doc = makeDoc([a, b, c]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'zorder',
      shapeIds: ['c'],
      zorderKind: 'back',
    }));
    expect(out.shapes.map((s) => s.id)).toEqual(['c', 'a', 'b']);
    expect(out.shapes.map((s) => s.zIndex)).toEqual([0, 1, 2]);
  });

  it('moves a shape forward by one level', () => {
    const a = makeShape({ id: 'a', zIndex: 0 });
    const b = makeShape({ id: 'b', zIndex: 1 });
    const c = makeShape({ id: 'c', zIndex: 2 });
    const doc = makeDoc([a, b, c]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'zorder',
      shapeIds: ['b'],
      zorderKind: 'forward',
    }));
    // b was at z=1, swap with c at z=2 → a, c, b.
    expect(out.shapes.map((s) => s.id)).toEqual(['a', 'c', 'b']);
    expect(out.shapes.map((s) => s.zIndex)).toEqual([0, 1, 2]);
  });

  it('moves a shape backward by one level', () => {
    const a = makeShape({ id: 'a', zIndex: 0 });
    const b = makeShape({ id: 'b', zIndex: 1 });
    const c = makeShape({ id: 'c', zIndex: 2 });
    const doc = makeDoc([a, b, c]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'zorder',
      shapeIds: ['b'],
      zorderKind: 'backward',
    }));
    // b was at z=1, swap with a at z=0 → b, a, c.
    expect(out.shapes.map((s) => s.id)).toEqual(['b', 'a', 'c']);
  });

  it('does nothing when the shape is already at the front (forward)', () => {
    const a = makeShape({ id: 'a', zIndex: 0 });
    const b = makeShape({ id: 'b', zIndex: 1 });
    const c = makeShape({ id: 'c', zIndex: 2 });
    const doc = makeDoc([a, b, c]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'zorder',
      shapeIds: ['c'],
      zorderKind: 'forward',
    }));
    expect(out.shapes.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('does nothing when the shape is already at the back (backward)', () => {
    const a = makeShape({ id: 'a', zIndex: 0 });
    const b = makeShape({ id: 'b', zIndex: 1 });
    const c = makeShape({ id: 'c', zIndex: 2 });
    const doc = makeDoc([a, b, c]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'zorder',
      shapeIds: ['a'],
      zorderKind: 'backward',
    }));
    expect(out.shapes.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('moves multiple shapes to front together', () => {
    const a = makeShape({ id: 'a', zIndex: 0 });
    const b = makeShape({ id: 'b', zIndex: 1 });
    const c = makeShape({ id: 'c', zIndex: 2 });
    const d = makeShape({ id: 'd', zIndex: 3 });
    const doc = makeDoc([a, b, c, d]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'zorder',
      shapeIds: ['a', 'c'],
      zorderKind: 'front',
    }));
    // rest: b, d; movers: a, c → b, d, a, c.
    expect(out.shapes.map((s) => s.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('defaults to "front" when zorderKind is missing', () => {
    const a = makeShape({ id: 'a', zIndex: 0 });
    const b = makeShape({ id: 'b', zIndex: 1 });
    const doc = makeDoc([a, b]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'zorder',
      shapeIds: ['a'],
      // no zorderKind — should default to 'front'
    }));
    expect(out.shapes.map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('no-ops when shapeIds is empty', () => {
    const a = makeShape({ id: 'a', zIndex: 0 });
    const doc = makeDoc([a]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'zorder',
      shapeIds: [],
      zorderKind: 'front',
    }));
    // No-op: the resolved shape is still present (re-resolved, so a new object,
    // but with the same id/type/position).
    expect(out.shapes).toHaveLength(1);
    expect(out.shapes[0].id).toBe('a');
    expect(out.shapes[0].type).toBe(a.type);
  });

  it('produces new shape objects (purity)', () => {
    const a = makeShape({ id: 'a', zIndex: 0 });
    const b = makeShape({ id: 'b', zIndex: 1 });
    const doc = makeDoc([a, b]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'zorder',
      shapeIds: ['a'],
      zorderKind: 'front',
    }));
    // The original `a` reference must not be mutated.
    expect(a.zIndex).toBe(0);
    // The output shapes must be new objects (spread).
    expect(out.shapes[0]).not.toBe(b);
    expect(out.shapes[1]).not.toBe(a);
  });
});

// ---- reorder -----------------------------------------------------------------

describe('patch: reorder', () => {
  it('moves a shape to a specific zIndex', () => {
    const a = makeShape({ id: 'a', zIndex: 0 });
    const b = makeShape({ id: 'b', zIndex: 1 });
    const c = makeShape({ id: 'c', zIndex: 2 });
    const d = makeShape({ id: 'd', zIndex: 3 });
    const doc = makeDoc([a, b, c, d]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'reorder',
      shapeId: 'd',
      zIndex: 1,
    }));
    // Move d to position 1: a, d, b, c.
    expect(out.shapes.map((s) => s.id)).toEqual(['a', 'd', 'b', 'c']);
    expect(out.shapes.map((s) => s.zIndex)).toEqual([0, 1, 2, 3]);
  });

  it('clamps zIndex to the document size', () => {
    const a = makeShape({ id: 'a', zIndex: 0 });
    const b = makeShape({ id: 'b', zIndex: 1 });
    const doc = makeDoc([a, b]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'reorder',
      shapeId: 'a',
      zIndex: 99,
    }));
    // a stays at end: b, a.
    expect(out.shapes.map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('clamps negative zIndex to 0', () => {
    const a = makeShape({ id: 'a', zIndex: 0 });
    const b = makeShape({ id: 'b', zIndex: 1 });
    const doc = makeDoc([a, b]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'reorder',
      shapeId: 'b',
      zIndex: -5,
    }));
    expect(out.shapes.map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('no-ops when shapeId is missing', () => {
    const a = makeShape({ id: 'a', zIndex: 0 });
    const doc = makeDoc([a]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'reorder',
      zIndex: 0,
    }));
    expect(out.shapes).toHaveLength(1);
    expect(out.shapes[0].id).toBe('a');
  });

  it('no-ops when the shape is not found', () => {
    const a = makeShape({ id: 'a', zIndex: 0 });
    const doc = makeDoc([a]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'reorder',
      shapeId: 'does-not-exist',
      zIndex: 0,
    }));
    expect(out.shapes).toHaveLength(1);
    expect(out.shapes[0].id).toBe('a');
  });
});

// ---- undo / redo (patch layer is a no-op) ------------------------------------

describe('patch: undo / redo (no-op at patch layer)', () => {
  it('undo returns the document unchanged', () => {
    const a = makeShape({ id: 'a', zIndex: 0 });
    const doc = makeDoc([a]);
    const out = applyPatchToCanvas(doc, patch({ op: 'undo' }));
    // undo/redo are no-ops at the patch layer (the store intercepts them).
    // The resolver re-derives shapes, so assert on content not identity.
    expect(out.shapes).toHaveLength(1);
    expect(out.shapes[0].id).toBe('a');
  });

  it('redo returns the document unchanged', () => {
    const a = makeShape({ id: 'a', zIndex: 0 });
    const doc = makeDoc([a]);
    const out = applyPatchToCanvas(doc, patch({ op: 'redo' }));
    expect(out.shapes).toHaveLength(1);
    expect(out.shapes[0].id).toBe('a');
  });
});

// ---- viewport ----------------------------------------------------------------

describe('patch: viewport', () => {
  it('updates the document viewport', () => {
    const doc = makeDoc([]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'viewport',
      viewport: { zoom: 2, panX: 100, panY: 50 },
    }));
    expect(out.viewport).toEqual({ zoom: 2, panX: 100, panY: 50 });
  });

  it('no-ops when viewport is missing', () => {
    const doc = makeDoc([]);
    const out = applyPatchToCanvas(doc, patch({ op: 'viewport' }));
    expect(out.viewport).toEqual(doc.viewport);
  });
});

// ---- normalizeShape new fields (exercised through 'add') ---------------------

describe('patch: normalizeShape (new Phase 5 fields)', () => {
  it('normalizes a path shape with points and closed=true', () => {
    const doc = makeDoc([]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'add',
      shape: {
        id: 'p1',
        type: 'path',
        points: [{ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 20, y: 0 }],
        closed: true,
      },
    }));
    expect(out.shapes).toHaveLength(1);
    const s = out.shapes[0];
    expect(s.type).toBe('path');
    expect(s.points).toEqual([{ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 20, y: 0 }]);
    expect(s.closed).toBe(true);
  });

  it('normalizes an image shape with src', () => {
    const doc = makeDoc([]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'add',
      shape: {
        id: 'img1',
        type: 'image',
        src: 'https://example.com/image.png',
        width: 200,
        height: 100,
      },
    }));
    const s = out.shapes[0];
    expect(s.type).toBe('image');
    expect(s.src).toBe('https://example.com/image.png');
    expect(s.width).toBe(200);
    expect(s.height).toBe(100);
  });

  it('normalizes per-corner radii', () => {
    const doc = makeDoc([]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'add',
      shape: {
        id: 'r1',
        type: 'rectangle',
        radii: { topLeft: 4, topRight: 8, bottomRight: 12, bottomLeft: 16 },
      },
    }));
    expect(out.shapes[0].radii).toEqual({
      topLeft: 4, topRight: 8, bottomRight: 12, bottomLeft: 16,
    });
  });

  it('normalizes a gradient fill', () => {
    const doc = makeDoc([]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'add',
      shape: {
        id: 'g1',
        type: 'rectangle',
        gradient: {
          type: 'linear',
          angle: 90,
          stops: [
            { offset: 0, color: '#ff0000' },
            { offset: 1, color: '#0000ff' },
          ],
        },
      },
    }));
    expect(out.shapes[0].gradient).toEqual({
      type: 'linear',
      angle: 90,
      stops: [
        { offset: 0, color: '#ff0000' },
        { offset: 1, color: '#0000ff' },
      ],
    });
  });

  it('normalizes a shadow effect', () => {
    const doc = makeDoc([]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'add',
      shape: {
        id: 's1',
        type: 'rectangle',
        shadow: { x: 2, y: 4, blur: 8, color: '#00000033' },
      },
    }));
    // The resolver surfaces the shadow with default spread (0) and inset (false).
    expect(out.shapes[0].shadow).toMatchObject({
      x: 2, y: 4, blur: 8, color: '#00000033',
    });
  });

  it('normalizes blur to a non-negative number', () => {
    const doc = makeDoc([]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'add',
      shape: { id: 'b1', type: 'rectangle', blur: 5 },
    }));
    expect(out.shapes[0].blur).toBe(5);
  });

  it('defaults blur to 0 when missing', () => {
    const doc = makeDoc([]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'add',
      shape: { id: 'b2', type: 'rectangle' },
    }));
    expect(out.shapes[0].blur).toBe(0);
  });

  it('normalizes maskId', () => {
    const doc = makeDoc([]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'add',
      shape: { id: 'm1', type: 'rectangle', maskId: 'mask-shape-id' },
    }));
    expect(out.shapes[0].maskId).toBe('mask-shape-id');
  });

  it('coerces numeric strings to numbers (LLM safety)', () => {
    const doc = makeDoc([]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'add',
      shape: {
        id: 'co1',
        type: 'rectangle',
        x: '100' as any,
        y: '200' as any,
        width: '300' as any,
        height: '400' as any,
        opacity: '0.5' as any,
        blur: '3' as any,
      },
    }));
    const s = out.shapes[0];
    expect(s.x).toBe(100);
    expect(s.y).toBe(200);
    expect(s.width).toBe(300);
    expect(s.height).toBe(400);
    expect(s.opacity).toBe(0.5);
    expect(s.blur).toBe(3);
  });

  it('clamps opacity to [0, 1]', () => {
    const doc = makeDoc([]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'add',
      shape: { id: 'op1', type: 'rectangle', opacity: 1.5 as any },
    }));
    expect(out.shapes[0].opacity).toBe(1);
    const out2 = applyPatchToCanvas(doc, patch({
      op: 'add',
      shape: { id: 'op2', type: 'rectangle', opacity: -0.5 as any },
    }));
    expect(out2.shapes[0].opacity).toBe(0);
  });

  it('preserves points with numeric coercion', () => {
    const doc = makeDoc([]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'add',
      shape: {
        id: 'p2',
        type: 'path',
        points: [
          { x: '10' as any, y: '20' as any },
          { x: 30, y: 40 },
        ] as any,
      },
    }));
    expect(out.shapes[0].points).toEqual([
      { x: 10, y: 20 },
      { x: 30, y: 40 },
    ]);
  });

  it('normalizes per-corner radii with numeric coercion', () => {
    const doc = makeDoc([]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'add',
      shape: {
        id: 'r2',
        type: 'rectangle',
        radii: {
          topLeft: '4' as any,
          topRight: '8' as any,
          bottomRight: 12,
          bottomLeft: 16,
        } as any,
      },
    }));
    expect(out.shapes[0].radii).toEqual({
      topLeft: 4, topRight: 8, bottomRight: 12, bottomLeft: 16,
    });
  });
});

// ---- Regression: tokens patch re-applies bindings ----------------------------

describe('patch: tokens re-applies bindings (regression)', () => {
  it('updates fill on shapes bound to a changed color token', () => {
    const bound = makeShape({
      id: 'b1',
      tokenBinding: { fillToken: 'bg.primary' },
      fill: '#ff0000',
    });
    const doc = makeDoc([bound]);
    doc.tokens.colors = [{ name: 'Primary', key: 'bg.primary', value: '#ff0000' }];
    const out = applyPatchToCanvas(doc, patch({
      op: 'tokens',
      tokens: {
        colors: [{ name: 'Primary', key: 'bg.primary', value: '#00ff00' }],
      },
    }));
    expect(out.shapes[0].fill).toBe('#00ff00');
  });

  it('updates stroke and textColor from their respective tokens', () => {
    const bound = makeShape({
      id: 'b2',
      tokenBinding: { strokeToken: 'border.default', textToken: 'text.heading' },
      stroke: '#aaa',
      textColor: '#bbb',
    });
    const doc = makeDoc([bound]);
    doc.tokens.colors = [
      { name: 'Border', key: 'border.default', value: '#aaa' },
      { name: 'Heading', key: 'text.heading', value: '#bbb' },
    ];
    const out = applyPatchToCanvas(doc, patch({
      op: 'tokens',
      tokens: {
        colors: [
          { name: 'Border', key: 'border.default', value: '#111111' },
          { name: 'Heading', key: 'text.heading', value: '#222222' },
        ],
      },
    }));
    expect(out.shapes[0].stroke).toBe('#111111');
    expect(out.shapes[0].textColor).toBe('#222222');
  });

  // ---- Task 7-e Fix 1 regression tests ---------------------------------------
  //   patch.ts::toPenNodePartial previously had a bug where setting both
  //   `fill` and `textColor` in the same update patch silently dropped the
  //   textColor (because of an `if (out.fill === undefined)` guard). This
  //   made all text shapes render with textColor='transparent' (invisible)
  //   when pen_apply_palette ran (it sets both fill and textColor for text
  //   shapes). The fix: for TEXT shapes, textColor takes precedence over
  //   fill; for non-text shapes, the old behavior is preserved.

  it('Task 7-e Fix 1: text shape textColor takes precedence over fill when both are set in the same update patch', () => {
    // Simulate what pen_apply_palette does for a text shape: passes
    // { type: 'text', textColor: <darkest palette color> } in the changes.
    const textShape = makeShape({ id: 't1', type: 'text', text: 'Revenue', fill: 'transparent', textColor: '#0f172a' });
    const doc = makeDoc([textShape]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'update_many',
      updates: [{ id: 't1', changes: { type: 'text', textColor: '#0ea5e9' } }],
    }));
    // textColor should have been applied to the .pen node's fill (which is
    // what the SVG renderer reads for text). The previous bug would have
    // left fill='transparent' (invisible text).
    expect(out.shapes[0].fill).toBe('#0ea5e9');
    expect(out.shapes[0].textColor).toBe('#0ea5e9');
  });

  it('Task 7-e Fix 1: non-text shape keeps fill when both fill and textColor are set (legacy behavior preserved)', () => {
    // For non-text shapes, fill takes precedence; textColor only applies
    // if fill is undefined. This preserves the existing behavior for
    // rectangles, ellipses, etc. that don't have a textColor concept.
    const rect = makeShape({ id: 'r1', type: 'rectangle', fill: '#ff0000' });
    const doc = makeDoc([rect]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'update',
      shapeId: 'r1',
      shape: { fill: '#00ff00', textColor: '#0000ff' },
    }));
    // Fill from the patch wins; textColor is ignored (rectangles don't
    // have a textColor concept).
    expect(out.shapes[0].fill).toBe('#00ff00');
  });
});

// ---- reparent (Figma hierarchy) ----------------------------------------------

describe('patch: reparent', () => {
  it('moves a top-level shape into a frame and preserves absolute position by default', () => {
    // Frame at (200, 100). Shape at (300, 150) at root. Reparent shape into
    // the frame. The shape's absolute position should be PRESERVED at (300, 150).
    // (Stored relative x/y becomes (100, 50); the resolved flat list shows (300, 150).)
    const frame = makeShape({ id: 'frame', type: 'frame', x: 200, y: 100, width: 400, height: 300 });
    const rect = makeShape({ id: 'rect', x: 300, y: 150, width: 50, height: 50 });
    const doc = makeNestedDoc([frame, rect]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'reparent',
      shapeId: 'rect',
      newParentId: 'frame',
    }));
    const updatedRect = out.shapes.find((s) => s.id === 'rect');
    expect(updatedRect?.parentId).toBe('frame');
    // Absolute position (in the resolved flat list) is preserved.
    expect(updatedRect?.x).toBe(300);
    expect(updatedRect?.y).toBe(150);
  });

  it('moves a nested shape to root and preserves absolute position', () => {
    // Frame at (200, 100). Child rect inside frame with relative (10, 20)
    // => absolute (210, 120). Reparent to root. Absolute position (210, 120)
    // should be preserved.
    const frame = makeShape({ id: 'frame', type: 'frame', x: 200, y: 100, width: 400, height: 300 });
    const rect = makeShape({ id: 'rect', x: 10, y: 20, width: 50, height: 50, parentId: 'frame' });
    const doc = makeNestedDoc([frame, rect]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'reparent',
      shapeId: 'rect',
      newParentId: null,
    }));
    const updatedRect = out.shapes.find((s) => s.id === 'rect');
    expect(updatedRect?.parentId).toBeNull();
    // Absolute (210, 120) is preserved — now also the stored root x/y.
    expect(updatedRect?.x).toBe(210);
    expect(updatedRect?.y).toBe(120);
  });

  it('rejects moving a node into itself (would create a cycle)', () => {
    const frame = makeShape({ id: 'frame', type: 'frame', x: 0, y: 0, width: 100, height: 100 });
    const doc = makeNestedDoc([frame]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'reparent',
      shapeId: 'frame',
      newParentId: 'frame',
    }));
    // Frame should remain at root.
    const updatedFrame = out.shapes.find((s) => s.id === 'frame');
    expect(updatedFrame?.parentId).toBeNull();
  });

  it('rejects moving a node into one of its own descendants', () => {
    // Outer frame contains Inner frame. Reparenting Outer INTO Inner should
    // be rejected (would create a cycle: Outer > Inner > Outer > ...).
    const outer = makeShape({ id: 'outer', type: 'frame', x: 0, y: 0, width: 200, height: 200 });
    const inner = makeShape({ id: 'inner', type: 'frame', x: 10, y: 10, width: 50, height: 50, parentId: 'outer' });
    const doc = makeNestedDoc([outer, inner]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'reparent',
      shapeId: 'outer',
      newParentId: 'inner',
    }));
    // Outer should remain at root (not moved into Inner).
    const updatedOuter = out.shapes.find((s) => s.id === 'outer');
    expect(updatedOuter?.parentId).toBeNull();
  });

  it('does NOT remap x/y when keepAbsolutePosition=false', () => {
    // Frame at (200, 100). Shape at (300, 150) at root. Reparent with
    // keepAbsolutePosition=false. Stored x/y stays (300, 150) — which is now
    // RELATIVE to the frame, so the new absolute becomes (500, 250).
    const frame = makeShape({ id: 'frame', type: 'frame', x: 200, y: 100, width: 400, height: 300 });
    const rect = makeShape({ id: 'rect', x: 300, y: 150, width: 50, height: 50 });
    const doc = makeNestedDoc([frame, rect]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'reparent',
      shapeId: 'rect',
      newParentId: 'frame',
      keepAbsolutePosition: false,
    }));
    const updatedRect = out.shapes.find((s) => s.id === 'rect');
    expect(updatedRect?.parentId).toBe('frame');
    // Resolved absolute is now 200 + 300 = 500, 100 + 150 = 250 (NOT preserved).
    expect(updatedRect?.x).toBe(500);
    expect(updatedRect?.y).toBe(250);
  });

  it('no-ops when the shapeId is missing', () => {
    const doc = makeNestedDoc([makeShape({ id: 'a' })]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'reparent',
      newParentId: null,
    }));
    expect(out.shapes).toHaveLength(1);
    expect(out.shapes[0].id).toBe('a');
  });

  it('no-ops when the shape is not found', () => {
    const doc = makeNestedDoc([makeShape({ id: 'a' })]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'reparent',
      shapeId: 'does-not-exist',
      newParentId: null,
    }));
    expect(out.shapes).toHaveLength(1);
    expect(out.shapes[0].id).toBe('a');
  });
});

// ---- ungroup coordinate remap (Figma hierarchy bug fix) ----------------------

describe('patch: ungroup coord remap', () => {
  it('remaps children to preserve absolute position when a top-level group is dissolved', () => {
    // Group at (200, 100) at root. Child rect with stored RELATIVE (10, 20)
    // => absolute (210, 120). After ungroup, rect is promoted to root and its
    // absolute (210, 120) is preserved.
    const group = makeShape({ id: 'g1', type: 'group', x: 200, y: 100, width: 50, height: 50 });
    const rect = makeShape({ id: 'r1', x: 10, y: 20, width: 30, height: 30, parentId: 'g1' });
    const doc = makeNestedDoc([group, rect]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'ungroup',
      shapeIds: ['g1'],
    }));
    const updatedRect = out.shapes.find((s) => s.id === 'r1');
    expect(updatedRect).toBeDefined();
    expect(updatedRect?.parentId).toBeNull();
    // Absolute (210, 120) is preserved — now also the stored root x/y.
    expect(updatedRect?.x).toBe(210);
    expect(updatedRect?.y).toBe(120);
  });

  it('remaps children to be relative to the grandparent when a nested group is dissolved', () => {
    // Outer frame at (100, 50). Inner group inside Outer at relative (10, 10)
    // => absolute (110, 60). Rect inside group at relative (5, 5) => absolute
    // (115, 65). After ungrouping the group, rect is promoted to Outer and its
    // absolute (115, 65) is preserved.
    const outer = makeShape({ id: 'outer', type: 'frame', x: 100, y: 50, width: 500, height: 500 });
    const group = makeShape({ id: 'g1', type: 'group', x: 10, y: 10, width: 100, height: 100, parentId: 'outer' });
    const rect = makeShape({ id: 'r1', x: 5, y: 5, width: 30, height: 30, parentId: 'g1' });
    const doc = makeNestedDoc([outer, group, rect]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'ungroup',
      shapeIds: ['g1'],
    }));
    const updatedRect = out.shapes.find((s) => s.id === 'r1');
    expect(updatedRect).toBeDefined();
    expect(updatedRect?.parentId).toBe('outer'); // promoted to grandparent
    // Absolute (115, 65) is preserved — the resolved flat list shows the same.
    expect(updatedRect?.x).toBe(115);
    expect(updatedRect?.y).toBe(65);
  });

  it('preserves sibling order when promoting children', () => {
    // Group with 3 children. After ungroup, children should appear at the
    // group's slot in the grandparent's children array, in the same order.
    const group = makeShape({ id: 'g1', type: 'group', x: 0, y: 0, width: 100, height: 100 });
    const a = makeShape({ id: 'a', x: 0, y: 0, width: 10, height: 10, parentId: 'g1' });
    const b = makeShape({ id: 'b', x: 0, y: 0, width: 10, height: 10, parentId: 'g1' });
    const c = makeShape({ id: 'c', x: 0, y: 0, width: 10, height: 10, parentId: 'g1' });
    const top = makeShape({ id: 'top', x: 0, y: 0, width: 10, height: 10 });
    const bottom = makeShape({ id: 'bottom', x: 0, y: 0, width: 10, height: 10 });
    const doc = makeNestedDoc([top, group, bottom, a, b, c]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'ungroup',
      shapeIds: ['g1'],
    }));
    // Top-level order should be: top, a, b, c, bottom (group replaced by its
    // children in their original order). The resolved flat list orders nodes
    // depth-first by zIndex, so top-level nodes appear in tree order.
    const rootLevelIds = out.shapes.filter((s) => !s.parentId).map((s) => s.id);
    expect(rootLevelIds).toEqual(['top', 'a', 'b', 'c', 'bottom']);
  });
});

// ---- set_constraints (Figma hierarchy) ----------------------------------------

describe('patch: set_constraints', () => {
  it('sets Figma-style constraints on a node', () => {
    const a = makeShape({ id: 'a' });
    const doc = makeDoc([a]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'set_constraints',
      shapeId: 'a',
      constraints: { horizontal: 'left_right', vertical: 'top_bottom' },
    }));
    expect(out.shapes[0].constraints).toEqual({ horizontal: 'left_right', vertical: 'top_bottom' });
  });

  it('clears constraints when null is passed', () => {
    const a = makeShape({ id: 'a', constraints: { horizontal: 'scale', vertical: 'center' } });
    const doc = makeDoc([a]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'set_constraints',
      shapeId: 'a',
      constraints: null,
    }));
    expect(out.shapes[0].constraints).toBeNull();
  });

  it('no-ops when the shapeId is missing', () => {
    const a = makeShape({ id: 'a' });
    const doc = makeDoc([a]);
    const out = applyPatchToCanvas(doc, patch({
      op: 'set_constraints',
      constraints: { horizontal: 'left', vertical: 'top' },
    }));
    expect(out.shapes[0].constraints).toBeNull();
  });

  it('survives a tree round-trip (constraints preserved after resolvePenTree)', () => {
    // Set constraints, then trigger an unrelated mutation (rename) to force
    // resolvePenTree to re-derive shapes. The constraints should survive.
    const a = makeShape({ id: 'a' });
    const doc = makeDoc([a]);
    let out = applyPatchToCanvas(doc, patch({
      op: 'set_constraints',
      shapeId: 'a',
      constraints: { horizontal: 'center', vertical: 'scale' },
    }));
    out = applyPatchToCanvas(out, patch({
      op: 'update',
      shapeId: 'a',
      shape: { name: 'Renamed' },
    }));
    expect(out.shapes[0].constraints).toEqual({ horizontal: 'center', vertical: 'scale' });
    expect(out.shapes[0].name).toBe('Renamed');
  });
});
