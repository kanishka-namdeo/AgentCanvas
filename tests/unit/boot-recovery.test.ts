// Unit tests — boot-time recovery (src/lib/agent/boot-recovery.ts).
//
// The scenario under guard: on server restart, stranded runs/messages are
// finalized honestly and tool_call_start journal events with no matching
// tool_call_end get a synthetic `agent:tool_call_interrupted` observation
// (the OpenHands unmatched-action pattern).
//
// REGRESSION GUARD: the orphan scan queries the journal by type. The journal
// stores SyncEvent types VERBATIM — 'agent:tool_call_start' /
// 'agent:tool_call_end' WITH the 'agent:' prefix. An earlier version queried
// the unprefixed strings, matched nothing, and silently disabled the entire
// scan (found by live verification: every boot logged "recorded 0
// interrupted tool call(s)" while orphaned starts existed). Test 1 fails
// against that version; test 2 pins the query shape explicitly.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Shared mutable fake-DB state (hoisted so the vi.mock factory can close
// over it — the factory runs before module imports).
const state = vi.hoisted(() => ({
  /// Pre-seeded journal rows (what the DB "contains" before recovery).
  journalRows: [] as Array<{ documentId: string; seq: number; type: string; toolCallId: string | null; payload: string; createdAt: Date }>,
  /// Rows appended by event-journal during the test (synthetic events).
  appendedRows: [] as Array<{ documentId: string; seq: number; type: string; toolCallId: string | null; payload: string }>,
  /// SessionRun rows for the stranded-run sweep.
  runRows: [] as Array<{ id: string; status: string; createdAt: Date; errorMessage: string | null }>,
  /// SessionMessage rows for the streaming-message sweep.
  messageRows: [] as Array<{ id: string; status: string; createdAt: Date; error: string | null }>,
  /// Captured agentEvent.findMany `where` clauses (query-shape assertions).
  journalQueries: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/db', () => ({
  db: {
    sessionRun: {
      findMany: vi.fn(async (args: any) => {
        const statuses = args?.where?.status?.in ?? [];
        const cutoff = args?.where?.createdAt?.lt;
        return state.runRows.filter(
          (r) => statuses.includes(r.status) && (!cutoff || new Date(r.createdAt) < new Date(cutoff)),
        );
      }),
      updateMany: vi.fn(async (args: any) => {
        const ids = args?.where?.id?.in ?? [];
        let count = 0;
        for (const row of state.runRows) {
          if (ids.includes(row.id)) {
            row.status = args.data.status;
            row.errorMessage = args.data.errorMessage ?? null;
            count++;
          }
        }
        return { count };
      }),
    },
    sessionMessage: {
      findMany: vi.fn(async (args: any) => {
        const cutoff = args?.where?.createdAt?.lt;
        return state.messageRows.filter(
          (r) => r.status === args?.where?.status && (!cutoff || new Date(r.createdAt) < new Date(cutoff)),
        );
      }),
      updateMany: vi.fn(async (args: any) => {
        const ids = args?.where?.id?.in ?? [];
        let count = 0;
        for (const row of state.messageRows) {
          if (ids.includes(row.id)) {
            row.status = args.data.status;
            row.error = args.data.error ?? null;
            count++;
          }
        }
        return { count };
      }),
    },
    agentEvent: {
      findMany: vi.fn(async (args: any) => {
        state.journalQueries.push(args?.where ?? {});
        return state.journalRows.filter((r) => r.type === args?.where?.type);
      }),
      // event-journal seq init: max seq for the document.
      findFirst: vi.fn(async (args: any) => {
        const docId = args?.where?.documentId;
        const rows = state.journalRows.filter((r) => r.documentId === docId);
        if (rows.length === 0) return null;
        const max = rows.reduce((m, r) => (r.seq > m.seq ? r : m), rows[0]);
        return { seq: max.seq };
      }),
      create: vi.fn(async (args: any) => {
        state.appendedRows.push(args.data);
        return args.data;
      }),
    },
  },
}));

import { runBootRecovery } from '@/lib/agent/boot-recovery';
import { flushJournal } from '@/lib/agent/event-journal';

const OLD = new Date(Date.now() - 60_000); // older than every cutoff

function seedJournal(
  documentId: string,
  seq: number,
  type: string,
  toolCallId: string | null,
): void {
  state.journalRows.push({ documentId, seq, type, toolCallId, payload: '{}', createdAt: OLD });
}

describe('boot-recovery: stranded run / streaming message sweeps', () => {
  beforeEach(() => {
    state.journalRows.length = 0;
    state.appendedRows.length = 0;
    state.runRows.length = 0;
    state.messageRows.length = 0;
    state.journalQueries.length = 0;
  });

  it('marks stale in_progress runs incomplete and streaming messages errored', async () => {
    state.runRows.push(
      { id: 'run-stale', status: 'in_progress', createdAt: OLD, errorMessage: null },
      { id: 'run-done', status: 'completed', createdAt: OLD, errorMessage: null },
    );
    state.messageRows.push({ id: 'msg-stale', status: 'streaming', createdAt: OLD, error: null });

    const report = await runBootRecovery();

    expect(report.runsMarkedIncomplete).toBe(1);
    expect(report.messagesMarkedError).toBe(1);
    expect(state.runRows.find((r) => r.id === 'run-stale')?.status).toBe('incomplete');
    expect(state.runRows.find((r) => r.id === 'run-done')?.status).toBe('completed');
    expect(state.messageRows.find((m) => m.id === 'msg-stale')?.status).toBe('error');
  });

  it('leaves fresh rows alone (younger than the 30s cutoff)', async () => {
    const fresh = new Date();
    state.runRows.push({ id: 'run-fresh', status: 'in_progress', createdAt: fresh, errorMessage: null });
    state.messageRows.push({ id: 'msg-fresh', status: 'streaming', createdAt: fresh, error: null });

    const report = await runBootRecovery();
    expect(report.runsMarkedIncomplete).toBe(0);
    expect(report.messagesMarkedError).toBe(0);
    expect(state.runRows[0].status).toBe('in_progress');
  });
});

describe('boot-recovery: orphaned tool-call scan (agent: prefix regression guard)', () => {
  beforeEach(() => {
    state.journalRows.length = 0;
    state.appendedRows.length = 0;
    state.runRows.length = 0;
    state.messageRows.length = 0;
    state.journalQueries.length = 0;
  });

  it('records an interrupted observation for a tool_call_start with no matching end', async () => {
    seedJournal('doc-a', 1, 'agent:tool_call_start', 'tc-orphan');
    seedJournal('doc-a', 2, 'agent:message_start', null);

    const report = await runBootRecovery();
    await flushJournal();

    expect(report.orphanToolCallsRecorded).toBe(1);
    const synthetic = state.appendedRows.find((r) => r.type === 'agent:tool_call_interrupted');
    expect(synthetic).toBeDefined();
    expect(synthetic?.toolCallId).toBe('tc-orphan');
    expect(synthetic?.documentId).toBe('doc-a');
  });

  it('skips tool calls that DID complete and starts without a toolCallId', async () => {
    seedJournal('doc-b', 1, 'agent:tool_call_start', 'tc-ok');
    seedJournal('doc-b', 2, 'agent:tool_call_end', 'tc-ok');
    seedJournal('doc-b', 3, 'agent:tool_call_start', null);

    const report = await runBootRecovery();
    await flushJournal();

    expect(report.orphanToolCallsRecorded).toBe(0);
    expect(state.appendedRows.filter((r) => r.type === 'agent:tool_call_interrupted')).toHaveLength(0);
  });

  it('queries the journal with the agent:-prefixed type strings (regression: unprefixed matched nothing)', async () => {
    await runBootRecovery();

    const types = state.journalQueries.map((q) => q.type).sort();
    // The scan MUST ask for the verbatim SyncEvent types. The buggy version
    // asked for 'tool_call_start'/'tool_call_end' and silently found nothing.
    expect(types).toContain('agent:tool_call_start');
    expect(types).toContain('agent:tool_call_end');
    expect(types).not.toContain('tool_call_start');
    expect(types).not.toContain('tool_call_end');
  });
});
