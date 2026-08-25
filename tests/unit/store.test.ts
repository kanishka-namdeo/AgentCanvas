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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useCanvasStore } from '@/lib/canvas/store';
import { useSessionStore } from '@/lib/sessions';
import type { CanvasDocument, CanvasPatch, Shape } from '@/lib/canvas/types'
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
    constraints: null,
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

  it('reparent patches are pushed to undo stack (mutating)', () => {
    // Figma-hierarchy reparent op should be treated as mutating (undo-able).
    const frame = { ...makeShape('frame'), type: 'frame' as const };
    const rect = makeShape('rect');
    const doc = makeDoc([frame, rect]);
    resetStore(doc);

    useCanvasStore.getState()._onSync({
      type: 'canvas:patch',
      patch: patch({
        op: 'reparent',
        shapeId: 'rect',
        newParentId: 'frame',
        keepAbsolutePosition: true,
      }),
    });

    expect(useCanvasStore.getState().undoStack).toHaveLength(1);
    // After reparent, rect should be inside frame.
    const rectShape = useCanvasStore.getState().document.shapes.find((s) => s.id === 'rect');
    expect(rectShape?.parentId).toBe('frame');
  });

  it('set_constraints patches are pushed to undo stack (mutating)', () => {
    const rect = makeShape('rect');
    const doc = makeDoc([rect]);
    resetStore(doc);

    useCanvasStore.getState()._onSync({
      type: 'canvas:patch',
      patch: patch({
        op: 'set_constraints',
        shapeId: 'rect',
        constraints: { horizontal: 'left_right', vertical: 'top_bottom' },
      }),
    });

    expect(useCanvasStore.getState().undoStack).toHaveLength(1);
    const rectShape = useCanvasStore.getState().document.shapes.find((s) => s.id === 'rect');
    expect(rectShape?.constraints).toEqual({ horizontal: 'left_right', vertical: 'top_bottom' });
  });
});

// ---- HTTP fallback single-apply (D5) ----------------------------------------

describe('store: promptAgent HTTP fallback — single-apply (D5)', () => {
  beforeEach(() => resetStore());

  // Regression: the fallback path used to apply every patch TWICE — once
  // inline (`set(document: applyPatchToCanvas(...))`) and again inside
  // `_onSync`'s canvas:patch handler. An `add` with a fixed id produced two
  // tree nodes with the SAME id, masked only by the renderer's render-time
  // id dedupe. `_onSync` must be the single applier in the fallback path.
  it('applies each streamed patch exactly once (no duplicate ids)', async () => {
    const doc = makeDoc([]);
    resetStore(doc);

    const patchLine =
      JSON.stringify({
        type: 'patch',
        patch: { op: 'add', shapeId: 'only-one', shape: { id: 'only-one', type: 'rectangle', name: 'Solo', x: 0, y: 0, width: 10, height: 10 }, summary: 'add one' },
      }) + '\n';
    const encoder = new TextEncoder();
    let sent = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return {
        ok: true,
        body: {
          getReader: () => ({
            read: async () => {
              if (sent) return { done: true, value: undefined };
              sent = true;
              return { done: false, value: encoder.encode(patchLine) };
            },
          }),
        },
      };
    }) as unknown as typeof fetch;

    try {
      // socket is null + connected is false → the HTTP fallback path runs.
      useCanvasStore.getState().promptAgent('draw one rectangle');
      // The fallback is an un-awaited async loop; wait for turn_end to flip
      // agentBusy back to false.
      await vi.waitFor(() => {
        expect(useCanvasStore.getState().agentBusy).toBe(false);
      });

      const s = useCanvasStore.getState();
      // Exactly ONE node with the fixed id in the resolved render cache...
      const matches = s.document.shapes.filter((sh) => sh.id === 'only-one');
      expect(matches).toHaveLength(1);
      // ...and exactly one in the .pen tree.
      const treeMatches = s.document.children.filter((c) => c.id === 'only-one');
      expect(treeMatches).toHaveLength(1);
      // The patch went through _onSync, so it pushed exactly one undo entry.
      expect(s.undoStack).toHaveLength(1);
      // And undo restores the pre-patch document.
      s.undo();
      expect(useCanvasStore.getState().document.shapes.map((sh) => sh.id)).not.toContain('only-one');
    } finally {
      globalThis.fetch = originalFetch as typeof fetch;
    }
  });

  it('streams multiple patches and applies each exactly once', async () => {
    const doc = makeDoc([]);
    resetStore(doc);

    const lines = [
      JSON.stringify({ type: 'patch', patch: { op: 'add', shapeId: 'a', shape: { id: 'a', type: 'rectangle', name: 'A', x: 0, y: 0, width: 10, height: 10 }, summary: 'add a' } }),
      JSON.stringify({ type: 'patch', patch: { op: 'add', shapeId: 'b', shape: { id: 'b', type: 'ellipse', name: 'B', x: 20, y: 0, width: 10, height: 10 }, summary: 'add b' } }),
      JSON.stringify({ type: 'agent_event', event: { type: 'agent:message_delta', text: 'done' } }),
    ].join('\n') + '\n';
    const encoder = new TextEncoder();
    let sent = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: encoder.encode(lines) };
          },
        }),
      },
    })) as unknown as typeof fetch;

    try {
      useCanvasStore.getState().promptAgent('draw two shapes');
      await vi.waitFor(() => {
        expect(useCanvasStore.getState().agentBusy).toBe(false);
      });
      const s = useCanvasStore.getState();
      expect(s.document.shapes.map((sh) => sh.id)).toEqual(['a', 'b']);
      expect(s.undoStack).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch as typeof fetch;
    }
  });
});

// ---- Client round-trip handlers (Phase 3, M2-c) -----------------------------------
//
// agent:computed_request → reads the live DOM (querySelector data-node-id +
// getComputedStyle + getBoundingClientRect) and POSTs the results to
// /api/agent/client-responses. agent:screenshot_request without a world
// element POSTs the 'no-dom-renderer' error. Fetch is mocked to capture the
// POST payload shape (jsdom rects are all-zero — geometry assertions stay
// structural).

describe('store: client round-trip handlers', () => {
  interface CapturedPost {
    url: string;
    body: any;
  }

  function captureFetch(): { posts: CapturedPost[]; restore: () => void } {
    const posts: CapturedPost[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: any) => {
      posts.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
      return { ok: true } as any;
    }) as unknown as typeof fetch;
    return {
      posts,
      restore: () => {
        globalThis.fetch = originalFetch as typeof fetch;
      },
    };
  }

  let mounted: HTMLElement[];

  beforeEach(() => {
    resetStore(makeDoc([]));
    useCanvasStore.setState({ worldElement: null });
    mounted = [];
  });

  afterEach(() => {
    for (const el of mounted) el.remove();
    useCanvasStore.setState({ worldElement: null });
  });

  function mountNode(id: string, style = 'display:flex;background-color:rgb(14,165,233);'): HTMLElement {
    const el = document.createElement('div');
    el.setAttribute('data-node-id', id);
    el.setAttribute('style', style);
    document.body.appendChild(el);
    mounted.push(el);
    return el;
  }

  it('agent:computed_request reads the live DOM and POSTs results to /api/agent/client-responses', async () => {
    mountNode('live-1');
    const { posts, restore } = captureFetch();
    try {
      useCanvasStore.getState()._onSync({
        type: 'agent:computed_request',
        toolCallId: 'tc-1',
        nodeIds: ['live-1', 'not-mounted'],
      });
      await vi.waitFor(() => {
        expect(posts.length).toBeGreaterThanOrEqual(1);
      });
      const post = posts.find((p) => p.url.includes('/api/agent/client-responses'))!;
      expect(post.body.kind).toBe('computed');
      expect(post.body.toolCallId).toBe('tc-1');
      // Mounted node reported; unmounted node omitted (tool falls back per node).
      expect(post.body.results).toHaveLength(1);
      const res = post.body.results[0];
      expect(res.id).toBe('live-1');
      expect(res.rect).toMatchObject({ x: 0, y: 0, width: 0, height: 0 }); // jsdom zero-rect, shape present
      expect(res.computed.display).toBe('flex');
      expect(res.computed.backgroundColor).toBe('rgb(14, 165, 233)');
      // The full curated subset (≥30 props) when no filter was requested.
      expect(Object.keys(res.computed).length).toBeGreaterThanOrEqual(30);
    } finally {
      restore();
    }
  });

  it('filters computed properties to the requested subset', async () => {
    mountNode('live-2');
    const { posts, restore } = captureFetch();
    try {
      useCanvasStore.getState()._onSync({
        type: 'agent:computed_request',
        toolCallId: 'tc-2',
        nodeIds: ['live-2'],
        properties: ['backgroundColor', 'fontSize'],
      });
      await vi.waitFor(() => {
        expect(posts.length).toBeGreaterThanOrEqual(1);
      });
      const res = posts[0].body.results[0];
      expect(Object.keys(res.computed).sort()).toEqual(['backgroundColor', 'fontSize']);
    } finally {
      restore();
    }
  });

  it('adds canvasRect (world-transform divided out) when a world element is registered', async () => {
    mountNode('live-3');
    const world = document.createElement('div');
    document.body.appendChild(world);
    mounted.push(world);
    useCanvasStore.setState({ worldElement: world });
    const { posts, restore } = captureFetch();
    try {
      useCanvasStore.getState()._onSync({
        type: 'agent:computed_request',
        toolCallId: 'tc-3',
        nodeIds: ['live-3'],
      });
      await vi.waitFor(() => {
        expect(posts.length).toBeGreaterThanOrEqual(1);
      });
      const res = posts[0].body.results[0];
      // jsdom rects are zero → canvasRect is zeros too, but the FIELD is present.
      expect(res.canvasRect).toMatchObject({ x: 0, y: 0 });
    } finally {
      restore();
    }
  });

  it('agent:screenshot_request without a world element POSTs the no-dom-renderer error', async () => {
    const { posts, restore } = captureFetch();
    try {
      useCanvasStore.getState()._onSync({
        type: 'agent:screenshot_request',
        toolCallId: 'tc-shot',
      });
      await vi.waitFor(() => {
        expect(posts.length).toBeGreaterThanOrEqual(1);
      });
      const post = posts.find((p) => p.url.includes('/api/agent/client-responses'))!;
      expect(post.body.kind).toBe('screenshot');
      expect(post.body.toolCallId).toBe('tc-shot');
      expect(post.body.error).toBe('no-dom-renderer');
      expect(post.body.dataUrl).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('pushMeasuredBounds POSTs the digest and emits the socket ClientEvent', () => {
    const { posts, restore } = captureFetch();
    const emitted: any[] = [];
    const fakeSocket = { emit: (_ch: string, ev: any) => emitted.push(ev) };
    try {
      useCanvasStore.setState({
        connected: true,
        socket: fakeSocket as any,
        measuredBounds: { n1: { width: 84, height: 24 } },
      });
      useCanvasStore.getState().pushMeasuredBounds();
      const post = posts.find((p) => p.url.includes('/api/agent/client-responses'))!;
      expect(post.body.kind).toBe('measured_bounds');
      expect(post.body.documentId).toBe('test-doc');
      expect(post.body.bounds).toEqual({ n1: { width: 84, height: 24 } });
      expect(emitted).toHaveLength(1);
      expect(emitted[0].type).toBe('canvas:measured_bounds');
      expect(emitted[0].documentId).toBe('test-doc');
    } finally {
      restore();
    }
  });

  it('pushMeasuredBounds is a no-op with an empty digest', () => {
    const { posts, restore } = captureFetch();
    const emitted: any[] = [];
    try {
      useCanvasStore.setState({
        connected: true,
        socket: { emit: (_ch: string, ev: any) => emitted.push(ev) } as any,
        measuredBounds: {},
      });
      useCanvasStore.getState().pushMeasuredBounds();
      expect(posts).toHaveLength(0);
      expect(emitted).toHaveLength(0);
    } finally {
      restore();
    }
  });
});
