// Unit tests — client-side mutation identity + offline outbox
// (src/lib/canvas/client-mutations.ts, Phase B R1 + R5).

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getClientId,
  nextMutationId,
  persistMutationClock,
  anchorMutationCounter,
  enqueueOutboxPatch,
  outboxEntries,
  outboxSize,
  pruneOutboxUpTo,
  clearOutbox,
  isMutationBearingPatch,
  __resetClientMutationsForTests,
  __reloadClientMutationsForTests,
} from '@/lib/canvas/client-mutations';

const DOC = 'doc-outbox';
const patch = (op: string) => ({ op, shapeId: 's1' }) as never;

describe('client-mutations: stable client identity', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetClientMutationsForTests();
  });

  it('generates once and persists — the same id comes back after a reload', () => {
    const a = getClientId();
    expect(a).toBeTruthy();
    expect(getClientId()).toBe(a); // cached
    // Simulate reload: clear ONLY the module cache, keep localStorage.
    __reloadClientMutationsForTests();
    const b = getClientId();
    expect(b).toBe(a);
  });
});

describe('client-mutations: monotonic mutation counter', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetClientMutationsForTests();
  });

  it('stamps contiguous ids', () => {
    expect(nextMutationId()).toBe(1);
    expect(nextMutationId()).toBe(2);
    expect(nextMutationId()).toBe(3);
  });

  it('reloads the persisted counter (crash recovery)', () => {
    nextMutationId();
    nextMutationId();
    persistMutationClock(); // value 2 persisted
    __reloadClientMutationsForTests(); // fresh module, same localStorage
    expect(nextMutationId()).toBe(3);
  });

  it('anchors to the server clock — never moves backwards for queued offline edits', () => {
    nextMutationId(); // 1 — an offline edit queued in the outbox
    nextMutationId(); // 2 — still queued
    persistMutationClock();

    // Server says our clock is at 5 (a previous session's accepted edits).
    anchorMutationCounter(5);
    expect(nextMutationId()).toBe(6);

    // Local-ahead counter must NOT regress: server is behind us.
    anchorMutationCounter(2);
    expect(nextMutationId()).toBe(7);
  });

  it('ignores invalid anchors', () => {
    anchorMutationCounter(undefined);
    anchorMutationCounter(null);
    anchorMutationCounter(Number.NaN);
    expect(nextMutationId()).toBe(1);
  });
});

describe('client-mutations: outbox', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetClientMutationsForTests();
  });

  it('enqueues and returns entries in ascending clientMutationId order', () => {
    enqueueOutboxPatch(DOC, 3, patch('update'));
    enqueueOutboxPatch(DOC, 1, patch('add'));
    enqueueOutboxPatch(DOC, 2, patch('remove'));

    const entries = outboxEntries(DOC);
    expect(entries.map((e) => e.clientMutationId)).toEqual([1, 2, 3]);
    expect(outboxSize(DOC)).toBe(3);
  });

  it('persists across a module reset (localStorage durability)', () => {
    enqueueOutboxPatch(DOC, 1, patch('update'));
    enqueueOutboxPatch(DOC, 2, patch('update'));

    __reloadClientMutationsForTests(); // fresh module, same localStorage

    expect(outboxSize(DOC)).toBe(2);
    expect(outboxEntries(DOC)[0].clientMutationId).toBe(1);
  });

  it('prunes acked entries (id <= lastMutationId) — the Replicache rule', () => {
    enqueueOutboxPatch(DOC, 1, patch('update'));
    enqueueOutboxPatch(DOC, 2, patch('update'));
    enqueueOutboxPatch(DOC, 3, patch('update'));

    const pruned = pruneOutboxUpTo(DOC, 2);

    expect(pruned).toBe(2);
    expect(outboxEntries(DOC).map((e) => e.clientMutationId)).toEqual([3]);
    // Idempotent: pruning again at the same bound is a no-op.
    expect(pruneOutboxUpTo(DOC, 2)).toBe(0);
  });

  it('clear drops the whole queue and reports the count (permanent rejection)', () => {
    enqueueOutboxPatch(DOC, 1, patch('update'));
    enqueueOutboxPatch(DOC, 2, patch('update'));
    expect(clearOutbox(DOC)).toBe(2);
    expect(outboxSize(DOC)).toBe(0);
    expect(clearOutbox(DOC)).toBe(0);
  });

  it('caps the queue at 500 per document (drop-oldest)', () => {
    for (let i = 1; i <= 505; i++) {
      enqueueOutboxPatch(DOC, i, patch('update'));
    }
    expect(outboxSize(DOC)).toBe(500);
    const entries = outboxEntries(DOC);
    expect(entries[0].clientMutationId).toBe(6); // oldest dropped
    expect(entries[entries.length - 1].clientMutationId).toBe(505);
  });

  it('isolates queues per document', () => {
    enqueueOutboxPatch('doc-a', 1, patch('update'));
    enqueueOutboxPatch('doc-b', 1, patch('update'));
    pruneOutboxUpTo('doc-a', 1);
    expect(outboxSize('doc-a')).toBe(0);
    expect(outboxSize('doc-b')).toBe(1);
  });

  it('survives corrupt localStorage gracefully', () => {
    localStorage.setItem('agentcanvas.outbox.v1', '{not json');
    expect(outboxSize(DOC)).toBe(0);
    enqueueOutboxPatch(DOC, 1, patch('update'));
    expect(outboxSize(DOC)).toBe(1);
  });
});

describe('client-mutations: select ops never bear identity', () => {
  it('marks select as non-mutation (never stamped, never queued)', () => {
    expect(isMutationBearingPatch({ op: 'select' } as never)).toBe(false);
    expect(isMutationBearingPatch({ op: 'update' } as never)).toBe(true);
    expect(isMutationBearingPatch({ op: 'add' } as never)).toBe(true);
    expect(isMutationBearingPatch({ op: 'remove' } as never)).toBe(true);
  });
});
