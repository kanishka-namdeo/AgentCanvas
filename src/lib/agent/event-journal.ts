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
//     `WHERE seq > ? ORDER BY seq` (the OpenHands EventLog pattern).
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

const seqCounters = new Map<string, number>();
const seqInitPromises = new Map<string, Promise<void>>();

function ensureSeqInit(documentId: string): Promise<void> {
  let init = seqInitPromises.get(documentId);
  if (!init) {
    init = (async () => {
      try {
        const { db } = await import('../db');
        const last = await db.agentEvent.findFirst({
          where: { documentId },
          orderBy: { seq: 'desc' },
          select: { seq: true },
        });
        seqCounters.set(documentId, (last?.seq ?? 0) + 1);
      } catch {
        // DB unavailable at init — start from 1; journal writes will also
        // fail and be swallowed (never break the stream).
        seqCounters.set(documentId, 1);
      }
    })();
    seqInitPromises.set(documentId, init);
  }
  return init;
}

// ---- serialized write chain ---------------------------------------------------

let writeChain: Promise<unknown> = Promise.resolve();

function enqueueWrite(documentId: string, type: string, toolCallId: string | undefined, payload: string): void {
  writeChain = writeChain
    .then(async () => {
      await ensureSeqInit(documentId);
      const seq = seqCounters.get(documentId) ?? 1;
      seqCounters.set(documentId, seq + 1);
      const { db } = await import('../db');
      await db.agentEvent.create({
        data: {
          documentId,
          seq,
          type,
          toolCallId: toolCallId ?? null,
          payload,
        },
      });
    })
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

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
