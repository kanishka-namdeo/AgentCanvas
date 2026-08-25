// Unit + integration tests — Phase 7 §H.1 Assets tab in the LayersPanel
// (spec docs/html-dom-renderer.md Appendix H §H.1 / §H.3 #1).
//
// Covers:
//   1. LayersPanel renders two Tabs (Layers / Assets); Assets grid lists
//      every reusable component from `collectComponents(document.children)`
//      as a draggable card with `data-ac-asset-id` carrying the component id.
//   2. Empty document → Assets tab shows the "No components yet" empty
//      state (Figma's own first-run copy).
//   3. Tab switching via click toggles which TabsContent is mounted
//      (Radix unmounts the inactive one — that's the perf contract).
//   4. Each card shows the component's `name`.
//   5. dragStart on a card sets `application/x-agentcanvas-component-id`
//      + a `text/plain` fallback on the dataTransfer (HTML5 DnD payload).
//   6. ⌥1 / ⌥2 CustomEvents switch the active tab (the keyboard shortcut
//      path wired in page.tsx; the panel listens for `ac:layers-set-tab`).
//   7. Drop on the Canvas container fires a `place_instance` patch with
//      canvas-space coordinates (verified against the document state — a
//      new PenRef node appears in `document.children`).
//   8. Drop without the COMPONENT_DRAG_MIME payload is ignored (no patch,
//      no drop affordance).
//   9. Pure helpers (screenToCanvas, buildComponentDropPatch,
//      readComponentIdFromDrop) — math + null-gate edge cases.
//
// Test-env path: vitest sets NODE_ENV='test' so the patch coalescer
// (store.ts:519) flushes synchronously — we can assert against
// `document.children` immediately after the drop, no rAF wait.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { useCanvasStore } from '@/lib/canvas/store';
import { useSettings } from '@/lib/settings/store';
import { useSessionStore } from '@/lib/sessions';
import { LayersPanel } from '@/components/canvas/LayersPanel';
import { Canvas } from '@/components/canvas/Canvas';
import { collectComponents } from '@/lib/pen/document';
import {
  COMPONENT_DRAG_MIME,
  buildComponentDropPatch,
  screenToCanvas,
  readComponentIdFromDrop,
} from '@/lib/canvas/assets-drag';
import { createEmptyCanvasDocument } from '@/lib/canvas/types';
import type { CanvasDocument, Viewport } from '@/lib/canvas/types';
import type { PenChild, PenComponent } from '@/lib/pen/types';

// ---- Helpers ----------------------------------------------------------------

/// Radix's TabsTrigger listens for `mousedown` (not `click`) to switch tabs
/// — a real browser fires both on a click gesture, but testing-library's
/// `fireEvent.click` only synthesizes the click event. This helper fires
/// the full sequence so the trigger's onMouseDown runs and the Tabs
/// context calls onValueChange.
function clickTab(trigger: HTMLElement): void {
  fireEvent.mouseDown(trigger);
  fireEvent.mouseUp(trigger);
  fireEvent.click(trigger);
}

/// jsdom's DragEvent constructor IGNORES the `clientX`/`clientY` fields in
/// the init dict (it doesn't merge MouseEventInit for DragEvent), so
/// testing-library's `fireEvent.drop(target, { clientX, clientY })`
/// arrives at the handler as `undefined`. This helper builds a plain
/// `Event` of the right type (jsdom doesn't always expose `DragEvent` as
/// a global, but `Event` is universal) and defines dataTransfer +
/// clientX/clientY as own properties so React's synthetic-event handlers
/// can read them. Wrapped in `act()` so the state updates triggered by
/// the React handler flush synchronously before the test asserts.
function dispatchDrop(
  target: HTMLElement,
  dataTransfer: {
    getData: (mime: string) => string;
    setData: (mime: string, value: string) => void;
    types: readonly string[];
    effectAllowed: string;
    dropEffect: string;
  },
  clientX: number,
  clientY: number,
): void {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer, configurable: true });
  Object.defineProperty(event, 'clientX', { value: clientX, configurable: true });
  Object.defineProperty(event, 'clientY', { value: clientY, configurable: true });
  act(() => {
    target.dispatchEvent(event);
  });
}

/// DragEvent 'dragover' companion — same dataTransfer fix-up + act() wrap.
/// dragover doesn't need client coords (the Canvas only checks types + sets
/// the drop affordance), but the structure mirrors dispatchDrop for clarity.
function dispatchDragOver(
  target: HTMLElement,
  dataTransfer: {
    getData: (mime: string) => string;
    setData: (mime: string, value: string) => void;
    types: readonly string[];
    effectAllowed: string;
    dropEffect: string;
  },
): void {
  const event = new Event('dragover', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer, configurable: true });
  act(() => {
    target.dispatchEvent(event);
  });
}

/// Build a reusable Component node (Figma's `reusable: true` marker — the
/// single field `collectComponents` walks the tree for). The card preview
/// helper in LayersPanel reads `fill` (and the v3 `fills` array) — pass a
/// concrete hex so the test can assert the swatch background.
function makeComponent(
  id: string,
  name: string,
  fill: string,
  children: PenChild[] = [],
): PenComponent {
  return {
    id,
    type: 'component',
    name,
    reusable: true,
    x: 0,
    y: 0,
    width: 120,
    height: 40,
    fill,
    children,
  } as PenComponent;
}

function makeDoc(children: PenChild[] = []): CanvasDocument {
  const doc = createEmptyCanvasDocument('test-doc', 'Test');
  doc.children = children;
  doc.shapes = [];
  return doc;
}

/// jsdom's getBoundingClientRect returns all-zeros by default. We mock it
/// on Element.prototype to a known container size (800×600, origin 0,0)
/// so buildComponentDropPatch's screen→canvas math is verifiable. Tests
/// that need a different offset pass it through `stubClientRect(left, top)`.
function stubClientRect(left = 0, top = 0) {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    left,
    top,
    right: left + 800,
    bottom: top + 600,
    width: 800,
    height: 600,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect);
}

function resetStore(doc: CanvasDocument) {
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

// ---- Tests -------------------------------------------------------------------

describe('LayersPanel — Assets tab (Phase 7 §H.1)', () => {
  beforeEach(() => {
    cleanup();
    useSettings.setState({ renderer: 'svg' });
    stubClientRect(0, 0);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('Assets tab lists every reusable component as a draggable card', () => {
    const doc = makeDoc([
      makeComponent('btn-primary', 'Primary Button', '#3b82f6'),
      makeComponent('card-default', 'Default Card', '#ffffff'),
    ]);
    resetStore(doc);
    const { container } = render(<LayersPanel />);

    // Sanity: collectComponents finds exactly the 2 we put in.
    expect(collectComponents(doc.children).size).toBe(2);

    // Click the Assets trigger (Radix TabsTrigger listens for mousedown —
    // see the `clickTab` helper above).
    const trigger = container.querySelector('[data-ac-tab-trigger="assets"]') as HTMLElement;
    expect(trigger).not.toBeNull();
    clickTab(trigger);

    // Grid + cards appear.
    expect(container.querySelector('[data-ac-assets-grid]')).not.toBeNull();
    const cards = container.querySelectorAll('[data-ac-asset-card]');
    expect(cards.length).toBe(2);
    const ids = Array.from(cards).map((c) => c.getAttribute('data-ac-asset-id'));
    expect(ids.sort()).toEqual(['btn-primary', 'card-default'].sort());
    // Every card is draggable.
    for (const c of cards) {
      expect((c as HTMLElement).draggable).toBe(true);
    }
  });

  it('Empty document → Assets tab shows the "No components yet" empty state', () => {
    const doc = makeDoc([]);
    resetStore(doc);
    const { container } = render(<LayersPanel />);

    clickTab(container.querySelector('[data-ac-tab-trigger="assets"]')!);

    const empty = container.querySelector('[data-ac-assets-empty]');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain('No components yet');
    expect(container.querySelector('[data-ac-assets-grid]')).toBeNull();
  });

  it('Tab switching click: Layers → Assets → Layers toggles content', () => {
    const doc = makeDoc([makeComponent('c1', 'C1', '#f00')]);
    resetStore(doc);
    const { container } = render(<LayersPanel />);

    // Default: Layers tab visible (search input present), Assets grid absent.
    expect(container.querySelector('input[placeholder="Search layers…"]')).not.toBeNull();
    expect(container.querySelector('[data-ac-assets-grid]')).toBeNull();

    // Click Assets → grid appears, Layers content unmounts.
    clickTab(container.querySelector('[data-ac-tab-trigger="assets"]')!);
    expect(container.querySelector('[data-ac-assets-grid]')).not.toBeNull();
    expect(container.querySelector('input[placeholder="Search layers…"]')).toBeNull();

    // Back to Layers → grid unmounts, search reappears.
    clickTab(container.querySelector('[data-ac-tab-trigger="layers"]')!);
    expect(container.querySelector('input[placeholder="Search layers…"]')).not.toBeNull();
    expect(container.querySelector('[data-ac-assets-grid]')).toBeNull();
  });

  it('Each card shows the component name', () => {
    const doc = makeDoc([
      makeComponent('btn-primary', 'Primary Button', '#3b82f6'),
      makeComponent('btn-secondary', 'Secondary', '#94a3b8'),
    ]);
    resetStore(doc);
    const { container } = render(<LayersPanel />);
    clickTab(container.querySelector('[data-ac-tab-trigger="assets"]')!);

    const nameEls = container.querySelectorAll('[data-ac-asset-name]');
    expect(nameEls.length).toBe(2);
    const names = Array.from(nameEls).map((el) => el.textContent ?? '');
    expect(names.sort()).toEqual(['Primary Button', 'Secondary'].sort());
  });

  it('dragStart on a card sets COMPONENT_DRAG_MIME + text/plain payload, effectAllowed=copy', () => {
    const doc = makeDoc([makeComponent('btn-primary', 'Primary Button', '#3b82f6')]);
    resetStore(doc);
    const { container } = render(<LayersPanel />);
    clickTab(container.querySelector('[data-ac-tab-trigger="assets"]')!);
    const card = container.querySelector('[data-ac-asset-card]') as HTMLElement;
    expect(card).not.toBeNull();

    const setData = vi.fn();
    const dataTransfer = {
      setData,
      getData: vi.fn(() => ''),
      types: [] as string[],
      effectAllowed: 'uninitialized' as 'uninitialized' | 'copy' | 'move',
      dropEffect: 'none' as 'none' | 'copy' | 'move',
    };
    fireEvent.dragStart(card, { dataTransfer, clientX: 10, clientY: 10 });

    expect(setData).toHaveBeenCalledWith(COMPONENT_DRAG_MIME, 'btn-primary');
    expect(setData).toHaveBeenCalledWith('text/plain', expect.stringContaining('Primary Button'));
    expect(setData).toHaveBeenCalledWith('text/plain', expect.stringContaining('btn-primary'));
    expect(dataTransfer.effectAllowed).toBe('copy');
  });

  it('⌥1 / ⌥2 CustomEvents switch the active tab via the ac:layers-set-tab channel', () => {
    const doc = makeDoc([makeComponent('c1', 'C1', '#f00')]);
    resetStore(doc);
    const { container } = render(<LayersPanel />);

    // Default = Layers.
    expect(container.querySelector('input[placeholder="Search layers…"]')).not.toBeNull();
    expect(container.querySelector('[data-ac-assets-grid]')).toBeNull();

    // ⌥2 → Assets.
    act(() => {
      window.dispatchEvent(new CustomEvent('ac:layers-set-tab', { detail: 'assets' }));
    });
    expect(container.querySelector('[data-ac-assets-grid]')).not.toBeNull();
    expect(container.querySelector('input[placeholder="Search layers…"]')).toBeNull();

    // ⌥1 → Layers.
    act(() => {
      window.dispatchEvent(new CustomEvent('ac:layers-set-tab', { detail: 'layers' }));
    });
    expect(container.querySelector('input[placeholder="Search layers…"]')).not.toBeNull();
    expect(container.querySelector('[data-ac-assets-grid]')).toBeNull();
  });
});

describe('Canvas — component drop places a linked instance (Phase 7 §H.1)', () => {
  beforeEach(() => {
    cleanup();
    useSettings.setState({ renderer: 'svg' });
    stubClientRect(0, 0);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('Drop with COMPONENT_DRAG_MIME → place_instance patch → PenRef at cursor canvas-space coords', () => {
    const doc = makeDoc([makeComponent('btn-primary', 'Primary Button', '#3b82f6')]);
    resetStore(doc);
    const before = useCanvasStore.getState().document.children.length;

    const { container } = render(<Canvas />);
    const root = container.firstElementChild as HTMLElement;

    // Viewport defaults to {zoom:1, panX:120, panY:80}; rect origin (0,0)
    // (stubbed). Drop at clientX=200, clientY=100 →
    //   canvasX = (200 - 0 - 120) / 1 = 80
    //   canvasY = (100 - 0 -  80) / 1 = 20
    const dataTransfer = {
      getData: (m: string) => (m === COMPONENT_DRAG_MIME ? 'btn-primary' : ''),
      setData: vi.fn(),
      types: [COMPONENT_DRAG_MIME],
      effectAllowed: 'copy' as 'copy' | 'move',
      dropEffect: 'copy' as 'copy' | 'move',
    };

    // Drag-over paints the drop affordance.
    dispatchDragOver(root, dataTransfer);
    expect(container.querySelector('[data-ac-drop-target]')).not.toBeNull();

    // Drop fires the patch synchronously (test-env flush).
    dispatchDrop(root, dataTransfer, 200, 100);

    const after = useCanvasStore.getState().document;
    expect(after.children.length).toBe(before + 1);
    const placed = after.children[after.children.length - 1] as unknown as {
      type: string;
      ref: string;
      x: number;
      y: number;
    };
    expect(placed.type).toBe('ref');
    expect(placed.ref).toBe('btn-primary');
    expect(placed.x).toBe(80);
    expect(placed.y).toBe(20);
    // Drop affordance cleared after the drop.
    expect(container.querySelector('[data-ac-drop-target]')).toBeNull();
  });

  it('Drag without COMPONENT_DRAG_MIME is ignored (no affordance, no patch, no doc change)', () => {
    const doc = makeDoc([makeComponent('c1', 'C1', '#f00')]);
    resetStore(doc);
    const before = useCanvasStore.getState().document.children.length;

    const { container } = render(<Canvas />);
    const root = container.firstElementChild as HTMLElement;

    const dataTransfer = {
      getData: () => '',
      setData: vi.fn(),
      types: ['text/plain'], // not our mime — e.g. a layer-row reparent drag
      effectAllowed: 'move' as 'copy' | 'move',
      dropEffect: 'move' as 'copy' | 'move',
    };

    dispatchDragOver(root, dataTransfer);
    expect(container.querySelector('[data-ac-drop-target]')).toBeNull();
    dispatchDrop(root, dataTransfer, 200, 100);
    expect(useCanvasStore.getState().document.children.length).toBe(before);
  });
});

describe('assets-drag helpers (pure math)', () => {
  it('screenToCanvas applies the inverse pan/zoom transform', () => {
    const vp: Viewport = { zoom: 2, panX: 100, panY: 50 };
    const { x, y } = screenToCanvas(220, 270, { left: 0, top: 0 }, vp);
    // (220 - 0 - 100) / 2 = 60; (270 - 0 - 50) / 2 = 110
    expect(x).toBe(60);
    expect(y).toBe(110);
  });

  it('screenToCanvas honors container offset', () => {
    const vp: Viewport = { zoom: 1, panX: 0, panY: 0 };
    const { x, y } = screenToCanvas(150, 250, { left: 50, top: 50 }, vp);
    expect(x).toBe(100);
    expect(y).toBe(200);
  });

  it('buildComponentDropPatch returns a place_instance patch with x/y + componentId', () => {
    const vp: Viewport = { zoom: 1, panX: 120, panY: 80 };
    const patch = buildComponentDropPatch('comp-x', 320, 180, { left: 0, top: 0 }, vp);
    expect(patch).not.toBeNull();
    expect(patch!.op).toBe('place_instance');
    expect(patch!.componentId).toBe('comp-x');
    expect(patch!.shape?.x).toBe(200);
    expect(patch!.shape?.y).toBe(100);
  });

  it('buildComponentDropPatch returns null for empty componentId', () => {
    const vp: Viewport = { zoom: 1, panX: 0, panY: 0 };
    expect(buildComponentDropPatch('', 100, 100, { left: 0, top: 0 }, vp)).toBeNull();
  });

  it('readComponentIdFromDrop returns the id carried by the mime', () => {
    const dt = { getData: (m: string) => (m === COMPONENT_DRAG_MIME ? 'abc-123' : '') };
    expect(readComponentIdFromDrop(dt)).toBe('abc-123');
  });

  it('readComponentIdFromDrop returns null when the mime payload is absent', () => {
    const dt = { getData: () => '' };
    expect(readComponentIdFromDrop(dt)).toBeNull();
  });
});
