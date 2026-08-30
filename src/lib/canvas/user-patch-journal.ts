// Server-side exactly-once journaling of USER canvas patches (Phase B, R1).
//
// Before this module the `canvas:patch` relay path was fire-and-forget: the
// patch mutated the in-memory document and was broadcast, but NOTHING was
// journaled — a server restart rolled every viewer back to the last
// client-POSTed DocumentSnapshot, and a retried patch double-applied onto the
// append-only canvas (an `add` re-delivered = a second node with the same
// intent, which no undo could noiselessly remove).
//
// This module turns user patches into journaled, exactly-once mutations
// following Replicache's `lastMutationID` rules:
//
//   clientMutationId <= lastMutationId      → 'duplicate' (skip + ack — the
//                                              effect is already server-side)
//   clientMutationId == lastMutationId + 1  → 'accepted'  (journal + bump)
//   clientMutationId  > lastMutationId + 1  → 'rejected'  (gap — the client
//                                              must re-anchor and surface)
//
// Durability split: the journal row (`user_patch` AgentEvent, serialized on
// event-journal's writeChain so per-document seqs interleave correctly with
// agent events) + a `MutationClock` row (O(1) exactly-once check, upserted
// fire-and-forget). An in-memory clock map fronts the DB: after the first
// per-client seed, the check + reserve is SYNCHRONOUS, so two mutations
// racing on the same socket.io event loop can never both win — the loser of
// the microtask ordering sees the reserved value and dedupes.
//
// Testability: no socket/port dependency; the DB is imported dynamically
// (`await import('../db')`) so `vi.mock('@/lib/db')` intercepts it — the
// boot-recovery precedent.

import { appendSyntheticJournalEvent } from '../agent/event-journal';
import type { CanvasPatch } from './types';

export type MutationVerdict = 'accepted' | 'duplicate' | 'rejected';

export interface MutationDecision {
  status: MutationVerdict;
  /// The client's durable lastMutationId AFTER this decision (the ack payload
  /// the client uses to prune its outbox / re-anchor its counter).
  lastMutationId: number;
}

// `${documentId}::${clientId}` → lastMutationId (fronts the DB table).
const clocks = new Map<string, number>();
// In-flight first-seed promises — concurrent mutations from one client share
// a single DB read instead of racing two seeds.
const clockSeeds = new Map<string, Promise<void>>();

function clockKey(documentId: string, clientId: string): string {
  return `${documentId}::${clientId}`;
}

async function ensureClock(documentId: string, clientId: string): Promise<void> {
  const key = clockKey(documentId, clientId);
  if (clocks.has(key)) return;
  let seed = clockSeeds.get(key);
  if (!seed) {
    seed = (async () => {
      try {
        const { db } = await import('../db');
        const row = await db.mutationClock.findUnique({
          where: { documentId_clientId: { documentId, clientId } },
        });
        clocks.set(key, row?.lastMutationId ?? 0);
      } catch {
        // DB unavailable — treat as a fresh clock; the journal write will
        // equally fail-and-swallow, and the in-memory map keeps the session
        // exactly-once even without durability.
        clocks.set(key, 0);
      }
    })();
    clockSeeds.set(key, seed);
    void seed.finally(() => clockSeeds.delete(key));
  }
  await seed;
}

async function bumpClockDurable(documentId: string, clientId: string, mutationId: number): Promise<void> {
  try {
    const { db } = await import('../db');
    await db.mutationClock.upsert({
      where: { documentId_clientId: { documentId, clientId } },
      create: { documentId, clientId, lastMutationId: mutationId },
      update: { lastMutationId: mutationId },
    });
  } catch {
    // Clock write failures never break the relay — the in-memory map keeps
    // this process exactly-once; a restart re-seeds from whatever landed.
  }
}

/// Decide + record one user mutation. The CALLER owns applying the patch to
/// the in-memory document and broadcasting it (only on 'accepted').
///
/// Ordering guarantee: the reserve (`clocks.set`) happens synchronously after
/// the seed await, so concurrent continuations from the same seed resolve in
/// registration order and the second sees the first's reservation.
export async function acceptUserMutation(
  documentId: string,
  clientId: string,
  clientMutationId: number,
  patch: CanvasPatch,
): Promise<MutationDecision> {
  await ensureClock(documentId, clientId);
  const key = clockKey(documentId, clientId);
  const last = clocks.get(key) ?? 0;

  if (!Number.isFinite(clientMutationId) || clientMutationId <= 0) {
    return { status: 'rejected', lastMutationId: last };
  }
  if (clientMutationId <= last) {
    return { status: 'duplicate', lastMutationId: last };
  }
  if (clientMutationId > last + 1) {
    return { status: 'rejected', lastMutationId: last };
  }

  // Reserve synchronously — atomic w.r.t. any interleaved continuation.
  clocks.set(key, clientMutationId);
  // Journal the accepted mutation (serialized on the journal write chain so
  // the `user_patch` row's seq interleaves correctly with agent events; the
  // payload deliberately mirrors the mutation semantics for audit/replay).
  appendSyntheticJournalEvent(documentId, 'user_patch', undefined, {
    clientId,
    clientMutationId,
    patch,
  });
  // Durable clock bump. AWAITED (not fire-and-forget): the caller's ack means
  // "durably accepted server-side" — a clock row that lost a race with a
  // process restart would re-open an already-acked mutation id for reuse.
  // The in-memory reserve above keeps concurrent verdicts correct even while
  // this write is in flight.
  await bumpClockDurable(documentId, clientId, clientMutationId);
  return { status: 'accepted', lastMutationId: clientMutationId };
}

/// Every client's durable lastMutationId for a document — served by the
/// events API (`lastMutationIDChanges`) and the agent status route so
/// reconnecting clients prune their offline outbox by the Replicache
/// `id <= lastMutationID` rule.
export async function getMutationClocks(documentId: string): Promise<Record<string, number>> {
  try {
    const { db } = await import('../db');
    const rows = await db.mutationClock.findMany({ where: { documentId } });
    const out: Record<string, number> = {};
    for (const row of rows) out[row.clientId] = row.lastMutationId;
    return out;
  } catch {
    return {};
  }
}

/// Test hook — reset the in-memory clock front (suite isolation).
export function __clearUserPatchJournalForTests(): void {
  clocks.clear();
  clockSeeds.clear();
}
