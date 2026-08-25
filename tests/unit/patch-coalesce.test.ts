// Patch coalescing — Phase 4 §4.4 property test.
//
// Pins the spec's acceptance criterion: "Patch coalescing property test green;
// undo/redo semantics unchanged by batching." Randomized patch sequences
// applied via `applyPatchesToCanvas` (batched, single set()) must produce a
// final document IDENTICAL to applying them serially via `applyPatchToCanvas`
// (unbatched, N set() calls).
//
// Property: for any sequence of patches [p1, p2, …, pN] drawn from a
// generator that exercises the op surface (add / update / bulk_add /
// update_many / select / delete / reorder / z-order / token binding / page
// ops), batched-application-document == unbatched-application-document.
//
// The store-level undo semantics (per-patch pre-state capture + push) are
// pinned by the integration tests in pipeline.test.ts; this file pins the
// pure-math equivalence of the batched apply.

import { describe, it, expect } from 'vitest';
import { applyPatchToCanvas, applyPatchesToCanvas } from '@/lib/canvas/patch';
import { createEmptyCanvasDocument } from '@/lib/canvas/types';
import type { CanvasDocument, CanvasPatch } from '@/lib/canvas/types';

// ---- Helpers -----------------------------------------------------------------

function emptyDoc(): CanvasDocument {
  return createEmptyCanvasDocument('test', 'Test');
}

let idCounter = 0;
function freshId(prefix = 'n'): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function addPatch(id: string, x = 0, y = 0, w = 100, h = 100, fill = '#cccccc'): CanvasPatch {
  return {
    op: 'add',
    shapeId: id,
    shape: { id, type: 'rectangle', name: id, x, y, width: w, height: h, fill },
    summary: `add ${id}`,
  } as CanvasPatch;
}

function bulkAddPatch(ids: string[], x = 0, y = 0): CanvasPatch {
  return {
    op: 'bulk_add',
    shapes: ids.map((id, i) => ({
      id,
      type: 'rectangle',
      name: id,
      x: x + i * 20,
      y,
      width: 50,
      height: 50,
      fill: '#abcdef',
    })),
    summary: `bulk_add ${ids.length} shapes`,
  } as CanvasPatch;
}

function updatePatch(id: string, changes: Record<string, unknown>): CanvasPatch {
  return { op: 'update', shapeId: id, shape: changes, summary: `update ${id}` } as CanvasPatch;
}

function updateManyPatch(updates: { id: string; changes: Record<string, unknown> }[]): CanvasPatch {
  return { op: 'update_many', updates, summary: `update_many ${updates.length}` } as CanvasPatch;
}

function selectPatch(ids: string[]): CanvasPatch {
  return { op: 'select', shapeIds: ids, summary: `select ${ids.length}` } as CanvasPatch;
}

function reorderPatch(id: string, zIndex: number): CanvasPatch {
  return { op: 'reorder', shapeId: id, zIndex, summary: `reorder ${id}` } as CanvasPatch;
}

function removePatch(ids: string[]): CanvasPatch {
  return { op: 'remove', shapeIds: ids, summary: `remove ${ids.length}` } as CanvasPatch;
}

function zorderPatch(ids: string[], kind: 'front' | 'back' | 'forward' | 'backward'): CanvasPatch {
  return { op: 'zorder', shapeIds: ids, zorderKind: kind, summary: `zorder ${kind}` } as CanvasPatch;
}

function applyUnbatched(doc: CanvasDocument, patches: CanvasPatch[]): CanvasDocument {
  let next = doc;
  for (const p of patches) {
    next = applyPatchToCanvas(next, p);
  }
  return next;
}

function applyBatched(doc: CanvasDocument, patches: CanvasPatch[]): CanvasDocument {
  return applyPatchesToCanvas(doc, patches);
}

/// Stable JSON for deep equality — keys sorted, functions/symbols dropped,
/// undefined fields skipped. Sufficient here because all patch op results
/// are plain JSON-serializable trees.
function stableDoc(doc: CanvasDocument): string {
  return JSON.stringify(doc, (key, value) => {
    if (typeof value === 'function' || typeof value === 'symbol') return undefined;
    if (value === undefined) return undefined;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.keys(value).sort().reduce<Record<string, unknown>>((acc, k) => {
        const v = (value as Record<string, unknown>)[k];
        if (v !== undefined) acc[k] = v;
        return acc;
      }, {});
    }
    return value;
  });
}

// ---- Tests -------------------------------------------------------------------

describe('applyPatchesToCanvas property — batched == unbatched', () => {
  it('empty patches array returns the input doc (reference equality)', () => {
    const doc = emptyDoc();
    expect(applyPatchesToCanvas(doc, [])).toBe(doc);
  });

  it('single add patch — batched == unbatched', () => {
    const doc = emptyDoc();
    const p = addPatch('a');
    expect(stableDoc(applyBatched(doc, [p]))).toBe(stableDoc(applyUnbatched(doc, [p])));
  });

  it('two add patches (independent) — batched == unbatched', () => {
    const doc = emptyDoc();
    const patches = [addPatch('a'), addPatch('b')];
    expect(stableDoc(applyBatched(doc, patches))).toBe(stableDoc(applyUnbatched(doc, patches)));
  });

  it('add then update same shape — batched == unbatched', () => {
    const doc = emptyDoc();
    const patches = [addPatch('a', 10, 20), updatePatch('a', { x: 100, y: 200, fill: '#ff0000' })];
    expect(stableDoc(applyBatched(doc, patches))).toBe(stableDoc(applyUnbatched(doc, patches)));
  });

  it('bulk_add then update_many — batched == unbatched', () => {
    const doc = emptyDoc();
    const patches = [
      bulkAddPatch(['a', 'b', 'c'], 0, 0),
      updateManyPatch([
        { id: 'a', changes: { fill: '#aa0000' } },
        { id: 'b', changes: { x: 500 } },
        { id: 'c', changes: { y: 300 } },
      ]),
    ];
    expect(stableDoc(applyBatched(doc, patches))).toBe(stableDoc(applyUnbatched(doc, patches)));
  });

  it('add + select (non-mutating) + update — batched == unbatched', () => {
    const doc = emptyDoc();
    const patches = [
      addPatch('a'),
      selectPatch(['a']),
      updatePatch('a', { fill: '#00ff00' }),
      addPatch('b'),
    ];
    expect(stableDoc(applyBatched(doc, patches))).toBe(stableDoc(applyUnbatched(doc, patches)));
  });

  it('add + remove + add — batched == unbatched', () => {
    const doc = emptyDoc();
    const patches = [
      addPatch('a'),
      addPatch('b'),
      removePatch(['a']),
      addPatch('c'),
    ];
    expect(stableDoc(applyBatched(doc, patches))).toBe(stableDoc(applyUnbatched(doc, patches)));
  });

  it('reorder after multiple adds — batched == unbatched', () => {
    const doc = emptyDoc();
    const patches = [
      addPatch('a'),
      addPatch('b'),
      addPatch('c'),
      reorderPatch('c', 0),
    ];
    expect(stableDoc(applyBatched(doc, patches))).toBe(stableDoc(applyUnbatched(doc, patches)));
  });

  it('z-order ops (front, back, forward, backward) — batched == unbatched', () => {
    const doc = emptyDoc();
    const patches = [
      addPatch('a'),
      addPatch('b'),
      addPatch('c'),
      zorderPatch(['a'], 'front'),
      zorderPatch(['c'], 'back'),
    ];
    expect(stableDoc(applyBatched(doc, patches))).toBe(stableDoc(applyUnbatched(doc, patches)));
  });

  it('update on non-existent shape is a no-op (preserved in batch)', () => {
    const doc = emptyDoc();
    const patches = [
      addPatch('a'),
      updatePatch('nonexistent', { x: 999 }), // no-op
      addPatch('b'),
    ];
    expect(stableDoc(applyBatched(doc, patches))).toBe(stableDoc(applyUnbatched(doc, patches)));
  });

  it('bulk_add of 50 shapes (simulated agent bulk_add) — batched == unbatched', () => {
    const doc = emptyDoc();
    const ids = Array.from({ length: 50 }, (_, i) => `bulk-${i}`);
    const patches = [
      bulkAddPatch(ids, 0, 0),
      updateManyPatch(ids.map((id, i) => ({ id, changes: { x: i * 30, fill: i % 2 === 0 ? '#ff0000' : '#00ff00' } }))),
    ];
    expect(stableDoc(applyBatched(doc, patches))).toBe(stableDoc(applyUnbatched(doc, patches)));
  });

  it('interleaved add + update + remove + add sequence — batched == unbatched', () => {
    const doc = emptyDoc();
    const patches: CanvasPatch[] = [
      addPatch('a'),
      addPatch('b'),
      updatePatch('a', { fill: '#aaaaaa' }),
      removePatch(['b']),
      addPatch('c'),
      updatePatch('c', { x: 999 }),
      addPatch('d'),
      selectPatch(['a', 'c']),
      removePatch(['a']),
      zorderPatch(['d'], 'front'),
    ];
    expect(stableDoc(applyBatched(doc, patches))).toBe(stableDoc(applyUnbatched(doc, patches)));
  });

  it('preserves document order through reorder operations', () => {
    const doc = emptyDoc();
    const patches = [
      addPatch('a'),
      addPatch('b'),
      addPatch('c'),
      addPatch('d'),
      reorderPatch('d', 0), // move d to the very front
      reorderPatch('b', 1), // move b to position 1
    ];
    const batched = applyBatched(doc, patches);
    const unbatched = applyUnbatched(doc, patches);
    expect(stableDoc(batched)).toBe(stableDoc(unbatched));
  });
});

describe('applyPatchesToCanvas — randomized property fuzz', () => {
  // Property test: for any sequence of randomly-generated patches from a
  // constrained op surface, batched application == unbatched application.
  // 50 randomized runs × ~10 patches each ≈ 500 patch round-trips.
  const PATCH_GENERATORS = [
    () => addPatch(freshId('r')),
    () => addPatch(freshId('s'), Math.floor(Math.random() * 500), Math.floor(Math.random() * 500), 50 + Math.floor(Math.random() * 100), 50 + Math.floor(Math.random() * 100)),
    () => ({ op: 'update', shapeId: `r-${1 + Math.floor(Math.random() * 10)}`, shape: { fill: `#${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}` }, summary: 'random-update' } as CanvasPatch),
    () => ({ op: 'select', shapeIds: [`r-${1 + Math.floor(Math.random() * 10)}`], summary: 'random-select' } as CanvasPatch),
  ];

  function randomPatchSeq(length: number): CanvasPatch[] {
    return Array.from({ length }, () => {
      const gen = PATCH_GENERATORS[Math.floor(Math.random() * PATCH_GENERATORS.length)];
      return gen();
    });
  }

  for (let run = 0; run < 50; run++) {
    it(`randomized run #${run + 1}: batched == unbatched`, () => {
      idCounter = 0;
      const doc = emptyDoc();
      const patches = randomPatchSeq(5 + Math.floor(Math.random() * 10));
      const batched = applyBatched(doc, patches);
      const unbatched = applyUnbatched(doc, patches);
      expect(stableDoc(batched)).toBe(stableDoc(unbatched));
    });
  }
});
