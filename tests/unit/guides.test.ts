// Tests for the Guides chrome overlay (spec Phase 7 §H.1 / §H.2).
//
// Covers the pure helpers exported from `@/components/canvas/dom/Guides`:
//   - guideToScreenCoords: canvas → screen line endpoints per axis
//   - guideToScreenAxis: screen coordinate of the guide's position along
//     its own axis (used to place the handle circle + measure math)
//   - guideColor: defaults to Figma red #f24822, custom colors preserved
//   - DEFAULT_GUIDE_COLOR constant exported for sharing with the Rulers
//     drag preview line
//
// Edge cases:
//   - position 0 → renders at pan (NOT negative). A guide at canvas y=0
//     sits at the top of the canvas origin, which after pan/zoom lands at
//     panY on screen.
//   - negative position → renders at canvas-space negative (off-screen to
//     the upper-left, but mathematically valid — the line still has the
//     right screen coords).
//   - extreme zoom levels → no division, just multiplication (zoom=0 is
//     guarded against elsewhere; here we just verify the math).
//
// The component itself is a thin shell over these helpers (SVG render);
// behavior is asserted here directly to keep the test fast + jsdom-safe.

import { describe, it, expect } from 'vitest';
import {
  guideToScreenCoords,
  guideToScreenAxis,
  guideColor,
  DEFAULT_GUIDE_COLOR,
} from '@/components/canvas/dom/Guides';
import type { GuideLine } from '@/lib/canvas/types';

function horizontalGuide(id: string, position: number, color?: string): GuideLine {
  return color ? { id, axis: 'horizontal', position, color } : { id, axis: 'horizontal', position };
}

function verticalGuide(id: string, position: number, color?: string): GuideLine {
  return color ? { id, axis: 'vertical', position, color } : { id, axis: 'vertical', position };
}

describe('guides: DEFAULT_GUIDE_COLOR', () => {
  it('is Figma red #f24822', () => {
    expect(DEFAULT_GUIDE_COLOR).toBe('#f24822');
  });
});

describe('guides: guideColor', () => {
  it('returns the guide color when set', () => {
    expect(guideColor(horizontalGuide('g1', 100, '#00ff00'))).toBe('#00ff00');
  });

  it('falls back to DEFAULT_GUIDE_COLOR when color is missing', () => {
    expect(guideColor(horizontalGuide('g1', 100))).toBe(DEFAULT_GUIDE_COLOR);
  });

  it('falls back when color is undefined (explicit)', () => {
    const g: GuideLine = { id: 'g1', axis: 'vertical', position: 50, color: undefined };
    expect(guideColor(g)).toBe(DEFAULT_GUIDE_COLOR);
  });

  it('preserves any custom color string (no normalization)', () => {
    expect(guideColor(horizontalGuide('g1', 0, 'rgba(0,0,0,0.5)'))).toBe('rgba(0,0,0,0.5)');
    expect(guideColor(horizontalGuide('g1', 0, 'currentColor'))).toBe('currentColor');
  });
});

describe('guides: guideToScreenCoords', () => {
  it('horizontal guide → y-line spanning full viewport width at position*zoom + panY', () => {
    const g = horizontalGuide('h1', 100);
    const coords = guideToScreenCoords(g, /*panX*/ 50, /*panY*/ 30, /*zoom*/ 2, /*w*/ 800, /*h*/ 600);
    expect(coords).toEqual({ x1: 0, y1: 230, x2: 800, y2: 230 });
    // y = 100 * 2 + 30 = 230. x spans 0..width.
  });

  it('vertical guide → x-line spanning full viewport height at position*zoom + panX', () => {
    const g = verticalGuide('v1', 200);
    const coords = guideToScreenCoords(g, 50, 30, 2, 800, 600);
    expect(coords).toEqual({ x1: 450, y1: 0, x2: 450, y2: 600 });
    // x = 200 * 2 + 50 = 450. y spans 0..height.
  });

  it('horizontal guide ignores panX in the y-coordinate (panX only affects vertical guides)', () => {
    const g = horizontalGuide('h1', 100);
    const a = guideToScreenCoords(g, 0, 40, 1, 800, 600);
    const b = guideToScreenCoords(g, 500, 40, 1, 800, 600);
    expect(a.y1).toBe(b.y1);
    expect(a.y2).toBe(b.y2);
    // x1/x2 stay 0..width regardless of panX.
    expect(a.x1).toBe(0);
    expect(a.x2).toBe(800);
  });

  it('vertical guide ignores panY in the x-coordinate', () => {
    const g = verticalGuide('v1', 100);
    const a = guideToScreenCoords(g, 40, 0, 1, 800, 600);
    const b = guideToScreenCoords(g, 40, 500, 1, 800, 600);
    expect(a.x1).toBe(b.x1);
    expect(a.x2).toBe(b.x2);
    expect(a.y1).toBe(0);
    expect(a.y2).toBe(600);
  });

  it('zoom = 1, pan = 0 → screen = canvas position', () => {
    const h = guideToScreenCoords(horizontalGuide('h1', 250), 0, 0, 1, 1000, 800);
    expect(h).toEqual({ x1: 0, y1: 250, x2: 1000, y2: 250 });
    const v = guideToScreenCoords(verticalGuide('v1', 750), 0, 0, 1, 1000, 800);
    expect(v).toEqual({ x1: 750, y1: 0, x2: 750, y2: 800 });
  });

  it('zoom scales the position', () => {
    const h = guideToScreenCoords(horizontalGuide('h1', 100), 0, 0, 2, 1000, 800);
    expect(h.y1).toBe(200); // 100 * 2
    const v = guideToScreenCoords(verticalGuide('v1', 100), 0, 0, 0.5, 1000, 800);
    expect(v.x1).toBe(50); // 100 * 0.5
  });

  it('pan offsets the position (positive pan = down/right)', () => {
    const h = guideToScreenCoords(horizontalGuide('h1', 100), 0, 200, 1, 1000, 800);
    expect(h.y1).toBe(300); // 100 + 200
    const v = guideToScreenCoords(verticalGuide('v1', 100), 200, 0, 1, 1000, 800);
    expect(v.x1).toBe(300); // 100 + 200
  });

  it('negative pan shifts the guide up/left (canvas origin off-screen)', () => {
    const h = guideToScreenCoords(horizontalGuide('h1', 100), 0, -50, 1, 1000, 800);
    expect(h.y1).toBe(50); // 100 + (-50)
    const v = guideToScreenCoords(verticalGuide('v1', 100), -50, 0, 1, 1000, 800);
    expect(v.x1).toBe(50);
  });
});

describe('guides: guideToScreenCoords — edge cases', () => {
  it('position 0 → renders at pan (NOT negative)', () => {
    // A guide at canvas y=0 is the top edge of the canvas origin. After
    // pan (panY=120) the screen y is 120 — NOT 0 or negative.
    const h = guideToScreenCoords(horizontalGuide('h1', 0), 100, 120, 1, 1000, 800);
    expect(h.y1).toBe(120); // 0 * 1 + 120
    expect(h.y2).toBe(120);
    expect(h.x1).toBe(0);
    expect(h.x2).toBe(1000);
    const v = guideToScreenCoords(verticalGuide('v1', 0), 120, 100, 1, 1000, 800);
    expect(v.x1).toBe(120); // 0 * 1 + 120
    expect(v.x2).toBe(120);
  });

  it('negative position → renders at canvas-space negative (off-screen, but valid)', () => {
    // A guide at canvas y=-200 (above the canvas origin) still computes a
    // valid screen y; with pan=0+zoom=1, screen y=-200 — off the visible
    // viewport, but mathematically correct (the line just doesn't show).
    const h = guideToScreenCoords(horizontalGuide('h1', -200), 0, 0, 1, 1000, 800);
    expect(h.y1).toBe(-200);
    expect(h.y2).toBe(-200);
    // With positive pan it can come back on screen.
    const h2 = guideToScreenCoords(horizontalGuide('h1', -200), 0, 300, 1, 1000, 800);
    expect(h2.y1).toBe(100); // -200 + 300
  });

  it('fractional positions are preserved (no integer rounding)', () => {
    const h = guideToScreenCoords(horizontalGuide('h1', 100.5), 0, 0, 1, 1000, 800);
    expect(h.y1).toBe(100.5);
    const v = guideToScreenCoords(verticalGuide('v1', 50.25), 0, 0, 2, 1000, 800);
    expect(v.x1).toBe(100.5); // 50.25 * 2
  });

  it('zero viewport dimensions are handled (degenerate line, no crash)', () => {
    const h = guideToScreenCoords(horizontalGuide('h1', 100), 0, 0, 1, 0, 0);
    expect(h).toEqual({ x1: 0, y1: 100, x2: 0, y2: 100 });
    const v = guideToScreenCoords(verticalGuide('v1', 100), 0, 0, 1, 0, 0);
    expect(v).toEqual({ x1: 100, y1: 0, x2: 100, y2: 0 });
  });
});

describe('guides: guideToScreenAxis', () => {
  it('returns the screen Y for a horizontal guide (used to place the handle)', () => {
    const g = horizontalGuide('h1', 100);
    expect(guideToScreenAxis(g, 0, 50, 2)).toBe(250); // 100 * 2 + 50
  });

  it('returns the screen X for a vertical guide', () => {
    const g = verticalGuide('v1', 200);
    expect(guideToScreenAxis(g, 30, 0, 1)).toBe(230); // 200 * 1 + 30
  });

  it('matches the along-axis endpoint of guideToScreenCoords (horizontal)', () => {
    const g = horizontalGuide('h1', 100);
    const coords = guideToScreenCoords(g, 50, 30, 2, 800, 600);
    const axis = guideToScreenAxis(g, 50, 30, 2);
    expect(axis).toBe(coords.y1);
    expect(axis).toBe(coords.y2);
  });

  it('matches the along-axis endpoint of guideToScreenCoords (vertical)', () => {
    const g = verticalGuide('v1', 100);
    const coords = guideToScreenCoords(g, 50, 30, 2, 800, 600);
    const axis = guideToScreenAxis(g, 50, 30, 2);
    expect(axis).toBe(coords.x1);
    expect(axis).toBe(coords.x2);
  });
});
