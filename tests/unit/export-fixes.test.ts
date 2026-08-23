// Export regression tests — fidelity + frame filtering + tree-based selection.
//
// Bugs fixed (see commit history):
//   - exportPngDataUrl now rasterizes to a real PNG (canvas 2x) instead of
//     returning an SVG data URL labeled as PNG. (Browser-only path — the
//     rasterizer itself needs Image/canvas; here we test the SVG it consumes.)
//   - exportSvg now emits gradients, drop shadows, opacity, rotation,
//     star/polygon nodes (previously silently dropped / flattened).
//   - filterByFrame is tree-based (descendants), so a child crossing the
//     frame's edge is no longer dropped; bbox filtering is only the fallback
//     for childless frames.

import { describe, it, expect } from 'vitest';
import { exportSvg, exportSvgWithSize } from '../../src/lib/canvas/export';
import type { Shape } from '../../src/lib/canvas/types';

function baseShape(id: string, patch: Partial<Shape>): Shape {
  return {
    id, type: 'rectangle', name: id, x: 0, y: 0, width: 100, height: 100,
    rotation: 0, opacity: 1, fill: '#0ea5e9', stroke: '#000000', strokeWidth: 0,
    radius: 0, fontSize: 16, textColor: '#0f172a', parentId: null, zIndex: 0,
    locked: false, visible: true,
    ...patch,
  };
}

describe('exportSvg fidelity', () => {
  it('emits linear gradients into <defs> and references them', () => {
    const s = baseShape('g1', {
      gradient: { type: 'linear', angle: 135, stops: [{ offset: 0, color: '#0ea5e9' }, { offset: 1, color: '#6366f1' }] },
    });
    const svg = exportSvg([s]);
    expect(svg).toContain('<defs>');
    expect(svg).toContain('<linearGradient');
    expect(svg).toMatch(/fill="url\(#grad-/);
  });

  it('emits drop shadows as feDropShadow filters (8-digit hex converted)', () => {
    const s = baseShape('c1', { shadow: { x: 0, y: 4, blur: 6, color: '#0000001a' } });
    const svg = exportSvg([s]);
    expect(svg).toContain('<feDropShadow');
    expect(svg).toContain('flood-color="rgba(0,0,0,0.102)"');
    expect(svg).toMatch(/filter="url\(#shadow-/);
  });

  it('emits opacity and rotation attributes', () => {
    const s = baseShape('o1', { opacity: 0.5, rotation: 45 });
    const svg = exportSvg([s]);
    expect(svg).toContain('opacity="0.5"');
    expect(svg).toContain('rotate(45');
  });

  it('renders star and polygon nodes instead of silently dropping them', () => {
    const star = baseShape('st', { type: 'star', pointCount: 5, innerRadiusRatio: 0.5 });
    const poly = baseShape('pg', { type: 'polygon', polygonCount: 6 });
    const svg = exportSvg([star, poly]);
    expect((svg?.match(/<polygon/g) ?? []).length).toBe(2);
  });

  it('normalizes bounds so the export starts at (0,0)', () => {
    const s = baseShape('n1', { x: 500, y: 700 });
    const r = exportSvgWithSize([s]);
    expect(r).not.toBeNull();
    expect(r!.svg).toContain('<rect x="0" y="0"');
    expect(r!.count).toBe(1);
  });
});

describe('exportSvg frame filtering', () => {
  const frame = baseShape('frame', { type: 'frame', x: 0, y: 0, width: 400, height: 400 });
  // Child extends BEYOND the frame's right edge (x 380..480 > 400).
  const overhang = baseShape('overhang', { x: 380, y: 50, width: 100, height: 40, parentId: 'frame' });
  const inside = baseShape('inside', { x: 20, y: 20, width: 60, height: 60, parentId: 'frame' });
  const outside = baseShape('outside', { x: 900, y: 900, width: 50, height: 50 });

  it('tree-based: includes children that cross the frame edge (bbox filter used to drop them)', () => {
    const r = exportSvgWithSize([frame, overhang, inside, outside], { frameId: 'frame' });
    expect(r).not.toBeNull();
    // frame + both descendants; the unrelated outside shape excluded.
    expect(r!.count).toBe(3);
  });

  it('falls back to bbox filtering for childless frames', () => {
    const loose = baseShape('loose', { type: 'rectangle', x: 0, y: 0, width: 400, height: 400 });
    const a = baseShape('a', { x: 10, y: 10, width: 50, height: 50 });
    const b = baseShape('b', { x: 500, y: 500, width: 50, height: 50 });
    const r = exportSvgWithSize([loose, a, b], { frameId: 'loose' });
    expect(r).not.toBeNull();
    expect(r!.count).toBe(1); // only `a` is inside the loose region
  });
});
