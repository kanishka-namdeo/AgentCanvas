// Resolver dual-field output (spec Phase 6 part 1, §9.3 #3 — dual-field window).
//
// resolvePenTree emits BOTH the legacy `Shape` fields (unchanged — the 860
// pre-existing tests depend on them) and the v3 mirrors (`layoutMode`,
// `itemSpacing`, `characters`, `effects`, `fills`, …). This test proves:
//   - legacy fields carry EXACTLY the pre-Phase-6 values (regression),
//   - v3 mirrors are semantically equal to their legacy sources,
//   - patch-inserted nodes (add/bulk_add) dual-carry from creation,
//   - the align/set_constraints ops accept canonical spellings.

import { describe, it, expect } from 'vitest';
import { resolvePenTree } from '@/lib/pen/resolve';
import { applyPatchToCanvas } from '@/lib/canvas/patch';
import { createEmptyCanvasDocument } from '@/lib/canvas/types';
import type { CanvasDocument } from '@/lib/canvas/types';
import type { PenChild, PenDocument } from '@/lib/pen/types';

function makeDoc(children: PenChild[]): CanvasDocument {
  return {
    id: 'doc',
    name: 'Test',
    version: '2.17',
    children,
    viewport: { zoom: 1, panX: 0, panY: 0 },
    background: '#ffffff',
    shapes: [],
    tokens: { colors: [], textStyles: [] },
  } as CanvasDocument;
}

const frame: PenChild = {
  type: 'frame',
  id: 'f1',
  name: 'Stack',
  x: 0,
  y: 0,
  width: 'fit_content',
  height: 300,
  layout: 'vertical',
  gap: 16,
  padding: [10, 20],
  justifyContent: 'center',
  alignItems: 'end',
  fill: '#ffffff',
  children: [
    {
      type: 'text',
      id: 't1',
      name: 'Greeting',
      content: 'Hello world',
      fill: '#0f172a',
      fontSize: 18,
      textGrowth: 'auto',
      width: 'fit_content',
    },
    {
      type: 'rectangle',
      id: 'r1',
      name: 'Shadowed',
      width: 120,
      height: 60,
      fill: '#93c5fd',
      cornerRadius: [4, 8, 12, 16],
      effect: {
        type: 'shadow',
        shadowType: 'outer',
        offset: { x: 2, y: 4 },
        blur: 8,
        spread: 1,
        color: '#00000040',
      },
    },
    {
      type: 'rectangle',
      id: 'g1',
      name: 'Gradient',
      width: 120,
      height: 40,
      fill: {
        type: 'gradient',
        gradientType: 'linear',
        rotation: 90,
        colors: [
          { color: '#ff0000', position: 0 },
          { color: '#0000ff', position: 1 },
        ],
      },
    },
  ],
} as unknown as PenChild;

describe('resolve-v3 — dual-field Layer output', () => {
  const layers = resolvePenTree(makeDoc([frame]));
  const f1 = layers.find((s) => s.id === 'f1')!;
  const t1 = layers.find((s) => s.id === 't1')!;
  const r1 = layers.find((s) => s.id === 'r1')!;
  const g1 = layers.find((s) => s.id === 'g1')!;

  it('emits all four layers', () => {
    expect(layers.map((s) => s.id)).toEqual(['f1', 't1', 'r1', 'g1']);
  });

  it('frame: legacy autoLayout EXACTLY as before (regression)', () => {
    expect(f1.autoLayout).toEqual({
      direction: 'vertical',
      gap: 16,
      padding: 0, // legacy field collapses a padding TUPLE to 0 (pre-Phase-6 behavior)
      alignX: 'center',
      alignY: 'max',
    });
  });

  it('frame: v3 mirrors are semantically equal (and MORE precise than legacy)', () => {
    expect(f1.layoutMode).toBe('VERTICAL');
    expect(f1.itemSpacing).toBe(16);
    expect(f1.paddingTop).toBe(10);
    expect(f1.paddingBottom).toBe(10);
    expect(f1.paddingLeft).toBe(20);
    expect(f1.paddingRight).toBe(20);
    expect(f1.primaryAxisAlignItems).toBe('CENTER');
    expect(f1.counterAxisAlignItems).toBe('MAX');
    expect(f1.layoutSizingHorizontal).toBe('HUG'); // fit_content
    expect(f1.layoutSizingVertical).toBe('FIXED'); // explicit number
    expect(f1.fills).toEqual([{ type: 'SOLID', color: '#ffffff' }]);
  });

  it('text: legacy text field unchanged; v3 characters mirror set', () => {
    expect(t1.text).toBe('Hello world');
    expect(t1.characters).toBe('Hello world');
    expect(t1.textAutoResize).toBe('WIDTH_AND_HEIGHT'); // textGrowth: 'auto'
    expect(t1.fills).toEqual([{ type: 'SOLID', color: '#0f172a' }]);
  });

  it('shadow: legacy shadow object unchanged; v3 effects entry typed', () => {
    expect(r1.shadow).toEqual({
      x: 2,
      y: 4,
      blur: 8,
      color: '#00000040',
      spread: 1,
      inset: false,
    });
    expect(r1.effects).toEqual([
      {
        type: 'DROP_SHADOW',
        offset: { x: 2, y: 4 },
        radius: 8,
        spread: 1,
        color: '#00000040',
      },
    ]);
  });

  it('radii: legacy radii object unchanged; v3 rectangleCornerRadii [TL,TR,BR,BL]', () => {
    expect(r1.radii).toEqual({ topLeft: 4, topRight: 8, bottomRight: 12, bottomLeft: 16 });
    expect(r1.rectangleCornerRadii).toEqual([4, 8, 12, 16]);
    expect(r1.radius).toBe(4); // legacy scalar = first tuple element
  });

  it('gradient: legacy gradient object unchanged; v3 fills entry typed', () => {
    expect(g1.gradient).toEqual({
      type: 'linear',
      angle: 90,
      stops: [
        { offset: 0, color: '#ff0000' },
        { offset: 1, color: '#0000ff' },
      ],
    });
    expect(g1.fills).toHaveLength(1);
    expect(g1.fills![0].type).toBe('GRADIENT_LINEAR');
    expect((g1.fills![0] as any).gradientStops).toEqual([
      { position: 0, color: '#ff0000' },
      { position: 1, color: '#0000ff' },
    ]);
    const handles = (g1.fills![0] as any).gradientHandlePositions as Array<{ x: number; y: number }>;
    expect(handles[0].x).toBeCloseTo(0.5);
    expect(handles[0].y).toBeCloseTo(0);
    expect(handles[1].x).toBeCloseTo(0.5);
    expect(handles[1].y).toBeCloseTo(1);
  });

  it('v3 fields stay absent when no source exists (no noise on plain rects)', () => {
    const plain = resolvePenTree(makeDoc([
      { type: 'rectangle', id: 'p1', width: 10, height: 10, fill: '#fff' } as PenChild,
    ]))[0];
    expect(plain.layoutMode).toBeUndefined();
    expect(plain.itemSpacing).toBeUndefined();
    expect(plain.characters).toBeUndefined();
    expect(plain.textAutoResize).toBeUndefined();
    expect(plain.effects).toBeUndefined();
    expect(plain.rectangleCornerRadii).toBeUndefined();
    // fills always carries the resolved paint (SOLID from the resolved fill).
    expect(plain.fills).toEqual([{ type: 'SOLID', color: '#fff' }]);
  });

  it('migrated (v3-source) nodes resolve to the same mirrors', () => {
    // Build the same frame with v3 fields ONLY (as a migrated file would carry
    // them) and verify the mirrors still populate.
    const v3Frame = {
      type: 'frame',
      id: 'f2',
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      layout: 'vertical',
      gap: 8,
      layoutMode: 'VERTICAL',
      itemSpacing: 8,
      paddingTop: 4,
      paddingBottom: 4,
      paddingLeft: 6,
      paddingRight: 6,
      primaryAxisAlignItems: 'MIN',
      counterAxisAlignItems: 'CENTER',
      layoutSizingHorizontal: 'FIXED',
      layoutSizingVertical: 'FIXED',
    } as unknown as PenChild;
    const layer = resolvePenTree(makeDoc([v3Frame]))[0];
    expect(layer.layoutMode).toBe('VERTICAL');
    expect(layer.itemSpacing).toBe(8);
    expect(layer.paddingTop).toBe(4);
    expect(layer.paddingLeft).toBe(6);
    expect(layer.primaryAxisAlignItems).toBe('MIN');
    expect(layer.counterAxisAlignItems).toBe('CENTER');
    expect(layer.layoutSizingHorizontal).toBe('FIXED');
    expect(layer.layoutSizingVertical).toBe('FIXED');
  });
});

describe('resolve-v3 — patch-inserted nodes dual-carry from creation', () => {
  it('add op: legacy payload fields populate v3 mirrors on the stored node', () => {
    let doc = createEmptyCanvasDocument('t');
    doc = applyPatchToCanvas(doc, {
      op: 'add',
      shapeId: 'n1',
      shape: {
        id: 'n1',
        type: 'frame',
        layout: 'horizontal',
        gap: 10,
        padding: 5,
        justifyContent: 'end',
        fill: '#123456',
        text: 'nope',
      } as any,
      summary: 'add frame',
    });
    const node = doc.children[0] as any;
    expect(node.layoutMode).toBe('HORIZONTAL');
    expect(node.itemSpacing).toBe(10);
    expect(node.paddingLeft).toBe(5);
    expect(node.primaryAxisAlignItems).toBe('MAX');
    expect(node.fills).toEqual([{ type: 'SOLID', color: '#123456' }]);
    // Legacy fields intact.
    expect(node.layout).toBe('horizontal');
    expect(node.gap).toBe(10);
    expect(node.padding).toBe(5);
    // And the resolved layer carries the mirrors too.
    const layer = doc.shapes.find((s) => s.id === 'n1')!;
    expect(layer.layoutMode).toBe('HORIZONTAL');
    expect(layer.itemSpacing).toBe(10);
  });
});

describe('resolve-v3 — canonical patch vocabulary accepted', () => {
  function docWith3Rects(): CanvasDocument {
    let doc = createEmptyCanvasDocument('t');
    const mk = (id: string, x: number) => ({
      op: 'add' as const,
      shapeId: id,
      shape: { id, type: 'rectangle', x, y: 0, width: 100, height: 50, fill: '#fff' } as any,
      summary: `add ${id}`,
    });
    doc = applyPatchToCanvas(doc, mk('a', 0));
    doc = applyPatchToCanvas(doc, mk('b', 50));
    doc = applyPatchToCanvas(doc, mk('c', 200));
    return doc;
  }

  it('alignKind canonical spellings behave exactly like the legacy aliases', () => {
    const legacy = applyPatchToCanvas(docWith3Rects(), {
      op: 'align', shapeIds: ['a', 'b', 'c'], alignKind: 'center_h', summary: 'legacy center_h',
    });
    const canonical = applyPatchToCanvas(docWith3Rects(), {
      op: 'align', shapeIds: ['a', 'b', 'c'], alignKind: 'HCENTER', summary: 'canonical HCENTER',
    });
    expect(canonical.shapes.map((s) => s.x)).toEqual(legacy.shapes.map((s) => s.x));
  });

  it('TIDY behaves as DISTRIBUTE_H for now (Phase 7 lands real grid semantics)', () => {
    const tidy = applyPatchToCanvas(docWith3Rects(), {
      op: 'align', shapeIds: ['a', 'b', 'c'], alignKind: 'TIDY', summary: 'tidy',
    });
    const dist = applyPatchToCanvas(docWith3Rects(), {
      op: 'align', shapeIds: ['a', 'b', 'c'], alignKind: 'DISTRIBUTE_H', summary: 'distribute',
    });
    expect(tidy.shapes.map((s) => s.x)).toEqual(dist.shapes.map((s) => s.x));
  });

  it('set_constraints accepts SCREAMING input; stored legacy; resolves identically', () => {
    let doc = docWith3Rects();
    doc = applyPatchToCanvas(doc, {
      op: 'set_constraints',
      shapeId: 'a',
      constraints: { horizontal: 'LEFT_RIGHT', vertical: 'TOP_BOTTOM' },
      summary: 'canonical constraints',
    });
    // Stored in the legacy spelling (legacy readers match on it).
    expect((doc.children[0] as any).constraints).toEqual({ horizontal: 'left_right', vertical: 'top_bottom' });
    // …and the canonical spelling is accepted without error:
    doc = applyPatchToCanvas(doc, {
      op: 'set_constraints',
      shapeId: 'b',
      constraints: { horizontal: 'RIGHT', vertical: 'CENTER' },
      summary: 'canonical right/center',
    });
    expect((doc.children[1] as any).constraints).toEqual({ horizontal: 'right', vertical: 'center' });
  });
});

describe('resolve-v3 — serialize/pen round-trip through the store path', () => {
  it('a resolved doc exports as v3 and re-imports with identical resolved geometry', async () => {
    const { canvasToPen, penToCanvas } = await import('@/lib/pen/converters');
    const original = makeDoc([frame]);
    const exported = canvasToPen(original);
    expect(exported.version).toBe('3.0');

    const reimported = penToCanvas(JSON.parse(JSON.stringify(exported)) as PenDocument, 're');
    const before = resolvePenTree(original);
    const after = resolvePenTree(reimported);
    expect(after.map((s) => s.id)).toEqual(before.map((s) => s.id));
    for (let i = 0; i < before.length; i++) {
      expect({ x: after[i].x, y: after[i].y, w: after[i].width, h: after[i].height }).toEqual({
        x: before[i].x, y: before[i].y, w: before[i].width, h: before[i].height,
      });
      // v3 mirrors survive the round trip.
      expect(after[i].layoutMode).toBe(before[i].layoutMode);
      expect(after[i].itemSpacing).toBe(before[i].itemSpacing);
      expect(after[i].characters).toBe(before[i].characters);
      expect(after[i].effects).toEqual(before[i].effects);
    }
  });
});
