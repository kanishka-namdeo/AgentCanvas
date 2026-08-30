// Unit tests — server-side journal fold (src/lib/canvas/journal-fold.ts,
// Phase C R2): server-authoritative canvas state = newest fold checkpoint +
// journal tail replay.
//
// Verifies the R2 contract:
//   - hydrateDocumentFromJournal folds user_patch + patch + document_restore
//     rows above the newest server checkpoint (restart survival for BOTH
//     user edits and agent patches — the Phase B gap's end-to-end closure);
//   - legacy documents (only client snapshots, no lastSeq) bootstrap from the
//     newest snapshot + newer rows, then write a real checkpoint;
//   - tombstone lane: removes/clears tracked FIFO-capped, re-adds cleared;
//   - writeServerCheckpoint persists {source:'server', lastSeq, tombstones}
//     after a journal-head quiescence probe;
//   - maybeCompactJournal prunes rows ≤ snapshotSeq - KEEP_TAIL once the
//     prunable window clears COMPACT_MIN_ROWS (churn guard);
//   - computeChangedNodeIdsSince returns the delta ids for R9a, null on
//     global ops.
//
// TEST STRATEGY (user-patch-journal.test.ts pattern): the module reaches the
// DB via dynamic `import('../db')` which vi.mock does NOT reliably intercept
// for newer modules — so checkpoints/restore rows run against a REAL
// throwaway SQLite, while the journal tail (event-journal, statically
// imported) is an in-memory vi.mock.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { unlinkSync } from 'node:fs';

const TMP_DB = `/tmp/agentcanvas-fold-test-${process.pid}-${Date.now()}.db`;
const PREV_DB_URL = process.env.DATABASE_URL;
process.env.DATABASE_URL = `file:${TMP_DB}`;

const state = vi.hoisted(() => ({
  rows: [] as Array<{ documentId: string; seq: number; type: string; toolCallId: string | null; payload: unknown; createdAt: Date }>,
}));

vi.mock('@/lib/agent/event-journal', () => ({
  getJournalEvents: vi.fn(async (documentId: string, afterSeq: number, limit: number) =>
    state.rows
      .filter((r) => r.documentId === documentId && r.seq > afterSeq)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit)
      .map((r) => ({ ...r }))),
  getJournalLastSeq: vi.fn(async (documentId: string) =>
    state.rows
      .filter((r) => r.documentId === documentId)
      .reduce((m, r) => Math.max(m, r.seq), 0)),
  getJournalOldestSeq: vi.fn(async (documentId: string) => {
    const rs = state.rows.filter((r) => r.documentId === documentId).sort((a, b) => a.seq - b.seq);
    return rs.length ? rs[0].seq : null;
  }),
  deleteJournalRowsUpTo: vi.fn(async (documentId: string, upToSeq: number) => {
    const before = state.rows.length;
    state.rows = state.rows.filter((r) => !(r.documentId === documentId && r.seq <= upToSeq));
    return before - state.rows.length;
  }),
  appendSyntheticJournalEvent: vi.fn(
    (documentId: string, type: string, toolCallId: string | undefined, payload: unknown) => {
      const seq = state.rows
        .filter((r) => r.documentId === documentId)
        .reduce((m, r) => Math.max(m, r.seq), 0) + 1;
      state.rows.push({
        documentId,
        seq,
        type,
        toolCallId: toolCallId ?? null,
        payload: JSON.parse(JSON.stringify(payload)),
        createdAt: new Date(),
      });
    },
  ),
  flushJournal: vi.fn(async () => {}),
}));

import {
  hydrateDocumentFromJournal,
  writeServerCheckpoint,
  maybeCompactJournal,
  journalDocumentRestore,
  getCheckpointSeq,
  computeChangedNodeIdsSince,
  trackPatchTombstones,
  TOMBSTONE_CAP,
  emptyDocument,
  collectAllNodeIds,
} from '@/lib/canvas/journal-fold';
import { db } from '@/lib/db';
import type { CanvasDocument, CanvasPatch } from '@/lib/canvas/types';

const DOC = 'doc-fold';

/// Seed one journal row with the NEXT seq for the document.
function seedRow(type: string, payload: unknown, documentId = DOC): number {
  const seq = state.rows
    .filter((r) => r.documentId === documentId)
    .reduce((m, r) => Math.max(m, r.seq), 0) + 1;
  state.rows.push({ documentId, seq, type, toolCallId: null, payload, createdAt: new Date() });
  return seq;
}

function addPatch(id: string, x = 10): CanvasPatch {
  return { op: 'add', shapeId: id, shape: { type: 'rectangle', x, y: 10, width: 50, height: 50, fill: '#ff0000' } } as never;
}

function updatePatch(id: string, x: number): CanvasPatch {
  return { op: 'update', shapeId: id, shape: { x } } as never;
}

function removePatch(id: string): CanvasPatch {
  return { op: 'remove', shapeId: id } as never;
}

async function insertSnapshotRow(data: {
  id: string;
  source: string;
  document: CanvasDocument;
  lastSeq?: number | null;
  tombstones?: string[] | null;
  createdAt?: Date;
}): Promise<void> {
  await db.documentSnapshot.create({
    data: {
      id: data.id,
      documentId: DOC,
      document: JSON.stringify(data.document),
      source: data.source,
      nodeCount: collectAllNodeIds(data.document).length,
      lastSeq: data.lastSeq ?? null,
      tombstones: data.tombstones ? JSON.stringify(data.tombstones) : null,
      ...(data.createdAt ? { createdAt: data.createdAt } : {}),
    },
  });
}

/// Deterministically wait for hydrate's fire-and-forget bootstrap checkpoint
/// write to land (polling — a fixed sleep is a flake under CI scheduling).
async function waitForCheckpoint(seq: number): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if ((await getCheckpointSeq(DOC)) === seq) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`checkpoint at seq ${seq} never landed`);
}

beforeAll(async () => {
  await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "DocumentSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT,
    "runId" TEXT,
    "documentId" TEXT NOT NULL,
    "document" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'turn_end',
    "nodeCount" INTEGER NOT NULL DEFAULT 0,
    "bookmarked" BOOLEAN NOT NULL DEFAULT false,
    "lastSeq" INTEGER,
    "tombstones" TEXT,
    "label" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "AgentEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "documentId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "toolCallId" TEXT,
    "payload" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await db.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "AgentEvent_documentId_seq_key"
    ON "AgentEvent"("documentId", "seq")`);
});

afterAll(async () => {
  await db.$disconnect();
  if (PREV_DB_URL !== undefined) process.env.DATABASE_URL = PREV_DB_URL;
  else delete process.env.DATABASE_URL;
  try { unlinkSync(TMP_DB); } catch { /* best effort */ }
});

beforeEach(async () => {
  state.rows.length = 0;
  await db.documentSnapshot.deleteMany({});
  await db.agentEvent.deleteMany({});
});

afterEach(async () => {
  // Drain fire-and-forget checkpoint writes still in flight (hydrate's
  // bootstrap + writeServerCheckpoint callers): a late write from test N
  // would otherwise land in test N+1's database and hijack its hydration.
  await new Promise((resolve) => setTimeout(resolve, 150));
  await db.documentSnapshot.deleteMany({});
});

describe('hydrateDocumentFromJournal (R2 fold)', () => {
  it('folds user_patch AND patch rows from empty — restart survival for both edit sources', async () => {
    seedRow('user_patch', { patch: addPatch('user-node'), clientId: 'c1', clientMutationId: 1 });
    seedRow('agent:message_start', { type: 'agent:message_start' }); // transcript row — skipped
    seedRow('patch', { patch: addPatch('agent-node', 200), toolCallId: 'tc1' });

    const h = await hydrateDocumentFromJournal(DOC);

    expect(h.foldedMutations).toBe(2);
    expect(h.foldedThroughSeq).toBe(3);
    expect(h.document.children.map((c: { id: string }) => c.id)).toEqual(['user-node', 'agent-node']);

    await waitForCheckpoint(3);
    // The bootstrap checkpoint anchors the next restart.
    expect(await getCheckpointSeq(DOC)).toBe(3);
    const ckpt = await db.documentSnapshot.findFirst({ where: { documentId: DOC, source: 'server' } });
    expect(ckpt).not.toBeNull();
    expect(ckpt!.lastSeq).toBe(3);
  });

  it('restart survival end-to-end: checkpoint + NEW journal tail (the user-edits-lost gap)', async () => {
    seedRow('user_patch', { patch: addPatch('a'), clientId: 'c1', clientMutationId: 1 });
    await hydrateDocumentFromJournal(DOC);
    await waitForCheckpoint(1);

    // "Server restarts": a fresh hydration of the SAME durable state.
    const h1 = await hydrateDocumentFromJournal(DOC);
    expect(h1.document.children.map((c: { id: string }) => c.id)).toEqual(['a']);
    expect(h1.baseSeq).toBe(1); // anchored on the bootstrap checkpoint

    // User edits land in the journal AFTER the checkpoint.
    seedRow('user_patch', { patch: updatePatch('a', 999), clientId: 'c1', clientMutationId: 2 });
    seedRow('user_patch', { patch: addPatch('b', 300), clientId: 'c1', clientMutationId: 3 });

    const h2 = await hydrateDocumentFromJournal(DOC);
    const a = h2.document.children.find((c: { id: string }) => c.id === 'a') as { x?: number };
    expect(a?.x).toBe(999);
    expect(h2.document.children.map((c: { id: string }) => c.id)).toEqual(['a', 'b']);
  });

  it('seeds tombstones from the checkpoint, then folds removes into the live lane', async () => {
    seedRow('user_patch', { patch: addPatch('a'), clientId: 'c1', clientMutationId: 1 });
    seedRow('user_patch', { patch: addPatch('b', 100), clientId: 'c1', clientMutationId: 2 });

    // Write a real checkpoint covering both adds, carrying a stale tombstone.
    const h0 = await hydrateDocumentFromJournal(DOC);
    await waitForCheckpoint(2);

    // Direct checkpoint with a tombstone (simulating a prior delete that
    // happened below the compaction line).
    await db.documentSnapshot.deleteMany({ where: { documentId: DOC, source: 'server' } });
    await insertSnapshotRow({
      id: 'ckpt-seeded',
      source: 'server',
      document: h0.document,
      lastSeq: 2,
      tombstones: ['ghost-node'],
    });

    // A remove above the checkpoint.
    seedRow('user_patch', { patch: removePatch('b'), clientId: 'c1', clientMutationId: 3 });

    const h = await hydrateDocumentFromJournal(DOC);
    expect(h.document.children.map((c: { id: string }) => c.id)).toEqual(['a']);
    // Tombstone lane = checkpoint-seeded + folded remove.
    expect(h.tombstones.has('ghost-node')).toBe(true);
    expect(h.tombstones.has('b')).toBe(true);
  });

  it('applies a document_restore event by loading its snapshot row (restores survive restarts)', async () => {
    seedRow('user_patch', { patch: addPatch('a'), clientId: 'c1', clientMutationId: 1 });
    await hydrateDocumentFromJournal(DOC);
    await waitForCheckpoint(1);

    const restored = emptyDocument(DOC);
    (restored as CanvasDocument).children = [{ id: 'restored-root', type: 'frame', x: 0, y: 0, width: 10, height: 10 } as never];
    const snapshotId = await journalDocumentRestore(DOC, restored);
    expect(snapshotId).not.toBeNull();
    // The restore journaled a document_restore event pointing at the row.
    expect(state.rows.some((r) => r.type === 'document_restore')).toBe(true);

    const h = await hydrateDocumentFromJournal(DOC);
    expect(h.document.children.map((c: { id: string }) => c.id)).toEqual(['restored-root']);
    // Restore voids prior tombstones.
    expect(h.tombstones.size).toBe(0);
  });

  it('legacy document (client snapshot, no lastSeq) folds rows newer than the snapshot marker', async () => {
    // Two rows that predate the client snapshot (their effects are IN it).
    const t0 = new Date(Date.now() - 60_000);
    await db.agentEvent.create({
      data: { id: 'ev-1', documentId: DOC, seq: 1, type: 'user_patch', payload: JSON.stringify({ patch: addPatch('old'), clientId: 'c1', clientMutationId: 1 }), createdAt: t0 },
    });
    await db.agentEvent.create({
      data: { id: 'ev-2', documentId: DOC, seq: 2, type: 'user_patch', payload: JSON.stringify({ patch: addPatch('also-old', 500), clientId: 'c1', clientMutationId: 2 }), createdAt: new Date(Date.now() - 50_000) },
    });

    // Mirror the same two rows into the mock journal (foldTail reads it).
    state.rows.push(
      { documentId: DOC, seq: 1, type: 'user_patch', toolCallId: null, payload: { patch: addPatch('old'), clientId: 'c1', clientMutationId: 1 }, createdAt: t0 },
      { documentId: DOC, seq: 2, type: 'user_patch', toolCallId: null, payload: { patch: addPatch('also-old', 500), clientId: 'c1', clientMutationId: 2 }, createdAt: new Date(Date.now() - 50_000) },
    );

    // Client snapshot containing 'old' (taken between the two edits).
    const snapDoc = emptyDocument(DOC);
    (snapDoc as CanvasDocument).children = [{ id: 'old', type: 'rectangle', x: 10, y: 10, width: 50, height: 50 } as never];
    await insertSnapshotRow({ id: 'snap-legacy', source: 'turn_end', document: snapDoc, createdAt: new Date(Date.now() - 40_000) });

    // A newer edit ABOVE the snapshot.
    seedRow('user_patch', { patch: addPatch('new-edit', 700), clientId: 'c1', clientMutationId: 3 });

    const h = await hydrateDocumentFromJournal(DOC);
    // Marker = last row at/below the snapshot = seq 2 → only seq 3 folds.
    expect(h.baseSeq).toBe(2);
    expect(h.document.children.map((c: { id: string }) => c.id).sort()).toEqual(['new-edit', 'old']);
    expect(h.document.children.some((c: { id: string }) => c.id === 'also-old')).toBe(false);
  });

  it('degrades to the empty document when the DB and journal are empty', async () => {
    const h = await hydrateDocumentFromJournal('doc-never-seen');
    expect(h.document.children).toEqual([]);
    expect(h.foldedThroughSeq).toBe(0);
    expect(h.tombstones.size).toBe(0);
  });
});

describe('writeServerCheckpoint + compaction (R2)', () => {
  it('persists a server checkpoint at the stable journal head + getCheckpointSeq reads it', async () => {
    seedRow('user_patch', { patch: addPatch('a'), clientId: 'c1', clientMutationId: 1 });
    seedRow('patch', { patch: addPatch('b', 100), toolCallId: 'tc1' });

    const doc = emptyDocument(DOC);
    (doc as CanvasDocument).children = [{ id: 'a', type: 'rectangle', x: 10, y: 10, width: 50, height: 50 } as never];
    const res = await writeServerCheckpoint(DOC, doc, new Set(['dead']));

    expect(res).not.toBeNull();
    expect(res!.lastSeq).toBe(2); // quiescence probe saw the stable head
    expect(await getCheckpointSeq(DOC)).toBe(2);

    const row = await db.documentSnapshot.findFirst({ where: { documentId: DOC, source: 'server' } });
    expect(JSON.parse(row!.tombstones!)).toEqual(['dead']);
    expect(JSON.parse(row!.document).children.map((c: { id: string }) => c.id)).toEqual(['a']);
  });

  it('skips a no-op checkpoint when the newest one already covers lastSeq', async () => {
    seedRow('user_patch', { patch: addPatch('a'), clientId: 'c1', clientMutationId: 1 });
    const doc = emptyDocument(DOC);
    const first = await writeServerCheckpoint(DOC, doc, new Set());
    const count = await db.documentSnapshot.count({ where: { documentId: DOC, source: 'server' } });

    const second = await writeServerCheckpoint(DOC, doc, new Set()); // same head — no-op
    // The skip lives inside writeCheckpointRow (void) — the caller still
    // learns the head + prune count, but NO second row lands.
    expect(second).toMatchObject({ lastSeq: first!.lastSeq, pruned: 0 });
    expect(await db.documentSnapshot.count({ where: { documentId: DOC, source: 'server' } })).toBe(count);
  });

  it('compaction prunes only past the safety tail, and only when the window is worth it', async () => {
    for (let i = 1; i <= 2500; i++) {
      seedRow('patch', { patch: updatePatch(`n${i}`, i), toolCallId: `tc${i}` });
    }
    // The oldest-row probe queries the REAL AgentEvent table — mirror the
    // rows there too (in production both stores are the same table).
    await db.agentEvent.createMany({
      data: Array.from({ length: 2500 }, (_, i) => ({
        id: `ev-c-${i}`,
        documentId: DOC,
        seq: i + 1,
        type: 'patch',
        payload: JSON.stringify({ patch: updatePatch(`n${i + 1}`, i + 1), toolCallId: `tc${i + 1}` }),
      })),
    });

    // snapshotSeq 2000 → floor 1500. Oldest row seq 1 → window 1499 ≥ 1000.
    const pruned = await maybeCompactJournal(DOC, 2000);
    expect(pruned).toBe(1500);
    const remaining = state.rows.filter((r) => r.documentId === DOC);
    expect(remaining.length).toBe(1000); // 1501..2500
    expect(remaining[0].seq).toBe(1501);

    // Mirror the prune into the DB rows (in production both stores are the
    // same table — the mock split is a test artifact).
    await db.agentEvent.deleteMany({ where: { documentId: DOC, seq: { lte: 1500 } } });

    // Too small a window (churn guard): snapshotSeq 2100 → floor 1600, but
    // oldest is now 1501 → window 99 < 1000 → no-op.
    expect(await maybeCompactJournal(DOC, 2100)).toBe(0);
    expect(state.rows.filter((r) => r.documentId === DOC).length).toBe(1000);
  });
});

describe('computeChangedNodeIdsSince (R9a delta context)', () => {
  it('collects the union of touched ids from patch + user_patch rows', async () => {
    seedRow('patch', { patch: updatePatch('a', 1), toolCallId: 'tc1' });
    seedRow('user_patch', { patch: updatePatch('b', 2), clientId: 'c1', clientMutationId: 1 });
    seedRow('agent:message_end', { type: 'agent:message_end' }); // not a mutation

    const res = await computeChangedNodeIdsSince(DOC, 0);
    expect(res.nodeIds).not.toBeNull();
    expect([...res.nodeIds!].sort()).toEqual(['a', 'b']);
    expect(res.throughSeq).toBe(3);
  });

  it('returns null (full-snapshot fallback) on a GLOBAL op', async () => {
    seedRow('patch', { patch: updatePatch('a', 1), toolCallId: 'tc1' });
    seedRow('user_patch', { patch: { op: 'clear' } as never, clientId: 'c1', clientMutationId: 1 });

    const res = await computeChangedNodeIdsSince(DOC, 0);
    expect(res.nodeIds).toBeNull();
  });

  it('returns null when the window is too big to enumerate (>3000 patches)', async () => {
    for (let i = 1; i <= 3001; i++) {
      seedRow('patch', { patch: updatePatch(`n${i}`, i), toolCallId: `tc${i}` });
    }
    const res = await computeChangedNodeIdsSince(DOC, 0);
    expect(res.nodeIds).toBeNull();
  });
});

describe('tombstone lane (pure helpers)', () => {
  it('tracks removes, clears, and re-adds', () => {
    const doc = emptyDocument(DOC);
    (doc as CanvasDocument).children = [
      { id: 'x', type: 'rectangle', x: 0, y: 0, width: 1, height: 1 } as never,
      { id: 'y', type: 'rectangle', x: 0, y: 0, width: 1, height: 1 } as never,
    ];
    const tombstones = new Set<string>();

    trackPatchTombstones(doc, removePatch('x'), tombstones);
    expect(tombstones.has('x')).toBe(true);

    trackPatchTombstones(doc, { op: 'clear' } as never, tombstones);
    expect(tombstones.has('x')).toBe(true);
    expect(tombstones.has('y')).toBe(true);

    // Re-add with the same id (undo-style) clears the tombstone.
    trackPatchTombstones(doc, addPatch('x'), tombstones);
    expect(tombstones.has('x')).toBe(false);
    expect(tombstones.has('y')).toBe(true);
  });

  it('caps the lane FIFO at TOMBSTONE_CAP', () => {
    const doc = emptyDocument(DOC);
    (doc as CanvasDocument).children = [];
    const tombstones = new Set<string>();
    for (let i = 0; i < TOMBSTONE_CAP + 50; i++) {
      trackPatchTombstones(doc, removePatch(`n${i}`), tombstones, TOMBSTONE_CAP);
    }
    expect(tombstones.size).toBe(TOMBSTONE_CAP);
    // FIFO: the oldest ids were evicted.
    expect(tombstones.has('n0')).toBe(false);
    expect(tombstones.has('n49')).toBe(false);
    expect(tombstones.has(`n${TOMBSTONE_CAP + 49}`)).toBe(true);
  });
});
