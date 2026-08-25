// Drag-side patch coalescing — Phase 4 §4.4 item 3 last-write-wins tests.
//
// Pins the spec's drag-side requirement via the PURE `dedupeLocalUpdates`
// function: when sendPatch is called with multiple `update` ops for the
// SAME shapeId within a single rAF frame, only the LATEST one survives to
// flush time. The dropped earlier patches also drop their undo entries —
// so ⌘Z walks back an entire drag gesture as ONE undo step (one per frame
// per shapeId), not N steps for N mousemove events.
//
// The test-env sync flush in `enqueuePatch` (NODE_ENV='test') prevents
// accumulation across multiple sendPatch calls in the same test, so the
// integration path can't be tested directly. Instead, we test the pure
// dedup function — which is what flushPatchQueue calls right before the
// serial replay. Production behavior (rAF-batched, drag LWW per shapeId)
// is the spec Phase 4 §4.4 item 3 contract this pins.

import { describe, it, expect } from 'vitest';
import { dedupeLocalUpdates } from '@/lib/canvas/store';
import type { QueuedPatch } from '@/lib/canvas/store';
import type { CanvasPatch } from '@/lib/canvas/types';

// ---- Helpers ----------------------------------------------------------------

function localUpdate(shapeId: string, x: number): QueuedPatch {
  return {
    local: true,
    patch: { op: 'update', shapeId, shape: { x }, summary: `drag ${shapeId} → x=${x}` },
  };
}

function agentUpdate(shapeId: string, x: number): QueuedPatch {
  return {
    local: false,
    patch: { op: 'update', shapeId, shape: { x }, summary: `agent ${shapeId} → x=${x}` },
  };
}

function localAdd(shapeId: string): QueuedPatch {
  return {
    local: true,
    patch: {
      op: 'add',
      shapeId,
      shape: { id: shapeId, type: 'rectangle', name: shapeId, x: 0, y: 0, width: 100, height: 100, fill: '#ccc' },
      summary: `add ${shapeId}`,
    },
  };
}

function localRemove(shapeIds: string[]): QueuedPatch {
  return {
    local: true,
    patch: { op: 'remove', shapeIds, summary: `remove ${shapeIds.length}` },
  };
}

function localSelect(shapeIds: string[]): QueuedPatch {
  return {
    local: true,
    patch: { op: 'select', shapeIds, summary: `select ${shapeIds.length}` },
  };
}

// ---- Tests ------------------------------------------------------------------

describe('dedupeLocalUpdates — drag-side last-write-wins (Phase 4 §4.4 item 3)', () => {
  describe('basic LWW for local update ops', () => {
    it('collapses 3 local updates to the same shapeId to ONE (the latest)', () => {
      const queued: QueuedPatch[] = [
        localUpdate('a', 10),
        localUpdate('a', 20),
        localUpdate('a', 30),
      ];
      const out = dedupeLocalUpdates(queued);
      expect(out.length).toBe(1);
      expect((out[0].patch.shape as { x: number }).x).toBe(30);
    });

    it('preserves the LATEST update per shapeId when shapeIds differ', () => {
      const queued: QueuedPatch[] = [
        localUpdate('a', 10),
        localUpdate('b', 100),
        localUpdate('a', 20),
        localUpdate('b', 200),
        localUpdate('a', 30),
      ];
      const out = dedupeLocalUpdates(queued);
      expect(out.length).toBe(2);
      // Order preserved: 'a' (latest=30), 'b' (latest=200)
      const aPatch = out.find((q) => q.patch.shapeId === 'a');
      const bPatch = out.find((q) => q.patch.shapeId === 'b');
      expect((aPatch?.patch.shape as { x: number }).x).toBe(30);
      expect((bPatch?.patch.shape as { x: number }).x).toBe(200);
    });

    it('preserves order: surviving patches keep their relative queue positions', () => {
      const queued: QueuedPatch[] = [
        localAdd('first'),
        localUpdate('a', 10),
        localUpdate('a', 20),
        localAdd('middle'),
        localUpdate('b', 100),
        localUpdate('b', 200),
        localAdd('last'),
      ];
      const out = dedupeLocalUpdates(queued);
      // Expected: first, a(20), middle, b(200), last
      expect(out.length).toBe(5);
      expect(out[0].patch.op).toBe('add');
      expect((out[0].patch as { shapeId: string }).shapeId).toBe('first');
      expect(out[1].patch.op).toBe('update');
      expect((out[1].patch.shape as { x: number }).x).toBe(20);
      expect(out[2].patch.op).toBe('add');
      expect((out[2].patch as { shapeId: string }).shapeId).toBe('middle');
      expect(out[3].patch.op).toBe('update');
      expect((out[3].patch.shape as { x: number }).x).toBe(200);
      expect(out[4].patch.op).toBe('add');
      expect((out[4].patch as { shapeId: string }).shapeId).toBe('last');
    });
  });

  describe('does NOT dedupe non-update ops', () => {
    it('multiple local `add` ops survive unchanged', () => {
      const queued: QueuedPatch[] = [
        localAdd('a'),
        localAdd('b'),
        localAdd('c'),
      ];
      const out = dedupeLocalUpdates(queued);
      expect(out.length).toBe(3);
    });

    it('multiple local `remove` ops survive unchanged (even with same shapeIds)', () => {
      const queued: QueuedPatch[] = [
        localRemove(['a']),
        localRemove(['a', 'b']),
        localRemove(['a']),
      ];
      const out = dedupeLocalUpdates(queued);
      expect(out.length).toBe(3);
    });

    it('multiple local `select` ops survive unchanged (non-mutating, never deduped)', () => {
      const queued: QueuedPatch[] = [
        localSelect(['a']),
        localSelect(['a', 'b']),
        localSelect(['a']),
      ];
      const out = dedupeLocalUpdates(queued);
      expect(out.length).toBe(3);
    });
  });

  describe('does NOT dedupe agent-driven (non-local) patches', () => {
    it('agent updates with the same shapeId survive unchanged (full per-patch undo)', () => {
      const queued: QueuedPatch[] = [
        agentUpdate('a', 10),
        agentUpdate('a', 20),
        agentUpdate('a', 30),
      ];
      const out = dedupeLocalUpdates(queued);
      expect(out.length).toBe(3);
    });

    it('mixed local + agent updates: only local updates dedupe', () => {
      const queued: QueuedPatch[] = [
        agentUpdate('a', 10), // agent — survives
        localUpdate('a', 100), // local — dedup candidate
        agentUpdate('a', 20), // agent — survives
        localUpdate('a', 200), // local — survives (latest local)
      ];
      const out = dedupeLocalUpdates(queued);
      expect(out.length).toBe(3);
      // agent patches at original positions 0, 2; local latest at position 3
      expect(out[0]).toBe(queued[0]);
      expect(out[1]).toBe(queued[2]);
      expect(out[2]).toBe(queued[3]);
    });
  });

  describe('edge cases', () => {
    it('empty queue returns empty', () => {
      expect(dedupeLocalUpdates([])).toEqual([]);
    });

    it('queue with no local updates returns the input reference unchanged', () => {
      const queued: QueuedPatch[] = [agentUpdate('a', 10), agentUpdate('a', 20)];
      const out = dedupeLocalUpdates(queued);
      expect(out).toBe(queued); // reference equality — no work needed
    });

    it('local update with no shapeId field survives (no dedup key)', () => {
      const queued: QueuedPatch[] = [
        { local: true, patch: { op: 'update', shape: { x: 10 }, summary: 'no-id-1' } },
        { local: true, patch: { op: 'update', shape: { x: 20 }, summary: 'no-id-2' } },
      ];
      const out = dedupeLocalUpdates(queued);
      expect(out.length).toBe(2);
    });

    it('local update with empty string shapeId survives (no dedup key)', () => {
      const queued: QueuedPatch[] = [
        { local: true, patch: { op: 'update', shapeId: '', shape: { x: 10 }, summary: 'empty-id-1' } },
        { local: true, patch: { op: 'update', shapeId: '', shape: { x: 20 }, summary: 'empty-id-2' } },
      ];
      const out = dedupeLocalUpdates(queued);
      expect(out.length).toBe(2);
    });
  });

  describe('property: LWW matches serial apply of only the latest per shapeId', () => {
    // Property: for a queue of N local update patches to K distinct shapeIds,
    // dedupeLocalUpdates returns a queue of exactly K patches — one per
    // shapeId, each carrying the LATEST x value seen for that shapeId in
    // the input queue.
    function randomQueue(length: number): QueuedPatch[] {
      const out: QueuedPatch[] = [];
      for (let i = 0; i < length; i++) {
        const shapeId = `s${Math.floor(Math.random() * 5)}`; // 5 distinct ids
        const x = Math.floor(Math.random() * 1000);
        out.push(localUpdate(shapeId, x));
      }
      return out;
    }

    function latestPerId(queued: QueuedPatch[]): Map<string, number> {
      const m = new Map<string, number>();
      for (const q of queued) {
        const sid = q.patch.shapeId!;
        const x = (q.patch.shape as { x: number }).x;
        m.set(sid, x); // last-writer-wins in queue order
      }
      return m;
    }

    for (let run = 0; run < 20; run++) {
      it(`randomized run #${run + 1}: dedupe yields exactly one patch per shapeId with the latest x`, () => {
        const queued = randomQueue(10 + Math.floor(Math.random() * 20));
        const expected = latestPerId(queued);
        const out = dedupeLocalUpdates(queued);
        expect(out.length).toBe(expected.size);
        for (const q of out) {
          const sid = q.patch.shapeId!;
          const x = (q.patch.shape as { x: number }).x;
          expect(x).toBe(expected.get(sid));
        }
      });
    }
  });
});
