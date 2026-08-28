// Unit tests — server-side user-patch journaling with exactly-once semantics
// (src/lib/canvas/user-patch-journal.ts, Phase B R1).
//
// Verifies the Replicache lastMutationID rules:
//   id == last + 1  → accepted (journal row + clock bump)
//   id <= last      → duplicate (no journal row, no re-apply)
//   id  > last + 1  → rejected  (gap — client must re-anchor)
// plus the concurrent first-seed lock and the read-side clock map.
//
// TEST STRATEGY: the module under test reaches the DB through a dynamic
// `import('../db')`, which vitest's vi.mock registry does NOT reliably
// intercept for this module (empirically: writes silently land in the real
// SQLite file). So the clock store runs against a REAL throwaway SQLite
// database (created via $executeRawUnsafe in beforeAll, unlinked in
// afterAll), while the journal dependency (event-journal, statically
// imported) is mocked with a plain static vi.mock — the reliable path.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { unlinkSync } from 'node:fs';

const TMP_DB = `/tmp/agentcanvas-upj-test-${process.pid}-${Date.now()}.db`;
const PREV_DB_URL = process.env.DATABASE_URL;
process.env.DATABASE_URL = `file:${TMP_DB}`;

const state = vi.hoisted(() => ({
  journalRows: [] as Array<{ documentId: string; type: string; toolCallId: string | null; payload: unknown }>,
}));

vi.mock('@/lib/agent/event-journal', () => ({
  appendSyntheticJournalEvent: vi.fn(
    (documentId: string, type: string, toolCallId: string | undefined, payload: unknown) => {
      state.journalRows.push({ documentId, type, toolCallId: toolCallId ?? null, payload });
    },
  ),
}));

import { acceptUserMutation, getMutationClocks, __clearUserPatchJournalForTests } from '@/lib/canvas/user-patch-journal';
import { db } from '@/lib/db';

const DOC = 'doc-r1';
const PATCH = { op: 'update', shapeId: 's1', shape: { fill: '#fff' } } as never;

async function decide(clientId: string, id: number) {
  return acceptUserMutation(DOC, clientId, id, PATCH);
}

beforeAll(async () => {
  await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "MutationClock" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "documentId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "lastMutationId" INTEGER NOT NULL,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await db.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "MutationClock_documentId_clientId_key"
    ON "MutationClock"("documentId", "clientId")`);
});

afterAll(async () => {
  await db.$disconnect();
  if (PREV_DB_URL !== undefined) process.env.DATABASE_URL = PREV_DB_URL;
  else delete process.env.DATABASE_URL;
  try { unlinkSync(TMP_DB); } catch { /* best effort */ }
});

describe('user-patch-journal: exactly-once rules (Replicache lastMutationID)', () => {
  beforeEach(async () => {
    state.journalRows.length = 0;
    await db.mutationClock.deleteMany({});
    __clearUserPatchJournalForTests();
  });

  it('accepts the first contiguous mutation: journal row + clock bump', async () => {
    const d = await decide('client-a', 1);

    expect(d).toEqual({ status: 'accepted', lastMutationId: 1 });
    expect(state.journalRows).toHaveLength(1);
    expect(state.journalRows[0].type).toBe('user_patch');
    expect(state.journalRows[0].toolCallId).toBeNull();
    expect(state.journalRows[0].payload).toMatchObject({ clientId: 'client-a', clientMutationId: 1 });
    expect((state.journalRows[0].payload as { patch: unknown }).patch).toMatchObject({ op: 'update' });
    // Durable clock landed in the (temp, real) table.
    const clocks = await getMutationClocks(DOC);
    expect(clocks).toEqual({ 'client-a': 1 });
  });

  it('answers a retried mutation (id <= last) as duplicate — no new journal row', async () => {
    await decide('client-a', 1);

    const d = await decide('client-a', 1); // retry / outbox re-send after lost ack

    expect(d).toEqual({ status: 'duplicate', lastMutationId: 1 });
    expect(state.journalRows).toHaveLength(1); // NOT re-journaled
    expect((await getMutationClocks(DOC))['client-a']).toBe(1); // NOT bumped
  });

  it('rejects a gap (id > last + 1) — the client must re-anchor', async () => {
    await decide('client-a', 1);

    const d = await decide('client-a', 4); // 2 and 3 never seen

    expect(d).toEqual({ status: 'rejected', lastMutationId: 1 });
    expect(state.journalRows).toHaveLength(1);
  });

  it('rejects invalid ids (0, negative, NaN)', async () => {
    expect((await decide('client-a', 0)).status).toBe('rejected');
    expect((await decide('client-a', -3)).status).toBe('rejected');
    expect((await decide('client-a', Number.NaN)).status).toBe('rejected');
    expect(state.journalRows).toHaveLength(0);
  });

  it('accepts a later contiguous mutation after the gap was healed (client re-anchored to last+1)', async () => {
    await decide('client-a', 1);
    await decide('client-a', 4); // rejected gap
    // Client re-anchors: next id = last + 1 = 2
    const d = await decide('client-a', 2);

    expect(d.status).toBe('accepted');
    expect(d.lastMutationId).toBe(2);
    expect(state.journalRows).toHaveLength(2);
  });

  it('tracks clocks per client — client-b does not inherit client-a progress', async () => {
    await decide('client-a', 1);
    await decide('client-a', 2);

    const d = await decide('client-b', 1);

    expect(d.status).toBe('accepted');
    expect(await getMutationClocks(DOC)).toEqual({ 'client-a': 2, 'client-b': 1 });
  });

  it('seeds the in-memory clock from the DB on first sight (restart recovery)', async () => {
    // A previous process already accepted mutations 1-3 for client-c.
    await db.mutationClock.create({
      data: { documentId: DOC, clientId: 'client-c', lastMutationId: 3 },
    });

    const dup = await decide('client-c', 3);
    expect(dup.status).toBe('duplicate');

    const next = await decide('client-c', 4);
    expect(next.status).toBe('accepted');
  });

  it('two concurrent first-ever mutations share one seed and resolve in order', async () => {
    // Both calls hit the DB seed simultaneously (socket events in one tick).
    const [d1, d2] = await Promise.all([decide('client-d', 1), decide('client-d', 2)]);

    // First-registered continuation reserves 1; the second sees clock=1 and
    // accepts the contiguous 2. Neither double-wins, neither is lost.
    expect(d1.status).toBe('accepted');
    expect(d2.status).toBe('accepted');
    expect(state.journalRows).toHaveLength(2);
    expect((await getMutationClocks(DOC))['client-d']).toBe(2);
  });

  it('getMutationClocks scopes to the document', async () => {
    await decide('client-a', 1);
    await acceptUserMutation('doc-other', 'client-a', 1, PATCH);

    expect(await getMutationClocks(DOC)).toEqual({ 'client-a': 1 });
    expect(await getMutationClocks('doc-other')).toEqual({ 'client-a': 1 });
  });
});
