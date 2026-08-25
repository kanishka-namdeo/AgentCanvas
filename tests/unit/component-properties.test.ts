// D2 — componentProperties interpretation during expandRef (spec Phase 2)
// unit tests.
//
// Figma's component property model on our .pen shapes:
//   DEFINITIONS on the master component (`componentPropertyDefinitions`),
//   VALUES on the instance (`PenRef.componentProperties`), binding by
//   property name → descendant source-id / name.
//
// Covered:
//   - BOOLEAN false → bound descendant `enabled: false` (hidden in resolve)
//   - BOOLEAN true → explicitly enabled
//   - TEXT → bound text descendant `content` override
//   - INSTANCE_SWAP → nested ref target rewrite (+ expansion of the swap)
//   - VARIANT → component_set ref renders the child variant matching the
//     instance's property values
//   - Precedence: explicit `descendants` overrides WIN over property-driven
//     writes (D2 applies after, skipping overridden fields)
//   - Definitions absent → componentProperties are inert (no interpretation)
//   - SLOT → TODO no-op (deferred)
//   - Binding by node NAME (exact + normalized "Show Icon" ≈ "show-icon")

import { describe, it, expect } from 'vitest';
import { expandRef, collectComponents } from '@/lib/pen/document';
import { resolvePenTree } from '@/lib/pen/resolve';
import { createEmptyCanvasDocument } from '@/lib/canvas/types';
import type { CanvasDocument } from '@/lib/canvas/types';
import type {
  PenChild,
  PenComponent,
  PenComponentSet,
  PenFrame,
  PenRef,
  PenText,
} from '@/lib/pen/types';

// ---- Helpers -----------------------------------------------------------------

function findIn(nodes: PenChild[], id: string): PenChild | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    const kids = (n as { children?: PenChild[] }).children;
    if (Array.isArray(kids)) {
      const found = findIn(kids, id);
      if (found) return found;
    }
  }
  return undefined;
}

function expand(ref: PenRef, doc: CanvasDocument): PenChild | null {
  return expandRef(ref, collectComponents(doc.children));
}

/// Master: a button component with a show-icon rectangle + label text child.
function buttonMaster(): PenComponent {
  const icon: PenChild = { id: 'show-icon', type: 'rectangle', name: 'Show Icon', x: 0, y: 0, width: 16, height: 16, fill: '#0ea5e9' };
  const label: PenText = { id: 'btn-label', type: 'text', name: 'Label', x: 24, y: 0, width: 80, height: 16, content: 'Click me' };
  return {
    id: 'master',
    type: 'component',
    reusable: true,
    x: 0,
    y: 0,
    width: 120,
    height: 40,
    fill: '#e2e8f0',
    componentPropertyDefinitions: {
      'show-icon': { type: 'boolean', defaultValue: true },
      'btn-label': { type: 'text', defaultValue: 'Click me' },
    },
    children: [icon, label],
  };
}

function docWith(children: PenChild[]): CanvasDocument {
  return { ...createEmptyCanvasDocument('test'), children };
}

// ---- BOOLEAN -----------------------------------------------------------------

describe('D2 componentProperties — BOOLEAN toggles descendant visibility', () => {
  it('false hides the bound descendant (enabled: false → invisible layer)', () => {
    const master = buttonMaster();
    const doc = docWith([master]);
    const ref: PenRef = { id: 'inst', type: 'ref', ref: 'master', x: 0, y: 0, componentProperties: { 'show-icon': false } };
    const expanded = expand(ref, doc)!;
    expect(expanded).not.toBeNull();
    // The clone carries fresh ids — find by _sourceId.
    const cloned = ((expanded as PenComponent).children ?? []).find((c) => (c as { _sourceId?: string })._sourceId === 'show-icon')!;
    expect(cloned).toBeDefined();
    expect((cloned as { enabled?: boolean }).enabled).toBe(false);
    // And the resolver surfaces it as an invisible layer (resolve re-expands
    // with its own fresh ids — locate by parent + name).
    const shapes = resolvePenTree(docWith([master, ref]));
    const iconShape = shapes.find((s) => s.parentId === 'inst' && s.name === 'Show Icon');
    expect(iconShape).toBeDefined();
    expect(iconShape!.visible).toBe(false);
  });

  it('true explicitly enables the bound descendant', () => {
    const master = buttonMaster();
    const doc = docWith([master]);
    const ref: PenRef = { id: 'inst', type: 'ref', ref: 'master', x: 0, y: 0, componentProperties: { 'show-icon': true } };
    const expanded = expand(ref, doc)!;
    const cloned = ((expanded as PenComponent).children ?? []).find((c) => (c as { _sourceId?: string })._sourceId === 'show-icon')!;
    expect((cloned as { enabled?: boolean }).enabled).toBe(true);
  });

  it('binds by node NAME (normalized) when ids don’t match', () => {
    // Property "showicon" vs descendant name "Show Icon" — normalized match
    // (case/punctuation-insensitive).
    const master: PenComponent = {
      ...buttonMaster(),
      componentPropertyDefinitions: { showicon: { type: 'boolean', defaultValue: true } },
    };
    const doc = docWith([master]);
    const ref: PenRef = { id: 'inst', type: 'ref', ref: 'master', x: 0, y: 0, componentProperties: { showicon: false } };
    const expanded = expand(ref, doc)!;
    const cloned = ((expanded as PenComponent).children ?? []).find((c) => (c as { _sourceId?: string })._sourceId === 'show-icon')!;
    expect((cloned as { enabled?: boolean }).enabled).toBe(false);
  });
});

// ---- TEXT --------------------------------------------------------------------

describe('D2 componentProperties — TEXT overrides descendant content', () => {
  it('overrides the bound text node’s content', () => {
    const master = buttonMaster();
    const doc = docWith([master]);
    const ref: PenRef = { id: 'inst', type: 'ref', ref: 'master', x: 0, y: 0, componentProperties: { 'btn-label': 'Cancel' } };
    const expanded = expand(ref, doc)!;
    const cloned = ((expanded as PenComponent).children ?? []).find((c) => (c as { _sourceId?: string })._sourceId === 'btn-label')!;
    expect((cloned as PenText).content).toBe('Cancel');
    // Resolved layer carries the overridden text (resolve re-expands with its
    // own fresh ids — locate by parent + name).
    const shapes = resolvePenTree(docWith([master, ref]));
    const labelShape = shapes.find((s) => s.parentId === 'inst' && s.name === 'Label');
    expect(labelShape).toBeDefined();
    expect(labelShape!.text).toBe('Cancel');
  });

  it('does not write content onto non-text-bearing nodes', () => {
    const master: PenComponent = {
      ...buttonMaster(),
      componentPropertyDefinitions: { 'show-icon': { type: 'text', defaultValue: 'x' } },
    };
    const doc = docWith([master]);
    const ref: PenRef = { id: 'inst', type: 'ref', ref: 'master', x: 0, y: 0, componentProperties: { 'show-icon': 'Not a label' } };
    const expanded = expand(ref, doc)!;
    const cloned = ((expanded as PenComponent).children ?? []).find((c) => (c as { _sourceId?: string })._sourceId === 'show-icon')!;
    expect((cloned as { content?: string }).content).toBeUndefined();
  });
});

// ---- INSTANCE_SWAP --------------------------------------------------------------

describe('D2 componentProperties — INSTANCE_SWAP rewrites a nested ref target', () => {
  function nestedDoc(): CanvasDocument {
    const iconA: PenComponent = { id: 'icon-a', type: 'component', reusable: true, x: 0, y: 0, width: 12, height: 12, fill: '#ff0000' };
    const iconB: PenComponent = { id: 'icon-b', type: 'component', reusable: true, x: 0, y: 0, width: 12, height: 12, fill: '#0000ff' };
    const nestedRef: PenRef = { id: 'icon-slot', type: 'ref', ref: 'icon-a', x: 4, y: 4 };
    const master: PenComponent = {
      id: 'master',
      type: 'component',
      reusable: true,
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      componentPropertyDefinitions: { 'icon-slot': { type: 'instance_swap', defaultValue: 'icon-a', preferredValues: ['icon-a', 'icon-b'] } },
      children: [nestedRef],
    };
    return docWith([iconA, iconB, master]);
  }

  it('rewrites the nested ref to the swapped component id (and expands it)', () => {
    const doc = nestedDoc();
    const ref: PenRef = { id: 'inst', type: 'ref', ref: 'master', x: 0, y: 0, componentProperties: { 'icon-slot': 'icon-b' } };
    const expanded = expand(ref, doc)!;
    // The nested ref was REPLACED by its expansion — a component-clone with
    // componentId = the swapped target (attached at runtime by expandRef).
    const swapped = findIn([expanded], (expanded as PenComponent).children![0].id) as PenComponent & { componentId?: string };
    expect(swapped.componentId).toBe('icon-b');
    expect(swapped.fill).toBe('#0000ff');
  });

  it('default (no property value) keeps the original nested target', () => {
    const doc = nestedDoc();
    const ref: PenRef = { id: 'inst', type: 'ref', ref: 'master', x: 0, y: 0 };
    const expanded = expand(ref, doc)!;
    const swapped = findIn([expanded], (expanded as PenComponent).children![0].id) as PenComponent & { componentId?: string };
    expect(swapped.componentId).toBe('icon-a');
  });
});

// ---- VARIANT --------------------------------------------------------------------

describe('D2 componentProperties — VARIANT swaps the rendered set child', () => {
  function variantDoc(): CanvasDocument {
    // Variant children: components carrying variantPropertyValues (the
    // `add_variant` patch op attaches it — the base PenComponent type doesn't
    // declare it, hence the intersection).
    type Variant = PenComponent & { variantPropertyValues: Record<string, string> };
    const primary: Variant = {
      id: 'btn-primary', type: 'component', reusable: true, x: 0, y: 0, width: 100, height: 40,
      fill: '#0ea5e9', variantPropertyValues: { state: 'default' },
      children: [{ id: 'pl', type: 'text', name: 'Label', x: 0, y: 0, width: 60, height: 16, content: 'Primary' }],
    };
    const danger: Variant = {
      id: 'btn-danger', type: 'component', reusable: true, x: 0, y: 0, width: 100, height: 40,
      fill: '#ef4444', variantPropertyValues: { state: 'danger' },
      children: [{ id: 'dl', type: 'text', name: 'Label', x: 0, y: 0, width: 60, height: 16, content: 'Danger' }],
    };
    // NOTE: the set carries reusable:true so `collectComponents` (which keys
    // off reusable) can resolve refs that target the SET itself — a ref to a
    // non-reusable set is dropped by the resolver (pre-existing behavior).
    const set: PenComponentSet = {
      id: 'btn-set', type: 'component_set', reusable: true, x: 0, y: 0, width: 100, height: 40,
      variantPropertyAxes: ['state'], children: [primary, danger],
    };
    return docWith([set]);
  }

  it('a set ref with state=danger renders the danger variant subtree', () => {
    const doc = variantDoc();
    const ref: PenRef = { id: 'inst', type: 'ref', ref: 'btn-set', x: 0, y: 0, componentProperties: { state: 'danger' } };
    const shapes = resolvePenTree(docWith([...doc.children, ref]));
    const inst = shapes.find((s) => s.id === 'inst')!;
    expect(inst.componentId).toBe('btn-set');
    // The instance root IS the picked variant clone (fill carries over).
    expect(inst.fill).toBe('#ef4444');
    // The instance subtree is the DANGER variant's text.
    const childText = shapes.find((s) => s.parentId === 'inst' && s.type === 'text')!;
    expect(childText.text).toBe('Danger');
    // Exactly ONE variant's subtree renders (the other is not instantiated).
    expect(shapes.filter((s) => s.parentId === 'inst' && s.type === 'text')).toHaveLength(1);
  });

  it('a set ref without properties renders the set itself (unchanged behavior)', () => {
    const doc = variantDoc();
    const ref: PenRef = { id: 'inst', type: 'ref', ref: 'btn-set', x: 0, y: 0 };
    const shapes = resolvePenTree(docWith([...doc.children, ref]));
    // Set-level expansion: both variants' children live under the instance.
    const childIds = shapes.filter((s) => s.parentId === 'inst').map((s) => s.id);
    expect(childIds.length).toBeGreaterThan(0);
  });

  it('a non-matching value keeps the set rendering (no crash, no swap)', () => {
    const doc = variantDoc();
    const ref: PenRef = { id: 'inst', type: 'ref', ref: 'btn-set', x: 0, y: 0, componentProperties: { state: 'nonexistent' } };
    const shapes = resolvePenTree(docWith([...doc.children, ref]));
    expect(shapes.find((s) => s.id === 'inst')).toBeDefined();
  });
});

// ---- Precedence + safety -----------------------------------------------------------

describe('D2 componentProperties — precedence + safety', () => {
  it('explicit descendants overrides WIN over property-driven writes', () => {
    const master = buttonMaster();
    const doc = docWith([master]);
    const ref: PenRef = {
      id: 'inst',
      type: 'ref',
      ref: 'master',
      x: 0,
      y: 0,
      componentProperties: { 'btn-label': 'PROPERTY VALUE' },
      // The override path is the source-id path from the component root.
      descendants: { 'master/btn-label': { content: 'OVERRIDE VALUE' } },
    };
    const expanded = expand(ref, doc)!;
    const cloned = ((expanded as PenComponent).children ?? []).find((c) => (c as { _sourceId?: string })._sourceId === 'btn-label')!;
    expect((cloned as PenText).content).toBe('OVERRIDE VALUE');
  });

  it('componentProperties are INERT when the master defines no properties', () => {
    const master: PenComponent = { ...buttonMaster(), componentPropertyDefinitions: undefined };
    const doc = docWith([master]);
    const ref: PenRef = { id: 'inst', type: 'ref', ref: 'master', x: 0, y: 0, componentProperties: { 'show-icon': false } };
    const expanded = expand(ref, doc)!;
    const cloned = ((expanded as PenComponent).children ?? []).find((c) => (c as { _sourceId?: string })._sourceId === 'show-icon')!;
    expect((cloned as { enabled?: boolean }).enabled).toBeUndefined();
  });

  it('unknown property names are skipped safely', () => {
    const master = buttonMaster();
    const doc = docWith([master]);
    const ref: PenRef = { id: 'inst', type: 'ref', ref: 'master', x: 0, y: 0, componentProperties: { 'no-such-property': false } };
    expect(() => expand(ref, doc)).not.toThrow();
    const expanded = expand(ref, doc)!;
    const cloned = ((expanded as PenComponent).children ?? []).find((c) => (c as { _sourceId?: string })._sourceId === 'show-icon')!;
    expect((cloned as { enabled?: boolean }).enabled).toBeUndefined();
  });

  it('SLOT properties are a documented no-op (deferred)', () => {
    const master: PenComponent = {
      ...buttonMaster(),
      componentPropertyDefinitions: { 'show-icon': { type: 'slot', defaultValue: '' } },
    };
    const doc = docWith([master]);
    const ref: PenRef = { id: 'inst', type: 'ref', ref: 'master', x: 0, y: 0, componentProperties: { 'show-icon': 'anything' } };
    expect(() => expand(ref, doc)).not.toThrow();
  });

  it('nested instances get their own componentProperties applied (recursion)', () => {
    // Outer master contains a nested ref to the button master; the OUTER
    // instance swaps the nested one's icon off via its own properties.
    const button = buttonMaster();
    const nestedRef: PenRef = { id: 'inner-btn', type: 'ref', ref: 'master', x: 0, y: 0, componentProperties: { 'show-icon': false } };
    const outer: PenFrame = {
      id: 'outer',
      type: 'frame',
      x: 0,
      y: 0,
      width: 200,
      height: 80,
      children: [nestedRef],
    };
    const doc = docWith([button, outer]);
    const shapes = resolvePenTree(doc);
    // Find the icon layer inside the nested instance — hidden.
    const iconShape = shapes.find((s) => s.parentId === 'inner-btn' && s.name === 'Show Icon');
    expect(iconShape).toBeDefined();
    expect(iconShape!.visible).toBe(false);
  });
});
