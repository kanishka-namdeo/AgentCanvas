// Tests for the pure clipboard helpers — serialize / deserialize / offset.
//
// These functions are pure (no side effects, no I/O), so they're trivially
// unit-testable. The useClipboard hook wraps them with navigator.clipboard
// calls and is tested separately in tests/integration/pipeline.test.ts.

import { describe, it, expect } from 'vitest';
import { serializeShapes, deserializeShapes, offsetShapes, detectPayloadKind } from '@/lib/canvas/clipboard';
import type { Shape } from '@/lib/canvas/types';

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

describe('clipboard: serializeShapes / deserializeShapes', () => {
  it('round-trips a single shape', () => {
    const shape = makeShape({ id: 's1', name: 'Card', x: 100, y: 200 });
    const json = serializeShapes([shape]);
    const back = deserializeShapes(json);
    expect(back).toHaveLength(1);
    expect(back[0].id).toBe('s1');
    expect(back[0].name).toBe('Card');
    expect(back[0].x).toBe(100);
    expect(back[0].y).toBe(200);
  });

  it('round-trips multiple shapes', () => {
    const shapes = [
      makeShape({ id: 'a', name: 'A', x: 10 }),
      makeShape({ id: 'b', name: 'B', x: 20 }),
      makeShape({ id: 'c', name: 'C', x: 30 }),
    ];
    const json = serializeShapes(shapes);
    const back = deserializeShapes(json);
    expect(back.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('preserves all shape fields on round-trip', () => {
    const shape = makeShape({
      id: 'complex',
      type: 'ellipse',
      name: 'Circle',
      x: 50, y: 75, width: 200, height: 150,
      rotation: 45, opacity: 0.8,
      fill: '#ff0000', stroke: '#0000ff', strokeWidth: 3, radius: 8,
      fontSize: 24, textColor: '#00ff00',
      parentId: 'parent-1', zIndex: 5,
      locked: true, visible: false,
      componentId: 'comp-1',
      points: [{ x: 1, y: 2 }], closed: true,
      src: 'https://example.com/img.png',
      radii: { topLeft: 4, topRight: 8, bottomRight: 12, bottomLeft: 16 },
      gradient: { type: 'linear', angle: 90, stops: [{ offset: 0, color: '#fff' }, { offset: 1, color: '#000' }] },
      shadow: { x: 1, y: 2, blur: 3, color: '#000', spread: 0, inset: false },
      blur: 2, maskId: 'mask-1',
      constraints: { horizontal: 'left', vertical: 'top' },
    });
    const back = deserializeShapes(serializeShapes([shape]))[0];
    expect(back).toEqual(shape);
  });

  it('returns [] for invalid JSON', () => {
    expect(deserializeShapes('not json')).toEqual([]);
  });

  it('returns [] for non-shape payloads', () => {
    expect(deserializeShapes(JSON.stringify({ kind: 'color', value: '#fff' }))).toEqual([]);
    expect(deserializeShapes(JSON.stringify({ kind: 'value', value: 42 }))).toEqual([]);
    expect(deserializeShapes(JSON.stringify({ not: 'a payload' }))).toEqual([]);
  });
});

describe('clipboard: offsetShapes', () => {
  it('offsets x and y by the given delta', () => {
    const shapes = [makeShape({ id: 's1', x: 100, y: 200 })];
    const offset = offsetShapes(shapes, 24, 0);
    expect(offset[0].x).toBe(124);
    expect(offset[0].y).toBe(200);
  });

  it('preserves the original shapes (does not mutate input)', () => {
    const shapes = [makeShape({ id: 's1', x: 100, y: 200 })];
    offsetShapes(shapes, 24, 0);
    expect(shapes[0].x).toBe(100); // unchanged
  });

  it('assigns fresh IDs by default', () => {
    const shapes = [makeShape({ id: 's1', x: 0 }), makeShape({ id: 's2', x: 100 })];
    const offset = offsetShapes(shapes, 24, 0);
    expect(offset[0].id).not.toBe('s1');
    expect(offset[1].id).not.toBe('s2');
    expect(offset[0].id).not.toBe(offset[1].id);
  });

  it('preserves IDs when newIds=false', () => {
    const shapes = [makeShape({ id: 's1', x: 0 })];
    const offset = offsetShapes(shapes, 24, 0, false);
    expect(offset[0].id).toBe('s1');
  });

  it('rewrites parentId references when newIds=true', () => {
    const parent = makeShape({ id: 'p1', x: 0 });
    const child = makeShape({ id: 'c1', x: 50, parentId: 'p1' });
    const offset = offsetShapes([parent, child], 24, 0, true);
    expect(offset[0].id).not.toBe('p1');
    expect(offset[1].parentId).toBe(offset[0].id); // child.parentId now points to the new parent id
  });

  it('handles null parentId cleanly', () => {
    const shape = makeShape({ id: 's1', parentId: null });
    const offset = offsetShapes([shape], 24, 0, true);
    expect(offset[0].parentId).toBeNull();
  });

  it('offset works for negative deltas', () => {
    const shapes = [makeShape({ id: 's1', x: 100, y: 100 })];
    const offset = offsetShapes(shapes, -50, -50);
    expect(offset[0].x).toBe(50);
    expect(offset[0].y).toBe(50);
  });
});

describe('clipboard: detectPayloadKind', () => {
  it('detects a shape payload', () => {
    const json = serializeShapes([makeShape()]);
    expect(detectPayloadKind(json)).toBe('shape');
  });

  it('detects a color payload', () => {
    expect(detectPayloadKind(JSON.stringify({ kind: 'color', value: '#fff' }))).toBe('color');
  });

  it('detects a value payload', () => {
    expect(detectPayloadKind(JSON.stringify({ kind: 'value', value: 42 }))).toBe('value');
  });

  it('detects a constraints payload', () => {
    expect(detectPayloadKind(JSON.stringify({ kind: 'constraints', horizontal: 'left', vertical: 'top' }))).toBe('constraints');
  });

  it('returns null for invalid JSON', () => {
    expect(detectPayloadKind('not json')).toBeNull();
  });

  it('returns null for payloads without a kind field', () => {
    expect(detectPayloadKind(JSON.stringify({ not: 'a payload' }))).toBeNull();
  });
});
