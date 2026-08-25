// styleFor — Phase 4 L4 culling emission (spec §4.2).
//
// Pure-function coverage (jsdom-safe — no rendering, just style object):
//   - L4 emission appears ONLY on container types when l4Culling=true
//   - L4 emission absent on non-container types even when l4Culling=true
//   - L4 emission absent on containers when l4Culling=false/undefined
//   - L4 emission absent when layer.width/height <= 0 (no intrinsic size)
//   - L4 emission composes with nativeLayout (flex container still culls)
//   - L4 emission composes with flowChild (flowing flex container still culls)
//   - L4 emission composes with visible:false (visibility:hidden + culling)
//   - CULLABLE_CONTAINER_TYPES export: contains exactly the 5 container types
//   - L4 does NOT break other styleFor outputs (fill / border / radius)
//
// Mirrors the styleFor-flex.test.ts harness (same makeLayer / makePen /
// makeDoc) so the parity guarantees are testable side-by-side.

import { describe, it, expect } from 'vitest';
import { styleFor, CULLABLE_CONTAINER_TYPES } from '@/components/canvas/dom/styleFor';
import type { Layer, LayerType } from '@/lib/canvas/types';

// ---- Helpers -----------------------------------------------------------------

function makeLayer(overrides: Partial<Layer> = {}): Layer {
  return {
    id: 'test-layer',
    type: 'rectangle',
    name: 'Test',
    x: 10,
    y: 20,
    width: 100,
    height: 50,
    rotation: 0,
    opacity: 1,
    fill: '#cccccc',
    stroke: '#000000',
    strokeWidth: 0,
    radius: 0,
    fontSize: 16,
    textColor: '#000000',
    parentId: null,
    zIndex: 3,
    locked: false,
    visible: true,
    autoLayout: null,
    tokenBinding: null,
    componentId: null,
    points: null,
    closed: false,
    src: null,
    radii: null,
    gradient: null,
    shadow: null,
    blur: 0,
    maskId: null,
    ...overrides,
  };
}

const CONTAINER_TYPES: LayerType[] = ['frame', 'component', 'instance', 'group', 'section'];
const NON_CONTAINER_TYPES: LayerType[] = [
  'rectangle',
  'ellipse',
  'text',
  'line',
  'path',
  'star',
  'polygon',
  'image',
  'boolean_operation',
  'slice',
  'component_set', // NOT in CULLABLE_CONTAINER_TYPES — special border styling
];

// ---- Tests -------------------------------------------------------------------

describe('styleFor L4 culling (Phase 4 §4.2)', () => {
  describe('CULLABLE_CONTAINER_TYPES export', () => {
    it('contains exactly the 5 container types', () => {
      expect(CULLABLE_CONTAINER_TYPES.size).toBe(5);
      for (const t of CONTAINER_TYPES) {
        expect(CULLABLE_CONTAINER_TYPES.has(t)).toBe(true);
      }
    });

    it('excludes non-container types (rectangle/text/line/...)', () => {
      for (const t of NON_CONTAINER_TYPES) {
        expect(CULLABLE_CONTAINER_TYPES.has(t)).toBe(false);
      }
    });
  });

  describe('L4 emission on container types when l4Culling=true', () => {
    for (const type of CONTAINER_TYPES) {
      it(`emits content-visibility/contain/contain-intrinsic-size for ${type}`, () => {
        const layer = makeLayer({ id: `c-${type}`, type, width: 320, height: 240 });
        const style = styleFor(layer, { relX: 0, relY: 0, l4Culling: true });

        expect(style.contentVisibility).toBe('auto');
        expect(style.contain).toBe('layout style paint');
        expect(style.containIntrinsicSize).toBe('320px 240px');
      });
    }

    it('uses layer dimensions in contain-intrinsic-size (not the relX/relY)', () => {
      const layer = makeLayer({ id: 'c-frame', type: 'frame', width: 500, height: 800, x: 100, y: 50 });
      const style = styleFor(layer, { relX: 100, relY: 50, l4Culling: true });
      expect(style.containIntrinsicSize).toBe('500px 800px');
    });

    it('does not break fill emission (frame still paints its background)', () => {
      const layer = makeLayer({ id: 'c-frame', type: 'frame', width: 100, height: 100, fill: '#ff0000' });
      const style = styleFor(layer, { relX: 0, relY: 0, l4Culling: true });
      expect(style.background).toBe('#ff0000');
      expect(style.contentVisibility).toBe('auto');
    });

    it('does not break clip → overflow:hidden emission (frame with clip=true)', () => {
      const layer = makeLayer({ id: 'c-frame', type: 'frame', width: 100, height: 100, clip: true });
      const style = styleFor(layer, { relX: 0, relY: 0, l4Culling: true });
      expect(style.overflow).toBe('hidden');
      expect(style.contentVisibility).toBe('auto');
      expect(style.contain).toBe('layout style paint');
    });

    it('composes with visible:false — emits both visibility:hidden AND L4 styles', () => {
      const layer = makeLayer({ id: 'c-frame', type: 'frame', width: 100, height: 100, visible: false });
      const style = styleFor(layer, { relX: 0, relY: 0, l4Culling: true });
      expect(style.visibility).toBe('hidden');
      expect(style.contentVisibility).toBe('auto');
    });
  });

  describe('L4 emission ABSENT on non-container types', () => {
    for (const type of NON_CONTAINER_TYPES) {
      it(`does NOT emit L4 styles for ${type} even when l4Culling=true`, () => {
        const layer = makeLayer({ id: `n-${type}`, type, width: 100, height: 100 });
        const style = styleFor(layer, { relX: 0, relY: 0, l4Culling: true });
        expect(style.contentVisibility).toBeUndefined();
        expect(style.contain).toBeUndefined();
        expect(style.containIntrinsicSize).toBeUndefined();
      });
    }
  });

  describe('L4 emission ABSENT when l4Culling flag is off', () => {
    it('omits L4 styles when l4Culling is false', () => {
      const layer = makeLayer({ id: 'c-frame', type: 'frame', width: 100, height: 100 });
      const style = styleFor(layer, { relX: 0, relY: 0, l4Culling: false });
      expect(style.contentVisibility).toBeUndefined();
      expect(style.contain).toBeUndefined();
      expect(style.containIntrinsicSize).toBeUndefined();
    });

    it('omits L4 styles when l4Culling is undefined (default parity behavior)', () => {
      const layer = makeLayer({ id: 'c-frame', type: 'frame', width: 100, height: 100 });
      const style = styleFor(layer, { relX: 0, relY: 0 });
      expect(style.contentVisibility).toBeUndefined();
      expect(style.contain).toBeUndefined();
      expect(style.containIntrinsicSize).toBeUndefined();
    });
  });

  describe('L4 emission ABSENT when dimensions are invalid', () => {
    it('omits L4 styles when width=0 (no intrinsic size to skip to)', () => {
      const layer = makeLayer({ id: 'c-frame', type: 'frame', width: 0, height: 100 });
      const style = styleFor(layer, { relX: 0, relY: 0, l4Culling: true });
      expect(style.contentVisibility).toBeUndefined();
      expect(style.containIntrinsicSize).toBeUndefined();
    });

    it('omits L4 styles when height=0', () => {
      const layer = makeLayer({ id: 'c-frame', type: 'frame', width: 100, height: 0 });
      const style = styleFor(layer, { relX: 0, relY: 0, l4Culling: true });
      expect(style.contentVisibility).toBeUndefined();
      expect(style.containIntrinsicSize).toBeUndefined();
    });
  });

  describe('L4 emission composes with native CSS layout mode', () => {
    it('flex container (vertical) still gets L4 styles', () => {
      const layer = makeLayer({ id: 'c-flex', type: 'frame', width: 400, height: 300 });
      const style = styleFor(layer, {
        relX: 0,
        relY: 0,
        l4Culling: true,
        nativeLayout: { direction: 'vertical', gap: 8, padding: 16, justifyContent: 'start', alignItems: 'start' },
      });
      expect(style.display).toBe('flex');
      expect(style.flexDirection).toBe('column');
      expect(style.contentVisibility).toBe('auto');
      expect(style.contain).toBe('layout style paint');
      expect(style.containIntrinsicSize).toBe('400px 300px');
    });

    it('flex container that is ALSO a flow child gets L4 styles + position:relative', () => {
      const layer = makeLayer({ id: 'c-flex-flow', type: 'frame', width: 200, height: 100 });
      const style = styleFor(layer, {
        relX: 0,
        relY: 0,
        l4Culling: true,
        nativeLayout: { direction: 'horizontal', gap: 4 },
        flowChild: { penWidth: 'fit_content', penHeight: 100, parentDirection: 'vertical' },
      });
      expect(style.position).toBe('relative');
      expect(style.contentVisibility).toBe('auto');
      expect(style.containIntrinsicSize).toBe('200px 100px');
    });
  });
});
