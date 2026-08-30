// Route-handler tests — the agent status endpoint (R4) + the events API's
// lastMutationIDChanges extension (R1).
//
// These are the repo's first direct route-handler unit tests: GET is invoked
// with a NextRequest and Promise-resolved params, and every dependency the
// routes import STATICALLY (event-journal, user-patch-journal) is mocked via
// plain vi.mock — the reliable interception path. The run registry is driven
// through its real API (pure module, no DB).
//
// The status route's lastTerminal/finalResponse reads go through a TAIL SCAN
// of getJournalEvents — the tests seed the mocked journal with windows and
// assert the shaping (last terminal wins, last turn_final's text, active
// run identity, empty-state zeros).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({
  journalRows: [] as Array<{ seq: number; type: string; toolCallId: string | null; payload: unknown; createdAt: string }>,
  clocks: {} as Record<string, number>,
  lastSeq: 0,
  oldestSeq: null as number | null,
  snapshotSeq: null as number | null,
}));

vi.mock('@/lib/agent/event-journal', () => ({
  getJournalLastSeq: vi.fn(async (documentId: string) => (documentId === DOC ? state.lastSeq : 0)),
  getJournalOldestSeq: vi.fn(
    async (documentId: string) => (documentId === DOC ? state.oldestSeq : null),
  ),
  getJournalEvents: vi.fn(async (documentId: string, afterSeq: number, limit: number) =>
    documentId === DOC
      ? state.journalRows
          .filter((r) => r.seq > afterSeq)
          .sort((a, b) => a.seq - b.seq)
          .slice(0, limit)
          .map((r) => ({ ...r }))
      : [],
  ),
}));

vi.mock('@/lib/canvas/user-patch-journal', () => ({
  getMutationClocks: vi.fn(async (documentId: string) => (documentId === DOC ? { ...state.clocks } : {})),
}));

// Phase C (R2): the events route also reads the fold-checkpoint watermark.
vi.mock('@/lib/canvas/journal-fold', () => ({
  getCheckpointSeq: vi.fn(async (documentId: string) => (documentId === DOC ? state.snapshotSeq : null)),
}));

import { GET as statusGET } from '@/app/api/documents/[documentId]/agent/status/route';
import { GET as eventsGET } from '@/app/api/documents/[documentId]/events/route';
import {
  registerActiveRun,
  unregisterActiveRun,
  __clearRunRegistryForTests,
} from '@/lib/canvas/run-registry';

const DOC = 'doc-status';

function seedJournalRow(seq: number, type: string, payload: unknown) {
  state.journalRows.push({
    seq,
    type,
    toolCallId: null,
    payload,
    createdAt: new Date(Date.now() - (10_000 - seq) * 1000).toISOString(),
  });
}

function statusRequest() {
  return new NextRequest(`http://localhost/api/documents/${DOC}/agent/status`);
}

function eventsRequest(afterSeq = 0) {
  return new NextRequest(`http://localhost/api/documents/${DOC}/events?afterSeq=${afterSeq}&limit=200`);
}

function params() {
  return { params: Promise.resolve({ documentId: DOC }) };
}

beforeEach(() => {
  state.journalRows.length = 0;
  state.clocks = {};
  state.lastSeq = 0;
  state.oldestSeq = null;
  state.snapshotSeq = null;
  __clearRunRegistryForTests();
});

describe('GET /api/documents/[documentId]/agent/status (R4)', () => {
  it('reports an idle document: active null + journal head + clocks', async () => {
    seedJournalRow(7, 'agent:turn_end', { type: 'agent:turn_end' });
    state.lastSeq = 7;
    state.clocks = { 'client-a': 3 };

    const res = await statusGET(statusRequest(), params());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.documentId).toBe(DOC);
    expect(body.active).toBeNull();
    expect(body.lastSeq).toBe(7);
    expect(body.lastMutationIDChanges).toEqual({ 'client-a': 3 });
    expect(body.lastTerminal).toMatchObject({ type: 'agent:turn_end', seq: 7 });
    expect(body.finalResponse).toBeNull();
  });

  it('reports a LIVE run from the registry with identity + startedAt', async () => {
    registerActiveRun(DOC, { sessionId: 'sess-1', runId: 'run-1', promptPreview: 'draw a card' });

    const res = await statusGET(statusRequest(), params());
    const body = await res.json();

    expect(body.active).toMatchObject({ sessionId: 'sess-1', runId: 'run-1', promptPreview: 'draw a card' });
    expect(typeof body.active.startedAt).toBe('string');
    expect(new Date(body.active.startedAt).getTime()).toBeGreaterThan(0);
  });

  it('returns the LAST turn_final text as finalResponse (terminal reconciliation)', async () => {
    seedJournalRow(3, 'agent:turn_final', { type: 'agent:turn_final', text: 'first final', status: 'complete' });
    seedJournalRow(9, 'agent:turn_final', { type: 'agent:turn_final', text: 'latest final', status: 'complete' });
    seedJournalRow(10, 'agent:turn_end', { type: 'agent:turn_end' });
    state.lastSeq = 10;

    const res = await statusGET(statusRequest(), params());
    const body = await res.json();

    expect(body.finalResponse).toBe('latest final');
    expect(body.lastTerminal).toMatchObject({ type: 'agent:turn_end', seq: 10 });
    expect(body.lastSeq).toBe(10);
  });

  it('an empty journal reports zeros and nulls, not a 500', async () => {
    const res = await statusGET(statusRequest(), params());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lastSeq).toBe(0);
    expect(body.lastMutationIDChanges).toEqual({});
    expect(body.lastTerminal).toBeNull();
    expect(body.finalResponse).toBeNull();
  });

  it('unregister (identity-checked) flips active back to null', async () => {
    const token = registerActiveRun(DOC, { runId: 'run-1' });
    unregisterActiveRun(DOC, token);

    const res = await statusGET(statusRequest(), params());
    expect((await res.json()).active).toBeNull();
  });

  it('scans only the journal tail (window bounded, not a full-table query)', async () => {
    // 300 rows — deeper than the 200-row tail window.
    for (let i = 1; i <= 300; i++) {
      seedJournalRow(i, 'agent:message_start', { type: 'agent:message_start', role: 'assistant' });
    }
    seedJournalRow(301, 'agent:turn_end', { type: 'agent:turn_end' });
    state.lastSeq = 301;

    const res = await statusGET(statusRequest(), params());
    const body = await res.json();

    // The terminal is inside the window → found; the getJournalEvents mock
    // received a bounded `take`.
    expect(body.lastTerminal).toMatchObject({ type: 'agent:turn_end', seq: 301 });
  });
});

describe('GET /api/documents/[documentId]/events — lastMutationIDChanges (R1)', () => {
  it('carries the per-client mutation clocks alongside the events', async () => {
    state.clocks = { 'client-a': 12, 'client-b': 4 };
    state.lastSeq = 5;
    seedJournalRow(5, 'agent:turn_end', { type: 'agent:turn_end' });

    const res = await eventsGET(eventsRequest(), params());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.lastMutationIDChanges).toEqual({ 'client-a': 12, 'client-b': 4 });
    expect(body.events).toHaveLength(1);
    expect(body.lastSeq).toBe(5);
  });

  it('returns {} when no client has mutated yet (additive field, old consumers unaffected)', async () => {
    const res = await eventsGET(eventsRequest(), params());
    const body = await res.json();
    expect(body.lastMutationIDChanges).toEqual({});
  });

  it('carries the Phase C compaction fields: snapshotSeq + oldestSeq (R2)', async () => {
    // A server checkpoint covers seq ≤ 40; compaction pruned everything
    // below 10 (KEEP_TAIL under the checkpoint). Both ride the envelope so
    // clients can detect a too-old watermark and re-baseline.
    state.snapshotSeq = 40;
    state.oldestSeq = 10;
    state.lastSeq = 42;
    seedJournalRow(41, 'agent:message_start', { type: 'agent:message_start', role: 'assistant' });
    seedJournalRow(42, 'agent:turn_end', { type: 'agent:turn_end' });

    const res = await eventsGET(eventsRequest(), params());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.snapshotSeq).toBe(40);
    expect(body.oldestSeq).toBe(10);
    expect(body.lastSeq).toBe(42);
  });

  it('reports null snapshotSeq/oldestSeq for a fresh document (no checkpoint, nothing pruned)', async () => {
    const res = await eventsGET(eventsRequest(), params());
    const body = await res.json();
    expect(body.snapshotSeq).toBeNull();
    expect(body.oldestSeq).toBeNull();
  });
});
