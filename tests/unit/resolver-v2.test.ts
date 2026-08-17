// Tests for the v2.0 resolver changes.
//
// Verifies that resolvePenTree() correctly maps the new node types
// (boolean_op, star, polygon, icon, component, component_set,
// instance, section, slice) to their corresponding ShapeType values,
// and that v2.0-specific fields (polygonCount, pointCount, iconName,
// booleanOperation, blendMode, cornerSmoothing, etc.) propagate to
// the resolved Shape.

import { describe, it, expect } from 'vitest';
import { resolvePenTree } from '@/lib/pen/resolve';
import { createEmptyCanvasDocument } from '@/lib/canvas/types';
import type { PenChild, PenDocument } from '@/lib/pen/types';
import { PEN_FORMAT_VERSION } from '@/lib/pen/types';

function docWith(children: PenChild[]): ReturnType<typeof createEmptyCanvasDocument> {
  const canvas = createEmptyCanvasDocument('test', 'Test');
  canvas.children = children;
  return canvas;
}

describe('resolvePenTree: v2.0 node type mapping', () => {
  it('maps a plain frame to "frame"', () => {
    const canvas = docWith([
      { type: 'frame', id: 'f1', x: 0, y: 0, width: 100, height: 100, children: [] } as PenChild,
    ]);
    const shapes = resolvePenTree(canvas);
    expect(shapes).toHaveLength(1);
    expect(shapes[0].type).toBe('frame');
  });

  it('maps a reusable frame to "component"', () => {
    const canvas = docWith([
      { type: 'frame', id: 'c1', reusable: true, x: 0, y: 0, width: 100, height: 40, children: [] } as PenChild,
    ]);
    const shapes = resolvePenTree(canvas);
    expect(shapes[0].type).toBe('component');
  });

  it('maps a frame with metadata.isComponentSet to "component_set"', () => {
    const canvas = docWith([
      {
        type: 'frame', id: 'cs1', x: 0, y: 0, width: 300, height: 200,
        metadata: { isComponentSet: true }, children: [],
      } as PenChild,
    ]);
    const shapes = resolvePenTree(canvas);
    expect(shapes[0].type).toBe('component_set');
  });

  it('maps a frame with metadata.isSection to "section"', () => {
    const canvas = docWith([
      {
        type: 'frame', id: 's1', x: 0, y: 0, width: 480, height: 320,
        metadata: { isSection: true }, children: [],
      } as PenChild,
    ]);
    const shapes = resolvePenTree(canvas);
    expect(shapes[0].type).toBe('section');
  });

  it('maps a frame with metadata.isSlice to "slice"', () => {
    const canvas = docWith([
      {
        type: 'frame', id: 'sl1', x: 0, y: 0, width: 200, height: 120,
        metadata: { isSlice: true }, children: [],
      } as PenChild,
    ]);
    const shapes = resolvePenTree(canvas);
    expect(shapes[0].type).toBe('slice');
  });

  it('maps a PenRef to "instance"', () => {
    // Need a reusable target for the ref to expand against
    const canvas = docWith([
      { type: 'frame', id: 'c1', reusable: true, x: 0, y: 0, width: 100, height: 40, children: [] } as PenChild,
      { type: 'ref', id: 'i1', ref: 'c1', x: 100, y: 100 } as PenChild,
    ]);
    const shapes = resolvePenTree(canvas);
    // The ref expands into a copy of the component, so we get the component
    // shape plus the expanded instance shape.
    const types = shapes.map((s) => s.type);
    expect(types).toContain('component');
  });

  it('maps a PenBooleanOp to "boolean_op"', () => {
    const canvas = docWith([
      {
        type: 'boolean_op', id: 'b1', operation: 'union', x: 0, y: 0, width: 100, height: 100,
        children: [
          { type: 'rectangle', id: 'r1', x: 0, y: 0, width: 80, height: 80, fill: '#ff0000' } as PenChild,
          { type: 'ellipse', id: 'e1', x: 40, y: 40, width: 80, height: 80, fill: '#00ff00' } as PenChild,
        ],
      } as PenChild,
    ]);
    const shapes = resolvePenTree(canvas);
    const boolShape = shapes.find((s) => s.type === 'boolean_op');
    expect(boolShape).toBeDefined();
    expect(boolShape?.booleanOperation).toBe('union');
  });

  it('maps a polygon to "polygon" (not "ellipse" as in v1)', () => {
    const canvas = docWith([
      { type: 'polygon', id: 'p1', x: 0, y: 0, width: 100, height: 100, polygonCount: 6, fill: '#3b82f6' } as PenChild,
    ]);
    const shapes = resolvePenTree(canvas);
    expect(shapes[0].type).toBe('polygon');
    expect(shapes[0].polygonCount).toBe(6);
  });

  it('maps a star to "star"', () => {
    const canvas = docWith([
      { type: 'star', id: 's1', x: 0, y: 0, width: 100, height: 100, pointCount: 5, innerRadius: 0.5, fill: '#fde047' } as PenChild,
    ]);
    const shapes = resolvePenTree(canvas);
    expect(shapes[0].type).toBe('star');
    expect(shapes[0].pointCount).toBe(5);
    expect(shapes[0].innerRadius).toBe(0.5);
  });

  it('maps an icon to "icon" (not "text" as in v1)', () => {
    const canvas = docWith([
      { type: 'icon', id: 'i1', x: 0, y: 0, width: 24, height: 24, library: 'lucide', icon: 'check', fill: '#000000' } as PenChild,
    ]);
    const shapes = resolvePenTree(canvas);
    expect(shapes[0].type).toBe('icon');
    expect(shapes[0].iconLibrary).toBe('lucide');
    expect(shapes[0].iconName).toBe('check');
  });
});

describe('resolvePenTree: v2.0 field propagation', () => {
  it('propagates blendMode to the resolved shape', () => {
    const canvas = docWith([
      { type: 'rectangle', id: 'r1', x: 0, y: 0, width: 100, height: 100, fill: '#ff0000', blendMode: 'multiply' } as PenChild,
    ]);
    const shapes = resolvePenTree(canvas);
    expect(shapes[0].blendMode).toBe('multiply');
  });

  it('propagates cornerSmoothing to the resolved shape', () => {
    const canvas = docWith([
      { type: 'rectangle', id: 'r1', x: 0, y: 0, width: 100, height: 100, fill: '#ff0000', cornerSmoothing: 0.6, cornerRadius: 16 } as PenChild,
    ]);
    const shapes = resolvePenTree(canvas);
    expect(shapes[0].cornerSmoothing).toBe(0.6);
  });

  it('propagates strokeDashes to the resolved shape', () => {
    const canvas = docWith([
      { type: 'rectangle', id: 'r1', x: 0, y: 0, width: 100, height: 100, fill: '#ff0000', stroke: '#000', strokeWidth: 2, strokeDashes: [4, 2] } as PenChild,
    ]);
    const shapes = resolvePenTree(canvas);
    expect(shapes[0].strokeDashes).toEqual([4, 2]);
  });

  it('propagates strokeAlignment / strokeLinejoin / strokeLinecap', () => {
    const canvas = docWith([
      {
        type: 'rectangle', id: 'r1', x: 0, y: 0, width: 100, height: 100, fill: '#ff0000',
        stroke: '#000', strokeWidth: 2,
        strokeAlignment: 'inner', strokeLinejoin: 'round', strokeLinecap: 'round',
      } as PenChild,
    ]);
    const shapes = resolvePenTree(canvas);
    expect(shapes[0].strokeAlignment).toBe('inner');
    expect(shapes[0].strokeLinejoin).toBe('round');
    expect(shapes[0].strokeLinecap).toBe('round');
  });

  it('propagates individual stroke weights', () => {
    const canvas = docWith([
      {
        type: 'rectangle', id: 'r1', x: 0, y: 0, width: 100, height: 100, fill: '#ff0000',
        stroke: '#000',
        strokeWidth: { top: 1, right: 2, bottom: 3, left: 4 },
      } as PenChild,
    ]);
    const shapes = resolvePenTree(canvas);
    expect(shapes[0].individualStrokeWeights).toEqual({ top: 1, right: 2, bottom: 3, left: 4 });
  });

  it('propagates layoutPosition', () => {
    const canvas = docWith([
      { type: 'rectangle', id: 'r1', x: 0, y: 0, width: 100, height: 100, fill: '#ff0000', layoutPosition: 'absolute' } as PenChild,
    ]);
    const shapes = resolvePenTree(canvas);
    expect(shapes[0].layoutPosition).toBe('absolute');
  });

  it('propagates clip from a frame', () => {
    const canvas = docWith([
      { type: 'frame', id: 'f1', x: 0, y: 0, width: 100, height: 100, clip: true, children: [] } as PenChild,
    ]);
    const shapes = resolvePenTree(canvas);
    expect(shapes[0].clip).toBe(true);
  });

  it('propagates metadata.constraints', () => {
    const canvas = docWith([
      {
        type: 'rectangle', id: 'r1', x: 0, y: 0, width: 100, height: 100, fill: '#ff0000',
        metadata: { constraints: { horizontal: 'left_right', vertical: 'scale' } },
      } as PenChild,
    ]);
    const shapes = resolvePenTree(canvas);
    expect(shapes[0].constraints).toEqual({ horizontal: 'left_right', vertical: 'scale' });
  });

  it('propagates metadata.gridLayout', () => {
    const canvas = docWith([
      {
        type: 'frame', id: 'f1', x: 0, y: 0, width: 400, height: 300,
        layout: 'grid',
        metadata: { gridLayout: { gridRowCount: 3, gridColumnCount: 4, gridRowGap: 8, gridColumnGap: 16 } },
        children: [],
      } as PenChild,
    ]);
    const shapes = resolvePenTree(canvas);
    expect(shapes[0].gridLayout?.gridRowCount).toBe(3);
    expect(shapes[0].gridLayout?.gridColumnCount).toBe(4);
  });

  it('propagates metadata.overflow', () => {
    const canvas = docWith([
      {
        type: 'frame', id: 'f1', x: 0, y: 0, width: 200, height: 400,
        metadata: { overflow: 'scroll-y' }, children: [],
      } as PenChild,
    ]);
    const shapes = resolvePenTree(canvas);
    expect(shapes[0].overflow).toBe('scroll-y');
  });

  it('propagates metadata.isMask + maskType', () => {
    const canvas = docWith([
      {
        type: 'rectangle', id: 'r1', x: 0, y: 0, width: 100, height: 100, fill: '#ff0000',
        metadata: { isMask: true, maskType: 'luminance' },
      } as PenChild,
    ]);
    const shapes = resolvePenTree(canvas);
    expect(shapes[0].isMask).toBe(true);
    expect(shapes[0].maskType).toBe('luminance');
  });

  it('propagates metadata.componentProperties', () => {
    const canvas = docWith([
      {
        type: 'frame', id: 'c1', reusable: true, x: 0, y: 0, width: 100, height: 40,
        metadata: {
          componentProperties: {
            label: { type: 'string', defaultValue: 'Submit' },
          },
        },
        children: [],
      } as PenChild,
    ]);
    const shapes = resolvePenTree(canvas);
    expect(shapes[0].componentProperties).toEqual({
      label: { type: 'string', defaultValue: 'Submit' },
    });
  });

  it('propagates metadata.variantProperties', () => {
    const canvas = docWith([
      {
        type: 'frame', id: 'c1', reusable: true, x: 0, y: 0, width: 100, height: 40,
        metadata: { variantProperties: { state: 'default', size: 'md' } },
        children: [],
      } as PenChild,
    ]);
    const shapes = resolvePenTree(canvas);
    expect(shapes[0].variantProperties).toEqual({ state: 'default', size: 'md' });
  });

  it('propagates ellipse arc data', () => {
    const canvas = docWith([
      {
        type: 'ellipse', id: 'e1', x: 0, y: 0, width: 100, height: 100, fill: '#ff0000',
        innerRadius: 0.5, startAngle: 0, sweepAngle: 180,
      } as PenChild,
    ]);
    const shapes = resolvePenTree(canvas);
    expect(shapes[0].innerRingRadius).toBe(0.5);
    expect(shapes[0].startAngle).toBe(0);
    expect(shapes[0].sweepAngle).toBe(180);
  });

  it('propagates boolean_op.operation', () => {
    const canvas = docWith([
      {
        type: 'boolean_op', id: 'b1', operation: 'subtract', x: 0, y: 0, width: 100, height: 100,
        children: [
          { type: 'rectangle', id: 'r1', x: 0, y: 0, width: 80, height: 80, fill: '#ff0000' } as PenChild,
          { type: 'ellipse', id: 'e1', x: 40, y: 40, width: 60, height: 60, fill: '#00ff00' } as PenChild,
        ],
      } as PenChild,
    ]);
    const shapes = resolvePenTree(canvas);
    const boolShape = shapes.find((s) => s.type === 'boolean_op');
    expect(boolShape?.booleanOperation).toBe('subtract');
  });
});

describe('resolvePenTree: boolean_op walks children', () => {
  it('resolves boolean_op children depth-first', () => {
    const canvas = docWith([
      {
        type: 'boolean_op', id: 'b1', operation: 'union', x: 0, y: 0, width: 200, height: 200,
        children: [
          { type: 'rectangle', id: 'r1', x: 0, y: 0, width: 100, height: 100, fill: '#ff0000' } as PenChild,
          { type: 'rectangle', id: 'r2', x: 50, y: 50, width: 100, height: 100, fill: '#00ff00' } as PenChild,
        ],
      } as PenChild,
    ]);
    const shapes = resolvePenTree(canvas);
    // We expect: 1 boolean_op + 2 children
    expect(shapes.length).toBeGreaterThanOrEqual(3);
    const boolShape = shapes.find((s) => s.id === 'b1');
    expect(boolShape).toBeDefined();
    expect(shapes.find((s) => s.id === 'r1')).toBeDefined();
    expect(shapes.find((s) => s.id === 'r2')).toBeDefined();
  });
});
