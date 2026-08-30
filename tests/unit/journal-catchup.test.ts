// Unit tests — client-side reconnect catch-up (src/lib/canvas/journal-catchup.ts).
//
// The module consumes GET /api/documents/[id]/events (the AgentEvent journal
// read API) and replays missed agent events after a socket reconnect.
//
// Phase B semantics: replay is UNBOUNDED and identity-idempotent — the whole
// gap window dispatches (terminals included, in journal order); patches and
// user_patch rows never dispatch (canvas:full owns canvas state); the
// first-connect baseline still skips history; lastMutationIDChanges feeds
// the adapter's outbox prune hook.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  runJournalCatchUp,
  loadWatermark,
  saveWatermark,
  scheduleWatermarkAdvance,
  __clearPendingWatermarkAdvances,
  type JournalRowWire,
  type CatchUpAdapter,
} from '@/lib/canvas/journal-catchup';

const DOC = 'doc-catchup';

function row(seq: number, type: string, payload: unknown, toolCallId: string | null = null): JournalRowWire {
  return { seq, type, toolCallId, payload, createdAt: new Date().toISOString() };
}

/// Queue of canned API responses keyed by the afterSeq the request carried.
function mockEventsApi(
  pagesByAfterSeq: Record<number, {
    events: JournalRowWire[];
    lastSeq: number;
    truncated?: boolean;
    lastMutationIDChanges?: Record<string, number>;
    oldestSeq?: number | null;
    snapshotSeq?: number | null;
  }>,
): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      calls.push(String(input));
      const url = new URL(String(input), 'http://localhost');
      const afterSeq = Number(url.searchParams.get('afterSeq'));
      const limit = Number(url.searchParams.get('limit'));
      const key = pagesByAfterSeq[afterSeq];
      if (!key) {
        // Default: nothing at/after this watermark.
        const fallback = { events: [], lastSeq: 0, count: 0, truncated: false };
        return new Response(JSON.stringify(fallback), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          events: key.events.slice(0, limit),
          lastSeq: key.lastSeq,
          count: key.events.length,
          truncated: key.truncated ?? false,
          lastMutationIDChanges: key.lastMutationIDChanges ?? {},
          oldestSeq: key.oldestSeq ?? null,
          snapshotSeq: key.snapshotSeq ?? null,
        }),
        { status: 200 },
      );
    }),
  );
  return { calls };
}

function recordingAdapter(): CatchUpAdapter & { dispatched: string[]; clocks: Array<Record<string, number>> } {
  const dispatched: string[] = [];
  const clocks: Array<Record<string, number>> = [];
  return {
    dispatched,
    clocks,
    dispatch: (ev) => dispatched.push(ev.type),
    onMutationClock: (changes) => clocks.push(changes),
  };
}

describe('journal-catchup: watermark persistence', () => {
  beforeEach(() => localStorage.clear());

  it('saves and loads per-document watermarks', () => {
    expect(loadWatermark(DOC)).toBe(0);
    saveWatermark(DOC, 41);
    expect(loadWatermark(DOC)).toBe(41);
    saveWatermark('other-doc', 99);
    expect(loadWatermark(DOC)).toBe(41); // isolated per document
  });

  it('never moves a watermark backwards (monotonic guard)', () => {
    saveWatermark(DOC, 50);
    saveWatermark(DOC, 30); // stale racing probe — ignored
    expect(loadWatermark(DOC)).toBe(50);
  });
});

describe('journal-catchup: first connect (no watermark)', () => {
  beforeEach(() => {
    localStorage.clear();
    __clearPendingWatermarkAdvances();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('baselines to lastSeq WITHOUT dispatching anything', async () => {
    const { calls } = mockEventsApi({
      [Number.MAX_SAFE_INTEGER]: { events: [], lastSeq: 57 },
    });
    const adapter = recordingAdapter();

    await runJournalCatchUp(DOC, adapter);

    expect(adapter.dispatched).toEqual([]);
    expect(loadWatermark(DOC)).toBe(57);
    expect(calls[0]).toContain(`afterSeq=${Number.MAX_SAFE_INTEGER}`);
  });

  it('reports lastMutationIDChanges from the baseline probe (outbox prune)', async () => {
    mockEventsApi({
      [Number.MAX_SAFE_INTEGER]: {
        events: [],
        lastSeq: 9,
        lastMutationIDChanges: { 'client-a': 4 },
      },
    });
    const adapter = recordingAdapter();

    await runJournalCatchUp(DOC, adapter);

    expect(adapter.clocks).toEqual([{ 'client-a': 4 }]);
  });
});

describe('journal-catchup: unbounded gap replay (R3)', () => {
  beforeEach(() => {
    localStorage.clear();
    __clearPendingWatermarkAdvances();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('replays the WHOLE window — multiple turns, terminals included', async () => {
    saveWatermark(DOC, 100);
    mockEventsApi({
      100: {
        events: [
          // Turn 1 (missed entirely)
          row(101, 'agent:user_message', { type: 'agent:user_message', text: 'hi' }),
          row(102, 'agent:message_start', { type: 'agent:message_start', role: 'assistant' }),
          row(103, 'agent:tool_call_start', { type: 'agent:tool_call_start', toolCallId: 'tc-1', toolName: 'pen_create_shape', argsPreview: '{}' }, 'tc-1'),
          row(104, 'agent:tool_call_end', { type: 'agent:tool_call_end', toolCallId: 'tc-1', success: true, summary: 'ok' }, 'tc-1'),
          row(105, 'agent:turn_end', { type: 'agent:turn_end' }),
          row(106, 'agent:turn_final', { type: 'agent:turn_final', text: 'done', status: 'complete' }),
          // Turn 2 (missed entirely) — previously NOT reconstructed
          row(107, 'agent:user_message', { type: 'agent:user_message', text: 'again' }),
          row(108, 'agent:message_start', { type: 'agent:message_start', role: 'assistant' }),
          row(109, 'agent:turn_end', { type: 'agent:turn_end' }),
          row(110, 'agent:turn_final', { type: 'agent:turn_final', text: 'done twice', status: 'complete' }),
        ],
        lastSeq: 110,
      },
    });
    const adapter = recordingAdapter();

    await runJournalCatchUp(DOC, adapter);

    // Everything dispatched — replay no longer stops at the first terminal.
    expect(adapter.dispatched).toEqual([
      'agent:user_message',
      'agent:message_start',
      'agent:tool_call_start',
      'agent:tool_call_end',
      'agent:turn_end',
      'agent:turn_final',
      'agent:user_message',
      'agent:message_start',
      'agent:turn_end',
      'agent:turn_final',
    ]);
    expect(loadWatermark(DOC)).toBe(110);
  });

  it('replays a missed turn_cancelled closure (the stranded-turn money case)', async () => {
    saveWatermark(DOC, 10);
    mockEventsApi({
      10: {
        events: [
          row(11, 'agent:tool_call_start', { type: 'agent:tool_call_start', toolCallId: 'tc-x', toolName: 'pen_generate_variants', argsPreview: '' }, 'tc-x'),
          row(12, 'agent:turn_cancelled', { type: 'agent:turn_cancelled' }),
          row(13, 'agent:turn_final', { type: 'agent:turn_final', text: '', status: 'cancelled' }),
        ],
        lastSeq: 13,
      },
    });
    const adapter = recordingAdapter();

    await runJournalCatchUp(DOC, adapter);

    expect(adapter.dispatched).toEqual([
      'agent:tool_call_start',
      'agent:turn_cancelled',
      'agent:turn_final',
    ]);
    expect(loadWatermark(DOC)).toBe(13);
  });

  it('skips synthetic audit rows AND canvas-state rows (patch, user_patch)', async () => {
    saveWatermark(DOC, 200);
    mockEventsApi({
      200: {
        events: [
          row(201, 'agent:tool_call_interrupted', { note: 'interrupted' }, 'tc-orphan'),
          row(202, 'patch_dropped', { reason: ['duplicate id'] }, 'tc-2'),
          row(203, 'patch', { patch: { op: 'add' }, toolCallId: 'tc-3' }, 'tc-3'),
          row(204, 'user_patch', { clientId: 'client-a', clientMutationId: 1, patch: { op: 'update' } }),
          row(205, 'agent:turn_end', { type: 'agent:turn_end' }),
        ],
        lastSeq: 205,
      },
    });
    const adapter = recordingAdapter();

    await runJournalCatchUp(DOC, adapter);

    expect(adapter.dispatched).toEqual(['agent:turn_end']);
  });

  it('skips rows whose payload type mismatches the row type (foreign/truncated rows)', async () => {
    saveWatermark(DOC, 300);
    mockEventsApi({
      300: {
        events: [
          row(301, 'agent:message_end', { type: 'agent:message_delta', text: 'mismatch' }),
          row(302, 'agent:turn_end', { type: 'agent:turn_end' }),
        ],
        lastSeq: 302,
      },
    });
    const adapter = recordingAdapter();

    await runJournalCatchUp(DOC, adapter);

    expect(adapter.dispatched).toEqual(['agent:turn_end']);
  });

  it('dispatches even when no turn is open (guard removed — identity-idempotent replay)', async () => {
    saveWatermark(DOC, 500);
    mockEventsApi({
      500: {
        events: [
          row(501, 'agent:user_message', { type: 'agent:user_message', text: 'foreign turn' }),
          row(502, 'agent:message_start', { type: 'agent:message_start', role: 'assistant' }),
          row(503, 'agent:turn_final', { type: 'agent:turn_final', text: 'late', status: 'complete' }),
        ],
        lastSeq: 503,
      },
    });
    const adapter = recordingAdapter();

    await runJournalCatchUp(DOC, adapter);

    // The old closed-turn guard skipped everything; Phase B reconstructs the
    // missed turn (the handlers adopt by identity, position is irrelevant).
    expect(adapter.dispatched).toEqual([
      'agent:user_message',
      'agent:message_start',
      'agent:turn_final',
    ]);
    expect(loadWatermark(DOC)).toBe(503);
  });

  it('reports lastMutationIDChanges with the replay (outbox prune hook)', async () => {
    saveWatermark(DOC, 60);
    mockEventsApi({
      60: {
        events: [row(61, 'agent:turn_end', { type: 'agent:turn_end' })],
        lastSeq: 61,
        lastMutationIDChanges: { 'client-a': 12 },
      },
    });
    const adapter = recordingAdapter();

    await runJournalCatchUp(DOC, adapter);

    expect(adapter.clocks).toEqual([{ 'client-a': 12 }]);
  });

  it('pages through a truncated window until current', async () => {
    saveWatermark(DOC, 1);
    const pageOne = Array.from({ length: 200 }, (_, i) =>
      row(2 + i, 'agent:message_start', { type: 'agent:message_start', role: 'assistant' }),
    );
    mockEventsApi({
      1: { events: pageOne, lastSeq: 400, truncated: true },
      201: {
        events: [
          row(202, 'agent:turn_end', { type: 'agent:turn_end' }),
        ],
        lastSeq: 400,
      },
    });
    const adapter = recordingAdapter();

    await runJournalCatchUp(DOC, adapter);

    // 200 from page one + the terminal from page two.
    expect(adapter.dispatched).toHaveLength(201);
    expect(adapter.dispatched[adapter.dispatched.length - 1]).toBe('agent:turn_end');
    expect(loadWatermark(DOC)).toBe(400);
  });

  it('keeps the old watermark when the fetch fails (offline flapping)', async () => {
    saveWatermark(DOC, 77);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    const adapter = recordingAdapter();

    await runJournalCatchUp(DOC, adapter);

    expect(adapter.dispatched).toEqual([]);
    expect(loadWatermark(DOC)).toBe(77); // untouched — retried on next reconnect
  });
});

describe('journal-catchup: too-old watermark re-baseline (R2 compaction)', () => {
  beforeEach(() => localStorage.clear());

  it('re-baselines WITHOUT replay when rows below the watermark were compacted away', async () => {
    saveWatermark(DOC, 5);
    // Server compacted: the oldest surviving row is 120, head 200. Watermark
    // 5 < 120 → the window is NOT contiguous — replaying the surviving
    // fragment would surface a partial history. Replicache bad-cookie rule:
    // full refetch (canvas via canvas:full, transcript via the sessions
    // store), never an error, never a partial replay.
    mockEventsApi({
      5: {
        events: [row(120, 'agent:message_start', { type: 'agent:message_start' })],
        lastSeq: 200,
        oldestSeq: 120,
        snapshotSeq: 118,
      },
    });
    const adapter = recordingAdapter();
    await runJournalCatchUp(DOC, adapter);

    expect(loadWatermark(DOC)).toBe(200); // re-baselined to the head
    expect(adapter.dispatched).toEqual([]); // NO replay of the surviving fragment
    expect(adapter.clocks).toEqual([{}]); // mutation clocks still reported (outbox prune)
  });

  it('replays normally when the watermark sits inside the surviving window', async () => {
    saveWatermark(DOC, 119);
    mockEventsApi({
      119: { events: [row(120, 'agent:message_end', { type: 'agent:message_end' })], lastSeq: 121, oldestSeq: 120 },
    });
    const adapter = recordingAdapter();
    await runJournalCatchUp(DOC, adapter);

    expect(loadWatermark(DOC)).toBe(121);
    expect(adapter.dispatched).toEqual(['agent:message_end']);
  });

  it('replays normally when oldestSeq is absent (pre-Phase-C server)', async () => {
    saveWatermark(DOC, 7);
    mockEventsApi({
      7: { events: [row(8, 'agent:turn_end', { type: 'agent:turn_end' })], lastSeq: 8 },
    });
    const adapter = recordingAdapter();
    await runJournalCatchUp(DOC, adapter);

    expect(loadWatermark(DOC)).toBe(8);
    expect(adapter.dispatched).toEqual(['agent:turn_end']);
  });

  it('keeps the old watermark when the probe fails (offline — same as the gap path)', async () => {
    saveWatermark(DOC, 5);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
    const adapter = recordingAdapter();
    await runJournalCatchUp(DOC, adapter);
    expect(loadWatermark(DOC)).toBe(5);
  });
});

describe('journal-catchup: live-terminal watermark advance (debounced)', () => {
  beforeEach(() => {
    localStorage.clear();
    __clearPendingWatermarkAdvances();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    __clearPendingWatermarkAdvances();
  });

  it('coalesces bursts of terminal events into one probe and saves lastSeq', async () => {
    mockEventsApi({
      [Number.MAX_SAFE_INTEGER]: { events: [], lastSeq: 900 },
    });

    scheduleWatermarkAdvance(DOC);
    scheduleWatermarkAdvance(DOC); // burst (turn_cancelled + turn_end)
    scheduleWatermarkAdvance(DOC);

    expect(loadWatermark(DOC)).toBe(0); // nothing before the debounce fires

    await vi.advanceTimersByTimeAsync(700);

    expect(loadWatermark(DOC)).toBe(900);
  });
});
