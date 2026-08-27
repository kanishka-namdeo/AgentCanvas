// resolvePenTreeDetailed — the Phase-2 tree export (spec §3.2/§3.4) unit tests.
//
// Proves the refactor is behavior-neutral for the flat path AND that the new
// pre-flattening tree is the faithful pairing the DOM renderer's native
// layout mode consumes:
//   - `layers` is EXACTLY resolvePenTree's output (same order/geometry)
//   - tree parent/child structure matches the flat layers' parentId chains
//   - each tree node carries its source .pen node (layout vocabulary intact)
//   - ref instances expand inside the tree (D3) with componentId tags
//   - measuredBounds hints (§3.8) replace the 100×100 fit_content placeholder
//     on the flat path without affecting absent ids

import { describe, it, expect } from 'vitest';
import { resolvePenTree, resolvePenTreeDetailed } from '@/lib/pen/resolve';
import { createEmptyCanvasDocument } from '@/lib/canvas/types';
import type { CanvasDocument } from '@/lib/canvas/types';
import type { PenChild, PenFrame, PenComponent, PenRef, PenText } from '@/lib/pen/types';

// ---- Fixtures ------------------------------------------------------------------

function nestedDoc(): CanvasDocument {
  const doc = createEmptyCanvasDocument('test');
  const label: PenText = { id: 'label-1', type: 'text', x: 0, y: 0, width: 80, height: 20, content: 'Card title' };
  const badge: PenText = { id: 'badge-1', type: 'text', x: 0, y: 0, width: 40, height: 16, content: 'NEW' };
  const inner: PenFrame = {
    id: 'inner-frame',
    type: 'frame',
    x: 8,
    y: 8,
    width: 'fill_container',
    height: 'fit_content',
    layout: 'horizontal',
    gap: 8,
    padding: [4, 8],
    fill: '#e2e8f0',
    children: [label, badge],
  };
  const root: PenFrame = {
    id: 'root-frame',
    type: 'frame',
    name: 'Card',
    x: 100,
    y: 60,
    width: 300,
    height: 'fit_content',
    layout: 'vertical',
    gap: 12,
    padding: 16,
    fill: '#ffffff',
    children: [inner],
  };
  return { ...doc, children: [root] };
}

function refDoc(): CanvasDocument {
  const doc = createEmptyCanvasDocument('test');
  const label: PenText = { id: 'btn-label', type: 'text', x: 0, y: 0, width: 60, height: 16, content: 'Click' };
  const master: PenComponent = {
    id: 'btn-master',
    type: 'component',
    reusable: true,
    x: 0,
    y: 0,
    width: 120,
    height: 40,
    fill: '#0ea5e9',
    children: [label],
  };
  const instance: PenRef = { id: 'btn-inst', type: 'ref', ref: 'btn-master', x: 200, y: 100 };
  return { ...doc, children: [master, instance] };
}

// ---- Flat-path equivalence -------------------------------------------------------

describe('resolvePenTreeDetailed — flat layers equivalence', () => {
  it('returns exactly resolvePenTree’s output (order + geometry + fields)', () => {
    const doc = nestedDoc();
    const { layers } = resolvePenTreeDetailed(doc);
    const flat = resolvePenTree(doc);
    expect(layers).toEqual(flat);
    expect(layers.map((l) => l.id)).toEqual(flat.map((l) => l.id));
  });

  it('emits depth-first order: parent before its children', () => {
    const { layers } = resolvePenTreeDetailed(nestedDoc());
    const ids = layers.map((l) => l.id);
    expect(ids.indexOf('root-frame')).toBeLessThan(ids.indexOf('inner-frame'));
    expect(ids.indexOf('inner-frame')).toBeLessThan(ids.indexOf('label-1'));
    expect(ids.indexOf('inner-frame')).toBeLessThan(ids.indexOf('badge-1'));
  });
});

// ---- Tree structure ----------------------------------------------------------------

describe('resolvePenTreeDetailed — tree structure', () => {
  it('tree parent/child chains match the flat layers’ parentId links', () => {
    const doc = nestedDoc();
    const { layers, tree } = resolvePenTreeDetailed(doc);
    const byId = new Map(layers.map((l) => [l.id, l]));

    const walk = (nodes: typeof tree, parentId: string | null) => {
      for (const tn of nodes) {
        // The tree node's layer IS the flat layer (same object identity).
        expect(tn.layer).toBe(byId.get(tn.layer.id));
        expect(tn.layer.parentId).toBe(parentId);
        walk(tn.children, tn.layer.id);
      }
    };
    walk(tree, null);

    // Every flat layer appears exactly once in the tree.
    const treeIds: string[] = [];
    const collect = (nodes: typeof tree) => {
      for (const tn of nodes) {
        treeIds.push(tn.layer.id);
        collect(tn.children);
      }
    };
    collect(tree);
    expect(treeIds.sort()).toEqual(layers.map((l) => l.id).sort());
  });

  it('roots have parentId null; nested children carry their parent id', () => {
    const { tree } = resolvePenTreeDetailed(nestedDoc());
    expect(tree).toHaveLength(1);
    expect(tree[0].layer.id).toBe('root-frame');
    expect(tree[0].layer.parentId).toBeNull();
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].layer.id).toBe('inner-frame');
    expect(tree[0].children[0].layer.parentId).toBe('root-frame');
    expect(tree[0].children[0].children.map((c) => c.layer.id).sort()).toEqual(['badge-1', 'label-1']);
  });

  it('each tree node carries its SOURCE .pen node with the layout vocabulary', () => {
    const { tree } = resolvePenTreeDetailed(nestedDoc());
    const rootPen = tree[0].pen as PenFrame;
    expect(rootPen.id).toBe('root-frame');
    expect(rootPen.layout).toBe('vertical');
    expect(rootPen.gap).toBe(12);
    expect(rootPen.padding).toEqual(16);
    // Height is the sizing MODE, not the resolved number.
    expect(rootPen.height).toBe('fit_content');

    const inner = tree[0].children[0];
    expect((inner.pen as PenFrame).layout).toBe('horizontal');
    expect((inner.pen as PenFrame).width).toBe('fill_container');
  });

  it('expands ref instances inside the tree (D3) and tags componentId', () => {
    const { layers, tree } = resolvePenTreeDetailed(refDoc());
    // Roots: the master component + the expanded instance.
    expect(tree.map((t) => t.layer.id).sort()).toEqual(['btn-inst', 'btn-master']);
    const inst = tree.find((t) => t.layer.id === 'btn-inst')!;
    expect(inst.layer.componentId).toBe('btn-master');
    // The instance's cloned label is a tree child (fresh id, expanded subtree).
    expect(inst.children).toHaveLength(1);
    expect(inst.children[0].layer.type).toBe('text');
    expect(inst.children[0].layer.id).not.toBe('btn-label');
    // Flat output agrees.
    expect(layers.find((l) => l.id === 'btn-inst')!.componentId).toBe('btn-master');
    expect(layers.some((l) => l.parentId === 'btn-inst' && l.type === 'text')).toBe(true);
  });
});

// ---- measuredBounds hints (spec §3.8) ----------------------------------------------

describe('resolvePenTreeDetailed — measured-bounds intrinsic-size hints', () => {
  function emptyFitDoc(): CanvasDocument {
    const doc = createEmptyCanvasDocument('test');
    const frame: PenFrame = {
      id: 'fit-frame',
      type: 'frame',
      x: 0,
      y: 0,
      width: 'fit_content',
      height: 'fit_content',
      fill: '#fff',
      children: [],
    };
    return { ...doc, children: [frame] };
  }

  it('without hints: empty fit_content frame falls back to the 100×100 placeholder', () => {
    const { layers } = resolvePenTreeDetailed(emptyFitDoc());
    const frame = layers.find((l) => l.id === 'fit-frame')!;
    expect(frame.width).toBe(100);
    expect(frame.height).toBe(100);
  });

  it('with hints: the measured size replaces the placeholder', () => {
    const { layers } = resolvePenTreeDetailed(emptyFitDoc(), {
      measuredBounds: { 'fit-frame': { width: 217, height: 42 } },
    });
    const frame = layers.find((l) => l.id === 'fit-frame')!;
    expect(frame.width).toBe(217);
    expect(frame.height).toBe(42);
  });

  it('hints only apply to fit_content sizes with no intrinsic content (absent ids untouched)', () => {
    const doc = nestedDoc();
    const without = resolvePenTree(doc);
    const withHints = resolvePenTree(doc, {
      measuredBounds: { 'nonexistent-id': { width: 1, height: 1 } },
    });
    expect(withHints).toEqual(without);
  });

  it('resolvePenTree threads the same hints (wrapper parity)', () => {
    const flat = resolvePenTree(emptyFitDoc(), { measuredBounds: { 'fit-frame': { width: 33, height: 7 } } });
    const frame = flat.find((l) => l.id === 'fit-frame')!;
    expect(frame.width).toBe(33);
    expect(frame.height).toBe(7);
  });
});
