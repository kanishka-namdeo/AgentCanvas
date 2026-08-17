// Tests for the v2.0 patch ops.
//
// Verifies that the patch applier correctly handles the 15 new ops:
//   create_component, create_component_set, create_instance,
//   set_component_property, detach_instance, create_boolean_op,
//   set_constraints, set_layout_position, set_grid_layout,
//   set_overflow, set_mask, clear_mask, set_blend_mode,
//   set_corner_smoothing, set_stroke_dashes, bind_field, unbind_field.

import { describe, it, expect } from 'vitest';
import { applyPatchToCanvas } from '@/lib/canvas/patch';
import { createEmptyCanvasDocument } from '@/lib/canvas/types';
import type { CanvasPatch, CanvasDocument } from '@/lib/canvas/types';
import type { PenChild, PenFrame } from '@/lib/pen/types';

function docWith(children: PenChild[]): CanvasDocument {
  const canvas = createEmptyCanvasDocument('test', 'Test');
  canvas.children = children;
  return canvas;
}

function rect(id: string, x = 0, y = 0, w = 100, h = 100): PenChild {
  return { type: 'rectangle', id, x, y, width: w, height: h, fill: '#ff0000' } as PenChild;
}

function frame(id: string, children: PenChild[] = []): PenChild {
  return { type: 'frame', id, x: 0, y: 0, width: 200, height: 100, children, fill: '#ffffff' } as PenChild;
}

describe('patch: create_component', () => {
  it('marks a node as reusable (reusable: true)', () => {
    const canvas = docWith([rect('r1')]);
    const patch: CanvasPatch = {
      op: 'create_component',
      shapeId: 'r1',
      summary: 'Make component',
    };
    const next = applyPatchToCanvas(canvas, patch);
    const node = next.children[0] as PenChild & { reusable?: boolean };
    expect(node.reusable).toBe(true);
  });
});

describe('patch: create_component_set', () => {
  it('groups existing components into a new frame with isComponentSet flag', () => {
    const canvas = docWith([
      { type: 'frame', id: 'c1', reusable: true, x: 0, y: 0, width: 100, height: 40, children: [] } as PenChild,
      { type: 'frame', id: 'c2', reusable: true, x: 100, y: 0, width: 100, height: 40, children: [] } as PenChild,
    ]);
    const patch: CanvasPatch = {
      op: 'create_component_set',
      childIds: ['c1', 'c2'],
      shape: { name: 'Button Set' },
      summary: 'Create component set',
    };
    const next = applyPatchToCanvas(canvas, patch);
    // Originals removed; one new set added
    expect(next.children).toHaveLength(1);
    const set = next.children[0] as PenFrame;
    expect(set.type).toBe('frame');
    expect(set.metadata?.isComponentSet).toBe(true);
    expect(set.children).toHaveLength(2);
    expect(set.name).toBe('Button Set');
  });
});

describe('patch: create_instance', () => {
  it('creates a PenRef pointing at the componentId', () => {
    const canvas = docWith([
      { type: 'frame', id: 'c1', reusable: true, x: 0, y: 0, width: 100, height: 40, children: [] } as PenChild,
    ]);
    const patch: CanvasPatch = {
      op: 'create_instance',
      componentId: 'c1',
      shape: { x: 200, y: 100 },
      variantValues: { state: 'hover' },
      summary: 'Create instance',
    };
    const next = applyPatchToCanvas(canvas, patch);
    expect(next.children).toHaveLength(2);
    const inst = next.children[1] as PenChild & { type: string; ref: string; variantValues?: Record<string, string> };
    expect(inst.type).toBe('ref');
    expect(inst.ref).toBe('c1');
    expect(inst.variantValues?.state).toBe('hover');
  });
});

describe('patch: set_component_property', () => {
  it('adds a component property definition to a node', () => {
    const canvas = docWith([
      { type: 'frame', id: 'c1', reusable: true, x: 0, y: 0, width: 100, height: 40, children: [] } as PenChild,
    ]);
    const patch: CanvasPatch = {
      op: 'set_component_property',
      shapeId: 'c1',
      componentProperty: {
        name: 'label',
        type: 'string',
        defaultValue: 'Submit',
      },
      summary: 'Add label property',
    };
    const next = applyPatchToCanvas(canvas, patch);
    const node = next.children[0] as PenFrame;
    const props = node.metadata?.componentProperties as Record<string, unknown> | undefined;
    expect(props?.label).toEqual({ type: 'string', defaultValue: 'Submit', variantOptions: undefined, preferredValues: undefined });
  });

  it('adds a variant property with options', () => {
    const canvas = docWith([
      { type: 'frame', id: 'c1', reusable: true, x: 0, y: 0, width: 100, height: 40, children: [] } as PenChild,
    ]);
    const patch: CanvasPatch = {
      op: 'set_component_property',
      shapeId: 'c1',
      componentProperty: {
        name: 'state',
        type: 'variant',
        defaultValue: 'default',
        variantOptions: ['default', 'hover', 'disabled'],
      },
      summary: 'Add state property',
    };
    const next = applyPatchToCanvas(canvas, patch);
    const node = next.children[0] as PenFrame;
    const props = node.metadata?.componentProperties as Record<string, { variantOptions?: string[] }>;
    expect(props?.state.variantOptions).toEqual(['default', 'hover', 'disabled']);
  });
});

describe('patch: detach_instance', () => {
  it('converts a PenRef into a flat frame with metadata.detachedFrom', () => {
    const canvas = docWith([
      { type: 'frame', id: 'c1', reusable: true, x: 0, y: 0, width: 100, height: 40, children: [] } as PenChild,
      { type: 'ref', id: 'i1', ref: 'c1', x: 100, y: 100 } as PenChild,
    ]);
    const patch: CanvasPatch = {
      op: 'detach_instance',
      shapeId: 'i1',
      summary: 'Detach',
    };
    const next = applyPatchToCanvas(canvas, patch);
    const detached = next.children.find((c) => (c as PenChild & { id?: string }).id === 'i1') as PenFrame;
    expect(detached.type).toBe('frame');
    expect(detached.metadata?.detachedFrom).toBe('c1');
  });
});

describe('patch: create_boolean_op', () => {
  it('groups existing shapes into a boolean_op node', () => {
    const canvas = docWith([rect('r1'), rect('r2', 50, 50)]);
    const patch: CanvasPatch = {
      op: 'create_boolean_op',
      operation: 'union',
      childIds: ['r1', 'r2'],
      shape: { name: 'Union' },
      summary: 'Create boolean',
    };
    const next = applyPatchToCanvas(canvas, patch);
    expect(next.children).toHaveLength(1);
    const bool = next.children[0] as PenChild & { type: string; operation: string; children: PenChild[] };
    expect(bool.type).toBe('boolean_op');
    expect(bool.operation).toBe('union');
    expect(bool.children).toHaveLength(2);
  });

  it('supports all four operations', () => {
    for (const op of ['union', 'intersect', 'subtract', 'exclude'] as const) {
      const canvas = docWith([rect('r1'), rect('r2', 50, 50)]);
      const patch: CanvasPatch = {
        op: 'create_boolean_op',
        operation: op,
        childIds: ['r1', 'r2'],
        summary: `Create ${op}`,
      };
      const next = applyPatchToCanvas(canvas, patch);
      const bool = next.children[0] as PenChild & { operation: string };
      expect(bool.operation).toBe(op);
    }
  });
});

describe('patch: set_constraints', () => {
  it('stores constraints in the node metadata', () => {
    const canvas = docWith([rect('r1')]);
    const patch: CanvasPatch = {
      op: 'set_constraints',
      shapeId: 'r1',
      constraints: { horizontal: 'left_right', vertical: 'scale' },
      summary: 'Set constraints',
    };
    const next = applyPatchToCanvas(canvas, patch);
    const node = next.children[0] as PenFrame;
    expect(node.metadata?.constraints).toEqual({ horizontal: 'left_right', vertical: 'scale' });
  });
});

describe('patch: set_layout_position', () => {
  it('sets layoutPosition to absolute', () => {
    const canvas = docWith([rect('r1')]);
    const patch: CanvasPatch = {
      op: 'set_layout_position',
      shapeId: 'r1',
      layoutPosition: 'absolute',
      summary: 'Absolute',
    };
    const next = applyPatchToCanvas(canvas, patch);
    const node = next.children[0] as PenChild & { layoutPosition?: string };
    expect(node.layoutPosition).toBe('absolute');
  });

  it('toggles back to auto', () => {
    const canvas = docWith([rect('r1')]);
    const patch: CanvasPatch = {
      op: 'set_layout_position',
      shapeId: 'r1',
      layoutPosition: 'auto',
      summary: 'Auto',
    };
    const next = applyPatchToCanvas(canvas, patch);
    const node = next.children[0] as PenChild & { layoutPosition?: string };
    expect(node.layoutPosition).toBe('auto');
  });
});

describe('patch: set_grid_layout', () => {
  it('sets layout:grid and stores gridLayout in metadata', () => {
    const canvas = docWith([frame('f1')]);
    const patch: CanvasPatch = {
      op: 'set_grid_layout',
      shapeId: 'f1',
      gridConfig: { rows: 3, columns: 4, rowGap: 8, columnGap: 16 },
      summary: 'Grid layout',
    };
    const next = applyPatchToCanvas(canvas, patch);
    const node = next.children[0] as PenFrame;
    expect(node.layout).toBe('grid');
    expect(node.metadata?.gridLayout).toEqual({ rows: 3, columns: 4, rowGap: 8, columnGap: 16, columnsSizing: undefined, rowsSizing: undefined });
  });
});

describe('patch: set_overflow', () => {
  it('sets clip:true and stores overflow mode in metadata', () => {
    const canvas = docWith([frame('f1')]);
    const patch: CanvasPatch = {
      op: 'set_overflow',
      shapeId: 'f1',
      overflow: 'scroll-y',
      summary: 'Scroll Y',
    };
    const next = applyPatchToCanvas(canvas, patch);
    const node = next.children[0] as PenFrame & { clip?: boolean };
    expect(node.clip).toBe(true);
    expect(node.metadata?.overflow).toBe('scroll-y');
  });
});

describe('patch: set_mask / clear_mask', () => {
  it('marks a node as a mask with type', () => {
    const canvas = docWith([rect('r1')]);
    const patch: CanvasPatch = {
      op: 'set_mask',
      shapeId: 'r1',
      maskType: 'luminance',
      summary: 'Set mask',
    };
    const next = applyPatchToCanvas(canvas, patch);
    const node = next.children[0] as PenFrame;
    expect(node.metadata?.isMask).toBe(true);
    expect(node.metadata?.maskType).toBe('luminance');
  });

  it('clears the mask flag', () => {
    const canvas = docWith([rect('r1')]);
    // First set the mask
    const setPatch: CanvasPatch = {
      op: 'set_mask', shapeId: 'r1', maskType: 'alpha', summary: 'Set',
    };
    let next = applyPatchToCanvas(canvas, setPatch);
    // Then clear it
    const clearPatch: CanvasPatch = {
      op: 'clear_mask', shapeId: 'r1', summary: 'Clear',
    };
    next = applyPatchToCanvas(next, clearPatch);
    const node = next.children[0] as PenFrame;
    expect(node.metadata?.isMask).toBeUndefined();
    expect(node.metadata?.maskType).toBeUndefined();
  });
});

describe('patch: set_blend_mode', () => {
  it('sets blendMode on a node', () => {
    const canvas = docWith([rect('r1')]);
    const patch: CanvasPatch = {
      op: 'set_blend_mode',
      shapeId: 'r1',
      blendMode: 'multiply',
      summary: 'Multiply',
    };
    const next = applyPatchToCanvas(canvas, patch);
    const node = next.children[0] as PenChild & { blendMode?: string };
    expect(node.blendMode).toBe('multiply');
  });
});

describe('patch: set_corner_smoothing', () => {
  it('sets cornerSmoothing on a node', () => {
    const canvas = docWith([rect('r1')]);
    const patch: CanvasPatch = {
      op: 'set_corner_smoothing',
      shapeId: 'r1',
      cornerSmoothing: 0.6,
      summary: 'iOS squircle',
    };
    const next = applyPatchToCanvas(canvas, patch);
    const node = next.children[0] as PenChild & { cornerSmoothing?: number };
    expect(node.cornerSmoothing).toBe(0.6);
  });

  it('clamps to [0, 1]', () => {
    const canvas = docWith([rect('r1')]);
    const tooHigh: CanvasPatch = {
      op: 'set_corner_smoothing', shapeId: 'r1', cornerSmoothing: 5, summary: 'Too high',
    };
    const tooLow: CanvasPatch = {
      op: 'set_corner_smoothing', shapeId: 'r1', cornerSmoothing: -1, summary: 'Too low',
    };
    let next = applyPatchToCanvas(canvas, tooHigh);
    expect((next.children[0] as PenChild & { cornerSmoothing?: number }).cornerSmoothing).toBe(1);
    next = applyPatchToCanvas(next, tooLow);
    expect((next.children[0] as PenChild & { cornerSmoothing?: number }).cornerSmoothing).toBe(0);
  });
});

describe('patch: set_stroke_dashes', () => {
  it('sets a dash pattern', () => {
    const canvas = docWith([rect('r1')]);
    const patch: CanvasPatch = {
      op: 'set_stroke_dashes',
      shapeId: 'r1',
      strokeDashes: [4, 2],
      summary: 'Dashed',
    };
    const next = applyPatchToCanvas(canvas, patch);
    const node = next.children[0] as PenChild & { strokeDashes?: number[] };
    expect(node.strokeDashes).toEqual([4, 2]);
  });
});

describe('patch: bind_field / unbind_field', () => {
  it('replaces a literal field with a $variable reference', () => {
    const canvas = docWith([rect('r1')]);
    const patch: CanvasPatch = {
      op: 'bind_field',
      shapeId: 'r1',
      bindField: 'fill',
      bindVariableKey: 'brand.primary',
      summary: 'Bind fill',
    };
    const next = applyPatchToCanvas(canvas, patch);
    const node = next.children[0] as PenChild & { fill?: string };
    expect(node.fill).toBe('$brand.primary');
  });

  it('binds stroke to a variable', () => {
    const canvas = docWith([rect('r1')]);
    const patch: CanvasPatch = {
      op: 'bind_field',
      shapeId: 'r1',
      bindField: 'stroke',
      bindVariableKey: 'border.subtle',
      summary: 'Bind stroke',
    };
    const next = applyPatchToCanvas(canvas, patch);
    const node = next.children[0] as PenChild & { stroke?: string };
    expect(node.stroke).toBe('$border.subtle');
  });
});

describe('patch: v2.0 ops preserve derived cache recomputation', () => {
  it('recomputes shapes after create_component', () => {
    const canvas = docWith([rect('r1')]);
    const patch: CanvasPatch = {
      op: 'create_component', shapeId: 'r1', summary: 'Make component',
    };
    const next = applyPatchToCanvas(canvas, patch);
    expect(next.shapes.length).toBeGreaterThan(0);
    expect(next.shapes[0].type).toBe('component');
  });

  it('recomputes shapes after set_mask', () => {
    const canvas = docWith([rect('r1')]);
    const patch: CanvasPatch = {
      op: 'set_mask', shapeId: 'r1', maskType: 'alpha', summary: 'Mask',
    };
    const next = applyPatchToCanvas(canvas, patch);
    expect(next.shapes.length).toBeGreaterThan(0);
    expect(next.shapes[0].isMask).toBe(true);
  });
});
