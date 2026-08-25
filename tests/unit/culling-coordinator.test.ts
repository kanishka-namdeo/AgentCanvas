// CullingCoordinator — Phase 4 L5 mount culling (spec §4.2) unit tests.
//
// Pure-math coverage (no React, no DOM, no rendering):
//   - computeCullingDecision budget gate (no-op below minNodeBudget)
//   - inner-margin → visible; outer-margin → culled; in-between → hysteresis
//   - hysteresis: previously-culled node stays culled until it crosses inner margin
//   - hysteresis: previously-visible node stays visible until it crosses outer margin
//   - zero-size layers never culled (degenerate / not-yet-measured)
//   - changed flag is true iff symmetric difference between prev and next is non-empty
//   - expandRect / rectsIntersect / viewportFromPanZoom pin the math
//   - rootLayerRects is a passthrough projection

import { describe, it, expect } from 'vitest';
import {
  computeCullingDecision,
  expandRect,
  rectsIntersect,
  viewportFromPanZoom,
  rootLayerRects,
  type ViewportRect,
  type LayerRect,
} from '@/components/canvas/dom/CullingCoordinator';

// ---- Helpers -----------------------------------------------------------------

const VP: ViewportRect = { x: 0, y: 0, width: 1000, height: 800 };

function makeLayer(id: string, x: number, y: number, w = 100, h = 100): LayerRect {
  return { id, x, y, width: w, height: h };
}

// ---- Tests --------------------------------------------------------------------

describe('CullingCoordinator budget gate', () => {
  it('no-ops (empty culled set) when node count is below the default 2000 budget', () => {
    const layers = [makeLayer('far', 100000, 100000)];
    const prev = new Set<string>(['far']);
    const r = computeCullingDecision(VP, layers, prev, 1999);
    expect(r.culledIds.size).toBe(0);
    expect(r.changed).toBe(true); // prev had 'far', now empty → changed
  });

  it('engages when node count meets the budget', () => {
    const layers = [makeLayer('far', 100000, 100000)];
    const r = computeCullingDecision(VP, layers, new Set(), 2000);
    expect(r.culledIds.has('far')).toBe(true);
  });

  it('respects a custom minNodeBudget', () => {
    const layers = [makeLayer('far', 5000, 5000)];
    const r = computeCullingDecision(VP, layers, new Set(), 50, { minNodeBudget: 50 });
    expect(r.culledIds.has('far')).toBe(true);
  });

  it('returns changed=false when budget gate no-ops on an already-empty prev set', () => {
    const layers = [makeLayer('far', 100000, 100000)];
    const r = computeCullingDecision(VP, layers, new Set(), 1999);
    expect(r.culledIds.size).toBe(0);
    expect(r.changed).toBe(false);
  });
});

describe('CullingCoordinator margins', () => {
  it('culls a layer far outside the outer margin (was visible, now culled)', () => {
    // Default margin=2 → inner=2000×1600; outer=3000×2400 (hysteresis=1.5).
    // A layer at (5000, 5000) is outside both → newly culled.
    const layers = [makeLayer('far', 5000, 5000)];
    const r = computeCullingDecision(VP, layers, new Set(), 5000);
    expect(r.culledIds.has('far')).toBe(true);
    expect(r.changed).toBe(true);
  });

  it('keeps a layer inside the inner margin visible (never culled)', () => {
    // inner margin = 2000×1600 centered on VP. A layer at (100, 100) is inside.
    const layers = [makeLayer('near', 100, 100)];
    const r = computeCullingDecision(VP, layers, new Set(), 5000);
    expect(r.culledIds.has('near')).toBe(false);
    expect(r.changed).toBe(false);
  });

  it('does not cull a layer that intersects the inner margin edge', () => {
    // Layer straddling the inner-margin top edge — still intersects → visible.
    const layers = [makeLayer('straddle', 500, -50, 100, 100)];
    const r = computeCullingDecision(VP, layers, new Set(), 5000);
    expect(r.culledIds.has('straddle')).toBe(false);
  });
});

describe('CullingCoordinator hysteresis', () => {
  it('previously-culled layer in the hysteresis zone STAYS culled', () => {
    // VP=(0,0,1000,800), center=(500,400). Inner margin = 2x → (-500,-400,2000,1600)
    // → X spans -500..1500, Y spans -400..1200.
    // Outer margin = 3x → (-1000,-800,3000,2400) → X spans -1000..2000, Y spans -800..1600.
    // A layer at x=1700 (X spans 1700..1800) is OUTSIDE inner (X>1500) but INSIDE outer (X<2000).
    const layers = [makeLayer('zone', 1700, 0)];
    const prev = new Set<string>(['zone']);
    const r = computeCullingDecision(VP, layers, prev, 5000);
    expect(r.culledIds.has('zone')).toBe(true);
    expect(r.changed).toBe(false); // no change
  });

  it('previously-VISIBLE layer in the hysteresis zone STAYS visible', () => {
    // Same zone as above; prev is empty (visible).
    const layers = [makeLayer('zone', 1700, 0)];
    const r = computeCullingDecision(VP, layers, new Set(), 5000);
    expect(r.culledIds.has('zone')).toBe(false);
    expect(r.changed).toBe(false);
  });

  it('previously-culled layer that re-enters inner margin becomes visible', () => {
    // Layer at (100, 100) inside inner; was culled in prev (race / pan-back).
    const layers = [makeLayer('back', 100, 100)];
    const prev = new Set<string>(['back']);
    const r = computeCullingDecision(VP, layers, prev, 5000);
    expect(r.culledIds.has('back')).toBe(false);
    expect(r.changed).toBe(true);
  });

  it('previously-visible layer that exits outer margin becomes culled', () => {
    // Layer far outside both margins; was visible in prev.
    const layers = [makeLayer('leaver', 10000, 10000)];
    const prev = new Set<string>(); // visible
    const r = computeCullingDecision(VP, layers, prev, 5000);
    expect(r.culledIds.has('leaver')).toBe(true);
    expect(r.changed).toBe(true);
  });

  it('previously-culled layer that re-enters outer (but not inner) margin STAYS culled', () => {
    // Hysteresis zone layer at x=1700 was culled, still in zone → stays culled.
    // This is the SAME as the first hysteresis test but explicit about the path:
    // the previous state was "culled" because the layer had been outside outer,
    // then moved back into the zone — hysteresis keeps it culled.
    const layers = [makeLayer('returner', 1700, 0)];
    const prev = new Set<string>(['returner']);
    const r = computeCullingDecision(VP, layers, prev, 5000);
    expect(r.culledIds.has('returner')).toBe(true);
    expect(r.changed).toBe(false);
  });
});

describe('CullingCoordinator zero-size layers', () => {
  it('never culls a zero-width layer', () => {
    const layers = [makeLayer('zero-w', 100000, 100000, 0, 100)];
    const r = computeCullingDecision(VP, layers, new Set(), 5000);
    expect(r.culledIds.has('zero-w')).toBe(false);
  });

  it('never culls a zero-height layer', () => {
    const layers = [makeLayer('zero-h', 100000, 100000, 100, 0)];
    const r = computeCullingDecision(VP, layers, new Set(), 5000);
    expect(r.culledIds.has('zero-h')).toBe(false);
  });
});

describe('CullingCoordinator changed flag', () => {
  it('returns changed=false when prev == next (identical sets)', () => {
    const layers = [makeLayer('far1', 100000, 100000), makeLayer('far2', 200000, 200000)];
    const prev = new Set<string>(['far1', 'far2']);
    const r = computeCullingDecision(VP, layers, prev, 5000);
    expect(r.culledIds.size).toBe(2);
    expect(r.changed).toBe(false);
  });

  it('returns changed=true when one new layer gets culled', () => {
    const layers = [makeLayer('far1', 100000, 100000), makeLayer('far2', 200000, 200000)];
    const prev = new Set<string>(['far1']);
    const r = computeCullingDecision(VP, layers, prev, 5000);
    expect(r.culledIds.has('far1')).toBe(true);
    expect(r.culledIds.has('far2')).toBe(true);
    expect(r.changed).toBe(true);
  });

  it('returns changed=true when one previously-culled layer re-enters viewport', () => {
    const layers = [makeLayer('back', 100, 100)]; // inside inner
    const prev = new Set<string>(['back']);
    const r = computeCullingDecision(VP, layers, prev, 5000);
    expect(r.culledIds.size).toBe(0);
    expect(r.changed).toBe(true);
  });

  it('returns changed=false when both prev and next are empty', () => {
    const layers = [makeLayer('near', 100, 100)]; // inside inner → visible
    const r = computeCullingDecision(VP, layers, new Set(), 5000);
    expect(r.culledIds.size).toBe(0);
    expect(r.changed).toBe(false);
  });
});

describe('CullingCoordinator pure helpers', () => {
  it('expandRect with multiplier 2.0 doubles both dimensions about the center', () => {
    const r = expandRect({ x: 0, y: 0, width: 100, height: 100 }, 2);
    expect(r.width).toBe(200);
    expect(r.height).toBe(200);
    expect(r.x).toBe(-50);
    expect(r.y).toBe(-50);
  });

  it('expandRect with multiplier 1.0 returns the same rect (no expansion)', () => {
    const r = expandRect({ x: 10, y: 20, width: 100, height: 200 }, 1);
    expect(r).toEqual({ x: 10, y: 20, width: 100, height: 200 });
  });

  it('expandRect with multiplier 1.5 = 1.5x size', () => {
    const r = expandRect({ x: 0, y: 0, width: 1000, height: 800 }, 1.5);
    expect(r.width).toBe(1500);
    expect(r.height).toBe(1200);
    expect(r.x).toBe(-250);
    expect(r.y).toBe(-200);
  });

  it('rectsIntersect: overlapping rects intersect', () => {
    expect(rectsIntersect({ x: 0, y: 0, width: 100, height: 100 }, { x: 50, y: 50, width: 100, height: 100 })).toBe(true);
  });

  it('rectsIntersect: touching edges intersect (zero-area overlap)', () => {
    expect(rectsIntersect({ x: 0, y: 0, width: 100, height: 100 }, { x: 100, y: 0, width: 100, height: 100 })).toBe(true);
  });

  it('rectsIntersect: disjoint rects do NOT intersect', () => {
    expect(rectsIntersect({ x: 0, y: 0, width: 100, height: 100 }, { x: 1000, y: 1000, width: 100, height: 100 })).toBe(false);
  });

  it('viewportFromPanZoom divides out zoom + pan', () => {
    // pan 100,200 / zoom 2 → canvas-space visible origin = (-50, -100), size = 2000/2, 1600/2.
    const vp = viewportFromPanZoom(100, 200, 2, 2000, 1600);
    expect(vp.x).toBe(-50);
    expect(vp.y).toBe(-100);
    expect(vp.width).toBe(1000);
    expect(vp.height).toBe(800);
  });

  it('viewportFromPanZoom handles zero zoom without dividing by zero', () => {
    const vp = viewportFromPanZoom(0, 0, 0, 1000, 800);
    expect(Number.isFinite(vp.x)).toBe(true);
    expect(Number.isFinite(vp.y)).toBe(true);
    expect(Number.isFinite(vp.width)).toBe(true);
    expect(Number.isFinite(vp.height)).toBe(true);
  });

  it('rootLayerRects projects id+x+y+w+h from roots', () => {
    const roots = [
      { id: 'a', x: 10, y: 20, width: 100, height: 200 },
      { id: 'b', x: 300, y: 400, width: 50, height: 60 },
    ];
    const r = rootLayerRects(roots);
    expect(r.length).toBe(2);
    expect(r[0]).toEqual({ id: 'a', x: 10, y: 20, width: 100, height: 200 });
    expect(r[1]).toEqual({ id: 'b', x: 300, y: 400, width: 50, height: 60 });
  });
});

describe('CullingCoordinator multi-layer integration', () => {
  it('mixes visible + culled layers in one pass', () => {
    const layers = [
      makeLayer('near', 100, 100), // inside inner → visible
      makeLayer('far', 100000, 100000), // outside outer → culled
      makeLayer('zone', 1700, 0), // hysteresis zone, prev empty → visible
      makeLayer('zero', 5000, 5000, 0, 100), // zero-size → never culled
    ];
    const r = computeCullingDecision(VP, layers, new Set(), 5000);
    expect(r.culledIds.has('near')).toBe(false);
    expect(r.culledIds.has('far')).toBe(true);
    expect(r.culledIds.has('zone')).toBe(false);
    expect(r.culledIds.has('zero')).toBe(false);
    expect(r.culledIds.size).toBe(1);
    expect(r.changed).toBe(true);
  });

  it('preserves set identity across multiple passes (no churn)', () => {
    // Run twice with the same input + previous output — second pass should
    // return changed=false and the same set.
    const layers = [makeLayer('far', 100000, 100000), makeLayer('far2', 200000, 200000)];
    const pass1 = computeCullingDecision(VP, layers, new Set(), 5000);
    const pass2 = computeCullingDecision(VP, layers, pass1.culledIds, 5000);
    expect(pass2.changed).toBe(false);
    expect(pass2.culledIds).toEqual(pass1.culledIds);
  });
});
