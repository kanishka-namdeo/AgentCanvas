// styleFor — native CSS layout mode (spec §3.4, Phase 2) unit tests.
//
// Pure-function coverage (jsdom-safe, no rendering):
//   - flexChildStyle sizing matrix: fixed / fit_content / fit_content(n) /
//     fill_container / unspecified × vertical / horizontal parents
//   - styleFor nativeLayout container CSS: direction / gap / padding
//     (1-number, [v,h], [t,r,b,l]) / justifyContent / alignItems mapping
//   - styleFor flowChild: no left/top/position; flex-item sizing applied
//   - flex container that is ALSO a flow child gets position:relative anchor
//   - cssVariablesFor: flat values, themed values, key sanitization
//   - tokenBinding → var(--acv-…, resolvedFallback) emission (fill/text/stroke)
//   - parity regression: absent nativeLayout/flowChild opts → absolute box

import { describe, it, expect } from 'vitest';
import { styleFor, flexChildStyle, nativeLayoutOptsFor, expandPadding } from '@/components/canvas/dom/styleFor';
import { cssVariablesFor, sanitizeVarKey, worldThemeAttr } from '@/components/canvas/dom/variables';
import type { Layer } from '@/lib/canvas/types';
import type { CanvasDocument } from '@/lib/canvas/types';
import type { PenChild, PenFrame } from '@/lib/pen/types';

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

function makePen(overrides: Partial<PenFrame> = {}): PenFrame {
  return {
    id: 'pen-frame',
    type: 'frame',
    x: 0,
    y: 0,
    ...overrides,
  };
}

function makeDoc(variables?: CanvasDocument['variables']): CanvasDocument {
  return {
    id: 'test-doc',
    name: 'Test',
    version: '2.17',
    background: '#ffffff',
    children: [],
    viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes: [],
    tokens: { colors: [], textStyles: [] },
    ...(variables ? { variables } : {}),
  };
}

// ---- flexChildStyle: the sizing matrix (spec §3.4 table) ----------------------

describe('flexChildStyle — .pen sizing modes → CSS flex-item rules', () => {
  it('fixed number sizes both dimensions explicitly (vertical parent)', () => {
    const s = flexChildStyle(120, 40, 'vertical');
    expect(s.width).toBe('120px');
    expect(s.height).toBe('40px');
    expect(s.flexGrow).toBeUndefined();
    expect(s.alignSelf).toBeUndefined();
  });

  it('fixed number sizes both dimensions explicitly (horizontal parent)', () => {
    const s = flexChildStyle(120, 40, 'horizontal');
    expect(s.width).toBe('120px');
    expect(s.height).toBe('40px');
  });

  it('fit_content: main axis flex 0 0 auto (longhands), cross axis alignSelf auto, dimension omitted', () => {
    // Vertical parent → main axis is HEIGHT.
    const s = flexChildStyle('fit_content', 'fit_content', 'vertical');
    expect(s.width).toBeUndefined();
    expect(s.height).toBeUndefined();
    // ≡ flex: 0 0 auto (longhands — see flexChildStyle header note).
    expect(s.flexGrow).toBe(0);
    expect(s.flexShrink).toBe(0);
    expect(s.flexBasis).toBe('auto');
    expect(s.alignSelf).toBe('auto');
  });

  it('fit_content on horizontal parent: same rules, dimensions omitted', () => {
    const s = flexChildStyle('fit_content', 'fit_content', 'horizontal');
    expect(s.width).toBeUndefined();
    expect(s.height).toBeUndefined();
    expect(s.flexGrow).toBe(0);
    expect(s.flexShrink).toBe(0);
    expect(s.flexBasis).toBe('auto');
    expect(s.alignSelf).toBe('auto');
  });

  it('fit_content(80) parses the paren fallback into min-width/min-height', () => {
    const s = flexChildStyle('fit_content(80)', 'fit_content(24)', 'vertical');
    expect(s.minWidth).toBe('80px');
    expect(s.minHeight).toBe('24px');
    expect(s.width).toBeUndefined();
    expect(s.height).toBeUndefined();
  });

  it('unparseable paren fallback degrades to plain auto', () => {
    const s = flexChildStyle('fit_content(abc)', 'fit_content', 'vertical');
    expect(s.minWidth).toBeUndefined();
    expect(s.minHeight).toBeUndefined();
    expect(s.flexGrow).toBe(0);
  });

  it('fill_container on vertical parent: height grows (flex 1 1 0 longhands), width stretches', () => {
    const s = flexChildStyle('fill_container', 'fill_container', 'vertical');
    // ≡ flex: 1 1 0 on the main axis (height).
    expect(s.flexGrow).toBe(1);
    expect(s.flexShrink).toBe(1);
    expect(s.flexBasis).toBe(0);
    expect(s.alignSelf).toBe('stretch'); // cross axis = width
    expect(s.width).toBeUndefined();
    expect(s.height).toBeUndefined();
  });

  it('fill_container on horizontal parent: width grows (flex 1 1 0 longhands), height stretches', () => {
    const s = flexChildStyle('fill_container', 'fill_container', 'horizontal');
    expect(s.flexGrow).toBe(1);
    expect(s.flexShrink).toBe(1);
    expect(s.flexBasis).toBe(0);
    expect(s.alignSelf).toBe('stretch'); // cross axis = height
  });

  it('mixed sizing: fixed width + fill_container height in a vertical parent', () => {
    const s = flexChildStyle(200, 'fill_container', 'vertical');
    expect(s.width).toBe('200px'); // cross axis fixed
    expect(s.height).toBeUndefined();
    expect(s.flexGrow).toBe(1); // main axis fills
    expect(s.flexShrink).toBe(1);
    expect(s.flexBasis).toBe(0);
    expect(s.alignSelf).toBeUndefined();
  });

  it('mixed sizing: fit_content width + fixed height in a horizontal parent', () => {
    const s = flexChildStyle('fit_content', 30, 'horizontal');
    expect(s.width).toBeUndefined();
    expect(s.height).toBe('30px');
    expect(s.flexGrow).toBe(0); // main axis = width hugs
    expect(s.flexShrink).toBe(0);
    expect(s.flexBasis).toBe('auto');
    expect(s.alignSelf).toBeUndefined();
  });

  it('unspecified / unresolvable ($variable) sizes degrade to auto', () => {
    const s = flexChildStyle(undefined, '$spacing.height', 'vertical');
    expect(s.width).toBeUndefined();
    expect(s.height).toBeUndefined();
    expect(s.flexGrow).toBe(0);
    expect(s.flexShrink).toBe(0);
    expect(s.flexBasis).toBe('auto');
    expect(s.alignSelf).toBe('auto');
  });

  it('numeric strings coerce to fixed px', () => {
    const s = flexChildStyle('160', '40', 'vertical');
    expect(s.width).toBe('160px');
    expect(s.height).toBe('40px');
  });
});

// ---- nativeLayoutOptsFor + expandPadding --------------------------------------

describe('nativeLayoutOptsFor — .pen layout fields → container options', () => {
  it('returns null for non-flex nodes (layout none / undefined / wrong type)', () => {
    expect(nativeLayoutOptsFor(makePen())).toBeNull();
    expect(nativeLayoutOptsFor(makePen({ layout: 'none' }))).toBeNull();
    expect(nativeLayoutOptsFor(undefined)).toBeNull();
    expect(nativeLayoutOptsFor({ id: 't', type: 'text', content: 'x' } as PenChild)).toBeNull();
  });

  it('derives direction + gap from a vertical layout node', () => {
    const opts = nativeLayoutOptsFor(makePen({ layout: 'vertical', gap: 12 }));
    expect(opts).toEqual({ direction: 'vertical', gap: 12, padding: undefined, justifyContent: undefined, alignItems: undefined });
  });

  it('derives horizontal direction and defaults gap to 0', () => {
    const opts = nativeLayoutOptsFor(makePen({ layout: 'horizontal' }));
    expect(opts!.direction).toBe('horizontal');
    expect(opts!.gap).toBe(0);
  });

  it('expandPadding: 1 number → all four sides', () => {
    expect(expandPadding(8)).toEqual({ top: 8, right: 8, bottom: 8, left: 8 });
  });

  it('expandPadding: [v,h] 2-tuple → vertical/horizontal', () => {
    expect(expandPadding([10, 20])).toEqual({ top: 10, right: 20, bottom: 10, left: 20 });
  });

  it('expandPadding: [t,r,b,l] 4-tuple → per-side', () => {
    expect(expandPadding([1, 2, 3, 4])).toEqual({ top: 1, right: 2, bottom: 3, left: 4 });
  });

  it('expandPadding: undefined / junk → zeros (coercion-safe)', () => {
    expect(expandPadding(undefined)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(expandPadding(null as unknown as undefined)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });
});

// ---- styleFor nativeLayout container CSS --------------------------------------

describe('styleFor — nativeLayout flex container CSS (§3.4 table)', () => {
  it('emits display flex + column direction + gap + padding for a vertical container', () => {
    const s = styleFor(makeLayer({ type: 'frame' }), {
      relX: 10,
      relY: 20,
      nativeLayout: { direction: 'vertical', gap: 8, padding: 12 },
    });
    expect(s.display).toBe('flex');
    expect(s.flexDirection).toBe('column');
    expect(s.gap).toBe('8px');
    expect(s.padding).toBe('12px 12px 12px 12px');
    // Absolute container keeps resolver geometry (it is not a flow child).
    expect(s.position).toBe('absolute');
    expect(s.left).toBe('10px');
    expect(s.top).toBe('20px');
    expect(s.width).toBe('100px');
    expect(s.height).toBe('50px');
  });

  it('emits row direction for horizontal containers', () => {
    const s = styleFor(makeLayer({ type: 'frame' }), {
      relX: 0,
      relY: 0,
      nativeLayout: { direction: 'horizontal', gap: 0 },
    });
    expect(s.flexDirection).toBe('row');
  });

  it('expands [v,h] padding to "vpx hpx vpx hpx"', () => {
    const s = styleFor(makeLayer({ type: 'frame' }), {
      relX: 0,
      relY: 0,
      nativeLayout: { direction: 'vertical', gap: 0, padding: [6, 14] },
    });
    expect(s.padding).toBe('6px 14px 6px 14px');
  });

  it('expands [t,r,b,l] padding per-side', () => {
    const s = styleFor(makeLayer({ type: 'frame' }), {
      relX: 0,
      relY: 0,
      nativeLayout: { direction: 'vertical', gap: 0, padding: [1, 2, 3, 4] },
    });
    expect(s.padding).toBe('1px 2px 3px 4px');
  });

  it('maps justifyContent start/center/end/space_between/space_around (undefined → flex-start)', () => {
    const j = (justifyContent?: string) =>
      styleFor(makeLayer({ type: 'frame' }), {
        relX: 0,
        relY: 0,
        nativeLayout: { direction: 'vertical', gap: 0, justifyContent },
      }).justifyContent;
    expect(j()).toBe('flex-start');
    expect(j('start')).toBe('flex-start');
    expect(j('center')).toBe('center');
    expect(j('end')).toBe('flex-end');
    expect(j('space_between')).toBe('space-between');
    expect(j('space_around')).toBe('space-around');
  });

  it('maps alignItems start/center/end (absent → omitted)', () => {
    const a = (alignItems?: string) =>
      styleFor(makeLayer({ type: 'frame' }), {
        relX: 0,
        relY: 0,
        nativeLayout: { direction: 'vertical', gap: 0, alignItems },
      }).alignItems;
    expect(a()).toBeUndefined();
    expect(a('start')).toBe('flex-start');
    expect(a('center')).toBe('center');
    expect(a('end')).toBe('flex-end');
  });

  it('keeps paint styles identical to parity (fill/radius/border survive)', () => {
    const layer = makeLayer({ type: 'frame', fill: '#00ff00', radius: 6, strokeWidth: 2, stroke: '#123456' });
    const native = styleFor(layer, {
      relX: 0,
      relY: 0,
      nativeLayout: { direction: 'vertical', gap: 4 },
    });
    const parity = styleFor(layer, { relX: 0, relY: 0 });
    expect(native.background).toBe(parity.background);
    expect(native.borderRadius).toBe(parity.borderRadius);
    expect(native.border).toBe(parity.border);
    expect(native.zIndex).toBe(parity.zIndex);
  });
});

// ---- styleFor flowChild --------------------------------------------------------

describe('styleFor — flowChild flex-item geometry', () => {
  it('omits position/left/top/width/height and applies flexChildStyle', () => {
    const s = styleFor(makeLayer(), {
      relX: 10,
      relY: 20,
      flowChild: { penWidth: 111, penHeight: 'fill_container', parentDirection: 'vertical' },
    });
    expect(s.position).toBeUndefined();
    expect(s.left).toBeUndefined();
    expect(s.top).toBeUndefined();
    expect(s.width).toBe('111px');
    expect(s.height).toBeUndefined();
    // ≡ flex: 1 1 0 (main axis).
    expect(s.flexGrow).toBe(1);
    expect(s.flexShrink).toBe(1);
    expect(s.flexBasis).toBe(0);
  });

  it('flex container that is ALSO a flow child anchors absolute children (position: relative)', () => {
    const s = styleFor(makeLayer({ type: 'frame' }), {
      relX: 10,
      relY: 20,
      nativeLayout: { direction: 'vertical', gap: 8 },
      flowChild: { penWidth: 'fill_container', penHeight: 'fit_content', parentDirection: 'vertical' },
    });
    expect(s.display).toBe('flex');
    expect(s.flexDirection).toBe('column');
    expect(s.position).toBe('relative'); // anchor for layoutPosition:absolute children
    expect(s.left).toBeUndefined();
    // fit_content height (main axis) ≡ flex: 0 0 auto.
    expect(s.flexGrow).toBe(0);
    expect(s.flexShrink).toBe(0);
    expect(s.flexBasis).toBe('auto');
    expect(s.alignSelf).toBe('stretch'); // fill_container width (cross axis)
  });
});

// ---- Parity regression: absent native opts = Phase-1 output -------------------

describe('styleFor — parity regression (no native opts)', () => {
  it('emits the absolute box exactly as Phase 1 when neither opt is passed', () => {
    const s = styleFor(makeLayer(), { relX: 10, relY: 20 });
    expect(s.position).toBe('absolute');
    expect(s.left).toBe('10px');
    expect(s.top).toBe('20px');
    expect(s.width).toBe('100px');
    expect(s.height).toBe('50px');
    expect(s.display).toBeUndefined();
    expect(s.flexDirection).toBeUndefined();
    expect(s.gap).toBeUndefined();
  });
});

// ---- cssVariablesFor (spec §3.6) ------------------------------------------------

describe('cssVariablesFor — document variables → CSS custom properties', () => {
  it('publishes flat variables as --acv-<sanitized-key> with resolved values', () => {
    const doc = makeDoc({
      'color.primary': { type: 'color', value: '#0ea5e9' },
      'spacing.md': { type: 'number', value: 16 },
    });
    const vars = cssVariablesFor(doc) as Record<string, string>;
    expect(vars['--acv-color-primary']).toBe('#0ea5e9');
    expect(vars['--acv-spacing-md']).toBe('16');
    expect(Object.keys(vars)).toHaveLength(2);
  });

  it('sanitizes keys: non-[a-zA-Z0-9-] become dashes', () => {
    expect(sanitizeVarKey('color.primary')).toBe('color-primary');
    expect(sanitizeVarKey('brand/accent_1!')).toBe('brand-accent-1-');
    expect(sanitizeVarKey('plain')).toBe('plain');
  });

  it('resolves themed values under the document-default theme (first value wins)', () => {
    const doc = makeDoc({
      'surface.bg': {
        type: 'color',
        value: [
          { value: '#ffffff', theme: { mode: 'light' } },
          { value: '#0f172a', theme: { mode: 'dark' } },
        ],
      },
    });
    const vars = cssVariablesFor(doc) as Record<string, string>;
    // Document-default theme is empty → the default (first) value publishes.
    expect(vars['--acv-surface-bg']).toBe('#ffffff');
  });

  it('skips missing/undefined values and empty documents', () => {
    expect(cssVariablesFor(makeDoc())).toEqual({});
    expect(cssVariablesFor(makeDoc(undefined))).toEqual({});
    const doc = makeDoc({ 'bad.var': { type: 'color', value: undefined as unknown as string } });
    // resolveThemedValue returns undefined → skipped.
    expect(cssVariablesFor(doc)).toEqual({});
  });

  it('worldThemeAttr publishes the documented default sentinel', () => {
    expect(worldThemeAttr(makeDoc())).toBe('default');
  });
});

// ---- tokenBinding → var() emission (spec §3.6) -----------------------------------

describe('styleFor — tokenBinding → var(--acv-…, fallback) emission', () => {
  it('fillToken emits background var() with the resolver-resolved fallback', () => {
    const s = styleFor(makeLayer({ fill: '#0ea5e9', tokenBinding: { fillToken: 'color.primary' } }), { relX: 0, relY: 0 });
    expect(s.background).toBe('var(--acv-color-primary, #0ea5e9)');
  });

  it('textToken emits color var() with the resolved text color fallback', () => {
    const s = styleFor(makeLayer({ type: 'text', text: 'Hi', textColor: '#0f172a', tokenBinding: { textToken: 'text.heading' } }), { relX: 0, relY: 0 });
    expect(s.color).toBe('var(--acv-text-heading, #0f172a)');
  });

  it('strokeToken emits border-color var() on stroked nodes', () => {
    const s = styleFor(makeLayer({ strokeWidth: 2, stroke: '#334155', tokenBinding: { strokeToken: 'border.default' } }), { relX: 0, relY: 0 });
    expect(s.border).toBe('2px solid var(--acv-border-default, #334155)');
  });

  it('unbound nodes keep today’s exact output (no var() wrapper)', () => {
    const s = styleFor(makeLayer({ fill: '#0ea5e9' }), { relX: 0, relY: 0 });
    expect(s.background).toBe('#0ea5e9');
    const t = styleFor(makeLayer({ type: 'text', text: 'Hi', textColor: '#000000' }), { relX: 0, relY: 0 });
    expect(t.color).toBe('#000000');
  });

  it('token binding survives native layout mode (paint is mode-independent)', () => {
    const s = styleFor(makeLayer({ fill: '#0ea5e9', tokenBinding: { fillToken: 'color.primary' } }), {
      relX: 0,
      relY: 0,
      nativeLayout: { direction: 'vertical', gap: 0 },
      flowChild: { penWidth: 50, penHeight: 50, parentDirection: 'vertical' },
    });
    expect(s.background).toBe('var(--acv-color-primary, #0ea5e9)');
    expect(s.width).toBe('50px');
  });
});
