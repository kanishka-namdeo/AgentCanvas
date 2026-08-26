// Integration tests — session store bridge.
//
// The canvas store (`useCanvasStore`) mirrors every agent event into the
// session store (`useSessionStore`) so chat history, tool calls, runs and
// snapshots survive reloads. These tests drive synthetic agent events through
// `useCanvasStore._onSync` (the same path WebSocket events take) and verify
// the session store ends up with the right runs / messages / tool calls /
// snapshots.
//
// We also verify the bridge for:
//   - Snapshot capture at turn_end (the Lovable-style append-only model —
//     DOCUMENT-scoped in the shared-canvas model, with sessionId provenance)
//   - Snapshot capture on stopAgent (cancelled run + user-created snapshot)
//   - Tool call mirroring (start → end, with success / failure)
//   - Session switching rebuilds turns WITHOUT swapping the shared canvas
//   - Fork creates a child CONVERSATION (message-prefix copy, shared canvas)

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useCanvasStore } from '@/lib/canvas/store';
import { useSessionStore } from '@/lib/sessions';
import type { CanvasDocument, Shape } from '@/lib/canvas/types'
import type { PenChild } from '@/lib/pen/types';

const DOC_ID = 'test-doc';

// ---- Fixtures ----------------------------------------------------------------

function makeDoc(shapes: Shape[] = []): CanvasDocument {
  return {
    id: DOC_ID,
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

/// Set up a session + run + user message + assistant message, mirror into
/// turns, and set agentBusy=true — the exact state promptAgent leaves the
/// store in. Returns handles for asserting on later.
function startTurn(prompt: string) {
  const ss = useSessionStore.getState();
  const session = ss.createSession(DOC_ID, { title: prompt.slice(0, 48) });
  useCanvasStore.setState({ activeSessionId: session.id });
  const run = ss.startRun(session.id, prompt, 'user_message');
  ss.autoTitleFromPrompt(session.id, prompt);
  const userMsg = ss.appendUserMessage(session.id, run.id, prompt);
  const assistantMsg = ss.appendAssistantMessage(session.id, run.id);

  useCanvasStore.setState((s) => ({
    turns: [
      ...s.turns,
      {
        id: userMsg.id, role: 'user', text: prompt, toolCalls: [],
        streaming: false, sessionId: session.id, runId: run.id, messageId: userMsg.id,
      },
      {
        id: assistantMsg.id, role: 'assistant', text: '', toolCalls: [],
        streaming: true, sessionId: session.id, runId: run.id, messageId: assistantMsg.id,
      },
    ],
    agentBusy: true,
  }));

  return { sessionId: session.id, runId: run.id, assistantMessageId: assistantMsg.id };
}

// ---- Tests -------------------------------------------------------------------

describe('session bridge: agent message stream → session store', () => {
  beforeEach(() => resetStore());

  it('message_delta appends to the assistant message + the live turn', () => {
    const { assistantMessageId } = startTurn('design a button');

    useCanvasStore.getState()._onSync({ type: 'agent:message_start', role: 'assistant' });
    useCanvasStore.getState()._onSync({ type: 'agent:message_delta', text: 'Creating ' });
    useCanvasStore.getState()._onSync({ type: 'agent:message_delta', text: 'a button.' });
    useCanvasStore.getState()._onSync({ type: 'agent:message_end' });
    useCanvasStore.getState()._onSync({ type: 'agent:turn_end' });

    const s = useCanvasStore.getState();
    expect(s.turns[1].text).toBe('Creating a button.');
    expect(s.turns[1].streaming).toBe(false);
    expect(s.agentBusy).toBe(false);

    const ss = useSessionStore.getState();
    const msg = ss.getMessage(assistantMessageId);
    expect(msg?.text).toBe('Creating a button.');
    expect(msg?.status).toBe('complete');
  });

  it('tool_call_start + tool_call_end record a tool call on the run', () => {
    const { runId } = startTurn('design a button');

    useCanvasStore.getState()._onSync({
      type: 'agent:tool_call_start',
      toolCallId: 'tc-1',
      toolName: 'pen_create_shape',
      argsPreview: '{"shape":{"type":"rectangle"}}',
    });
    useCanvasStore.getState()._onSync({
      type: 'agent:tool_call_end',
      toolCallId: 'tc-1',
      success: true,
      summary: 'Created rectangle "Button"',
    });
    useCanvasStore.getState()._onSync({ type: 'agent:turn_end' });

    const ss = useSessionStore.getState();
    const calls = ss.listToolCalls(runId);
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe('tc-1');
    expect(calls[0].name).toBe('pen_create_shape');
    expect(calls[0].status).toBe('success');
    expect(calls[0].summary).toBe('Created rectangle "Button"');

    // Also visible in the live turn.
    const turn = useCanvasStore.getState().turns[1];
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0].success).toBe(true);
    expect(turn.toolCalls[0].summary).toBe('Created rectangle "Button"');
  });

  it('failed tool call records status=error in session store', () => {
    const { runId } = startTurn('design a button');

    useCanvasStore.getState()._onSync({
      type: 'agent:tool_call_start',
      toolCallId: 'tc-fail',
      toolName: 'pen_delete_shape',
      argsPreview: '{"shapeId":"nope"}',
    });
    useCanvasStore.getState()._onSync({
      type: 'agent:tool_call_end',
      toolCallId: 'tc-fail',
      success: false,
      summary: 'Shape not found: nope',
    });
    useCanvasStore.getState()._onSync({ type: 'agent:turn_end' });

    const ss = useSessionStore.getState();
    const calls = ss.listToolCalls(runId);
    expect(calls).toHaveLength(1);
    expect(calls[0].status).toBe('error');

    const turn = useCanvasStore.getState().turns[1];
    expect(turn.toolCalls[0].success).toBe(false);
  });
});

describe('session bridge: snapshot capture at turn_end', () => {
  beforeEach(() => resetStore());

  it('captures a snapshot of the post-mutation document at turn_end', () => {
    const { sessionId, runId } = startTurn('design a button');

    // Apply a mutation (simulating the agent's tool call).
    useCanvasStore.getState()._onSync({
      type: 'canvas:patch',
      patch: {
        op: 'add',
        shape: { type: 'rectangle', name: 'Button', x: 0, y: 0, width: 100, height: 40, id: 'btn-1' },
        summary: 'Created rectangle "Button"',
      },
    });
    useCanvasStore.getState()._onSync({ type: 'agent:turn_end' });

    const ss = useSessionStore.getState();
    // SHARED-CANVAS MODEL: snapshots are DOCUMENT-scoped (newest first),
    // with the chat's sessionId as provenance.
    const snaps = ss.listSnapshots(DOC_ID);
    expect(snaps.length).toBeGreaterThanOrEqual(1);
    const lastSnap = snaps[0]; // newest first
    expect(lastSnap.source).toBe('turn_end');
    expect(lastSnap.documentId).toBe(DOC_ID);
    expect(lastSnap.sessionId).toBe(sessionId);
    expect(lastSnap.sourceRunId).toBe(runId);
    expect(lastSnap.createdBy).toBe('agent');
    // The snapshot document should contain the shape we just added.
    expect(lastSnap.document.shapes.find((s) => s.id === 'btn-1')).toBeDefined();

    // The run should be marked completed.
    expect(ss.getRun(runId)?.status).toBe('completed');
  });

  it('does NOT capture a duplicate snapshot on a duplicate turn_end', () => {
    const { sessionId } = startTurn('design a button');

    useCanvasStore.getState()._onSync({
      type: 'canvas:patch',
      patch: { op: 'add', shape: { type: 'rectangle', name: 'Btn', id: 'btn-1' }, summary: 'add' },
    });
    useCanvasStore.getState()._onSync({ type: 'agent:turn_end' });
    const firstSnapCount = useSessionStore.getState().listSnapshots(DOC_ID).length;

    // Emit turn_end again (the runner emits one from the normal exit path
    // AND one at generator end — this is the duplicate we must guard).
    useCanvasStore.getState()._onSync({ type: 'agent:turn_end' });
    const secondSnapCount = useSessionStore.getState().listSnapshots(DOC_ID).length;

    expect(secondSnapCount).toBe(firstSnapCount); // no new snapshot
  });
});

describe('session bridge: stopAgent finalizes as cancelled', () => {
  beforeEach(() => resetStore());

  it('stopAgent captures a user-created snapshot + ends the run as cancelled', () => {
    // Note: stopAgent's HTTP path uses an AbortController we can't easily
    // simulate here (we'd need to fake fetch). The WebSocket path (when
    // agentAbort is null) finalizes locally — that's what we test.
    const { sessionId, runId, assistantMessageId } = startTurn('design a button');
    // Ensure agentAbort is null (no HTTP fetch in flight) so the WS path runs.
    // (It's a module-level let in store.ts; we don't have direct access, but
    // since we never called promptAgent (we called startTurn manually), no
    // AbortController was created, so agentAbort is still null.)

    // Apply a mutation so the snapshot has something to capture.
    useCanvasStore.getState()._onSync({
      type: 'canvas:patch',
      patch: { op: 'add', shape: { type: 'rectangle', name: 'Half', id: 'half-1' }, summary: 'add' },
    });

    useCanvasStore.getState().stopAgent();

    const s = useCanvasStore.getState();
    expect(s.agentBusy).toBe(false);
    expect(s.turns[1].streaming).toBe(false);

    const ss = useSessionStore.getState();
    expect(ss.getMessage(assistantMessageId)?.status).toBe('complete');
    expect(ss.getRun(runId)?.status).toBe('cancelled');

    // Document-scoped snapshot (shared canvas), newest first.
    const snaps = ss.listSnapshots(DOC_ID);
    expect(snaps.length).toBeGreaterThanOrEqual(1);
    const lastSnap = snaps[0];
    expect(lastSnap.createdBy).toBe('user');
    expect(lastSnap.sessionId).toBe(sessionId);
    expect(lastSnap.document.shapes.find((x) => x.id === 'half-1')).toBeDefined();
  });
});

describe('session bridge: error path', () => {
  beforeEach(() => resetStore());

  it('agent:error finalizes the assistant message + run as failed', () => {
    const { runId, assistantMessageId } = startTurn('design a button');

    useCanvasStore.getState()._onSync({ type: 'agent:error', message: 'LLM rate-limited' });

    const s = useCanvasStore.getState();
    expect(s.agentBusy).toBe(false);
    expect(s.turns[1].streaming).toBe(false);
    expect(s.turns[1].error).toBe('LLM rate-limited');
    // Chat-parity change: the error message lives on turn.error (rendered by
    // the dedicated error row) and is NOT spliced into the markdown text —
    // partial responses stay readable and copyable.
    expect(s.turns[1].text).not.toContain('LLM rate-limited');

    const ss = useSessionStore.getState();
    expect(ss.getMessage(assistantMessageId)?.status).toBe('error');
    expect(ss.getMessage(assistantMessageId)?.error).toBe('LLM rate-limited');
    expect(ss.getRun(runId)?.status).toBe('failed');
    expect(ss.getRun(runId)?.errorMessage).toBe('LLM rate-limited');
  });
});

describe('session bridge: session switching rebuilds turns WITHOUT swapping the shared canvas', () => {
  beforeEach(() => resetStore());

  it('switchSession rebuilds turns but never touches the shared document', () => {
    // SHARED-CANVAS MODEL: every chat on a document mutates ONE canvas.
    // Switching chats swaps only the transcript; the document is untouched.
    const ss = useSessionStore.getState();
    const docA = makeDoc([makeShape('a1')]);
    const docB = makeDoc([makeShape('b1'), makeShape('b2')]);

    const sessionA = ss.createSession(DOC_ID, { title: 'A' });
    const sessionB = ss.createSession(DOC_ID, { title: 'B' });

    // Capture document-scoped snapshots with per-chat provenance. Pin the
    // first capture's createdAt — same-millisecond ties would make the
    // newest-first ordering ambiguous.
    const snapA = ss.captureSnapshot(DOC_ID, docA, { sessionId: sessionA.id, source: 'manual', createdBy: 'user' });
    useSessionStore.setState((s) => ({
      snapshots: {
        ...s.snapshots,
        [snapA.id]: { ...s.snapshots[snapA.id], createdAt: '2026-01-01T00:00:00.000Z' },
      },
    }));
    ss.captureSnapshot(DOC_ID, docB, { sessionId: sessionB.id, source: 'manual', createdBy: 'user' });

    // Add messages to session B.
    const runB = ss.startRun(sessionB.id, 'do thing', 'user_message');
    ss.appendUserMessage(sessionB.id, runB.id, 'do thing');
    ss.appendAssistantMessage(sessionB.id, runB.id);
    ss.startToolCall(runB.id, 'tc-b1', 'pen_create_shape', '{}');
    ss.endToolCall('tc-b1', true, 'created', 'created b2');

    // The live canvas holds content (as it would after a turn or a boot
    // hydration from the document's latest snapshot).
    useCanvasStore.setState({ document: docB, activeSessionId: sessionB.id });

    // Switch to A: transcript becomes A's (empty), canvas UNCHANGED.
    useCanvasStore.getState().switchSession(sessionA.id);
    expect(useCanvasStore.getState().document.shapes.map((s) => s.id)).toEqual(['b1', 'b2']);
    expect(useCanvasStore.getState().turns).toHaveLength(0); // A has no messages

    // Switch back to B: turns rebuild from session B's messages, canvas STILL unchanged.
    useCanvasStore.getState().switchSession(sessionB.id);
    expect(useCanvasStore.getState().document.shapes.map((s) => s.id)).toEqual(['b1', 'b2']);
    const turns = useCanvasStore.getState().turns;
    expect(turns).toHaveLength(2); // user + assistant
    expect(turns[0].role).toBe('user');
    expect(turns[1].role).toBe('assistant');
    expect(turns[1].toolCalls).toHaveLength(1);
    expect(turns[1].toolCalls[0].name).toBe('pen_create_shape');
    expect(turns[1].toolCalls[0].success).toBe(true);

    // The document timeline holds BOTH captures (shared across chats),
    // newest first, with per-chat provenance intact.
    const snaps = useSessionStore.getState().listSnapshots(DOC_ID);
    expect(snaps).toHaveLength(2);
    expect(snaps[0].sessionId).toBe(sessionB.id);
    expect(snaps[1].sessionId).toBe(sessionA.id);
  });

  it('newSession creates a fresh conversation that CONTINUES on the current canvas', () => {
    // Start with a populated canvas.
    resetStore(makeDoc([makeShape('a')]));
    const ss = useSessionStore.getState();
    const original = ss.createSession(DOC_ID, { title: 'Original' });
    ss.captureSnapshot(DOC_ID, makeDoc([makeShape('a')]), { sessionId: original.id, source: 'manual', createdBy: 'user' });
    useCanvasStore.setState({ activeSessionId: original.id });

    // Verify we're on the original session with the shape loaded.
    expect(useCanvasStore.getState().document.shapes).toHaveLength(1);

    // Create a new chat.
    const newId = useCanvasStore.getState().newSession();
    expect(newId).not.toBeNull();
    expect(useCanvasStore.getState().activeSessionId).toBe(newId);
    // SHARED-CANVAS MODEL: the canvas is NOT reset — the new chat continues
    // from the current shared state with an empty transcript.
    expect(useCanvasStore.getState().document.shapes.map((s) => s.id)).toEqual(['a']);
    expect(useCanvasStore.getState().turns).toHaveLength(0);
    // The new session is active for this document.
    expect(useSessionStore.getState().activeSessionByDoc[DOC_ID]).toBe(newId);
  });
});

describe('session bridge: fork creates a child conversation (shared canvas)', () => {
  beforeEach(() => resetStore());

  it('forkActiveSession copies the message prefix + shares the live canvas', () => {
    const { sessionId } = startTurn('design a button');
    // Apply a mutation.
    useCanvasStore.getState()._onSync({
      type: 'canvas:patch',
      patch: { op: 'add', shape: { type: 'rectangle', name: 'Hero', id: 'hero-1' }, summary: 'add' },
    });
    useCanvasStore.getState()._onSync({ type: 'agent:turn_end' });

    const snapsBeforeFork = useSessionStore.getState().listSnapshots(DOC_ID).length;

    // Fork (conversation fork — no canvas fork in the shared-canvas model).
    const forkId = useCanvasStore.getState().forkActiveSession();
    expect(forkId).not.toBeNull();
    expect(forkId).not.toBe(sessionId);

    const ss = useSessionStore.getState();
    const fork = ss.getSession(forkId!);
    expect(fork).toBeDefined();
    expect(fork!.parentId).toBe(sessionId);

    // The fork COPIED the parent's conversation prefix (user + assistant
    // messages with new ids; runs/tool calls stay with the parent).
    const forkMessages = ss.listMessages(forkId!);
    expect(forkMessages).toHaveLength(2);
    expect(forkMessages[0].role).toBe('user');
    expect(forkMessages[0].text).toBe('design a button');
    expect(forkMessages[0].sessionId).toBe(forkId);
    expect(forkMessages[0].runId).toBeNull(); // runs are NOT copied
    expect(forkMessages[1].role).toBe('assistant');
    // The parent keeps its own messages untouched.
    expect(ss.listMessages(sessionId)).toHaveLength(2);

    // NO fork snapshots are created — the canvas timeline is shared and
    // never forked (the parent's turn_end snapshot remains the latest).
    const snapsAfterFork = useSessionStore.getState().listSnapshots(DOC_ID);
    expect(snapsAfterFork).toHaveLength(snapsBeforeFork);

    // Active session should now be the fork, and the fork's transcript is
    // rebuilt from the copied messages.
    expect(useCanvasStore.getState().activeSessionId).toBe(forkId);
    expect(useCanvasStore.getState().turns).toHaveLength(2);
    // Canvas still shows the shared state (untouched by the fork).
    expect(useCanvasStore.getState().document.shapes.find((s) => s.id === 'hero-1')).toBeDefined();
  });
});
