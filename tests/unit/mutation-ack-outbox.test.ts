// Store-level tests — mutation identity + offline outbox + reconnect contract
// (Phase B R1 + R5).
//
// Drives sendPatch / _onSync(canvas:full | mutation:ack) directly with a
// fake socket (the shared-canvas.test.ts pattern):
//   - offline sendPatch enqueues (optimistic local apply still runs)
//   - canvas:full sync triggers the flush (AFTER the merge)
//   - accepted/duplicate acks prune; the drain chain re-flushes stragglers
//   - a rejected ack re-anchors the counter, drops the queue, toasts
//   - select ops are never stamped / never queued
//   - document:restore clears the queue

import { describe, it, expect, beforeEach, vi } from 'vitest';

// sonner mock — hoisted; the rejected-ack toast assertion reads toastCalls.
const toastState = vi.hoisted(() => ({ errors: [] as Array<{ title: unknown; description: unknown }> }));
vi.mock('sonner', () => ({
  toast: {
    error: (title: unknown, opts?: { description?: unknown }) => {
      toastState.errors.push({ title, description: opts?.description });
    },
    info: vi.fn(),
    warning: vi.fn(),
    success: vi.fn(),
    message: vi.fn(),
  },
}));

import { useCanvasStore } from '@/lib/canvas/store';
import { useSessionStore } from '@/lib/sessions';
import type { ClientEvent, SyncEvent } from '@/lib/canvas/types';
import {
  outboxSize,
  outboxEntries,
  __resetClientMutationsForTests,
  __reloadClientMutationsForTests,
} from '@/lib/canvas/client-mutations';

const DOC = 'demo';

function makeDoc() {
  return {
    id: DOC, name: 'Doc', background: '#fff', version: '2.17',
    children: [], viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes: [], tokens: { colors: [], textStyles: [] },
  };
}

function resetStore(connected = false) {
  const emitted: ClientEvent[] = [];
  useCanvasStore.setState({
    document: makeDoc(),
    selectedIds: [], agentHighlightIds: [],
    socket: { emit: (_ch: string, ev: ClientEvent) => { emitted.push(ev); } } as never,
    connected,
    viewerCount: 1, remotePresence: {}, turns: [], agentBusy: false,
    documentId: DOC, activeSessionId: null, undoStack: [], redoStack: [],
    guideLines: [], guideUndoStack: [], guideRedoStack: [],
    checkpoints: [], lastCheckpointSignature: null, turnCounter: 0,
  });
  useSessionStore.setState({
    sessions: {}, runs: {}, messages: {}, toolCalls: {}, snapshots: {}, activeSessionByDoc: {},
  });
  return { emitted };
}

function dispatch(ev: SyncEvent) {
  useCanvasStore.getState()._onSync(ev);
}

const updatePatch = { op: 'update', shapeId: 's1', shape: { fill: '#fff' } } as never;

describe('sendPatch: mutation identity + offline enqueue (R1/R5)', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetClientMutationsForTests();
  });

  it('stamps clientId + contiguous clientMutationId on online emits', () => {
    const { emitted } = resetStore(true);

    useCanvasStore.getState().sendPatch(updatePatch);
    useCanvasStore.getState().sendPatch(updatePatch);

    expect(emitted).toHaveLength(2);
    const first = emitted[0] as { clientMutationId?: number; clientId?: string };
    const second = emitted[1] as { clientMutationId?: number; clientId?: string };
    expect(first.clientMutationId).toBe(1);
    expect(second.clientMutationId).toBe(2);
    expect(first.clientId).toBeTruthy();
    expect(second.clientId).toBe(first.clientId);
    expect(outboxSize(DOC)).toBe(0);
  });

  it('select ops emit WITHOUT identity (never journaled, never queued)', () => {
    const { emitted } = resetStore(true);

    useCanvasStore.getState().sendPatch({ op: 'select', ids: ['a'] } as never);

    expect(emitted).toHaveLength(1);
    const ev = emitted[0] as { clientMutationId?: number; clientId?: string };
    expect(ev.clientMutationId).toBeUndefined();
    expect(ev.clientId).toBeUndefined();
  });

  it('offline patches enqueue in the outbox; the local apply still runs', () => {
    const { emitted } = resetStore(false); // disconnected

    useCanvasStore.getState().sendPatch(updatePatch);
    useCanvasStore.getState().sendPatch(updatePatch);

    expect(emitted).toHaveLength(0); // nothing on the wire
    expect(outboxSize(DOC)).toBe(2);
    expect(outboxEntries(DOC).map((e) => e.clientMutationId)).toEqual([1, 2]);
  });

  it('while the queue is draining, NEW online edits enqueue behind it (no overtake gap)', () => {
    const { emitted } = resetStore(true);
    // Queue entry 1 as if offline-queued (clientMutationId 1).
    useCanvasStore.setState({ connected: false });
    useCanvasStore.getState().sendPatch(updatePatch);
    expect(outboxSize(DOC)).toBe(1);

    // Reconnect, queue not yet acked — a fresh edit must NOT emit directly.
    useCanvasStore.setState({ connected: true });
    useCanvasStore.getState().sendPatch(updatePatch);

    expect(emitted).toHaveLength(0);
    expect(outboxSize(DOC)).toBe(2);
  });
});

describe('reconnect contract: canvas:full → outbox flush → ack prune (R5)', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetClientMutationsForTests();
  });

  it('canvas:full sync flushes the queued entries in ascending order', () => {
    const { emitted } = resetStore(false);
    useCanvasStore.getState().sendPatch(updatePatch); // id 1
    useCanvasStore.getState().sendPatch(updatePatch); // id 2
    expect(emitted).toHaveLength(0);

    // Reconnect: canvas:full arrives (reason sync, same empty doc).
    useCanvasStore.setState({ connected: true });
    dispatch({ type: 'canvas:full', document: makeDoc(), reason: 'sync' });

    expect(emitted).toHaveLength(2);
    expect(emitted.map((e) => (e as { clientMutationId?: number }).clientMutationId)).toEqual([1, 2]);
    // Queue keeps entries until acks prune them.
    expect(outboxSize(DOC)).toBe(2);
  });

  it('accepted acks prune the queue; newer stragglers re-flush (drain chain)', () => {
    const { emitted } = resetStore(false);
    useCanvasStore.getState().sendPatch(updatePatch); // id 1
    useCanvasStore.getState().sendPatch(updatePatch); // id 2
    useCanvasStore.setState({ connected: true });
    dispatch({ type: 'canvas:full', document: makeDoc(), reason: 'sync' });
    expect(emitted).toHaveLength(2);

    // Ack for id 1 only (id 2's ack is still in flight).
    dispatch({ type: 'mutation:ack', clientId: 'me', clientMutationId: 1, status: 'accepted', lastMutationId: 1 });
    expect(outboxSize(DOC)).toBe(1);

    // A new edit lands while id 2 is un-acked → it enqueues (no overtake)…
    useCanvasStore.getState().sendPatch(updatePatch); // id 3
    expect(outboxSize(DOC)).toBe(2);

    // …and the ack for 2 re-flushes 2 AND 3.
    dispatch({ type: 'mutation:ack', clientId: 'me', clientMutationId: 2, status: 'accepted', lastMutationId: 2 });
    expect(outboxSize(DOC)).toBe(1); // 3 still awaiting ITS ack
    const ids = emitted.map((e) => (e as { clientMutationId?: number }).clientMutationId);
    expect(ids).toEqual([1, 2, 2, 3]); // flush, then drain-chain re-flush of 2+3

    dispatch({ type: 'mutation:ack', clientId: 'me', clientMutationId: 3, status: 'accepted', lastMutationId: 3 });
    expect(outboxSize(DOC)).toBe(0);

    // Queue empty again → direct emit resumes.
    useCanvasStore.getState().sendPatch(updatePatch); // id 4
    expect(emitted[emitted.length - 1]).toMatchObject({ clientMutationId: 4 });
  });

  it('duplicate acks prune too (retried outbox entry already applied server-side)', () => {
    resetStore(false);
    useCanvasStore.getState().sendPatch(updatePatch); // id 1

    dispatch({ type: 'mutation:ack', clientId: 'me', clientMutationId: 1, status: 'duplicate', lastMutationId: 1 });

    expect(outboxSize(DOC)).toBe(0);
  });

  it('a REJECTED ack re-anchors the counter, drops the queue, and surfaces a toast', () => {
    toastState.errors.length = 0;
    resetStore(false);
    useCanvasStore.getState().sendPatch(updatePatch); // id 1
    useCanvasStore.getState().sendPatch(updatePatch); // id 2

    dispatch({ type: 'mutation:ack', clientId: 'me', clientMutationId: 2, status: 'rejected', lastMutationId: 0 });

    expect(outboxSize(DOC)).toBe(0); // dropped
    expect(toastState.errors).toHaveLength(1);
    expect(String(toastState.errors[0].title)).toContain('could not be synced');
    // Counter re-anchored to last+1 = 1 → next stamp is 1 again.
    useCanvasStore.getState().sendPatch(updatePatch);
    expect(outboxEntries(DOC).map((e) => e.clientMutationId)).toEqual([1]);
  });

  it('document:restore clears the queue (restore re-orders intent)', () => {
    resetStore(false);
    useCanvasStore.getState().sendPatch(updatePatch);
    expect(outboxSize(DOC)).toBe(1);

    dispatch({ type: 'canvas:full', document: makeDoc(), reason: 'restore' });

    expect(outboxSize(DOC)).toBe(0);
  });

  it('the outbox survives a page reload mid-outage (localStorage durability)', () => {
    resetStore(false);
    useCanvasStore.getState().sendPatch(updatePatch);
    useCanvasStore.getState().sendPatch(updatePatch);

    __reloadClientMutationsForTests(); // fresh module, same localStorage

    expect(outboxSize(DOC)).toBe(2);
    expect(outboxEntries(DOC)[0].clientMutationId).toBe(1);
  });
});
