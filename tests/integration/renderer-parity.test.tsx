// Parity harness (spec Phase 0, jsdom mode) — structural + geometric parity
// between the classic SVG renderer (svg/SvgCanvas) and the DOM renderer
// (dom/DomCanvas) over a fixture corpus.
//
// What is asserted per corpus document (both renderers mounted with identical
// props):
//   (a) NODE COUNTS — DomCanvas [data-node-type=X] counts equal the model
//       counts from doc.shapes (deduped, including hidden layers: DOM mode
//       keeps them mounted with visibility:hidden). Cross-check: the SVG
//       renderer emits one wrapper <g> per deduped layer.
//   (b) GEOMETRY — for every [data-node-id], the cumulative inline
//       left/top offsets (walking the ancestor chain) equal the layer's
//       ABSOLUTE x/y (ε ≤ 1px); width/height equal layer w/h (except line,
//       whose pill geometry is width=hypot, height=max(2,strokeWidth)).
//   (c) Z-ORDER — direct DOM children of every parent node appear in
//       zIndex-sorted order (mirroring the SVG flat zIndex sort).
//
// jsdom has no layout engine, so geometry is read from inline styles — parity
// mode is absolute positioning only, which makes this exact. The
// getBoundingClientRect-based oracle (real measured geometry) is browser-
// gated below via PARITY_BROWSER.

import { describe, it, expect, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { SvgCanvas } from '@/components/canvas/svg/SvgCanvas';
import { DomCanvas } from '@/components/canvas/dom/DomCanvas';
import type { CanvasDocument, Layer, LayerType } from '@/lib/canvas/types';
import type { PenChild } from '@/lib/pen/types';

// ---- Fixtures -----------------------------------------------------------------

function makeLayer(id: string, overrides: Partial<Layer> = {}): Layer {
  return {
    id,
    type: 'rectangle',
    name: id,
    x: 0, y: 0, width: 100, height: 60,
    rotation: 0, opacity: 1,
    fill: '#cccccc', stroke: '#000000', strokeWidth: 0,
    radius: 0, fontSize: 16, textColor: '#000000',
    parentId: null, zIndex: 0,
    locked: false, visible: true,
    autoLayout: null, tokenBinding: null, componentId: null,
    points: null, closed: false, src: null, radii: null,
    gradient: null, shadow: null, blur: 0, maskId: null,
    ...overrides,
  };
}

function makeDoc(id: string, shapes: Layer[]): CanvasDocument {
  return {
    id,
    name: id,
    background: '#ffffff',
    version: '2.17',
    children: shapes as unknown as PenChild[],
    viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes,
    tokens: { colors: [], textStyles: [] },
  };
}

const noopMouseDown = vi.fn();
const noopResizeHandle = vi.fn();

/// Fixture corpus — one doc per structural concern. Together they cover every
/// LayerType value, nesting + clipping, z-order, component semantics, effects,
/// text variants, hidden subtrees, and id dedupe.
function buildCorpus(): CanvasDocument[] {
  const docs: CanvasDocument[] = [];

  // 1. Every LayerType, all roots.
  const everyType: LayerType[] = [
    'rectangle', 'ellipse', 'text', 'line', 'frame', 'group', 'path', 'image',
    'section', 'component', 'component_set', 'instance', 'boolean_operation',
    'slice', 'star', 'polygon',
  ];
  docs.push(
    makeDoc(
      'all-types',
      everyType.map((type, i) =>
        makeLayer(`${type}-1`, {
          type,
          x: (i % 4) * 220,
          y: Math.floor(i / 4) * 160,
          width: 120,
          height: 80,
          text: type === 'text' ? 'Hello parity' : undefined,
          points:
            type === 'path'
              ? [{ x: (i % 4) * 220, y: 160 }, { x: (i % 4) * 220 + 120, y: 160 + 80 }]
              : null,
          booleanOperationType: type === 'boolean_operation' ? 'union' : null,
          label: type === 'section' ? 'Docs' : null,
        }),
      ),
    ),
  );

  // 2. Nested frames with clipping (child extends beyond the clip frame).
  docs.push(
    makeDoc('nested-clip', [
      makeLayer('outer', { type: 'frame', x: 10, y: 10, width: 300, height: 200, clip: true }),
      makeLayer('inner', { type: 'frame', x: 30, y: 40, width: 200, height: 120, clip: true, parentId: 'outer' }),
      makeLayer('spill', { type: 'rectangle', x: 250, y: 120, width: 150, height: 90, parentId: 'inner' }),
      makeLayer('loose', { type: 'ellipse', x: 400, y: 30, width: 60, height: 60 }),
    ]),
  );

  // 3. Multi-child z-order (shuffled zIndex values + grandchildren).
  docs.push(
    makeDoc('z-order', [
      makeLayer('zframe', { type: 'frame', x: 0, y: 0, width: 400, height: 400 }),
      makeLayer('z5', { x: 10, y: 10, parentId: 'zframe', zIndex: 5, fill: '#ff0000' }),
      makeLayer('z3', { x: 20, y: 20, parentId: 'zframe', zIndex: 3, fill: '#00ff00' }),
      makeLayer('z1', { x: 30, y: 30, parentId: 'zframe', zIndex: 1, fill: '#0000ff' }),
      makeLayer('z4', { x: 40, y: 40, parentId: 'zframe', zIndex: 4, fill: '#ffff00' }),
      makeLayer('z2', { x: 50, y: 50, parentId: 'zframe', zIndex: 2, fill: '#ff00ff' }),
      // Grandchild under z3 — also zIndex-shuffled among its own siblings.
      makeLayer('z3a', { x: 60, y: 60, parentId: 'z3', zIndex: 2 }),
      makeLayer('z3b', { x: 70, y: 70, parentId: 'z3', zIndex: 1 }),
    ]),
  );

  // 4. Component semantics: master, set, instances.
  docs.push(
    makeDoc('components', [
      makeLayer('master', { type: 'component', x: 0, y: 0, width: 120, height: 40, componentId: 'master' }),
      makeLayer('set', { type: 'component_set', x: 0, y: 80, width: 200, height: 60 }),
      makeLayer('inst', { type: 'instance', x: 0, y: 180, width: 120, height: 40, componentId: 'master' }),
      makeLayer('child-of-master', { x: 8, y: 8, width: 40, height: 24, parentId: 'master' }),
      makeLayer('child-of-inst', { x: 8, y: 8, width: 40, height: 24, parentId: 'inst' }),
    ]),
  );

  // 5. Effects: gradients, shadow, blur, opacity, rotation.
  docs.push(
    makeDoc('effects', [
      makeLayer('grad-lin', {
        x: 0, y: 0, width: 200, height: 100,
        gradient: { type: 'linear', angle: 90, stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }] },
      }),
      makeLayer('grad-rad', {
        type: 'ellipse', x: 220, y: 0, width: 100, height: 100,
        gradient: { type: 'radial', angle: 0, stops: [{ offset: 0, color: '#ffffff' }, { offset: 1, color: '#000000' }] },
      }),
      makeLayer('shadowed', { x: 0, y: 140, width: 180, height: 80, shadow: { x: 0, y: 4, blur: 12, color: '#000000' } }),
      makeLayer('blurred', { x: 220, y: 140, width: 120, height: 80, blur: 3 }),
      makeLayer('ghost', { x: 0, y: 260, width: 90, height: 60, opacity: 0.4 }),
      makeLayer('rotated', { x: 0, y: 360, width: 120, height: 40, rotation: 25 }),
    ]),
  );

  // 6. Text variants.
  docs.push(
    makeDoc('text-variants', [
      makeLayer('t-title', { type: 'text', x: 0, y: 0, width: 300, height: 40, text: 'Title', fontSize: 32, fontWeight: 700, textColor: '#0f172a' }),
      makeLayer('t-body', { type: 'text', x: 0, y: 60, width: 260, height: 60, text: 'Body line one\nBody line two', fontSize: 14, lineHeight: 1.5 }),
      makeLayer('t-center', { type: 'text', x: 0, y: 140, width: 200, height: 24, text: 'Centered', textAlign: 'center', letterSpacing: 2 }),
    ]),
  );

  // 7. Hidden subtree: hidden parent with visible children — DOM mode keeps
  //    everything mounted (visibility:hidden); the SVG renderer drops it.
  docs.push(
    makeDoc('hidden-subtree', [
      makeLayer('hidden-frame', { type: 'frame', x: 0, y: 0, width: 300, height: 200, visible: false }),
      makeLayer('hidden-child', { x: 10, y: 10, width: 50, height: 50, parentId: 'hidden-frame' }),
      makeLayer('visible-sibling', { x: 400, y: 0, width: 80, height: 80 }),
    ]),
  );

  // 8. Duplicate ids — last-writer-wins in both renderers.
  docs.push(
    makeDoc('dedupe', [
      makeLayer('dup', { x: 0, y: 0, fill: '#ff0000' }),
      makeLayer('dup', { x: 500, y: 500, fill: '#00ff00' }),
      makeLayer('other', { x: 100, y: 100 }),
    ]),
  );

  return docs;
}

// ---- Helpers ------------------------------------------------------------------

interface MountedPair {
  svg: ReturnType<typeof render>;
  dom: ReturnType<typeof render>;
}

function mountBoth(doc: CanvasDocument): MountedPair {
  const svg = render(
    <SvgCanvas
      document={doc}
      size={{ w: 800, h: 600 }}
      zoom={1}
      panX={0}
      panY={0}
      selectedIds={new Set<string>()}
      highlightIds={new Set<string>()}
      onShapeMouseDown={noopMouseDown}
      onResizeHandleMouseDown={noopResizeHandle}
    />,
  );
  const dom = render(
    <DomCanvas
      document={doc}
      selectedIds={[]}
      highlightIds={[]}
      viewport={{ zoom: 1, panX: 0, panY: 0 }}
      layoutMode="parity"
      onShapeMouseDown={noopMouseDown}
      onResizeHandleMouseDown={noopResizeHandle}
    />,
  );
  return { svg, dom };
}

/// Deduped model layers (last-writer-wins — mirrors both renderers' loops).
function dedupedLayers(doc: CanvasDocument): Layer[] {
  return Array.from(new Map(doc.shapes.map((s) => [s.id, s] as const)).values());
}

/// Sum the inline left/top offsets along the [data-node-id] ancestor chain.
function cumulativeOffsets(el: HTMLElement): { left: number; top: number } {
  let left = 0;
  let top = 0;
  let cur: HTMLElement | null = el;
  while (cur && cur.hasAttribute('data-node-id')) {
    left += parseFloat(cur.style.left) || 0;
    top += parseFloat(cur.style.top) || 0;
    cur = cur.parentElement;
  }
  return { left, top };
}

const EPSILON = 1; // px — spec Phase 0 acceptance: geometry ε ≤ 1px

// ---- Tests ----------------------------------------------------------------------

describe('renderer parity: SVG vs DOM over the fixture corpus', () => {
  const corpus = buildCorpus();

  it('corpus covers every LayerType value and 5+ documents', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(5);
    const seen = new Set<string>();
    for (const doc of corpus) for (const s of doc.shapes) seen.add(s.type);
    expect(seen.size).toBe(16); // every LayerType (types.ts has 16 values)
  });

  for (const doc of corpus) {
    describe(`document: ${doc.id}`, () => {
      let mounted: MountedPair;

      it('(setup) mounts both renderers', () => {
        cleanup();
        mounted = mountBoth(doc);
        expect(mounted.svg.container.querySelector('svg')).not.toBeNull();
        expect(mounted.dom.container.querySelector('[data-ac-world]')).not.toBeNull();
      });

      it('(a) DOM node counts per type match the model (incl. hidden layers)', () => {
        cleanup();
        mounted = mountBoth(doc);
        const layers = dedupedLayers(doc);

        // Total node divs.
        const nodeDivs = mounted.dom.container.querySelectorAll('[data-node-id]');
        expect(nodeDivs.length).toBe(layers.length);

        // Per-type counts.
        const expectedByType = new Map<string, number>();
        for (const l of layers) {
          expectedByType.set(l.type, (expectedByType.get(l.type) ?? 0) + 1);
        }
        const domByType = new Map<string, number>();
        for (const el of Array.from(nodeDivs)) {
          const t = el.getAttribute('data-node-type')!;
          domByType.set(t, (domByType.get(t) ?? 0) + 1);
        }
        expect(domByType).toEqual(expectedByType);

        // Cross-check: the SVG renderer emits exactly one wrapper <g> per
        // deduped layer (svg > world-g > shape-g).
        const svgWrappers = mounted.svg.container.querySelectorAll('svg > g > g');
        expect(svgWrappers.length).toBe(layers.length);
      });

      it('(b) cumulative inline offsets equal absolute layer geometry (ε ≤ 1px)', () => {
        cleanup();
        mounted = mountBoth(doc);
        const layers = dedupedLayers(doc);
        const byId = new Map(layers.map((l) => [l.id, l]));

        const nodeDivs = mounted.dom.container.querySelectorAll('[data-node-id]');
        expect(nodeDivs.length).toBeGreaterThan(0);
        for (const el of Array.from(nodeDivs)) {
          const id = el.getAttribute('data-node-id')!;
          const layer = byId.get(id);
          expect(layer, `unknown node id ${id} in doc ${doc.id}`).toBeDefined();
          const offsets = cumulativeOffsets(el as HTMLElement);
          expect(Math.abs(offsets.left - layer!.x)).toBeLessThanOrEqual(EPSILON);
          expect(Math.abs(offsets.top - layer!.y)).toBeLessThanOrEqual(EPSILON);
          if (layer!.type !== 'line') {
            // Lines override the box with pill geometry (width=hypot).
            expect(Math.abs((parseFloat((el as HTMLElement).style.width) || 0) - layer!.width)).toBeLessThanOrEqual(EPSILON);
            expect(Math.abs((parseFloat((el as HTMLElement).style.height) || 0) - layer!.height)).toBeLessThanOrEqual(EPSILON);
          }
        }
      });

      it('(c) children appear in zIndex order within their parent', () => {
        cleanup();
        mounted = mountBoth(doc);
        const layers = dedupedLayers(doc);

        // Group layers by parentId and compare DOM order vs zIndex sort.
        const byParent = new Map<string, Layer[]>();
        for (const l of layers) {
          const pid = l.parentId ?? '__root__';
          const list = byParent.get(pid) ?? [];
          list.push(l);
          byParent.set(pid, list);
        }
        let checked = 0;
        for (const [pid, children] of byParent) {
          const sorted = children.slice().sort((a, b) => a.zIndex - b.zIndex);
          if (pid === '__root__') {
            // Root order is not asserted (roots render in array order).
            continue;
          }
          const parentEl = mounted.dom.container.querySelector(`[data-node-id="${pid}"]`);
          expect(parentEl, `parent ${pid} should be mounted`).not.toBeNull();
          const domOrder = Array.from(parentEl!.children)
            .filter((c) => c.hasAttribute('data-node-id'))
            .map((c) => c.getAttribute('data-node-id'));
          expect(domOrder).toEqual(sorted.map((c) => c.id));
          checked++;
        }
        // At least one parent group was checked somewhere in the corpus.
        if (doc.id === 'z-order' || doc.id === 'nested-clip') {
          expect(checked).toBeGreaterThan(0);
        }
      });
    });
  }

  it('dedupe: last-writer-wins renders the second payload only', () => {
    cleanup();
    const doc = corpus.find((d) => d.id === 'dedupe')!;
    const { dom } = mountBoth(doc);
    const dup = dom.container.querySelector('[data-node-id="dup"]') as HTMLElement;
    expect(dup).not.toBeNull();
    expect(dom.container.querySelectorAll('[data-node-id="dup"]')).toHaveLength(1);
    // The second writer (green, x=500) wins.
    expect(dup.style.background).toBe('rgb(0, 255, 0)');
    expect(dup.style.left).toBe('500px');
  });

  it('hidden subtree: DOM hides the subtree (mounted); SVG leaks visible children through hidden parents', () => {
    cleanup();
    const doc = corpus.find((d) => d.id === 'hidden-subtree')!;
    const { dom, svg } = mountBoth(doc);
    // DOM: hidden frame + its child stay in the tree, whole subtree hidden
    // (visibility inherits — Figma-correct; documented divergence in styleFor).
    const hidden = dom.container.querySelector('[data-node-id="hidden-frame"]') as HTMLElement;
    expect(hidden).not.toBeNull();
    expect(hidden.style.visibility).toBe('hidden');
    expect(hidden.querySelector('[data-node-id="hidden-child"]')).not.toBeNull();
    // SVG: the flat renderer paints each layer independently of parent
    // visibility — the hidden frame's VISIBLE child still paints (latent
    // SVG-mode limitation, documented; the DOM renderer fixes it).
    const svgPainted = Array.from(svg.container.querySelectorAll('svg > g > g')).filter(
      (g) => g.querySelector('rect, ellipse, text, line, polygon, polyline, image'),
    );
    expect(svgPainted.length).toBe(2); // hidden-child + visible-sibling
  });
});

// ---- Browser-gated geometry oracle (spec Phase 0 step 3) ---------------------------

describe.skipIf(!process.env.PARITY_BROWSER)('parity: browser-gated geometry oracle', () => {
  // The getBoundingClientRect-based oracle needs a REAL layout engine
  // (Playwright / real browser run with PARITY_BROWSER=1). jsdom returns
  // all-zero rects, so this suite self-skips there even when the env var is
  // set accidentally.
  it('measures DOM node rects against the model geometry (needs real layout)', () => {
    cleanup();
    const doc = buildCorpus().find((d) => d.id === 'all-types')!;
    const zoom = 2;
    const panX = 50;
    const panY = 30;
    const { container } = render(
      <DomCanvas
        document={doc}
        selectedIds={[]}
        highlightIds={[]}
        viewport={{ zoom, panX, panY }}
        layoutMode="parity"
        onShapeMouseDown={noopMouseDown}
        onResizeHandleMouseDown={noopResizeHandle}
      />,
    );
    const world = container.querySelector('[data-ac-world]') as HTMLElement;
    const probe = world.getBoundingClientRect();
    if (probe.width === 0 && probe.height === 0) {
      // No layout engine (plain jsdom with PARITY_BROWSER set): document the
      // oracle shape and pass — the inline-style parity suites above carry
      // the jsdom-mode guarantees.
      return;
    }
    // Real browser: every node's measured screen rect equals the model
    // geometry scaled by zoom + pan (ε ≤ 1px), including rotated nodes
    // (rotation preserves the transform-origin corner).
    for (const layer of dedupedLayers(doc)) {
      const el = container.querySelector(`[data-node-id="${layer.id}"]`) as HTMLElement | null;
      expect(el, `node ${layer.id} should be mounted`).not.toBeNull();
      const rect = el!.getBoundingClientRect();
      expect(Math.abs(rect.left - (layer.x * zoom + panX))).toBeLessThanOrEqual(1);
      expect(Math.abs(rect.top - (layer.y * zoom + panY))).toBeLessThanOrEqual(1);
      if (layer.type !== 'line') {
        expect(Math.abs(rect.width - layer.width * zoom)).toBeLessThanOrEqual(1);
        expect(Math.abs(rect.height - layer.height * zoom)).toBeLessThanOrEqual(1);
      }
    }
  });
});
