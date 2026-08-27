// Tests for the client round-trip pending registry + measured-bounds runtime
// store (src/lib/agent/client-roundtrip.ts, spec §5.2/§5.5 — M2-c).
//
// Contracts under test:
//   - awaitClientResponse NEVER rejects: timeout resolves null so the agent
//     loop can't hang (the critical M2-c constraint)
//   - resolvers resolve the blocked promise and clean up the map
//   - the emit callback runs AFTER registration (no resolve-before-register
//     race — a client answering instantly cannot be dropped)
//   - setMeasuredBounds/getMeasuredBounds with the 20-doc LRU cap

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  awaitClientResponse,
  resolveClientResponse,
  resolveComputedResponse,
  resolveScreenshotResponse,
  setMeasuredBounds,
  getMeasuredBounds,
  __resetClientRoundtripForTests,
  resolveExtractedHtmlResponse,
} from '@/lib/agent/client-roundtrip';

beforeEach(() => {
  __resetClientRoundtripForTests();
});

afterEach(() => {
  __resetClientRoundtripForTests();
});

// ---- awaitClientResponse -----------------------------------------------------

describe('client-roundtrip: awaitClientResponse', () => {
  it('resolves null on timeout (never rejects — agent loop cannot hang)', async () => {
    const start = Date.now();
    const result = await awaitClientResponse<string>('t-timeout', () => {}, 15);
    expect(result).toBeNull();
    expect(Date.now() - start).toBeGreaterThanOrEqual(10);
  });

  it('resolves with the value when the client answers before the timeout', async () => {
    const promise = awaitClientResponse<string[]>('t-answer', () => {
      // Simulate the client answering immediately (same microtask).
      setTimeout(() => resolveClientResponse('t-answer', ['hello']), 1);
    }, 1000);
    const result = await promise;
    expect(result).toEqual(['hello']);
  });

  it('calls emit AFTER registering the pending entry (no race — an instant resolver still lands)', async () => {
    const promise = awaitClientResponse<string>('t-race', () => {
      // If registration happened after emit, this resolve would be a no-op
      // and the await would hit the timeout → null.
      const ok = resolveClientResponse('t-race', 'instant');
      expect(ok).toBe(true);
    }, 1000);
    expect(await promise).toBe('instant');
  });

  it('returns false when resolving an unknown / already-timed-out call', () => {
    expect(resolveClientResponse('never-registered', 'x')).toBe(false);
  });

  it('a late resolver after timeout is a harmless no-op', async () => {
    const result = await awaitClientResponse<string>('t-late', () => {}, 5);
    expect(result).toBeNull();
    expect(resolveClientResponse('t-late', 'too late')).toBe(false);
  });
});

// ---- typed resolvers ---------------------------------------------------------

describe('client-roundtrip: typed resolvers', () => {
  it('resolveComputedResponse forwards the results array', async () => {
    const payload: Array<{ id: string; rect: { x: number; y: number; width: number; height: number }; computed: Record<string, string> }> = [
      { id: 'n1', rect: { x: 0, y: 0, width: 1, height: 1 }, computed: { display: 'flex' } },
      { id: 'n2', rect: { x: 10, y: 0, width: 2, height: 2 }, computed: {} },
    ];
    const promise = awaitClientResponse<typeof payload>('c-1', () => {
      setTimeout(() => resolveComputedResponse('c-1', payload), 1);
    }, 1000);
    const results = await promise;
    expect(results?.map((r) => r.id)).toEqual(['n1', 'n2']);
  });

  it('resolveComputedResponse coerces a non-array payload to []', async () => {
    const promise = awaitClientResponse<unknown[]>('c-2', () => {
      setTimeout(() => resolveComputedResponse('c-2', undefined as any), 1);
    }, 1000);
    expect(await promise).toEqual([]);
  });

  it('resolveScreenshotResponse passes through a valid data URL', async () => {
    const dataUrl = 'data:image/png;base64,aGVsbG8=';
    const promise = awaitClientResponse<{ dataUrl?: string; error?: string }>('s-1', () => {
      setTimeout(() => resolveScreenshotResponse('s-1', dataUrl), 1);
    }, 1000);
    const shot = await promise;
    expect(shot?.dataUrl).toBe(dataUrl);
    expect(shot?.error).toBeUndefined();
  });

  it('resolveScreenshotResponse converts a missing data URL into an error', async () => {
    const promise = awaitClientResponse<{ dataUrl?: string; error?: string }>('s-2', () => {
      setTimeout(() => resolveScreenshotResponse('s-2', undefined, 'no-dom-renderer'), 1);
    }, 1000);
    const shot = await promise;
    expect(shot?.dataUrl).toBeUndefined();
    expect(shot?.error).toBe('no-dom-renderer');
  });

  it('resolveScreenshotResponse rejects a non-image dataUrl as an error', async () => {
    const promise = awaitClientResponse<{ dataUrl?: string; error?: string }>('s-3', () => {
      setTimeout(() => resolveScreenshotResponse('s-3', 'not-a-data-url'), 1);
    }, 1000);
    const shot = await promise;
    expect(shot?.dataUrl).toBeUndefined();
    expect(shot?.error).toBe('invalid_data_url');
  });
});

// ---- resolveExtractedHtmlResponse (Phase 3 v2 — pen_insert_html mode='v2') ---

describe('client-roundtrip: resolveExtractedHtmlResponse', () => {
  it('resolves with the extracted children when the client answers', async () => {
    const children = [
      { id: 'n1', type: 'frame', x: 0, y: 0, width: 100, height: 50, fill: '#ff0000' },
      { id: 'n2', type: 'text', x: 4, y: 4, content: 'hi' },
    ];
    const promise = awaitClientResponse<{ children?: unknown[]; warnings?: string[]; nodeCount?: number; error?: string }>('e-1', () => {
      setTimeout(() => resolveExtractedHtmlResponse('e-1', children as Array<Record<string, unknown>>, ['max-depth: 20 (skipped 3 descendants)']), 1);
    }, 1000);
    const result = await promise;
    expect(result?.children).toEqual(children);
    expect(result?.warnings).toEqual(['max-depth: 20 (skipped 3 descendants)']);
    expect(result?.nodeCount).toBe(2);
    expect(result?.error).toBeUndefined();
  });

  it('resolves with an error when the client reports an extraction failure', async () => {
    const promise = awaitClientResponse<{ children?: unknown[]; warnings?: string[]; nodeCount?: number; error?: string }>('e-2', () => {
      setTimeout(() => resolveExtractedHtmlResponse('e-2', undefined, undefined, 'no-dom-renderer'), 1);
    }, 1000);
    const result = await promise;
    expect(result?.children).toEqual([]);
    expect(result?.error).toBe('no-dom-renderer');
    expect(result?.nodeCount).toBe(0);
  });

  it('coerces a missing children array to empty (defensive — never throws)', async () => {
    const promise = awaitClientResponse<{ children?: unknown[]; warnings?: string[]; nodeCount?: number; error?: string }>('e-3', () => {
      // Client POST malformed — children is a string instead of an array.
      setTimeout(() => resolveExtractedHtmlResponse('e-3', 'not-an-array' as unknown as Array<Record<string, unknown>>), 1);
    }, 1000);
    const result = await promise;
    expect(result?.children).toEqual([]);
    expect(result?.error).toBe('extract_html_failed');
  });

  it('returns false when resolving an unknown / already-timed-out call', () => {
    expect(resolveExtractedHtmlResponse('does-not-exist', [{ id: 'x', type: 'frame' }])).toBe(false);
  });
});

// ---- measured-bounds store ---------------------------------------------------

describe('client-roundtrip: measured-bounds store', () => {
  it('returns {} for a document with no push yet', () => {
    expect(getMeasuredBounds('unknown-doc')).toEqual({});
  });

  it('stores and returns bounds per document', () => {
    setMeasuredBounds('doc-a', { n1: { width: 84, height: 24 }, n2: { width: 320, height: 56 } });
    expect(getMeasuredBounds('doc-a')).toEqual({
      n1: { width: 84, height: 24 },
      n2: { width: 320, height: 56 },
    });
    // Other documents are unaffected.
    expect(getMeasuredBounds('doc-b')).toEqual({});
  });

  it('a second push REPLACES the document map (not merges)', () => {
    setMeasuredBounds('doc-a', { n1: { width: 1, height: 1 } });
    setMeasuredBounds('doc-a', { n2: { width: 2, height: 2 } });
    const bounds = getMeasuredBounds('doc-a');
    expect(Object.keys(bounds)).toEqual(['n2']);
  });

  it('evicts the OLDEST document when the LRU cap (20) is exceeded', () => {
    for (let i = 0; i < 22; i++) {
      setMeasuredBounds(`doc-${i}`, { n: { width: i, height: i } });
    }
    expect(Object.keys(getMeasuredBounds('doc-0'))).toEqual([]); // evicted
    expect(Object.keys(getMeasuredBounds('doc-1'))).toEqual([]); // evicted
    expect(getMeasuredBounds('doc-2')).toEqual({ n: { width: 2, height: 2 } }); // survivor
    expect(getMeasuredBounds('doc-21')).toEqual({ n: { width: 21, height: 21 } }); // newest
  });

  it('re-pushing an existing document refreshes its LRU position', () => {
    for (let i = 0; i < 19; i++) {
      setMeasuredBounds(`doc-${i}`, { n: { width: i, height: i } });
    }
    // Touch doc-0 → it becomes the most-recently-used.
    setMeasuredBounds('doc-0', { n: { width: 100, height: 100 } });
    // Two more docs push the size past 20 — doc-1 is now the oldest.
    setMeasuredBounds('doc-new-1', {});
    setMeasuredBounds('doc-new-2', {});
    expect(Object.keys(getMeasuredBounds('doc-1'))).toEqual([]); // evicted (oldest)
    expect(getMeasuredBounds('doc-0')).toEqual({ n: { width: 100, height: 100 } }); // survived the touch
  });

  it('ignores garbage input (empty id / non-object bounds)', () => {
    setMeasuredBounds('', { n: { width: 1, height: 1 } });
    setMeasuredBounds('doc-x', null as any);
    setMeasuredBounds('doc-x', 'nope' as any);
    expect(getMeasuredBounds('doc-x')).toEqual({});
    expect(getMeasuredBounds('')).toEqual({});
  });
});
