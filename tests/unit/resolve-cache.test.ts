// Tests for the incremental resolve caches (Phase C, R9c — tldraw
// structural-sharing / createComputedCache pattern).
//
// resolvePenTreeDetailed runs on EVERY document mutation (recomputeDerived at
// the tail of every applyPatchToCanvas, DomCanvas's native-mode useMemo,
// canvasSnapshot per agent turn, the journal fold per row). The R9c caches
// make unchanged subtrees reuse their previous EMIT result — same Shape
// objects, same ResolvedTreeNodes, same pen references — which is what lets
// the DomNode React.memo finally hit and stops the whole world tree from
// re-rendering (and instance-descendant UUIDs from regenerating) on every
// patch.
//
// Contract under test:
//   - identical input ⇒ identical output OBJECTS (not just values);
//   - a patch to one subtree re-emits exactly that path (node + ancestors),
//     while sibling subtrees reuse their previous objects;
//   - measured-bounds hints invalidate only the measured node's path — the
//     sibling subtree still reuses;
//   - a variables CONTENT change invalidates (the stamp is content-based,
//     because applyPatchToCanvas shallow-copies `variables` per patch);
//   - emit-time warnings are replayed on cache hits (degradation stays
//     agent-visible);
//   - ref instances keep stable descendant ids across resolves (pre-R9c each
//     resolve deep-cloned the component and minted fresh UUIDs);
//   - the stats counters move.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolvePenTreeDetailed,
  resolveCacheStats,
  __clearResolveCachesForTests,
} from '@/lib/pen/resolve';
import { applyPatchToCanvas } from '@/lib/canvas/patch';
import { createEmptyCanvasDocument } from '@/lib/canvas/types';
import type { CanvasDocument } from '@/lib/canvas/types';
import type { PenChild, PenComponent, PenFrame, PenRef, PenText } from '@/lib/pen/types';

function buildDoc(): CanvasDocument {
  const doc = createEmptyCanvasDocument('r9c-doc');
  const leafL: PenText = { id: 'leaf-l', type: 'text', x: 0, y: 0, width: 80, height: 20, content: 'Left' };
  // Explicit fit_content sizing: the measured-bounds hint replaces the
  // placeholder fallback (text estimates bypass the hint — spec §3.8), which
  // the scoping test depends on.
  const leafR: PenText = { id: 'leaf-r', type: 'text', x: 0, y: 0, width: 'fit_content', height: 'fit_content', content: 'Right' };
  const frameL: PenFrame = { id: 'frame-l', type: 'frame', name: 'L', x: 0, y: 0, width: 200, height: 200, children: [leafL] };
  const frameR: PenFrame = { id: 'frame-r', type: 'frame', name: 'R', x: 300, y: 0, width: 200, height: 200, children: [leafR] };
  return { ...doc, children: [frameL, frameR] };
}

function buildRefDoc(): CanvasDocument {
  const doc = createEmptyCanvasDocument('r9c-ref');
  const label: PenText = { id: 'btn-label', type: 'text', x: 0, y: 0, width: 60, height: 16, content: 'Click' };
  const master: PenComponent = {
    id: 'btn-master', type: 'component', reusable: true,
    x: 0, y: 0, width: 120, height: 40, fill: '#0ea5e9', children: [label],
  };
  const instance: PenRef = { id: 'btn-inst', type: 'ref', ref: 'btn-master', x: 200, y: 100 };
  return { ...doc, children: [master, instance] };
}

function collectTreeIds(nodes: Array<{ layer: { id: string }; children: unknown }>): string[] {
  const out: string[] = [];
  const walk = (ns: Array<{ layer: { id: string }; children: unknown }>) => {
    for (const n of ns) {
      out.push(n.layer.id);
      if (Array.isArray(n.children)) walk(n.children as Array<{ layer: { id: string }; children: unknown }>);
    }
  };
  walk(nodes);
  return out;
}

beforeEach(() => {
  __clearResolveCachesForTests();
});

describe('resolve R9c emit cache — identity reuse', () => {
  it('an identical second resolve returns the SAME Shape and tree-node objects', () => {
    const doc = buildDoc();
    const a = resolvePenTreeDetailed(doc);
    const b = resolvePenTreeDetailed(doc);

    expect(b.layers.map((s) => s.id)).toEqual(a.layers.map((s) => s.id));
    a.layers.forEach((s, i) => expect(b.layers[i]).toBe(s)); // identity, not equality
    a.tree.forEach((tn, i) => expect(b.tree[i]).toBe(tn));
    expect(b.tree[0].children[0]).toBe(a.tree[0].children[0]);
    // pen references are the SOURCE nodes (identity-preserving expansion).
    expect(b.tree[0].pen).toBe(a.tree[0].pen);
  });

  it('bumps the hit counter on the second resolve (miss then hit)', () => {
    const doc = buildDoc();
    resolvePenTreeDetailed(doc);
    const misses = resolveCacheStats.emitMisses;
    const hits = resolveCacheStats.emitHits;
    resolvePenTreeDetailed(doc);
    expect(resolveCacheStats.emitHits).toBeGreaterThan(hits);
    expect(resolveCacheStats.emitMisses).toBe(misses); // no new misses
  });

  it('emits equal VALUES with new objects when variables CONTENT changes (stamp is content-based)', () => {
    const doc = buildDoc();
    doc.variables = { 'color.x': { type: 'color', value: '#111111' } };
    const a = resolvePenTreeDetailed(doc);
    doc.variables = { 'color.x': { type: 'color', value: '#222222' } };
    const b = resolvePenTreeDetailed(doc);
    // Different variables object (patch.ts shallow-copies per patch) with
    // different content → stamp differs → re-emit (new object, same value
    // for literal-fill nodes).
    expect(b.layers[0]).not.toBe(a.layers[0]);
    expect(b.layers[0]).toEqual(a.layers[0]);

    // Same variables OBJECT identity again → back to identity reuse.
    const c = resolvePenTreeDetailed(doc);
    expect(c.layers[0]).toBe(b.layers[0]);
  });
});

describe('resolve R9c emit cache — invalidation scoping', () => {
  it('a patch to one subtree re-emits that path; the sibling subtree reuses objects', () => {
    const doc = buildDoc();
    const before = resolvePenTreeDetailed(doc);
    const beforeById = new Map(before.layers.map((s) => [s.id, s]));

    // Update leaf-l's content — the frame-l path changes; frame-r + leaf-r
    // pen objects keep their identities (path-copy applier), so their emit
    // entries hit.
    const next = applyPatchToCanvas(doc, {
      op: 'update',
      shapeId: 'leaf-l',
      shape: { content: 'Left!' },
    } as never);
    const after = resolvePenTreeDetailed(next);

    const leafLAfter = after.layers.find((s) => s.id === 'leaf-l')!;
    expect(leafLAfter).not.toBe(beforeById.get('leaf-l')); // re-emitted
    expect(leafLAfter.text).toBe('Left!');

    const leafRAfter = after.layers.find((s) => s.id === 'leaf-r')!;
    expect(leafRAfter).toBe(beforeById.get('leaf-r')); // SAME object

    // The untouched sibling subtree's TREE NODE is reused wholesale.
    // (Top-level frames themselves re-emit — applyPatchToCanvas defensively
    // shallow-clones every top-level child per patch, churning their
    // identities. That churn stops at depth 1: everything BELOW the clone
    // keeps identity, which is where the node count lives.)
    const frameRTreeAfter = after.tree.find((tn) => tn.layer.id === 'frame-r')!;
    const frameRTreeBefore = before.tree.find((tn) => tn.layer.id === 'frame-r')!;
    expect(frameRTreeAfter.children[0]).toBe(frameRTreeBefore.children[0]); // leaf-r treeNode reused
    expect(frameRTreeAfter.children[0].layer).toBe(frameRTreeBefore.children[0].layer);
  });

  it('measured-bounds hints invalidate only the measured node\u2019s path; siblings reuse', () => {
    const doc = buildDoc();
    const a = resolvePenTreeDetailed(doc); // no hints

    // leaf-r is fit_content (no explicit size) → the hint replaces its
    // placeholder geometry.
    const b = resolvePenTreeDetailed(doc, {
      measuredBounds: { 'leaf-r': { width: 55, height: 18 } },
    });

    const leafRBefore = a.layers.find((s) => s.id === 'leaf-r')!;
    const leafRAfter = b.layers.find((s) => s.id === 'leaf-r')!;
    expect(leafRAfter).not.toBe(leafRBefore);
    expect(leafRAfter.width).toBe(55);
    expect(leafRAfter.height).toBe(18);

    // The sibling leaf (and its whole path) is untouched by the hint.
    expect(b.layers.find((s) => s.id === 'leaf-l')!).toBe(a.layers.find((s) => s.id === 'leaf-l')!);
  });

  it('replays emit-time warnings on cache hits (degradation stays visible)', () => {
    const doc = buildDoc();
    (doc.children[0] as PenFrame).fill = '$missing-var';
    const a = resolvePenTreeDetailed(doc);
    expect(a.warnings.some((w) => w.kind === 'unresolved_variable')).toBe(true);

    const b = resolvePenTreeDetailed(doc); // full-hit path
    expect(b.warnings.some((w) => w.kind === 'unresolved_variable')).toBe(true);
    expect(b.warnings.length).toBe(a.warnings.length);
  });
});

describe('resolve R9c expansion cache — ref instances', () => {
  it('keeps instance-descendant ids AND object identities stable across resolves', () => {
    const doc = buildRefDoc();
    const a = resolvePenTreeDetailed(doc);
    const b = resolvePenTreeDetailed(doc);

    const idsA = collectTreeIds(a.tree);
    const idsB = collectTreeIds(b.tree);
    // Pre-R9c every resolve deep-cloned the component and minted fresh
    // crypto.randomUUID()s for instance descendants — ids churned per call.
    expect(idsB).toEqual(idsA);
    expect(idsB).toContain('btn-label'); // stable, not a fresh UUID

    // Same tree nodes again (expansion cached per ref-node).
    const instTreeA = a.tree.find((tn) => tn.layer.id === 'btn-inst')!;
    const instTreeB = b.tree.find((tn) => tn.layer.id === 'btn-inst')!;
    expect(instTreeB).toBe(instTreeA);
  });

  it('re-expands when the component target changes (content-edit the master)', () => {
    const doc = buildRefDoc();
    const a = resolvePenTreeDetailed(doc);

    // Edit the master's fill → new component node identity → ref re-expands.
    const next = applyPatchToCanvas(doc, {
      op: 'update',
      shapeId: 'btn-master',
      shape: { fill: '#123456' },
    } as never);
    const b = resolvePenTreeDetailed(next);
    const instShape = b.layers.find((s) => s.id === 'btn-inst')!;
    // Instance fill follows the (overridden) master paint — the expansion
    // picked up the new component. (No overrides on this ref → master fill.)
    expect(instShape.fill).toBe('#123456');
  });
});
