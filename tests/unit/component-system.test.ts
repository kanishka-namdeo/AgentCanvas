// Component System (Phase 2 — Figma-aligned components & design systems) — unit tests.
//
// Covers the 7 new patch ops:
//   - convert_to_component    — promote frame → reusable component
//   - place_instance          — create a PenRef (linked instance)
//   - set_instance_override   — override a descendant property on a PenRef
//   - reset_instance          — clear all overrides
//   - detach_instance         — bake PenRef into a standalone frame
//   - combine_as_variants     — wrap components into a ComponentSet
//   - swap_variant            — switch which variant the instance points to

import { describe, it, expect } from 'vitest';
import { applyPatchToCanvas } from '@/lib/canvas/patch';
import { createEmptyCanvasDocument } from '@/lib/canvas/types';
import type { CanvasPatch, CanvasDocument } from '@/lib/canvas/types';
import type { PenChild, PenRef, PenComponent, PenComponentSet } from '@/lib/pen/types';

// ---- Helpers --------------------------------------------------------------

/// Build a doc with one Component (a Button with a label text child) for tests.
function docWithButtonComponent(): { doc: CanvasDocument; buttonId: string; labelId: string } {
  const doc = createEmptyCanvasDocument('test');
  const buttonId = 'btn-comp';
  const labelId = 'btn-label';
  // Create the component via the existing op (create_component sets up a
  // reusable container with children).
  const patch: CanvasPatch = {
    op: 'create_component',
    shapeId: buttonId,
    shape: {
      id: buttonId,
      type: 'component',
      name: 'Primary Button',
      x: 100,
      y: 100,
      width: 120,
      height: 40,
      fill: '#0ea5e9',
      radius: 6,
      reusable: true,
    },
    summary: 'Add Button component',
  };
  let next = applyPatchToCanvas(doc, patch);
  // Add a text label as the button's child.
  next = applyPatchToCanvas(next, {
    op: 'add',
    shapeId: labelId,
    shape: {
      id: labelId,
      type: 'text',
      name: 'Label',
      x: 20,
      y: 12,
      width: 80,
      height: 16,
      text: 'Click me',
      fontSize: 12,
      textColor: '#ffffff',
      parentId: buttonId,
    },
    summary: 'Add label',
  });
  return { doc: next, buttonId, labelId };
}

// ---- Tests: convert_to_component -----------------------------------------

describe('Component System — convert_to_component', () => {
  it('promotes a frame into a reusable Component', () => {
    const doc = createEmptyCanvasDocument('test');
    // Start with a regular frame.
    let next = applyPatchToCanvas(doc, {
      op: 'add',
      shapeId: 'frame-1',
      shape: { id: 'frame-1', type: 'frame', name: 'My Frame', x: 0, y: 0, width: 100, height: 50 },
      summary: 'Add frame',
    });
    // Promote it.
    next = applyPatchToCanvas(next, {
      op: 'convert_to_component',
      shapeId: 'frame-1',
      summary: 'Promote to component',
    });
    const node = next.children.find((c) => c.id === 'frame-1');
    expect(node).toBeDefined();
    expect(node!.type).toBe('component');
    expect((node as PenComponent).reusable).toBe(true);
    // Name is preserved.
    expect((node as { name?: string }).name).toBe('My Frame');
  });

  it('refuses to promote a non-promotable type (e.g. component_set)', () => {
    const doc = createEmptyCanvasDocument('test');
    let next = applyPatchToCanvas(doc, {
      op: 'create_component_set',
      shapeId: 'set-1',
      shape: { id: 'set-1', type: 'component_set', name: 'Set', x: 0, y: 0, width: 200, height: 100 },
      variantPropertyAxes: ['state'],
      summary: 'Add set',
    });
    next = applyPatchToCanvas(next, {
      op: 'convert_to_component',
      shapeId: 'set-1',
      summary: 'Try to promote set',
    });
    // Type unchanged.
    const node = next.children.find((c) => c.id === 'set-1');
    expect(node!.type).toBe('component_set');
  });
});

// ---- Tests: place_instance + set_instance_override ----------------------

describe('Component System — place_instance + set_instance_override', () => {
  it('places a PenRef instance pointing at a reusable component', () => {
    const { doc, buttonId } = docWithButtonComponent();
    const next = applyPatchToCanvas(doc, {
      op: 'place_instance',
      shapeId: 'inst-1',
      componentId: buttonId,
      shape: { x: 300, y: 200 },
      summary: 'Place instance',
    });
    const ref = next.children.find((c) => c.id === 'inst-1');
    expect(ref).toBeDefined();
    expect(ref!.type).toBe('ref');
    expect((ref as PenRef).ref).toBe(buttonId);
    expect((ref as PenRef).x).toBe(300);
    expect((ref as PenRef).y).toBe(200);
    // The ref should expand to the component's resolved tree (button + label).
    const resolved = next.shapes.filter((s) => s.id === 'inst-1' || s.parentId === 'inst-1');
    expect(resolved.length).toBeGreaterThan(0);
  });

  it('overrides text on a descendant of an instance', () => {
    const { doc, buttonId, labelId } = docWithButtonComponent();
    let next = applyPatchToCanvas(doc, {
      op: 'place_instance',
      shapeId: 'inst-1',
      componentId: buttonId,
      shape: { x: 300, y: 200 },
      summary: 'Place instance',
    });
    // Override the label text on the instance.
    // (The patch applier normalizes the legacy `text` field name to .pen's
    // `content` field — so we check `content` in the stored descendants.)
    next = applyPatchToCanvas(next, {
      op: 'set_instance_override',
      shapeId: 'inst-1',
      descendantPath: labelId,
      override: { text: 'Submit' },
      summary: 'Override label text',
    });
    const ref = next.children.find((c) => c.id === 'inst-1') as PenRef | undefined;
    expect(ref).toBeDefined();
    expect(ref!.descendants).toBeDefined();
    expect(ref!.descendants![labelId]).toBeDefined();
    expect((ref!.descendants![labelId] as { content?: string }).content).toBe('Submit');

    // End-to-end: the resolved tree should have the overridden text on the
    // instance's child text node (NOT the main component's "Click me" default).
    const textShapes = next.shapes.filter((s) => s.parentId === 'inst-1' && s.type === 'text');
    expect(textShapes.length).toBe(1);
    expect(textShapes[0].text).toBe('Submit');
  });

  it('merges multiple overrides on the same descendant path', () => {
    const { doc, buttonId, labelId } = docWithButtonComponent();
    let next = applyPatchToCanvas(doc, {
      op: 'place_instance',
      shapeId: 'inst-1',
      componentId: buttonId,
      shape: { x: 0, y: 0 },
      summary: 'Place instance',
    });
    next = applyPatchToCanvas(next, {
      op: 'set_instance_override',
      shapeId: 'inst-1',
      descendantPath: labelId,
      override: { text: 'Submit' },
      summary: 'Set text',
    });
    next = applyPatchToCanvas(next, {
      op: 'set_instance_override',
      shapeId: 'inst-1',
      descendantPath: labelId,
      override: { textColor: '#ff0000' },
      summary: 'Set color',
    });
    const ref = next.children.find((c) => c.id === 'inst-1') as PenRef | undefined;
    // Both overrides should be present (merged).
    // Note: `text` → `content` and `textColor` → `fill` after normalization.
    const ov = ref!.descendants![labelId] as { content?: string; fill?: string };
    expect(ov.content).toBe('Submit');
    expect(ov.fill).toBe('#ff0000');
  });

  it('silently no-ops when overriding a non-ref node', () => {
    const doc = createEmptyCanvasDocument('test');
    let next = applyPatchToCanvas(doc, {
      op: 'add',
      shapeId: 'rect-1',
      shape: { id: 'rect-1', type: 'rectangle', name: 'R', x: 0, y: 0, width: 10, height: 10 },
      summary: 'Add rect',
    });
    // No exception — just a no-op.
    next = applyPatchToCanvas(next, {
      op: 'set_instance_override',
      shapeId: 'rect-1',
      descendantPath: 'foo',
      override: { text: 'x' },
      summary: 'No-op',
    });
    const node = next.children.find((c) => c.id === 'rect-1');
    // The node is unchanged.
    expect(node!.type).toBe('rectangle');
  });
});

// ---- Tests: reset_instance -----------------------------------------------

describe('Component System — reset_instance', () => {
  it('clears all overrides on an instance', () => {
    const { doc, buttonId, labelId } = docWithButtonComponent();
    let next = applyPatchToCanvas(doc, {
      op: 'place_instance',
      shapeId: 'inst-1',
      componentId: buttonId,
      shape: { x: 0, y: 0 },
      summary: 'Place',
    });
    next = applyPatchToCanvas(next, {
      op: 'set_instance_override',
      shapeId: 'inst-1',
      descendantPath: labelId,
      override: { text: 'Override' },
      summary: 'Override',
    });
    expect((next.children.find((c) => c.id === 'inst-1') as PenRef).descendants).toBeDefined();
    next = applyPatchToCanvas(next, {
      op: 'reset_instance',
      shapeId: 'inst-1',
      summary: 'Reset',
    });
    const ref = next.children.find((c) => c.id === 'inst-1') as PenRef | undefined;
    expect(ref).toBeDefined();
    expect(ref!.descendants).toBeUndefined();
    expect(ref!.componentProperties).toBeUndefined();
  });
});

// ---- Tests: detach_instance ----------------------------------------------

describe('Component System — detach_instance', () => {
  it('converts a PenRef into a standalone frame (link broken)', () => {
    const { doc, buttonId, labelId } = docWithButtonComponent();
    let next = applyPatchToCanvas(doc, {
      op: 'place_instance',
      shapeId: 'inst-1',
      componentId: buttonId,
      shape: { x: 300, y: 200 },
      summary: 'Place',
    });
    // Override before detaching — overrides should bake in.
    next = applyPatchToCanvas(next, {
      op: 'set_instance_override',
      shapeId: 'inst-1',
      descendantPath: labelId,
      override: { text: 'Detached text' },
      summary: 'Override',
    });
    next = applyPatchToCanvas(next, {
      op: 'detach_instance',
      shapeId: 'inst-1',
      summary: 'Detach',
    });
    const node = next.children.find((c) => c.id === 'inst-1');
    expect(node).toBeDefined();
    // It should no longer be a ref.
    expect(node!.type).not.toBe('ref');
    // The detached node is a frame (or component clone) with children.
    expect('children' in node! && Array.isArray((node! as { children?: unknown[] }).children)).toBe(true);
  });
});

// ---- Tests: combine_as_variants ------------------------------------------

describe('Component System — combine_as_variants', () => {
  it('wraps 2 components into a component_set with auto-derived axes', () => {
    const doc = createEmptyCanvasDocument('test');
    let next = applyPatchToCanvas(doc, {
      op: 'create_component',
      shapeId: 'btn-lg-default',
      shape: { id: 'btn-lg-default', type: 'component', name: 'Size=Large, State=Default', x: 0, y: 0, width: 120, height: 40, reusable: true },
      summary: 'Add btn-lg-default',
    });
    next = applyPatchToCanvas(next, {
      op: 'create_component',
      shapeId: 'btn-lg-hover',
      shape: { id: 'btn-lg-hover', type: 'component', name: 'Size=Large, State=Hover', x: 0, y: 60, width: 120, height: 40, reusable: true },
      summary: 'Add btn-lg-hover',
    });
    next = applyPatchToCanvas(next, {
      op: 'combine_as_variants',
      shapeId: 'btn-set',
      componentIds: ['btn-lg-default', 'btn-lg-hover'],
      shape: { name: 'Button' },
      summary: 'Combine as variants',
    });
    const set = next.children.find((c) => c.id === 'btn-set') as PenComponentSet | undefined;
    expect(set).toBeDefined();
    expect(set!.type).toBe('component_set');
    expect(set!.variantPropertyAxes).toEqual(['Size', 'State']);
    expect(set!.children!.length).toBe(2);
    // The two components should have been MOVED INTO the set (not duplicated).
    const flatIds = next.children.map((c) => c.id);
    expect(flatIds).not.toContain('btn-lg-default');
    expect(flatIds).not.toContain('btn-lg-hover');
  });

  it('uses explicitly provided axes when given', () => {
    const doc = createEmptyCanvasDocument('test');
    let next = applyPatchToCanvas(doc, {
      op: 'create_component',
      shapeId: 'c1',
      shape: { id: 'c1', type: 'component', name: 'Variant A', x: 0, y: 0, width: 50, height: 50, reusable: true },
      summary: 'Add c1',
    });
    next = applyPatchToCanvas(next, {
      op: 'create_component',
      shapeId: 'c2',
      shape: { id: 'c2', type: 'component', name: 'Variant B', x: 60, y: 0, width: 50, height: 50, reusable: true },
      summary: 'Add c2',
    });
    next = applyPatchToCanvas(next, {
      op: 'combine_as_variants',
      shapeId: 'set',
      componentIds: ['c1', 'c2'],
      axes: ['variant'],
      shape: { name: 'Variants' },
      summary: 'Combine',
    });
    const set = next.children.find((c) => c.id === 'set') as PenComponentSet | undefined;
    expect(set!.variantPropertyAxes).toEqual(['variant']);
  });

  it('refuses to combine when one of the ids is not a component', () => {
    const doc = createEmptyCanvasDocument('test');
    let next = applyPatchToCanvas(doc, {
      op: 'create_component',
      shapeId: 'c1',
      shape: { id: 'c1', type: 'component', name: 'C1', x: 0, y: 0, width: 50, height: 50, reusable: true },
      summary: 'Add c1',
    });
    next = applyPatchToCanvas(next, {
      op: 'add',
      shapeId: 'rect-1',
      shape: { id: 'rect-1', type: 'rectangle', name: 'R', x: 0, y: 0, width: 10, height: 10 },
      summary: 'Add rect',
    });
    const before = next.children.length;
    next = applyPatchToCanvas(next, {
      op: 'combine_as_variants',
      shapeId: 'set',
      componentIds: ['c1', 'rect-1'],
      shape: { name: 'Should fail' },
      summary: 'Should fail',
    });
    // No set was created.
    expect(next.children.find((c) => c.id === 'set')).toBeUndefined();
    // The original component is still in the tree (combine failed midway).
    expect(next.children.find((c) => c.id === 'c1')).toBeDefined();
    // No extra nodes were added.
    expect(next.children.length).toBe(before);
  });
});

// ---- Tests: swap_variant -------------------------------------------------

describe('Component System — swap_variant', () => {
  it('switches which variant the instance points to', () => {
    const doc = createEmptyCanvasDocument('test');
    let next = applyPatchToCanvas(doc, {
      op: 'create_component',
      shapeId: 'v1',
      shape: { id: 'v1', type: 'component', name: 'State=Default', x: 0, y: 0, width: 100, height: 40, reusable: true },
      summary: 'Add v1',
    });
    next = applyPatchToCanvas(next, {
      op: 'create_component',
      shapeId: 'v2',
      shape: { id: 'v2', type: 'component', name: 'State=Hover', x: 0, y: 60, width: 100, height: 40, reusable: true },
      summary: 'Add v2',
    });
    next = applyPatchToCanvas(next, {
      op: 'combine_as_variants',
      shapeId: 'set',
      componentIds: ['v1', 'v2'],
      axes: ['State'],
      shape: { name: 'Button' },
      summary: 'Combine',
    });
    // Place an instance pointing at v1.
    next = applyPatchToCanvas(next, {
      op: 'place_instance',
      shapeId: 'inst',
      componentId: 'v1',
      shape: { x: 300, y: 100 },
      summary: 'Place instance',
    });
    expect((next.children.find((c) => c.id === 'inst') as PenRef).ref).toBe('v1');
    // Swap to v2.
    next = applyPatchToCanvas(next, {
      op: 'swap_variant',
      shapeId: 'inst',
      componentId: 'v2',
      summary: 'Swap to v2',
    });
    expect((next.children.find((c) => c.id === 'inst') as PenRef).ref).toBe('v2');
  });
});

// ---- Tests: end-to-end propagation ---------------------------------------

describe('Component System — main → instance propagation', () => {
  it('updating the main component re-resolves instances automatically', () => {
    const { doc, buttonId } = docWithButtonComponent();
    let next = applyPatchToCanvas(doc, {
      op: 'place_instance',
      shapeId: 'inst-1',
      componentId: buttonId,
      shape: { x: 300, y: 200 },
      summary: 'Place instance',
    });
    // Sanity: the instance should render at the main component's width.
    const beforeInst = next.shapes.find((s) => s.id === 'inst-1');
    expect(beforeInst).toBeDefined();
    expect(beforeInst!.width).toBe(120);
    // Now update the main component's width.
    next = applyPatchToCanvas(next, {
      op: 'update',
      shapeId: buttonId,
      shape: { width: 200 },
      summary: 'Widen main component',
    });
    // The instance should reflect the new width after re-resolution.
    const afterInst = next.shapes.find((s) => s.id === 'inst-1');
    expect(afterInst!.width).toBe(200);
  });
});

// ---- Tests: deriveVariantAxes (helper) -----------------------------------

describe('Component System — deriveVariantAxes (via combine_as_variants)', () => {
  it('parses "Property=Value, Property=Value" naming convention', () => {
    const doc = createEmptyCanvasDocument('test');
    let next = applyPatchToCanvas(doc, {
      op: 'create_component',
      shapeId: 'c1',
      shape: { id: 'c1', type: 'component', name: 'Size=L, State=Default, Icon=Leading', x: 0, y: 0, width: 50, height: 50, reusable: true },
      summary: 'Add c1',
    });
    next = applyPatchToCanvas(next, {
      op: 'create_component',
      shapeId: 'c2',
      shape: { id: 'c2', type: 'component', name: 'Size=L, State=Default, Icon=Trailing', x: 60, y: 0, width: 50, height: 50, reusable: true },
      summary: 'Add c2',
    });
    next = applyPatchToCanvas(next, {
      op: 'combine_as_variants',
      shapeId: 'set',
      componentIds: ['c1', 'c2'],
      shape: { name: 'Multi-axis' },
      summary: 'Combine',
    });
    const set = next.children.find((c) => c.id === 'set') as PenComponentSet | undefined;
    expect(set!.variantPropertyAxes).toEqual(['Size', 'State', 'Icon']);
  });

  it('falls back to ["Variant"] for non-conforming names', () => {
    const doc = createEmptyCanvasDocument('test');
    let next = applyPatchToCanvas(doc, {
      op: 'create_component',
      shapeId: 'c1',
      shape: { id: 'c1', type: 'component', name: 'Plain Button', x: 0, y: 0, width: 50, height: 50, reusable: true },
      summary: 'Add c1',
    });
    next = applyPatchToCanvas(next, {
      op: 'create_component',
      shapeId: 'c2',
      shape: { id: 'c2', type: 'component', name: 'Another Button', x: 60, y: 0, width: 50, height: 50, reusable: true },
      summary: 'Add c2',
    });
    next = applyPatchToCanvas(next, {
      op: 'combine_as_variants',
      shapeId: 'set',
      componentIds: ['c1', 'c2'],
      shape: { name: 'Fallback' },
      summary: 'Combine',
    });
    const set = next.children.find((c) => c.id === 'set') as PenComponentSet | undefined;
    expect(set!.variantPropertyAxes).toEqual(['Variant']);
  });
});

// ---- Tests: nested refs (D3 recursive expansion) -------------------------

describe('Component System — nested refs (D3 recursive expansion)', () => {
  /// Build a doc with:
  ///   - Component B ("Badge") — reusable, contains a text child "Badge".
  ///   - Component A ("Card") — reusable, contains a nested ref → B.
  ///   - An instance of A placed at root ("inst-a").
  /// Regression (D3): the nested ref used to survive expansion as a raw `ref`
  /// node, which the resolver mapped to a plain rectangle.
  function docWithNestedRef(): { doc: CanvasDocument; aId: string; bId: string; bTextId: string } {
    const aId = 'card-comp';
    const bId = 'badge-comp';
    const bTextId = 'badge-label';
    let next = createEmptyCanvasDocument('test');
    // Component B (reusable) with a text child.
    next = applyPatchToCanvas(next, {
      op: 'create_component',
      shapeId: bId,
      shape: {
        id: bId,
        type: 'component',
        name: 'Badge',
        x: 0, y: 0, width: 60, height: 24,
        fill: '#22c55e',
        reusable: true,
      },
      summary: 'Add Badge component',
    });
    next = applyPatchToCanvas(next, {
      op: 'add',
      shapeId: bTextId,
      shape: {
        id: bTextId,
        type: 'text',
        name: 'Badge label',
        x: 8, y: 4, width: 44, height: 16,
        text: 'Badge',
        fontSize: 10,
        parentId: bId,
      },
      summary: 'Add badge label',
    });
    // Component A (reusable) containing a nested instance (ref) of B.
    next = applyPatchToCanvas(next, {
      op: 'create_component',
      shapeId: aId,
      shape: {
        id: aId,
        type: 'component',
        name: 'Card',
        x: 0, y: 200, width: 200, height: 120,
        fill: '#e2e8f0',
        reusable: true,
      },
      summary: 'Add Card component',
    });
    next = applyPatchToCanvas(next, {
      op: 'place_instance',
      shapeId: 'nested-badge',
      componentId: bId,
      shape: { x: 12, y: 12, parentId: aId },
      summary: 'Place nested Badge inside Card',
    });
    // Place an instance of A at the root.
    next = applyPatchToCanvas(next, {
      op: 'place_instance',
      shapeId: 'inst-a',
      componentId: aId,
      shape: { x: 400, y: 100 },
      summary: 'Place Card instance',
    });
    return { doc: next, aId, bId, bTextId };
  }

  it('renders the nested component instance as primitives, not a rectangle', () => {
    const { doc } = docWithNestedRef();
    const shapes = doc.shapes;
    const instA = shapes.find((s) => s.id === 'inst-a');
    expect(instA).toBeDefined();
    // The nested ref → B must have been expanded: inst-a's child is B's clone
    // (type 'component' — B's own type), NOT a placeholder rectangle.
    const nested = shapes.find((s) => s.parentId === 'inst-a');
    expect(nested).toBeDefined();
    expect(nested!.type).toBe('component');
    expect(nested!.type).not.toBe('rectangle');
    expect(nested!.componentId).toBe('badge-comp');
    // ...and B's text child is actually rendered as a text shape.
    const badgeText = shapes.find((s) => s.parentId === nested!.id && s.type === 'text');
    expect(badgeText).toBeDefined();
    expect(badgeText!.text).toBe('Badge');
  });

  it('assigns fresh, unique ids to the nested instance descendants', () => {
    const { doc } = docWithNestedRef();
    const shapes = doc.shapes;
    const allIds = shapes.map((s) => s.id);
    // No duplicate ids in the resolved output (the renderer dedupes by id —
    // duplicates would silently mask data).
    expect(new Set(allIds).size).toBe(allIds.length);
    // The nested B-instance root got a FRESH id (not B's component id, not
    // the source nested-ref id, not inst-a's id).
    const nested = shapes.find((s) => s.parentId === 'inst-a')!;
    expect(nested!.id).not.toBe('badge-comp');
    expect(nested!.id).not.toBe('nested-badge');
    expect(nested!.id).not.toBe('inst-a');
    // Its text child also got a fresh id (not B's source text id).
    const badgeText = shapes.find((s) => s.parentId === nested!.id && s.type === 'text')!;
    expect(badgeText!.id).not.toBe('badge-label');
    // The source components render with their own ids (no collision with the
    // nested clone).
    expect(shapes.filter((s) => s.id === 'badge-comp').length).toBe(1);
  });

  it('applies instance overrides that target the nested ref (root override lands on the expansion)', () => {
    const { doc, aId } = docWithNestedRef();
    // Override the nested ref node itself (by its source id inside A) —
    // the override must land on the EXPANDED B-instance root.
    const next = applyPatchToCanvas(doc, {
      op: 'set_instance_override',
      shapeId: 'inst-a',
      descendantPath: 'nested-badge',
      override: { fill: '#ff0000' },
      summary: 'Recolor nested badge',
    });
    const nested = next.shapes.find((s) => s.parentId === 'inst-a');
    expect(nested).toBeDefined();
    expect(nested!.fill).toBe('#ff0000');
    // Sanity: the main component A is untouched.
    expect(next.shapes.find((s) => s.id === aId)!.fill).toBe('#e2e8f0');
  });

  it('detached instances bake the nested ref too (no raw refs survive)', () => {
    const { doc } = docWithNestedRef();
    const next = applyPatchToCanvas(doc, {
      op: 'detach_instance',
      shapeId: 'inst-a',
      summary: 'Detach Card instance',
    });
    // Walk the detached subtree — no node may remain type 'ref'.
    const detached = next.children.find((c) => c.id === 'inst-a')!;
    expect(detached!.type).not.toBe('ref');
    const refNodes: string[] = [];
    const walk = (nodes: PenChild[]) => {
      for (const n of nodes) {
        if (n.type === 'ref') refNodes.push(n.id);
        if ('children' in n && Array.isArray((n as { children?: PenChild[] }).children)) {
          walk((n as { children: PenChild[] }).children);
        }
      }
    };
    walk([detached]);
    expect(refNodes).toEqual([]);
  });

  it('leaves a self-referencing component unexpanded past the cycle guard (no infinite loop)', () => {
    // Component Ouroboros contains a ref to ITSELF.
    let next = createEmptyCanvasDocument('test');
    next = applyPatchToCanvas(next, {
      op: 'create_component',
      shapeId: 'ouro',
      shape: {
        id: 'ouro',
        type: 'component',
        name: 'Ouroboros',
        x: 0, y: 0, width: 100, height: 100,
        fill: '#818cf8',
        reusable: true,
      },
      summary: 'Add self-referencing component',
    });
    next = applyPatchToCanvas(next, {
      op: 'place_instance',
      shapeId: 'self-ref',
      componentId: 'ouro',
      shape: { x: 10, y: 10, parentId: 'ouro' },
      summary: 'Place self reference',
    });
    next = applyPatchToCanvas(next, {
      op: 'place_instance',
      shapeId: 'inst-ouro',
      componentId: 'ouro',
      shape: { x: 500, y: 500 },
      summary: 'Place Ouroboros instance',
    });
    // Resolution terminates and emits a bounded number of shapes: the
    // instance root + exactly one level of expansion (the inner self-ref is
    // cut by the cycle guard and renders as a rectangle).
    const instShapes = next.shapes.filter((s) => s.id === 'inst-ouro' || isDescendantOf(next.shapes, s.id, 'inst-ouro'));
    expect(instShapes.length).toBe(2); // inst root + one rectangle placeholder (cycle cut immediately)
    const placeholder = instShapes.find((s) => s.type === 'rectangle');
    expect(placeholder).toBeDefined();
    // The whole document resolves without blowing up.
    expect(next.shapes.length).toBeGreaterThan(0);
  });
});

/// Is `shapeId` a (transitive) descendant of `ancestorId` in the flat shape list?
function isDescendantOf(shapes: Array<{ id: string; parentId?: string | null }>, shapeId: string, ancestorId: string): boolean {
  let current = shapes.find((s) => s.id === shapeId);
  while (current && current.parentId) {
    if (current.parentId === ancestorId) return true;
    current = shapes.find((s) => s.id === current!.parentId);
  }
  return false;
}
