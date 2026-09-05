// Interaction-surface consistency pass (2026-09-05) — regression tests.
//
// Grounded in the audited standards for this pass:
//   - WAI-ARIA APG "Developing a Keyboard Interface" (Tab moves focus
//     BETWEEN components; arrows move focus INSIDE composites; open menus
//     own Escape; tree-view key contract),
//   - MDN wheel event (passive:false + preventDefault; deltaMode LINE vs
//     PIXEL; ctrlKey=true = trackpad pinch),
//   - WCAG 2.1.4 (single-character shortcuts must not fire inside composite
//     widgets / text entry),
//   - Figma parity (⌘+/-/0 canvas-zoom aliases, ⌘S checkpoint, browser-zoom
//     chords owned by the app).
//
// Covers:
//   1. platformChord display translation (⌘ → Ctrl on win, ⎋ → Esc…),
//   2. the focus-scope helpers (isEditableTarget / inCompositeWidget /
//      menuLayerOpen / inCanvasKeyScope — cross-realm window detection),
//   3. interpretWheel: the full wheel branch table incl. deltaMode
//      normalization + shift+wheel horizontal pan + ctrlKey pinch,
//   4. registry additions (z-order family, file chords, gesture docs) with
//      conflict detection still clean + the new ⌘+ / ⌘0 / ⌘S aliases,
//   5. component behavior: Escape stands down while a Radix floating layer
//      is open; Space pan-arm only in canvas scope; window-level drag
//      phases (drag survives the cursor leaving the canvas).
//   6. LayersPanel APG tree keyboard (roving tabindex, arrows, Enter,
//      Space, F2, typeahead).
//   7. Guides: right-click no longer deletes instantly (menu affordance).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, act, cleanup } from '@testing-library/react';
import type { ReactElement } from 'react';
import {
  platformChord,
  resetPlatformCache,
  isEditableTarget,
  inCompositeWidget,
  menuLayerOpen,
  inCanvasKeyScope,
  matchShortcut,
  SHORTCUTS,
  SHORTCUTS_BY_ACTION,
  findConflicts,
} from '@/lib/canvas/shortcuts';
import { interpretWheel, normalizeWheelDeltas } from '@/lib/canvas/use-canvas-gestures';
import { Canvas } from '@/components/canvas/Canvas';
import { LayersPanel } from '@/components/canvas/LayersPanel';
import { Guides } from '@/components/canvas/dom/Guides';
import { useCanvasStore } from '@/lib/canvas/store';
import { useSessionStore } from '@/lib/sessions';
import type { CanvasDocument, Shape } from '@/lib/canvas/types';
import type { PenChild } from '@/lib/pen/types';

// ---- Fixtures (shared with canvas-interactions.test.tsx) ---------------------

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

function fixtureDoc(): CanvasDocument {
  return makeDoc([
    makeShape('frame1', { type: 'frame', x: 0, y: 0, width: 300, height: 300, zIndex: 0 }),
    makeShape('rect-a', { x: 20, y: 20, width: 60, height: 60, parentId: 'frame1', zIndex: 1 }),
    makeShape('rect-b', { x: 120, y: 120, width: 60, height: 60, parentId: 'frame1', zIndex: 2 }),
    makeShape('ell-1', { type: 'ellipse', x: 500, y: 100, width: 80, height: 80, zIndex: 3 }),
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

// ---- 1. platformChord ---------------------------------------------------------

describe('platformChord display translation', () => {
  afterEach(() => {
    resetPlatformCache();
  });

  it('win platform: ⌘ family translates to Ctrl family', () => {
    resetPlatformCache(); // jsdom default platform '' → 'win'
    expect(platformChord('⌘⇧G')).toBe('Ctrl+Shift+G');
    expect(platformChord('⌘X')).toBe('Ctrl+X');
    expect(platformChord('⌥⌘K')).toBe('Ctrl+Alt+K');
  });

  it('win platform: non-modifier symbols get Windows spellings', () => {
    resetPlatformCache();
    expect(platformChord('⎋')).toBe('Esc');
    expect(platformChord('⌫')).toBe('Backspace');
  });

  it('mac platform passes mac notation through', () => {
    Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true });
    resetPlatformCache();
    expect(platformChord('⌘⇧G')).toBe('⌘⇧G');
    expect(platformChord('⎋')).toBe('⎋');
    resetPlatformCache();
    Object.defineProperty(window.navigator, 'platform', { value: '', configurable: true });
  });
});

// ---- 2. Focus-scope helpers ---------------------------------------------------

describe('focus-scope helpers', () => {
  it('isEditableTarget: input/textarea/select true; button false (contentEditable unsupported in jsdom)', () => {
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const select = document.createElement('select');
    const button = document.createElement('button');
    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(textarea)).toBe(true);
    expect(isEditableTarget(select)).toBe(true);
    expect(isEditableTarget(button)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });

  it('inCompositeWidget: APG composite roles + form controls true; plain div false', () => {
    const mk = (attrs: Record<string, string>) => {
      const el = document.createElement('div');
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      return el;
    };
    expect(inCompositeWidget(mk({ role: 'slider' }))).toBe(true);
    expect(inCompositeWidget(mk({ role: 'menu' }))).toBe(true);
    expect(inCompositeWidget(mk({ role: 'treeitem' }))).toBe(true);
    expect(inCompositeWidget(mk({ role: 'tablist' }))).toBe(true);
    expect(inCompositeWidget(document.createElement('select'))).toBe(true);
    expect(inCompositeWidget(document.createElement('div'))).toBe(false);
    // child of a composite counts (closest semantics)
    const tree = mk({ role: 'tree' });
    const row = document.createElement('div');
    row.setAttribute('role', 'treeitem');
    tree.appendChild(row);
    expect(inCompositeWidget(row)).toBe(true);
    expect(inCompositeWidget(null)).toBe(false);
  });

  it('menuLayerOpen: true while a Radix popper wrapper exists, false after', () => {
    expect(menuLayerOpen()).toBe(false);
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-radix-popper-content-wrapper', '');
    document.body.appendChild(wrapper);
    expect(menuLayerOpen()).toBe(true);
    wrapper.remove();
    expect(menuLayerOpen()).toBe(false);
  });

  it('inCanvasKeyScope: window/body true; button false; shape node true (cross-realm safe)', () => {
    expect(inCanvasKeyScope(window)).toBe(true);
    expect(inCanvasKeyScope(document.body)).toBe(true);
    expect(inCanvasKeyScope(document)).toBe(true);
    const shape = document.createElement('div');
    shape.setAttribute('data-node-type', 'frame');
    expect(inCanvasKeyScope(shape)).toBe(true);
    const button = document.createElement('button');
    expect(inCanvasKeyScope(button)).toBe(false);
    // window self-reference identity works even for a foreign-realm Window
    const fakeWindow = { window: null as unknown, document: {} } as { window: unknown };
    fakeWindow.window = fakeWindow;
    expect(inCanvasKeyScope(fakeWindow as unknown as EventTarget)).toBe(true);
    expect(inCanvasKeyScope(null)).toBe(false);
  });
});

// ---- 3. Wheel interpretation ---------------------------------------------------

describe('interpretWheel branch table', () => {
  it('ctrlKey → cursor-anchored zoom (trackpad pinch encoding)', () => {
    expect(interpretWheel({ deltaX: 0, deltaY: -10, deltaMode: 0, ctrlKey: true, shiftKey: false }))
      .toEqual({ kind: 'zoom', delta: -(-10) * 0.015 });
  });

  it('small pixel deltas → trackpad two-finger pan (deltas negated for screen space)', () => {
    expect(interpretWheel({ deltaX: 3, deltaY: -7, deltaMode: 0, ctrlKey: false, shiftKey: false }))
      .toEqual({ kind: 'pan', dx: -3, dy: 7 });
  });

  it('large pixel deltaY (mouse wheel) → zoom', () => {
    const g = interpretWheel({ deltaX: 0, deltaY: 120, deltaMode: 0, ctrlKey: false, shiftKey: false });
    expect(g.kind).toBe('zoom');
  });

  it('deltaMode LINE normalizes to pixels (Firefox external mice zoom, never misread as trackpad pan)', () => {
    // 3 lines × 40px = 120px — above the trackpad threshold → zoom.
    const g = interpretWheel({ deltaX: 0, deltaY: 3, deltaMode: 1, ctrlKey: false, shiftKey: false });
    expect(g.kind).toBe('zoom');
    // Even 1 line stays a discrete wheel → zoom (line mode is never a
    // trackpad two-finger scroll — those are pixel mode).
    const p = interpretWheel({ deltaX: 0, deltaY: 1, deltaMode: 1, ctrlKey: false, shiftKey: false });
    expect(p.kind).toBe('zoom');
  });

  it('shift+wheel → horizontal pan (unswapped Chrome deltas)', () => {
    expect(interpretWheel({ deltaX: 0, deltaY: 100, deltaMode: 0, ctrlKey: false, shiftKey: true }))
      .toEqual({ kind: 'pan', dx: -100, dy: 0 });
  });

  it('shift+wheel with browser-swapped deltas (Firefox) → horizontal pan from deltaX', () => {
    expect(interpretWheel({ deltaX: 100, deltaY: 0, deltaMode: 0, ctrlKey: false, shiftKey: true }))
      .toEqual({ kind: 'pan', dx: -100, dy: 0 });
  });

  it('normalizeWheelDeltas: LINE ×40, PAGE ×800, PIXEL passthrough', () => {
    expect(normalizeWheelDeltas({ deltaX: 2, deltaY: 3, deltaMode: 1 })).toEqual({ dx: 80, dy: 120 });
    expect(normalizeWheelDeltas({ deltaX: 1, deltaY: 1, deltaMode: 2 })).toEqual({ dx: 800, dy: 800 });
    expect(normalizeWheelDeltas({ deltaX: 5, deltaY: 6, deltaMode: 0 })).toEqual({ dx: 5, dy: 6 });
  });
});

// ---- 4. Registry additions ------------------------------------------------------

describe('shortcut registry: interaction-consistency additions', () => {
  it('still has zero primary-chord conflicts (both platforms)', () => {
    expect(findConflicts()).toEqual([]);
  });

  it('documents the previously-unlisted wired chords', () => {
    const actions = new Set(SHORTCUTS.map((s) => s.action));
    for (const a of [
      'file.new-session', 'file.import', 'file.export',
      'bring-forward', 'bring-to-front', 'send-backward', 'send-to-back',
      'chat.scroll-up', 'chat.scroll-down',
      'auto-layout.apply', 'tool.pen',
      'nudge', 'pan-space-drag', 'duplicate-drag', 'measure-hold', 'deep-select', 'nested-marquee',
    ]) {
      expect(actions.has(a), `registry should list ${a}`).toBe(true);
    }
  });

  it('zoom.in/out/100 gain the ⌘+/⌘−/⌘0 browser-zoom aliases (win match)', () => {
    resetPlatformCache(); // win
    const mk = (key: string, code: string, extra: Record<string, unknown> = {}): KeyboardEvent =>
      ({ key, code, metaKey: false, ctrlKey: true, altKey: false, shiftKey: false, ...extra } as unknown as KeyboardEvent);
    const zoomIn = SHORTCUTS_BY_ACTION.get('zoom.in')!;
    expect(matchShortcut(mk('=', 'Equal'), zoomIn)).toBe(true);
    expect(matchShortcut(mk('+', 'Equal', { shiftKey: true }), zoomIn)).toBe(true);
    const zoom100 = SHORTCUTS_BY_ACTION.get('zoom.100')!;
    expect(matchShortcut(mk('0', 'Digit0'), zoom100)).toBe(true);
    const zoomOut = SHORTCUTS_BY_ACTION.get('zoom.out')!;
    expect(matchShortcut(mk('-', 'Minus'), zoomOut)).toBe(true);
  });

  it('save-checkpoint gains the ⌘S alias (app owns the chord, not the browser)', () => {
    resetPlatformCache();
    const save = SHORTCUTS_BY_ACTION.get('save-checkpoint')!;
    expect(
      matchShortcut(
        { key: 's', code: 'KeyS', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false } as unknown as KeyboardEvent,
        save,
      ),
    ).toBe(true);
  });

  it('shortcuts-dialog no longer carries the dead ⌃⇧? alias', () => {
    const def = SHORTCUTS_BY_ACTION.get('shortcuts-dialog')!;
    expect(def.also ?? []).toEqual([]);
  });

  it('delete entry documents Backspace on win', () => {
    expect(SHORTCUTS_BY_ACTION.get('delete')!.win).toContain('Backspace');
  });
});

// ---- 5. Canvas component behavior ----------------------------------------------

describe('Canvas key handling: scope + Escape ownership', () => {
  beforeEach(() => {
    resetStore();
  });
  afterEach(() => {
    cleanup();
    resetPlatformCache();
  });

  function renderUi(ui: ReactElement) {
    return render(ui);
  }

  it('Escape stands down while a Radix floating layer is open (menu owns Esc)', () => {
    const { container } = renderUi(<Canvas />);
    act(() => useCanvasStore.setState({ selectedIds: ['rect-a'] }));
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-radix-popper-content-wrapper', '');
    document.body.appendChild(wrapper);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useCanvasStore.getState().selectedIds).toEqual(['rect-a']); // untouched
    wrapper.remove();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useCanvasStore.getState().selectedIds).toEqual([]); // cleared now
    void container;
  });

  it('Space pan-arm only in canvas scope — Space on a focused button does not arm grab cursor', () => {
    const { container } = renderUi(<Canvas />);
    const canvasEl = container.firstElementChild as HTMLElement;
    // Button-focused Space (dispatch ON the focused button — the event
    // bubbles to the window listener with target = the button): the button
    // owns the key; the pan-arm must not engage.
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    fireEvent.keyDown(button, { key: ' ', code: 'Space' });
    expect(canvasEl.className).not.toContain('cursor-grab');
    button.remove();
    // Body-focused Space (window target): grab cursor arms (Figma space-pan).
    fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    expect(canvasEl.className).toContain('cursor-grab');
    fireEvent.keyUp(window, { key: ' ', code: 'Space' });
  });

  it('window blur resets the spaceDown pan-arm (alt-tab while holding Space)', () => {
    const { container } = renderUi(<Canvas />);
    const canvasEl = container.firstElementChild as HTMLElement;
    fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    expect(canvasEl.className).toContain('cursor-grab');
    fireEvent(window, new Event('blur'));
    expect(canvasEl.className).not.toContain('cursor-grab');
  });

  it('Enter is not globally hijacked: with a selection, Enter on a focused button does NOT navigate the hierarchy', () => {
    renderUi(<Canvas />);
    act(() => useCanvasStore.setState({ selectedIds: ['frame1'] }));
    // Dispatch ON the focused button — the window listener sees target =
    // button → the control owns Enter (button activation), no nav.
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    fireEvent.keyDown(button, { key: 'Enter' });
    expect(useCanvasStore.getState().selectedIds).toEqual(['frame1']); // nav.child did NOT fire
    button.remove();
    // Same key from canvas scope (window target) still descends (Phase 7).
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(useCanvasStore.getState().selectedIds).toEqual(['rect-b']);
  });

  it('drag phases survive on window-level events (cursor leaves the canvas mid-drag)', () => {
    const sendPatch = vi.fn();
    resetStore();
    act(() => useCanvasStore.setState({ sendPatch }));
    const { container } = renderUi(<Canvas />);
    const rectA = container.querySelector('[data-node-id="rect-a"]') as HTMLElement;
    fireEvent.mouseDown(rectA, { button: 0, clientX: 140, clientY: 100 });
    // The move event fires on WINDOW (the cursor is outside the container).
    fireEvent.mouseMove(window, { clientX: 240, clientY: 200 });
    fireEvent.mouseUp(window, { clientX: 240, clientY: 200 });
    const updates = sendPatch.mock.calls.filter(([p]) => (p as { op?: string })?.op === 'update');
    expect(updates.length).toBeGreaterThan(0);
  });

  it('clicking an L5 culled-subtree placeholder selects the shape it stands in for', () => {
    const { container } = renderUi(<Canvas />);
    const placeholder = document.createElement('div');
    placeholder.setAttribute('data-ac-placeholder', '');
    placeholder.setAttribute('data-node-id', 'ell-1');
    const canvasEl = container.firstElementChild as HTMLElement;
    canvasEl.appendChild(placeholder);
    fireEvent.mouseDown(placeholder, { button: 0, clientX: 10, clientY: 10 });
    expect(useCanvasStore.getState().selectedIds).toEqual(['ell-1']);
    placeholder.remove();
  });
});

// ---- 6. LayersPanel APG tree keyboard -------------------------------------------

describe('LayersPanel: APG tree view keyboard', () => {
  beforeEach(() => {
    resetStore();
    try { window.localStorage.clear(); } catch { /* jsdom may lack it */ }
  });
  afterEach(() => cleanup());

  function row(container: HTMLElement, id: string): HTMLElement {
    return container.querySelector(`[data-ac-layer-row="${id}"]`) as HTMLElement;
  }

  it('rows are treeitems with a single roving tab stop', () => {
    const { container } = render(<LayersPanel />);
    const tree = container.querySelector('[role="tree"]');
    expect(tree).toBeTruthy();
    expect(tree!.getAttribute('aria-label')).toBe('Layers');
    // Render order = zIndex DESC (Figma convention: topmost layer first):
    // ell-1 (z3), then frame1 (z0) with children rect-b (z2), rect-a (z1).
    const rows = container.querySelectorAll('[role="treeitem"]');
    expect(rows.length).toBe(4);
    const tabbables = Array.from(rows).filter((r) => (r as HTMLElement).tabIndex === 0);
    expect(tabbables.length).toBe(1);
    expect((tabbables[0] as HTMLElement).dataset.acLayerRow).toBe('ell-1'); // first row
  });

  it('ArrowDown moves focus; Enter selects; focus does not re-select', () => {
    const { container } = render(<LayersPanel />);
    // Order: ell-1, frame1, rect-b, rect-a.
    const frame1 = row(container, 'frame1');
    const rectB = row(container, 'rect-b');
    frame1.focus();
    fireEvent.keyDown(frame1, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rectB);
    expect(useCanvasStore.getState().selectedIds).toEqual([]); // focus ≠ selection
    fireEvent.keyDown(rectB, { key: 'Enter' });
    expect(useCanvasStore.getState().selectedIds).toEqual(['rect-b']);
  });

  it('ArrowRight on a collapsed container expands; ArrowLeft collapses / ascends', () => {
    const { container } = render(<LayersPanel />);
    const frame1 = row(container, 'frame1');
    frame1.focus();
    // Collapse frame1 (expanded by default) via ArrowLeft.
    fireEvent.keyDown(frame1, { key: 'ArrowLeft' });
    expect(container.querySelector('[data-ac-layer-row="rect-b"]')).toBeNull(); // hidden
    // ArrowRight expands again.
    fireEvent.keyDown(frame1, { key: 'ArrowRight' });
    expect(container.querySelector('[data-ac-layer-row="rect-b"]')).not.toBeNull();
    // ArrowRight on an expanded container focuses the first child (rect-b).
    fireEvent.keyDown(frame1, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(row(container, 'rect-b'));
    // ArrowLeft on a child ascends to the parent.
    fireEvent.keyDown(row(container, 'rect-b'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(frame1);
  });

  it('Space toggles selection; F2 opens the inline rename input', () => {
    const { container } = render(<LayersPanel />);
    const ell = row(container, 'ell-1');
    ell.focus();
    fireEvent.keyDown(ell, { key: ' ' });
    expect(useCanvasStore.getState().selectedIds).toEqual(['ell-1']);
    fireEvent.keyDown(ell, { key: ' ' });
    expect(useCanvasStore.getState().selectedIds).toEqual([]);
    fireEvent.keyDown(ell, { key: 'F2' });
    expect(container.querySelector('[data-ac-layer-row="ell-1"] input')).toBeTruthy();
  });

  it('typeahead jumps to the next row whose name starts with the typed char', () => {
    const { container } = render(<LayersPanel />);
    // Order: ell-1, frame1, rect-b, rect-a — from frame1, 'e' wraps to ell-1.
    const frame1 = row(container, 'frame1');
    frame1.focus();
    fireEvent.keyDown(frame1, { key: 'e' }); // → ell-1
    expect(document.activeElement).toBe(row(container, 'ell-1'));
  });

  it('pages column: treeitem semantics + Enter activates the page', () => {
    const doc = fixtureDoc();
    doc.pages = [
      { id: 'page-1', name: 'Page 1', children: [] } as never,
      { id: 'page-2', name: 'Page 2', children: [] } as never,
    ];
    doc.activePageIndex = 0;
    resetStore(doc);
    const { container } = render(<LayersPanel />);
    const pageTree = container.querySelector('[data-ac-pages-column] [role="tree"]');
    expect(pageTree).toBeTruthy();
    const page2 = container.querySelector('[data-ac-page="page-2"]') as HTMLElement;
    page2.focus();
    fireEvent.keyDown(page2, { key: 'Enter' });
    const last = useCanvasStore.getState().sendPatch as ReturnType<typeof vi.fn> | undefined;
    void last;
    // The patch goes through the real store — assert via the active page patch effect
    // (sendPatch is the store action; we spy on it instead).
  });

  it('pages Enter emits a set_active_page patch (spy)', () => {
    const doc = fixtureDoc();
    doc.pages = [
      { id: 'page-1', name: 'Page 1', children: [] } as never,
      { id: 'page-2', name: 'Page 2', children: [] } as never,
    ];
    doc.activePageIndex = 0;
    resetStore(doc);
    const sendPatch = vi.fn();
    act(() => useCanvasStore.setState({ sendPatch }));
    const { container } = render(<LayersPanel />);
    const page2 = container.querySelector('[data-ac-page="page-2"]') as HTMLElement;
    page2.focus();
    fireEvent.keyDown(page2, { key: 'Enter' });
    const call = sendPatch.mock.calls.find(([p]) => (p as { op?: string }).op === 'set_active_page');
    expect(call).toBeTruthy();
  });
});

// ---- 7. Guides context-menu affordance -------------------------------------------

describe('Guides: right-click opens a menu instead of deleting instantly', () => {
  afterEach(() => cleanup());

  it('contextmenu alone does NOT remove the guide', () => {
    const onRemoveGuide = vi.fn();
    render(
      <Guides
        guideLines={[{ id: 'g1', axis: 'horizontal', position: 100 }]}
        panX={0}
        panY={0}
        zoom={1}
        width={800}
        height={600}
        onRemoveGuide={onRemoveGuide}
      />,
    );
    const hit = document.querySelector('[data-ac-guide-hit="g1"]') as SVGElement;
    expect(hit).toBeTruthy();
    fireEvent.contextMenu(hit);
    // Old behavior: synchronous delete. New: menu affordance — no deletion yet.
    expect(onRemoveGuide).not.toHaveBeenCalled();
  });
});
