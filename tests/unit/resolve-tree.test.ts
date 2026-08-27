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

// ---- resolver warnings (agent-visible degradation reporting) ----------------------

describe('resolvePenTreeDetailed — resolver warnings', () => {
  it('placeholder_size: fires for an empty fit_content frame, silenced by a measured hint', () => {
    const doc = createEmptyCanvasDocument('test');
    const frame: PenFrame = {
      id: 'fit-frame', type: 'frame', x: 0, y: 0,
      width: 'fit_content', height: 'fit_content', fill: '#fff', children: [],
    };
    const withFrame = { ...doc, children: [frame] };

    // No measured hint → placeholder + warning.
    const warned = resolvePenTreeDetailed(withFrame);
    expect(warned.warnings.map((w) => w.kind)).toContain('placeholder_size');
    expect(warned.warnings.find((w) => w.kind === 'placeholder_size')!.nodeId).toBe('fit-frame');

    // Measured hint → no placeholder, no warning.
    const silenced = resolvePenTreeDetailed(withFrame, {
      measuredBounds: { 'fit-frame': { width: 217, height: 42 } },
    });
    expect(silenced.warnings.filter((w) => w.kind === 'placeholder_size')).toHaveLength(0);
  });

  it('placeholder_size: NOT raised for groups/sections (0×0 is intentional)', () => {
    const doc = createEmptyCanvasDocument('test');
    // PenGroup carries no explicit size — groups auto-fit (implicit fit_content).
    const group: PenChild = {
      id: 'grp', type: 'group', x: 0, y: 0, children: [],
    };
    const { warnings } = resolvePenTreeDetailed({ ...doc, children: [group] });
    expect(warnings.filter((w) => w.kind === 'placeholder_size')).toHaveLength(0);
  });

  it('dropped_ref: fires when a ref targets an unknown component (node vanishes)', () => {
    const doc = createEmptyCanvasDocument('test');
    const badRef: PenRef = { id: 'ghost-inst', type: 'ref', ref: 'missing-component', x: 0, y: 0 };
    const { layers, warnings } = resolvePenTreeDetailed({ ...doc, children: [badRef] });
    // The node is dropped from the render list …
    expect(layers.find((l) => l.id === 'ghost-inst')).toBeUndefined();
    // … and the warning names the missing target.
    const w = warnings.find((x) => x.kind === 'dropped_ref');
    expect(w).toBeDefined();
    expect(w!.nodeId).toBe('ghost-inst');
    expect(w!.message).toContain('missing-component');
  });

  it('ref_unexpanded: fires for a ref left raw by the cycle guard (renders as rectangle)', () => {
    const doc = createEmptyCanvasDocument('test');
    // Self-referencing component: A contains a ref to A → cycle guard leaves
    // the nested ref raw; the resolver maps it to a plain rectangle.
    const a: PenComponent = {
      id: 'comp-a', type: 'component', reusable: true, x: 0, y: 0, width: 100, height: 50,
      children: [{ id: 'nested-ref', type: 'ref', ref: 'comp-a', x: 0, y: 0 } as PenRef],
    };
    const instance: PenRef = { id: 'inst-a', type: 'ref', ref: 'comp-a', x: 200, y: 100 };
    const { warnings } = resolvePenTreeDetailed({ ...doc, children: [a, instance] });
    expect(warnings.some((w) => w.kind === 'ref_unexpanded')).toBe(true);
  });

  it('unresolved_variable: fires when a fill references an undefined $variable', () => {
    const doc = createEmptyCanvasDocument('test');
    const rect: PenChild = {
      id: 'var-rect', type: 'rectangle', x: 0, y: 0, width: 50, height: 50,
      fill: '$primary', stroke: '$outline', strokeWidth: 2,
    };
    const { warnings } = resolvePenTreeDetailed({ ...doc, children: [rect] });
    const kinds = warnings.filter((w) => w.kind === 'unresolved_variable');
    expect(kinds.length).toBeGreaterThanOrEqual(1);
    expect(kinds.some((w) => w.message!.includes('$primary'))).toBe(true);
  });

  it('effects_dropped: fires when more than one shadow is enabled on one node', () => {
    const doc = createEmptyCanvasDocument('test');
    const rect: PenChild = {
      id: 'shadowed', type: 'rectangle', x: 0, y: 0, width: 50, height: 50,
      effect: [
        { type: 'shadow', offset: { x: 0, y: 2 }, blur: 4, color: '#0000001a' },
        { type: 'shadow', offset: { x: 0, y: 8 }, blur: 12, color: '#00000033' },
      ],
    };
    const { warnings } = resolvePenTreeDetailed({ ...doc, children: [rect] });
    const w = warnings.find((x) => x.kind === 'effects_dropped');
    expect(w).toBeDefined();
    expect(w!.message).toContain('2 shadows');
  });

  it('path_geometry_dropped: fires for geometry the simple M/L parser cannot read', () => {
    const doc = createEmptyCanvasDocument('test');
    const path: PenChild = {
      id: 'curvy', type: 'path', x: 0, y: 0, width: 50, height: 50,
      geometry: 'M 0 0 C 10 10 20 20 30 30',
    };
    const { warnings } = resolvePenTreeDetailed({ ...doc, children: [path] });
    expect(warnings.some((w) => w.kind === 'path_geometry_dropped')).toBe(true);
  });

  it('unknown_node_type: fires for a type outside the .pen ontology', () => {
    const doc = createEmptyCanvasDocument('test');
    const weird = { id: 'alien', type: 'hologram', x: 0, y: 0, width: 50, height: 50 } as unknown as PenChild;
    const { warnings } = resolvePenTreeDetailed({ ...doc, children: [weird] });
    expect(warnings.some((w) => w.kind === 'unknown_node_type' && w.nodeId === 'alien')).toBe(true);
  });

  it('clean documents produce zero warnings (no false positives)', () => {
    const { layers, warnings } = resolvePenTreeDetailed(nestedDoc());
    expect(layers.length).toBeGreaterThan(0);
    expect(warnings).toHaveLength(0);
  });

  it('dedupes by (nodeId, kind) and mirrors into the external accumulator', () => {
    const doc = createEmptyCanvasDocument('test');
    const frame: PenFrame = {
      id: 'fit-frame', type: 'frame', x: 0, y: 0,
      width: 'fit_content', height: 'fit_content', fill: '#fff', children: [],
    };
    const external: import('@/lib/pen/resolve').ResolverWarning[] = [];
    const { warnings } = resolvePenTreeDetailed(
      { ...doc, children: [frame] },
      { warnings: external },
    );
    // Both axes fell back (w + h) but the (nodeId, kind) pair dedupes to ONE.
    const placeholders = warnings.filter((w) => w.kind === 'placeholder_size');
    expect(placeholders).toHaveLength(1);
    // External accumulator received the same entries.
    expect(external).toEqual(warnings);
  });
});
