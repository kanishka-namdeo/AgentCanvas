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
});
