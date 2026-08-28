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
import { getJournalEvents, getJournalLastSeq } from '@/lib/agent/event-journal';
import { getMutationClocks } from '@/lib/canvas/user-patch-journal';

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
    const [events, lastSeq, lastMutationIDChanges] = await Promise.all([
      getJournalEvents(documentId, afterSeq, limit),
      getJournalLastSeq(documentId),
      getMutationClocks(documentId),
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
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown database error';
    return NextResponse.json({ error: `Failed to read event journal: ${message}` }, { status: 500 });
  }
}
