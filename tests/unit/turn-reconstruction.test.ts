// Store-stack tests — turn reconstruction from journal replay + live
// user_message/turn_final events (Phase B R3).
//
// Drives _onSync directly (the socket 'sync' handler contract) exactly like
// the other store suites. Covers:
//   - a viewer that missed WHOLE turns reconstructs them from
//     user_message → message_start(placeholder) → turn_final(content)
//   - the ORIGINATING client's open turn heals its partial text via
//     turn_final (replace, not append)
//   - double replay is a no-op (identity idempotency)
//   - the prompting client's own user_message broadcast is skipped by
//     messageId (no duplicate turn)
//   - the session store adopts user + final assistant rows by id

import { describe, it, expect, beforeEach } from 'vitest';
import { useCanvasStore } from '@/lib/canvas/store';
import { useSessionStore } from '@/lib/sessions';
import type { SyncEvent } from '@/lib/canvas/types';
import { __resetClientMutationsForTests } from '@/lib/canvas/client-mutations';

const DOC = 'demo';

function resetStore() {
  useCanvasStore.setState({
    document: {
      id: DOC, name: 'Doc', background: '#fff', version: '2.17',
      children: [], viewport: { zoom: 1, panX: 0, panY: 0 },
      shapes: [], tokens: { colors: [], textStyles: [] },
    },
    selectedIds: [], agentHighlightIds: [], socket: null, connected: false,
    viewerCount: 1, remotePresence: {}, turns: [], agentBusy: false,
    documentId: DOC, activeSessionId: null, undoStack: [], redoStack: [],
    guideLines: [], guideUndoStack: [], guideRedoStack: [],
    checkpoints: [], lastCheckpointSignature: null, turnCounter: 0,
  });
  useSessionStore.setState({
    sessions: {}, runs: {}, messages: {}, toolCalls: {}, snapshots: {}, activeSessionByDoc: {},
  });
}

function dispatch(ev: SyncEvent) {
  useCanvasStore.getState()._onSync(ev);
}

function lastTurn() {
  const turns = useCanvasStore.getState().turns;
  return turns[turns.length - 1];
}

/// Seed the ORIGINATING client's mid-run state (what promptAgent created).
function seedOpenTurn() {
  const ss = useSessionStore.getState();
  const session = ss.createSession(DOC, { title: 't' });
  const run = ss.startRun(session.id, 'build a card');
  const userMsg = ss.appendUserMessage(session.id, run.id, 'build a card');
  const assistantMsg = ss.appendAssistantMessage(session.id, run.id);
  useCanvasStore.setState((s) => ({
    activeSessionId: session.id,
    agentBusy: true,
    turns: [
      ...s.turns,
      {
        id: userMsg.id, role: 'user', text: 'build a card', toolCalls: [],
        streaming: false, sessionId: session.id, runId: run.id, messageId: userMsg.id, startedAt: 1,
      },
      {
        id: assistantMsg.id, role: 'assistant', text: '', toolCalls: [],
        streaming: true, sessionId: session.id, runId: run.id, messageId: assistantMsg.id, startedAt: 2,
      },
    ],
  }));
  return { session, run, userMsg, assistantMsg };
}

describe('turn reconstruction: foreign viewer that missed whole turns (R3)', () => {
  beforeEach(() => {
    resetStore();
    localStorage.clear();
    __resetClientMutationsForTests();
  });

  it('rebuilds two missed turns with content from journal-order replay', () => {
    // Turn 1 — entirely missed.
    dispatch({ type: 'agent:user_message', text: 'draw a card', sessionId: 'sess-x', runId: 'run-1', messageId: 'msg-u1' });
    dispatch({ type: 'agent:message_start', role: 'assistant' });
    dispatch({ type: 'agent:turn_end' });
    dispatch({ type: 'agent:turn_final', text: 'card created', status: 'complete', sessionId: 'sess-x', runId: 'run-1', messageId: 'msg-a1' });

    // Turn 2 — entirely missed.
    dispatch({ type: 'agent:user_message', text: 'make it blue', sessionId: 'sess-x', runId: 'run-2', messageId: 'msg-u2' });
    dispatch({ type: 'agent:message_start', role: 'assistant' });
    dispatch({ type: 'agent:turn_end' });
    dispatch({ type: 'agent:turn_final', text: 'blue now', status: 'complete', sessionId: 'sess-x', runId: 'run-2', messageId: 'msg-a2' });

    const turns = useCanvasStore.getState().turns;
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(turns[0].text).toBe('draw a card');
    expect(turns[1].text).toBe('card created');
    expect(turns[2].text).toBe('make it blue');
    expect(turns[3].text).toBe('blue now');
    expect(turns.every((t) => !t.streaming)).toBe(true);
    // The foreign session is NOT known locally → no session-store rows.
    expect(useSessionStore.getState().messages['msg-u1']).toBeUndefined();
    expect(useSessionStore.getState().messages['msg-a1']).toBeUndefined();
  });

  it('replay is IDEMPOTENT — dispatching the same window twice changes nothing', () => {
    const window: SyncEvent[] = [
      { type: 'agent:user_message', text: 'draw a card', sessionId: 'sess-x', runId: 'run-1', messageId: 'msg-u1' },
      { type: 'agent:message_start', role: 'assistant' },
      { type: 'agent:turn_end' },
      { type: 'agent:turn_final', text: 'card created', status: 'complete', sessionId: 'sess-x', runId: 'run-1', messageId: 'msg-a1' },
    ];
    for (const ev of window) dispatch(ev);
    for (const ev of window) dispatch(ev); // double delivery

    const turns = useCanvasStore.getState().turns;
    expect(turns).toHaveLength(2); // no duplicates
    expect(turns[1].text).toBe('card created');
  });

  it('reconstructs with tool calls attaching to the synthesized placeholder', () => {
    dispatch({ type: 'agent:user_message', text: 'hi', runId: 'run-1' });
    dispatch({ type: 'agent:message_start', role: 'assistant' });
    dispatch({ type: 'agent:tool_call_start', toolCallId: 'tc-1', toolName: 'pen_create_shape', argsPreview: '{}' });
    dispatch({ type: 'agent:tool_call_end', toolCallId: 'tc-1', success: true, summary: 'ok' });
    dispatch({ type: 'agent:turn_final', text: 'done', status: 'complete', runId: 'run-1' });

    const turns = useCanvasStore.getState().turns;
    expect(turns[1].toolCalls).toHaveLength(1);
    expect(turns[1].toolCalls[0].id).toBe('tc-1');
    expect(turns[1].toolCalls[0].success).toBe(true);
    // Id-guard: a duplicate tool_call_start from a replay window is skipped.
    dispatch({ type: 'agent:tool_call_start', toolCallId: 'tc-1', toolName: 'pen_create_shape', argsPreview: '{}' });
    expect(useCanvasStore.getState().turns[1].toolCalls).toHaveLength(1);
  });
});

describe('turn reconstruction: the originating client heals its open turn (R3)', () => {
  beforeEach(() => {
    resetStore();
    localStorage.clear();
    __resetClientMutationsForTests();
  });

  it('turn_final REPLACES partial stream text and finalizes message + run', () => {
    const { session, run, assistantMsg } = seedOpenTurn();

    // Partial text landed before the disconnect.
    dispatch({ type: 'agent:message_delta', text: 'I will cre' });
    // Reconnect replay: closure + full final content.
    dispatch({ type: 'agent:message_end', stopReason: 'end_turn' });
    dispatch({ type: 'agent:turn_end' });
    dispatch({
      type: 'agent:turn_final',
      text: 'I will create a styled card for you.',
      status: 'complete',
      sessionId: session.id,
      runId: run.id,
      messageId: assistantMsg.id,
    });

    const state = useCanvasStore.getState();
    expect(state.agentBusy).toBe(false);
    const last = state.turns[state.turns.length - 1];
    expect(last.text).toBe('I will create a styled card for you.'); // healed, not appended
    expect(last.streaming).toBe(false);

    const ss = useSessionStore.getState();
    expect(ss.messages[assistantMsg.id].text).toBe('I will create a styled card for you.');
    expect(ss.messages[assistantMsg.id].status).toBe('complete');
    expect(ss.runs[run.id].status).toBe('completed');
  });

  it('turn_final carries the honest CANCELLED status end to end', () => {
    const { run, assistantMsg } = seedOpenTurn();
    dispatch({ type: 'agent:turn_cancelled' });
    dispatch({ type: 'agent:turn_final', text: 'partial', status: 'cancelled', runId: run.id, messageId: assistantMsg.id });

    const ss = useSessionStore.getState();
    expect(ss.messages[assistantMsg.id].status).toBe('cancelled');
    expect(ss.runs[run.id].status).toBe('cancelled');
    expect(useCanvasStore.getState().agentBusy).toBe(false);
  });

  it('the prompting client SKIPS its own user_message broadcast (idempotent by messageId)', () => {
    const { session, run, userMsg } = seedOpenTurn();
    const turnsBefore = useCanvasStore.getState().turns.length;

    // The server broadcasts agent:user_message to every subscriber INCLUDING
    // the sender — the sender already has the row.
    dispatch({ type: 'agent:user_message', text: 'build a card', sessionId: session.id, runId: run.id, messageId: userMsg.id });

    expect(useCanvasStore.getState().turns).toHaveLength(turnsBefore); // no dup
    const ss = useSessionStore.getState();
    // Exactly ONE user message row for that id.
    expect(Object.values(ss.messages).filter((m) => m.id === userMsg.id)).toHaveLength(1);
  });
});

describe('turn reconstruction: session-store adoption for known sessions', () => {
  beforeEach(() => {
    resetStore();
    localStorage.clear();
    __resetClientMutationsForTests();
  });

  it('adoptUserMessage creates the row under the journal id (no server POST path)', () => {
    // A locally-known session (e.g. an earlier turn of ours on this canvas).
    const ss = useSessionStore.getState();
    const session = ss.createSession(DOC, { title: 'mine' });
    useCanvasStore.setState({ activeSessionId: session.id });

    dispatch({ type: 'agent:user_message', text: 'from another tab', sessionId: session.id, runId: 'run-9', messageId: 'msg-x9' });

    const msg = useSessionStore.getState().messages['msg-x9'];
    expect(msg).toBeDefined();
    expect(msg.role).toBe('user');
    expect(msg.text).toBe('from another tab');
    expect(msg.status).toBe('complete');
    // Read the LIVE session (the createSession return value is a stale snapshot).
    expect(useSessionStore.getState().sessions[session.id].messageIds).toContain('msg-x9');
  });

  it('adoptAssistantFinal fills a message that existed but was never finalized', () => {
    const ss = useSessionStore.getState();
    const session = ss.createSession(DOC, { title: 'mine' });
    // An assistant message stuck 'streaming' from a crashed run.
    const run = ss.startRun(session.id, 'prompt');
    const assistantMsg = ss.appendAssistantMessage(session.id, run.id);

    dispatch({ type: 'agent:turn_final', text: 'late final text', status: 'complete', sessionId: session.id, runId: run.id, messageId: assistantMsg.id });

    const msg = useSessionStore.getState().messages[assistantMsg.id];
    expect(msg.text).toBe('late final text');
    expect(msg.status).toBe('complete');
    expect(useSessionStore.getState().runs[run.id].status).toBe('completed');
  });
});
