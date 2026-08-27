// Unit tests — SHARED-CANVAS model (multiple chats per canvas).
//
// The document is the shared artifact: every session attached to a
// documentId mutates ONE canvas. These tests pin the core contracts:
//   1. switchSession NEVER swaps the document (transcript-only)
//   2. newSession continues on the current shared canvas
//   3. captureSnapshot is document-scoped with session provenance
//   4. restoreSnapshot (canvas-store action) reverts the shared canvas,
//      appends a 'restore' snapshot, and broadcasts document:restore
//   5. forkSession copies the message prefix; runs/toolCalls stay with the
//      parent; the canvas timeline is never forked
//   6. deleteSession keeps document snapshots (the timeline outlives chats)
//   7. turn_end across TWO different chats lands on ONE shared timeline
//   8. the sessions persist v1 → v2 migration re-keys session-owned
//      snapshots to the document scope

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useCanvasStore } from '@/lib/canvas/store';
import { useSessionStore } from '@/lib/sessions';
import type { CanvasDocument, Shape, ClientEvent } from '@/lib/canvas/types';
import type { PenChild } from '@/lib/pen/types';
import type { Snapshot } from '@/lib/sessions/types';

const DOC_ID = 'shared-doc';

// ---- Fixtures ----------------------------------------------------------------

function makeDoc(shapes: Shape[] = []): CanvasDocument {
  return {
    id: DOC_ID,
    name: 'Shared',
    background: '#ffffff',
    version: '2.17',
    children: shapes as unknown as PenChild[],
    viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes,
    tokens: { colors: [], textStyles: [] },
  };
}

function makeShape(id: string): Shape {
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
    documentId: DOC_ID,
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

/// Start an agent turn on the given session (mirrors promptAgent's state).
function startTurn(sessionId: string, prompt: string) {
  const ss = useSessionStore.getState();
  const run = ss.startRun(sessionId, prompt, 'user_message');
  const userMsg = ss.appendUserMessage(sessionId, run.id, prompt);
  const assistantMsg = ss.appendAssistantMessage(sessionId, run.id);
  useCanvasStore.setState((s) => ({
    turns: [
      ...s.turns,
      {
        id: userMsg.id, role: 'user', text: prompt, toolCalls: [],
        streaming: false, sessionId, runId: run.id, messageId: userMsg.id,
      },
      {
        id: assistantMsg.id, role: 'assistant', text: '', toolCalls: [],
        streaming: true, sessionId, runId: run.id, messageId: assistantMsg.id,
      },
    ],
    agentBusy: true,
    activeSessionId: sessionId,
  }));
  return { runId: run.id, userMessageId: userMsg.id, assistantMessageId: assistantMsg.id };
}

// ---- Tests -------------------------------------------------------------------

describe('shared canvas: switching chats never swaps the document', () => {
  beforeEach(() => resetStore());

  it('preserves document identity + content across switches', () => {
    const ss = useSessionStore.getState();
    const chatA = ss.createSession(DOC_ID, { title: 'A' });
    const chatB = ss.createSession(DOC_ID, { title: 'B' });
    useCanvasStore.setState({ document: makeDoc([makeShape('x')]), activeSessionId: chatA.id });

    useCanvasStore.getState().switchSession(chatB.id);
    const afterSwitch1 = useCanvasStore.getState().document;
    expect(afterSwitch1.id).toBe(DOC_ID);
    expect(afterSwitch1.shapes.map((s) => s.id)).toEqual(['x']);

    useCanvasStore.getState().switchSession(chatA.id);
    const afterSwitch2 = useCanvasStore.getState().document;
    expect(afterSwitch2).toBe(afterSwitch1); // same reference — never replaced
    expect(afterSwitch2.shapes.map((s) => s.id)).toEqual(['x']);
  });

  it('newSession keeps the canvas + creates an empty active conversation', () => {
    resetStore(makeDoc([makeShape('keep-me')]));
    const newId = useCanvasStore.getState().newSession();
    expect(newId).not.toBeNull();
    const s = useCanvasStore.getState();
    expect(s.activeSessionId).toBe(newId);
    expect(s.document.shapes.map((x) => x.id)).toEqual(['keep-me']); // NOT cleared
    expect(s.turns).toHaveLength(0);
    const fork = useSessionStore.getState().getSession(newId!);
    expect(fork?.documentId).toBe(DOC_ID);
    expect(fork?.messageIds).toHaveLength(0);
  });
});

describe('shared canvas: document-scoped snapshots with provenance', () => {
  beforeEach(() => resetStore());

  it('captureSnapshot keys by documentId + records session provenance, newest-first', () => {
    const ss = useSessionStore.getState();
    const chatA = ss.createSession(DOC_ID, { title: 'A' });
    const chatB = ss.createSession(DOC_ID, { title: 'B' });

    const snapA = ss.captureSnapshot(DOC_ID, makeDoc([makeShape('a')]), {
      sessionId: chatA.id, source: 'manual', createdBy: 'user',
    });
    // Pin an earlier createdAt — captures within the same millisecond would
    // make the newest-first ordering ambiguous.
    useSessionStore.setState((s) => ({
      snapshots: {
        ...s.snapshots,
        [snapA.id]: { ...s.snapshots[snapA.id], createdAt: '2026-01-01T00:00:00.000Z' },
      },
    }));
    const snapB = ss.captureSnapshot(DOC_ID, makeDoc([makeShape('b')]), {
      sessionId: chatB.id, source: 'turn_end', createdBy: 'agent',
    });

    expect(snapA.documentId).toBe(DOC_ID);
    expect(snapA.sessionId).toBe(chatA.id);
    expect(snapB.documentId).toBe(DOC_ID);
    expect(snapB.sessionId).toBe(chatB.id);
    // The fork chain links within the document timeline.
    expect(snapB.parentSnapshotId).toBe(snapA.id);

    const snaps = useSessionStore.getState().listSnapshots(DOC_ID);
    expect(snaps).toHaveLength(2);
    expect(snaps[0].id).toBe(snapB.id); // newest first
    expect(snaps[1].id).toBe(snapA.id);

    // Sessions carry no snapshot bookkeeping (shared canvas model).
    expect(useSessionStore.getState().getSession(chatA.id)?.messageIds).toBeDefined();
    expect(JSON.stringify(useSessionStore.getState().getSession(chatA.id))).not.toContain('snapshotIds');
  });

  it('turn_end captures ONE shared timeline across two different chats', () => {
    const ss = useSessionStore.getState();
    const chatA = ss.createSession(DOC_ID, { title: 'A' });
    const chatB = ss.createSession(DOC_ID, { title: 'B' });

    // Turn 1 on chat A.
    const turnA = startTurn(chatA.id, 'make a red square');
    useCanvasStore.getState()._onSync({
      type: 'canvas:patch',
      patch: { op: 'add', shape: { type: 'rectangle', name: 'Red', id: 'r1' }, summary: 'add' },
    });
    useCanvasStore.getState()._onSync({ type: 'agent:turn_end' });
    // Pin turn 1's snapshot createdAt — same-millisecond ties with turn 2
    // would make the newest-first ordering ambiguous.
    {
      const firstSnap = useSessionStore.getState().listSnapshots(DOC_ID)[0];
      useSessionStore.setState((s) => ({
        snapshots: {
          ...s.snapshots,
          [firstSnap.id]: { ...s.snapshots[firstSnap.id], createdAt: '2026-01-01T00:00:00.000Z' },
        },
      }));
    }

    // Turn 2 on chat B — same canvas, different conversation.
    const turnB = startTurn(chatB.id, 'make a blue square');
    useCanvasStore.getState()._onSync({
      type: 'canvas:patch',
      patch: { op: 'add', shape: { type: 'rectangle', name: 'Blue', id: 'b1' }, summary: 'add' },
    });
    useCanvasStore.getState()._onSync({ type: 'agent:turn_end' });

    const snaps = useSessionStore.getState().listSnapshots(DOC_ID);
    expect(snaps).toHaveLength(2); // ONE shared timeline
    expect(snaps[0].sessionId).toBe(chatB.id); // newest from chat B
    expect(snaps[1].sessionId).toBe(chatA.id);
    // Each snapshot sees the shared accumulated state.
    expect(snaps[1].document.shapes.find((s) => s.id === 'r1')).toBeDefined();
    expect(snaps[0].document.shapes.find((s) => s.id === 'r1')).toBeDefined();
    expect(snaps[0].document.shapes.find((s) => s.id === 'b1')).toBeDefined();
    expect(snaps[0].sourceRunId).toBe(turnB.runId);
    expect(snaps[1].sourceRunId).toBe(turnA.runId);
  });
});

describe('shared canvas: restore reverts the shared canvas + broadcasts', () => {
  beforeEach(() => resetStore());

  it('appends a restore snapshot, swaps the document, and emits document:restore', async () => {
    const ss = useSessionStore.getState();
    const chat = ss.createSession(DOC_ID, { title: 'A' });

    // Two states: one shape, then two shapes. createdAt has millisecond
    // resolution and the test runs faster — pin explicit timestamps so the
    // newest-first ordering is deterministic.
    const first = ss.captureSnapshot(DOC_ID, makeDoc([makeShape('v1')]), {
      sessionId: chat.id, source: 'manual', createdBy: 'user',
    });
    useSessionStore.setState((s) => ({
      snapshots: {
        ...s.snapshots,
        [first.id]: { ...s.snapshots[first.id], createdAt: '2026-01-01T00:00:00.000Z' },
      },
    }));
    useCanvasStore.setState({ document: makeDoc([makeShape('v1'), makeShape('v2')]) });
    const second = ss.captureSnapshot(DOC_ID, makeDoc([makeShape('v1'), makeShape('v2')]), {
      sessionId: chat.id, source: 'manual', createdBy: 'user',
    });
    useSessionStore.setState((s) => ({
      snapshots: {
        ...s.snapshots,
        [second.id]: { ...s.snapshots[second.id], createdAt: '2026-01-01T00:00:01.000Z' },
      },
    }));

    // Mock socket to observe the broadcast.
    const emitted: ClientEvent[] = [];
    useCanvasStore.setState({
      socket: { emit: (_ch: string, ev: ClientEvent) => { emitted.push(ev); } } as never,
      connected: true,
    });

    // Restore to the FIRST snapshot (oldest in the list).
    const snaps = useSessionStore.getState().listSnapshots(DOC_ID);
    const target = snaps[snaps.length - 1]; // oldest
    expect(target.id).toBe(first.id);
    await useCanvasStore.getState().restoreSnapshot(target.id);

    const s = useCanvasStore.getState();
    // Document reverted to the single-shape state.
    expect(s.document.shapes.map((x) => x.id)).toEqual(['v1']);
    expect(s.document.id).toBe(DOC_ID);

    // Append-only: a NEW 'restore' snapshot was added (now the newest).
    const after = useSessionStore.getState().listSnapshots(DOC_ID);
    expect(after).toHaveLength(3);
    expect(after[0].source).toBe('restore');
    expect(after[0].parentSnapshotId).toBe(snaps[0].id); // parent = previous newest

    // The restore was broadcast to other viewers.
    const restoreEvent = emitted.find((e) => e.type === 'document:restore');
    expect(restoreEvent).toBeDefined();
    if (restoreEvent?.type === 'document:restore') {
      expect(restoreEvent.documentId).toBe(DOC_ID);
      expect(restoreEvent.document.shapes.map((x) => x.id)).toEqual(['v1']);
    }
  });
});

describe('shared canvas: fork is a conversation fork', () => {
  beforeEach(() => resetStore());

  it('copies the message prefix; runs/toolCalls stay with the parent; canvas untouched', () => {
    const ss = useSessionStore.getState();
    const parent = ss.createSession(DOC_ID, { title: 'Parent' });
    const turn = startTurn(parent.id, 'design a button');
    // The assistant "responds".
    useSessionStore.getState().appendAssistantText(turn.assistantMessageId, 'I made a button.');

    useCanvasStore.setState({ document: makeDoc([makeShape('shared-1')]) });
    const docBefore = useCanvasStore.getState().document;

    const fork = useSessionStore.getState().forkSession(parent.id, null);
    expect(fork).toBeDefined();
    const forkId = fork!.id;
    expect(fork!.parentId).toBe(parent.id);

    // Message prefix copied with NEW ids, runs NOT copied.
    const forkMsgs = useSessionStore.getState().listMessages(forkId!);
    expect(forkMsgs).toHaveLength(2);
    expect(forkMsgs[0].id).not.toBe(turn.userMessageId);
    expect(forkMsgs[0].text).toBe('design a button');
    expect(forkMsgs[0].runId).toBeNull();
    expect(forkMsgs[1].text).toBe('I made a button.');
    // Parent untouched.
    expect(useSessionStore.getState().listMessages(parent.id)).toHaveLength(2);
    expect(useSessionStore.getState().getRun(turn.runId)?.sessionId).toBe(parent.id);

    // The canvas reference is UNCHANGED (shared artifact).
    expect(useCanvasStore.getState().document).toBe(docBefore);

    // Forking from a specific message truncates the prefix at that message.
    const fork2 = useSessionStore.getState().forkSession(parent.id, turn.userMessageId);
    const fork2Msgs = useSessionStore.getState().listMessages(fork2!.id);
    expect(fork2Msgs).toHaveLength(1); // only the user message
    expect(fork2Msgs[0].role).toBe('user');
  });
});

describe('shared canvas: deleting a chat keeps the canvas timeline', () => {
  beforeEach(() => resetStore());

  it('deleteSession preserves document snapshots', () => {
    const ss = useSessionStore.getState();
    const chat = ss.createSession(DOC_ID, { title: 'A' });
    ss.captureSnapshot(DOC_ID, makeDoc([makeShape('a')]), {
      sessionId: chat.id, source: 'manual', createdBy: 'user',
    });
    expect(useSessionStore.getState().listSnapshots(DOC_ID)).toHaveLength(1);

    useSessionStore.getState().deleteSession(chat.id);
    expect(useSessionStore.getState().getSession(chat.id)).toBeUndefined();
    // The snapshot survives with its (now dangling) provenance.
    const snaps = useSessionStore.getState().listSnapshots(DOC_ID);
    expect(snaps).toHaveLength(1);
    expect(snaps[0].sessionId).toBe(chat.id); // provenance preserved
  });

  it('clearAllForDocument wipes both chats AND the document timeline', () => {
    const ss = useSessionStore.getState();
    const a = ss.createSession(DOC_ID, { title: 'A' });
    ss.captureSnapshot(DOC_ID, makeDoc([makeShape('a')]), {
      sessionId: a.id, source: 'manual', createdBy: 'user',
    });
    expect(useSessionStore.getState().listSnapshots(DOC_ID)).toHaveLength(1);

    useSessionStore.getState().clearAllForDocument(DOC_ID);
    expect(useSessionStore.getState().listSnapshots(DOC_ID)).toHaveLength(0);
    expect(useSessionStore.getState().listSessions({ documentId: DOC_ID })).toHaveLength(0);
  });
});

describe('shared canvas: sessions persist v1 → v2 migration', () => {
  beforeEach(() => resetStore());

  it('re-keys session-owned snapshots to document scope + strips legacy session fields', async () => {
    // A v1 payload: snapshots owned by sessions (snapshot.sessionId as the
    // owning key; sessions carry currentSnapshotId + snapshotIds).
    const legacySession = {
      id: 'sess_legacy',
      documentId: 'demo',
      title: 'Legacy chat',
      status: 'active',
      pinned: false,
      starred: false,
      parentId: null,
      forkedFromMessageId: null,
      forkedFromSnapshotId: null,
      isRoot: true,
      currentSnapshotId: 'snap_legacy_1',
      currentRunId: null,
      lastRunId: null,
      model: 'unresolved',
      messageCount: 0,
      runCount: 0,
      toolCallCount: 0,
      messageIds: [],
      runIds: [],
      snapshotIds: ['snap_legacy_1'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastOpenedAt: '2026-01-01T00:00:00.000Z',
      archivedAt: null,
    };
    const legacySnapshot = {
      id: 'snap_legacy_1',
      sessionId: 'sess_legacy',
      parentSnapshotId: null,
      source: 'turn_end',
      sourceRunId: null,
      sourceMessageId: null,
      document: makeDoc([makeShape('legacy')]),
      nodeCount: 1,
      label: null,
      bookmarked: false,
      createdAt: '2026-01-01T00:00:01.000Z',
      createdBy: 'agent',
    };
    window.localStorage.setItem(
      'agentcanvas.sessions.v1',
      JSON.stringify({
        state: {
          sessions: { sess_legacy: legacySession },
          runs: {},
          messages: {},
          toolCalls: {},
          snapshots: { snap_legacy_1: legacySnapshot },
          activeSessionByDoc: { demo: 'sess_legacy' },
        },
        version: 1,
      }),
    );

    // Rehydrate through the persist middleware (applies migrate).
    const persistApi = (useSessionStore as unknown as {
      persist: { rehydrate: () => Promise<unknown> };
    }).persist;
    await persistApi.rehydrate();

    const state = useSessionStore.getState();
    // Snapshot re-keyed to the document scope with provenance intact.
    const snap: Snapshot | undefined = state.snapshots['snap_legacy_1'];
    expect(snap?.documentId).toBe('demo');
    expect(snap?.sessionId).toBe('sess_legacy');
    expect(snap?.remote).toBe(false);
    expect(state.listSnapshots('demo').map((x) => x.id)).toEqual(['snap_legacy_1']);
    // Session fields stripped.
    const sess = state.sessions['sess_legacy'] as unknown as Record<string, unknown>;
    expect('currentSnapshotId' in sess).toBe(false);
    expect('snapshotIds' in sess).toBe(false);

    window.localStorage.removeItem('agentcanvas.sessions.v1');
  });
});
