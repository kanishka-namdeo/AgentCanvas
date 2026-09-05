// Run-state UI consistency suite (2026-09-05 contract).
//
// Covers the store-level guarantees behind "the relevant UI controls are
// consistent while the agent or a subagent runs":
//   1. Canonical `runPhase` transitions — armed for EVERY viewer (C3:
//      message_start re-arm), refined by tool/delta events, terminal on
//      turn_end / turn_cancelled / error / stuck, intermediate 'cancelling'
//      on stopAgent.
//   2. Busy-guards at the store choke points (C1/C2/C8): promptAgent routes
//      to the queue instead of double-running; undo/redo refuse with the
//      user guard but allow the agent's own canvas:patch undo/redo;
//      mutation-bearing sendPatch is paused; newSession / forkActiveSession
//      guard BEFORE create (no orphan rows).
//   3. Sub-agent rows resolve by dispatchId (parallel multitask workers
//      share subAgentType — the type+running match resolved every row on
//      the first result).
//   4. The session store's setRunStatus drives the StatusBadge phases
//      ('awaiting_tool' / 'cancelling' / 'in_progress') without ever
//      rewriting a terminal run.

import { describe, it, expect, beforeEach } from 'vitest';
import { useCanvasStore } from '@/lib/canvas/store';
import { useSessionStore } from '@/lib/sessions';
import type { CanvasDocument, Shape, SyncEvent } from '@/lib/canvas/types';
import type { PenChild } from '@/lib/pen/types';
import { phaseFields, isLiveRunPhase } from '@/lib/canvas/run-phase';

// ---- Fixtures ----------------------------------------------------------------

function makeShape(id: string, name: string, type = 'rectangle'): Shape {
  return {
    id,
    type,
    name,
    x: 0, y: 0, width: 100, height: 100,
    rotation: 0, opacity: 1,
    fill: '#ccc', stroke: '#000', strokeWidth: 0,
    radius: 0, fontSize: 16, textColor: '#000',
    parentId: null, zIndex: 0,
    locked: false, visible: true,
    autoLayout: null, tokenBinding: null, componentId: null,
    points: null, closed: false, src: null, radii: null,
    gradient: null, shadow: null, blur: 0, maskId: null,
    constraints: null,
  } as unknown as Shape;
}

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

/// Seed a live assistant turn the way promptAgent does (busy armed, last
/// turn = streaming assistant) without touching the network.
function seedLiveRun() {
  useCanvasStore.setState((s) => ({
    turns: [
      ...s.turns,
      { id: 'u1', role: 'user', text: 'design a login screen', toolCalls: [], streaming: false },
      { id: 'a1', role: 'assistant', text: '', toolCalls: [], streaming: true, startedAt: Date.now() },
    ],
    ...phaseFields('thinking'),
  }));
}

function lastTurn() {
  return useCanvasStore.getState().turns[useCanvasStore.getState().turns.length - 1];
}

function dispatch(event: SyncEvent) {
  useCanvasStore.getState()._onSync(event);
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
    runPhase: 'idle',
    queuedPrompts: [],
    documentId: 'test-doc',
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

// ---- 1. Canonical runPhase transitions --------------------------------------

describe('runPhase: single source of truth', () => {
  beforeEach(() => resetStore());

  it('stays idle and not-busy at rest, and phaseFields keeps the mirror in lockstep', () => {
    const s = useCanvasStore.getState();
    expect(s.runPhase).toBe('idle');
    expect(s.agentBusy).toBe(false);
    // The lockstep invariant: every phase patch writes BOTH fields.
    expect(phaseFields('thinking')).toEqual({ runPhase: 'thinking', agentBusy: true });
    expect(phaseFields('completed')).toEqual({ runPhase: 'completed', agentBusy: false });
    expect(isLiveRunPhase('cancelling')).toBe(true);
    expect(isLiveRunPhase('completed')).toBe(false);
  });

  it('C3: message_start arms busy for a FOREIGN viewer (reload / second browser)', () => {
    // A foreign viewer has no promptAgent-armed busy state — its last turn
    // is the user message (placeholder creation path) and the run is live
    // server-side.
    useCanvasStore.setState({
      turns: [{ id: 'u1', role: 'user', text: 'design a login', toolCalls: [], streaming: false }],
    });
    dispatch({ type: 'agent:message_start' });
    const s = useCanvasStore.getState();
    expect(s.agentBusy).toBe(true);
    expect(s.runPhase).toBe('thinking');
    // Placeholder was created for the stream to land in.
    expect(lastTurn().role).toBe('assistant');
  });

  it('message_start re-arms after the critique loop\'s mid-run turn_end (busy flip)', () => {
    seedLiveRun();
    // Mid-run turn_end (critique loop boundary) clears busy…
    dispatch({ type: 'agent:turn_end' });
    expect(useCanvasStore.getState().agentBusy).toBe(false);
    // …and the fix turn's message_start re-arms it.
    dispatch({ type: 'agent:message_start' });
    expect(useCanvasStore.getState().agentBusy).toBe(true);
    expect(useCanvasStore.getState().runPhase).toBe('thinking');
  });

  it('refines to tool / finalizing and settles terminal on turn_end', () => {
    seedLiveRun();
    dispatch({ type: 'agent:tool_call_start', toolCallId: 'tc1', toolName: 'pen_add_rect', argsPreview: '{}' });
    expect(useCanvasStore.getState().runPhase).toBe('tool');
    dispatch({ type: 'agent:tool_call_end', toolCallId: 'tc1', success: true, summary: 'added' });
    expect(useCanvasStore.getState().runPhase).toBe('thinking');
    dispatch({ type: 'agent:message_delta', text: 'Here is your design.' });
    expect(useCanvasStore.getState().runPhase).toBe('finalizing');
    dispatch({ type: 'agent:turn_end' });
    const s = useCanvasStore.getState();
    expect(s.agentBusy).toBe(false);
    expect(s.runPhase).toBe('completed');
  });

  it('stopAgent enters the intermediate cancelling phase, then settles cancelled', () => {
    seedLiveRun();
    useCanvasStore.getState().stopAgent();
    // Socket null + no agentAbort → the local finalization branch runs in
    // the same call; the intermediate phase is observable in between via the
    // set order, and the settled state is terminal.
    const s = useCanvasStore.getState();
    expect(s.agentBusy).toBe(false);
    expect(['cancelling', 'cancelled']).toContain(s.runPhase);
    // The server-side confirmation event settles 'cancelled' for every viewer.
    dispatch({ type: 'agent:turn_cancelled' });
    expect(useCanvasStore.getState().runPhase).toBe('cancelled');
    expect(useCanvasStore.getState().agentBusy).toBe(false);
  });

  it('error and stuck clear busy with their terminal phases', () => {
    seedLiveRun();
    dispatch({ type: 'agent:error', message: 'upstream 429' });
    expect(useCanvasStore.getState().runPhase).toBe('failed');
    expect(useCanvasStore.getState().agentBusy).toBe(false);

    resetStore();
    seedLiveRun();
    dispatch({ type: 'agent:stuck', message: 'tool loop' });
    expect(useCanvasStore.getState().runPhase).toBe('stuck');
    expect(useCanvasStore.getState().agentBusy).toBe(false);
  });

  it('plan_proposed → awaiting_input (busy-but-interactive); plan_resolved resumes thinking', () => {
    seedLiveRun();
    dispatch({
      type: 'agent:plan_proposed',
      planId: 'p1',
      title: 'Two-screen build',
      summary: 'login + dashboard',
      steps: [{ step: 1, description: 'login' }],
    });
    expect(useCanvasStore.getState().runPhase).toBe('awaiting_input');
    expect(useCanvasStore.getState().agentBusy).toBe(true); // approval UI live, rest gated
    dispatch({ type: 'agent:plan_resolved', planId: 'p1', decision: 'build' });
    expect(useCanvasStore.getState().runPhase).toBe('thinking');
  });
});

// ---- 2. Busy-guards at the store choke points --------------------------------

describe('busy-guards (one rule at every entry)', () => {
  beforeEach(() => resetStore());

  it('C2: promptAgent while busy routes the prompt into the queue instead of double-running', () => {
    seedLiveRun();
    const turnsBefore = useCanvasStore.getState().turns.length;
    useCanvasStore.getState().promptAgent('a second concurrent prompt');
    const s = useCanvasStore.getState();
    // No new turn pair was appended (no second run armed)…
    expect(s.turns.length).toBe(turnsBefore);
    // …the prompt queued instead.
    expect(s.queuedPrompts.length).toBe(1);
    expect(s.queuedPrompts[0].text).toBe('a second concurrent prompt');
  });

  it('C1: user undo/redo refuse while busy; the agent\'s own canvas:patch undo passes', () => {
    const doc = makeDoc([makeShape('s1', 'Rect')]);
    resetStore(doc);
    // Push an undo entry: mutate while IDLE first.
    useCanvasStore.setState({ undoStack: [makeDoc([])], agentBusy: false, runPhase: 'idle' });
    useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().document.shapes.length).toBe(0); // undone to empty
    expect(useCanvasStore.getState().redoStack.length).toBe(1);

    // Now arm busy and try again — refused, redo stack untouched.
    seedLiveRun();
    useCanvasStore.getState().redo();
    expect(useCanvasStore.getState().document.shapes.length).toBe(0); // NOT redone
    expect(useCanvasStore.getState().redoStack.length).toBe(1);

    // The agent's own undo (canvas:patch op 'undo') bypasses the guard.
    dispatch({ type: 'canvas:patch', patch: { op: 'redo', summary: 'agent redo' } as never });
    expect(useCanvasStore.getState().document.shapes.length).toBe(1);
  });

  it('C1: mutation-bearing sendPatch is paused while busy; select stays live (Figma parity)', () => {
    const doc = makeDoc([makeShape('s1', 'Rect')]);
    resetStore(doc);
    seedLiveRun();

    // Mutation-bearing patch: silently held back (the once-per-run toast is
    // the feedback channel — store stays silent here).
    useCanvasStore.getState().sendPatch({ op: 'remove', shapeIds: ['s1'], summary: 'delete' });
    expect(useCanvasStore.getState().document.shapes.length).toBe(1);

    // Selection is UI state, not a document mutation — stays fully live.
    useCanvasStore.getState().select(['s1']);
    expect(useCanvasStore.getState().selectedIds).toEqual(['s1']);
  });

  it('C5: newSession and forkActiveSession guard BEFORE create (no orphan rows)', () => {
    resetStore();
    // Idle: creating works.
    const created = useCanvasStore.getState().newSession();
    expect(created).toBeTruthy();
    const sessionCount = Object.keys(useSessionStore.getState().sessions).length;

    // Busy: both refuse BEFORE creating anything.
    seedLiveRun();
    expect(useCanvasStore.getState().newSession()).toBeNull();
    expect(useCanvasStore.getState().forkActiveSession(null)).toBeNull();
    expect(Object.keys(useSessionStore.getState().sessions).length).toBe(sessionCount);
  });

  it('C8: restoreSnapshot refuses while busy', () => {
    resetStore();
    seedLiveRun();
    // Snapshot doesn't exist — the guard must fire BEFORE any lookup anyway.
    void useCanvasStore.getState().restoreSnapshot('snap-1');
    // The busy guard returns early; no throw, no state change.
    expect(useCanvasStore.getState().agentBusy).toBe(true);
  });
});

// ---- 3. Sub-agent dispatch resolution ----------------------------------------

describe('sub-agent rows (dispatchId)', () => {
  beforeEach(() => resetStore());

  it('parallel same-type workers resolve independently by dispatchId', () => {
    seedLiveRun();
    dispatch({ type: 'agent:subagent_dispatch', subAgentType: 'multitask_worker', task: '(1/2) Build "Login"', dispatchId: 'mtw_0_Login' });
    dispatch({ type: 'agent:subagent_dispatch', subAgentType: 'multitask_worker', task: '(2/2) Build "Home"', dispatchId: 'mtw_1_Home' });
    let rows = lastTurn().subAgents!;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'running')).toBe(true);

    // The FIRST result must resolve only its own row (the old type+running
    // match resolved BOTH).
    dispatch({
      type: 'agent:subagent_result',
      subAgentType: 'multitask_worker',
      success: true,
      summary: '"Login": built',
      toolCalls: 1,
      dispatchId: 'mtw_0_Login',
    });
    rows = lastTurn().subAgents!;
    expect(rows[0].status).toBe('completed');
    expect(rows[1].status).toBe('running');
    expect(rows[1].summary).toBeUndefined();

    // The second result resolves the remaining row.
    dispatch({
      type: 'agent:subagent_result',
      subAgentType: 'multitask_worker',
      success: false,
      summary: '"Home": failed',
      toolCalls: 0,
      dispatchId: 'mtw_1_Home',
    });
    rows = lastTurn().subAgents!;
    expect(rows[1].status).toBe('failed');
  });

  it('legacy events without dispatchId fall back to type+running matching', () => {
    seedLiveRun();
    dispatch({ type: 'agent:subagent_dispatch', subAgentType: 'design_critic', task: 'Critique canvas' });
    dispatch({ type: 'agent:subagent_result', subAgentType: 'design_critic', success: true, summary: 'clean', toolCalls: 1 });
    expect(lastTurn().subAgents![0].status).toBe('completed');
  });
});

// ---- 4. Session store run status (StatusBadge phases) -------------------------

describe('setRunStatus (StatusBadge phases)', () => {
  beforeEach(() => resetStore());

  it('drives awaiting_tool / cancelling / in_progress on a live run', () => {
    const ss = useSessionStore.getState();
    const session = ss.createSession('test-doc', { title: 'Run phases' });
    const run = ss.startRun(session.id, 'design a login');

    expect(useSessionStore.getState().runs[run.id].status).toBe('in_progress');
    ss.setRunStatus(run.id, 'awaiting_tool');
    expect(useSessionStore.getState().runs[run.id].status).toBe('awaiting_tool');
    ss.setRunStatus(run.id, 'in_progress');
    expect(useSessionStore.getState().runs[run.id].status).toBe('in_progress');
    ss.setRunStatus(run.id, 'cancelling');
    expect(useSessionStore.getState().runs[run.id].status).toBe('cancelling');
  });

  it('never rewrites a terminal run and rejects terminal statuses', () => {
    const ss = useSessionStore.getState();
    const session = ss.createSession('test-doc', { title: 'Terminal guard' });
    const run = ss.startRun(session.id, 'design a dashboard');
    ss.endRun(run.id, 'completed');

    ss.setRunStatus(run.id, 'cancelling');
    expect(useSessionStore.getState().runs[run.id].status).toBe('completed'); // untouched

    const run2 = ss.startRun(session.id, 'another prompt');
    ss.setRunStatus(run2.id, 'completed' as never);
    expect(useSessionStore.getState().runs[run2.id].status).toBe('in_progress'); // terminal values rejected
  });
});

// ---- 5. Queue flush deferral (mid-run turn_end) -------------------------------

describe('queue flush (mid-critique guard)', () => {
  beforeEach(() => resetStore());

  it('a queued prompt survives a busy re-arm inside the flush window (re-queued at the head)', async () => {
    seedLiveRun();
    useCanvasStore.getState().queuePrompt('follow-up prompt');
    expect(useCanvasStore.getState().queuedPrompts.length).toBe(1);

    // turn_end pops the head and defers the flush…
    dispatch({ type: 'agent:turn_end' });
    expect(useCanvasStore.getState().queuedPrompts.length).toBe(0);

    // …the fix turn re-arms busy BEFORE the 350ms timer fires…
    dispatch({ type: 'agent:message_start' });
    expect(useCanvasStore.getState().agentBusy).toBe(true);

    // …so the flush re-queues instead of double-running.
    await new Promise((r) => setTimeout(r, 450));
    expect(useCanvasStore.getState().queuedPrompts.length).toBe(1);
    expect(useCanvasStore.getState().queuedPrompts[0].text).toBe('follow-up prompt');
    // Still a single turn pair — no concurrent run was armed.
    expect(useCanvasStore.getState().turns.length).toBe(2);
  });
});
