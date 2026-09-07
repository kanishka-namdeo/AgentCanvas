// UI abuse-pattern hardening tests (worklog Task 12-d → 12-f, 2026-09-07).
//
// Covers the canvas direct-input guards landed in the 12-d fix pass:
//   1. Mega-paste caps in clipboard.ts (raw size / shape count / per-shape
//      validation) — a 50k-shape / 100MB paste used to freeze the tab in
//      JSON.parse + bulk_add's O(N²) insertNode before any server cap ran.
//   2. SVG export attribute escaping (escapeAttr) — pasted/imported shape
//      fields used to be interpolated UNESCAPED into the .svg download.
//   3. Raster export clamp math (computeRasterSize) — the PNG fallback used
//      to allocate bbox × scale with no pixel cap or NaN guard.
//   4. .pen import caps — MAX_NODES lowered 50k → 20k (aligns with the HTTP
//      canvasState cap) + the 25MB client-side file-size gate.
//
// Pure-helper tests only — component behavior (DomChrome handle suppression,
// PropertiesPanel Map lookups, islands image placeholder) is exercised by the
// existing renderer/interaction suites.

import { describe, it, expect } from 'vitest';
import {
  serializeShapes,
  deserializeShapes,
  offsetShapes,
  MAX_PASTE_RAW_CHARS,
  MAX_PASTE_SHAPES,
} from '@/lib/canvas/clipboard';
import {
  escapeAttr,
  computeRasterSize,
  exportSvg,
  MAX_RASTER_PIXELS,
  RASTER_TIMEOUT_MS,
} from '@/lib/canvas/export';
import { MAX_NODES, validatePenDocument } from '@/lib/pen/types';
import { MAX_PEN_IMPORT_BYTES } from '@/components/canvas/PenFileMenu';
import type { Shape } from '@/lib/canvas/types';

function makeShape(overrides: Partial<Shape> = {}): Shape {
  return {
    id: overrides.id ?? 's1',
    type: overrides.type ?? 'rectangle',
    name: overrides.name ?? 'Shape',
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    width: overrides.width ?? 100,
    height: overrides.height ?? 100,
    rotation: overrides.rotation ?? 0,
    opacity: overrides.opacity ?? 1,
    fill: overrides.fill ?? '#e2e8f0',
    stroke: overrides.stroke ?? '#0f172a',
    strokeWidth: overrides.strokeWidth ?? 0,
    radius: overrides.radius ?? 0,
    fontSize: overrides.fontSize ?? 16,
    textColor: overrides.textColor ?? '#0f172a',
    parentId: overrides.parentId ?? null,
    zIndex: overrides.zIndex ?? 0,
    locked: overrides.locked ?? false,
    visible: overrides.visible ?? true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 12-d#1 — mega-paste caps (clipboard.ts deserializeShapes)
// ---------------------------------------------------------------------------

describe('paste caps: raw payload size', () => {
  it('rejects a raw payload over MAX_PASTE_RAW_CHARS before JSON.parse', () => {
    // Valid JSON, valid kind, valid shapes — ONLY the size cap can reject it
    // (proves the guard fires before the parser, where the freeze lived).
    const payload = JSON.stringify({
      kind: 'shape',
      version: 1,
      shapes: [makeShape()],
      pad: 'x'.repeat(MAX_PASTE_RAW_CHARS),
    });
    expect(payload.length).toBeGreaterThan(MAX_PASTE_RAW_CHARS);
    expect(deserializeShapes(payload)).toEqual([]);
  });

  it('pins the raw cap at 2,000,000 chars', () => {
    expect(MAX_PASTE_RAW_CHARS).toBe(2_000_000);
  });

  it('still parses payloads at/under the cap', () => {
    const shapes = [makeShape({ id: 'ok' })];
    const json = serializeShapes(shapes);
    expect(json.length).toBeLessThanOrEqual(MAX_PASTE_RAW_CHARS);
    expect(deserializeShapes(json).map((s) => s.id)).toEqual(['ok']);
  });
});

describe('paste caps: shape count', () => {
  it('rejects arrays with more than MAX_PASTE_SHAPES entries', () => {
    const tooMany = Array.from({ length: MAX_PASTE_SHAPES + 1 }, (_, i) => ({
      id: `s${i}`,
      type: 'rectangle',
    }));
    const json = JSON.stringify({ kind: 'shape', version: 1, shapes: tooMany });
    expect(json.length).toBeLessThan(MAX_PASTE_RAW_CHARS); // raw cap not the trigger
    expect(deserializeShapes(json)).toEqual([]);
  });

  it('accepts exactly MAX_PASTE_SHAPES entries', () => {
    const atCap = Array.from({ length: MAX_PASTE_SHAPES }, (_, i) => ({
      id: `s${i}`,
      type: 'rectangle',
    }));
    const back = deserializeShapes(
      JSON.stringify({ kind: 'shape', version: 1, shapes: atCap }),
    );
    expect(back).toHaveLength(MAX_PASTE_SHAPES);
  });

  it('pins the count cap at 2,000', () => {
    expect(MAX_PASTE_SHAPES).toBe(2_000);
  });
});

describe('paste caps: per-shape validation', () => {
  it('drops malformed entries and keeps the good ones', () => {
    const good = makeShape({ id: 'good', type: 'ellipse' });
    const json = JSON.stringify({
      kind: 'shape',
      version: 1,
      shapes: [
        good,
        null,
        42,
        'not-a-shape',
        { id: 'no-type' },
        { type: 'rectangle' },
        { id: '', type: 'rectangle' },
        { id: 'no-kind', kind: 'rectangle' },
      ],
    });
    const back = deserializeShapes(json);
    expect(back).toHaveLength(1);
    expect(back[0].id).toBe('good');
  });

  it('fails the paste ([]) when ALL entries are dropped', () => {
    const json = JSON.stringify({
      kind: 'shape',
      version: 1,
      shapes: [null, 42, { id: 'x' }],
    });
    expect(deserializeShapes(json)).toEqual([]);
  });

  it('a good small paste still round-trips end-to-end', () => {
    const shapes = [
      makeShape({ id: 'a', x: 10 }),
      makeShape({ id: 'b', parentId: 'a' }),
    ];
    const pasted = deserializeShapes(serializeShapes(shapes));
    expect(pasted.map((s) => s.id)).toEqual(['a', 'b']);
    // The paste path (offset + fresh ids) still works on validated output.
    const offset = offsetShapes(pasted, 24, 24, true);
    expect(offset).toHaveLength(2);
    expect(offset[1].parentId).toBe(offset[0].id);
  });
});

// ---------------------------------------------------------------------------
// 12-d#6 — SVG export attribute injection (export.ts escapeAttr)
// ---------------------------------------------------------------------------

describe('escapeAttr', () => {
  it('escapes double quotes', () => {
    expect(escapeAttr('x"y')).toBe('x&quot;y');
  });

  it('escapes angle brackets', () => {
    expect(escapeAttr('<b>')).toBe('&lt;b&gt;');
  });

  it('escapes ampersands (first, so no double-escaping of entities)', () => {
    expect(escapeAttr('a & b')).toBe('a &amp; b');
    expect(escapeAttr('&"')).toBe('&amp;&quot;');
  });

  it('neutralizes a full attribute-breakout payload', () => {
    const attack = 'x"><script>alert(1)</script>';
    const escaped = escapeAttr(attack);
    expect(escaped).toBe('x&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escaped).not.toMatch(/["<>]/);
  });

  it('leaves ordinary color values untouched', () => {
    expect(escapeAttr('#0ea5e9')).toBe('#0ea5e9');
    expect(escapeAttr('rgba(0,0,0,0.102)')).toBe('rgba(0,0,0,0.102)');
    expect(escapeAttr('')).toBe('');
  });
});

describe('exportSvg attribute escaping (integration)', () => {
  it('escapes a hostile fill instead of injecting markup into the .svg', () => {
    const s = makeShape({ id: 'evil', fill: 'x"><script>alert(1)</script>' });
    const svg = exportSvg([s]) ?? '';
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('fill="x&quot;&gt;&lt;script&gt;');
  });

  it('escapes a hostile image href', () => {
    const s = makeShape({
      id: 'evil-img',
      type: 'image',
      src: 'javascript:alert(1)" onload="steal(',
    });
    const svg = exportSvg([s]) ?? '';
    expect(svg).not.toContain('" onload="');
    expect(svg).toContain('href="javascript:alert(1)&quot;');
  });

  it('escapes hostile gradient stop colors', () => {
    const s = makeShape({
      id: 'evil-grad',
      gradient: {
        type: 'linear',
        angle: 90,
        stops: [
          { offset: 0, color: '#fff"><script>' },
          { offset: 1, color: '#000' },
        ],
      },
    });
    const svg = exportSvg([s]) ?? '';
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('stop-color="#fff&quot;&gt;&lt;script&gt;"');
  });
});

// ---------------------------------------------------------------------------
// 12-d#5 — export raster bomb (export.ts computeRasterSize)
// ---------------------------------------------------------------------------

describe('computeRasterSize', () => {
  it('pins the pixel budget at 64MP and the timeout at 30s', () => {
    expect(MAX_RASTER_PIXELS).toBe(64_000_000);
    expect(RASTER_TIMEOUT_MS).toBe(30_000);
  });

  it('passes through in-budget rasters unchanged', () => {
    const r = computeRasterSize(100, 100, 2);
    expect(r).toEqual({ width: 200, height: 200, scale: 2 });
  });

  it('reduces scale when the requested raster exceeds the 64MP budget', () => {
    // 10000 × 10000 at scale 2 = 400MP — 6.25× over budget.
    const r = computeRasterSize(10_000, 10_000, 2);
    expect(r).not.toBeNull();
    expect(r!.scale).toBeLessThan(2);
    expect(r!.width * r!.height).toBeLessThanOrEqual(MAX_RASTER_PIXELS);
    expect(r!.width).toBe(8_000); // sqrt(64e6 / 1e8) = 0.8 → 8000 × 8000
    expect(r!.height).toBe(8_000);
  });

  it('clamps non-square bboxes too (aspect preserved, product ≤ budget)', () => {
    // 20000 × 1000 at scale 2 = 80MP — over budget.
    const r = computeRasterSize(20_000, 1_000, 2);
    expect(r).not.toBeNull();
    expect(r!.scale).toBeLessThan(2);
    expect(r!.width * r!.height).toBeLessThanOrEqual(MAX_RASTER_PIXELS);
    // Aspect ratio ~20:1 preserved by the uniform scale reduction.
    expect(r!.width / r!.height).toBeCloseTo(20, 0);
  });

  it('never INCREASES a small scale to fill the budget', () => {
    const r = computeRasterSize(10, 10, 0.5);
    expect(r).toEqual({ width: 5, height: 5, scale: 0.5 });
  });

  it('treats a non-finite/invalid scale as 1 (no NaN allocation)', () => {
    expect(computeRasterSize(100, 100, Number.NaN)).toEqual({
      width: 100,
      height: 100,
      scale: 1,
    });
    expect(computeRasterSize(100, 100, 0)).toEqual({
      width: 100,
      height: 100,
      scale: 1,
    });
  });

  it('NaN bbox guard: returns null for non-finite or non-positive dims', () => {
    expect(computeRasterSize(Number.NaN, 100, 2)).toBeNull();
    expect(computeRasterSize(100, Number.NaN, 2)).toBeNull();
    expect(computeRasterSize(Number.POSITIVE_INFINITY, 100, 2)).toBeNull();
    expect(computeRasterSize(100, Number.NEGATIVE_INFINITY, 2)).toBeNull();
    expect(computeRasterSize(0, 100, 2)).toBeNull();
    expect(computeRasterSize(-5, 100, 2)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 12-d#8 — .pen import caps (pen/types.ts MAX_NODES + PenFileMenu size gate)
// ---------------------------------------------------------------------------

describe('.pen import caps', () => {
  it('MAX_NODES is 20,000 (aligned with the HTTP canvasState cap)', () => {
    expect(MAX_NODES).toBe(20_000);
  });

  it('client-side file-size gate is 25MB', () => {
    expect(MAX_PEN_IMPORT_BYTES).toBe(25_000_000);
  });

  it('validatePenDocument rejects a document well over 20k nodes', () => {
    // 25k nodes (the walk's count check fires once nodeCount passes
    // MAX_NODES, so use a comfortably-over value, not a boundary one).
    const children = Array.from({ length: 25_000 }, (_, i) => ({
      type: 'frame',
      id: `f${i}`,
    }));
    const result = validatePenDocument({ version: '2.17', children });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('Too many nodes'))).toBe(true);
  });

  it('validatePenDocument accepts a document at exactly 20k nodes', () => {
    const children = Array.from({ length: MAX_NODES }, (_, i) => ({
      type: 'frame',
      id: `f${i}`,
    }));
    expect(validatePenDocument({ version: '2.17', children }).ok).toBe(true);
  });
});
