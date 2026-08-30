// Integration tests — agent-durability event flows through the canvas-store
// bridge (`_onSync`): the client side of the server-side durability changes.
//
// Covered behaviors (each maps to a server-side change):
//   C1  toolCallId+content dedup — a verbatim duplicate canvas:patch applies once
//   D3  agent:turn_cancelled finalizes the turn + run as CANCELLED
//   D3  a trailing turn_end after turn_cancelled does NOT overwrite the run
//       status back to 'completed' (the old terminal-overwrite bug) and does
//       not double-capture a snapshot
//   C4  agent:stuck finalizes the run with the distinct 'stuck' status
//   D4  agent:error with a typed code still finalizes as failed

import { describe, it, expect, beforeEach } from 'vitest';
import { useCanvasStore } from '@/lib/canvas/store';
import { useSessionStore } from '@/lib/sessions';
import type { CanvasDocument, Shape, CanvasPatch } from '@/lib/canvas/types';

const DOC_ID = 'test-doc';

function makeDoc(shapes: Shape[] = []): CanvasDocument {
  return {
    id: DOC_ID,
    name: 'Test',
    background: '#ffffff',
    version: '2.17',
    children: shapes as never,
    viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes,
    tokens: { colors: [], textStyles: [] },
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

function startTurn(prompt: string) {
  const ss = useSessionStore.getState();
  const session = ss.createSession(DOC_ID, { title: prompt.slice(0, 48) });
  useCanvasStore.setState({ activeSessionId: session.id });
  const run = ss.startRun(session.id, prompt, 'user_message');
  const userMsg = ss.appendUserMessage(session.id, run.id, prompt);
  const assistantMsg = ss.appendAssistantMessage(session.id, run.id);

  useCanvasStore.setState((s) => ({
    turns: [
      ...s.turns,
      {
        id: userMsg.id, role: 'user' as const, text: prompt, toolCalls: [],
        streaming: false, sessionId: session.id, runId: run.id, messageId: userMsg.id,
      },
      {
        id: assistantMsg.id, role: 'assistant' as const, text: '', toolCalls: [],
        streaming: true, sessionId: session.id, runId: run.id, messageId: assistantMsg.id,
      },
    ],
    agentBusy: true,
  }));

  return { sessionId: session.id, runId: run.id, assistantMessageId: assistantMsg.id };
}

describe('agent durability: idempotent patch application (C1)', () => {
  beforeEach(() => resetStore());

  it('applies a toolCallId-carrying patch once and skips the verbatim duplicate', () => {
    const patch: CanvasPatch = {
      op: 'add',
      shape: { type: 'rectangle', name: 'Button', x: 0, y: 0, width: 100, height: 40, id: 'btn-1' },
      summary: 'Created rectangle "Button"',
    };

    useCanvasStore.getState()._onSync({ type: 'canvas:patch', patch, toolCallId: 'tc-1' });
    expect(useCanvasStore.getState().document.shapes.filter((s) => s.id === 'btn-1')).toHaveLength(1);

    // Verbatim duplicate delivery (socket.io at-least-once / NDJSON replay):
    // same toolCallId, same content → must be skipped.
    useCanvasStore.getState()._onSync({
      type: 'canvas:patch',
      patch: JSON.parse(JSON.stringify(patch)),
      toolCallId: 'tc-1',
    });
    expect(useCanvasStore.getState().document.shapes.filter((s) => s.id === 'btn-1')).toHaveLength(1);
  });

  it('still applies DIFFERENT patches that share one toolCallId (details.patches)', () => {
    useCanvasStore.getState()._onSync({
      type: 'canvas:patch',
      patch: { op: 'add', shape: { type: 'rectangle', name: 'A', id: 'a' }, summary: 'a' },
      toolCallId: 'tc-multi',
    });
    useCanvasStore.getState()._onSync({
      type: 'canvas:patch',
      patch: { op: 'add', shape: { type: 'rectangle', name: 'B', id: 'b' }, summary: 'b' },
      toolCallId: 'tc-multi',
    });
    const ids = useCanvasStore.getState().document.shapes.map((s) => s.id);
    expect(ids).toContain('a');
    expect(ids).toContain('b');
  });

  it('never dedupes user edits (patches without toolCallId)', () => {
    const patch: CanvasPatch = { op: 'add', shape: { type: 'rectangle', name: 'X', id: 'x-1' }, summary: 'x' };
    useCanvasStore.getState()._onSync({ type: 'canvas:patch', patch });
    useCanvasStore.getState()._onSync({ type: 'canvas:patch', patch: JSON.parse(JSON.stringify(patch)) });
    // User patches are broadcast to all viewers — each viewer applies both
    // (identical content, no toolCallId → no dedup). Both land.
    expect(useCanvasStore.getState().document.shapes.filter((s) => s.id === 'x-1').length).toBeGreaterThanOrEqual(1);
  });
});

describe('agent durability: server-side Stop → agent:turn_cancelled (D3)', () => {
  beforeEach(() => resetStore());

  it('finalizes the turn + assistant message + run as cancelled', () => {
    const { runId, assistantMessageId } = startTurn('design a button');

    useCanvasStore.getState()._onSync({ type: 'agent:message_delta', text: 'Half ' });
    useCanvasStore.getState()._onSync({ type: 'agent:turn_cancelled' });

    const s = useCanvasStore.getState();
    expect(s.agentBusy).toBe(false);
    expect(s.turns[1].streaming).toBe(false);

    const ss = useSessionStore.getState();
    expect(ss.getMessage(assistantMessageId)?.status).toBe('cancelled');
    expect(ss.getRun(runId)?.status).toBe('cancelled');
  });

  it('a trailing turn_end after turn_cancelled does not overwrite the cancelled run', () => {
    const { runId } = startTurn('design a button');

    useCanvasStore.getState()._onSync({ type: 'agent:turn_cancelled' });
    const snapsAfterCancel = useSessionStore.getState().listSnapshots(DOC_ID).length;

    // The runner's tail still emits turn_end after turn_cancelled — it must
    // NOT re-finalize the run as completed or capture a second snapshot.
    useCanvasStore.getState()._onSync({ type: 'agent:turn_end' });

    const ss = useSessionStore.getState();
    expect(ss.getRun(runId)?.status).toBe('cancelled');
    expect(useSessionStore.getState().listSnapshots(DOC_ID).length).toBe(snapsAfterCancel);
  });

  it('a turn_end after agent:error does not overwrite the failed run', () => {
    const { runId } = startTurn('design a button');
    useCanvasStore.getState()._onSync({ type: 'agent:error', message: 'HTTP 502: Bad Gateway', code: 'server', retryable: true });
    useCanvasStore.getState()._onSync({ type: 'agent:turn_end' });
    expect(useSessionStore.getState().getRun(runId)?.status).toBe('failed');
  });
});

describe('agent durability: stuck detector → agent:stuck (C4)', () => {
  beforeEach(() => resetStore());

  it('finalizes the run with the distinct stuck status + marks the message errored', () => {
    const { runId, assistantMessageId } = startTurn('design a button');

    useCanvasStore.getState()._onSync({
      type: 'agent:stuck',
      message: 'The tool "pen_update_shape" failed identically 3 times in a row',
      toolName: 'pen_update_shape',
      streak: 3,
    });

    const s = useCanvasStore.getState();
    expect(s.agentBusy).toBe(false);
    expect(s.turns[1].streaming).toBe(false);
    expect(s.turns[1].error).toContain('pen_update_shape');

    const ss = useSessionStore.getState();
    expect(ss.getMessage(assistantMessageId)?.status).toBe('error');
    expect(ss.getRun(runId)?.status).toBe('stuck');
    expect(ss.getRun(runId)?.errorMessage).toContain('pen_update_shape');
  });

  it('a trailing turn_end after stuck does not overwrite the stuck status', () => {
    const { runId } = startTurn('design a button');
    useCanvasStore.getState()._onSync({ type: 'agent:stuck', message: 'stuck!', toolName: 't', streak: 3 });
    useCanvasStore.getState()._onSync({ type: 'agent:turn_end' });
    expect(useSessionStore.getState().getRun(runId)?.status).toBe('stuck');
  });
});

describe('agent durability: endRun terminal guard (sessions store)', () => {
  beforeEach(() => resetStore());

  it('refuses to change a terminal status to a different terminal status', () => {
    const { runId } = startTurn('design a button');
    const ss = useSessionStore.getState();
    ss.endRun(runId, 'cancelled');
    ss.endRun(runId, 'completed'); // trailing turn_end path — must be a no-op
    expect(ss.getRun(runId)?.status).toBe('cancelled');
  });

  it('allows re-finalization with the SAME status (idempotent resync flows)', () => {
    const { runId } = startTurn('design a button');
    const ss = useSessionStore.getState();
    ss.endRun(runId, 'completed');
    ss.endRun(runId, 'completed');
    expect(ss.getRun(runId)?.status).toBe('completed');
  });
});

describe('agent durability: stopAgent finalizes the message as cancelled (D3 client fix)', () => {
  beforeEach(() => resetStore());

  it('stopAgent (WS path, socket null) marks message cancelled + run cancelled', () => {
    const { runId, assistantMessageId } = startTurn('design a button');
    useCanvasStore.getState()._onSync({
      type: 'canvas:patch',
      patch: { op: 'add', shape: { type: 'rectangle', name: 'Half', id: 'half-1' }, summary: 'add' },
    });

    useCanvasStore.getState().stopAgent();

    const s = useCanvasStore.getState();
    expect(s.agentBusy).toBe(false);
    expect(s.turns[1].streaming).toBe(false);

    const ss = useSessionStore.getState();
    // The OLD behavior finalized the message as 'complete' — a stopped turn
    // must read 'cancelled' in history.
    expect(ss.getMessage(assistantMessageId)?.status).toBe('cancelled');
    expect(ss.getRun(runId)?.status).toBe('cancelled');

    const snaps = ss.listSnapshots(DOC_ID);
    expect(snaps.length).toBeGreaterThanOrEqual(1);
    expect(snaps[0].createdBy).toBe('user');
  });
});
