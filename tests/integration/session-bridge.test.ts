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
//   - Snapshot capture at turn_end (the Lovable-style append-only model)
//   - Snapshot capture on stopAgent (cancelled run + user-created snapshot)
//   - Tool call mirroring (start → end, with success / failure)
//   - Session switching restores canvas + rebuilds turns
//   - Fork creates a child session with its own snapshot

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useCanvasStore } from '@/lib/canvas/store';
import { useSessionStore } from '@/lib/sessions';
import type { CanvasDocument, Shape } from '@/lib/canvas/types';

// ---- Fixtures ----------------------------------------------------------------

function makeDoc(shapes: Shape[] = []): CanvasDocument {
  return {
    id: 'test-doc',
    name: 'Test',
    background: '#ffffff',
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
    activeRunBySession: {},
    _hydrated: true,
  });
}

/// Set up a session + run + user message + assistant message, mirror into
/// turns, and set agentBusy=true — the exact state promptAgent leaves the
/// store in. Returns handles for asserting on later.
function startTurn(prompt: string) {
  const ss = useSessionStore.getState();
  const session = ss.createSession('test-doc', { title: prompt.slice(0, 48) });
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
    const snaps = ss.listSnapshots(sessionId);
    expect(snaps.length).toBeGreaterThanOrEqual(1);
    const lastSnap = snaps[snaps.length - 1];
    expect(lastSnap.source).toBe('turn_end');
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
    const firstSnapCount = useSessionStore.getState().listSnapshots(sessionId).length;

    // Emit turn_end again (the runner emits one from the normal exit path
    // AND one at generator end — this is the duplicate we must guard).
    useCanvasStore.getState()._onSync({ type: 'agent:turn_end' });
    const secondSnapCount = useSessionStore.getState().listSnapshots(sessionId).length;

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

    const snaps = ss.listSnapshots(sessionId);
    expect(snaps.length).toBeGreaterThanOrEqual(1);
    const lastSnap = snaps[snaps.length - 1];
    expect(lastSnap.createdBy).toBe('user');
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
    expect(s.turns[1].text).toContain('LLM rate-limited');

    const ss = useSessionStore.getState();
    expect(ss.getMessage(assistantMessageId)?.status).toBe('error');
    expect(ss.getMessage(assistantMessageId)?.error).toBe('LLM rate-limited');
    expect(ss.getRun(runId)?.status).toBe('failed');
    expect(ss.getRun(runId)?.errorMessage).toBe('LLM rate-limited');
  });
});

describe('session bridge: session switching restores canvas + turns', () => {
  beforeEach(() => resetStore());

  it('switchSession loads the session\'s latest snapshot + rebuilds turns', () => {
    // Seed two sessions, each with their own snapshot + messages.
    const ss = useSessionStore.getState();
    const docA = makeDoc([makeShape('a1')]);
    const docB = makeDoc([makeShape('b1'), makeShape('b2')]);

    const sessionA = ss.createSession('test-doc', { title: 'A' });
    const sessionB = ss.createSession('test-doc', { title: 'B' });

    // Capture snapshots for each.
    ss.captureSnapshot(sessionA.id, docA, { source: 'manual', createdBy: 'user' });
    ss.captureSnapshot(sessionB.id, docB, { source: 'manual', createdBy: 'user' });

    // Add messages to session B.
    const runB = ss.startRun(sessionB.id, 'do thing', 'user_message');
    ss.appendUserMessage(sessionB.id, runB.id, 'do thing');
    ss.appendAssistantMessage(sessionB.id, runB.id);
    ss.startToolCall(runB.id, 'tc-b1', 'pen_create_shape', '{}');
    ss.endToolCall('tc-b1', true, 'created', 'created b2');

    // Switch to A first.
    useCanvasStore.setState({ activeSessionId: sessionA.id });
    useCanvasStore.getState().switchSession(sessionA.id);
    expect(useCanvasStore.getState().document.shapes.map((s) => s.id)).toEqual(['a1']);
    expect(useCanvasStore.getState().turns).toHaveLength(0); // A has no messages

    // Switch to B — should load docB + rebuild turns from session B's messages.
    useCanvasStore.getState().switchSession(sessionB.id);
    expect(useCanvasStore.getState().document.shapes.map((s) => s.id)).toEqual(['b1', 'b2']);
    const turns = useCanvasStore.getState().turns;
    expect(turns).toHaveLength(2); // user + assistant
    expect(turns[0].role).toBe('user');
    expect(turns[1].role).toBe('assistant');
    expect(turns[1].toolCalls).toHaveLength(1);
    expect(turns[1].toolCalls[0].name).toBe('pen_create_shape');
    expect(turns[1].toolCalls[0].success).toBe(true);
  });

  it('newSession creates a fresh session + switches to it (clearing canvas)', () => {
    // Start with a populated canvas.
    resetStore(makeDoc([makeShape('a')]));
    const ss = useSessionStore.getState();
    const original = ss.createSession('test-doc', { title: 'Original' });
    ss.captureSnapshot(original.id, makeDoc([makeShape('a')]), { source: 'manual', createdBy: 'user' });
    useCanvasStore.setState({ activeSessionId: original.id });

    // Verify we're on the original session with the shape loaded.
    expect(useCanvasStore.getState().document.shapes).toHaveLength(1);

    // Create a new session.
    const newId = useCanvasStore.getState().newSession();
    expect(newId).not.toBeNull();
    expect(useCanvasStore.getState().activeSessionId).toBe(newId);
    // New session → empty canvas (no snapshot yet).
    expect(useCanvasStore.getState().document.shapes).toHaveLength(0);
    expect(useCanvasStore.getState().turns).toHaveLength(0);
  });
});

describe('session bridge: fork creates a child session', () => {
  beforeEach(() => resetStore());

  it('forkActiveSession creates a new session inheriting the current canvas', () => {
    const { sessionId } = startTurn('design a button');
    // Apply a mutation.
    useCanvasStore.getState()._onSync({
      type: 'canvas:patch',
      patch: { op: 'add', shape: { type: 'rectangle', name: 'Hero', id: 'hero-1' }, summary: 'add' },
    });
    useCanvasStore.getState()._onSync({ type: 'agent:turn_end' });

    // Fork.
    const forkId = useCanvasStore.getState().forkActiveSession();
    expect(forkId).not.toBeNull();
    expect(forkId).not.toBe(sessionId);

    // The fork should have inherited the current canvas (with the Hero shape).
    const ss = useSessionStore.getState();
    const fork = ss.getSession(forkId!);
    expect(fork).toBeDefined();
    expect(fork!.parentId).toBe(sessionId);

    // The fork should have its own snapshot with the inherited doc.
    const forkSnaps = ss.listSnapshots(forkId!);
    expect(forkSnaps.length).toBeGreaterThanOrEqual(1);
    expect(forkSnaps[forkSnaps.length - 1].document.shapes.find((s) => s.id === 'hero-1')).toBeDefined();

    // Active session should now be the fork.
    expect(useCanvasStore.getState().activeSessionId).toBe(forkId);
    // Canvas should still show the inherited shape.
    expect(useCanvasStore.getState().document.shapes.find((s) => s.id === 'hero-1')).toBeDefined();
  });
});
