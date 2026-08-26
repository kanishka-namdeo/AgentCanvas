// Tests for the DOM renderer's DomNode component (spec Phase 1).
//
// DOM renderer test suite — covers the per-shape type cases that the legacy
// SVG ShapeRenderer test suite used to cover, ported to the DOM data-attribute
// contract. Render
// DomNode directly (no store, no Canvas shell) and assert the emitted inline
// styles + data-attribute contract (spec Appendix C). Parity mode uses inline
// styles only, so jsdom's CSSOM is sufficient — no layout engine needed.
//
// Covered:
//   - data-node-id / data-node-type / data-instance-of contract
//   - rectangle/frame: fill→background, radius, border (stroke)
//   - per-corner radii (4-value border-radius string)
//   - gradient backgrounds (linear with angle+90 conversion, radial)
//   - shadow → boxShadow (non-text) and textShadow (text)
//   - blur → filter
//   - opacity / rotation (D4 fix) / clip → overflow hidden
//   - ellipse → border-radius: 50%
//   - text typography (color, fontSize, fontWeight, fontFamily, letterSpacing,
//     lineHeight, textAlign, textDecoration) + text content
//   - visible:false → visibility:hidden with the subtree STILL MOUNTED
//   - image → <img> content
//   - line → rotated pill (width=hypot, height=max(2,strokeWidth))
//   - path/star/polygon → SVG islands
//   - section label chip, slice overlay, boolean_operation op symbol
//   - nested children render inside the parent div with relative offsets

import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { DomNode } from '@/components/canvas/dom/DomNode';
import type { Layer, LayerType } from '@/lib/canvas/types';

// ---- Helpers -----------------------------------------------------------------

function makeLayer(overrides: Partial<Layer> = {}): Layer {
  return {
    id: overrides.id ?? 'test-layer',
    type: overrides.type ?? 'rectangle',
    name: overrides.name ?? 'Test',
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    width: overrides.width ?? 100,
    height: overrides.height ?? 100,
    rotation: overrides.rotation ?? 0,
    opacity: overrides.opacity ?? 1,
    fill: overrides.fill ?? '#cccccc',
    stroke: overrides.stroke ?? '#000000',
    strokeWidth: overrides.strokeWidth ?? 0,
    radius: overrides.radius ?? 0,
    text: overrides.text,
    fontSize: overrides.fontSize ?? 16,
    textColor: overrides.textColor ?? '#000000',
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
    ...overrides,
  };
}

const noopMouseDown = vi.fn();
const noopHover = vi.fn();
const getChildren = vi.fn(() => [] as Layer[]);

function renderNode(layer: Layer, childLayers: Layer[] = [], parentX = 0, parentY = 0) {
  return render(
    <DomNode
      layer={layer}
      childLayers={childLayers}
      parentX={parentX}
      parentY={parentY}
      getChildren={getChildren}
      onShapeMouseDown={noopMouseDown}
      onHover={noopHover}
    />,
  );
}

function nodeEl(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[data-node-id]');
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

// ---- Data-attribute contract (Appendix C) --------------------------------------

describe('DomNode: data-attribute contract', () => {
  it('carries data-node-id and data-node-type', () => {
    const { container } = renderNode(makeLayer({ id: 'r1', type: 'rectangle' }));
    const el = nodeEl(container);
    expect(el.getAttribute('data-node-id')).toBe('r1');
    expect(el.getAttribute('data-node-type')).toBe('rectangle');
  });

  it('carries data-instance-of on instance layers, absent otherwise', () => {
    const { container: cInst } = renderNode(
      makeLayer({ id: 'i1', type: 'instance', componentId: 'master-1' }),
    );
    expect(nodeEl(cInst).getAttribute('data-instance-of')).toBe('master-1');

    const { container: cRect } = renderNode(
      makeLayer({ id: 'r1', componentId: 'r1' }), // componentId === id → master, not instance
    );
    expect(nodeEl(cRect).getAttribute('data-instance-of')).toBeNull();

    const { container: cPlain } = renderNode(makeLayer({ id: 'r2' }));
    expect(nodeEl(cPlain).getAttribute('data-instance-of')).toBeNull();
  });
});

// ---- Base geometry --------------------------------------------------------------

describe('DomNode: base geometry', () => {
  it('positions absolutely with relative offsets and layer size/zIndex', () => {
    const { container } = renderNode(
      makeLayer({ x: 130, y: 70, width: 40, height: 25, zIndex: 7 }),
      [],
      30, // parent abs x
      20, // parent abs y
    );
    const el = nodeEl(container);
    expect(el.style.position).toBe('absolute');
    expect(el.style.left).toBe('100px'); // 130 - 30
    expect(el.style.top).toBe('50px'); // 70 - 20
    expect(el.style.width).toBe('40px');
    expect(el.style.height).toBe('25px');
    expect(el.style.zIndex).toBe('7');
    expect(el.style.boxSizing).toBe('border-box');
    expect(el.style.pointerEvents).toBe('auto');
    expect(el.style.cursor).toBe('move');
  });

  it('nests child nodes inside the parent div with parent-relative offsets', () => {
    const parent = makeLayer({ id: 'p', type: 'frame', x: 200, y: 100 });
    const child = makeLayer({ id: 'c', type: 'rectangle', x: 250, y: 130, parentId: 'p' });
    const { container } = renderNode(parent, [child]);
    const parentEl = container.querySelector('[data-node-id="p"]') as HTMLElement;
    const childEl = parentEl.querySelector('[data-node-id="c"]') as HTMLElement;
    expect(childEl).not.toBeNull();
    expect(childEl.style.left).toBe('50px'); // 250 - 200
    expect(childEl.style.top).toBe('30px'); // 130 - 100
  });
});

// ---- Fill / stroke / radius ------------------------------------------------------

describe('DomNode: fill, stroke, radius', () => {
  it('maps solid fill to background', () => {
    const { container } = renderNode(makeLayer({ fill: '#ff0000' }));
    expect(nodeEl(container).style.background).toBe('rgb(255, 0, 0)');
  });

  it('keeps transparent fill transparent', () => {
    const { container } = renderNode(makeLayer({ fill: 'transparent' }));
    expect(nodeEl(container).style.background).toBe('transparent');
  });

  it('maps strokeWidth + stroke to a border', () => {
    const { container } = renderNode(makeLayer({ stroke: '#00ff00', strokeWidth: 2 }));
    expect(nodeEl(container).style.border).toBe('2px solid rgb(0, 255, 0)');
  });

  it('emits no border when strokeWidth is 0', () => {
    const { container } = renderNode(makeLayer({ strokeWidth: 0 }));
    expect(nodeEl(container).style.border).toBe('');
  });

  it('maps uniform radius to border-radius', () => {
    const { container } = renderNode(makeLayer({ radius: 12 }));
    expect(nodeEl(container).style.borderRadius).toBe('12px');
  });

  it('maps per-corner radii to a 4-value border-radius string', () => {
    const { container } = renderNode(
      makeLayer({ radii: { topLeft: 4, topRight: 8, bottomRight: 12, bottomLeft: 16 } }),
    );
    expect(nodeEl(container).style.borderRadius).toBe('4px 8px 12px 16px');
  });

  it('ellipse renders with border-radius: 50% (ignores radius fields)', () => {
    const { container } = renderNode(makeLayer({ type: 'ellipse', radius: 10 }));
    expect(nodeEl(container).style.borderRadius).toBe('50%');
  });
});

// ---- Gradients --------------------------------------------------------------------

describe('DomNode: gradient fill', () => {
  it('emits a linear-gradient with the angle converted to CSS convention (+90)', () => {
    // .pen angle 0 points right; CSS 0deg points up → cssAngle 90.
    const { container } = renderNode(
      makeLayer({
        gradient: {
          type: 'linear',
          angle: 0,
          stops: [
            { offset: 0, color: '#ff0000' },
            { offset: 1, color: '#0000ff' },
          ],
        },
      }),
    );
    const bg = nodeEl(container).style.background;
    expect(bg).toContain('linear-gradient(90deg');
    expect(bg).toContain('rgb(255, 0, 0) 0%');
    expect(bg).toContain('rgb(0, 0, 255) 100%');
  });

  it('emits a radial-gradient(circle, …) for radial fills', () => {
    const { container } = renderNode(
      makeLayer({
        gradient: {
          type: 'radial',
          angle: 45,
          stops: [
            { offset: 0, color: '#ffffff' },
            { offset: 1, color: '#000000' },
          ],
        },
      }),
    );
    const bg = nodeEl(container).style.background;
    expect(bg).toContain('radial-gradient(circle');
    expect(bg).toContain('rgb(255, 255, 255) 0%');
    expect(bg).toContain('rgb(0, 0, 0) 100%');
  });
});

// ---- Effects ------------------------------------------------------------------------

describe('DomNode: effects', () => {
  it('maps shadow to box-shadow with spread defaulting to 0', () => {
    const { container } = renderNode(
      makeLayer({ shadow: { x: 2, y: 4, blur: 8, color: '#112233' } }),
    );
    expect(nodeEl(container).style.boxShadow).toBe('2px 4px 8px 0px #112233');
  });

  it('includes spread + inset in box-shadow when set', () => {
    const { container } = renderNode(
      makeLayer({ shadow: { x: 1, y: 2, blur: 3, spread: 4, color: '#000', inset: true } }),
    );
    expect(nodeEl(container).style.boxShadow).toBe('1px 2px 3px 4px #000 inset');
  });

  it('maps shadow to text-shadow on text layers', () => {
    const { container } = renderNode(
      makeLayer({ type: 'text', text: 'Hi', shadow: { x: 1, y: 2, blur: 3, color: '#333' } }),
    );
    expect(nodeEl(container).style.textShadow).toBe('1px 2px 3px #333');
    expect(nodeEl(container).style.boxShadow).toBe('');
  });

  it('maps blur to filter: blur(Npx) only when blur > 0', () => {
    const { container: cBlur } = renderNode(makeLayer({ blur: 5 }));
    expect(nodeEl(cBlur).style.filter).toBe('blur(5px)');
    const { container: cNone } = renderNode(makeLayer({ blur: 0 }));
    expect(nodeEl(cNone).style.filter).toBe('');
  });

  it('emits opacity only when !== 1', () => {
    const { container: cHalf } = renderNode(makeLayer({ opacity: 0.5 }));
    expect(nodeEl(cHalf).style.opacity).toBe('0.5');
    const { container: cFull } = renderNode(makeLayer({ opacity: 1 }));
    expect(nodeEl(cFull).style.opacity).toBe('');
  });

  it('renders rotation on-screen (D4 fix): rotate(deg) with 0 0 origin', () => {
    const { container } = renderNode(makeLayer({ rotation: 30 }));
    const el = nodeEl(container);
    expect(el.style.transform).toBe('rotate(30deg)');
    expect(el.style.transformOrigin).toBe('0 0');
  });

  it('emits no transform when rotation is 0', () => {
    const { container } = renderNode(makeLayer({ rotation: 0 }));
    expect(nodeEl(container).style.transform).toBe('');
  });

  it('clip: true on a frame → overflow hidden', () => {
    const { container: cClip } = renderNode(makeLayer({ type: 'frame', clip: true }));
    expect(nodeEl(cClip).style.overflow).toBe('hidden');
    const { container: cOpen } = renderNode(makeLayer({ type: 'frame', clip: false }));
    expect(nodeEl(cOpen).style.overflow).toBe('');
  });
});

// ---- Text -----------------------------------------------------------------------------

describe('DomNode: text', () => {
  it('renders text content with full typography', () => {
    const { container } = renderNode(
      makeLayer({
        id: 't1',
        type: 'text',
        text: 'Hello world',
        fontSize: 24,
        textColor: '#00ff00',
        fontWeight: 600,
        fontFamily: 'Roboto',
        letterSpacing: 1.5,
        lineHeight: 1.4,
        textAlign: 'center',
        underline: true,
        strikethrough: true,
      }),
    );
    const el = nodeEl(container);
    expect(el.textContent).toBe('Hello world');
    expect(el.style.color).toBe('rgb(0, 255, 0)');
    expect(el.style.fontSize).toBe('24px');
    expect(el.style.fontWeight).toBe('600');
    expect(el.style.fontFamily).toBe('Roboto, var(--font-inter), system-ui, sans-serif');
    expect(el.style.letterSpacing).toBe('1.5px');
    expect(el.style.lineHeight).toBe('1.4');
    expect(el.style.textAlign).toBe('center');
    expect(el.style.textDecoration).toContain('underline');
    expect(el.style.textDecoration).toContain('line-through');
    expect(el.style.whiteSpace).toBe('pre-wrap');
  });

  it('falls back to default font family + weight 400 + no decoration', () => {
    const { container } = renderNode(makeLayer({ type: 'text', text: 'x' }));
    const el = nodeEl(container);
    expect(el.style.fontFamily).toBe('var(--font-inter), Inter, system-ui, sans-serif');
    expect(el.style.fontWeight).toBe('400');
    expect(el.style.textDecoration).toBe('');
  });

  it('does not paint layer.fill as background on text (SVG parity)', () => {
    const { container } = renderNode(makeLayer({ type: 'text', text: 'x', fill: '#ff0000' }));
    expect(nodeEl(container).style.background).toBe('');
  });
});

// ---- Visibility (documented divergence) ---------------------------------------------------

describe('DomNode: visibility', () => {
  it('visible:false → visibility:hidden, subtree stays mounted', () => {
    const hidden = makeLayer({ id: 'hidden-parent', type: 'frame', visible: false });
    const child = makeLayer({ id: 'visible-child', type: 'rectangle', parentId: 'hidden-parent' });
    const { container } = renderNode(hidden, [child]);
    const el = nodeEl(container);
    expect(el.style.visibility).toBe('hidden');
    // The child is STILL in the DOM (SVG mode would unmount the whole subtree).
    const childEl = el.querySelector('[data-node-id="visible-child"]');
    expect(childEl).not.toBeNull();
  });
});

// ---- Image -------------------------------------------------------------------------------

describe('DomNode: image', () => {
  it('renders an <img> with cover fit and no pointer events', () => {
    const { container } = renderNode(
      makeLayer({ type: 'image', src: 'https://example.com/p.png', radius: 8 }),
    );
    const el = nodeEl(container);
    const img = el.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('https://example.com/p.png');
    expect(img!.getAttribute('draggable')).toBe('false');
    expect(img!.style.objectFit).toBe('cover');
    expect(img!.style.pointerEvents).toBe('none');
    // Radius is handled by the wrapper (borderRadius + overflow hidden).
    expect(el.style.borderRadius).toBe('8px');
    expect(el.style.overflow).toBe('hidden');
  });
});

// ---- Line (rotated pill) -------------------------------------------------------------------

describe('DomNode: line', () => {
  it('renders as a rotated pill: width = hypot(w,h), height = max(2, strokeWidth)', () => {
    const { container } = renderNode(
      makeLayer({ type: 'line', x: 0, y: 0, width: 30, height: 40, strokeWidth: 3, fill: '#ff0000' }),
    );
    const el = nodeEl(container);
    expect(el.style.width).toBe('50px'); // hypot(30, 40) = 50
    expect(el.style.height).toBe('3px'); // max(2, 3)
    expect(el.style.borderRadius).toBe('9999px'); // round caps
    expect(el.style.background).toBe('rgb(255, 0, 0)'); // fill is the line color
    expect(el.style.transform).toBe('rotate(53.13010235415598deg)'); // atan2(40, 30)
    expect(el.style.transformOrigin).toBe('0 0');
  });

  it('composes the pill angle with layer rotation', () => {
    const { container } = renderNode(
      makeLayer({ type: 'line', x: 0, y: 0, width: 100, height: 0, rotation: 45 }),
    );
    expect(nodeEl(container).style.transform).toBe('rotate(45deg)');
  });
});

// ---- SVG islands ---------------------------------------------------------------------------

describe('DomNode: SVG islands', () => {
  it('path renders an island <svg> with a polygon (closed) using absolute points', () => {
    const { container } = renderNode(
      makeLayer({
        id: 'p1',
        type: 'path',
        x: 10,
        y: 20,
        width: 30,
        height: 30,
        closed: true,
        points: [
          { x: 10, y: 20 },
          { x: 40, y: 20 },
          { x: 25, y: 50 },
        ],
        fill: '#00ff00',
      }),
    );
    const el = nodeEl(container);
    const svg = el.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('viewBox')).toBe('10 20 30 30');
    const polygon = svg!.querySelector('polygon');
    expect(polygon).not.toBeNull();
    expect(polygon!.getAttribute('points')).toBe('10,20 40,20 25,50');
    expect(polygon!.getAttribute('fill')).toBe('#00ff00');
    // Islands never intercept pointer events — the node div is the hit area.
    expect(svg!.style.pointerEvents).toBe('none');
  });

  it('path renders a polyline (open) with strokeWidth floor 2', () => {
    const { container } = renderNode(
      makeLayer({
        type: 'path',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        closed: false,
        strokeWidth: 1,
        stroke: '#0000ff',
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 10 },
        ],
      }),
    );
    const polyline = nodeEl(container).querySelector('polyline');
    expect(polyline).not.toBeNull();
    expect(polyline!.getAttribute('fill')).toBe('none');
    expect(polyline!.getAttribute('stroke')).toBe('#0000ff');
    expect(polyline!.getAttribute('stroke-width')).toBe('2');
  });

  it('path with no points renders no island svg', () => {
    const { container } = renderNode(makeLayer({ type: 'path', points: null }));
    expect(nodeEl(container).querySelector('svg')).toBeNull();
  });

  it('star renders an island polygon with 2×pointCount vertices around the relative center', () => {
    const { container } = renderNode(
      makeLayer({ id: 's1', type: 'star', x: 0, y: 0, width: 100, height: 100, pointCount: 5 }),
    );
    const svg = nodeEl(container).querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('viewBox')).toBe('0 0 100 100');
    const polygon = svg!.querySelector('polygon');
    expect(polygon).not.toBeNull();
    const pts = (polygon!.getAttribute('points') ?? '').split(' ');
    expect(pts).toHaveLength(10); // 5-point star → 10 vertices
    // First outer vertex sits at the top center (cx=50, cy=0 for rOuter=50).
    expect(pts[0]).toBe('50,0');
  });

  it('polygon renders an island polygon with polygonCount sides (default 6)', () => {
    const { container } = renderNode(
      makeLayer({ id: 'pg1', type: 'polygon', x: 0, y: 0, width: 80, height: 80 }),
    );
    const polygon = nodeEl(container).querySelector('polygon');
    expect(polygon).not.toBeNull();
    const pts = (polygon!.getAttribute('points') ?? '').split(' ');
    expect(pts).toHaveLength(6);
  });
});

// ---- Structural type specials ------------------------------------------------------------------

describe('DomNode: structural type specials', () => {
  it('group renders as a transparent hit container (no background, no border)', () => {
    const { container } = renderNode(makeLayer({ type: 'group', fill: '#ff0000', stroke: '#000' }));
    const el = nodeEl(container);
    expect(el.style.background).toBe('');
    expect(el.style.border).toBe('');
    // The div itself is the full-size hit area.
    expect(el.style.pointerEvents).toBe('auto');
  });

  it('section renders a dashed border + label chip', () => {
    const { container } = renderNode(
      makeLayer({ id: 'sec1', type: 'section', name: 'My Section', fill: '#e2e8f0' }),
    );
    const el = nodeEl(container);
    expect(el.style.border).toContain('dashed');
    expect(el.style.borderRadius).toBe('8px');
    const chip = el.firstElementChild as HTMLElement;
    expect(chip).not.toBeNull();
    expect(chip.textContent).toBe('My Section');
    // The section div itself paints no background (SVG parity: fill="transparent"
    // on the section rect — the fill is spent on the chip).
    expect(el.style.background).toBe('');
    expect(chip.style.background).toBe('rgb(226, 232, 240)'); // layer.fill
    expect(chip.style.top).toBe('-10px');
    expect(chip.style.left).toBe('8px');
    expect(chip.style.pointerEvents).toBe('none');
  });

  it('section label prefers layer.label, then layer.name', () => {
    const { container: cLabel } = renderNode(
      makeLayer({ type: 'section', name: 'Named', label: 'CustomLabel' }),
    );
    expect(nodeEl(cLabel).firstElementChild!.textContent).toBe('CustomLabel');
    const { container: cName } = renderNode(makeLayer({ type: 'section', name: 'Named' }));
    expect(nodeEl(cName).firstElementChild!.textContent).toBe('Named');
    const { container: cNeither } = renderNode(
      makeLayer({ type: 'section', id: 's2', name: 'Test' }),
    );
    expect(nodeEl(cNeither).firstElementChild!.textContent).toBe('Test');
  });

  it('component / component_set / instance get accent borders by default', () => {
    const { container: cComp } = renderNode(makeLayer({ type: 'component' }));
    expect(nodeEl(cComp).style.border).toBe('1.5px solid var(--ac-canvas-component)');
    const { container: cSet } = renderNode(makeLayer({ type: 'component_set' }));
    expect(nodeEl(cSet).style.borderStyle).toBe('dashed');
    const { container: cInst } = renderNode(makeLayer({ type: 'instance' }));
    expect(nodeEl(cInst).style.border).toBe('1.5px solid var(--ac-canvas-instance)');
    // An explicit stroke wins over the accent default.
    const { container: cStroked } = renderNode(
      makeLayer({ type: 'component', stroke: '#123456', strokeWidth: 3 }),
    );
    expect(nodeEl(cStroked).style.border).toBe('3px solid rgb(18, 52, 86)');
  });

  it('slice renders the export-region overlay + label', () => {
    const { container } = renderNode(makeLayer({ type: 'slice' }));
    const el = nodeEl(container);
    expect(el.style.background).toBe('color-mix(in oklch, var(--ac-canvas-autolayout) 8%, transparent)');
    expect(el.style.border).toContain('var(--ac-canvas-autolayout)');
    expect(el.textContent).toContain('⌖ slice');
  });

  it('boolean_operation renders the op-symbol placeholder', () => {
    const { container: cUnion } = renderNode(
      makeLayer({ type: 'boolean_operation', booleanOperationType: 'union' }),
    );
    expect(nodeEl(cUnion).textContent).toBe('∪');
    const { container: cSub } = renderNode(
      makeLayer({ type: 'boolean_operation', booleanOperationType: 'subtract' }),
    );
    expect(nodeEl(cSub).textContent).toBe('−');
    const { container: cX } = renderNode(
      makeLayer({ type: 'boolean_operation', booleanOperationType: 'exclude' }),
    );
    expect(nodeEl(cX).textContent).toBe('⊕');
  });
});

// ---- All 17 layer types render a node div --------------------------------------------------------

describe('DomNode: type coverage', () => {
  const ALL_TYPES: LayerType[] = [
    'rectangle', 'ellipse', 'text', 'line', 'frame', 'group', 'path', 'image',
    'section', 'component', 'component_set', 'instance', 'boolean_operation',
    'slice', 'star', 'polygon',
  ];

  it('renders a div for every LayerType', () => {
    for (const type of ALL_TYPES) {
      const { container } = renderNode(makeLayer({ type }));
      const el = container.querySelector(`[data-node-type="${type}"]`);
      expect(el, `expected a node div for type ${type}`).not.toBeNull();
    }
  });
});
