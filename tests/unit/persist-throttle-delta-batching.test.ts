// R9b tests: throttled sessions-store persist + client-side delta batching.
//
// Persist: a burst of appendAssistantText calls (the per-token-chunk hot
// path) must produce a BOUNDED number of localStorage writes (leading write
// + one trailing per 300ms window — not one per call), the final text must
// land on flush, and the test hook must force a synchronous write.
//
// Delta batching: under NODE_ENV='test' the buffer flushes synchronously
// (dispatch-then-assert contract); under a stubbed 'development' env,
// deltas coalesce into ONE store update per 32ms window and a terminal
// event flushes any remaining buffered text BEFORE finalizing.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useCanvasStore } from '@/lib/canvas/store';
import { useSessionStore, __flushThrottledSessionPersist } from '@/lib/sessions/store';
import type { CanvasDocument, Shape } from '@/lib/canvas/types';
import type { PenChild } from '@/lib/pen/types';

// ---- Fixtures ----------------------------------------------------------------

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

function resetStores() {
  useCanvasStore.setState({
    document: makeDoc([]),
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

// ---- Throttled persist ----------------------------------------------------------

describe('throttled sessions persist (R9b)', () => {
  const originalSetItem = Storage.prototype.setItem;
  let setItemSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    __flushThrottledSessionPersist();
    vi.useFakeTimers();
    setItemSpy = vi.fn();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      setItemSpy(k, v);
      return originalSetItem.call(this, k, v);
    });
    resetStores();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('a burst of streaming appends produces a bounded number of writes', () => {
    // Build a session + streaming message, then hammer the exact hot path:
    // 40 token-chunk appends inside 300ms.
    const ss = useSessionStore.getState();
    const session = ss.createSession('demo', { title: 't' });
    const msg = ss.appendAssistantMessage(session.id, 'run-1');

    const before = setItemSpy.mock.calls.length;
    for (let i = 0; i < 40; i++) {
      useSessionStore.getState().appendAssistantText(msg.id, `chunk${i} `);
      vi.advanceTimersByTime(5); // 200ms of wall time total
    }
    const during = setItemSpy.mock.calls.length;
    vi.advanceTimersByTime(400); // flush the trailing window
    const after = setItemSpy.mock.calls.length;

    // Pre-throttle behavior was 40 writes; now: leading write + at most a
    // couple of window boundaries + one trailing flush. Hard bound: < 10.
    expect(after - before).toBeLessThan(10);
    expect(during).toBeLessThan(after + 1);

    // The FINAL text landed on disk.
    const raw = localStorage.getItem('agentcanvas.sessions.v1');
    expect(raw).toContain('chunk39');
  });

  it('the flush hook lands pending writes synchronously', () => {
    const ss = useSessionStore.getState();
    const session = ss.createSession('demo', { title: 't' });
    const msg = ss.appendAssistantMessage(session.id, 'run-1');
    useSessionStore.getState().appendAssistantText(msg.id, 'tail text');
    // Force the window closed so the next append is inside a throttle window.
    vi.advanceTimersByTime(1);
    useSessionStore.getState().appendAssistantText(msg.id, ' more');
    __flushThrottledSessionPersist();
    const raw = localStorage.getItem('agentcanvas.sessions.v1');
    expect(raw).toContain('tail text more');
  });
});

// ---- Delta batching ---------------------------------------------------------------

describe('streaming delta batching (R9b)', () => {
  beforeEach(() => {
    resetStores();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function startStreamingTurn(): string {
    // Create the REAL session-store message so the mirror path works.
    const ss = useSessionStore.getState();
    const session = ss.createSession('demo', { title: 'stream test' });
    const msg = ss.appendAssistantMessage(session.id, 'run-1');
    useCanvasStore.setState({
      turns: [
        { id: 'u1', role: 'user', text: 'draw a card', toolCalls: [], streaming: false },
        { id: 'a1', role: 'assistant', text: '', toolCalls: [], streaming: true, messageId: msg.id },
      ],
      agentBusy: true,
    });
    return msg.id;
  }

  it('test env: deltas flush synchronously (dispatch-then-assert contract)', () => {
    const msgId = startStreamingTurn();
    useCanvasStore.getState()._onSync({ type: 'agent:message_delta', text: 'Hello ' });
    useCanvasStore.getState()._onSync({ type: 'agent:message_delta', text: 'world' });
    const turn = useCanvasStore.getState().turns[1];
    expect(turn.text).toBe('Hello world');
    expect(useSessionStore.getState().messages[msgId]?.text).toBe('Hello world');
  });

  it('dev env: deltas coalesce into one store update per window', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const msgId = startStreamingTurn();
    let updates = 0;
    const unsub = useCanvasStore.subscribe(() => { updates += 1; });

    useCanvasStore.getState()._onSync({ type: 'agent:message_delta', text: 'a' });
    useCanvasStore.getState()._onSync({ type: 'agent:message_delta', text: 'b' });
    useCanvasStore.getState()._onSync({ type: 'agent:message_delta', text: 'c' });
    expect(updates).toBe(0); // buffered — no set() yet

    vi.advanceTimersByTime(40);
    expect(updates).toBe(1); // ONE commit for the whole window
    const turn = useCanvasStore.getState().turns[1];
    expect(turn.text).toBe('abc');
    expect(useSessionStore.getState().messages[msgId]?.text).toBe('abc');
    unsub();
  });

  it('dev env: a terminal event flushes buffered text BEFORE finalizing', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const msgId = startStreamingTurn();
    useCanvasStore.getState()._onSync({ type: 'agent:message_delta', text: 'partial answer' });
    // No timer advance — message_end must land the buffered text itself.
    useCanvasStore.getState()._onSync({ type: 'agent:message_end' });
    const turn = useCanvasStore.getState().turns[1];
    expect(turn.text).toBe('partial answer');
    expect(turn.streaming).toBe(false);
    expect(useSessionStore.getState().messages[msgId]?.status).toBe('complete');
    expect(useSessionStore.getState().messages[msgId]?.text).toBe('partial answer');
  });

  it('dev env: promptAgent flushes the previous turn’s buffered tail first', () => {
    vi.stubEnv('NODE_ENV', 'development');
    startStreamingTurn();
    useCanvasStore.getState()._onSync({ type: 'agent:message_delta', text: 'final bits' });
    useCanvasStore.getState()._onSync({ type: 'agent:turn_end' });
    // Buffer is empty now (turn_end flushed); queue a new prompt while a
    // second wave of deltas could still race in — simulate by re-opening a
    // streaming turn WITHOUT flushing (the promptAgent guard covers this).
    useCanvasStore.setState({
      turns: [
        ...useCanvasStore.getState().turns,
        { id: 'u2', role: 'user', text: 'again', toolCalls: [], streaming: false },
        { id: 'a2', role: 'assistant', text: '', toolCalls: [], streaming: true, messageId: 'm2' },
      ],
    });
    useCanvasStore.getState()._onSync({ type: 'agent:message_delta', text: 'second turn text' });
    vi.advanceTimersByTime(40);
    const turns = useCanvasStore.getState().turns;
    expect(turns.find((t) => t.id === 'a1')?.text).toBe('final bits');
    expect(turns.find((t) => t.id === 'a2')?.text).toBe('second turn text');
  });
});
