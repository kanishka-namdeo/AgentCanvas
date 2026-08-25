// Integration tests — renderer reflects document state driven through the store.
//
// Strategy:
//   - Set up `useCanvasStore` with an initial document.
//   - Drive mutations through `_onSync({type:'canvas:patch', patch})` — the
//     same path WebSocket events take in production. Wrap in `act()` so React
//     flushes state updates before assertions run.
//   - Render the `Canvas` component (which subscribes to the store) via
//     @testing-library/react and assert the SVG reflects the mutations.
//
// We test the integration of:
//   - The store's document state
//   - The Canvas component's subscription to that state
//   - The ShapeRenderer's rendering of each shape type

import { describe, it, expect, beforeEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { useCanvasStore } from '@/lib/canvas/store';
import { useSessionStore } from '@/lib/sessions';
import { useSettings } from '@/lib/settings/store';
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
    points: null, closed: false, src: null, radii: null,
    gradient: null, shadow: null, blur: 0, maskId: null,
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
  // Phase 5 default-flip guard: production now defaults to 'dom' but these
  // tests assert SVG-specific selectors (`rect`, `<text>`, `ellipse`, …).
  // Pin to 'svg' so the SvgCanvas mounts and the assertions still hold.
  // Renderer-agnostic migration to the data-attribute contract is tracked
  // separately (spec Phase 5 acceptance criterion).
  useSettings.setState({ renderer: 'svg', canvasLayoutMode: 'parity', domCulling: false });
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

// ---- Tests -------------------------------------------------------------------

describe('renderer integration: document mutations appear in the SVG', () => {
  beforeEach(() => {
    resetStore();
    cleanup();
  });

  it('renders an empty canvas with no shapes', () => {
    const { container } = renderCanvas();
    // No shape rects should be present (just the <defs> gradients etc).
    const rects = container.querySelectorAll('rect, ellipse, circle, polygon, polyline, image, text');
    expect(rects.length).toBe(0);
  });

  it('renders a rectangle after a canvas:patch add op', () => {
    const { container } = renderCanvas();
    applyPatch({
      op: 'add',
      shape: { type: 'rectangle', name: 'Card', x: 10, y: 10, width: 80, height: 50, fill: '#ff0000', id: 'r1' },
      summary: 'add rect',
    });
    const rect = container.querySelector('rect');
    expect(rect).not.toBeNull();
    expect(rect!.getAttribute('fill')).toBe('#ff0000');
  });

  it('reflects an update patch — fill changes appear in the rendered rect', () => {
    resetStore(makeDoc([makeShape('r1', { fill: '#ff0000' })]));
    const { container } = renderCanvas();

    // Find the rect with the original fill.
    const before = container.querySelector('rect[fill="#ff0000"]');
    expect(before).not.toBeNull();

    // Apply an update patch changing the fill to blue.
    applyPatch({
      op: 'update',
      shapeId: 'r1',
      shape: { fill: '#0000ff' },
      summary: 'recolor',
    });

    // The new fill should be present; the old should be gone.
    const after = container.querySelector('rect[fill="#0000ff"]');
    expect(after).not.toBeNull();
    const oldGone = container.querySelector('rect[fill="#ff0000"]');
    expect(oldGone).toBeNull();
  });

  it('reflects a remove patch — the rect disappears', () => {
    resetStore(makeDoc([makeShape('r1'), makeShape('r2')]));
    const { container } = renderCanvas();

    const before = container.querySelectorAll('rect');
    expect(before.length).toBeGreaterThanOrEqual(2);

    applyPatch({
      op: 'remove',
      shapeIds: ['r1'],
      summary: 'remove r1',
    });

    const after = container.querySelectorAll('rect');
    expect(after.length).toBe(before.length - 1);
  });

  it('reflects a clear patch — all shapes disappear', () => {
    resetStore(makeDoc([makeShape('r1'), makeShape('r2'), makeShape('r3')]));
    const { container } = renderCanvas();
    expect(container.querySelectorAll('rect').length).toBeGreaterThanOrEqual(3);

    applyPatch({ op: 'clear', summary: 'clear all' });

    expect(container.querySelectorAll('rect').length).toBe(0);
  });

  it('renders a text shape as SVG <text> with the correct content', () => {
    const { container } = renderCanvas();
    applyPatch({
      op: 'add',
      shape: { type: 'text', name: 'Heading', x: 0, y: 0, width: 200, height: 32, text: 'Hello world', fontSize: 24, textColor: '#0f172a', id: 't1' },
      summary: 'add text',
    });
    const text = container.querySelector('text');
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
    const ellipse = container.querySelector('ellipse');
    expect(ellipse).not.toBeNull();
    expect(ellipse!.getAttribute('fill')).toBe('#00ff00');
  });

  it('renders a path (closed polygon) from points', () => {
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
    const polygon = container.querySelector('polygon');
    expect(polygon).not.toBeNull();
    expect(polygon!.getAttribute('fill')).toBe('#ff8800');
    // The points attribute should contain all three vertices.
    const pts = polygon!.getAttribute('points') ?? '';
    expect(pts).toContain('50,0');
    expect(pts).toContain('100,100');
    expect(pts).toContain('0,100');
  });

  it('renders an image shape with href', () => {
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
    const image = container.querySelector('image');
    expect(image).not.toBeNull();
    const href = image!.getAttribute('href') ?? image!.getAttribute('xlink:href');
    expect(href).toBe('https://example.com/photo.png');
  });

  it('renders a shadow filter on a shape with shadow set', () => {
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
    // The ShapeRenderer renders shadow filters inside a <defs> with a <filter>.
    const filters = container.querySelectorAll('filter');
    expect(filters.length).toBeGreaterThanOrEqual(1);
  });

  it('renders a gradient fill via <linearGradient>', () => {
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
    const gradient = container.querySelector('linearGradient');
    expect(gradient).not.toBeNull();
    const stops = gradient!.querySelectorAll('stop');
    expect(stops.length).toBe(2);
  });

  it('reflects undo: shape disappears after undo of an add patch', () => {
    const { container } = renderCanvas();
    applyPatch({
      op: 'add',
      shape: { type: 'rectangle', name: 'Card', x: 0, y: 0, width: 100, height: 100, fill: '#00ff00', id: 'u1' },
      summary: 'add',
    });
    expect(container.querySelectorAll('rect').length).toBeGreaterThanOrEqual(1);

    undo();
    // After undo, the shape should be gone.
    expect(container.querySelectorAll('rect[fill="#00ff00"]').length).toBe(0);
  });

  it('reflects redo: shape reappears after redo of an undone add patch', () => {
    const { container } = renderCanvas();
    applyPatch({
      op: 'add',
      shape: { type: 'rectangle', name: 'Card', x: 0, y: 0, width: 100, height: 100, fill: '#00ff00', id: 'rd1' },
      summary: 'add',
    });
    undo();
    expect(container.querySelectorAll('rect[fill="#00ff00"]').length).toBe(0);

    redo();
    expect(container.querySelectorAll('rect[fill="#00ff00"]').length).toBeGreaterThanOrEqual(1);
  });

  it('hidden shapes (visible: false) render nothing', () => {
    resetStore(makeDoc([makeShape('h1', { visible: false, fill: '#abcdef' })]));
    const { container } = renderCanvas();
    expect(container.querySelector('rect[fill="#abcdef"]')).toBeNull();
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
    expect(container.querySelector('rect[fill="#ff0000"]')).not.toBeNull();
    expect(container.querySelector('rect[fill="#00ff00"]')).not.toBeNull();
    expect(container.querySelector('rect[fill="#0000ff"]')).not.toBeNull();
  });

  it('background op changes the canvas container style', () => {
    const { container } = renderCanvas();
    // Initial background is white (#ffffff) — the outer div has style.background.
    const outerBefore = container.firstChild as HTMLElement;
    expect(outerBefore).not.toBeNull();
    expect(outerBefore.style.background).toContain('rgb(255, 255, 255)');

    applyPatch({ op: 'background', background: '#0f172a', summary: 'dark bg' });

    // After the patch, jsdom converts #0f172a to its rgb equivalent.
    const outerAfter = container.firstChild as HTMLElement;
    expect(outerAfter.style.background).toContain('rgb(15, 23, 42)');
  });
});
