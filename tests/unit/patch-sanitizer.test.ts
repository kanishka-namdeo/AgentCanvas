// Unit tests — the agent-patch sanitizer (src/lib/canvas/patch-sanitizer.ts).
//
// The sanitizer is the tldraw "validate → sanitize → apply" layer in front of
// the append-only canvas: malformed patches must be DROPPED here because they
// can never be edited out after applying. Pinned rules:
//   - unknown op / missing payload → drop
//   - target ops (update/remove/duplicate) referencing nonexistent ids → drop
//     (the applier would no-op anyway — dropping avoids phantom undo + diff
//     records and a pointless fanout to every viewer)
//   - add/bulk_add with an id that ALREADY exists → drop (the #1 double-apply
//     failure: two nodes with the same id, previously masked by the renderer)
//   - non-finite / absurd geometry → clamped or dropped field
//   - everything else passes through untouched

import { describe, it, expect } from 'vitest';
import { sanitizeAgentPatch } from '@/lib/canvas/patch-sanitizer';
import type { CanvasDocument, CanvasPatch, Shape } from '@/lib/canvas/types';

function makeShape(id: string, overrides: Partial<Shape> = {}): Shape {
  return {
    id,
    type: 'rectangle',
    name: id,
    x: 0, y: 0, width: 100, height: 100,
    rotation: 0, opacity: 1,
    fill: '#cccccc', stroke: '#000', strokeWidth: 0,
    radius: 0, fontSize: 16, textColor: '#000',
    parentId: null, zIndex: 0,
    locked: false, visible: true,
    autoLayout: null, tokenBinding: null, componentId: null,
    points: null, closed: false, src: null, radii: null,
    gradient: null, shadow: null, blur: 0, maskId: null,
    ...overrides,
  } as Shape;
}

function makeDoc(shapes: Shape[] = []): CanvasDocument {
  return {
    id: 'doc',
    name: 'Test',
    background: '#ffffff',
    version: '2.17',
    children: shapes as never,
    viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes,
    tokens: { colors: [], textStyles: [] },
  };
}

describe('sanitizeAgentPatch — drops', () => {
  it('drops a patch with an unknown op', () => {
    const res = sanitizeAgentPatch({ op: 'teleport' } as unknown as CanvasPatch, makeDoc());
    expect(res.patch).toBeNull();
    expect(res.warnings.length).toBeGreaterThan(0);
  });

  it('drops update targeting a shape that does not exist', () => {
    const res = sanitizeAgentPatch(
      { op: 'update', shapeId: 'ghost', shape: { fill: '#f00' } } as CanvasPatch,
      makeDoc([makeShape('real')]),
    );
    expect(res.patch).toBeNull();
  });

  it('drops update_many when every target is missing (keeps partial matches)', () => {
    const res = sanitizeAgentPatch(
      {
        op: 'update_many',
        updates: [
          { id: 'real', changes: { fill: '#f00' } },
          { id: 'ghost', changes: { fill: '#0f0' } },
        ],
      } as unknown as CanvasPatch,
      makeDoc([makeShape('real')]),
    );
    expect(res.patch).not.toBeNull();
    expect(res.patch!.op).toBe('update_many');
    expect((res.patch as unknown as { updates: Array<{ id: string }> }).updates).toEqual([
      { id: 'real', changes: { fill: '#f00' } },
    ]);
  });

  it('drops remove when no target exists at all, keeps it when some do', () => {
    const none = sanitizeAgentPatch(
      { op: 'remove', shapeIds: ['ghost1', 'ghost2'] } as unknown as CanvasPatch,
      makeDoc([makeShape('real')]),
    );
    expect(none.patch).toBeNull();

    const partial = sanitizeAgentPatch(
      { op: 'remove', shapeIds: ['real', 'ghost'] } as unknown as CanvasPatch,
      makeDoc([makeShape('real')]),
    );
    expect(partial.patch).not.toBeNull();
  });

  it('drops add whose explicit id already exists on the canvas', () => {
    const res = sanitizeAgentPatch(
      { op: 'add', shape: { type: 'rectangle', id: 'dup' } } as unknown as CanvasPatch,
      makeDoc([makeShape('dup')]),
    );
    expect(res.patch).toBeNull();
    expect(res.warnings[0]).toContain('already exists');
  });

  it('drops bulk_add entries with duplicate ids inside the payload', () => {
    const res = sanitizeAgentPatch(
      {
        op: 'bulk_add',
        shapes: [
          { type: 'rectangle', id: 'n1' },
          { type: 'rectangle', id: 'n1' },
          { type: 'rectangle', id: 'n2' },
        ],
      } as unknown as CanvasPatch,
      makeDoc(),
    );
    expect(res.patch).not.toBeNull();
    expect((res.patch as unknown as { shapes: unknown[] }).shapes).toHaveLength(2);
  });

  it('drops duplicate whose source shape is already gone', () => {
    const res = sanitizeAgentPatch(
      { op: 'duplicate', shapeIds: ['ghost'] } as unknown as CanvasPatch,
      makeDoc([makeShape('real')]),
    );
    expect(res.patch).toBeNull();
  });
});

describe('sanitizeAgentPatch — clamps', () => {
  it('clamps non-finite geometry fields off the shape payload', () => {
    const res = sanitizeAgentPatch(
      {
        op: 'update',
        shapeId: 'real',
        shape: { x: Number.NaN, width: Number.POSITIVE_INFINITY, height: 250 },
      } as unknown as CanvasPatch,
      makeDoc([makeShape('real')]),
    );
    expect(res.patch).not.toBeNull();
    const shape = (res.patch as unknown as { shape: Record<string, unknown> }).shape;
    expect('x' in shape).toBe(false); // NaN dropped → applier default
    expect('width' in shape).toBe(false); // Infinity dropped
    expect(shape.height).toBe(250);
    expect(res.warnings.some((w) => w.includes('x'))).toBe(true);
  });

  it('clamps absurd coordinates into the sane range', () => {
    const res = sanitizeAgentPatch(
      { op: 'update', shapeId: 'real', shape: { x: 9_999_999 } } as unknown as CanvasPatch,
      makeDoc([makeShape('real')]),
    );
    const shape = (res.patch as unknown as { shape: Record<string, unknown> }).shape;
    expect(shape.x).toBe(100_000);
  });
});

describe('sanitizeAgentPatch — passes through', () => {
  it('passes a clean add through untouched', () => {
    const patch = { op: 'add', shape: { type: 'rectangle', id: 'fresh', x: 10, y: 20 } } as unknown as CanvasPatch;
    const res = sanitizeAgentPatch(patch, makeDoc());
    expect(res.patch).toBe(patch);
    expect(res.warnings).toEqual([]);
  });

  it('passes op-less-payload ops (background/clear/select) through', () => {
    for (const op of ['background', 'clear', 'select', 'undo', 'redo']) {
      const res = sanitizeAgentPatch({ op } as CanvasPatch, makeDoc([makeShape('a')]));
      expect(res.patch).not.toBeNull();
      expect(res.warnings).toEqual([]);
    }
  });
});
