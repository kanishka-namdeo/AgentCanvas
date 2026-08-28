// Store-level integration tests for the three agent-chat features:
//
//   1. Turn-diff tracking — `_onSync({type:'canvas:patch'})` with a
//      toolCallId records PatchOpRecords on the live assistant turn AND the
//      session-store message; user-initiated patches (no toolCallId) are
//      never attributed to the agent.
//   2. Approval gate events — `agent:approval_request` opens the pending
//      dialog state; `submitApproval` clears it; `agent:approval_resolved`
//      (fan-out) closes it for other viewers.
//   3. Session-store message import — `importServerMessages` gap-fills
//      server history (with attachments + patchOps) without overwriting
//      locally-known messages.

import { describe, it, expect, beforeEach } from 'vitest';
import { useCanvasStore } from '@/lib/canvas/store';
import { useSessionStore } from '@/lib/sessions';
import type { CanvasDocument, CanvasPatch, Shape } from '@/lib/canvas/types';

// ---- Fixtures ----------------------------------------------------------------

function makeShape(id: string): Shape {
  return {
    id, type: 'rectangle', name: id,
    x: 0, y: 0, width: 100, height: 100,
    rotation: 0, opacity: 1, fill: '#ccc', stroke: '#000', strokeWidth: 0,
    radius: 0, fontSize: 16, textColor: '#000',
    parentId: null, zIndex: 0, locked: false, visible: true,
    autoLayout: null, tokenBinding: null, componentId: null,
    points: null, closed: false, src: null, radii: null,
    gradient: null, shadow: null, blur: 0, maskId: null,
    constraints: null,
  };
}

function makeDoc(shapes: Shape[] = []): CanvasDocument {
  return {
    id: 'doc1', name: 'T', background: '#fff', version: '2.17',
    children: shapes as any, viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes, tokens: { colors: [], textStyles: [] },
  };
}

function patch(p: Partial<CanvasPatch> & { op: CanvasPatch['op'] }): CanvasPatch {
  return { summary: 'test patch', ...p } as CanvasPatch;
}

/// Seed a live agent turn the way promptAgent does, without the network.
function seedLiveTurn() {
  const ss = useSessionStore.getState();
  const sess = ss.createSession('doc1', { title: 't' });
  const run = ss.startRun(sess.id, 'draw things', 'user_message');
  const userMsg = ss.appendUserMessage(sess.id, run.id, 'draw things');
  const assistantMsg = ss.appendAssistantMessage(sess.id, run.id);
  useCanvasStore.setState({
    activeSessionId: sess.id,
    agentBusy: true,
    turns: [
      { id: userMsg.id, role: 'user', text: 'draw things', toolCalls: [], streaming: false, messageId: userMsg.id },
      { id: assistantMsg.id, role: 'assistant', text: '', toolCalls: [], streaming: true, messageId: assistantMsg.id, sessionId: sess.id, runId: run.id },
    ],
  });
  return { sessionId: sess.id, runId: run.id, assistantMsgId: assistantMsg.id };
}

beforeEach(() => {
  useCanvasStore.setState({
    document: makeDoc([]), selectedIds: [], agentHighlightIds: [],
    socket: null, connected: false, viewerCount: 1, turns: [], agentBusy: false,
    documentId: 'doc1', activeSessionId: null, undoStack: [], redoStack: [],
    pendingApproval: null,
  });
  useSessionStore.setState({
    sessions: {}, runs: {}, messages: {}, toolCalls: {}, snapshots: {},
    activeSessionByDoc: {},
  });
});

// ---- 1. Turn-diff tracking ----------------------------------------------------

describe('canvas store: turn-diff tracking', () => {
  it('records agent patches (toolCallId present) on the last assistant turn', () => {
    const { assistantMsgId } = seedLiveTurn();
    // Simulate the real pi-SDK order: message_end (the assistant message
    // CARRYING the tool requests ends) fires BEFORE tool execution patches —
    // and the critique loop emits turn_end mid-run too. Attribution must
    // survive both (it keys on toolCallId + last-turn-is-assistant).
    useCanvasStore.getState()._onSync({ type: 'agent:message_end' });
    useCanvasStore.setState({ agentBusy: false });
    useCanvasStore.getState()._onSync({
      type: 'canvas:patch',
      patch: patch({ op: 'add', shapeId: 'a', summary: 'Added Hero' }),
      toolCallId: 'tc1',
    });
    useCanvasStore.getState()._onSync({
      type: 'canvas:patch',
      patch: patch({ op: 'remove', shapeIds: ['b', 'c'], summary: 'Deleted 2' }),
      toolCallId: 'tc2',
    });

    const turn = useCanvasStore.getState().turns[1];
    expect(turn.patchOps).toEqual([
      { op: 'add', count: 1, summary: 'Added Hero' },
      { op: 'remove', count: 2, summary: 'Deleted 2' },
    ]);

    // Mirrored to the session-store message (localStorage persistence).
    expect(useSessionStore.getState().messages[assistantMsgId].patchOps).toHaveLength(2);
  });

  it('ignores select patches even when the agent emits them', () => {
    seedLiveTurn();
    useCanvasStore.getState()._onSync({
      type: 'canvas:patch',
      patch: patch({ op: 'select', shapeIds: ['a'] }),
      toolCallId: 'tc-sel',
    });
    const turn = useCanvasStore.getState().turns[1];
    expect(turn.patchOps ?? []).toHaveLength(0);
  });

  it('does NOT attribute user-initiated patches (no toolCallId) to the turn', () => {
    seedLiveTurn();
    useCanvasStore.getState()._onSync({
      type: 'canvas:patch',
      patch: patch({ op: 'clear', summary: 'user cleared manually' }),
    });
    const turn = useCanvasStore.getState().turns[1];
    expect(turn.patchOps ?? []).toHaveLength(0);
  });

  it('stops attributing once the user starts the next turn (last turn is a user turn)', () => {
    seedLiveTurn();
    // The user sends a new prompt — a user turn becomes the last turn.
    useCanvasStore.setState({
      turns: [...useCanvasStore.getState().turns, { id: 'u2', role: 'user', text: 'next', toolCalls: [], streaming: false }],
    });
    useCanvasStore.getState()._onSync({
      type: 'canvas:patch',
      patch: patch({ op: 'add', shapeId: 'late' }),
      toolCallId: 'tc-late',
    });
    const turns = useCanvasStore.getState().turns;
    expect(turns[1].patchOps ?? []).toHaveLength(0);
    expect((turns[2] as any).patchOps ?? []).toHaveLength(0);
  });
});

// ---- 2. Approval gate state ---------------------------------------------------

describe('canvas store: approval gate events', () => {
  it('agent:approval_request opens the pending dialog state', () => {
    useCanvasStore.getState()._onSync({
      type: 'agent:approval_request',
      toolCallId: 'tc9',
      toolName: 'pen_clear',
      description: 'Clear the entire canvas (3 layers would be deleted)',
      details: ['All 3 layers will be removed.'],
    });
    expect(useCanvasStore.getState().pendingApproval).toEqual({
      toolCallId: 'tc9',
      toolName: 'pen_clear',
      description: 'Clear the entire canvas (3 layers would be deleted)',
      details: ['All 3 layers will be removed.'],
    });
  });

  it('agent:approval_resolved closes the dialog for matching ids only', () => {
    useCanvasStore.getState()._onSync({
      type: 'agent:approval_request',
      toolCallId: 'tc9', toolName: 'pen_clear', description: 'd', details: [],
    });
    // Non-matching resolution → dialog stays open.
    useCanvasStore.getState()._onSync({ type: 'agent:approval_resolved', toolCallId: 'other', approved: true });
    expect(useCanvasStore.getState().pendingApproval).not.toBeNull();
    // Matching resolution → closed.
    useCanvasStore.getState()._onSync({ type: 'agent:approval_resolved', toolCallId: 'tc9', approved: false });
    expect(useCanvasStore.getState().pendingApproval).toBeNull();
  });

  it('submitApproval clears the pending dialog and POSTs the decision', async () => {
    // Mock fetch so the POST doesn't actually hit the network.
    const fetchCalls: any[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: any) => {
      fetchCalls.push({ url, body: JSON.parse(init?.body ?? '{}') });
      return new Response(JSON.stringify({ ok: true, addedTool: undefined }), { status: 200 });
    }) as any;

    try {
      useCanvasStore.getState()._onSync({
        type: 'agent:approval_request',
        toolCallId: 'tc-submit', toolName: 'pen_clear', description: 'd', details: [],
      });
      expect(useCanvasStore.getState().pendingApproval).not.toBeNull();
      await useCanvasStore.getState().submitApproval('tc-submit', true, false);
      expect(useCanvasStore.getState().pendingApproval).toBeNull();
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].body).toMatchObject({
        toolCallId: 'tc-submit', approved: true, alwaysAllow: false,
      });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('submitApproval forwards alwaysAllow=true only when approved (deny + always-allow is a contradiction)', async () => {
    const fetchCalls: any[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: any) => {
      fetchCalls.push({ url, body: JSON.parse(init?.body ?? '{}') });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as any;

    try {
      // Deny + alwaysAllow → server should receive alwaysAllow: false.
      useCanvasStore.getState()._onSync({
        type: 'agent:approval_request',
        toolCallId: 'tc-deny', toolName: 'pen_clear', description: 'd', details: [],
      });
      await useCanvasStore.getState().submitApproval('tc-deny', false, true);
      expect(fetchCalls[0].body).toMatchObject({ approved: false, alwaysAllow: false });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('submitApproval persists the always-allowed tool to settings when the server returns addedTool', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, _init?: any) => {
      return new Response(
        JSON.stringify({ ok: true, addedTool: 'pen_clear' }),
        { status: 200 },
      );
    }) as any;

    try {
      const { useSettings } = await import('@/lib/settings/store');
      useSettings.getState().set('alwaysAllowTools', []);
      useCanvasStore.getState()._onSync({
        type: 'agent:approval_request',
        toolCallId: 'tc-allow', toolName: 'pen_clear', description: 'd', details: [],
      });
      await useCanvasStore.getState().submitApproval('tc-allow', true, true);
      expect(useSettings.getState().alwaysAllowTools).toContain('pen_clear');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// ---- 4. Restore-from-before-this-turn snapshot chain ------------------------

describe('session store: restore-from-before-this-turn snapshot chain', () => {
  beforeEach(() => {
    // Reset both stores so snapshots from prior tests don't leak in.
    useCanvasStore.setState({
      document: makeDoc([]), selectedIds: [], agentHighlightIds: [],
      socket: null, connected: false, viewerCount: 1, turns: [], agentBusy: false,
      documentId: 'doc1', activeSessionId: null, undoStack: [], redoStack: [],
      pendingApproval: null,
    });
    useSessionStore.setState({
      sessions: {}, runs: {}, messages: {}, toolCalls: {}, snapshots: {},
      activeSessionByDoc: {},
    });
  });

  it('parentSnapshotId of a turn-end snapshot is the "before this turn" state', () => {
    const ss = useSessionStore.getState();
    const sess = ss.createSession('doc1', { title: 't' });

    // Snapshot 1: turn 1 ends, canvas had shapes [A].
    // Shared-canvas model: captureSnapshot takes documentId (not sessionId).
    const snap1 = ss.captureSnapshot(sess.documentId, makeDoc([makeShape('A')]), {
      source: 'turn_end',
      sourceMessageId: 'msg-turn-1',
      sessionId: sess.id,
    });
    expect(snap1.parentSnapshotId).toBeNull(); // first snapshot has no parent

    // Snapshot 2: turn 2 ends, canvas had shapes [A, B].
    const snap2 = ss.captureSnapshot(sess.documentId, makeDoc([makeShape('A'), makeShape('B')]), {
      source: 'turn_end',
      sourceMessageId: 'msg-turn-2',
      sessionId: sess.id,
    });
    expect(snap2.parentSnapshotId).toBe(snap1.id); // parent = before this turn

    // "Before this turn" = the parent snapshot of the turn's own snapshot.
    // Re-read from the LIVE store (captureSnapshot updates state; the
    // captured `ss` reference is a stale snapshot of the prior state).
    const live = useSessionStore.getState();
    const turn2Snapshot = live.listSnapshots(sess.documentId).find((s) => s.sourceMessageId === 'msg-turn-2');
    expect(turn2Snapshot?.id).toBe(snap2.id);
    const beforeTurn2 = turn2Snapshot?.parentSnapshotId
      ? live.snapshots[turn2Snapshot.parentSnapshotId]
      : undefined;
    expect(beforeTurn2?.id).toBe(snap1.id);
    expect(beforeTurn2?.document.shapes.map((s) => s.id)).toEqual(['A']);
  });

  it('restoreSnapshot creates a NEW snapshot (append-only) and does NOT destroy the parent', async () => {
    const ss = useSessionStore.getState();
    const sess = ss.createSession('doc1', { title: 't' });
    const snap1 = ss.captureSnapshot(sess.documentId, makeDoc([makeShape('A')]), { source: 'turn_end' });
    // Force distinct createdAt stamps. Snapshots sort by createdAt DESC with
    // a STABLE sort, so a same-millisecond tie leaves "newest" resolved by
    // insertion order — which made the parent assertion below racy under
    // suite load (the two back-to-back captures usually share a millisecond,
    // but straddling a ms boundary flips the head from snap1 to snap2).
    await new Promise((r) => setTimeout(r, 3));
    const snap2 = ss.captureSnapshot(sess.documentId, makeDoc([makeShape('A'), makeShape('B')]), { source: 'turn_end' });

    // Re-read live state — `ss` is stale (zustand state is immutable).
    const beforeCount = Object.keys(useSessionStore.getState().snapshots).length;
    const restored = ss.restoreSnapshot(sess.documentId, snap1.id);
    const afterCount = Object.keys(useSessionStore.getState().snapshots).length;

    expect(restored).toBeDefined();
    expect(afterCount).toBe(beforeCount + 1); // append-only — snap2 still exists
    expect(restored?.document.shapes.map((s) => s.id)).toEqual(['A']); // restored content
    expect(restored?.source).toBe('restore');
    // Restore-snapshot parent = the PREVIOUS NEWEST head (linear-chain
    // semantics — the documented contract in shared-canvas.test.ts
    // "parent = previous newest"; AgentPanel's restore-from-before-this-turn
    // relies on the same parent-pointing rule). The restore takes its CONTENT
    // from snap1 but hangs off the timeline HEAD, which is snap2 here.
    expect(restored?.parentSnapshotId).toBe(snap2.id);
    // The original turn-end snapshot is still in the chain (not destroyed).
    expect(useSessionStore.getState().snapshots[snap2.id]).toBeDefined();
  });

  it('restoreSnapshot returns undefined for unknown snapshot ids', () => {
    const ss = useSessionStore.getState();
    const sess = ss.createSession('doc1', { title: 't' });
    expect(ss.restoreSnapshot(sess.documentId, 'never-existed')).toBeUndefined();
  });

  it('restoreSnapshot returns undefined when the snapshot belongs to a different document', () => {
    const ss = useSessionStore.getState();
    const sess1 = ss.createSession('doc1', { title: 't1' });
    const sess2 = ss.createSession('doc2', { title: 't2' });
    const snap = ss.captureSnapshot(sess1.documentId, makeDoc([makeShape('A')]), { source: 'turn_end' });
    expect(ss.restoreSnapshot(sess2.documentId, snap.id)).toBeUndefined();
  });
});

// ---- 3. Server-message import (cross-device hydration) ------------------------

describe('session store: importServerMessages', () => {
  it('gap-fills unknown messages with images + patchOps intact', () => {
    const ss = useSessionStore.getState();
    const sess = ss.createSession('doc1', { title: 't' });
    const imported = useSessionStore.getState().importServerMessages(sess.id, [
      {
        id: 'srv-msg-1', role: 'user', text: 'hello',
        status: 'complete', runId: null, createdAt: '2026-08-27T10:00:00.000Z',
        images: [{ id: 'img_1', name: 'pic.png', dataUrl: 'data:image/png;base64,AAA' }],
      },
      {
        id: 'srv-msg-2', role: 'assistant', text: 'done',
        status: 'complete', runId: null, createdAt: '2026-08-27T10:00:01.000Z',
        patchOps: [{ op: 'add', count: 4, summary: 'Added 4' }],
      },
    ]);
    expect(imported).toBe(2);
    const session = useSessionStore.getState().sessions[sess.id];
    expect(session.messageIds).toEqual(['srv-msg-1', 'srv-msg-2']);
    const m1 = useSessionStore.getState().messages['srv-msg-1'];
    expect(m1.role).toBe('user');
    expect(m1.images).toHaveLength(1);
    const m2 = useSessionStore.getState().messages['srv-msg-2'];
    expect(m2.patchOps).toEqual([{ op: 'add', count: 4, summary: 'Added 4' }]);
  });

  it('never overwrites locally-known messages', () => {
    const ss = useSessionStore.getState();
    const sess = ss.createSession('doc1', { title: 't' });
    const run = ss.startRun(sess.id, 'p', 'user_message');
    const localMsg = ss.appendUserMessage(sess.id, run.id, 'local version');
    const imported = useSessionStore.getState().importServerMessages(sess.id, [
      { id: localMsg.id, role: 'user', text: 'SERVER version (should be ignored)', status: 'complete' },
      { id: 'srv-new', role: 'assistant', text: 'server-only', status: 'complete' },
    ]);
    expect(imported).toBe(1); // only the unknown one
    expect(useSessionStore.getState().messages[localMsg.id].text).toBe('local version');
  });

  it('returns 0 for empty input or unknown sessions', () => {
    const ss = useSessionStore.getState();
    const sess = ss.createSession('doc1', { title: 't' });
    expect(useSessionStore.getState().importServerMessages(sess.id, [])).toBe(0);
    expect(useSessionStore.getState().importServerMessages('nope', [
      { id: 'x', role: 'user', text: 'y', status: 'complete' },
    ])).toBe(0);
  });
});
