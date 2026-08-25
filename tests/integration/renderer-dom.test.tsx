// Integration tests — the DOM renderer (parity mode, spec Phase 1) reflects
// document state driven through the store.
//
// Mirror of tests/integration/renderer.test.tsx for renderer === 'dom':
//   - Set up `useCanvasStore` with an initial document.
//   - Force the renderer flag via the settings store (the same store the
//     Settings → Appearance select writes).
//   - Drive mutations through `_onSync({type:'canvas:patch', patch})` in act().
//   - Render the `Canvas` component and assert via the DOM data-attribute
//     contract (spec Appendix C) instead of SVG tag selectors.
//
// Covered: initial render, add/update/remove, undo/redo, text content,
// multi-select chrome outlines, bulk_add, group nesting.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { useCanvasStore } from '@/lib/canvas/store';
import { useSessionStore } from '@/lib/sessions';
import { useSettings } from '@/lib/settings/store';
import { Canvas } from '@/components/canvas/Canvas';
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
}

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

describe('DOM renderer integration: document mutations appear as DOM nodes', () => {
  beforeEach(() => {
    resetStore();
    cleanup();
    // Force the DOM renderer (Settings → Appearance → Canvas renderer).
    useSettings.setState({ renderer: 'dom' });
  });

  afterEach(() => {
    // Restore the default so nothing leaks (defensive — vitest isolates
    // environments per file, but the settings store persists to localStorage).
    useSettings.setState({ renderer: 'svg' });
  });

  it('renders an empty canvas with no nodes and no svg world', () => {
    const { container } = render(<Canvas />);
    expect(container.querySelectorAll('[data-node-id]')).toHaveLength(0);
    // The DOM renderer mounts the world container + chrome overlay…
    expect(container.querySelector('[data-ac-world]')).not.toBeNull();
    expect(container.querySelector('[data-ac-chrome]')).not.toBeNull();
    // …and no classic <svg> paint tree (no <defs> — SvgCanvas always emits
    // one; the only svgs left are chrome/empty-state icons outside the world).
    expect(container.querySelector('[data-ac-world] svg')).toBeNull();
    expect(container.querySelector('defs')).toBeNull();
  });

  it('renders a node div after a canvas:patch add op', () => {
    const { container } = render(<Canvas />);
    applyPatch({
      op: 'add',
      shape: { type: 'rectangle', name: 'Card', x: 10, y: 10, width: 80, height: 50, fill: '#ff0000', id: 'r1' },
      summary: 'add rect',
    });
    const node = container.querySelector('[data-node-id="r1"]');
    expect(node).not.toBeNull();
    expect(node!.getAttribute('data-node-type')).toBe('rectangle');
    expect((node as HTMLElement).style.background).toBe('rgb(255, 0, 0)');
  });

  it('reflects an update patch — fill changes appear in the node background', () => {
    resetStore(makeDoc([makeShape('r1', { fill: '#ff0000' })]));
    const { container } = render(<Canvas />);

    const before = container.querySelector('[data-node-id="r1"]') as HTMLElement;
    expect(before).not.toBeNull();
    expect(before.style.background).toBe('rgb(255, 0, 0)');

    applyPatch({
      op: 'update',
      shapeId: 'r1',
      shape: { fill: '#0000ff' },
      summary: 'recolor',
    });

    const after = container.querySelector('[data-node-id="r1"]') as HTMLElement;
    expect(after.style.background).toBe('rgb(0, 0, 255)');
  });

  it('reflects a remove patch — the node disappears', () => {
    resetStore(makeDoc([makeShape('r1'), makeShape('r2')]));
    const { container } = render(<Canvas />);
    expect(container.querySelectorAll('[data-node-id]')).toHaveLength(2);

    applyPatch({ op: 'remove', shapeIds: ['r1'], summary: 'remove r1' });

    expect(container.querySelectorAll('[data-node-id]')).toHaveLength(1);
    expect(container.querySelector('[data-node-id="r1"]')).toBeNull();
    expect(container.querySelector('[data-node-id="r2"]')).not.toBeNull();
  });

  it('reflects undo/redo of an add patch', () => {
    const { container } = render(<Canvas />);
    applyPatch({
      op: 'add',
      shape: { type: 'rectangle', name: 'Card', x: 0, y: 0, width: 100, height: 100, fill: '#00ff00', id: 'u1' },
      summary: 'add',
    });
    expect(container.querySelector('[data-node-id="u1"]')).not.toBeNull();

    undo();
    expect(container.querySelector('[data-node-id="u1"]')).toBeNull();

    redo();
    expect(container.querySelector('[data-node-id="u1"]')).not.toBeNull();
  });

  it('renders a text layer with its text string', () => {
    const { container } = render(<Canvas />);
    applyPatch({
      op: 'add',
      shape: { type: 'text', name: 'Heading', x: 0, y: 0, width: 200, height: 32, text: 'Hello world', fontSize: 24, textColor: '#0f172a', id: 't1' },
      summary: 'add text',
    });
    const node = container.querySelector('[data-node-type="text"]');
    expect(node).not.toBeNull();
    expect(node!.textContent).toContain('Hello world');
  });

  it('multi-select renders one selection outline + 8 handles per node in the chrome overlay', () => {
    resetStore(makeDoc([makeShape('r1'), makeShape('r2', { x: 200 })]));
    act(() => {
      useCanvasStore.setState({ selectedIds: ['r1', 'r2'] });
    });
    const { container } = render(<Canvas />);
    const chrome = container.querySelector('[data-ac-chrome]');
    expect(chrome).not.toBeNull();
    // 2 selection outlines (one per selected node)…
    expect(chrome!.querySelectorAll('[data-chrome-selection]')).toHaveLength(2);
    // …and 8 resize handles per selected node = 16 total.
    expect(chrome!.querySelectorAll('[data-chrome-handle]')).toHaveLength(16);
  });

  it('deselecting removes the chrome outlines without touching the world tree', () => {
    resetStore(makeDoc([makeShape('r1')]));
    act(() => {
      useCanvasStore.setState({ selectedIds: ['r1'] });
    });
    const { container } = render(<Canvas />);
    expect(container.querySelectorAll('[data-chrome-selection]')).toHaveLength(1);
    act(() => {
      useCanvasStore.setState({ selectedIds: [] });
    });
    expect(container.querySelectorAll('[data-chrome-selection]')).toHaveLength(0);
    // World tree untouched by the selection change.
    expect(container.querySelector('[data-node-id="r1"]')).not.toBeNull();
  });

  it('bulk_add of N nodes renders N node divs', () => {
    const { container } = render(<Canvas />);
    const shapes = Array.from({ length: 12 }, (_, i) => ({
      type: 'rectangle', name: `N${i}`, x: i * 60, y: 0, width: 50, height: 50, fill: '#0000ff', id: `ba${i}`,
    }));
    applyPatch({ op: 'bulk_add', shapes, summary: 'bulk add 12' });
    expect(container.querySelectorAll('[data-node-id]')).toHaveLength(12);
    expect(container.querySelectorAll('[data-node-type="rectangle"]')).toHaveLength(12);
  });

  it('group + children nest — child node is a DOM descendant of the group node', () => {
    resetStore(
      makeDoc([
        makeShape('g1', { type: 'group', x: 100, y: 100, width: 300, height: 200 }),
        makeShape('c1', { x: 150, y: 130, parentId: 'g1' }),
      ]),
    );
    const { container } = render(<Canvas />);
    const groupEl = container.querySelector('[data-node-id="g1"]') as HTMLElement;
    expect(groupEl).not.toBeNull();
    expect(groupEl.getAttribute('data-node-type')).toBe('group');
    const childEl = container.querySelector('[data-node-id="c1"]') as HTMLElement;
    expect(childEl).not.toBeNull();
    // The child lives INSIDE the group div (real DOM nesting), positioned
    // relative to the group's absolute origin.
    expect(groupEl.contains(childEl)).toBe(true);
    expect(childEl.style.left).toBe('50px'); // 150 - 100
    expect(childEl.style.top).toBe('30px'); // 130 - 100
  });

  it('hidden nodes stay mounted (visibility:hidden) with the data contract intact', () => {
    resetStore(makeDoc([makeShape('h1', { visible: false, fill: '#abcdef' })]));
    const { container } = render(<Canvas />);
    const node = container.querySelector('[data-node-id="h1"]') as HTMLElement;
    expect(node).not.toBeNull();
    expect(node.style.visibility).toBe('hidden');
  });
});
