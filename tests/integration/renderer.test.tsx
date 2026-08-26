// Integration tests — renderer reflects document state driven through the store.
//
// Phase 5 migration (spec acceptance criterion): selectors migrated from
// the legacy SVG-specific (`rect`, `<text>`, `ellipse`, `polygon`, `image`,
// `filter`, `linearGradient`, `stop`) to the renderer-agnostic
// DATA-ATTRIBUTE CONTRACT (spec Appendix C):
//   - `[data-node-id]`            every node carries this
//   - `[data-node-type="..."]`    stable per-LayerType selector
//   - `[data-instance-of]`        instances only
//
// Color/style assertions use the inline-style `background` / `boxShadow` /
// `textShadow` properties (jsdom normalizes hex fills to rgb — see
// dom-node.test.tsx for the same pattern). SVG-as-primitive constructs
// (gradient stops, filter primitives) are tested at the unit-test layer
// (dom-node) and replaced here with their DOM equivalents (linear-gradient
// CSS background, boxShadow CSS).
//
// Strategy:
//   - Set up `useCanvasStore` with an initial document.
//   - Drive mutations through `_onSync({type:'canvas:patch', patch})` — the
//     same path WebSocket events take in production. Wrap in `act()` so React
//     flushes state updates before assertions run.
//   - Render the `Canvas` component (which subscribes to the store) via
//     @testing-library/react and assert the DOM reflects the mutations.
//
// We test the integration of:
//   - The store's document state
//   - The Canvas component's subscription to that state
//   - The DomCanvas/DomNode rendering of each shape type

import { describe, it, expect, beforeEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { useCanvasStore } from '@/lib/canvas/store';
import { useSessionStore } from '@/lib/sessions';
import { Canvas } from '@/components/canvas/Canvas';
import type { CanvasDocument, Shape } from '@/lib/canvas/types'
import type { PenChild } from '@/lib/pen/types';

// ---- Fixtures ----------------------------------------------------------------

function makeDoc(shapes: Shape[] = []): CanvasDocument {
  return {
    id: 'test-doc',
    name: 'Test',
    background: '#ffffff',
    version: '2.17',
    children: shapes as unknown as PenChild[],
    viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes,
    tokens: { colors: [], textStyles: [] },
  };
}

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
    points: null, closed: false, src: null, radii: null, gradient: null,
    shadow: null, blur: 0, maskId: null,
    ...overrides,
  };
}

function resetStore(doc: CanvasDocument = makeDoc([])) {
  useCanvasStore.setState({
    document: doc,
    selectedIds: [],
    agentHighlightIds: [],
    socket: null,
    connected: false,
    viewerCount: 1,
    turns: [],
    agentBusy: false,
    documentId: 'test-doc',
    activeSessionId: null,
    undoStack: [],
    redoStack: [],
  });
  useSessionStore.setState({
    sessions: {},
    runs: {},
    messages: {},
    toolCalls: {},
    snapshots: {},
    activeSessionByDoc: {},
  });
  // Phase 5: default mode is now 'dom' (no SVG pin). These tests use
  // data-attribute selectors ([data-node-type]) which work in BOTH renderer
  // modes — the test runs against whichever renderer is the default.
}

function renderCanvas() {
  return render(<Canvas />);
}

/// Apply a patch through the store's _onSync, wrapped in act() so React
/// flushes the state update before the test continues.
function applyPatch(patch: any) {
  act(() => {
    useCanvasStore.getState()._onSync({ type: 'canvas:patch', patch });
  });
}

function undo() {
  act(() => useCanvasStore.getState().undo());
}

function redo() {
  act(() => useCanvasStore.getState().redo());
}

/// Hex → rgb() helper. jsdom's CSSOM normalizes hex fills to rgb in inline
/// styles (see dom-node.test.tsx). This helper converts hex → rgb so the
/// assertions read naturally and survive the normalization.
function hexToRgb(hex: string): string {
  const m = hex.match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return hex;
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

// ---- Tests -------------------------------------------------------------------

describe('renderer integration: document mutations appear in the canvas (data-attribute contract)', () => {
  beforeEach(() => {
    resetStore();
    cleanup();
  });

  it('renders an empty canvas with no shape nodes', () => {
    const { container } = renderCanvas();
    // No [data-node-id] elements should be present.
    const nodes = container.querySelectorAll('[data-node-id]');
    expect(nodes.length).toBe(0);
  });

  it('renders a rectangle after a canvas:patch add op', () => {
    const { container } = renderCanvas();
    applyPatch({
      op: 'add',
      shape: { type: 'rectangle', name: 'Card', x: 10, y: 10, width: 80, height: 50, fill: '#ff0000', id: 'r1' },
      summary: 'add rect',
    });
    const rect = container.querySelector('[data-node-type="rectangle"]') as HTMLElement | null;
    expect(rect).not.toBeNull();
    expect(rect!.getAttribute('data-node-id')).toBe('r1');
    // Fill maps to CSS background (jsdom normalizes hex → rgb).
    expect(rect!.style.background).toBe(hexToRgb('#ff0000'));
  });

  it('reflects an update patch — fill changes appear in the rendered rect', () => {
    resetStore(makeDoc([makeShape('r1', { fill: '#ff0000' })]));
    const { container } = renderCanvas();

    // Find the rect with the original fill.
    const before = container.querySelector('[data-node-type="rectangle"]') as HTMLElement | null;
    expect(before).not.toBeNull();
    expect(before!.style.background).toBe(hexToRgb('#ff0000'));

    // Apply an update patch changing the fill to blue.
    applyPatch({
      op: 'update',
      shapeId: 'r1',
      shape: { fill: '#0000ff' },
      summary: 'recolor',
    });

    // The new fill should be present; the old should be gone.
    const after = container.querySelector('[data-node-type="rectangle"]') as HTMLElement | null;
    expect(after).not.toBeNull();
    expect(after!.style.background).toBe(hexToRgb('#0000ff'));
  });

  it('reflects a remove patch — the rect disappears', () => {
    resetStore(makeDoc([makeShape('r1'), makeShape('r2')]));
    const { container } = renderCanvas();

    const before = container.querySelectorAll('[data-node-type="rectangle"]');
    expect(before.length).toBeGreaterThanOrEqual(2);

    applyPatch({
      op: 'remove',
      shapeIds: ['r1'],
      summary: 'remove r1',
    });

    const after = container.querySelectorAll('[data-node-type="rectangle"]');
    expect(after.length).toBe(before.length - 1);
  });

  it('reflects a clear patch — all shapes disappear', () => {
    resetStore(makeDoc([makeShape('r1'), makeShape('r2'), makeShape('r3')]));
    const { container } = renderCanvas();
    expect(container.querySelectorAll('[data-node-id]').length).toBeGreaterThanOrEqual(3);

    applyPatch({ op: 'clear', summary: 'clear all' });

    expect(container.querySelectorAll('[data-node-id]').length).toBe(0);
  });

  it('renders a text shape with the correct content', () => {
    const { container } = renderCanvas();
    applyPatch({
      op: 'add',
      shape: { type: 'text', name: 'Heading', x: 0, y: 0, width: 200, height: 32, text: 'Hello world', fontSize: 24, textColor: '#0f172a', id: 't1' },
      summary: 'add text',
    });
    const text = container.querySelector('[data-node-type="text"]');
    expect(text).not.toBeNull();
    expect(text!.textContent).toContain('Hello world');
  });

  it('renders an ellipse', () => {
    const { container } = renderCanvas();
    applyPatch({
      op: 'add',
      shape: { type: 'ellipse', name: 'Avatar', x: 0, y: 0, width: 80, height: 80, fill: '#00ff00', id: 'e1' },
      summary: 'add ellipse',
    });
    const ellipse = container.querySelector('[data-node-type="ellipse"]') as HTMLElement | null;
    expect(ellipse).not.toBeNull();
    expect(ellipse!.style.background).toBe(hexToRgb('#00ff00'));
    // Ellipses always render with border-radius: 50% (SVG parity).
    expect(ellipse!.style.borderRadius).toBe('50%');
  });

  it('renders a path (closed polygon) — data-attribute + island present', () => {
    const { container } = renderCanvas();
    applyPatch({
      op: 'add',
      shape: {
        type: 'path', name: 'Triangle',
        x: 0, y: 0, width: 100, height: 100,
        points: [{ x: 50, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
        closed: true,
        fill: '#ff8800',
        id: 'p1',
      },
      summary: 'add triangle',
    });
    // The DOM renderer wraps the polygon SVG island in a div with
    // data-node-type="path" (spec §3.7 SVG islands). The island itself is
    // a <polygon> SVG element rendered inside the div — covered by the
    // dom-node unit tests. Integration test asserts the wrapper exists
    // with the right type + id.
    const wrapper = container.querySelector('[data-node-type="path"]');
    expect(wrapper).not.toBeNull();
    expect(wrapper!.getAttribute('data-node-id')).toBe('p1');
    // The SVG island inside the wrapper carries the polygon.
    const polygon = wrapper!.querySelector('polygon');
    expect(polygon).not.toBeNull();
    expect(polygon!.getAttribute('fill')).toBe('#ff8800');
  });

  it('renders an image shape with the src on an inner <img>', () => {
    const { container } = renderCanvas();
    applyPatch({
      op: 'add',
      shape: {
        type: 'image', name: 'Photo',
        x: 0, y: 0, width: 100, height: 100,
        src: 'https://example.com/photo.png',
        id: 'img1',
      },
      summary: 'add image',
    });
    const wrapper = container.querySelector('[data-node-type="image"]');
    expect(wrapper).not.toBeNull();
    // The DOM renderer paints an <img> inside the wrapper div (islands.tsx).
    const img = wrapper!.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('https://example.com/photo.png');
  });

  it('renders a shadow on a shape with shadow set (CSS boxShadow)', () => {
    const { container } = renderCanvas();
    applyPatch({
      op: 'add',
      shape: {
        type: 'rectangle', name: 'Card',
        x: 0, y: 0, width: 100, height: 100, fill: '#ffffff',
        shadow: { x: 0, y: 4, blur: 12, color: '#000000' },
        id: 'sh1',
      },
      summary: 'add shadowed rect',
    });
    // DOM renderer maps shadow → CSS boxShadow (non-text). The SVG renderer
    // would have rendered a <filter> inside <defs>. The data-attribute
    // contract doesn't cover filter primitives — the assertion is the
    // boxShadow style on the node div.
    const rect = container.querySelector('[data-node-type="rectangle"]') as HTMLElement | null;
    expect(rect).not.toBeNull();
    // boxShadow format: `<x>px <y>px <blur>px <spread>px <color>` — jsdom
    // keeps the original hex color (unlike background which normalizes to rgb).
    expect(rect!.style.boxShadow).toContain('0px 4px 12px');
    expect(rect!.style.boxShadow).toContain('#000000');
  });

  it('renders a gradient fill (CSS linear-gradient)', () => {
    const { container } = renderCanvas();
    applyPatch({
      op: 'add',
      shape: {
        type: 'rectangle', name: 'Hero',
        x: 0, y: 0, width: 400, height: 200, fill: '#ff0000',
        gradient: {
          type: 'linear', angle: 90,
          stops: [
            { offset: 0, color: '#ff0000' },
            { offset: 1, color: '#0000ff' },
          ],
        },
        id: 'gr1',
      },
      summary: 'add gradient rect',
    });
    // DOM renderer maps gradient → CSS `background: linear-gradient(...)`.
    // The SVG renderer would have rendered a <linearGradient> def + stops.
    // The data-attribute contract asserts the linear-gradient string on
    // the node div's background.
    const rect = container.querySelector('[data-node-type="rectangle"]') as HTMLElement | null;
    expect(rect).not.toBeNull();
    expect(rect!.style.background).toContain('linear-gradient');
    // Both stop colors should appear in the gradient string.
    expect(rect!.style.background).toContain('rgb(255, 0, 0)');
    expect(rect!.style.background).toContain('rgb(0, 0, 255)');
  });

  it('reflects undo: shape disappears after undo of an add patch', () => {
    const { container } = renderCanvas();
    applyPatch({
      op: 'add',
      shape: { type: 'rectangle', name: 'Card', x: 0, y: 0, width: 100, height: 100, fill: '#00ff00', id: 'u1' },
      summary: 'add',
    });
    expect(container.querySelectorAll('[data-node-id]').length).toBeGreaterThanOrEqual(1);

    undo();
    // After undo, the shape should be gone.
    expect(container.querySelectorAll('[data-node-id="u1"]').length).toBe(0);
  });

  it('reflects redo: shape reappears after redo of an undone add patch', () => {
    const { container } = renderCanvas();
    applyPatch({
      op: 'add',
      shape: { type: 'rectangle', name: 'Card', x: 0, y: 0, width: 100, height: 100, fill: '#00ff00', id: 'rd1' },
      summary: 'add',
    });
    undo();
    expect(container.querySelectorAll('[data-node-id="rd1"]').length).toBe(0);

    redo();
    expect(container.querySelectorAll('[data-node-id="rd1"]').length).toBeGreaterThanOrEqual(1);
  });

  it('hidden shapes (visible: false) render nothing visible', () => {
    resetStore(makeDoc([makeShape('h1', { visible: false, fill: '#abcdef' })]));
    const { container } = renderCanvas();
    // DOM renderer: hidden → visibility:hidden (subtree stays mounted but
    // not visible). The shape div exists (per spec — re-show doesn't remount),
    // but its visibility is 'hidden'.
    const node = container.querySelector('[data-node-id="h1"]') as HTMLElement | null;
    expect(node).not.toBeNull();
    expect(node!.style.visibility).toBe('hidden');
    // And the fill is still set on the div (would render if visible).
    expect(node!.style.background).toBe(hexToRgb('#abcdef'));
  });

  it('bulk_add renders all shapes in one update', () => {
    const { container } = renderCanvas();
    applyPatch({
      op: 'bulk_add',
      shapes: [
        { type: 'rectangle', name: 'A', x: 0, y: 0, width: 50, height: 50, fill: '#ff0000', id: 'ba1' },
        { type: 'rectangle', name: 'B', x: 60, y: 0, width: 50, height: 50, fill: '#00ff00', id: 'ba2' },
        { type: 'rectangle', name: 'C', x: 120, y: 0, width: 50, height: 50, fill: '#0000ff', id: 'ba3' },
      ],
      summary: 'bulk add 3',
    });
    expect(container.querySelector('[data-node-id="ba1"]') as HTMLElement | null).not.toBeNull();
    expect(container.querySelector('[data-node-id="ba2"]') as HTMLElement | null).not.toBeNull();
    expect(container.querySelector('[data-node-id="ba3"]') as HTMLElement | null).not.toBeNull();
    // Verify each rect has its expected fill.
    expect((container.querySelector('[data-node-id="ba1"]') as HTMLElement)!.style.background).toBe(hexToRgb('#ff0000'));
    expect((container.querySelector('[data-node-id="ba2"]') as HTMLElement)!.style.background).toBe(hexToRgb('#00ff00'));
    expect((container.querySelector('[data-node-id="ba3"]') as HTMLElement)!.style.background).toBe(hexToRgb('#0000ff'));
  });

  it('background op changes the canvas container style', () => {
    const { container } = renderCanvas();
    // Initial background is white (#ffffff) — the outer wrapper carries
    // style.background (the world div, in DOM mode).
    const outerBefore = container.firstChild as HTMLElement;
    expect(outerBefore).not.toBeNull();
    expect(outerBefore.style.background).toContain('rgb(255, 255, 255)');

    applyPatch({ op: 'background', background: '#0f172a', summary: 'dark bg' });

    // After the patch, jsdom converts #0f172a to its rgb equivalent.
    const outerAfter = container.firstChild as HTMLElement;
    expect(outerAfter.style.background).toContain('rgb(15, 23, 42)');
  });
});
