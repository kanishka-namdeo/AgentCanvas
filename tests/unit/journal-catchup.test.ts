// Unit tests — client-side reconnect catch-up (src/lib/canvas/journal-catchup.ts).
//
// The module consumes GET /api/documents/[id]/events (the AgentEvent journal
// read API) and replays missed agent events after a socket reconnect. These
// tests pin the three replay-safety guards, the watermark model, and paging.

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
  pagesByAfterSeq: Record<number, { events: JournalRowWire[]; lastSeq: number; truncated?: boolean }>,
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
        }),
        { status: 200 },
      );
    }),
  );
  return { calls };
}

function recordingAdapter(open = true): CatchUpAdapter & { dispatched: string[] } {
  const dispatched: string[] = [];
  return {
    dispatched,
    isTurnOpen: () => open,
    dispatch: (ev) => dispatched.push(ev.type),
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
    const adapter = recordingAdapter(true);

    await runJournalCatchUp(DOC, adapter);

    expect(adapter.dispatched).toEqual([]);
    expect(loadWatermark(DOC)).toBe(57);
    expect(calls[0]).toContain(`afterSeq=${Number.MAX_SAFE_INTEGER}`);
  });
});

describe('journal-catchup: gap replay with an open turn', () => {
  beforeEach(() => {
    localStorage.clear();
    __clearPendingWatermarkAdvances();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('replays missed agent events and STOPS at the first terminal event', async () => {
    saveWatermark(DOC, 100);
    mockEventsApi({
      100: {
        events: [
          row(101, 'agent:message_start', { type: 'agent:message_start', role: 'assistant' }),
          row(102, 'patch', { patch: { op: 'add' }, toolCallId: 'tc-1' }, 'tc-1'),
          row(103, 'agent:tool_call_start', { type: 'agent:tool_call_start', toolCallId: 'tc-1', toolName: 'pen_create_shape', argsPreview: '{}' }, 'tc-1'),
          row(104, 'agent:tool_call_end', { type: 'agent:tool_call_end', toolCallId: 'tc-1', success: true, summary: 'ok' }, 'tc-1'),
          row(105, 'agent:turn_end', { type: 'agent:turn_end' }),
          // Post-terminal rows belong to later turns — must NOT be replayed.
          row(106, 'agent:message_start', { type: 'agent:message_start', role: 'assistant' }),
          row(107, 'agent:turn_end', { type: 'agent:turn_end' }),
        ],
        lastSeq: 107,
      },
    });
    const adapter = recordingAdapter(true);

    await runJournalCatchUp(DOC, adapter);

    // Patch skipped (canvas:full owns canvas state), replay stops at 105.
    expect(adapter.dispatched).toEqual([
      'agent:message_start',
      'agent:tool_call_start',
      'agent:tool_call_end',
      'agent:turn_end',
    ]);
    expect(loadWatermark(DOC)).toBe(107); // advanced to the probed head
  });

  it('replays a missed turn_cancelled closure (the stranded-turn money case)', async () => {
    saveWatermark(DOC, 10);
    mockEventsApi({
      10: {
        events: [
          row(11, 'agent:tool_call_start', { type: 'agent:tool_call_start', toolCallId: 'tc-x', toolName: 'pen_generate_variants', argsPreview: '' }, 'tc-x'),
          row(12, 'agent:turn_cancelled', { type: 'agent:turn_cancelled' }),
        ],
        lastSeq: 12,
      },
    });
    const adapter = recordingAdapter(true);

    await runJournalCatchUp(DOC, adapter);

    expect(adapter.dispatched).toEqual(['agent:tool_call_start', 'agent:turn_cancelled']);
    expect(loadWatermark(DOC)).toBe(12);
  });

  it('skips synthetic audit rows (agent:tool_call_interrupted, patch_dropped)', async () => {
    saveWatermark(DOC, 200);
    mockEventsApi({
      200: {
        events: [
          row(201, 'agent:tool_call_interrupted', { note: 'interrupted' }, 'tc-orphan'),
          row(202, 'patch_dropped', { reason: ['duplicate id'] }, 'tc-2'),
          row(203, 'agent:turn_end', { type: 'agent:turn_end' }),
        ],
        lastSeq: 203,
      },
    });
    const adapter = recordingAdapter(true);

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
    const adapter = recordingAdapter(true);

    await runJournalCatchUp(DOC, adapter);

    expect(adapter.dispatched).toEqual(['agent:turn_end']);
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
    const adapter = recordingAdapter(true);

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
    const adapter = recordingAdapter(true);

    await runJournalCatchUp(DOC, adapter);

    expect(adapter.dispatched).toEqual([]);
    expect(loadWatermark(DOC)).toBe(77); // untouched — retried on next reconnect
  });
});

describe('journal-catchup: closed-turn guard', () => {
  beforeEach(() => {
    localStorage.clear();
    __clearPendingWatermarkAdvances();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('advances the watermark but dispatches NOTHING when the last turn is closed', async () => {
    saveWatermark(DOC, 500);
    mockEventsApi({
      500: {
        events: [
          row(501, 'agent:message_start', { type: 'agent:message_start', role: 'assistant' }),
          row(502, 'agent:tool_call_start', { type: 'agent:tool_call_start', toolCallId: 'tc-f', toolName: 'x', argsPreview: '' }, 'tc-f'),
          row(503, 'agent:turn_end', { type: 'agent:turn_end' }),
        ],
        lastSeq: 503,
      },
    });
    const adapter = recordingAdapter(false); // no open turn

    await runJournalCatchUp(DOC, adapter);

    // The window belongs to foreign/older turns — position-based replay onto
    // a closed/different turn would corrupt it. Skip + square the watermark.
    expect(adapter.dispatched).toEqual([]);
    expect(loadWatermark(DOC)).toBe(503);
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
