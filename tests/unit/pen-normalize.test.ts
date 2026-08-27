// Alias normalizer matrix (spec §10.2 #3 / Appendix G §G.2 + §G.4).
//
// EVERY G.2 row gets a parametrized case: legacy spelling in → canonical
// spelling out. Plus:
//   - strict mode throws on unknown values (no silent defaults),
//   - non-strict mode passes unknown values through (total, never throws),
//   - normalizePenNode dual-carry assertions (legacy kept + v3 populated),
//   - normalizePatchPayload value-level cases (G.4).

import { describe, it, expect } from 'vitest';
import {
  normalizeLayoutMode,
  normalizeAxisAlign,
  normalizeLayoutSizing,
  normalizeLayoutPositioning,
  normalizePaintType,
  normalizeScaleMode,
  normalizeEffectType,
  normalizeTextAutoResize,
  normalizeConstraintsH,
  normalizeConstraintsV,
  normalizeVariableType,
  normalizeBlendMode,
  normalizeAlignKind,
  normalizeTextAlign,
  normalizePenNode,
  normalizePatchPayload,
  gradientAngleToHandles,
} from '@/lib/pen/normalize';
import type { PenChild } from '@/lib/pen/types';

describe('pen-normalize — G.2 alias matrix (parametrized)', () => {
  // [name, fn, legacy input, canonical output]
  const cases: Array<[string, (v: unknown, opts?: { strict?: boolean }) => string, string, string]> = [
    // layout: none/vertical/horizontal → NONE/VERTICAL/HORIZONTAL
    ['layoutMode: none', normalizeLayoutMode, 'none', 'NONE'],
    ['layoutMode: vertical', normalizeLayoutMode, 'vertical', 'VERTICAL'],
    ['layoutMode: horizontal', normalizeLayoutMode, 'horizontal', 'HORIZONTAL'],
    // start/center/end/space_between/space_around → MIN/CENTER/MAX/…
    ['axisAlign: start', normalizeAxisAlign, 'start', 'MIN'],
    ['axisAlign: center', normalizeAxisAlign, 'center', 'CENTER'],
    ['axisAlign: end', normalizeAxisAlign, 'end', 'MAX'],
    ['axisAlign: space_between', normalizeAxisAlign, 'space_between', 'SPACE_BETWEEN'],
    ['axisAlign: space_around', normalizeAxisAlign, 'space_around', 'SPACE_AROUND'],
    // fit_content / fill_container → HUG / FILL
    ['layoutSizing: fit_content', normalizeLayoutSizing, 'fit_content', 'HUG'],
    ['layoutSizing: fill_container', normalizeLayoutSizing, 'fill_container', 'FILL'],
    // auto / absolute → AUTO / ABSOLUTE
    ['layoutPositioning: auto', normalizeLayoutPositioning, 'auto', 'AUTO'],
    ['layoutPositioning: absolute', normalizeLayoutPositioning, 'absolute', 'ABSOLUTE'],
    // linear / radial / angular → GRADIENT_*
    ['paintType: linear', normalizePaintType, 'linear', 'GRADIENT_LINEAR'],
    ['paintType: radial', normalizePaintType, 'radial', 'GRADIENT_RADIAL'],
    ['paintType: angular', normalizePaintType, 'angular', 'GRADIENT_ANGULAR'],
    // stretch / fill / fit (image mode) → STRETCH / FILL / FIT
    ['scaleMode: stretch', normalizeScaleMode, 'stretch', 'STRETCH'],
    ['scaleMode: fill', normalizeScaleMode, 'fill', 'FILL'],
    ['scaleMode: fit', normalizeScaleMode, 'fit', 'FIT'],
    // constraints H: left/right/center/scale/left_right
    ['constraintsH: left', normalizeConstraintsH, 'left', 'LEFT'],
    ['constraintsH: right', normalizeConstraintsH, 'right', 'RIGHT'],
    ['constraintsH: center', normalizeConstraintsH, 'center', 'CENTER'],
    ['constraintsH: scale', normalizeConstraintsH, 'scale', 'SCALE'],
    ['constraintsH: left_right', normalizeConstraintsH, 'left_right', 'LEFT_RIGHT'],
    // constraints V: top/bottom/center/scale/top_bottom
    ['constraintsV: top', normalizeConstraintsV, 'top', 'TOP'],
    ['constraintsV: bottom', normalizeConstraintsV, 'bottom', 'BOTTOM'],
    ['constraintsV: center', normalizeConstraintsV, 'center', 'CENTER'],
    ['constraintsV: scale', normalizeConstraintsV, 'scale', 'SCALE'],
    ['constraintsV: top_bottom', normalizeConstraintsV, 'top_bottom', 'TOP_BOTTOM'],
    // textGrowth: auto / fixed-width / fixed-width-height
    ['textAutoResize: auto', normalizeTextAutoResize, 'auto', 'WIDTH_AND_HEIGHT'],
    ['textAutoResize: fixed-width', normalizeTextAutoResize, 'fixed-width', 'NONE'],
    ['textAutoResize: fixed-width-height', normalizeTextAutoResize, 'fixed-width-height', 'HEIGHT'],
    // alignKind: center_h / center_v / distribute_h / distribute_v
    ['alignKind: center_h', normalizeAlignKind, 'center_h', 'HCENTER'],
    ['alignKind: center_v', normalizeAlignKind, 'center_v', 'VCENTER'],
    ['alignKind: distribute_h', normalizeAlignKind, 'distribute_h', 'DISTRIBUTE_H'],
    ['alignKind: distribute_v', normalizeAlignKind, 'distribute_v', 'DISTRIBUTE_V'],
    // variable type: color/number/string/boolean
    ['variableType: color', normalizeVariableType, 'color', 'COLOR'],
    ['variableType: number', normalizeVariableType, 'number', 'FLOAT'],
    ['variableType: string', normalizeVariableType, 'string', 'STRING'],
    ['variableType: boolean', normalizeVariableType, 'boolean', 'BOOLEAN'],
    // shadowType: inner / outer
    ['effectType: inner', normalizeEffectType, 'inner', 'INNER_SHADOW'],
    ['effectType: outer', normalizeEffectType, 'outer', 'DROP_SHADOW'],
    // blendMode casing (legacy PenBlendMode camelCase members)
    ['blendMode: normal', normalizeBlendMode, 'normal', 'NORMAL'],
    ['blendMode: linearBurn', normalizeBlendMode, 'linearBurn', 'LINEAR_BURN'],
    ['blendMode: softLight', normalizeBlendMode, 'softLight', 'SOFT_LIGHT'],
    ['blendMode: light (documented merge)', normalizeBlendMode, 'light', 'LIGHTEN'],
    // textAlign
    ['textAlign: justify', normalizeTextAlign, 'justify', 'JUSTIFIED'],
  ];

  it.each(cases)('%s → %s', (_name, fn, legacy, canonical) => {
    expect(fn(legacy)).toBe(canonical);
  });

  it('canonical inputs are idempotent (already canonical stays canonical)', () => {
    expect(normalizeLayoutMode('VERTICAL')).toBe('VERTICAL');
    expect(normalizeConstraintsH('LEFT_RIGHT')).toBe('LEFT_RIGHT');
    expect(normalizeVariableType('FLOAT')).toBe('FLOAT');
    expect(normalizeAlignKind('TIDY')).toBe('TIDY');
    expect(normalizeBlendMode('PASS_THROUGH')).toBe('PASS_THROUGH');
  });

  it('unknown values pass through unchanged (total, no throw)', () => {
    expect(normalizeLayoutMode('diagonal')).toBe('diagonal');
    expect(normalizeAlignKind('zigzag')).toBe('zigzag');
    expect(normalizeBlendMode('plaid')).toBe('plaid');
    expect(normalizeConstraintsH('centerX')).toBe('centerX');
  });

  it('strict mode throws on unknown values (no silent defaults)', () => {
    expect(() => normalizeLayoutMode('diagonal', { strict: true })).toThrow(/layoutMode/);
    expect(() => normalizeAlignKind('zigzag', { strict: true })).toThrow(/alignKind/);
    expect(() => normalizeVariableType('tensor', { strict: true })).toThrow(/variableType/);
    // Strict accepts everything known:
    expect(normalizeLayoutMode('none', { strict: true })).toBe('NONE');
    expect(normalizeLayoutMode('NONE', { strict: true })).toBe('NONE');
  });

  it('enabled:false → visible:false surfaces at the node level (G.2 last row)', () => {
    const node = normalizePenNode({ type: 'rectangle', id: 'r1', enabled: false } as PenChild);
    expect((node as any).visible).toBe(false);
    expect((node as any).enabled).toBe(false); // legacy kept
  });
});

describe('pen-normalize — gradient angle → handles (G.1 row 24)', () => {
  // Formula (spec): start=(0.5−cos/2, 0.5−sin/2), end=(0.5+cos/2, 0.5+sin/2).
  it('0° (cos=1, sin=0) spans left→right horizontally', () => {
    const [start, end] = gradientAngleToHandles(0);
    expect(start.x).toBeCloseTo(0);
    expect(start.y).toBeCloseTo(0.5);
    expect(end.x).toBeCloseTo(1);
    expect(end.y).toBeCloseTo(0.5);
  });

  it('90° (cos=0, sin=1) spans top→bottom vertically', () => {
    const [start, end] = gradientAngleToHandles(90);
    expect(start.x).toBeCloseTo(0.5);
    expect(start.y).toBeCloseTo(0);
    expect(end.x).toBeCloseTo(0.5);
    expect(end.y).toBeCloseTo(1);
  });

  it('180° reverses the horizontal direction', () => {
    const [start, end] = gradientAngleToHandles(180);
    expect(start.x).toBeCloseTo(1);
    expect(end.x).toBeCloseTo(0);
    expect(start.y).toBeCloseTo(0.5);
    expect(end.y).toBeCloseTo(0.5);
  });
});

describe('pen-normalize — normalizePenNode (dual-carry)', () => {
  it('populates every v3 field from a fully-legacy node, keeping legacy intact', () => {
    const legacy = {
      type: 'frame',
      id: 'f1',
      layout: 'vertical',
      gap: 8,
      padding: [12, 24],
      justifyContent: 'space_between',
      alignItems: 'center',
      width: 'fit_content',
      height: 'fill_container',
      layoutPosition: 'absolute',
      fill: '#ff0000',
      stroke: '#00ff00',
      strokeWidth: 2,
      effect: { type: 'shadow', shadowType: 'inner', offset: { x: 1, y: 2 }, blur: 3, spread: 4, color: '#000000' },
      cornerRadius: [1, 2, 3, 4],
      enabled: false,
      theme: { mode: 'dark' },
      tokenBinding: { fillToken: 'primary', textToken: 'body' },
      children: [
        { type: 'text', id: 't1', content: 'Hello', textGrowth: 'fixed-width' } as PenChild,
      ],
    } as unknown as PenChild;

    const n = normalizePenNode(legacy) as any;

    // v3 fields populated (G.1 rows 1–7, 15–17, 20–21)
    expect(n.layoutMode).toBe('VERTICAL');
    expect(n.itemSpacing).toBe(8);
    expect(n.paddingTop).toBe(12);
    expect(n.paddingBottom).toBe(12);
    expect(n.paddingLeft).toBe(24);
    expect(n.paddingRight).toBe(24);
    expect(n.primaryAxisAlignItems).toBe('SPACE_BETWEEN');
    expect(n.counterAxisAlignItems).toBe('CENTER');
    expect(n.layoutSizingHorizontal).toBe('HUG');
    expect(n.layoutSizingVertical).toBe('FILL');
    expect(n.layoutPositioning).toBe('ABSOLUTE');
    expect(n.fills).toEqual([{ type: 'SOLID', color: '#ff0000' }]);
    expect(n.strokes).toEqual([{ type: 'SOLID', color: '#00ff00' }]);
    expect(n.strokeWeight).toBe(2);
    expect(n.effects).toMatchObject([
      { type: 'INNER_SHADOW', offset: { x: 1, y: 2 }, radius: 3, spread: 4, color: '#000000' },
    ]);
    expect(n.rectangleCornerRadii).toEqual([1, 2, 3, 4]);
    expect(n.visible).toBe(false);
    expect(n.explicitVariableModes).toEqual({ 'col:mode': 'mode:mode:dark' });
    expect(n.boundVariables).toEqual({
      fills: [{ type: 'VARIABLE_ALIAS', id: 'var:primary' }],
      characters: [{ type: 'VARIABLE_ALIAS', id: 'var:body' }],
    });

    // Legacy fields UNTOUCHED (dual-carry, single object)
    expect(n.layout).toBe('vertical');
    expect(n.gap).toBe(8);
    expect(n.padding).toEqual([12, 24]);
    expect(n.justifyContent).toBe('space_between');
    expect(n.alignItems).toBe('center');
    expect(n.width).toBe('fit_content');
    expect(n.height).toBe('fill_container');
    expect(n.fill).toBe('#ff0000');
    expect(n.cornerRadius).toEqual([1, 2, 3, 4]);
    expect(n.enabled).toBe(false);
    expect(n.theme).toEqual({ mode: 'dark' });
    expect(n.tokenBinding).toEqual({ fillToken: 'primary', textToken: 'body' });

    // Children normalized recursively
    expect(n.children[0].characters).toBe('Hello');
    expect(n.children[0].textAutoResize).toBe('NONE');
    expect(n.children[0].content).toBe('Hello');
    expect(n.children[0].textGrowth).toBe('fixed-width');
  });

  it('gradient fills become typed paint entries with angle-derived handles', () => {
    const legacy = {
      type: 'rectangle',
      id: 'r1',
      fill: {
        type: 'gradient',
        gradientType: 'linear',
        rotation: 90,
        colors: [
          { color: '#ff0000', position: 0 },
          { color: '#0000ff', position: 1 },
        ],
      },
    } as unknown as PenChild;
    const n = normalizePenNode(legacy) as any;
    expect(n.fills).toHaveLength(1);
    expect(n.fills[0].type).toBe('GRADIENT_LINEAR');
    expect(n.fills[0].gradientStops).toEqual([
      { position: 0, color: '#ff0000' },
      { position: 1, color: '#0000ff' },
    ]);
    const [start, end] = n.fills[0].gradientHandlePositions;
    expect(start.x).toBeCloseTo(0.5);
    expect(start.y).toBeCloseTo(0);
    expect(end.x).toBeCloseTo(0.5);
    expect(end.y).toBeCloseTo(1);
  });

  it('image fills become IMAGE paints with scaleMode (G.1 row 10)', () => {
    const legacy = {
      type: 'rectangle',
      id: 'r1',
      fill: { type: 'image', url: './photo.jpg', mode: 'stretch' },
    } as unknown as PenChild;
    const n = normalizePenNode(legacy) as any;
    expect(n.fills[0]).toMatchObject({ type: 'IMAGE', scaleMode: 'STRETCH', imageRef: './photo.jpg' });
  });

  it('ref nodes gain componentId (G.1 row 23)', () => {
    const n = normalizePenNode({ type: 'ref', id: 'i1', ref: 'btn' } as PenChild) as any;
    expect(n.componentId).toBe('btn');
    expect(n.ref).toBe('btn');
  });

  it('is idempotent (normalize² ≡ normalize)', () => {
    const legacy = {
      type: 'frame',
      id: 'f1',
      layout: 'horizontal',
      gap: 4,
      padding: 10,
      justifyContent: 'center',
      fill: '#abc',
      children: [{ type: 'text', id: 't1', content: 'x', textGrowth: 'auto' } as PenChild],
    } as unknown as PenChild;
    expect(normalizePenNode(normalizePenNode(legacy))).toEqual(normalizePenNode(legacy));
  });

  it('v3 fields already present win over re-derived legacy values', () => {
    const node = {
      type: 'frame',
      id: 'f1',
      layout: 'vertical',
      layoutMode: 'HORIZONTAL', // divergent v3 value — kept
      itemSpacing: 99,
      gap: 1,
    } as unknown as PenChild;
    const n = normalizePenNode(node) as any;
    expect(n.layoutMode).toBe('HORIZONTAL');
    expect(n.itemSpacing).toBe(99);
  });

  it('never throws on malformed nodes', () => {
    expect(normalizePenNode({} as PenChild)).toEqual({});
    expect(normalizePenNode(null as unknown as PenChild)).toBe(null);
    expect(normalizePenNode({ type: 'frame', id: 'x', children: 'not-an-array' } as any)).toBeTruthy();
  });
});

describe('pen-normalize — normalizePatchPayload (G.4)', () => {
  it('alignKind values canonicalize (legacy → canonical)', () => {
    const p = normalizePatchPayload({ op: 'align', alignKind: 'center_h' });
    expect(p.alignKind).toBe('HCENTER');
    const p2 = normalizePatchPayload({ op: 'align', alignKind: 'distribute_v' });
    expect(p2.alignKind).toBe('DISTRIBUTE_V');
    const p3 = normalizePatchPayload({ op: 'align', alignKind: 'TIDY' });
    expect(p3.alignKind).toBe('TIDY');
  });

  it('alignKind unknown values pass through', () => {
    const p = normalizePatchPayload({ op: 'align', alignKind: 'weird' });
    expect(p.alignKind).toBe('weird');
  });

  it('constraints accept BOTH casings; stored spelling stays legacy', () => {
    // canonical input accepted → stored legacy
    const p = normalizePatchPayload({
      op: 'set_constraints',
      constraints: { horizontal: 'LEFT_RIGHT', vertical: 'TOP_BOTTOM' },
    });
    expect(p.constraints).toEqual({ horizontal: 'left_right', vertical: 'top_bottom' });

    // legacy input unchanged
    const p2 = normalizePatchPayload({
      op: 'set_constraints',
      constraints: { horizontal: 'left', vertical: 'center' },
    });
    expect(p2.constraints).toEqual({ horizontal: 'left', vertical: 'center' });

    // mixed casing handled per-value
    const p3 = normalizePatchPayload({
      op: 'set_constraints',
      constraints: { horizontal: 'RIGHT', vertical: 'scale' },
    });
    expect(p3.constraints).toEqual({ horizontal: 'right', vertical: 'scale' });
  });

  it('variableType accepts canonical spellings, stores legacy', () => {
    expect(normalizePatchPayload({ op: 'set_variable', variableType: 'COLOR' }).variableType).toBe('color');
    expect(normalizePatchPayload({ op: 'set_variable', variableType: 'FLOAT' }).variableType).toBe('number');
    expect(normalizePatchPayload({ op: 'set_variable', variableType: 'boolean' }).variableType).toBe('boolean');
  });

  it('patch field NAMES stay frozen (shapeId/shapeIds untouched)', () => {
    const p = normalizePatchPayload({ op: 'update', shapeId: 'a', shapeIds: ['a', 'b'], summary: 's' });
    expect(p.shapeId).toBe('a');
    expect(p.shapeIds).toEqual(['a', 'b']);
    expect(p.summary).toBe('s');
  });

  it('themeAxis semantics untouched', () => {
    const p = normalizePatchPayload({ op: 'set_theme_axis', themeAxis: 'mode', themeValues: ['light', 'dark'] });
    expect(p.themeAxis).toBe('mode');
    expect(p.themeValues).toEqual(['light', 'dark']);
  });

  it('is pure: the input patch object is not mutated', () => {
    const input = { op: 'align' as const, alignKind: 'left' as const };
    normalizePatchPayload(input);
    expect(input.alignKind).toBe('left');
  });
});
