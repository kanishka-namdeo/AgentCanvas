// Zoom clamp unification (D6) — unit tests.
//
// Regression: gestures clamped zoom to 0.1–8 (use-canvas-gestures.ts) while
// the Canvas zoom buttons + context-menu zoom items clamped to 0.1–4. The
// clamp now lives in ONE exported helper (`clampZoom` in
// `src/lib/canvas/use-canvas-gestures.ts`) consumed by every zoom control,
// unified to the gesture range 0.1–8.

import { describe, it, expect } from 'vitest';
import { clampZoom, MIN_ZOOM, MAX_ZOOM } from '@/lib/canvas/use-canvas-gestures';

describe('zoom clamp (D6)', () => {
  it('exposes the canonical zoom range 0.1–8 (gesture range)', () => {
    expect(MIN_ZOOM).toBe(0.1);
    expect(MAX_ZOOM).toBe(8);
  });

  it('clamps values below MIN_ZOOM', () => {
    expect(clampZoom(0)).toBe(0.1);
    expect(clampZoom(0.05)).toBe(0.1);
    expect(clampZoom(-3)).toBe(0.1);
  });

  it('clamps values above MAX_ZOOM', () => {
    expect(clampZoom(8.5)).toBe(8);
    expect(clampZoom(100)).toBe(8);
    expect(clampZoom(Infinity)).toBe(8);
  });

  it('passes in-range values through unchanged', () => {
    expect(clampZoom(0.1)).toBe(0.1);
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(4)).toBe(4);
    expect(clampZoom(8)).toBe(8);
  });

  it('lets the zoom-in button reach the gesture range above 4× (old button cap)', () => {
    // Zoom-in button multiplier is ×1.1; context menu is ×1.2. From a zoom
    // of 4, both must be allowed past the OLD 0.1–4 button clamp.
    expect(clampZoom(4 * 1.1)).toBeCloseTo(4.4, 10);
    expect(clampZoom(4 * 1.2)).toBeCloseTo(4.8, 10);
    // And the zoom-out button multiplier (×0.9 / ×0.8) still floors at 0.1.
    expect(clampZoom(0.11 * 0.9)).toBe(0.1); // 0.099 → clamped up to MIN_ZOOM
    expect(clampZoom(0.1 * 0.8)).toBe(0.1);
  });

  it('is the single clamp used by every zoom site (no other caps in the module)', async () => {
    // Guard against re-introducing a divergent clamp: the gestures module's
    // exported constants must be the ONLY zoom bounds (grep-level check on
    // the module source, since the clamp helpers used to be inline in JSX).
    const fs = await import('node:fs');
    const path = await import('node:path');
    const root = process.cwd();
    const src = fs.readFileSync(
      path.resolve(root, 'src/lib/canvas/use-canvas-gestures.ts'),
      'utf-8',
    );
    // MIN_ZOOM / MAX_ZOOM are defined exactly once each.
    expect(src.match(/^export const MIN_ZOOM = /m)).not.toBeNull();
    expect(src.match(/^export const MAX_ZOOM = /m)).not.toBeNull();
    // The Canvas component consumes the shared clamp, not an inline cap.
    const canvasSrc = fs.readFileSync(
      path.resolve(root, 'src/components/canvas/Canvas.tsx'),
      'utf-8',
    );
    expect(canvasSrc).toContain("clampZoom } from '@/lib/canvas/use-canvas-gestures'");
    expect(canvasSrc).not.toMatch(/zoom:\s*Math\.(min|max)\(/);
  });
});
