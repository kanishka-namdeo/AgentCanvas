// Tests for the v2.0 Figma-aligned ontology.
//
// Covers:
//   - PenNodeMetadata bag (ComponentSet, Section, Slice, Mask, Constraints, …)
//   - PenBooleanOp type
//   - PenStar type
//   - Component Property definitions
//   - Variable alias + bound variables
//   - Type guards (isPenNode, isPenDocument)

import { describe, it, expect } from 'vitest';
import {
  PEN_FORMAT_VERSION,
  PEN_NODE_TYPES,
  isPenNode,
  isPenDocument,
  type PenChild,
  type PenDocument,
  type PenFrame,
  type PenBooleanOp,
  type PenStar,
  type PenPolygon,
  type PenRef,
  type PenComponentPropertyDefinition,
  type PenNodeMetadata,
  type PenLayoutConstraint,
} from '@/lib/pen/types';

describe('PEN_NODE_TYPES (v2.0)', () => {
  it('includes all v1 node types', () => {
    const v1 = ['frame', 'group', 'rectangle', 'ellipse', 'polygon', 'path', 'text', 'note', 'context', 'prompt', 'icon', 'script', 'ref'];
    for (const t of v1) expect(PEN_NODE_TYPES).toContain(t);
  });

  it('adds v2.0 types: star and boolean_op', () => {
    expect(PEN_NODE_TYPES).toContain('star');
    expect(PEN_NODE_TYPES).toContain('boolean_op');
  });
});

describe('PenBooleanOp', () => {
  it('constructs a union boolean op with children', () => {
    const boolOp: PenBooleanOp = {
      type: 'boolean_op',
      id: 'b1',
      operation: 'union',
      children: [
        { type: 'rectangle', id: 'r1', x: 0, y: 0, width: 100, height: 100, fill: '#ff0000' },
        { type: 'ellipse', id: 'e1', x: 50, y: 50, width: 100, height: 100, fill: '#00ff00' },
      ] as PenChild[],
    };
    expect(boolOp.operation).toBe('union');
    expect(boolOp.children).toHaveLength(2);
    expect(isPenNode(boolOp)).toBe(true);
  });

  it('supports all four operation types', () => {
    const ops: Array<PenBooleanOp['operation']> = ['union', 'intersect', 'subtract', 'exclude'];
    for (const op of ops) {
      const node: PenBooleanOp = {
        type: 'boolean_op', id: `b-${op}`, operation: op, children: [],
      };
      expect(node.operation).toBe(op);
    }
  });
});

describe('PenStar', () => {
  it('constructs a 5-point star with inner radius', () => {
    const star: PenStar = {
      type: 'star',
      id: 's1',
      x: 0, y: 0, width: 100, height: 100,
      pointCount: 5,
      innerRadius: 0.5,
      fill: '#ffdd00',
    };
    expect(star.pointCount).toBe(5);
    expect(star.innerRadius).toBe(0.5);
    expect(isPenNode(star)).toBe(true);
  });
});

describe('PenPolygon', () => {
  it('constructs a hexagon', () => {
    const hex: PenPolygon = {
      type: 'polygon',
      id: 'p1',
      x: 0, y: 0, width: 100, height: 100,
      polygonCount: 6,
      fill: '#3b82f6',
    };
    expect(hex.polygonCount).toBe(6);
  });
});

describe('PenNodeMetadata', () => {
  it('flags a frame as a Component Set', () => {
    const set: PenFrame = {
      type: 'frame',
      id: 'set-1',
      name: 'Button Set',
      metadata: { isComponentSet: true },
      children: [],
    };
    expect((set.metadata as PenNodeMetadata).isComponentSet).toBe(true);
  });

  it('flags a frame as a Section', () => {
    const sec: PenFrame = {
      type: 'frame',
      id: 'sec-1',
      name: 'Onboarding Flow',
      metadata: { isSection: true },
      children: [],
    };
    expect((sec.metadata as PenNodeMetadata).isSection).toBe(true);
  });

  it('flags a frame as a Slice', () => {
    const slice: PenFrame = {
      type: 'frame',
      id: 'sl-1',
      name: 'Export Slice',
      metadata: { isSlice: true },
      children: [],
    };
    expect((slice.metadata as PenNodeMetadata).isSlice).toBe(true);
  });

  it('stores mask configuration', () => {
    const mask: PenFrame = {
      type: 'frame',
      id: 'm1',
      metadata: { isMask: true, maskType: 'alpha' },
      children: [],
    };
    const meta = mask.metadata as PenNodeMetadata;
    expect(meta.isMask).toBe(true);
    expect(meta.maskType).toBe('alpha');
  });

  it('stores layout constraints', () => {
    const constraints: PenLayoutConstraint = {
      horizontal: 'left_right',
      vertical: 'scale',
    };
    const rect: PenChild = {
      type: 'rectangle',
      id: 'r1',
      x: 0, y: 0, width: 100, height: 50,
      fill: '#ff0000',
      metadata: { constraints },
    };
    expect((rect as unknown as PenFrame).metadata?.constraints).toEqual(constraints);
  });

  it('stores grid layout config', () => {
    const grid: PenFrame = {
      type: 'frame',
      id: 'g1',
      layout: 'grid',
      metadata: {
        gridLayout: {
          gridRowCount: 3,
          gridColumnCount: 4,
          gridRowGap: 8,
          gridColumnGap: 16,
          gridColumnsSizing: '1fr 1fr 1fr 1fr',
        },
      },
      children: [],
    };
    const meta = grid.metadata as PenNodeMetadata;
    expect(meta.gridLayout?.gridRowCount).toBe(3);
    expect(meta.gridLayout?.gridColumnCount).toBe(4);
    expect(meta.gridLayout?.gridColumnsSizing).toBe('1fr 1fr 1fr 1fr');
  });

  it('stores overflow mode', () => {
    const scrollable: PenFrame = {
      type: 'frame',
      id: 'sc1',
      metadata: { overflow: 'scroll-y' },
      children: [],
    };
    expect((scrollable.metadata as PenNodeMetadata).overflow).toBe('scroll-y');
  });

  it('stores component property definitions', () => {
    const comp: PenFrame = {
      type: 'frame',
      id: 'btn',
      reusable: true,
      metadata: {
        componentProperties: {
          label: { type: 'string', defaultValue: 'Submit' },
          showIcon: { type: 'boolean', defaultValue: true },
          size: { type: 'variant', defaultValue: 'md', variantOptions: ['sm', 'md', 'lg'] },
        },
      },
      children: [],
    };
    const props = (comp.metadata as PenNodeMetadata).componentProperties as Record<string, PenComponentPropertyDefinition>;
    expect(props.label.type).toBe('string');
    expect(props.showIcon.defaultValue).toBe(true);
    expect(props.size.variantOptions).toEqual(['sm', 'md', 'lg']);
  });

  it('stores variant properties on a component', () => {
    const variant: PenFrame = {
      type: 'frame',
      id: 'btn-default',
      reusable: true,
      metadata: {
        variantProperties: { state: 'default', size: 'md' },
      },
      children: [],
    };
    expect((variant.metadata as PenNodeMetadata).variantProperties?.state).toBe('default');
  });
});

describe('PenRef (instance)', () => {
  it('constructs a ref with descendant overrides', () => {
    const ref: PenRef = {
      type: 'ref',
      id: 'inst-1',
      ref: 'btn-primary',
      descendants: {
        'label': { content: 'Cancel' },
      },
    };
    expect(ref.ref).toBe('btn-primary');
    expect(ref.descendants?.['label']).toEqual({ content: 'Cancel' });
  });

  it('carries variant values for instance', () => {
    const ref: PenRef = {
      type: 'ref',
      id: 'inst-2',
      ref: 'btn-set',
      variantValues: { state: 'hover', size: 'lg' },
    };
    expect(ref.variantValues?.state).toBe('hover');
    expect(ref.variantValues?.size).toBe('lg');
  });
});

describe('isPenNode / isPenDocument', () => {
  it('isPenNode returns true for valid v2.0 nodes', () => {
    expect(isPenNode({ type: 'frame', id: 'f1', children: [] })).toBe(true);
    expect(isPenNode({ type: 'boolean_op', id: 'b1', operation: 'union', children: [] })).toBe(true);
    expect(isPenNode({ type: 'star', id: 's1', x: 0, y: 0, width: 100, height: 100 })).toBe(true);
  });

  it('isPenNode returns false for non-node objects', () => {
    expect(isPenNode({})).toBe(false);
    expect(isPenNode(null)).toBe(false);
    expect(isPenNode({ type: 'unknown' })).toBe(false);
  });

  it('isPenDocument validates a complete .pen document', () => {
    const doc: PenDocument = {
      version: PEN_FORMAT_VERSION,
      children: [
        { type: 'frame', id: 'f1', children: [] },
      ],
    };
    expect(isPenDocument(doc)).toBe(true);
  });

  it('isPenDocument rejects missing version or children', () => {
    expect(isPenDocument({})).toBe(false);
    expect(isPenDocument({ version: PEN_FORMAT_VERSION })).toBe(false);
    expect(isPenDocument({ children: [] })).toBe(false);
  });
});
