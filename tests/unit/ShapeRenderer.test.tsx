// Tests for the ShapeRenderer component — the SVG element factory that
// turns a Shape into rendered SVG.
//
// We focus on the new shape types and effects added in Phase 5:
//   - 'path' shape (closed polygon + open polyline)
//   - 'image' shape (SVG <image> with href)
//   - gradient fill (linear + radial)
//   - drop shadow (SVG filter)
//   - blur (SVG filter)
//   - per-corner radii (rx / ry on <rect>)
//   - maskId (currently a no-op visual marker — documented)
//
// We also confirm:
//   - hidden shapes (visible: false) render nothing
//   - all existing shape types (rectangle / ellipse / text / line) still render
//   - the `selected` prop doesn't crash the renderer
//
// Strategy: render ShapeRenderer inside an <svg> container (SVG elements
// can't be queried by jsdom as HTML, but their attributes are queryable).

import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { ShapeRenderer } from '@/components/canvas/svg/ShapeRenderer';
import type { Shape } from '@/lib/canvas/types';

// ---- Helpers -----------------------------------------------------------------

function makeShape(overrides: Partial<Shape> = {}): Shape {
  return {
    id: overrides.id ?? 'test-shape',
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
    constraints: overrides.constraints ?? null,
  };
}

const noopMouseDown = vi.fn();
const noopResizeHandle = vi.fn();

function renderShape(shape: Shape) {
  return render(
    <svg>
      <ShapeRenderer
        shape={shape}
        selected={false}
        highlighted={false}
        zoom={1}
        onShapeMouseDown={noopMouseDown}
        onResizeHandleMouseDown={noopResizeHandle}
      />
    </svg>,
  );
}

/// Find the first SVG element with the given tag name within `container`.
function svgEl(container: HTMLElement, tag: string): Element | null {
  return container.querySelector(tag);
}

// ---- Visibility --------------------------------------------------------------

describe('ShapeRenderer: visibility', () => {
  it('renders nothing when visible=false', () => {
    const shape = makeShape({ visible: false });
    const { container } = renderShape(shape);
    // No shape elements should be present.
    expect(container.querySelector('rect')).toBeNull();
    expect(container.querySelector('ellipse')).toBeNull();
    expect(container.querySelector('path')).toBeNull();
    expect(container.querySelector('polygon')).toBeNull();
    expect(container.querySelector('polyline')).toBeNull();
    expect(container.querySelector('image')).toBeNull();
    expect(container.querySelector('text')).toBeNull();
    expect(container.querySelector('line')).toBeNull();
  });
});

// ---- Existing shape types (regression) ---------------------------------------

describe('ShapeRenderer: existing shape types', () => {
  it('renders a rectangle as <rect>', () => {
    const { container } = renderShape(makeShape({
      type: 'rectangle', x: 10, y: 20, width: 100, height: 50, fill: '#ff0000',
    }));
    const rect = svgEl(container, 'rect');
    expect(rect).not.toBeNull();
    expect(rect!.getAttribute('x')).toBe('10');
    expect(rect!.getAttribute('y')).toBe('20');
    expect(rect!.getAttribute('width')).toBe('100');
    expect(rect!.getAttribute('height')).toBe('50');
    expect(rect!.getAttribute('fill')).toBe('#ff0000');
  });

  it('renders a frame as <rect>', () => {
    const { container } = renderShape(makeShape({ type: 'frame' }));
    expect(svgEl(container, 'rect')).not.toBeNull();
  });

  it('renders an ellipse as <ellipse>', () => {
    const { container } = renderShape(makeShape({
      type: 'ellipse', x: 0, y: 0, width: 100, height: 100,
    }));
    const ell = svgEl(container, 'ellipse');
    expect(ell).not.toBeNull();
    expect(ell!.getAttribute('cx')).toBe('50');
    expect(ell!.getAttribute('cy')).toBe('50');
    expect(ell!.getAttribute('rx')).toBe('50');
    expect(ell!.getAttribute('ry')).toBe('50');
  });

  it('renders a text shape as <text>', () => {
    const { container } = renderShape(makeShape({
      type: 'text', text: 'Hello', fontSize: 24, textColor: '#00ff00',
    }));
    const text = svgEl(container, 'text');
    expect(text).not.toBeNull();
    expect(text!.getAttribute('font-size')).toBe('24');
    expect(text!.getAttribute('fill')).toBe('#00ff00');
    expect(text!.textContent).toBe('Hello');
  });

  it('renders a line shape as <line>', () => {
    const { container } = renderShape(makeShape({
      type: 'line', x: 10, y: 20, width: 100, height: 50, fill: '#ff0000',
    }));
    const line = svgEl(container, 'line');
    expect(line).not.toBeNull();
    expect(line!.getAttribute('x1')).toBe('10');
    expect(line!.getAttribute('y1')).toBe('20');
    expect(line!.getAttribute('x2')).toBe('110');
    expect(line!.getAttribute('y2')).toBe('70');
    expect(line!.getAttribute('stroke')).toBe('#ff0000');
  });
});

// ---- New: 'path' shape -------------------------------------------------------

describe('ShapeRenderer: path shape', () => {
  it('renders a closed path as <polygon>', () => {
    const { container } = renderShape(makeShape({
      type: 'path',
      closed: true,
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 5 }],
      fill: '#00ff00',
    }));
    const polygon = svgEl(container, 'polygon');
    expect(polygon).not.toBeNull();
    expect(polygon!.getAttribute('points')).toBe('0,0 10,0 5,5');
    expect(polygon!.getAttribute('fill')).toBe('#00ff00');
  });

  it('renders an open path as <polyline>', () => {
    const { container } = renderShape(makeShape({
      type: 'path',
      closed: false,
      points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
      stroke: '#0000ff',
      strokeWidth: 2,
    }));
    const polyline = svgEl(container, 'polyline');
    expect(polyline).not.toBeNull();
    expect(polyline!.getAttribute('points')).toBe('0,0 10,10');
    expect(polyline!.getAttribute('fill')).toBe('none');
    expect(polyline!.getAttribute('stroke')).toBe('#0000ff');
  });

  it('renders nothing when a path has no points', () => {
    const { container } = renderShape(makeShape({
      type: 'path', points: null, closed: false,
    }));
    expect(svgEl(container, 'polygon')).toBeNull();
    expect(svgEl(container, 'polyline')).toBeNull();
  });

  it('renders nothing when a path has an empty points array', () => {
    const { container } = renderShape(makeShape({
      type: 'path', points: [], closed: false,
    }));
    expect(svgEl(container, 'polygon')).toBeNull();
    expect(svgEl(container, 'polyline')).toBeNull();
  });
});

// ---- New: 'image' shape ------------------------------------------------------

describe('ShapeRenderer: image shape', () => {
  it('renders as <image> with href', () => {
    const { container } = renderShape(makeShape({
      type: 'image',
      src: 'https://example.com/photo.png',
      x: 10, y: 20, width: 200, height: 100,
    }));
    const img = svgEl(container, 'image');
    expect(img).not.toBeNull();
    // SVG <image> uses href (or xlink:href in older specs).
    const href = img!.getAttribute('href') ?? img!.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
    expect(href).toBe('https://example.com/photo.png');
    expect(img!.getAttribute('x')).toBe('10');
    expect(img!.getAttribute('y')).toBe('20');
    expect(img!.getAttribute('width')).toBe('200');
    expect(img!.getAttribute('height')).toBe('100');
  });

  it('renders <image> even when src is null (href becomes undefined)', () => {
    const { container } = renderShape(makeShape({
      type: 'image', src: null, x: 0, y: 0, width: 100, height: 100,
    }));
    expect(svgEl(container, 'image')).not.toBeNull();
  });
});

// ---- New: gradient fill ------------------------------------------------------

describe('ShapeRenderer: gradient fill', () => {
  it('renders a linearGradient def for a linear gradient', () => {
    const { container } = renderShape(makeShape({
      type: 'rectangle',
      gradient: {
        type: 'linear',
        angle: 90,
        stops: [
          { offset: 0, color: '#ff0000' },
          { offset: 1, color: '#0000ff' },
        ],
      },
    }));
    const linear = svgEl(container, 'linearGradient');
    expect(linear).not.toBeNull();
    const stops = linear!.querySelectorAll('stop');
    expect(stops).toHaveLength(2);
    expect(stops[0].getAttribute('offset')).toBe('0%');
    expect(stops[0].getAttribute('stop-color')).toBe('#ff0000');
    expect(stops[1].getAttribute('offset')).toBe('100%');
    expect(stops[1].getAttribute('stop-color')).toBe('#0000ff');
  });

  it('renders a radialGradient def for a radial gradient', () => {
    const { container } = renderShape(makeShape({
      type: 'rectangle',
      gradient: {
        type: 'radial',
        angle: 0,
        stops: [
          { offset: 0, color: '#fff' },
          { offset: 1, color: '#000' },
        ],
      },
    }));
    expect(svgEl(container, 'radialGradient')).not.toBeNull();
  });

  it('sets the rect fill to url(#gradient-id)', () => {
    const { container } = renderShape(makeShape({
      id: 'g1',
      type: 'rectangle',
      gradient: {
        type: 'linear', angle: 0,
        stops: [{ offset: 0, color: '#fff' }, { offset: 1, color: '#000' }],
      },
    }));
    const rect = svgEl(container, 'rect');
    expect(rect!.getAttribute('fill')).toBe('url(#shape-gradient-g1)');
  });

  it('does NOT render a gradient def when there are fewer than 2 stops', () => {
    const { container } = renderShape(makeShape({
      type: 'rectangle',
      gradient: {
        type: 'linear', angle: 0,
        stops: [{ offset: 0, color: '#fff' }],
      },
    }));
    expect(svgEl(container, 'linearGradient')).toBeNull();
  });

  it('computes linearGradient x1/y1/x2/y2 from the angle', () => {
    // angle=0 → gradient pointing right → x1=0%, x2=100%, y1=y2=50%.
    // Math: rad=0, cos(0)=1, sin(0)=0.
    //   x1 = 50 - cos(0)*50 = 0
    //   y1 = 50 - sin(0)*50 = 50
    //   x2 = 50 + cos(0)*50 = 100
    //   y2 = 50 + sin(0)*50 = 50
    const { container: c0 } = renderShape(makeShape({
      type: 'rectangle',
      gradient: { type: 'linear', angle: 0, stops: [{ offset: 0, color: '#fff' }, { offset: 1, color: '#000' }] },
    }));
    let lg = svgEl(c0, 'linearGradient')!;
    expect(lg.getAttribute('x1')).toBe('0%');
    expect(lg.getAttribute('x2')).toBe('100%');
    expect(lg.getAttribute('y1')).toBe('50%');
    expect(lg.getAttribute('y2')).toBe('50%');

    // angle=90 → gradient pointing down → x1=x2=50%, y1=0%, y2=100%.
    //   rad=PI/2, cos=0, sin=1.
    //   x1 = 50 - 0 = 50, x2 = 50 + 0 = 50
    //   y1 = 50 - 50 = 0, y2 = 50 + 50 = 100
    const { container: c90 } = renderShape(makeShape({
      type: 'rectangle',
      gradient: { type: 'linear', angle: 90, stops: [{ offset: 0, color: '#fff' }, { offset: 1, color: '#000' }] },
    }));
    lg = svgEl(c90, 'linearGradient')!;
    expect(lg.getAttribute('x1')).toBe('50%');
    expect(lg.getAttribute('x2')).toBe('50%');
    expect(lg.getAttribute('y1')).toBe('0%');
    expect(lg.getAttribute('y2')).toBe('100%');
  });

  it('supports gradient on ellipse, path (polygon), and frame', () => {
    for (const type of ['ellipse', 'path', 'frame'] as const) {
      const { container } = renderShape(makeShape({
        type,
        closed: type === 'path' ? true : undefined,
        points: type === 'path' ? [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 5 }] : undefined,
        gradient: {
          type: 'linear', angle: 90,
          stops: [{ offset: 0, color: '#fff' }, { offset: 1, color: '#000' }],
        },
      }));
      expect(svgEl(container, 'linearGradient')).not.toBeNull();
    }
  });
});

// ---- New: drop shadow --------------------------------------------------------

describe('ShapeRenderer: drop shadow', () => {
  it('renders an SVG filter def with feDropShadow', () => {
    const { container } = renderShape(makeShape({
      id: 'shadowed',
      type: 'rectangle',
      shadow: { x: 2, y: 4, blur: 8, color: '#00000044' },
    }));
    const filter = svgEl(container, 'filter');
    expect(filter).not.toBeNull();
    expect(filter!.getAttribute('id')).toBe('shape-filter-shadowed');
    const feDrop = filter!.querySelector('feDropShadow');
    expect(feDrop).not.toBeNull();
    expect(feDrop!.getAttribute('dx')).toBe('2');
    expect(feDrop!.getAttribute('dy')).toBe('4');
    expect(feDrop!.getAttribute('stdDeviation')).toBe('8');
    expect(feDrop!.getAttribute('flood-color')).toBe('#00000044');
  });

  it('applies the filter to the rect via filter=url(...)', () => {
    const { container } = renderShape(makeShape({
      id: 'shadowed-rect',
      type: 'rectangle',
      shadow: { x: 0, y: 0, blur: 4, color: '#000' },
    }));
    const rect = svgEl(container, 'rect');
    expect(rect!.getAttribute('filter')).toBe('url(#shape-filter-shadowed-rect)');
  });
});

// ---- New: blur ----------------------------------------------------------------

describe('ShapeRenderer: blur', () => {
  it('renders an SVG filter def with feGaussianBlur', () => {
    const { container } = renderShape(makeShape({
      id: 'blurred',
      type: 'rectangle',
      blur: 5,
    }));
    const filter = svgEl(container, 'filter');
    expect(filter).not.toBeNull();
    const feBlur = filter!.querySelector('feGaussianBlur');
    expect(feBlur).not.toBeNull();
    expect(feBlur!.getAttribute('stdDeviation')).toBe('5');
  });

  it('does NOT render a filter when blur=0', () => {
    const { container } = renderShape(makeShape({
      type: 'rectangle',
      blur: 0,
    }));
    expect(svgEl(container, 'filter')).toBeNull();
  });

  it('combines shadow + blur in one filter def', () => {
    const { container } = renderShape(makeShape({
      id: 'both',
      type: 'rectangle',
      blur: 3,
      shadow: { x: 1, y: 1, blur: 2, color: '#000' },
    }));
    const filter = svgEl(container, 'filter');
    expect(filter).not.toBeNull();
    expect(filter!.querySelector('feGaussianBlur')).not.toBeNull();
    expect(filter!.querySelector('feDropShadow')).not.toBeNull();
  });
});

// ---- New: per-corner radii ---------------------------------------------------

describe('ShapeRenderer: per-corner radii', () => {
  it('uses radii.topLeft as rx and radii.topRight as ry', () => {
    const { container } = renderShape(makeShape({
      type: 'rectangle',
      radii: { topLeft: 4, topRight: 8, bottomRight: 12, bottomLeft: 16 },
    }));
    const rect = svgEl(container, 'rect');
    expect(rect!.getAttribute('rx')).toBe('4');
    expect(rect!.getAttribute('ry')).toBe('8');
  });

  it('falls back to uniform radius when radii is null', () => {
    const { container } = renderShape(makeShape({
      type: 'rectangle',
      radius: 10,
      radii: null,
    }));
    const rect = svgEl(container, 'rect');
    expect(rect!.getAttribute('rx')).toBe('10');
    expect(rect!.getAttribute('ry')).toBe('10');
  });

  it('applies per-corner radii to frames too', () => {
    const { container } = renderShape(makeShape({
      type: 'frame',
      radii: { topLeft: 4, topRight: 4, bottomRight: 4, bottomLeft: 4 },
    }));
    const rect = svgEl(container, 'rect');
    expect(rect!.getAttribute('rx')).toBe('4');
    expect(rect!.getAttribute('ry')).toBe('4');
  });
});

// ---- New: maskId (currently a no-op visual marker) ---------------------------

describe('ShapeRenderer: maskId', () => {
  it('renders the underlying shape without crashing when maskId is set', () => {
    // The current implementation only adds a data attribute (no-op visual).
    // We just verify the shape still renders.
    const { container } = renderShape(makeShape({
      type: 'rectangle',
      maskId: 'other-shape-id',
    }));
    expect(svgEl(container, 'rect')).not.toBeNull();
  });
});

// ---- Selected state ----------------------------------------------------------

describe('ShapeRenderer: selected state', () => {
  it('renders resize handles when selected=true', () => {
    const { container } = render(
      <svg>
        <ShapeRenderer
          shape={makeShape({ type: 'rectangle' })}
          selected={true}
          highlighted={false}
          zoom={1}
          onShapeMouseDown={noopMouseDown}
          onResizeHandleMouseDown={noopResizeHandle}
        />
      </svg>,
    );
    // When selected, the renderer emits:
    //   1 main shape rect
    //   1 selection outline rect (the light-blue bounding box)
    //   8 resize handle rects (nw, n, ne, e, se, s, sw, w)
    // Total: 10 rects.
    const rects = container.querySelectorAll('rect');
    expect(rects.length).toBe(10);
    // The 8 handle rects have a fill of var(--ac-canvas-handle-fill).
    const handleRects = Array.from(rects).filter((r) => r.getAttribute('fill') === 'var(--ac-canvas-handle-fill)');
    expect(handleRects.length).toBe(8);
  });
});

// ---- Highlighted state -------------------------------------------------------

describe('ShapeRenderer: highlighted state', () => {
  it('renders an amber animated outline when highlighted=true', () => {
    const { container } = render(
      <svg>
        <ShapeRenderer
          shape={makeShape({ type: 'rectangle', x: 10, y: 10, width: 100, height: 50 })}
          selected={false}
          highlighted={true}
          zoom={1}
          onShapeMouseDown={noopMouseDown}
          onResizeHandleMouseDown={noopResizeHandle}
        />
      </svg>,
    );
    // The highlight rect has stroke var(--ac-canvas-highlight) (was #f59e0b).
    const highlight = Array.from(container.querySelectorAll('rect')).find(
      (r) => r.getAttribute('stroke') === 'var(--ac-canvas-highlight)',
    );
    expect(highlight).toBeDefined();
    // It should contain an <animate> element.
    expect(highlight!.querySelector('animate')).not.toBeNull();
  });
});
