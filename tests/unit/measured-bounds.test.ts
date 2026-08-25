// Measured-bounds readback (spec §3.8, Phase 2) unit tests.
//
// Covers the two halves of the readback pipeline:
//   1. The canvas store's `measuredBounds` runtime slice:
//      - set/merge semantics (single + batched)
//      - EPHEMERAL: not part of undo snapshots (undo restores document only)
//      - never recomputes `document` (no layout feedback loop)
//      - not persisted (the canvas store has no persist middleware —
//        source-level guard, following the agentHighlightIds pattern)
//   2. The MeasuredBoundsPool (dom/measure.ts):
//      - no-ops safely where ResizeObserver is undefined (bare jsdom)
//      - rAF-coalesced flush rounds sizes and calls onMeasure per id
//      - last-write-wins within one frame
//      - unobserve / disconnect tear down cleanly
//      - FIFO eviction at the 4000-id cap (warns once in dev)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useCanvasStore } from '@/lib/canvas/store';
import { MeasuredBoundsPool } from '@/components/canvas/dom/measure';
import { createEmptyCanvasDocument } from '@/lib/canvas/types';
import type { CanvasPatch, CanvasDocument } from '@/lib/canvas/types';

// ---- Store slice ----------------------------------------------------------------

function resetStore(doc?: CanvasDocument) {
  useCanvasStore.setState({
    document: doc ?? createEmptyCanvasDocument('test-doc', 'Test'),
    selectedIds: [],
    agentHighlightIds: [],
    socket: null,
    connected: false,
    viewerCount: 1,
    turns: [],
    agentBusy: false,
    documentId: 'test-doc',
    activeSessionId: null,
    undoStack: [],
    redoStack: [],
    measuredBounds: {},
  });
}

describe('measuredBounds store slice — runtime (ephemeral) state', () => {
  beforeEach(() => resetStore());

  it('setMeasuredBounds merges one entry without touching other ids', () => {
    useCanvasStore.getState().setMeasuredBounds('a', { width: 10, height: 20 });
    useCanvasStore.getState().setMeasuredBounds('b', { width: 30, height: 40 });
    useCanvasStore.getState().setMeasuredBounds('a', { width: 11, height: 21 }); // overwrite
    const mb = useCanvasStore.getState().measuredBounds;
    expect(mb).toEqual({
      a: { width: 11, height: 21 },
      b: { width: 30, height: 40 },
    });
  });

  it('setMeasuredBoundsMany merges batched entries (record + array forms)', () => {
    useCanvasStore.getState().setMeasuredBounds('seed', { width: 1, height: 1 });
    useCanvasStore.getState().setMeasuredBoundsMany({ x: { width: 5, height: 6 }, y: { width: 7, height: 8 } });
    useCanvasStore.getState().setMeasuredBoundsMany([['z', { width: 9, height: 9 }]] as Array<[string, { width: number; height: number }]>);
    const mb = useCanvasStore.getState().measuredBounds;
    expect(mb.seed).toEqual({ width: 1, height: 1 }); // untouched seed survives
    expect(mb.x).toEqual({ width: 5, height: 6 });
    expect(mb.y).toEqual({ width: 7, height: 8 });
    expect(mb.z).toEqual({ width: 9, height: 9 });
  });

  it('is NOT part of undo history — undo restores document, not measurements', () => {
    // Mutate (pushes document onto the undo stack)…
    const patch: CanvasPatch = {
      op: 'add',
      shape: { type: 'rectangle', name: 'R', x: 0, y: 0, width: 10, height: 10, id: 'r1' },
      summary: 'add',
    };
    useCanvasStore.getState().sendPatch(patch);
    expect(useCanvasStore.getState().undoStack).toHaveLength(1);
    const docWithShape = useCanvasStore.getState().document;
    expect(docWithShape.children.length).toBe(1);

    // …measure (ephemeral)…
    useCanvasStore.getState().setMeasuredBounds('r1', { width: 42, height: 24 });

    // …undo: document reverts, measurements survive (they describe the live
    // DOM, which is downstream of the model — never snapshotted).
    useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().document.children.length).toBe(0);
    expect(useCanvasStore.getState().document).not.toBe(docWithShape);
    expect(useCanvasStore.getState().measuredBounds.r1).toEqual({ width: 42, height: 24 });
  });

  it('writing measurements NEVER recomputes `document` (no feedback loop)', () => {
    const docBefore = useCanvasStore.getState().document;
    const shapesBefore = docBefore.shapes;
    useCanvasStore.getState().setMeasuredBounds('any', { width: 1, height: 2 });
    useCanvasStore.getState().setMeasuredBoundsMany({ other: { width: 3, height: 4 } });
    const state = useCanvasStore.getState();
    expect(state.document).toBe(docBefore); // same reference — untouched
    expect(state.document.shapes).toBe(shapesBefore);
  });

  it('is not persisted — the canvas store has no persist middleware (source guard)', () => {
    // Follows the agentHighlightIds pattern: plain runtime state, no persist.
    // Guard at the source level (like tests/unit/zoom-clamp.test.ts): the
    // canvas store must not import zustand/middleware (persist requires it).
    const src = readFileSync(join(process.cwd(), 'src/lib/canvas/store.ts'), 'utf8');
    expect(src).not.toMatch(/from ['"]zustand\/middleware['"]/);
    // And the state field defaults to an empty object.
    expect(useCanvasStore.getState().measuredBounds).toEqual({});
  });
});

// ---- MeasuredBoundsPool -----------------------------------------------------------

/// A capturing ResizeObserver mock: records instances + their callbacks so
/// tests can fire synthetic entries, and tracks observe/unobserve calls.
class MockRO {
  static instances: MockRO[] = [];
  static observeCalls: Array<{ el: Element; ro: MockRO }> = [];
  static unobserveCalls: Array<{ el: Element; ro: MockRO }> = [];
  callback: (entries: ResizeObserverEntry[]) => void;
  constructor(cb: (entries: ResizeObserverEntry[]) => void) {
    this.callback = cb;
    MockRO.instances.push(this);
  }
  observe(el: Element) {
    MockRO.observeCalls.push({ el, ro: this });
  }
  unobserve(el: Element) {
    MockRO.unobserveCalls.push({ el, ro: this });
  }
  disconnect() {}
}

function entry(el: Element, width: number, height: number): ResizeObserverEntry {
  return { target: el, contentRect: { width, height } } as unknown as ResizeObserverEntry;
}

function flushAsync(): Promise<void> {
  // One macrotask — enough for rAF (pretendToBeVisual jsdom) or the
  // setTimeout(0) fallback to run the pool's coalesced flush.
  return new Promise((resolve) => setTimeout(resolve, 20));
}

describe('MeasuredBoundsPool', () => {
  const realRO = globalThis.ResizeObserver;

  afterEach(() => {
    // Restore whatever the environment had (the setup.ts no-op polyfill).
    globalThis.ResizeObserver = realRO;
    vi.restoreAllMocks();
    MockRO.instances = [];
    MockRO.observeCalls = [];
    MockRO.unobserveCalls = [];
  });

  it('no-ops safely where ResizeObserver is undefined (bare jsdom)', async () => {
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    const onMeasure = vi.fn();
    const pool = new MeasuredBoundsPool(onMeasure);
    const el = document.createElement('div');
    expect(() => pool.observe(el, 'n1')).not.toThrow();
    expect(pool.size).toBe(1); // registered, but nothing observes/fires
    expect(() => pool.unobserve('n1')).not.toThrow();
    expect(pool.size).toBe(0);
    expect(() => pool.disconnect()).not.toThrow();
    expect(onMeasure).not.toHaveBeenCalled();
  });

  it('flushes rAF-coalesced entries — sizes rounded, one onMeasure per id', async () => {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = MockRO;
    const onMeasure = vi.fn();
    const pool = new MeasuredBoundsPool(onMeasure);
    const a = document.createElement('div');
    const b = document.createElement('div');
    pool.observe(a, 'a');
    pool.observe(b, 'b');
    expect(MockRO.instances).toHaveLength(1); // ONE shared observer

    const ro = MockRO.instances[0];
    ro.callback([entry(a, 100.4, 50.6), entry(b, 33.2, 11.9)]);
    await flushAsync();
    expect(onMeasure).toHaveBeenCalledTimes(2);
    expect(onMeasure).toHaveBeenCalledWith('a', { width: 100, height: 51 }); // Math.round
    expect(onMeasure).toHaveBeenCalledWith('b', { width: 33, height: 12 });
    pool.disconnect();
  });

  it('last write wins within one frame (coalesced)', async () => {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = MockRO;
    const onMeasure = vi.fn();
    const pool = new MeasuredBoundsPool(onMeasure);
    const a = document.createElement('div');
    pool.observe(a, 'a');
    const ro = MockRO.instances[0];
    ro.callback([entry(a, 10, 10)]);
    ro.callback([entry(a, 20, 20)]); // same frame — supersedes
    await flushAsync();
    expect(onMeasure).toHaveBeenCalledTimes(1);
    expect(onMeasure).toHaveBeenCalledWith('a', { width: 20, height: 20 });
    pool.disconnect();
  });

  it('unobserve removes the element and cancels pending entries', async () => {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = MockRO;
    const onMeasure = vi.fn();
    const pool = new MeasuredBoundsPool(onMeasure);
    const a = document.createElement('div');
    pool.observe(a, 'a');
    const ro = MockRO.instances[0];
    ro.callback([entry(a, 10, 10)]);
    pool.unobserve('a');
    await flushAsync();
    expect(onMeasure).not.toHaveBeenCalled();
    expect(pool.size).toBe(0);
    pool.disconnect();
  });

  it('re-observing an id with a new element un-observes the old one first', () => {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = MockRO;
    const pool = new MeasuredBoundsPool(vi.fn());
    const el1 = document.createElement('div');
    const el2 = document.createElement('div');
    pool.observe(el1, 'n');
    pool.observe(el2, 'n'); // React ref churn — same id, new element
    expect(pool.size).toBe(1);
    expect(MockRO.unobserveCalls).toHaveLength(1);
    expect(MockRO.unobserveCalls[0].el).toBe(el1);
    pool.disconnect();
  });

  it('evicts FIFO at the 4000-id cap (warns once in dev)', () => {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = MockRO;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pool = new MeasuredBoundsPool(vi.fn());
    const first = document.createElement('div');
    pool.observe(first, 'first');
    const els = Array.from({ length: 4000 }, (_, i) => {
      const el = document.createElement('div');
      pool.observe(el, `id-${i}`);
      return el;
    });
    // The cap held: 'first' was evicted (FIFO), the last 4000 remain.
    expect(pool.size).toBe(4000);
    expect(MockRO.unobserveCalls.some((c) => c.el === first)).toBe(true);
    expect(MockRO.observeCalls[MockRO.observeCalls.length - 1].el).toBe(els[3999]);
    expect(warn).toHaveBeenCalledTimes(1); // logs once, not per eviction
    pool.disconnect();
  });

  it('disconnect clears everything', () => {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = MockRO;
    const pool = new MeasuredBoundsPool(vi.fn());
    pool.observe(document.createElement('div'), 'a');
    pool.observe(document.createElement('div'), 'b');
    expect(pool.size).toBe(2);
    pool.disconnect();
    expect(pool.size).toBe(0);
  });
});
