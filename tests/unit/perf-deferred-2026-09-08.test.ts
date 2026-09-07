// Tests for the four deferred perf items (2026-09-08, from the 12-b/12-d
// reports — "Remaining known-LOW items deliberately deferred"):
//
//   1. canvas:full burst coalescing (12-b #8)  — flapping reconnects
//   2. culling memoization (12-d #9)           — 100k+ root canvases
//   3. key-repeat rAF coalescing (12-d #12)    — held ⌘Z / arrow keys
//   4. snapshot pool derived-shape stripping (12-d #14)
//
// 1 and 4 drive the real store; 3 unit-tests the extracted coalescer with an
// injected frame scheduler; 2 pins the wiring with source scans (DomCanvas is
// render-heavy — the memoization semantics are structural, not behavioral).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useCanvasStore, __setFullSyncCoalescerForTests, __resetFullSyncCoalescerForTests } from '@/lib/canvas/store';
import { useSessionStore } from '@/lib/sessions';
import { stripDerivedForSnapshot, rehydrateSnapshot } from '@/lib/canvas/version-history';
import { createKeyRepeatCoalescer } from '@/lib/canvas/key-repeat-coalescer';
import type { CanvasDocument, Shape, SyncEvent } from '@/lib/canvas/types';
import type { PenChild } from '@/lib/pen/types';

// ---- Fixtures (mirror canvas-full-merge.test.ts / store.test.ts) ------------

function makeDoc(shapes: Shape[] = []): CanvasDocument {
  return {
    id: 'demo',
    name: 'Doc',
    background: '#ffffff',
    version: '2.17',
    children: shapes as unknown as PenChild[],
    viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes,
    tokens: { colors: [], textStyles: [] },
  };
}

function makeShape(
  id: string,
  fill = '#cccccc',
  version?: number,
  versionNonce?: number,
): Shape {
  return {
    id,
    type: 'rectangle',
    name: id,
    x: 0, y: 0, width: 100, height: 100,
    rotation: 0, opacity: 1,
    fill, stroke: '#000', strokeWidth: 0,
    radius: 0, fontSize: 16, textColor: '#000',
    parentId: null, zIndex: 0,
    locked: false, visible: true,
    autoLayout: null, tokenBinding: null, componentId: null,
    points: null, closed: false, src: null, radii: null,
    gradient: null, shadow: null, blur: 0, maskId: null,
    constraints: null,
    ...(version !== undefined ? { version } : {}),
    ...(versionNonce !== undefined ? { versionNonce } : {}),
  } as Shape;
}

function resetStore(doc: CanvasDocument = makeDoc([])) {
  useCanvasStore.setState({
    document: doc,
    selectedIds: [],
    agentHighlightIds: [],
    socket: null,
    connected: false,
    viewerCount: 1,
    remotePresence: {},
    turns: [],
    agentBusy: false,
    documentId: 'demo',
    activeSessionId: null,
    undoStack: [],
    redoStack: [],
    guideLines: [],
    guideUndoStack: [],
    guideRedoStack: [],
    checkpoints: [],
    lastCheckpointSignature: null,
    turnCounter: 0,
  });
  useSessionStore.setState({
    sessions: {},
    runs: {},
    messages: {},
    toolCalls: {},
    snapshots: {},
    activeSessionByDoc: {},
  });
}

function node(doc: CanvasDocument, id: string) {
  return (doc.children as unknown as Array<{ id: string; fill?: string }>).find((c) => c.id === id);
}

function dispatchFull(document: CanvasDocument, reason?: 'sync' | 'restore', immediate?: boolean) {
  const event: SyncEvent = { type: 'canvas:full', document, ...(reason ? { reason } : {}) };
  useCanvasStore.getState()._onSync(event, immediate ? { immediate: true } : undefined);
}

function src(rel: string): string {
  return readFileSync(join(process.cwd(), rel), 'utf8');
}

// ---- 1. canvas:full burst coalescing (12-b #8) ------------------------------

describe('canvas:full burst coalescing (12-b #8)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetFullSyncCoalescerForTests();
    resetStore();
  });
  afterEach(() => {
    __resetFullSyncCoalescerForTests();
    vi.useRealTimers();
  });

  it('the first full outside a burst window applies synchronously', () => {
    __setFullSyncCoalescerForTests(true);
    resetStore(makeDoc([makeShape('local', '#local', 2, 5)]));
    dispatchFull(makeDoc([makeShape('srv-1', '#s1', 3, 7)]));
    // No timer advance — the merge landed immediately.
    expect(node(useCanvasStore.getState().document, 'srv-1')).toBeDefined();
    expect(node(useCanvasStore.getState().document, 'local')).toBeDefined();
  });

  it('fulls inside the burst window defer to the trailing edge, LATEST wins (superseded dropped)', () => {
    __setFullSyncCoalescerForTests(true);
    resetStore(makeDoc([makeShape('local', '#local', 2, 5)]));
    dispatchFull(makeDoc([makeShape('srv-1', '#s1', 3, 7)])); // applies now
    // Burst: two further fulls within 120ms of the apply.
    dispatchFull(makeDoc([makeShape('srv-2', '#s2', 4, 9)]));
    dispatchFull(makeDoc([makeShape('srv-3', '#s3', 5, 11)]));
    // Not applied yet — the window is still open.
    expect(node(useCanvasStore.getState().document, 'srv-2')).toBeUndefined();
    expect(node(useCanvasStore.getState().document, 'srv-3')).toBeUndefined();
    // Trailing edge: ONLY the latest pending full applies.
    vi.advanceTimersByTime(120);
    expect(node(useCanvasStore.getState().document, 'srv-2')).toBeUndefined(); // superseded
    expect(node(useCanvasStore.getState().document, 'srv-3')).toBeDefined(); // latest
    expect(node(useCanvasStore.getState().document, 'local')).toBeDefined(); // merge kept local
  });

  it('restore-reason fulls bypass the coalescer (authoritative swap lands immediately)', () => {
    __setFullSyncCoalescerForTests(true);
    resetStore(makeDoc([makeShape('local', '#local', 2, 5)]));
    dispatchFull(makeDoc([makeShape('srv-1', '#s1', 3, 7)])); // applies, opens the window
    // A restore lands INSIDE the window — must not defer.
    dispatchFull(makeDoc([makeShape('restored', '#r')]), 'restore');
    expect(node(useCanvasStore.getState().document, 'restored')).toBeDefined();
    // Wholesale replace semantics preserved (deletions land).
    expect(node(useCanvasStore.getState().document, 'local')).toBeUndefined();
  });

  it('NODE_ENV=test keeps the pre-coalescer synchronous semantics unless a test opts in', () => {
    // Default (disabled): two fulls back-to-back both apply synchronously —
    // the contract every pre-existing suite depends on.
    resetStore(makeDoc([makeShape('local', '#local', 2, 5)]));
    dispatchFull(makeDoc([makeShape('x', '#x', 3, 7)]));
    dispatchFull(makeDoc([makeShape('y', '#y', 4, 9)]));
    expect(node(useCanvasStore.getState().document, 'x')).toBeDefined();
    expect(node(useCanvasStore.getState().document, 'y')).toBeDefined();
  });

  it('immediate dispatch bypasses the coalescer (the trailing apply path)', () => {
    __setFullSyncCoalescerForTests(true);
    resetStore(makeDoc([makeShape('local', '#local', 2, 5)]));
    dispatchFull(makeDoc([makeShape('srv-1', '#s1', 3, 7)])); // opens window
    dispatchFull(makeDoc([makeShape('imm', '#i', 6, 13)]), undefined, true);
    expect(node(useCanvasStore.getState().document, 'imm')).toBeDefined();
  });

  it('wiring: the fire callback drops fulls from a superseded init generation, and init resets the pending slot', () => {
    const store = src('src/lib/canvas/store.ts');
    // Generation guard at fire time (a full for the OLD document's room must
    // never apply to the new one).
    expect(store).toContain('if (pending.generation !== initGeneration) return;');
    // init() resets the pending slot + cancels the timer on generation bump.
    expect(store).toMatch(/const generation = \+\+initGeneration;[\s\S]{0,400}fullSyncPending = null;/);
    // The case body consults the coalescer only for non-restore fulls.
    expect(store).toContain("if (event.reason !== 'restore' && opts?.immediate !== true && shouldDeferFullSync(event))");
  });
});

// ---- 3. key-repeat coalescing (12-d #12) ------------------------------------

describe('key-repeat coalescer (12-d #12)', () => {
  /// Manual frame scheduler: captures the drain callback so tests decide
  /// when frames elapse without fake timers.
  function makeManualScheduler() {
    const drains: Array<() => void> = [];
    const schedule = (fn: () => void): number | null => {
      drains.push(fn);
      return drains.length; // token
    };
    const cancel = (token: number): void => {
      drains[token - 1] = () => {};
    };
    const flushFrame = (): void => {
      const next = drains.shift();
      if (next) next();
    };
    return { schedule, cancel, flushFrame };
  }

  it('nudge keydowns within one frame accumulate into ONE applyNudge with the total delta', () => {
    const sched = makeManualScheduler();
    const nudges: Array<[number, number]> = [];
    const c = createKeyRepeatCoalescer({
      applyHistory: () => { throw new Error('no history ops expected'); },
      applyNudge: (dx, dy) => nudges.push([dx, dy]),
      schedule: sched.schedule,
      cancel: sched.cancel,
    });
    // 3 ArrowRight + 1 ArrowDown + 1 ArrowLeft within the frame → net (2, 1).
    c.queueNudge(1, 0);
    c.queueNudge(1, 0);
    c.queueNudge(1, 0);
    c.queueNudge(0, 1);
    c.queueNudge(-1, 0);
    expect(nudges).toHaveLength(0); // nothing before the frame elapses
    sched.flushFrame();
    expect(nudges).toEqual([[2, 1]]); // ONE call, accumulated total
  });

  it('undo keydowns are COUNTED — at most one undo per frame, but every keydown eventually applies', () => {
    const sched = makeManualScheduler();
    const ops: string[] = [];
    const c = createKeyRepeatCoalescer({
      applyHistory: (op) => ops.push(op),
      applyNudge: () => {},
      schedule: sched.schedule,
      cancel: sched.cancel,
    });
    // ⌘Z held: 3 OS key-repeats land inside one frame.
    c.queueUndo();
    c.queueUndo();
    c.queueUndo();
    sched.flushFrame(); // frame 1
    expect(ops).toEqual(['undo']); // ONE per frame
    sched.flushFrame(); // frame 2 (leftovers re-armed the drain)
    expect(ops).toEqual(['undo', 'undo']);
    sched.flushFrame(); // frame 3
    expect(ops).toEqual(['undo', 'undo', 'undo']);
    // All intent preserved — exactly one undo per keydown, none dropped.
    sched.flushFrame();
    expect(ops).toHaveLength(3);
  });

  it('undo and redo in the same frame: undo drains first (user cannot hold both)', () => {
    const sched = makeManualScheduler();
    const ops: string[] = [];
    const c = createKeyRepeatCoalescer({
      applyHistory: (op) => ops.push(op),
      applyNudge: () => {},
      schedule: sched.schedule,
      cancel: sched.cancel,
    });
    c.queueUndo();
    c.queueRedo();
    sched.flushFrame();
    expect(ops).toEqual(['undo']);
    sched.flushFrame();
    expect(ops).toEqual(['undo', 'redo']);
  });

  it('a history op and a nudge in the same frame both apply in ONE drain', () => {
    const sched = makeManualScheduler();
    const ops: string[] = [];
    const nudges: Array<[number, number]> = [];
    const c = createKeyRepeatCoalescer({
      applyHistory: (op) => ops.push(op),
      applyNudge: (dx, dy) => nudges.push([dx, dy]),
      schedule: sched.schedule,
      cancel: sched.cancel,
    });
    c.queueUndo();
    c.queueNudge(10, 0);
    sched.flushFrame();
    expect(ops).toEqual(['undo']);
    expect(nudges).toEqual([[10, 0]]);
  });

  it('dispose flushes pending work synchronously and cancels the scheduled frame', () => {
    const sched = makeManualScheduler();
    let canceled: number | null = null;
    const ops: string[] = [];
    const nudges: Array<[number, number]> = [];
    const c = createKeyRepeatCoalescer({
      applyHistory: (op) => ops.push(op),
      applyNudge: (dx, dy) => nudges.push([dx, dy]),
      schedule: sched.schedule,
      cancel: (t) => { canceled = t; },
    });
    c.queueNudge(1, 1);
    c.dispose(); // listener torn down mid-frame — nothing may be stranded
    expect(nudges).toEqual([[1, 1]]);
    // The drain consumed the frame token synchronously; even if the host
    // still fires the queued callback, it must be a no-op.
    sched.flushFrame();
    expect(nudges).toHaveLength(1);
  });

  it('dispose with nothing pending leaves the scheduler alone (pure teardown)', () => {
    const sched = makeManualScheduler();
    let canceled = 0;
    const ops: string[] = [];
    const c = createKeyRepeatCoalescer({
      applyHistory: (op) => ops.push(op),
      applyNudge: () => {},
      schedule: sched.schedule,
      cancel: () => { canceled += 1; },
    });
    c.dispose();
    expect(ops).toHaveLength(0);
    expect(canceled).toBe(0); // nothing was scheduled, nothing to cancel
  });

  it('wiring: page.tsx routes ⌘Z/⇧Z and arrows through the coalescer with Map lookups at drain time', () => {
    const page = src('src/app/page.tsx');
    expect(page).toContain('keyRepeatCoalescer.queueUndo()');
    expect(page).toContain('keyRepeatCoalescer.queueRedo()');
    expect(page).toContain('keyRepeatCoalescer.queueNudge(dx, dy)');
    // Effect teardown flushes pending work (mid-frame panel toggle).
    expect(page).toContain('keyRepeatCoalescer.dispose()');
    // The nudge flush builds ONE Map and resolves parent offsets from it
    // (was: findShape per id, twice, per keypress).
    expect(page).toContain('new Map(st.document.shapes.map((s) => [s.id, s] as const))');
    // ONE update_many per drain, not per keypress.
    expect(page).toMatch(/applyNudge[\s\S]{0,1400}sendPatch\(\{ op: 'update_many'/);
  });
});

// ---- 4. snapshot pool derived-shape stripping (12-d #14) --------------------

describe('snapshot pool derived-shape stripping (12-d #14)', () => {
  it('stripDerivedForSnapshot drops only the caches; the source tree is structurally shared', () => {
    const doc = makeDoc([makeShape('a'), makeShape('b')]);
    const stripped = stripDerivedForSnapshot(doc);
    expect(stripped).not.toBe(doc);
    expect(stripped.children).toBe(doc.children); // shared (immutable) tree
    expect(stripped.variables).toBe(doc.variables);
    expect(stripped.viewport).toBe(doc.viewport);
    expect(stripped.shapes).toHaveLength(0);
    expect(stripped.tokens.colors).toHaveLength(0);
    // The live document keeps its caches.
    expect(doc.shapes).toHaveLength(2);
  });

  it('all stripped snapshots share ONE frozen empty pair (zero marginal memory per snapshot)', () => {
    const a = stripDerivedForSnapshot(makeDoc([makeShape('a')]));
    const b = stripDerivedForSnapshot(makeDoc([makeShape('b')]));
    expect(a.shapes).toBe(b.shapes);
    expect(a.tokens).toBe(b.tokens);
    // Frozen — an accidental in-place mutation fails loudly.
    expect(() => (a.shapes as unknown as Array<unknown>).push(1)).toThrow();
  });

  it('rehydrateSnapshot recomputes the caches from the tree (with measuredBounds hints)', () => {
    const live = makeDoc([makeShape('a'), makeShape('b')]);
    const stripped = stripDerivedForSnapshot(live);
    const bounds = { a: { width: 42, height: 24 } };
    const rehydrated = rehydrateSnapshot(stripped, bounds);
    expect(rehydrated.children).toBe(stripped.children); // tree untouched
    expect(rehydrated.shapes.map((s) => s.id).sort()).toEqual(['a', 'b']);
    // A document that still carries caches is passed through unchanged.
    expect(rehydrateSnapshot(live)).toBe(live);
  });

  it('capture → promote round trip: undo/redo/restore content survives the strip cycle', () => {
    const docA = makeDoc([makeShape('a', '#ff0000')]);
    resetStore(docA);
    useCanvasStore.getState().addCheckpoint('Target', false);
    const targetId = useCanvasStore.getState().checkpoints[0].id;
    // Mutate past the checkpoint.
    useCanvasStore.getState()._onSync({
      type: 'canvas:patch',
      patch: { op: 'update', shapeId: 'a', shape: { fill: '#00ff00' } } as never,
    });
    // Restore → the stripped snapshot promotes with rehydrated caches.
    expect(useCanvasStore.getState().restoreCheckpoint(targetId)).toBe(true);
    expect(useCanvasStore.getState().document.shapes[0]?.fill).toBe('#ff0000');
    // Undo → the stripped pre-restore entry promotes too.
    useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().document.shapes[0]?.fill).toBe('#00ff00');
    // Redo → back to the restored state.
    useCanvasStore.getState().redo();
    expect(useCanvasStore.getState().document.shapes[0]?.fill).toBe('#ff0000');
  });

  it('the checkpoint row carries shapeCount (the dialog layer count survives stripping)', () => {
    resetStore(makeDoc([makeShape('a'), makeShape('b'), makeShape('c')]));
    useCanvasStore.getState().addCheckpoint('Three', false);
    const cp = useCanvasStore.getState().checkpoints[0];
    expect(cp.shapeCount).toBe(3);
    expect(cp.document.shapes).toHaveLength(0);
  });
});

// ---- 2. culling memoization (12-d #9) — wiring pins --------------------------

describe('culling memoization wiring (12-d #9)', () => {
  it('rootLayerRects is memoized on the roots identity, not recomputed per pan/zoom event', () => {
    const dom = src('src/components/canvas/dom/DomCanvas.tsx');
    expect(dom).toContain('const rootRects = useMemo(() => rootLayerRects(roots), [roots]);');
    // The immune set is memoized on selection/hover identities.
    expect(dom).toMatch(/const immuneIds = useMemo\(\(\) => \{[\s\S]{0,220}new Set<string>\(selectedIds\)/);
    // The O(roots) filter moved INSIDE the rAF-throttled run.
    expect(dom).toContain('const filterableRects = rootRects.filter((r) => !immuneIds.has(r.id));');
    // The effect deps ride the memoized identities (no per-event rebuilds).
    expect(dom).toContain('[l4Culling, panX, panY, zoom, rootRects, layers.length, immuneIds]');
  });
});
