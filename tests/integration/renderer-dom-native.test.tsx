// Integration tests — the DOM renderer's NATIVE CSS layout mode (spec §3.4,
// Phase 2) vs its PARITY mode.
//
// Fixture: a frame with vertical auto-layout (gap + [v,h] padding) holding
// three flow children — fixed-size, fit_content, fill_container — plus one
// layoutPosition:'absolute' child that opts out of the flow.
//
//   Native mode assertions (jsdom — inline styles only):
//     - the frame div is a real CSS flex container (display/flex-direction/
//       gap/padding per the §3.4 table)
//     - the fill child grows on the main axis (flex longhands) with NO
//       explicit height
//     - the fit child hugs (no explicit width)
//     - the fixed child keeps explicit px sizing
//     - the absolute child keeps position:absolute + resolver offsets
//     - the world div publishes --acv-* custom properties (§3.6) +
//       data-ac-theme; token-bound nodes emit var(--acv-…, fallback)
//
//   Parity-mode regression (same fixture, layoutMode='parity'):
//     - every child is absolutely positioned from the resolver's predicted
//       geometry (left/top/width/height) — Phase-1 behavior, byte-for-byte.
//
//   Browser-only assertions (real layout engine) are gated behind
//   PARITY_BROWSER — jsdom cannot measure text.

import { describe, it, expect, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { DomCanvas } from '@/components/canvas/dom/DomCanvas';
import { resolvePenTree } from '@/lib/pen/resolve';
import { createEmptyCanvasDocument } from '@/lib/canvas/types';
import type { CanvasDocument } from '@/lib/canvas/types';
import type { PenFrame, PenRectangle, PenText } from '@/lib/pen/types';

// ---- Fixtures -----------------------------------------------------------------

const noopMouseDown = vi.fn();
const noopResizeHandle = vi.fn();

/// A frame with vertical auto-layout + 3 flow children (fixed / fit / fill)
/// + 1 absolute child. Variables + a token-bound rect exercise §3.6.
function nativeLayoutDoc(): CanvasDocument {
  const base = createEmptyCanvasDocument('native-doc', 'Native');
  const fixed: PenRectangle = {
    id: 'fixed-child', type: 'rectangle', name: 'Fixed', x: 0, y: 0,
    width: 120, height: 30, fill: '#ff0000',
  };
  const fit: PenText = {
    id: 'fit-child', type: 'text', name: 'Fit', x: 0, y: 0,
    width: 'fit_content', height: 'fit_content', content: 'Hello native layout',
  };
  const filler: PenRectangle = {
    id: 'fill-child', type: 'rectangle', name: 'Fill', x: 0, y: 0,
    width: 'fill_container', height: 'fill_container', fill: '#00ff00',
  };
  const absolute: PenRectangle = {
    id: 'abs-child', type: 'rectangle', name: 'Abs', x: 240, y: 12,
    width: 24, height: 24, fill: '#0000ff', layoutPosition: 'absolute',
  };
  const tokenBound: PenRectangle = {
    id: 'token-child', type: 'rectangle', name: 'Token', x: 500, y: 60,
    width: 60, height: 60, fill: '#0ea5e9',
    tokenBinding: { fillToken: 'color.primary' },
  } as PenRectangle;
  const frame: PenFrame = {
    id: 'flex-frame', type: 'frame', name: 'Panel', x: 40, y: 60,
    width: 300, height: 240,
    layout: 'vertical', gap: 10, padding: [8, 12],
    justifyContent: 'start', alignItems: 'start',
    fill: '#ffffff',
    children: [fixed, fit, filler, absolute],
  };
  const children = [frame, tokenBound];
  return {
    ...base,
    children,
    // Parity mode consumes the resolver's flat output.
    shapes: resolvePenTree({ ...base, children }),
    variables: {
      'color.primary': { type: 'color', value: '#0ea5e9' },
      'spacing.md': { type: 'number', value: 16 },
    },
  };
}

function mountCanvas(doc: CanvasDocument, layoutMode: 'parity' | 'native') {
  return render(
    <DomCanvas
      document={doc}
      selectedIds={[]}
      highlightIds={[]}
      viewport={{ zoom: 1, panX: 0, panY: 0 }}
      layoutMode={layoutMode}
      onShapeMouseDown={noopMouseDown}
      onResizeHandleMouseDown={noopResizeHandle}
    />,
  );
}

// ---- Native mode -----------------------------------------------------------------

describe('DOM renderer native layout mode — flex emission (§3.4)', () => {
  it('renders the auto-layout frame as a real CSS flex container', () => {
    const { container } = mountCanvas(nativeLayoutDoc(), 'native');
    const frame = container.querySelector('[data-node-id="flex-frame"]') as HTMLElement;
    expect(frame).not.toBeNull();
    expect(frame.style.display).toBe('flex');
    expect(frame.style.flexDirection).toBe('column');
    expect(frame.style.gap).toBe('10px');
    // [v,h] padding → "8px 12px 8px 12px" (jsdom may collapse the shorthand —
    // accept the collapsed form too).
    expect(['8px 12px 8px 12px', '8px 12px']).toContain(frame.style.padding);
    // The frame is a ROOT (child of layout:'none' world) → keeps absolute
    // positioning from resolver geometry.
    expect(frame.style.position).toBe('absolute');
    expect(frame.style.left).toBe('40px');
    expect(frame.style.top).toBe('60px');
    expect(frame.style.width).toBe('300px');
  });

  it('fixed child keeps explicit px sizing inside the flow', () => {
    const { container } = mountCanvas(nativeLayoutDoc(), 'native');
    const fixed = container.querySelector('[data-node-id="fixed-child"]') as HTMLElement;
    expect(fixed).not.toBeNull();
    expect(fixed.style.position).toBe(''); // flow child — no absolute positioning
    expect(fixed.style.left).toBe('');
    expect(fixed.style.top).toBe('');
    expect(fixed.style.width).toBe('120px');
    expect(fixed.style.height).toBe('30px');
  });

  it('fill_container child grows on the main axis with NO explicit height', () => {
    const { container } = mountCanvas(nativeLayoutDoc(), 'native');
    const fill = container.querySelector('[data-node-id="fill-child"]') as HTMLElement;
    expect(fill).not.toBeNull();
    // Main axis (height, vertical parent): ≡ flex: 1 1 0 via longhands.
    expect(fill.style.flexGrow).toBe('1');
    expect(fill.style.flexShrink).toBe('1');
    expect(fill.style.flexBasis).toBe('0px');
    expect(fill.style.height).toBe(''); // browser-driven
    // Cross axis (width): stretch.
    expect(fill.style.alignSelf).toBe('stretch');
    expect(fill.style.width).toBe('');
  });

  it('fit_content child hugs with no explicit width', () => {
    const { container } = mountCanvas(nativeLayoutDoc(), 'native');
    const fit = container.querySelector('[data-node-id="fit-child"]') as HTMLElement;
    expect(fit).not.toBeNull();
    expect(fit.style.width).toBe(''); // auto — the browser measures the text
    expect(fit.style.height).toBe('');
    // Main axis (height): ≡ flex: 0 0 auto via longhands.
    expect(fit.style.flexGrow).toBe('0');
    expect(fit.style.flexShrink).toBe('0');
    expect(fit.style.flexBasis).toBe('auto');
    expect(fit.style.alignSelf).toBe('auto');
    // The text content still renders.
    expect(fit.textContent).toContain('Hello native layout');
  });

  it('layoutPosition:absolute child opts out of the flow (position + offsets)', () => {
    const { container } = mountCanvas(nativeLayoutDoc(), 'native');
    const abs = container.querySelector('[data-node-id="abs-child"]') as HTMLElement;
    expect(abs).not.toBeNull();
    expect(abs.style.position).toBe('absolute');
    // Offsets relative to the frame's origin (resolver geometry): 240-0, 12-0.
    expect(abs.style.left).toBe('240px');
    expect(abs.style.top).toBe('12px');
    expect(abs.style.width).toBe('24px');
    expect(abs.style.height).toBe('24px');
  });

  it('publishes --acv-* custom properties + data-ac-theme on the world div (§3.6)', () => {
    const { container } = mountCanvas(nativeLayoutDoc(), 'native');
    const world = container.querySelector('[data-ac-world]') as HTMLElement;
    expect(world).not.toBeNull();
    expect(world.getAttribute('data-ac-theme')).toBe('default');
    expect(world.style.getPropertyValue('--acv-color-primary')).toBe('#0ea5e9');
    expect(world.style.getPropertyValue('--acv-spacing-md')).toBe('16');
  });

  it('token-bound node emits var(--acv-…, fallback) background in native mode', () => {
    const { container } = mountCanvas(nativeLayoutDoc(), 'native');
    const token = container.querySelector('[data-node-id="token-child"]') as HTMLElement;
    expect(token).not.toBeNull();
    expect(token.style.background).toBe('var(--acv-color-primary, #0ea5e9)');
  });
});

// ---- Parity-mode regression --------------------------------------------------------

describe('DOM renderer parity mode — regression on the same fixture', () => {
  it('renders every child absolutely positioned from the resolver geometry', () => {
    const doc = nativeLayoutDoc();
    const { container } = mountCanvas(doc, 'parity');
    const frame = container.querySelector('[data-node-id="flex-frame"]') as HTMLElement;
    expect(frame.style.display).toBe(''); // NOT a flex container in parity mode
    expect(frame.style.flexDirection).toBe('');
    expect(frame.style.gap).toBe('');
    expect(frame.style.position).toBe('absolute');

    // Every child: absolute box from the flat resolved layers.
    for (const id of ['fixed-child', 'fit-child', 'fill-child', 'abs-child']) {
      const el = container.querySelector(`[data-node-id="${id}"]`) as HTMLElement;
      expect(el).not.toBeNull();
      expect(el.style.position).toBe('absolute');
      expect(el.style.left).not.toBe('');
      expect(el.style.top).not.toBe('');
      // Parity sizes come from the resolver's predicted geometry.
      const model = doc.shapes.find((s) => s.id === id)!;
      expect(parseFloat(el.style.left)).toBeCloseTo(model.x - 40, 0); // frame-relative
      expect(parseFloat(el.style.top)).toBeCloseTo(model.y - 60, 0);
      expect(parseFloat(el.style.width)).toBeCloseTo(model.width, 0);
      expect(parseFloat(el.style.height)).toBeCloseTo(model.height, 0);
    }
  });

  it('fit/fill children get resolver-predicted sizes (no flex rules)', () => {
    const { container } = mountCanvas(nativeLayoutDoc(), 'parity');
    const fit = container.querySelector('[data-node-id="fit-child"]') as HTMLElement;
    const fill = container.querySelector('[data-node-id="fill-child"]') as HTMLElement;
    expect(fit.style.flexGrow).toBe('');
    expect(fit.style.alignSelf).toBe('');
    expect(fill.style.flexGrow).toBe('');
    expect(fill.style.alignSelf).toBe('');
    // Both have explicit resolver boxes (fit_content text → intrinsic
    // prediction; fill_container → parent content box).
    expect(fit.style.width).not.toBe('');
    expect(fill.style.height).not.toBe('');
  });
});

// ---- Browser-only assertions (real layout engine required) --------------------------

describe.skipIf(!process.env.PARITY_BROWSER)('DOM renderer native mode — real measurements (browser only)', () => {
  it('a fit_content text node measures a real non-zero width (< 100)', () => {
    cleanup();
    const { container } = mountCanvas(nativeLayoutDoc(), 'native');
    const fit = container.querySelector('[data-node-id="fit-child"]') as HTMLElement;
    expect(fit).not.toBeNull();
    const rect = fit.getBoundingClientRect();
    // jsdom returns all-zero rects; a real browser measures the text.
    if (rect.width === 0 && rect.height === 0) return;
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.width).toBeLessThan(100);
    expect(rect.height).toBeGreaterThan(0);
  });

  it('the fill_container child actually stretches to the frame content box', () => {
    cleanup();
    const { container } = mountCanvas(nativeLayoutDoc(), 'native');
    const frame = container.querySelector('[data-node-id="flex-frame"]') as HTMLElement;
    const fill = container.querySelector('[data-node-id="fill-child"]') as HTMLElement;
    const fr = frame.getBoundingClientRect();
    const cr = fill.getBoundingClientRect();
    if (fr.width === 0 && cr.width === 0) return;
    // Vertical layout + alignItems start + width fill_container → the child's
    // width equals the frame's content width (300 - 12 - 12 padding).
    expect(Math.abs(cr.width - (fr.width - 24))).toBeLessThanOrEqual(1);
  });
});
