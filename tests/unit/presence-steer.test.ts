// Presence lane tests (R7) + steer registry tests (R8c).
//
// Store-level: roster/update SyncEvents land in `remotePresence`;
// sendPresence emits presence:update ClientEvents through a fake socket
// (selection changes immediate, cursor moves 33ms-throttled with a trailing
// flush — fake timers).
//
// Registry-level: the active-sessions module that backs the real
// agent:steer — register/steer/unregister with identity checks.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useCanvasStore, __resetPresenceForTests } from '@/lib/canvas/store';
import { useSessionStore } from '@/lib/sessions';
import {
  registerActiveSession,
  steerActiveSession,
  hasActiveSession,
  __clearActiveSessions,
} from '@/lib/agent/active-sessions';
import type { ClientEvent, CanvasDocument, Shape } from '@/lib/canvas/types';
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

let emitted: ClientEvent[] = [];

function resetStore() {
  emitted = [];
  __resetPresenceForTests();
  useCanvasStore.setState({
    document: makeDoc([]),
    selectedIds: [],
    agentHighlightIds: [],
    socket: { emit: (_ch: string, ev: ClientEvent) => { emitted.push(ev); } } as never,
    connected: true,
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

// ---- Inbound presence ---------------------------------------------------------

describe('presence lane inbound (R7)', () => {
  beforeEach(() => resetStore());

  it('presence:roster replaces the whole remote map', () => {
    useCanvasStore.getState()._onSync({
      type: 'presence:roster',
      roster: [
        { participantId: 'p1', name: 'Guest A', color: '#f97316', cursor: { x: 1, y: 2 } },
        { participantId: 'p2', name: 'Guest B', color: '#06b6d4' },
      ],
    });
    expect(Object.keys(useCanvasStore.getState().remotePresence).sort()).toEqual(['p1', 'p2']);

    // A later, smaller roster REPLACES (a participant left).
    useCanvasStore.getState()._onSync({
      type: 'presence:roster',
      roster: [{ participantId: 'p1', name: 'Guest A', color: '#f97316' }],
    });
    expect(Object.keys(useCanvasStore.getState().remotePresence)).toEqual(['p1']);
  });

  it('presence:update upserts one participant without touching others', () => {
    useCanvasStore.getState()._onSync({
      type: 'presence:roster',
      roster: [{ participantId: 'p1', name: 'Guest A', color: '#f97316' }],
    });
    useCanvasStore.getState()._onSync({
      type: 'presence:update',
      participant: { participantId: 'p2', name: 'Guest B', color: '#06b6d4', cursor: { x: 10, y: 20 }, selection: ['s1'] },
    });
    const presence = useCanvasStore.getState().remotePresence;
    expect(presence.p1).toBeDefined();
    expect(presence.p2.cursor).toEqual({ x: 10, y: 20 });
    expect(presence.p2.selection).toEqual(['s1']);

    // Same participant again → updated in place.
    useCanvasStore.getState()._onSync({
      type: 'presence:update',
      participant: { participantId: 'p2', name: 'Guest B', color: '#06b6d4', cursor: null, idle: true },
    });
    const after = useCanvasStore.getState().remotePresence;
    expect(after.p2.cursor).toBeNull();
    expect(after.p2.idle).toBe(true);
    expect(after.p1).toBeDefined();
  });

  it('legacy presence (viewerCount) still lands', () => {
    useCanvasStore.getState()._onSync({ type: 'presence', viewerCount: 3 });
    expect(useCanvasStore.getState().viewerCount).toBe(3);
  });
});

// ---- Outbound presence --------------------------------------------------------

describe('presence lane outbound (R7)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStore();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('selection changes emit immediately as presence:update', () => {
    useCanvasStore.getState().sendPresence({ selection: ['a', 'b'] });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].type).toBe('presence:update');
    if (emitted[0].type !== 'presence:update') return;
    expect(emitted[0].documentId).toBe('demo');
    expect(emitted[0].participant.selection).toEqual(['a', 'b']);
    expect(emitted[0].participant.participantId).toMatch(/^p-/);
    expect(emitted[0].participant.name).toMatch(/^Guest /);
  });

  it('cursor bursts are throttled: first immediate, rest trailing', () => {
    const send = useCanvasStore.getState().sendPresence;
    send({ cursor: { x: 1, y: 1 } });
    expect(emitted).toHaveLength(1); // leading edge
    send({ cursor: { x: 2, y: 2 } });
    send({ cursor: { x: 3, y: 3 } });
    send({ cursor: { x: 4, y: 4 } });
    expect(emitted).toHaveLength(1); // still inside the 33ms window
    vi.advanceTimersByTime(50);
    expect(emitted).toHaveLength(2); // trailing flush
    const last = emitted[1];
    if (last.type !== 'presence:update') throw new Error('expected presence:update');
    expect(last.participant.cursor).toEqual({ x: 4, y: 4 }); // LAST position wins
  });

  it('idle flips ride along with the next emit (cumulative state)', () => {
    const send = useCanvasStore.getState().sendPresence;
    send({ cursor: { x: 1, y: 1 } });
    send({ idle: true }); // non-cursor → immediate
    expect(emitted).toHaveLength(2);
    const last = emitted[1];
    if (last.type !== 'presence:update') throw new Error('expected presence:update');
    expect(last.participant.idle).toBe(true);
    expect(last.participant.cursor).toEqual({ x: 1, y: 1 }); // state carried over
  });

  it('emits nothing while disconnected', () => {
    useCanvasStore.setState({ connected: false });
    useCanvasStore.getState().sendPresence({ selection: ['a'] });
    vi.advanceTimersByTime(100);
    expect(emitted).toHaveLength(0);
  });
});

// ---- Steer registry (R8c) -----------------------------------------------------

describe('active-sessions registry (R8c)', () => {
  beforeEach(() => {
    __clearActiveSessions();
  });

  it('returns false when no session is registered for the document', async () => {
    await expect(steerActiveSession('demo', 'make it blue')).resolves.toBe(false);
    expect(hasActiveSession('demo')).toBe(false);
  });

  it('steers the registered session with the text', async () => {
    const steer = vi.fn().mockResolvedValue(undefined);
    const unregister = registerActiveSession('demo', { steer });
    await expect(steerActiveSession('demo', 'make it blue')).resolves.toBe(true);
    expect(steer).toHaveBeenCalledWith('make it blue');
    unregister();
  });

  it('unregistering makes the document unsteerable again', async () => {
    const unregister = registerActiveSession('demo', { steer: vi.fn() });
    unregister();
    await expect(steerActiveSession('demo', 'too late')).resolves.toBe(false);
  });

  it('identity check: a stale unregister never evicts a newer session', async () => {
    const first = { steer: vi.fn() };
    const second = { steer: vi.fn() };
    const unregisterFirst = registerActiveSession('demo', first);
    registerActiveSession('demo', second); // retry/fallback replaced the entry
    unregisterFirst(); // must NOT evict `second`
    expect(hasActiveSession('demo')).toBe(true);
    await expect(steerActiveSession('demo', 'x')).resolves.toBe(true);
  });

  it('a throwing steer evicts the dead session and returns false', async () => {
    const steer = vi.fn().mockRejectedValue(new Error('disposed'));
    registerActiveSession('demo', { steer });
    await expect(steerActiveSession('demo', 'x')).resolves.toBe(false);
    expect(hasActiveSession('demo')).toBe(false); // corpse removed
  });
});

// ---- steer_rejected feedback ---------------------------------------------------

describe('agent:steer_rejected feedback (R8c)', () => {
  it('warns via toast without touching turn/run state', async () => {
    const { toast } = await import('sonner');
    const warn = vi.spyOn(toast, 'warning').mockImplementation(() => ({}) as never);
    resetStore();
    useCanvasStore.setState({
      turns: [{ id: 't1', role: 'assistant', text: 'so far', streaming: true, toolCalls: [] }],
      agentBusy: true,
    });
    useCanvasStore.getState()._onSync({ type: 'agent:steer_rejected', reason: 'No agent run is active on this canvas.' });
    expect(warn).toHaveBeenCalled();
    const state = useCanvasStore.getState();
    expect(state.agentBusy).toBe(true); // untouched — unlike agent:error
    expect(state.turns[0].streaming).toBe(true); // untouched
    warn.mockRestore();
  });
});
