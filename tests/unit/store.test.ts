// Tests for the canvas store's undo/redo behavior.
//
// We test the store's undo/redo actions directly by setting state and
// calling actions, bypassing the `init()` action (which opens a WebSocket
// and is unsuitable for unit tests).
//
// Coverage:
//   - undo() pops the undo stack and pushes current to redo stack
//   - redo() pops the redo stack and pushes current to undo stack
//   - undo() / redo() are no-ops when the respective stack is empty
//   - undo stack is capped at 50 entries
//   - _onSync({type: 'canvas:patch', patch: {op: 'undo'}}) calls undo()
//   - _onSync({type: 'canvas:patch', patch: {op: 'redo'}}) calls redo()
//   - _onSync pushes the current document to undoStack before applying
//     any mutating patch (op !== 'select')
//   - _onSync does NOT push for non-mutating 'select' patches
//   - _onSync clears the redoStack on every mutating patch

import { describe, it, expect, beforeEach } from 'vitest';
import { useCanvasStore } from '@/lib/canvas/store';
import { useSessionStore } from '@/lib/sessions';
import type { CanvasDocument, CanvasPatch, Shape } from '@/lib/canvas/types';

// ---- Fixtures ----------------------------------------------------------------

function makeDoc(shapes: Shape[] = []): CanvasDocument {
  return {
    id: 'test-doc',
    name: 'Test',
    background: '#ffffff',
    viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes,
    tokens: { colors: [], textStyles: [] },
    heatmap: null,
  };
}

function makeShape(id: string, fill = '#cccccc'): Shape {
  return {
    id,
    type: 'rectangle',
    name: id,
    x: 0, y: 0, width: 100, height: 100,
    rotation: 0, opacity: 1,
    fill, stroke: '#000', strokeWidth: 0,
    radius: 0, fontSize: 16, textColor: '#000',
    parentId: null, zIndex: 0,
    locked: false, visible: true,
    autoLayout: null, tokenBinding: null, componentId: null,
    points: null, closed: false, src: null, radii: null,
    gradient: null, shadow: null, blur: 0, maskId: null,
  };
}

function patch(p: Partial<CanvasPatch> & { op: CanvasPatch['op'] }): CanvasPatch {
  return { summary: 'test', ...p };
}

/// Reset the store to a known state before each test.
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
  // Also reset the session store so its persisted state doesn't leak.
  useSessionStore.setState({
    sessions: {},
    runs: {},
    messages: {},
    toolCalls: {},
    snapshots: {},
    activeSessionByDoc: {},
    activeRunBySession: {},
    _hydrated: true,
  });
}

// ---- Tests -------------------------------------------------------------------

describe('store: undo() action', () => {
  beforeEach(() => resetStore());

  it('pops the undo stack and pushes the current doc to redo', () => {
    const docA = makeDoc([makeShape('a')]);
    const docB = makeDoc([makeShape('a'), makeShape('b')]);
    resetStore(docB);
    useCanvasStore.setState({ undoStack: [docA], redoStack: [] });

    useCanvasStore.getState().undo();

    const s = useCanvasStore.getState();
    expect(s.document).toBe(docA);
    expect(s.undoStack).toHaveLength(0);
    expect(s.redoStack).toHaveLength(1);
    expect(s.redoStack[0]).toBe(docB);
  });

  it('is a no-op when the undo stack is empty', () => {
    const doc = makeDoc([makeShape('a')]);
    resetStore(doc);
    useCanvasStore.setState({ undoStack: [], redoStack: [] });

    useCanvasStore.getState().undo();

    const s = useCanvasStore.getState();
    expect(s.document).toBe(doc);
    expect(s.undoStack).toHaveLength(0);
    expect(s.redoStack).toHaveLength(0);
  });

  it('caps the redo stack at 50 entries', () => {
    const doc = makeDoc([makeShape('a')]);
    resetStore(doc);
    // Pre-fill undoStack with 60 entries — undo() will pop one and push
    // current to redo, but redo should be capped at 50.
    const undoDocs = Array.from({ length: 60 }, (_, i) =>
      makeDoc([makeShape(`undo-${i}`)]),
    );
    const redoDocs = Array.from({ length: 50 }, (_, i) =>
      makeDoc([makeShape(`redo-${i}`)]),
    );
    useCanvasStore.setState({ undoStack: undoDocs, redoStack: redoDocs });

    useCanvasStore.getState().undo();

    const s = useCanvasStore.getState();
    // Redo should have grown by 1 then been sliced to 50.
    expect(s.redoStack).toHaveLength(50);
    expect(s.redoStack[49]).toBe(doc); // current was pushed
  });
});

describe('store: redo() action', () => {
  beforeEach(() => resetStore());

  it('pops the redo stack and pushes the current doc to undo', () => {
    const docA = makeDoc([makeShape('a')]);
    const docB = makeDoc([makeShape('a'), makeShape('b')]);
    resetStore(docA);
    useCanvasStore.setState({ undoStack: [], redoStack: [docB] });

    useCanvasStore.getState().redo();

    const s = useCanvasStore.getState();
    expect(s.document).toBe(docB);
    expect(s.redoStack).toHaveLength(0);
    expect(s.undoStack).toHaveLength(1);
    expect(s.undoStack[0]).toBe(docA);
  });

  it('is a no-op when the redo stack is empty', () => {
    const doc = makeDoc([makeShape('a')]);
    resetStore(doc);
    useCanvasStore.setState({ undoStack: [], redoStack: [] });

    useCanvasStore.getState().redo();

    const s = useCanvasStore.getState();
    expect(s.document).toBe(doc);
  });

  it('caps the undo stack at 50 entries', () => {
    const doc = makeDoc([makeShape('current')]);
    resetStore(doc);
    const undoDocs = Array.from({ length: 50 }, (_, i) =>
      makeDoc([makeShape(`undo-${i}`)]),
    );
    const redoDocs = Array.from({ length: 60 }, (_, i) =>
      makeDoc([makeShape(`redo-${i}`)]),
    );
    useCanvasStore.setState({ undoStack: undoDocs, redoStack: redoDocs });

    useCanvasStore.getState().redo();

    const s = useCanvasStore.getState();
    expect(s.undoStack).toHaveLength(50);
    expect(s.undoStack[49]).toBe(doc); // current was pushed
  });
});

describe('store: _onSync canvas:patch — undo/redo interception', () => {
  beforeEach(() => resetStore());

  it('intercepts op=undo and calls undo()', () => {
    const docA = makeDoc([makeShape('a')]);
    const docB = makeDoc([makeShape('a'), makeShape('b')]);
    resetStore(docB);
    useCanvasStore.setState({ undoStack: [docA], redoStack: [] });

    useCanvasStore.getState()._onSync({
      type: 'canvas:patch',
      patch: patch({ op: 'undo' }),
    });

    expect(useCanvasStore.getState().document).toBe(docA);
    expect(useCanvasStore.getState().undoStack).toHaveLength(0);
  });

  it('intercepts op=redo and calls redo()', () => {
    const docA = makeDoc([makeShape('a')]);
    const docB = makeDoc([makeShape('a'), makeShape('b')]);
    resetStore(docA);
    useCanvasStore.setState({ undoStack: [], redoStack: [docB] });

    useCanvasStore.getState()._onSync({
      type: 'canvas:patch',
      patch: patch({ op: 'redo' }),
    });

    expect(useCanvasStore.getState().document).toBe(docB);
    expect(useCanvasStore.getState().redoStack).toHaveLength(0);
  });
});

describe('store: _onSync canvas:patch — undo stack push behavior', () => {
  beforeEach(() => resetStore());

  it('pushes the current document to undoStack before applying a mutating patch', () => {
    const docBefore = makeDoc([makeShape('a', '#ff0000')]);
    resetStore(docBefore);

    useCanvasStore.getState()._onSync({
      type: 'canvas:patch',
      patch: patch({
        op: 'update',
        shapeId: 'a',
        shape: { fill: '#00ff00' },
      }),
    });

    const s = useCanvasStore.getState();
    expect(s.undoStack).toHaveLength(1);
    expect(s.undoStack[0]).toBe(docBefore); // the pre-mutation reference
    expect(s.document.shapes[0].fill).toBe('#00ff00'); // mutation applied
  });

  it('clears the redoStack on every mutating patch', () => {
    const doc = makeDoc([makeShape('a')]);
    resetStore(doc);
    useCanvasStore.setState({
      undoStack: [],
      redoStack: [makeDoc([makeShape('r1')]), makeDoc([makeShape('r2')])],
    });

    useCanvasStore.getState()._onSync({
      type: 'canvas:patch',
      patch: patch({ op: 'add', shape: { id: 'b', type: 'rectangle' } }),
    });

    expect(useCanvasStore.getState().redoStack).toHaveLength(0);
  });

  it('does NOT push to undoStack for non-mutating select patches', () => {
    const doc = makeDoc([makeShape('a')]);
    resetStore(doc);

    useCanvasStore.getState()._onSync({
      type: 'canvas:patch',
      patch: patch({ op: 'select', shapeIds: ['a'] }),
    });

    expect(useCanvasStore.getState().undoStack).toHaveLength(0);
    // But the agentHighlightIds should have been set (select highlights).
    expect(useCanvasStore.getState().agentHighlightIds).toEqual(['a']);
  });

  it('does NOT clear redoStack for non-mutating select patches', () => {
    const doc = makeDoc([makeShape('a')]);
    resetStore(doc);
    const redoDocs = [makeDoc([makeShape('r1')]), makeDoc([makeShape('r2')])];
    useCanvasStore.setState({ redoStack: redoDocs });

    useCanvasStore.getState()._onSync({
      type: 'canvas:patch',
      patch: patch({ op: 'select', shapeIds: ['a'] }),
    });

    expect(useCanvasStore.getState().redoStack).toEqual(redoDocs);
  });

  it('caps undoStack at 50 entries on push', () => {
    const doc = makeDoc([makeShape('a')]);
    resetStore(doc);
    const undoDocs = Array.from({ length: 50 }, (_, i) =>
      makeDoc([makeShape(`u-${i}`)]),
    );
    useCanvasStore.setState({ undoStack: undoDocs });

    useCanvasStore.getState()._onSync({
      type: 'canvas:patch',
      patch: patch({ op: 'add', shape: { id: 'b', type: 'rectangle' } }),
    });

    const s = useCanvasStore.getState();
    expect(s.undoStack).toHaveLength(50); // capped
    // The oldest entry should have been dropped; the newest should be `doc`.
    expect(s.undoStack[49]).toBe(doc);
    expect(s.undoStack[0]).not.toBe(undoDocs[0]); // oldest dropped
  });

  it('handles a full undo/redo cycle correctly', () => {
    // Start with doc1, apply a mutation → doc2, undo → doc1, redo → doc2.
    const doc1 = makeDoc([makeShape('a', '#ff0000')]);
    resetStore(doc1);

    // Mutate: change fill to green.
    useCanvasStore.getState()._onSync({
      type: 'canvas:patch',
      patch: patch({ op: 'update', shapeId: 'a', shape: { fill: '#00ff00' } }),
    });
    const doc2 = useCanvasStore.getState().document;
    expect(doc2.shapes[0].fill).toBe('#00ff00');
    expect(useCanvasStore.getState().undoStack).toHaveLength(1);
    expect(useCanvasStore.getState().undoStack[0]).toBe(doc1);

    // Undo.
    useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().document).toBe(doc1);
    expect(useCanvasStore.getState().undoStack).toHaveLength(0);
    expect(useCanvasStore.getState().redoStack).toHaveLength(1);
    expect(useCanvasStore.getState().redoStack[0]).toBe(doc2);

    // Redo.
    useCanvasStore.getState().redo();
    expect(useCanvasStore.getState().document).toBe(doc2);
    expect(useCanvasStore.getState().redoStack).toHaveLength(0);
    expect(useCanvasStore.getState().undoStack).toHaveLength(1);
    expect(useCanvasStore.getState().undoStack[0]).toBe(doc1);
  });

  it('handles multiple sequential mutations then undoes back through them', () => {
    const doc0 = makeDoc([]);
    resetStore(doc0);

    // Apply 3 mutations.
    useCanvasStore.getState()._onSync({
      type: 'canvas:patch',
      patch: patch({ op: 'add', shape: { id: 'a', type: 'rectangle' } }),
    });
    useCanvasStore.getState()._onSync({
      type: 'canvas:patch',
      patch: patch({ op: 'add', shape: { id: 'b', type: 'rectangle' } }),
    });
    useCanvasStore.getState()._onSync({
      type: 'canvas:patch',
      patch: patch({ op: 'add', shape: { id: 'c', type: 'rectangle' } }),
    });
    expect(useCanvasStore.getState().document.shapes.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(useCanvasStore.getState().undoStack).toHaveLength(3);

    // Undo 3 times → back to empty.
    useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().document.shapes.map((s) => s.id)).toEqual(['a', 'b']);
    useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().document.shapes.map((s) => s.id)).toEqual(['a']);
    useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().document.shapes).toEqual([]);
    expect(useCanvasStore.getState().undoStack).toHaveLength(0);

    // One more undo is a no-op.
    useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().document.shapes).toEqual([]);
  });
});

describe('store: _onSync canvas:patch — op coverage for new ops', () => {
  beforeEach(() => resetStore());

  it('zorder patches are pushed to undo stack (mutating)', () => {
    const doc = makeDoc([makeShape('a'), makeShape('b')]);
    resetStore(doc);

    useCanvasStore.getState()._onSync({
      type: 'canvas:patch',
      patch: patch({ op: 'zorder', shapeIds: ['a'], zorderKind: 'front' }),
    });

    expect(useCanvasStore.getState().undoStack).toHaveLength(1);
    expect(useCanvasStore.getState().document.shapes.map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('reorder patches are pushed to undo stack (mutating)', () => {
    const doc = makeDoc([makeShape('a'), makeShape('b'), makeShape('c')]);
    resetStore(doc);

    useCanvasStore.getState()._onSync({
      type: 'canvas:patch',
      patch: patch({ op: 'reorder', shapeId: 'c', zIndex: 0 }),
    });

    expect(useCanvasStore.getState().undoStack).toHaveLength(1);
    expect(useCanvasStore.getState().document.shapes.map((s) => s.id)).toEqual(['c', 'a', 'b']);
  });

  it('viewport patches are pushed to undo stack (mutating)', () => {
    const doc = makeDoc([]);
    resetStore(doc);

    useCanvasStore.getState()._onSync({
      type: 'canvas:patch',
      patch: patch({ op: 'viewport', viewport: { zoom: 2, panX: 50, panY: 25 } }),
    });

    expect(useCanvasStore.getState().undoStack).toHaveLength(1);
    expect(useCanvasStore.getState().document.viewport).toEqual({ zoom: 2, panX: 50, panY: 25 });
  });
});
