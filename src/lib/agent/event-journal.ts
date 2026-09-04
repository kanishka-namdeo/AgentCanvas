// Server-side agent event journal — OpenHands-style append-only event log.
//
// Before this module, NOTHING server-side was journaled mid-run: all DB
// persistence (sessions / runs / messages / snapshots) rode on client
// fire-and-forget POSTs, so a closed tab or a server crash mid-run lost the
// entire turn and stranded rows at in_progress/streaming forever. The
// `AgentAction` table in the Prisma schema has had zero writers since it was
// added — dead schema.
//
// This module activates a REAL journal (new `AgentEvent` table) written from
// the NDJSON route — the single choke point every agent event (native runner
// AND legacy runner, WS-driven AND HTTP-fallback) flows through:
//
//   - One row per significant event: patches (with toolCallId), tool call
//     start/end, message start/end, turn_end / turn_cancelled, errors,
//     model_info, skill_selected, plan, critique, stuck. High-frequency /
//     low-value deltas (message_delta, thinking_delta, presence) are NOT
//     journaled — bolt.diy's "deltas are ephemeral, events are durable" rule.
//   - Per-document monotonic `seq` — resume/replay reads are
//     `WHERE seq > ? ORDER BY seq` (the OpenHands EventLog pattern). Seq is
//     allocated from a fresh DB head read per write (multi-bundle safe —
//     see insertRowAtFreshSeq).
//   - Writes are chained (serialized) + fire-and-forget: a journal failure
//     NEVER breaks the agent stream, and SQLite never sees interleaved
//     transactions from one process.
//
// Read side: GET /api/documents/[documentId]/events?afterSeq=N (reconnect
// watermark) + boot-time interrupted-tool recovery (boot-recovery.ts).

import type { AgentStreamEvent } from './runner-types';

/// Event types that are journaled. Deltas/presence are deliberately excluded
/// (UX-only ephemera — reconnecting clients get final state from snapshots).
const JOURNALED_AGENT_EVENT_TYPES = new Set<string>([
  'agent:message_start',
  'agent:message_end',
  'agent:tool_call_start',
  'agent:tool_call_end',
  'agent:turn_end',
  'agent:turn_cancelled',
  'agent:error',
  'agent:stuck',
  // Turn lifecycle with identity + content (Phase B R3). Today these are
  // written by the NDJSON route via appendSyntheticJournalEvent; keeping them
  // on the allow-list makes journalAgentEvent forward-compatible if the
  // translator starts emitting them directly.
  'agent:user_message',
  'agent:turn_final',
  'agent:skill_selected',
  'agent:model_info',
  'agent:plan',
  'agent:critique',
  'agent:subagent_dispatch',
  'agent:subagent_result',
  'agent:approval_request',
  'agent:approval_resolved',
  'agent:ask_user_question',
  // Agent modes (2026-08-30): the plan-approval handshake + the adaptive
  // critique skip notice MUST be journaled — reconnect catch-up replay
  // rebuilds the PlanApprovalCard / saving row from these rows (a skipped
  // journal write = a reconnecting viewer never sees a pending plan).
  'agent:plan_proposed',
  'agent:plan_resolved',
  'agent:critique_skipped',
  'agent:tool_progress',
  'agent:todo_update',
  'agent:background_task_started',
  'agent:background_task_complete',
]);

/// Payload cap per row — patches (esp. add_subtree) can be large; cap keeps
/// rows bounded while keeping full fidelity for everything normal.
const MAX_PAYLOAD_CHARS = 65_536;

export interface JournalRow {
  seq: number;
  type: string;
  toolCallId: string | null;
  payload: unknown;
  createdAt: string;
}

// ---- seq management ---------------------------------------------------------
//
// NOTE (Phase C, R2 prerequisite): there is NO in-memory seq counter anymore.
// `insertRowAtFreshSeq` below allocates every row's seq from a fresh DB head
// read (with collision retry) because this module exists in MULTIPLE runtime
// instances (instrumentation bundle vs route-handler bundles) whose cached
// counters would otherwise collide on @@unique([documentId, seq]) and
// silently drop rows. See the comment on insertRowAtFreshSeq.

// ---- serialized write chain ---------------------------------------------------

let writeChain: Promise<unknown> = Promise.resolve();

/// Insert one row, allocating its seq from the CURRENT journal head on
/// every attempt. The head is re-read per write (not cached across writes)
/// because this module has MULTIPLE runtime instances: Next.js compiles
/// instrumentation.ts (socket service) and each route handler into separate
/// module graphs, so `seqCounters` here is per-bundle and a cached counter
/// silently collides on the `@@unique([documentId, seq])` index — the losing
/// write used to vanish into the writeChain's `.catch` with no error and no
/// gap in the seq sequence. Re-reading the head + retrying on unique
/// violations makes cross-bundle interleavings correct regardless of module
/// duplication; the writeChain below still serializes writes WITHIN one
/// instance so per-instance enqueue order is preserved.
async function insertRowAtFreshSeq(
  documentId: string,
  type: string,
  toolCallId: string | undefined,
  payload: string,
): Promise<void> {
  const { db } = await import('../db');
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    let seq: number;
    try {
      const last = await db.agentEvent.findFirst({
        where: { documentId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      seq = (last?.seq ?? 0) + 1;
    } catch (err) {
      // Head read failed (db unavailable) — surface to the chain's catch.
      throw err;
    }
    try {
      await db.agentEvent.create({
        data: {
          documentId,
          seq,
          type,
          toolCallId: toolCallId ?? null,
          payload,
        },
      });
      return;
    } catch (err) {
      // Unique violation on (documentId, seq) — another writer instance won
      // the race for this seq. Retry with a freshly re-read head.
      lastError = err;
      continue;
    }
  }
  // Exhausted retries (extreme contention) — rethrow so the chain's catch
  // swallows it exactly like every other journal failure.
  throw lastError ?? new Error('journal insert exhausted retries');
}

function enqueueWrite(documentId: string, type: string, toolCallId: string | undefined, payload: string): void {
  writeChain = writeChain
    .then(() => insertRowAtFreshSeq(documentId, type, toolCallId, payload))
    .catch(() => {
      // Journal failures are silently swallowed by design: the live NDJSON
      // stream is the primary path; the journal is a durability backstop.
    });
}

function boundedJson(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return '"[unserializable]"';
  }
  if (text.length > MAX_PAYLOAD_CHARS) {
    return text.slice(0, MAX_PAYLOAD_CHARS) + '…[truncated]';
  }
  return text;
}

/// Append one agent stream event to the journal (fire-and-forget, filtered).
export function journalAgentEvent(documentId: string, ev: AgentStreamEvent): void {
  try {
    if (ev.kind === 'patch') {
      enqueueWrite(
        documentId,
        'patch',
        ev.toolCallId,
        boundedJson({ patch: ev.patch, toolCallId: ev.toolCallId ?? null }),
      );
      return;
    }
    const type = ev.event?.type;
    if (!type || !JOURNALED_AGENT_EVENT_TYPES.has(type)) return;
    enqueueWrite(documentId, type, (ev.event as { toolCallId?: string }).toolCallId, boundedJson(ev.event));
  } catch {
    // Never throw out of the journal.
  }
}

/// Append a synthetic (non-agent-emitted) journal event — used by boot-time
/// recovery to record "this tool call was interrupted by a restart"
/// observations (the OpenHands unmatched-action pattern, type
/// 'agent:tool_call_interrupted') and by the NDJSON route to audit dropped
/// patches (type 'patch_dropped').
export function appendSyntheticJournalEvent(
  documentId: string,
  type: string,
  toolCallId: string | undefined,
  payload: unknown,
): void {
  enqueueWrite(documentId, type, toolCallId, boundedJson(payload));
}

/// Wait for all queued journal writes to land (tests / graceful shutdown).
export async function flushJournal(): Promise<void> {
  await writeChain.catch(() => {});
}

// ---- read side ----------------------------------------------------------------

/// Read journal events for a document strictly after `afterSeq`, in seq
/// order. Payloads are parsed back into objects. `limit` caps the response.
export async function getJournalEvents(
  documentId: string,
  afterSeq = 0,
  limit = 200,
): Promise<JournalRow[]> {
  const { db } = await import('../db');
  const rows = await db.agentEvent.findMany({
    where: { documentId, seq: { gt: afterSeq } },
    orderBy: { seq: 'asc' },
    take: Math.min(Math.max(limit, 1), 1000),
  });
  return rows.map((row) => ({
    seq: row.seq,
    type: row.type,
    toolCallId: row.toolCallId,
    payload: safeParse(row.payload),
    createdAt: row.createdAt.toISOString(),
  }));
}

/// Read the MOST RECENT journal rows of the given types, returned in
/// chronological (seq-ascending) order. `limit` caps how many recent rows are
/// considered.
///
/// Why not getJournalEvents(…, 0, N)? That reads the OLDEST N rows (ascending
/// from seq 0) — a dense design turn writes 30-60 rows, so once the journal
/// passes the window size, the NEWEST turns (the ones a follow-up prompt
/// actually references) fall out of the window exactly when a multi-shot
/// session gets long. This variant queries newest-first (type-filtered, so
/// the window counts only the rows the caller cares about) and reverses the
/// result back to chronological order for replay-style consumers.
export async function getJournalEventsByType(
  documentId: string,
  types: string[],
  limit = 80,
): Promise<JournalRow[]> {
  const { db } = await import('../db');
  if (types.length === 0) return [];
  const rows = await db.agentEvent.findMany({
    where: { documentId, type: { in: types } },
    orderBy: { seq: 'desc' },
    take: Math.min(Math.max(limit, 1), 1000),
  });
  return rows.reverse().map((row) => ({
    seq: row.seq,
    type: row.type,
    toolCallId: row.toolCallId,
    payload: safeParse(row.payload),
    createdAt: row.createdAt.toISOString(),
  }));
}

/// Latest seq written for a document (0 when the journal is empty).
export async function getJournalLastSeq(documentId: string): Promise<number> {
  const { db } = await import('../db');
  const last = await db.agentEvent.findFirst({
    where: { documentId },
    orderBy: { seq: 'desc' },
    select: { seq: true },
  });
  return last?.seq ?? 0;
}

/// Oldest seq STILL PRESENT for a document (null when the journal is empty).
/// After Phase C compaction prunes rows folded into a server checkpoint,
/// this is the floor a client's watermark must be ≥ to replay a contiguous
/// window — anything older gets the Replicache "bad cookie" full-refetch
/// treatment (re-baseline + canvas:full) instead of a partial replay.
export async function getJournalOldestSeq(documentId: string): Promise<number | null> {
  const { db } = await import('../db');
  const first = await db.agentEvent.findFirst({
    where: { documentId },
    orderBy: { seq: 'asc' },
    select: { seq: true },
  });
  return first?.seq ?? null;
}

/// DEBUG CLONE — exact body copy of getJournalLastSeq.
export async function getJournalLastSeq2(documentId: string): Promise<number> {
  const { db } = await import('../db');
  const last = await db.agentEvent.findFirst({
    where: { documentId },
    orderBy: { seq: 'desc' },
    select: { seq: true },
  });
  return last?.seq ?? 0;
}

/// Compaction (Phase C, R2): delete every row with seq ≤ upToSeq for a
/// document. Called ONLY by journal-fold.ts after a server checkpoint whose
/// lastSeq covers those rows — the folded DocumentSnapshot is the durable
/// truth for them. Returns the number of rows pruned. Transcript rows go
/// too (their window is past; stale clients re-baseline via the events
/// API's oldestSeq + canvas:full — the Replicache bad-cookie rule).
export async function deleteJournalRowsUpTo(documentId: string, upToSeq: number): Promise<number> {
  const { db } = await import('../db');
  const res = await db.agentEvent.deleteMany({
    where: { documentId, seq: { lte: upToSeq } },
  });
  return res.count;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
