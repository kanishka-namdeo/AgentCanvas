// Rulers — Phase 7 §H.2 tests.
//
// Pure-function coverage (jsdom-safe — the component renders SVG, but the
// tick math is what matters and it's pure):
//   - tickSpacingFor: zoom → {major, minor} adaptive ladder
//   - formatTickLabel: 0/100/1000/1500/10000 → "0"/"100"/"1k"/"1.5k"/"10k"
//   - computeTicks: pan/zoom/length → visible tick array with correct
//     screen positions + labels + major flag
//   - edge cases: zero/negative length, extreme zoom, pan far from origin

import { describe, it, expect } from 'vitest';
import { tickSpacingFor, formatTickLabel, computeTicks } from '@/components/canvas/Rulers';

describe('Rulers tickSpacingFor (Phase 7 §H.2)', () => {
  it('zoom 1.0 → major 100, minor 20', () => {
    const { major, minor } = tickSpacingFor(1);
    expect(major).toBe(100);
    expect(minor).toBe(20);
  });

  it('zoom 2.0 → major 50, minor 10 (denser at high zoom)', () => {
    const { major, minor } = tickSpacingFor(2);
    expect(major).toBe(50);
    expect(minor).toBe(10);
  });

  it('zoom 0.5 → major 200, minor 40 (looser at low zoom)', () => {
    const { major, minor } = tickSpacingFor(0.5);
    expect(major).toBe(200);
    expect(minor).toBe(40); // major/5
  });

  it('zoom 4.0 → major 20, minor 4 (very tight)', () => {
    const { major, minor } = tickSpacingFor(4);
    expect(major).toBe(20);
    expect(minor).toBe(4); // major/5
  });

  it('zoom 0.0 returns a finite spacing (no division by zero)', () => {
    const { major, minor } = tickSpacingFor(0);
    expect(Number.isFinite(major)).toBe(true);
    expect(Number.isFinite(minor)).toBe(true);
    expect(minor).toBeGreaterThanOrEqual(1);
  });

  it('zoom 0.1 (heavily zoomed-out) → major 1000, minor 200', () => {
    // target = 80/0.1 = 800 → snaps UP to 1000 (next ladder value ≥ 800).
    const { major, minor } = tickSpacingFor(0.1);
    expect(major).toBe(1000);
    expect(minor).toBe(200);
  });
});

describe('Rulers formatTickLabel (Phase 7 §H.2)', () => {
  it('0 → "0"', () => {
    expect(formatTickLabel(0)).toBe('0');
  });

  it('100 → "100"', () => {
    expect(formatTickLabel(100)).toBe('100');
  });

  it('1000 → "1k"', () => {
    expect(formatTickLabel(1000)).toBe('1k');
  });

  it('1500 → "1.5k" (one decimal, no trailing .0)', () => {
    expect(formatTickLabel(1500)).toBe('1.5k');
  });

  it('2000 → "2k" (not "2.0k")', () => {
    expect(formatTickLabel(2000)).toBe('2k');
  });

  it('10000 → "10k"', () => {
    expect(formatTickLabel(10000)).toBe('10k');
  });

  it('12345 → "12k" (large numbers round to k with no decimal)', () => {
    expect(formatTickLabel(12345)).toBe('12k');
  });

  it('negative values format correctly: -1000 → "-1k"', () => {
    expect(formatTickLabel(-1000)).toBe('-1k');
  });

  it('negative -500 → "-500"', () => {
    expect(formatTickLabel(-500)).toBe('-500');
  });
});

describe('Rulers computeTicks (Phase 7 §H.2)', () => {
  it('returns an array of {pos, label, major} ticks sorted by pos', () => {
    const ticks = computeTicks(0, 1, 1000);
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks[0].pos).toBeLessThanOrEqual(ticks[ticks.length - 1].pos);
    for (const t of ticks) {
      expect(typeof t.pos).toBe('number');
      expect(t.label === null || typeof t.label === 'string').toBe(true);
      expect(typeof t.major).toBe('boolean');
    }
  });

  it('at zoom 1, pan 0: tick at pos 0 has label "0"', () => {
    const ticks = computeTicks(0, 1, 1000);
    const zero = ticks.find((t) => t.pos === 0);
    expect(zero).toBeDefined();
    expect(zero!.major).toBe(true);
    expect(zero!.label).toBe('0');
  });

  it('at zoom 1, pan 0: major ticks labeled every 100 canvas px (inclusive of 0 and 1000)', () => {
    const ticks = computeTicks(0, 1, 1000);
    const labeled = ticks.filter((t) => t.label !== null);
    // Length=1000 inclusive: 0, 100, 200, ..., 1000 = 11 labeled ticks.
    expect(labeled.length).toBe(11);
    expect(labeled[0].label).toBe('0');
    expect(labeled[1].label).toBe('100');
    expect(labeled[10].label).toBe('1k');
  });

  it('minor ticks have null label and major=false', () => {
    const ticks = computeTicks(0, 1, 1000);
    const minor = ticks.filter((t) => !t.major);
    expect(minor.length).toBeGreaterThan(0);
    for (const t of minor) {
      expect(t.label).toBeNull();
    }
  });

  it('ticks are bounded within [0, length]', () => {
    const ticks = computeTicks(0, 1, 500);
    for (const t of ticks) {
      expect(t.pos).toBeGreaterThanOrEqual(0);
      expect(t.pos).toBeLessThanOrEqual(500);
    }
  });

  it('pan shifts ticks: pan=100 (content moved right) moves "0" label to pos 100', () => {
    const ticks = computeTicks(100, 1, 1000);
    const zero = ticks.find((t) => t.label === '0');
    expect(zero).toBeDefined();
    expect(zero!.pos).toBe(100);
  });

  it('zoom 2.0 halves spacing: "0" at pos 0, "50" at pos 100 (next major)', () => {
    const ticks = computeTicks(0, 2, 100);
    const zero = ticks.find((t) => t.label === '0');
    expect(zero?.pos).toBe(0);
    const fifty = ticks.find((t) => t.label === '50');
    expect(fifty?.pos).toBe(100); // 50 canvas px × zoom 2 = 100 screen px
  });

  it('zoom 0.5 doubles spacing: "0" at pos 0, "200" at pos 100 (next major)', () => {
    const ticks = computeTicks(0, 0.5, 200);
    const zero = ticks.find((t) => t.label === '0');
    expect(zero?.pos).toBe(0);
    const twoHundred = ticks.find((t) => t.label === '200');
    expect(twoHundred?.pos).toBe(100); // 200 canvas px × zoom 0.5 = 100 screen px
  });

  it('zero length returns empty array (no ticks visible)', () => {
    const ticks = computeTicks(0, 1, 0);
    expect(ticks).toEqual([]);
  });

  it('negative length returns empty array', () => {
    const ticks = computeTicks(0, 1, -100);
    expect(ticks).toEqual([]);
  });

  it('handles pan far from origin: pan=5000 still produces ticks', () => {
    const ticks = computeTicks(5000, 1, 1000);
    expect(ticks.length).toBeGreaterThan(0);
    // All ticks should be within [0, 1000].
    for (const t of ticks) {
      expect(t.pos).toBeGreaterThanOrEqual(0);
      expect(t.pos).toBeLessThanOrEqual(1000);
    }
  });

  it('handles extreme zoom (1000×): produces tight major ticks', () => {
    const { major } = tickSpacingFor(1000);
    // 80/1000 = 0.08 → snaps to 1 (smallest ladder value).
    expect(major).toBe(1);
    const ticks = computeTicks(0, 1000, 500);
    expect(ticks.length).toBeGreaterThan(0);
  });

  it('no label collisions: each major tick has a unique label', () => {
    const ticks = computeTicks(0, 1, 2000);
    const labels = ticks.filter((t) => t.label !== null).map((t) => t.label);
    const unique = new Set(labels);
    expect(unique.size).toBe(labels.length);
  });
});
