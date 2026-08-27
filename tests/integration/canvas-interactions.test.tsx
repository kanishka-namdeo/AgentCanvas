// Integration tests — Phase 7 canvas interactions (spec §10.3 #2):
// marquee selection (plain + ⌘-nested), ⌘+click deep select, Enter/⇧Enter/
// Tab/⇧Tab hierarchy navigation, snap-to-pixel drag rounding, outline mode,
// pixel-grid visibility, and the zoom-to-fit viewport math.
//
// jsdom pointer simulation on the DOM renderer (parity mode) following the
// pattern of renderer-dom.test.tsx: drive the store, render <Canvas/> with
// the renderer flag forced to 'dom', and assert through the store + the
// DOM data-attribute contract (Appendix C).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { useCanvasStore } from '@/lib/canvas/store';
import { useSessionStore } from '@/lib/sessions';
import { useSettings } from '@/lib/settings/store';
import { Canvas } from '@/components/canvas/Canvas';
import { fitViewport } from '@/lib/canvas/viewport';
import { scaleGeometry } from '@/lib/canvas/scale';
import type { CanvasDocument, Shape } from '@/lib/canvas/types';
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

/// Fixture world (canvas coords; the shell viewport starts at zoom 1,
/// panX 120, panY 80 — so screen = canvas + (120, 80) with jsdom's 0-rects):
///
///   frame1 (0,0,300,300)
///     ├── rect-a (20,20,60,60)     z1
///     └── rect-b (120,120,60,60)   z2
///   ell-1 (500,100,80,80)          z3
///   frame2 (1000,0,400,400)        z4
///     ├── rect-e (1100,100,60,60)  z5
///     └── rect-d (1300,300,60,60)  z6
function fixtureDoc(): CanvasDocument {
  return makeDoc([
    makeShape('frame1', { type: 'frame', x: 0, y: 0, width: 300, height: 300, zIndex: 0 }),
    makeShape('rect-a', { x: 20, y: 20, width: 60, height: 60, parentId: 'frame1', zIndex: 1 }),
    makeShape('rect-b', { x: 120, y: 120, width: 60, height: 60, parentId: 'frame1', zIndex: 2 }),
    makeShape('ell-1', { type: 'ellipse', x: 500, y: 100, width: 80, height: 80, zIndex: 3 }),
    makeShape('frame2', { type: 'frame', x: 1000, y: 0, width: 400, height: 400, zIndex: 4 }),
    makeShape('rect-e', { x: 1100, y: 100, width: 60, height: 60, parentId: 'frame2', zIndex: 5 }),
    makeShape('rect-d', { x: 1300, y: 300, width: 60, height: 60, parentId: 'frame2', zIndex: 6 }),
  ]);
}

function resetStore(doc: CanvasDocument = fixtureDoc()) {
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
    toolMode: 'select',
    pixelGridVisible: true,
    snapToPixel: false,
    outlineMode: false,
    measuredBounds: {},
  });
  useSessionStore.setState({
    sessions: {},
    runs: {},
    messages: {},
    toolCalls: {},
    snapshots: {},
    activeSessionByDoc: {},
  });
}

function getSelected(): string[] {
  return useCanvasStore.getState().selectedIds;
}

// ---- Tests -------------------------------------------------------------------

describe('Phase 7 canvas interactions', () => {
  beforeEach(() => {
    resetStore();
    cleanup();
    useSettings.setState({ renderer: 'dom', canvasLayoutMode: 'parity' });
  });

  afterEach(() => {
    useSettings.setState({ renderer: 'dom' });
    cleanup();
  });

  // ---- Marquee selection ------------------------------------------------------

  it('marquee mousedown → move → mouseup selects intersecting nodes (partial hits included)', () => {
    const { container } = render(<Canvas />);
    const root = container.firstElementChild as HTMLElement;
    // Canvas-space marquee (20,20)→(220,220) = screen (140,100)→(340,300).
    fireEvent.mouseDown(root, { button: 0, clientX: 140, clientY: 100 });
    // The marquee rect renders during the drag (test/automation selector).
    fireEvent.mouseMove(root, { clientX: 340, clientY: 300 });
    expect(container.querySelector('[data-ac-marquee]')).not.toBeNull();
    fireEvent.mouseUp(root, { clientX: 340, clientY: 300 });

    const sel = getSelected().sort();
    // frame1 (0..300 ⊃ marquee), rect-a (20..80 inside), rect-b (120..180
    // inside) all intersect; ell-1 (500..580) and frame2 (1000..) do not.
    expect(sel).toEqual(['frame1', 'rect-a', 'rect-b']);
    // Marquee rect unmounts after mouse-up.
    expect(container.querySelector('[data-ac-marquee]')).toBeNull();
  });

  it('plain click on empty canvas still clears the selection', () => {
    act(() => useCanvasStore.setState({ selectedIds: ['ell-1'] }));
    const { container } = render(<Canvas />);
    const root = container.firstElementChild as HTMLElement;
    fireEvent.mouseDown(root, { button: 0, clientX: 700, clientY: 600 });
    fireEvent.mouseUp(root, { clientX: 700, clientY: 600 });
    expect(getSelected()).toEqual([]);
  });

  it('⌘-drag nested marquee ALSO selects descendants of intersecting containers', () => {
    const { container } = render(<Canvas />);
    const root = container.firstElementChild as HTMLElement;
    // Canvas-space marquee (1050,50)→(1200,200) = screen (1170,130)→(1320,280).
    // Intersects frame2 + rect-e; rect-d is inside frame2 but outside the rect.
    fireEvent.mouseDown(root, { button: 0, clientX: 1170, clientY: 130, metaKey: true });
    fireEvent.mouseMove(root, { clientX: 1320, clientY: 280 });
    fireEvent.mouseUp(root, { clientX: 1320, clientY: 280 });

    const sel = getSelected().sort();
    expect(sel).toContain('frame2');
    expect(sel).toContain('rect-e');
    // Nested semantics: rect-d joins because an ANCESTOR intersected.
    expect(sel).toContain('rect-d');
    // frame1 / rect-a / rect-b / ell-1 untouched.
    expect(sel).not.toContain('frame1');
    expect(sel).not.toContain('ell-1');
  });

  it('plain marquee does NOT select descendants of non-intersecting bboxes', () => {
    const { container } = render(<Canvas />);
    const root = container.firstElementChild as HTMLElement;
    fireEvent.mouseDown(root, { button: 0, clientX: 1170, clientY: 130 });
    fireEvent.mouseMove(root, { clientX: 1320, clientY: 280 });
    fireEvent.mouseUp(root, { clientX: 1320, clientY: 280 });
    const sel = getSelected().sort();
    expect(sel).toEqual(['frame2', 'rect-e']);
  });

  // ---- Deep select (⌘+click ancestor cycling) ----------------------------------

  it('⌘+click selects the event-target node, second ⌘+click moves to its parent', () => {
    const { container } = render(<Canvas />);
    const rectA = container.querySelector('[data-node-id="rect-a"]') as HTMLElement;
    expect(rectA).not.toBeNull();

    // First ⌘+click: rect-a is NOT selected → select it (deepest).
    fireEvent.mouseDown(rectA, { button: 0, metaKey: true, clientX: 150, clientY: 110 });
    expect(getSelected()).toEqual(['rect-a']);

    // Second ⌘+click on the same node → select its PARENT (frame1).
    fireEvent.mouseDown(rectA, { button: 0, metaKey: true, clientX: 150, clientY: 110 });
    expect(getSelected()).toEqual(['frame1']);

    // ⌘+click on the top-level frame (no parent) → stays selected.
    const frame1 = container.querySelector('[data-node-id="frame1"]') as HTMLElement;
    fireEvent.mouseDown(frame1, { button: 0, metaKey: true, clientX: 150, clientY: 110 });
    expect(getSelected()).toEqual(['frame1']);
  });

  it('plain click keeps the legacy single-select behavior', () => {
    const { container } = render(<Canvas />);
    const rectA = container.querySelector('[data-node-id="rect-a"]') as HTMLElement;
    fireEvent.mouseDown(rectA, { button: 0, clientX: 150, clientY: 110 });
    expect(getSelected()).toEqual(['rect-a']);
  });

  // ---- Hierarchy navigation (Enter / ⇧Enter / Tab / ⇧Tab) ----------------------

  it('Enter selects the topmost child; ⇧Enter returns to the parent', () => {
    render(<Canvas />);
    act(() => useCanvasStore.setState({ selectedIds: ['frame1'] }));
    fireEvent.keyDown(window, { key: 'Enter' });
    // Children of frame1: rect-a (z1), rect-b (z2) → topmost = rect-b.
    expect(getSelected()).toEqual(['rect-b']);
    fireEvent.keyDown(window, { key: 'Enter', shiftKey: true });
    expect(getSelected()).toEqual(['frame1']);
  });

  it('Tab / ⇧Tab cycle siblings within the same parent (wrapping)', () => {
    render(<Canvas />);
    act(() => useCanvasStore.setState({ selectedIds: ['rect-a'] }));
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(getSelected()).toEqual(['rect-b']);
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(getSelected()).toEqual(['rect-a']); // wraps
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(getSelected()).toEqual(['rect-b']); // wraps backwards
  });

  it('Enter on a leaf (no children) is a no-op; ⇧Enter on a root stays put', () => {
    render(<Canvas />);
    act(() => useCanvasStore.setState({ selectedIds: ['ell-1'] }));
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(getSelected()).toEqual(['ell-1']);
    fireEvent.keyDown(window, { key: 'Enter', shiftKey: true });
    expect(getSelected()).toEqual(['ell-1']);
  });

  // ---- Snap-to-pixel ------------------------------------------------------------

  it('snap-to-pixel rounds drag coordinates to integers before the patch', () => {
    const sendPatch = vi.fn();
    act(() => useCanvasStore.setState({ sendPatch, snapToPixel: true }));
    const { container } = render(<Canvas />);

    // Zoom in once via the menu CustomEvent → zoom 1.2 (fractional canvas deltas).
    act(() => {
      window.dispatchEvent(new CustomEvent('ac:canvas-zoom', { detail: { kind: 'in' } }));
    });

    const ell = container.querySelector('[data-node-id="ell-1"]') as HTMLElement;
    fireEvent.mouseDown(ell, { button: 0, clientX: 540, clientY: 140 });
    // dx = 7px screen → 7/1.2 = 5.8333 canvas px → rounds to 6.
    fireEvent.mouseMove(container.firstElementChild as HTMLElement, { clientX: 547, clientY: 140 });
    fireEvent.mouseUp(container.firstElementChild as HTMLElement, { clientX: 547, clientY: 140 });

    const last = sendPatch.mock.calls[sendPatch.mock.calls.length - 1][0];
    expect(last.op).toBe('update');
    expect(last.shapeId).toBe('ell-1');
    expect(last.shape.x).toBe(500 + Math.round(7 / 1.2)); // 506 — integer
    expect(Number.isInteger(last.shape.x)).toBe(true);
  });

  it('without snap-to-pixel the same drag keeps fractional coordinates', () => {
    const sendPatch = vi.fn();
    act(() => useCanvasStore.setState({ sendPatch }));
    const { container } = render(<Canvas />);
    act(() => {
      window.dispatchEvent(new CustomEvent('ac:canvas-zoom', { detail: { kind: 'in' } }));
    });
    const ell = container.querySelector('[data-node-id="ell-1"]') as HTMLElement;
    fireEvent.mouseDown(ell, { button: 0, clientX: 540, clientY: 140 });
    fireEvent.mouseMove(container.firstElementChild as HTMLElement, { clientX: 547, clientY: 140 });
    fireEvent.mouseUp(container.firstElementChild as HTMLElement, { clientX: 547, clientY: 140 });
    const last = sendPatch.mock.calls[sendPatch.mock.calls.length - 1][0];
    expect(last.shape.x).toBeCloseTo(500 + 7 / 1.2, 5); // 505.8333 — fractional
  });

  // ---- Outline mode + pixel grid (view options) ---------------------------------

  it('outline mode toggles the data-ac-outline world attribute', () => {
    const { container } = render(<Canvas />);
    const world = container.querySelector('[data-ac-world]') as HTMLElement;
    expect(world.hasAttribute('data-ac-outline')).toBe(false);

    // Keyboard: ⌘⇧O (Ctrl+Shift+O on the win platform jsdom reports).
    fireEvent.keyDown(window, { key: 'O', ctrlKey: true, shiftKey: true, code: 'KeyO' });
    expect(useCanvasStore.getState().outlineMode).toBe(true);
    expect(world.hasAttribute('data-ac-outline')).toBe(true);

    fireEvent.keyDown(window, { key: 'O', ctrlKey: true, shiftKey: true, code: 'KeyO' });
    expect(useCanvasStore.getState().outlineMode).toBe(false);
    expect(world.hasAttribute('data-ac-outline')).toBe(false);
  });

  it('pixel grid toggle (Ctrl+\') hides the backdrop grid', () => {
    const { container } = render(<Canvas />);
    const grid = container.querySelector('[data-empty-bg="true"]') as HTMLElement;
    expect(grid.style.visibility).toBe('visible');
    fireEvent.keyDown(window, { key: "'", ctrlKey: true, code: 'Quote' });
    expect(useCanvasStore.getState().pixelGridVisible).toBe(false);
    expect(grid.style.visibility).toBe('hidden');
    fireEvent.keyDown(window, { key: "'", ctrlKey: true, code: 'Quote' });
    expect(grid.style.visibility).toBe('visible');
  });

  it('snap-to-pixel keyboard toggle flips the store flag', () => {
    render(<Canvas />);
    fireEvent.keyDown(window, { key: '"', ctrlKey: true, shiftKey: true, code: 'Quote' });
    expect(useCanvasStore.getState().snapToPixel).toBe(true);
    fireEvent.keyDown(window, { key: '"', ctrlKey: true, shiftKey: true, code: 'Quote' });
    expect(useCanvasStore.getState().snapToPixel).toBe(false);
  });

  // ---- Zoom shortcuts -------------------------------------------------------------

  it('⇧1 zoom-to-fit fits the document bbox with margin (world transform)', () => {
    const { container } = render(<Canvas />);
    const world = container.querySelector('[data-ac-world]') as HTMLElement;
    expect(world.style.transform).toContain('scale(1)');

    // Fixture bbox: (0,0)→(1400,400); container 1200×800; margin 40.
    // zoom = min(1120/1400, 720/400) = 0.8; pan = ((1200-1120)/2, (800-320)/2) = (40, 240).
    fireEvent.keyDown(window, { key: '!', shiftKey: true, code: 'Digit1' });
    expect(world.style.transform).toContain('scale(0.8)');
    expect(world.style.transform).toContain('translate(40px, 240px)');

    // ⇧0 resets to 100%.
    fireEvent.keyDown(window, { key: ')', shiftKey: true, code: 'Digit0' });
    expect(world.style.transform).toContain('scale(1)');
  });

  it('⇧2 zoom-to-selection fits the selected shapes only', () => {
    const { container } = render(<Canvas />);
    const world = container.querySelector('[data-ac-world]') as HTMLElement;
    act(() => useCanvasStore.setState({ selectedIds: ['ell-1'] }));
    // ell-1 bbox: (500,100,80,80) → zoom = min(1120/80, 720/80) = 9 → clamped to 8.
    fireEvent.keyDown(window, { key: '@', shiftKey: true, code: 'Digit2' });
    expect(world.style.transform).toContain(`scale(8)`);
  });
});

// ---- Pure viewport math (fitViewport) -------------------------------------------

describe('fitViewport (zoom-to-fit math)', () => {
  it('fits a 100×100 layer into 800×600 with 40px margin', () => {
    const vp = fitViewport([{ x: 0, y: 0, width: 100, height: 100 }], { w: 800, h: 600 }, 40);
    expect(vp.zoom).toBeCloseTo(5.2, 6);
    expect(vp.panX).toBeCloseTo(140, 6);
    expect(vp.panY).toBeCloseTo(40, 6);
  });

  it('centers non-origin content and uses the constrained axis', () => {
    const vp = fitViewport([{ x: 1000, y: 200, width: 200, height: 1000 }], { w: 800, h: 600 }, 40);
    // zoom limited by height: 520/1000 = 0.52.
    expect(vp.zoom).toBeCloseTo(0.52, 6);
    expect(vp.panX).toBeCloseTo((800 - 200 * 0.52) / 2 - 1000 * 0.52, 6);
    expect(vp.panY).toBeCloseTo((600 - 1000 * 0.52) / 2 - 200 * 0.52, 6);
  });

  it('clamps zoom into the canvas range', () => {
    // Huge content would zoom below MIN_ZOOM (0.1).
    const tiny = fitViewport([{ x: 0, y: 0, width: 100000, height: 100000 }], { w: 800, h: 600 });
    expect(tiny.zoom).toBe(0.1);
    // Tiny content would zoom above MAX_ZOOM (8).
    const huge = fitViewport([{ x: 0, y: 0, width: 1, height: 1 }], { w: 800, h: 600 });
    expect(huge.zoom).toBe(8);
  });

  it('empty input returns the default viewport', () => {
    expect(fitViewport([], { w: 800, h: 600 })).toEqual({ zoom: 1, panX: 120, panY: 80 });
  });
});

// ---- Scale tool geometry (K) ------------------------------------------------------

describe('scaleGeometry (proportional scale-tool math)', () => {
  it('scales width/height/fontSize/strokeWidth by one factor anchored at the opposite corner', () => {
    const out = scaleGeometry(
      { x: 100, y: 100, width: 200, height: 100, fontSize: 10, strokeWidth: 2 },
      'se',
      200, // dxCanvas: width 200 → 400 (factor 2)
      999, // dyCanvas ignored for the 'e'/'s' corner → factor from width
    );
    expect(out.width).toBe(400);
    expect(out.height).toBe(200);
    expect(out.x).toBe(100); // nw anchor stays
    expect(out.y).toBe(100);
    expect(out.fontSize).toBe(20);
    expect(out.strokeWidth).toBe(4);
  });

  it('nw handle anchors the se corner', () => {
    const out = scaleGeometry({ x: 100, y: 100, width: 200, height: 100 }, 'nw', -100, 0);
    // width 200 → 300 (factor 1.5); x moves so the right edge stays at 300.
    expect(out.width).toBe(300);
    expect(out.height).toBe(150);
    expect(out.x).toBe(0);
    expect(out.y).toBe(50);
  });

  it('edge handles scale uniformly from their own axis', () => {
    const out = scaleGeometry({ x: 0, y: 0, width: 100, height: 50 }, 'n', 0, -25);
    // height 50 → 75 (factor 1.5); y anchors the bottom edge at 50.
    expect(out.height).toBe(75);
    expect(out.width).toBe(150);
    expect(out.y).toBe(-25);
  });

  it('never produces zero/negative sizes (MIN_FACTOR guard)', () => {
    const out = scaleGeometry({ x: 0, y: 0, width: 100, height: 100, fontSize: 12 }, 'se', -100000, 0);
    expect(out.width).toBeGreaterThan(0);
    expect(out.height).toBeGreaterThan(0);
    expect(out.fontSize).toBeGreaterThan(0);
  });
});
