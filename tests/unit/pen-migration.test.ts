// .pen 2.17 → 3.0 migration suite (spec §10.2 #2 / Appendix G §G.1).
//
// A rich 2.17 fixture (nested auto-layout frames, gradients, image fills,
// shadows + blur, per-corner radii, text with textGrowth, disabled nodes,
// 2 theme axes × 2 values, bound tokens, a component + ref instance,
// constraints) migrates to the Figma-canonical v3 form. Asserts:
//   - the version stamp becomes '3.0',
//   - EVERY G.1 row's canonical field lands (with legacy dual-carry kept),
//   - generated collection/variable/mode ids are NAME-DERIVED (deterministic),
//   - migrate(migrate(x)) ≡ migrate(x)  (idempotence),
//   - serialize → deserialize → migrate → semantic equality (round-trip),
//   - the RESOLVER produces identical geometry before/after migration
//     (the runtime-identical proof for the dual-field window),
//   - export writes v3 / import migrates-on-read (converters wiring).

import { describe, it, expect } from 'vitest';
import { migratePenDocument, isV3Document } from '@/lib/pen/migrate';
import { canvasToPen, penToCanvas, serializePenDocument } from '@/lib/pen/converters';
import { resolvePenTree } from '@/lib/pen/resolve';
import type { PenDocument, PenChild } from '@/lib/pen/types';
import type { CanvasDocument } from '@/lib/canvas/types';

// ---- The 2.17 fixture --------------------------------------------------------

function makeLegacyDoc(): PenDocument {
  return {
    version: '2.17',
    themes: {
      mode: ['light', 'dark'],
      density: ['comfortable', 'compact'],
    },
    variables: {
      'color.primary': {
        type: 'color',
        value: [
          { value: '#2563eb', theme: {} },
          { value: '#1d4ed8', theme: { mode: 'dark' } },
          { value: '#3b82f6', theme: { density: 'compact' } },
        ],
      },
      'color.surface': { type: 'color', value: '#f8fafc' },
      'spacing.card': { type: 'number', value: 24 },
      'text.greeting': { type: 'string', value: 'Hello' },
      'flag.enabled': { type: 'boolean', value: true },
    },
    children: [
      {
        type: 'frame',
        id: 'card',
        name: 'Card',
        x: 40,
        y: 60,
        width: 320,
        height: 'fit_content',
        layout: 'vertical',
        gap: 12,
        padding: [16, 24, 20, 24],
        justifyContent: 'space_between',
        alignItems: 'center',
        fill: '#ffffff',
        stroke: '#e2e8f0',
        strokeWidth: 1,
        effect: { type: 'shadow', shadowType: 'outer', offset: { x: 0, y: 4 }, blur: 12, spread: 0, color: '#0f172a33' },
        cornerRadius: [8, 12, 16, 20],
        theme: { mode: 'dark' },
        tokenBinding: { fillToken: 'color.surface' },
        children: [
          {
            type: 'text',
            id: 'title',
            name: 'Title',
            content: 'Pricing',
            fontSize: 24,
            fill: '#0f172a',
            textGrowth: 'fixed-width',
            width: 200,
          },
          {
            type: 'rectangle',
            id: 'banner',
            name: 'Banner',
            width: 280,
            height: 80,
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
          {
            type: 'rectangle',
            id: 'photo',
            name: 'Photo',
            width: 280,
            height: 120,
            fill: { type: 'image', url: './photo.jpg', mode: 'fill' },
          },
          {
            type: 'rectangle',
            id: 'overlay',
            name: 'Overlay',
            width: 100,
            height: 40,
            fill: '#00000055',
            effect: { type: 'blur', radius: 6 },
            layoutPosition: 'absolute',
            x: 10,
            y: 10,
            enabled: false,
            constraints: { horizontal: 'right', vertical: 'bottom' },
          } as any,
        ],
      } as any,
      {
        type: 'component',
        id: 'button',
        name: 'Button',
        reusable: true,
        x: 400,
        y: 60,
        width: 120,
        height: 36,
        fill: '#2563eb',
        cornerRadius: 6,
        children: [
          { type: 'text', id: 'button-label', name: 'Label', content: 'Buy now', fill: '#ffffff', fontSize: 14 },
        ],
      },
      {
        type: 'ref',
        id: 'button-instance',
        name: 'Button instance',
        ref: 'button',
        x: 400,
        y: 120,
        descendants: {
          'button-label': { content: 'Subscribe' },
        },
      },
    ],
  };
}

function findNode(children: PenChild[], id: string): any {
  for (const c of children) {
    if (c.id === id) return c;
    const kids = (c as any).children;
    if (Array.isArray(kids)) {
      const found = findNode(kids, id);
      if (found) return found;
    }
  }
  return undefined;
}

// ---- G.1 row-by-row ----------------------------------------------------------

describe('pen-migration — G.1 field renames on the rich fixture', () => {
  const migrated = migratePenDocument(makeLegacyDoc());
  const card = findNode(migrated.children, 'card');
  const title = findNode(migrated.children, 'title');
  const overlay = findNode(migrated.children, 'overlay');
  const banner = findNode(migrated.children, 'banner');
  const photo = findNode(migrated.children, 'photo');
  const instance = findNode(migrated.children, 'button-instance');

  it('stamps version 3.0 (and isV3Document recognizes it)', () => {
    expect(migrated.version).toBe('3.0');
    expect(isV3Document(migrated)).toBe(true);
    expect(isV3Document(makeLegacyDoc())).toBe(false);
  });

  it('row 1: layout → layoutMode', () => {
    expect(card.layoutMode).toBe('VERTICAL');
    expect(card.layout).toBe('vertical'); // dual-carry
  });

  it('row 2: gap → itemSpacing', () => {
    expect(card.itemSpacing).toBe(12);
    expect(card.gap).toBe(12);
  });

  it('row 3: padding tuple → paddingLeft/Right/Top/Bottom', () => {
    expect(card.paddingTop).toBe(16);
    expect(card.paddingRight).toBe(24);
    expect(card.paddingBottom).toBe(20);
    expect(card.paddingLeft).toBe(24);
    expect(card.padding).toEqual([16, 24, 20, 24]);
  });

  it('rows 4–5: justifyContent/alignItems → primary/counterAxisAlignItems', () => {
    expect(card.primaryAxisAlignItems).toBe('SPACE_BETWEEN');
    expect(card.counterAxisAlignItems).toBe('CENTER');
    expect(card.justifyContent).toBe('space_between');
    expect(card.alignItems).toBe('center');
  });

  it('row 6: fit_content/fill_container → layoutSizingHorizontal/Vertical', () => {
    expect(card.layoutSizingVertical).toBe('HUG');
    expect(card.layoutSizingHorizontal).toBe('FIXED'); // explicit number
    expect(card.width).toBe(320);
    expect(card.height).toBe('fit_content');
  });

  it('row 7: layoutPosition → layoutPositioning', () => {
    expect(overlay.layoutPositioning).toBe('ABSOLUTE');
    expect(overlay.layoutPosition).toBe('absolute');
  });

  it('row 8: fill string → fills: [{type:SOLID, color}]', () => {
    expect(card.fills).toEqual([{ type: 'SOLID', color: '#ffffff' }]);
    expect(card.fill).toBe('#ffffff');
  });

  it('row 9: gradient fill → typed paint entry with stops + handles', () => {
    const paint = banner.fills[0];
    expect(paint.type).toBe('GRADIENT_LINEAR');
    expect(paint.gradientStops).toEqual([
      { position: 0, color: '#ff0000' },
      { position: 1, color: '#0000ff' },
    ]);
    // 90° → top→bottom per the spec formula.
    expect(paint.gradientHandlePositions[0].x).toBeCloseTo(0.5);
    expect(paint.gradientHandlePositions[0].y).toBeCloseTo(0);
    expect(paint.gradientHandlePositions[1].x).toBeCloseTo(0.5);
    expect(paint.gradientHandlePositions[1].y).toBeCloseTo(1);
  });

  it('row 10: image fill → IMAGE paint with scaleMode', () => {
    expect(photo.fills[0]).toMatchObject({ type: 'IMAGE', scaleMode: 'FILL', imageRef: './photo.jpg' });
  });

  it('row 11: stroke/strokeWidth → strokes + strokeWeight', () => {
    expect(card.strokes).toEqual([{ type: 'SOLID', color: '#e2e8f0' }]);
    expect(card.strokeWeight).toBe(1);
    expect(card.stroke).toBe('#e2e8f0');
    expect(card.strokeWidth).toBe(1);
  });

  it('rows 12–13: shadow + blur → typed effects entries', () => {
    expect(card.effects).toMatchObject([
      { type: 'DROP_SHADOW', offset: { x: 0, y: 4 }, radius: 12, spread: 0, color: '#0f172a33' },
    ]);
    expect(overlay.effects).toMatchObject([{ type: 'LAYER_BLUR', radius: 6 }]);
  });

  it('row 14: cornerRadius tuple → rectangleCornerRadii [TL,TR,BR,BL]', () => {
    expect(card.rectangleCornerRadii).toEqual([8, 12, 16, 20]);
    expect(card.cornerRadius).toEqual([8, 12, 16, 20]); // legacy kept verbatim
  });

  it('rows 15–16: content → characters; textGrowth → textAutoResize', () => {
    expect(title.characters).toBe('Pricing');
    expect(title.content).toBe('Pricing');
    expect(title.textAutoResize).toBe('NONE'); // fixed-width
    expect(title.textGrowth).toBe('fixed-width');
  });

  it('row 17: enabled → visible', () => {
    expect(overlay.visible).toBe(false);
    expect(overlay.enabled).toBe(false);
  });

  it('row 18: themes axes → variableCollections with modes + defaultModeId', () => {
    const cols = migrated.variableCollections!;
    expect(cols).toHaveLength(2);
    const mode = cols.find((c) => c.id === 'col:mode')!;
    expect(mode.name).toBe('mode');
    expect(mode.modes).toEqual([
      { modeId: 'mode:mode:light', name: 'light' },
      { modeId: 'mode:mode:dark', name: 'dark' },
    ]);
    expect(mode.defaultModeId).toBe('mode:mode:light');
    const density = cols.find((c) => c.id === 'col:density')!;
    expect(density.modes).toEqual([
      { modeId: 'mode:density:comfortable', name: 'comfortable' },
      { modeId: 'mode:density:compact', name: 'compact' },
    ]);
    // Legacy themes map kept (dual-carry).
    expect(migrated.themes).toEqual(makeLegacyDoc().themes);
  });

  it('row 19: variables $key map → id’d records with valuesByMode', () => {
    const records = migrated.variableRecords!;
    expect(records).toHaveLength(5);

    const primary = records.find((r) => r.id === 'var:color.primary')!;
    expect(primary.name).toBe('color.primary');
    expect(primary.resolvedType).toBe('COLOR');
    expect(primary.variableCollectionId).toBe('col:mode');
    expect(primary.valuesByMode).toEqual({
      'mode:mode:light': '#2563eb',    // default covers light
      'mode:mode:dark': '#1d4ed8',     // themed entry
      'mode:density:compact': '#3b82f6', // cross-axis entry (documented approximation)
    });

    const surface = records.find((r) => r.id === 'var:color.surface')!;
    expect(surface.resolvedType).toBe('COLOR');
    expect(surface.variableCollectionId).toBe('col:mode');
    expect(surface.valuesByMode).toEqual({
      'mode:mode:light': '#f8fafc',
      'mode:mode:dark': '#f8fafc',
    });

    expect(records.find((r) => r.id === 'var:spacing.card')!.resolvedType).toBe('FLOAT');
    expect(records.find((r) => r.id === 'var:text.greeting')!.resolvedType).toBe('STRING');
    expect(records.find((r) => r.id === 'var:flag.enabled')!.resolvedType).toBe('BOOLEAN');

    // Legacy variables map kept (dual-carry — the runtime resolver reads it).
    expect(migrated.variables).toEqual(makeLegacyDoc().variables);
  });

  it('row 20: node theme → explicitVariableModes {collectionId: modeId}', () => {
    expect(card.explicitVariableModes).toEqual({ 'col:mode': 'mode:mode:dark' });
    expect(card.theme).toEqual({ mode: 'dark' });
  });

  it('row 21: tokenBinding → boundVariables alias arrays', () => {
    expect(card.boundVariables).toEqual({
      fills: [{ type: 'VARIABLE_ALIAS', id: 'var:color.surface' }],
    });
    expect(card.tokenBinding).toEqual({ fillToken: 'color.surface' });
  });

  it('row 22: constraints lowercase → SCREAMING', () => {
    expect(overlay.constraints).toEqual({ horizontal: 'RIGHT', vertical: 'BOTTOM' });
  });

  it('row 23: PenRef.ref → componentId (descendants kept)', () => {
    expect(instance.componentId).toBe('button');
    expect(instance.ref).toBe('button');
    expect(instance.descendants).toEqual({ 'button-label': expect.objectContaining({ content: 'Subscribe' }) });
  });

  it('row 25: group nodes default to PASS_THROUGH blending', () => {
    const doc: PenDocument = {
      version: '2.17',
      children: [
        { type: 'group', id: 'g1', children: [] } as PenChild,
        { type: 'frame', id: 'f1', children: [] } as PenChild,
      ],
    };
    const m = migratePenDocument(doc);
    expect(findNode(m.children, 'g1').blendMode).toBe('PASS_THROUGH');
    expect(findNode(m.children, 'f1').blendMode).toBeUndefined();
  });
});

// ---- Determinism / idempotence / round-trip ----------------------------------

describe('pen-migration — determinism + idempotence', () => {
  it('generated ids are name-derived (no clock/random)', () => {
    const a = migratePenDocument(makeLegacyDoc());
    expect(a.variableCollections!.map((c) => c.id)).toEqual(['col:mode', 'col:density']);
    expect(a.variableRecords!.map((r) => r.id)).toEqual([
      'var:color.primary', 'var:color.surface', 'var:spacing.card', 'var:text.greeting', 'var:flag.enabled',
    ]);
  });

  it('migrate(migrate(x)) ≡ migrate(x) — full deep equality', () => {
    const once = migratePenDocument(makeLegacyDoc());
    const twice = migratePenDocument(once);
    expect(twice).toEqual(once);
  });

  it('migration is a pure function (input document not mutated)', () => {
    const original = makeLegacyDoc();
    const snapshot = JSON.stringify(original);
    migratePenDocument(original);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it('a v3 document passes through untouched (same reference)', () => {
    const v3 = migratePenDocument(makeLegacyDoc());
    expect(migratePenDocument(v3)).toBe(v3);
  });

  it('migrating two independently-built fixtures yields identical output', () => {
    expect(migratePenDocument(makeLegacyDoc())).toEqual(migratePenDocument(makeLegacyDoc()));
  });
});

describe('pen-migration — serialize → deserialize → migrate round-trip', () => {
  it('semantic equality: node count, geometry, fills, variables, component relations', () => {
    const source = makeLegacyDoc();
    const migrated = migratePenDocument(source);

    // Serialize the MIGRATED file, re-parse, re-migrate (no-op) — semantic
    // content survives the file round-trip.
    const text = serializePenDocument(migrated);
    const reparsed = JSON.parse(text) as PenDocument;
    expect(reparsed.version).toBe('3.0');
    expect(migratePenDocument(reparsed)).toEqual(migrated);

    // Node count + ids identical.
    const ids = (doc: PenDocument) => JSON.stringify(doc, (k, v) => (k === 'fills' || k === 'strokes' || k === 'effects' ? undefined : v));
    expect(ids(reparsed)).toBe(ids(migrated));

    // Geometry: every node keeps x/y/width/height.
    for (const id of ['card', 'title', 'banner', 'photo', 'button', 'button-instance']) {
      const before = findNode(source.children, id);
      const after = findNode(reparsed.children, id);
      expect(after.x).toBe(before.x);
      expect(after.y).toBe(before.y);
      expect(after.width).toBe(before.width);
      expect(after.height).toBe(before.height);
    }

    // Fills survive (legacy + v3 projection agree).
    const cardAfter = findNode(reparsed.children, 'card');
    expect(cardAfter.fill).toBe('#ffffff');
    expect(cardAfter.fills[0].color).toBe('#ffffff');

    // Variables + component relations survive.
    expect(reparsed.variables).toEqual(source.variables);
    expect(findNode(reparsed.children, 'button-instance').ref).toBe('button');
    expect(findNode(reparsed.children, 'button-instance').componentId).toBe('button');
  });
});

// ---- Runtime-identical proof (the dual-field window's core safety net) -------

describe('pen-migration — resolver equivalence (runtime identical)', () => {
  function toCanvas(doc: PenDocument): CanvasDocument {
    return {
      id: 'test',
      name: 'test',
      version: doc.version,
      themes: doc.themes,
      variables: doc.variables,
      children: doc.children,
      viewport: { zoom: 1, panX: 0, panY: 0 },
      background: '#ffffff',
      shapes: [],
      tokens: { colors: [], textStyles: [] },
    } as CanvasDocument;
  }

  it('resolving the migrated document yields IDENTICAL geometry to the 2.17 original', () => {
    const original = makeLegacyDoc();
    const migrated = migratePenDocument(original);

    const before = resolvePenTree(toCanvas(original));
    const after = resolvePenTree(toCanvas(migrated));

    // Same layer count and order (ref-instance clones get fresh RANDOM ids at
    // every resolve — per-index comparison, plus stable-id spot checks).
    expect(after).toHaveLength(before.length);
    const stableIds = ['card', 'title', 'banner', 'photo', 'overlay', 'button', 'button-instance'];
    for (const id of stableIds) {
      expect(after.some((s) => s.id === id)).toBe(true);
    }
    for (let i = 0; i < before.length; i++) {
      const a = before[i];
      const b = after[i];
      expect({ x: b.x, y: b.y, w: b.width, h: b.height }).toEqual({
        x: a.x, y: a.y, w: a.width, h: a.height,
      });
      // Legacy render fields byte-identical (fill/text/shadow/radii/visibility).
      expect(b.fill).toBe(a.fill);
      expect(b.text).toBe(a.text);
      expect(b.shadow).toEqual(a.shadow);
      expect(b.radii).toEqual(a.radii);
      expect(b.visible).toBe(a.visible);
      expect(b.autoLayout).toEqual(a.autoLayout);
    }
  });

  it('constraint-cased (SCREAMING) nodes resolve identically to lowercase ones', () => {
    const base = [
      {
        type: 'frame',
        id: 'p',
        width: 300,
        height: 200,
        layout: 'none',
        children: [
          { type: 'rectangle', id: 'c-lo', x: 10, y: 20, width: 50, height: 40, constraints: { horizontal: 'right', vertical: 'bottom' } },
          { type: 'rectangle', id: 'c-up', x: 10, y: 20, width: 50, height: 40, constraints: { horizontal: 'RIGHT', vertical: 'BOTTOM' } },
        ],
      },
    ] as unknown as PenChild[];
    const doc = {
      id: 't', name: 't', version: '2.17', children: base,
      viewport: { zoom: 1, panX: 0, panY: 0 }, background: '#fff',
      shapes: [], tokens: { colors: [], textStyles: [] },
    } as CanvasDocument;
    const layers = resolvePenTree(doc);
    const lo = layers.find((s) => s.id === 'c-lo')!;
    const up = layers.find((s) => s.id === 'c-up')!;
    expect({ x: up.x, y: up.y }).toEqual({ x: lo.x, y: lo.y });
  });
});

// ---- Converter wiring (export writes v3 / import migrates on read) -----------

describe('pen-migration — converter wiring', () => {
  it('canvasToPen writes v3 (version 3.0 + canonical fields + legacy kept)', () => {
    const canvas = penToCanvas(makeLegacyDoc(), 'doc-1');
    // Simulate the pre-Phase-6 store state: a 2.17 doc with runtime fields.
    const legacyCanvas: CanvasDocument = {
      ...canvas,
      version: '2.17',
    };
    const pen = canvasToPen(legacyCanvas);
    expect(pen.version).toBe('3.0');
    expect(findNode(pen.children, 'card').itemSpacing).toBe(12);
    expect(pen.variableCollections).toBeDefined();
    // Legacy dual-carry still in the file → old code can load it.
    expect(findNode(pen.children, 'card').gap).toBe(12);
    expect(pen.themes).toEqual(makeLegacyDoc().themes);
  });

  it('penToCanvas migrates-on-read (2.17 → 3.0 in the store) and keeps pages in sync', () => {
    const doc = makeLegacyDoc();
    (doc as any).pages = [{ id: 'p1', name: 'Page 1', children: doc.children }];
    (doc as any).activePageIndex = 0;

    const canvas = penToCanvas(doc, 'imported');
    expect(canvas.version).toBe('3.0');
    expect(findNode(canvas.children, 'card').layoutMode).toBe('VERTICAL');
    expect(canvas.variableCollections).toHaveLength(2);
    expect(canvas.variableRecords).toHaveLength(5);
    // The active page mirror stays reference-identical to the page's tree.
    expect(canvas.children).toBe(canvas.pages![0].children);
  });

  it('penToCanvas leaves v3 documents untouched (no double migration)', () => {
    const v3 = migratePenDocument(makeLegacyDoc());
    const canvas = penToCanvas(v3, 'imported');
    expect(canvas.version).toBe('3.0');
    expect(JSON.stringify(canvas.children)).toBe(JSON.stringify(v3.children));
  });
});
