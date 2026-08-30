// GET /api/documents/[documentId]/agent/status
//
// Agent status endpoint (Phase B, R4) — the REST-first hydration anchor.
//
// On document open the client fetches this BEFORE attaching the socket, so
// the journal watermark and the client's mutation counter are anchored from
// server truth even when the socket layer is degraded (the OpenHands
// mount flow: REST tail first, WebSocket second). It also doubles as
// LibreChat-style terminal reconciliation for OTHER viewers: a client that
// never saw a run can learn it is over (active:null + finalResponse) and
// reconcile its view without waiting for a reconnect cycle.
//
// Shape (all additive fields; consumers treat unknown keys as optional):
//   {
//     documentId,
//     active: { startedAt, sessionId?, runId?, promptPreview? } | null,
//     lastSeq,                     // journal head
//     lastMutationIDChanges,       // Replicache clocks: { clientId: lastId }
//     lastTerminal:  { type, at, seq } | null,
//     finalResponse: string | null // last agent:turn_final text
//   }

import { NextRequest, NextResponse } from 'next/server';
import { getJournalLastSeq, getJournalEvents } from '@/lib/agent/event-journal';
import { getMutationClocks } from '@/lib/canvas/user-patch-journal';
import { getActiveRun } from '@/lib/canvas/run-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TERMINAL_JOURNAL_TYPES = new Set([
  'agent:turn_end',
  'agent:turn_cancelled',
  'agent:error',
  'agent:stuck',
]);

/// How deep into the journal tail the lastTerminal/finalResponse scan looks.
/// One page of the same indexed seq query the events API runs; every turn
/// writes at least one terminal row, so the last terminal is well within
/// reach even for verbose runs.
const TAIL_SCAN_EVENTS = 200;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ documentId: string }> },
) {
  const { documentId } = await params;

  try {
    // lastSeq FIRST — the tail scan window is defined relative to it.
    const lastSeq = await getJournalLastSeq(documentId).catch(() => 0);
    const tailFrom = Math.max(0, lastSeq - TAIL_SCAN_EVENTS);
    const [tailRows, lastMutationIDChanges] = await Promise.all([
      getJournalEvents(documentId, tailFrom, TAIL_SCAN_EVENTS).catch(() => []),
      getMutationClocks(documentId),
    ]);

    let lastTerminal: { type: string; seq: number; at: string } | null = null;
    let lastFinal: { text: string | null; seq: number } | null = null;
    for (const row of tailRows) {
      if (TERMINAL_JOURNAL_TYPES.has(row.type)) {
        lastTerminal = { type: row.type, seq: row.seq, at: row.createdAt };
      } else if (row.type === 'agent:turn_final') {
        const payload = row.payload as { text?: unknown } | null;
        lastFinal = {
          text:
            payload && typeof payload === 'object' && typeof payload.text === 'string'
              ? payload.text
              : null,
          seq: row.seq,
        };
      }
    }

    const run = getActiveRun(documentId);

    return NextResponse.json({
      documentId,
      active: run
        ? {
            startedAt: new Date(run.startedAt).toISOString(),
            ...(run.sessionId ? { sessionId: run.sessionId } : {}),
            ...(run.runId ? { runId: run.runId } : {}),
            ...(run.promptPreview ? { promptPreview: run.promptPreview } : {}),
          }
        : null,
      lastSeq,
      lastMutationIDChanges,
      lastTerminal,
      finalResponse: lastFinal?.text ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown database error';
    return NextResponse.json({ error: `Failed to read agent status: ${message}` }, { status: 500 });
  }
}
