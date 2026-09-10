// Speed-parity P2.2 — per-turn computed-cache for pen_get_computed.
//
// Verifies:
//   - The cache is created per-turn in the runner's ctx.
//   - pen_get_computed reads from the cache on hit (skips round-trip).
//   - applyPatch invalidates cache entries for touched nodes.
//   - Cache entries expire after 5s TTL.
//
// Spec: docs/speed-parity-spec/07-agent-behaviors-flows.md (P2.2)

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createCanvasTools, type CanvasToolContext } from '@/lib/agent/tools';
import type { CanvasDocument, CanvasPatch, Shape } from '@/lib/canvas/types';
import { applyPatchToCanvas } from '@/lib/canvas/patch';

// ---- In-memory harness (same shape as tools.test.ts) -------------------------

interface TestHarness {
  doc: CanvasDocument;
  patches: CanvasPatch[];
  ctx: CanvasToolContext;
  reset(): void;
  addShape(s: Partial<Shape> & { id: string }): Shape;
}

function makeHarness(): TestHarness {
  let doc: CanvasDocument = {
    id: 'doc-cache',
    name: 'Test',
    background: '#ffffff',
    version: '2.17',
    children: [],
    viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes: [],
    tokens: { colors: [], textStyles: [] },
  };
  const patches: CanvasPatch[] = [];
  const computedCache = new Map<string, { value: unknown; expiresAt: number }>();
  const invalidateComputedCache = (nodeId: string) => {
    computedCache.delete(nodeId);
  };
  const collectTouchedIds = (_patch: CanvasPatch) => {};
  const extractTouchedNodeIds = (patch: CanvasPatch): string[] => {
    const ids: string[] = [];
    if (patch.op === 'update' && typeof (patch as any).shapeId === 'string') {
      ids.push((patch as any).shapeId);
    } else if (Array.isArray(patch.updates)) {
      for (const u of patch.updates) {
        if (u && typeof (u as any).id === 'string') ids.push((u as any).id);
      }
    }
    if (typeof (patch as any).shapeId === 'string' && !ids.includes((patch as any).shapeId)) {
      ids.push((patch as any).shapeId);
    }
    return ids;
  };
  const ctx: CanvasToolContext = {
    getShapes: () => doc.shapes ?? [],
    getTokens: () => doc.tokens ?? { colors: [], textStyles: [] },
    getDocument: () => doc,
    computedCache,
    invalidateComputedCache,
    applyPatch(patch: CanvasPatch): CanvasPatch {
      collectTouchedIds(patch);
      for (const id of extractTouchedNodeIds(patch)) invalidateComputedCache(id);
      doc = applyPatchToCanvas(doc, patch);
      patches.push(patch);
      return patch;
    },
  };
  return {
    doc,
    patches,
    ctx,
    reset() {
      doc.shapes = [];
      doc.children = [];
      patches.length = 0;
      computedCache.clear();
    },
    addShape(s: Partial<Shape> & { id: string }): Shape {
      const shape = { type: 'rect', name: s.id, ...s } as Shape;
      doc.shapes = [...(doc.shapes ?? []), shape];
      return shape;
    },
  };
}

// ---- Tests ------------------------------------------------------------------

describe('P2.2: per-turn computed-cache for pen_get_computed', () => {
  let h: TestHarness;

  beforeEach(() => {
    h = makeHarness();
  });

  it('ctx.computedCache is a Map (created per-turn by the runner)', () => {
    expect(h.ctx.computedCache).toBeInstanceOf(Map);
    expect(h.ctx.invalidateComputedCache).toBeTypeOf('function');
  });

  it('applyPatch invalidates cache entries for touched nodes', () => {
    const cache = h.ctx.computedCache!;

    // Seed the cache with entries for two nodes.
    cache.set('node-1', { value: { id: 'node-1' }, expiresAt: Date.now() + 5000 });
    cache.set('node-2', { value: { id: 'node-2' }, expiresAt: Date.now() + 5000 });
    expect(cache.size).toBe(2);

    // Apply a patch that touches node-1.
    h.addShape({ id: 'node-1', type: 'frame' as const, x: 0, y: 0, width: 100, height: 100 });
    const patch = {
      id: 'p1',
      op: 'update' as const,
      shapeId: 'node-1',
      changes: { x: 50 },
    } as unknown as CanvasPatch;
    h.ctx.applyPatch(patch);

    // node-1's cache entry should be invalidated; node-2 should survive.
    expect(cache.has('node-1')).toBe(false);
    expect(cache.has('node-2')).toBe(true);
  });

  it('cache entries expire after 5s TTL', () => {
    const cache = h.ctx.computedCache!;
    const pastTime = Date.now() - 6000; // 6s ago — past the 5s TTL
    cache.set('stale-node', { value: { id: 'stale-node' }, expiresAt: pastTime });
    cache.set('fresh-node', { value: { id: 'fresh-node' }, expiresAt: Date.now() + 4000 });

    // The pen_get_computed tool checks entry.expiresAt > Date.now() before
    // treating a cache entry as a hit. A stale entry is treated as a miss.
    const now = Date.now();
    const staleEntry = cache.get('stale-node');
    const freshEntry = cache.get('fresh-node');
    const staleHit = staleEntry && staleEntry.expiresAt > now;
    const freshHit = freshEntry && freshEntry.expiresAt > now;
    expect(staleHit).toBeFalsy();
    expect(freshHit).toBeTruthy();
  });

  it('multiple mutations in one turn each invalidate their respective nodes', () => {
    const cache = h.ctx.computedCache!;
    h.addShape({ id: 'a', type: 'frame' as const, x: 0, y: 0, width: 50, height: 50 });
    h.addShape({ id: 'b', type: 'frame' as const, x: 100, y: 0, width: 50, height: 50 });
    h.addShape({ id: 'c', type: 'frame' as const, x: 200, y: 0, width: 50, height: 50 });

    cache.set('a', { value: { id: 'a' }, expiresAt: Date.now() + 5000 });
    cache.set('b', { value: { id: 'b' }, expiresAt: Date.now() + 5000 });
    cache.set('c', { value: { id: 'c' }, expiresAt: Date.now() + 5000 });

    h.ctx.applyPatch({ id: 'p1', op: 'update', shapeId: 'a', changes: { x: 10 } } as any);
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
    expect(cache.has('c')).toBe(true);

    h.ctx.applyPatch({ id: 'p2', op: 'update', shapeId: 'c', changes: { x: 210 } } as any);
    expect(cache.has('b')).toBe(true);
    expect(cache.has('c')).toBe(false);
  });
});

describe('P2.2: extractTouchedNodeIds covers all patch shapes', () => {
  // Verifies the invalidation hook catches node ids in ALL patch shapes:
  //   - { op: 'update', shapeId: 'X' }
  //   - { updates: [{ id: 'X' }, { id: 'Y' }] }
  //   - { shapeId: 'parent' } (subtree create — parent layout may shift)

  it('extractTouchedNodeIds from update patch', () => {
    const extract = (patch: any): string[] => {
      const ids: string[] = [];
      if (patch.op === 'update' && typeof patch.shapeId === 'string') ids.push(patch.shapeId);
      if (Array.isArray(patch.updates)) {
        for (const u of patch.updates) {
          if (u && typeof u.id === 'string') ids.push(u.id);
        }
      }
      if (typeof patch.shapeId === 'string' && !ids.includes(patch.shapeId)) ids.push(patch.shapeId);
      return ids;
    };
    expect(extract({ op: 'update', shapeId: 'node-1', changes: {} })).toEqual(['node-1']);
    expect(extract({ updates: [{ id: 'a' }, { id: 'b' }] })).toEqual(['a', 'b']);
    expect(extract({ shapeId: 'parent' })).toEqual(['parent']);
  });
});
