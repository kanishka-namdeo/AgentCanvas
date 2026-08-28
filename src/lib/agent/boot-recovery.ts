// Boot-time interrupted-run recovery — the OpenHands restart-crash pattern.
//
// When the Next.js server dies mid-run (deploy, crash, container restart):
//   - SessionRun rows are stranded at 'queued' / 'in_progress' /
//     'awaiting_tool' / 'cancelling' forever (their only writers are client
//     fire-and-forget POSTs, and the client's own run copy is equally stuck).
//   - SessionMessage rows are stranded at 'streaming' — the client maps that
//     back to an eternal spinner on the next hydrate.
//   - Tool calls whose `tool_call_start` was journaled but whose
//     `tool_call_end` never landed have NO observation — a future resume
//     would hand the model a dangling action.
//
// On boot (instrumentation.ts → register()), this module:
//   1. Marks stale non-terminal runs  → status 'incomplete' with an
//     "interrupted by server restart" errorMessage (resumable, honest).
//   2. Marks stale streaming messages → status 'error' with the same note.
//   3. Scans the event journal (last 24h) for tool_call_start events with no
//     matching tool_call_end and appends a synthetic interrupted observation
//     per orphan (OpenHands `get_unmatched_actions`).
//
// NOTE on type strings: the journal stores SyncEvent types VERBATIM — the
// lifecycle events carry the `agent:` prefix ('agent:tool_call_start',
// 'agent:tool_call_end'). The queries below MUST use the prefixed names;
// the unprefixed forms match nothing and silently disable the orphan scan
// (found by live verification on 2026-08-28: every scan logged
// "recorded 0 interrupted tool call(s)" while orphaned starts existed).
//
// Everything is best-effort: a DB failure at boot must NEVER block the
// server from starting — the caller wraps this in try/catch and the module
// itself guards each phase independently.

// Runs/messages younger than this are left alone: the server just booted, so
// a row created within the last 30s would have to come from THIS process —
// there is no such run yet. The guard exists for the (theoretical) case of a
// racing second writer.
const STALE_CUTOFF_MS = 30_000;

// How far back the unmatched-tool-call scan reaches.
const ORPHAN_SCAN_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface BootRecoveryReport {
  runsMarkedIncomplete: number;
  messagesMarkedError: number;
  orphanToolCallsRecorded: number;
}

export async function runBootRecovery(): Promise<BootRecoveryReport> {
  const report: BootRecoveryReport = {
    runsMarkedIncomplete: 0,
    messagesMarkedError: 0,
    orphanToolCallsRecorded: 0,
  };
  const cutoff = new Date(Date.now() - STALE_CUTOFF_MS);
  const { db } = await import('../db');

  // ---- 1. Strandled runs → incomplete --------------------------------------
  try {
    const stuckRuns = await db.sessionRun.findMany({
      where: {
        status: { in: ['queued', 'in_progress', 'awaiting_tool', 'cancelling'] },
        createdAt: { lt: cutoff },
      },
      select: { id: true },
    });
    if (stuckRuns.length > 0) {
      const res = await db.sessionRun.updateMany({
        where: { id: { in: stuckRuns.map((r) => r.id) } },
        data: {
          status: 'incomplete',
          errorMessage: 'Run interrupted by server restart',
        },
      });
      report.runsMarkedIncomplete = res.count;
    }
  } catch (err) {
    console.warn('[boot-recovery] run sweep failed (non-fatal):', err instanceof Error ? err.message : String(err));
  }

  // ---- 2. Streaming messages → error ---------------------------------------
  try {
    const stuckMessages = await db.sessionMessage.findMany({
      where: { status: 'streaming', createdAt: { lt: cutoff } },
      select: { id: true },
    });
    if (stuckMessages.length > 0) {
      const res = await db.sessionMessage.updateMany({
        where: { id: { in: stuckMessages.map((m) => m.id) } },
        data: {
          status: 'error',
          error: 'Interrupted by server restart',
        },
      });
      report.messagesMarkedError = res.count;
    }
  } catch (err) {
    console.warn('[boot-recovery] message sweep failed (non-fatal):', err instanceof Error ? err.message : String(err));
  }

  // ---- 3. Unmatched tool calls → synthetic interrupted observations ---------
  try {
    const since = new Date(Date.now() - ORPHAN_SCAN_WINDOW_MS);
    const [starts, ends] = await Promise.all([
      db.agentEvent.findMany({
        where: { type: 'agent:tool_call_start', createdAt: { gt: since } },
        orderBy: { seq: 'asc' },
        select: { documentId: true, toolCallId: true, payload: true },
      }),
      db.agentEvent.findMany({
        where: { type: 'agent:tool_call_end', createdAt: { gt: since } },
        select: { toolCallId: true },
      }),
    ]);
    const completed = new Set(ends.map((e) => e.toolCallId).filter((id): id is string => typeof id === 'string'));
    const { appendSyntheticJournalEvent } = await import('./event-journal');
    for (const start of starts) {
      if (!start.toolCallId || completed.has(start.toolCallId)) continue;
      appendSyntheticJournalEvent(start.documentId, 'agent:tool_call_interrupted', start.toolCallId, {
        note: 'Tool call interrupted by server restart — no result was produced.',
        original: safeParse(start.payload),
      });
      report.orphanToolCallsRecorded++;
    }
  } catch (err) {
    // Most common cause: AgentEvent table doesn't exist yet (fresh DB before
    // the first `prisma db push`). Non-fatal by design.
    console.warn('[boot-recovery] orphan tool-call scan skipped (non-fatal):', err instanceof Error ? err.message : String(err));
  }

  if (
    report.runsMarkedIncomplete > 0 ||
    report.messagesMarkedError > 0 ||
    report.orphanToolCallsRecorded > 0
  ) {
    console.log(
      `[boot-recovery] recovered ${report.runsMarkedIncomplete} stranded run(s), ` +
        `${report.messagesMarkedError} streaming message(s), ` +
        `recorded ${report.orphanToolCallsRecorded} interrupted tool call(s)`,
    );
  }
  return report;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
