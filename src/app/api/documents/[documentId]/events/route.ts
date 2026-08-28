// GET /api/documents/[documentId]/events?afterSeq=N&limit=M
//
// Read side of the agent event journal (AgentEvent table): returns every
// journaled event strictly after the caller's watermark, in seq order — the
// OpenHands EventLog replay query. This is the foundation for reconnect
// catch-up (a client that missed socket events mid-disconnect can pull what
// it missed) and for post-hoc run inspection / debugging ("what did the
// agent actually do on this canvas?").
//
// Payloads are pre-parsed objects (patch / SyncEvent JSON). High-frequency
// deltas were never journaled, so responses stay compact.

import { NextRequest, NextResponse } from 'next/server';
import {
  getJournalEvents,
  getJournalLastSeq,
  getJournalOldestSeq,
} from '@/lib/agent/event-journal';
import { getMutationClocks } from '@/lib/canvas/user-patch-journal';
import { getCheckpointSeq } from '@/lib/canvas/journal-fold';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 200;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ documentId: string }> },
) {
  const { documentId } = await params;
  const afterSeqParam = Number(req.nextUrl.searchParams.get('afterSeq') ?? 0);
  const afterSeq = Number.isFinite(afterSeqParam) ? Math.max(0, Math.trunc(afterSeqParam)) : 0;
  const limitParam = Number(req.nextUrl.searchParams.get('limit') ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(limitParam)
    ? Math.min(Math.max(Math.trunc(limitParam), 1), 1000)
    : DEFAULT_LIMIT;

  try {
    const [events, lastSeq, lastMutationIDChanges, snapshotSeq, oldestSeq] = await Promise.all([
      getJournalEvents(documentId, afterSeq, limit),
      getJournalLastSeq(documentId),
      getMutationClocks(documentId),
      getCheckpointSeq(documentId),
      getJournalOldestSeq(documentId),
    ]);
    return NextResponse.json({
      events,
      lastSeq,
      count: events.length,
      truncated: events.length >= limit && lastSeq > (events[events.length - 1]?.seq ?? 0),
      // Replicache-style per-client mutation clocks (R1): a client (or its
      // offline outbox) treats any mutation with id <= its entry here as
      // durably applied server-side. Additive — old consumers ignore it.
      lastMutationIDChanges,
      // Phase C (R2) compaction awareness: `snapshotSeq` = the seq covered by
      // the newest server-written fold checkpoint; `oldestSeq` = the minimum
      // seq still present. A client whose watermark < oldestSeq cannot
      // replay a contiguous window and must re-baseline (full refetch via
      // canvas:full — the Replicache bad-cookie rule), never error.
      snapshotSeq,
      oldestSeq,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown database error';
    return NextResponse.json({ error: `Failed to read event journal: ${message}` }, { status: 500 });
  }
}
