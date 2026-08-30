// Store-level tests for the canvas:full merge semantics (R6 + R8 reason tag).
//
// _onSync({type:'canvas:full'}) used to REPLACE the local document
// wholesale (with an empty-incoming guard). Now:
//   - reason 'restore'  → authoritative wholesale replace (deletions land)
//   - reason 'sync' / undefined → per-element reconcile merge (unsynced local
//     edits survive; server-only elements arrive; conflicts resolve by
//     version+nonce)
//   - empty incoming + non-empty local + idle → skip (rollback guard)
//   - empty incoming + non-empty local + agentBusy → replace (agent rebuild)
//   - empty local → adopt incoming directly
//
// Driven through _onSync exactly like production (socket 'sync' handler).

import { describe, it, expect, beforeEach } from 'vitest';
import { useCanvasStore } from '@/lib/canvas/store';
import { useSessionStore } from '@/lib/sessions';
import type { CanvasDocument, Shape, SyncEvent } from '@/lib/canvas/types';
import type { PenChild } from '@/lib/pen/types';

function makeDoc(shapes: Shape[] = []): CanvasDocument {
  return {
    id: 'demo',
    name: 'Doc',
    background: '#ffffff',
    version: '2.17',
    children: shapes as unknown as PenChild[],
    viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes,
    tokens: { colors: [], textStyles: [] },
  };
}

function makeShape(
  id: string,
  fill = '#cccccc',
  version?: number,
  versionNonce?: number,
): Shape {
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
    ...(version !== undefined ? { version } : {}),
    ...(versionNonce !== undefined ? { versionNonce } : {}),
  } as Shape;
}

function resetStore(doc: CanvasDocument = makeDoc([])) {
  useCanvasStore.setState({
    document: doc,
    selectedIds: [],
    agentHighlightIds: [],
    socket: null,
    connected: false,
    viewerCount: 1,
    remotePresence: {},
    turns: [],
    agentBusy: false,
    documentId: 'demo',
    activeSessionId: null,
    undoStack: [],
    redoStack: [],
    guideLines: [],
    guideUndoStack: [],
    guideRedoStack: [],
    checkpoints: [],
    lastCheckpointSignature: null,
    turnCounter: 0,
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

function node(doc: CanvasDocument, id: string) {
  return (doc.children as unknown as Array<{ id: string; fill?: string }>).find((c) => c.id === id);
}

function dispatchFull(document: CanvasDocument, reason?: 'sync' | 'restore') {
  const event: SyncEvent = { type: 'canvas:full', document, ...(reason ? { reason } : {}) };
  useCanvasStore.getState()._onSync(event);
}

describe('canvas:full merge semantics (R6)', () => {
  beforeEach(() => resetStore());

  it('sync full MERGES: a newer local edit survives the resync', () => {
    resetStore(makeDoc([makeShape('a', '#local-edit', 4, 10)]));
    dispatchFull(makeDoc([makeShape('a', '#server-stale', 2, 99)]), 'sync');
    expect(node(useCanvasStore.getState().document, 'a')?.fill).toBe('#local-edit');
  });

  it('sync full MERGES: a newer server edit lands', () => {
    resetStore(makeDoc([makeShape('a', '#local-stale', 2, 99)]));
    dispatchFull(makeDoc([makeShape('a', '#server-edit', 4, 10)]), 'sync');
    expect(node(useCanvasStore.getState().document, 'a')?.fill).toBe('#server-edit');
  });

  it('sync full MERGES: unsynced local-only element survives (offline add)', () => {
    resetStore(makeDoc([makeShape('a', '#111', 1, 1), makeShape('mine', '#0f0', 1, 5)]));
    dispatchFull(makeDoc([makeShape('a', '#111', 1, 1)]), 'sync');
    const doc = useCanvasStore.getState().document;
    expect(node(doc, 'mine')?.fill).toBe('#0f0');
    expect(node(doc, 'a')).toBeDefined();
  });

  it('sync full without a reason (old server) still merges', () => {
    resetStore(makeDoc([makeShape('a', '#local-edit', 4, 10)]));
    dispatchFull(makeDoc([makeShape('a', '#server-stale', 2, 99)]));
    expect(node(useCanvasStore.getState().document, 'a')?.fill).toBe('#local-edit');
  });

  it('restore full REPLACES wholesale — deletions must land', () => {
    resetStore(makeDoc([makeShape('a', '#111', 1, 1), makeShape('post-snapshot', '#0f0', 9, 9)]));
    dispatchFull(makeDoc([makeShape('a', '#111', 1, 1)]), 'restore');
    const doc = useCanvasStore.getState().document;
    expect(node(doc, 'a')).toBeDefined();
    expect(node(doc, 'post-snapshot')).toBeUndefined();
  });

  it('empty incoming + local content + idle → skipped entirely (rollback guard)', () => {
    const before = makeDoc([makeShape('a', '#111', 1, 1)]);
    resetStore(before);
    dispatchFull(makeDoc([]), 'sync');
    // Same content, same reference semantics — nothing happened.
    expect(useCanvasStore.getState().document).toBe(before);
  });

  it('empty incoming + local content + agentBusy → replaced (agent rebuild)', () => {
    resetStore(makeDoc([makeShape('a', '#111', 1, 1)]));
    useCanvasStore.setState({ agentBusy: true });
    dispatchFull(makeDoc([]), 'sync');
    expect(useCanvasStore.getState().document.children).toHaveLength(0);
  });

  it('empty incoming + local content + agentBusy + restore → replaced (restore wins)', () => {
    resetStore(makeDoc([makeShape('a', '#111', 1, 1)]));
    useCanvasStore.setState({ agentBusy: true });
    dispatchFull(makeDoc([]), 'restore');
    expect(useCanvasStore.getState().document.children).toHaveLength(0);
  });

  it('empty local adopts the incoming document directly', () => {
    resetStore(makeDoc([]));
    dispatchFull(makeDoc([makeShape('a', '#111', 1, 1)]), 'sync');
    expect(node(useCanvasStore.getState().document, 'a')?.fill).toBe('#111');
  });

  it('the merged document feeds the derived shape cache', () => {
    resetStore(makeDoc([makeShape('a', '#111', 1, 1)]));
    dispatchFull(makeDoc([makeShape('a', '#111', 1, 1), makeShape('b', '#222', 1, 2)]), 'sync');
    expect(useCanvasStore.getState().document.shapes.map((s) => s.id).sort()).toEqual(['a', 'b']);
  });
});
