// Unit tests for the DOM-renderer bench runner's pure helpers
// (scripts/dom-renderer-bench/stats.ts — spec Appendix F).
//
// Both `computeStats` and `gateEnforced` are pure + total (no I/O, no globals);
// these tests assert the spec'd edge cases (empty samples, single sample,
// exact nearest-rank percentiles) and the CI gate thresholds
// (pan/zoom p95 ≤ 16ms @ ≥1k nodes; patch p95 ≤ 16ms; bulk_add ≤ 3 commits).

import { describe, it, expect } from 'vitest';
import {
  computeStats,
  gateEnforced,
  DEFAULT_GATES,
  type CorpusMetrics,
  type PerfGates,
} from '../../scripts/dom-renderer-bench/stats';

describe('computeStats', () => {
  it('returns all-zero stats for an empty sample array (no NaN)', () => {
    const s = computeStats([]);
    expect(s.n).toBe(0);
    expect(s.p50).toBe(0);
    expect(s.p95).toBe(0);
    expect(s.p99).toBe(0);
    expect(s.min).toBe(0);
    expect(s.max).toBe(0);
    expect(s.mean).toBe(0);
    // NaN guard (the spec'd invariant — empty input must not poison downstream
    // arithmetic in the runner).
    expect(Number.isNaN(s.p50)).toBe(false);
    expect(Number.isNaN(s.mean)).toBe(false);
  });

  it('returns every metric equal to the single sample', () => {
    const s = computeStats([42]);
    expect(s.n).toBe(1);
    expect(s.p50).toBe(42);
    expect(s.p95).toBe(42);
    expect(s.p99).toBe(42);
    expect(s.min).toBe(42);
    expect(s.max).toBe(42);
    expect(s.mean).toBe(42);
  });

  it('computes nearest-rank p50/p95/p99 + min/max/mean on 1..10', () => {
    const s = computeStats([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(s.n).toBe(10);
    expect(s.p50).toBe(5); // ceil(0.5*10)-1 = 4 → arr[4] = 5
    expect(s.p95).toBe(10); // ceil(0.95*10)-1 = 9 → arr[9] = 10
    expect(s.p99).toBe(10); // same index → 10
    expect(s.min).toBe(1);
    expect(s.max).toBe(10);
    expect(s.mean).toBe(5.5);
  });

  it('computes p50/p95/p99 on the Appendix-F outlier sample', () => {
    // 5 samples — two frames at 16ms (the gate threshold), one at 17, one at
    // 18, and one outlier at 100ms. The runner must treat 100 as p95 (a real
    // jank frame), not as something the gate would let through.
    const s = computeStats([16, 16, 17, 18, 100]);
    expect(s.n).toBe(5);
    expect(s.p50).toBe(17); // ceil(0.5*5)-1 = 2 → arr[2] = 17
    expect(s.p95).toBe(100); // ceil(0.95*5)-1 = 4 → arr[4] = 100
    expect(s.p99).toBe(100); // same index → 100
    expect(s.min).toBe(16);
    expect(s.max).toBe(100);
    expect(s.mean).toBeCloseTo(33.4, 1); // (16+16+17+18+100)/5 = 33.4
  });

  it('does not mutate the input array (sort is on a copy)', () => {
    const input = [3, 1, 2];
    computeStats(input);
    expect(input).toEqual([3, 1, 2]);
  });

  it('handles an unsorted input (sorts internally before percentile lookup)', () => {
    const s = computeStats([10, 1, 5, 3, 7]);
    expect(s.min).toBe(1);
    expect(s.max).toBe(10);
    expect(s.p50).toBe(5); // sorted: [1,3,5,7,10], ceil(0.5*5)-1=2 → 5
    expect(s.p95).toBe(10); // ceil(0.95*5)-1=4 → 10
  });
});

describe('gateEnforced', () => {
  /// Helper — build a CorpusMetrics object with sensible defaults so each test
  /// only spells out the fields it cares about.
  function corpus(
    over: Partial<CorpusMetrics> & { name: string; nodes: number },
  ): CorpusMetrics {
    return {
      name: over.name,
      nodes: over.nodes,
      panFrame: over.panFrame ?? { n: 60, p50: 12, p95: 14, p99: 18, min: 10, max: 20, mean: 13 },
      patchLatency:
        over.patchLatency ?? { n: 30, p50: 8, p95: 12, p99: 14, min: 6, max: 16, mean: 10 },
      bulkAddCommits: over.bulkAddCommits ?? 2,
    };
  }

  it('passes when every metric is within every gate', () => {
    const results = [
      corpus({ name: 'small', nodes: 50 }),
      corpus({ name: 'medium', nodes: 200 }),
      corpus({ name: 'large', nodes: 1000 }),
      corpus({ name: 'xl', nodes: 5000 }),
    ];
    const r = gateEnforced(results);
    expect(r.pass).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('fails when pan/zoom p95 exceeds 16ms at ≥1000 nodes', () => {
    const results = [
      corpus({
        name: 'large',
        nodes: 1000,
        panFrame: { n: 60, p50: 14, p95: 18, p99: 22, min: 12, max: 24, mean: 15 },
      }),
    ];
    const r = gateEnforced(results);
    expect(r.pass).toBe(false);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toContain('pan/zoom p95');
    expect(r.violations[0]).toContain('18.0ms');
    expect(r.violations[0]).toContain('16ms');
    expect(r.violations[0]).toContain('large');
  });

  it('does NOT enforce the pan/zoom gate below 1000 nodes (advisory only)', () => {
    // Same slow p95 at 200 nodes — should not produce a violation because the
    // gate is only enforced on the "large/xl" reference workloads.
    const results = [
      corpus({
        name: 'medium',
        nodes: 200,
        panFrame: { n: 60, p50: 14, p95: 25, p99: 30, min: 12, max: 32, mean: 16 },
      }),
    ];
    const r = gateEnforced(results);
    expect(r.pass).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('fails when patch latency p95 exceeds 16ms (any corpus with samples)', () => {
    const results = [
      corpus({
        name: 'small',
        nodes: 50,
        patchLatency: { n: 30, p50: 10, p95: 20, p99: 24, min: 6, max: 26, mean: 12 },
      }),
    ];
    const r = gateEnforced(results);
    expect(r.pass).toBe(false);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toContain('patch p95');
    expect(r.violations[0]).toContain('20.0ms');
  });

  it('fails when bulk_add commits exceed 3', () => {
    const results = [
      corpus({ name: 'medium', nodes: 200, bulkAddCommits: 5 }),
    ];
    const r = gateEnforced(results);
    expect(r.pass).toBe(false);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toContain('bulk_add');
    expect(r.violations[0]).toContain('5 commits');
    expect(r.violations[0]).toContain('3 gate');
  });

  it('reports ALL violations when multiple gates fail at once', () => {
    const results = [
      corpus({
        name: 'large',
        nodes: 1000,
        panFrame: { n: 60, p50: 20, p95: 25, p99: 30, min: 18, max: 32, mean: 22 },
        patchLatency: { n: 30, p50: 14, p95: 22, p99: 28, min: 10, max: 30, mean: 16 },
        bulkAddCommits: 7,
      }),
    ];
    const r = gateEnforced(results);
    expect(r.pass).toBe(false);
    expect(r.violations).toHaveLength(3);
    expect(r.violations.some((v) => v.includes('pan/zoom p95'))).toBe(true);
    expect(r.violations.some((v) => v.includes('patch p95'))).toBe(true);
    expect(r.violations.some((v) => v.includes('bulk_add'))).toBe(true);
  });

  it('accepts custom gates (looser thresholds pass a failing-by-default corpus)', () => {
    // Default gate would fail this; passing a custom p95Frame=30 makes it pass.
    const results = [
      corpus({
        name: 'large',
        nodes: 1000,
        panFrame: { n: 60, p50: 18, p95: 22, p99: 28, min: 16, max: 30, mean: 20 },
      }),
    ];
    const custom: PerfGates = { p95Frame: 30 };
    const r = gateEnforced(results, custom);
    expect(r.pass).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('skips gates for metrics that were not collected (n=0 / commits=0)', () => {
    // A corpus where the pan/zoom measurement failed (n=0) and bulk_add never
    // ran (commits=0) — only the patch latency gate should apply.
    const results: CorpusMetrics[] = [
      {
        name: 'large',
        nodes: 1000,
        panFrame: { n: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0, mean: 0 },
        patchLatency: { n: 30, p50: 8, p95: 12, p99: 14, min: 6, max: 16, mean: 10 },
        bulkAddCommits: 0,
      },
    ];
    const r = gateEnforced(results);
    expect(r.pass).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('DEFAULT_GATES reflects Appendix F thresholds (16ms frame, 16ms patch, 3 commits, ≥1k nodes)', () => {
    expect(DEFAULT_GATES.p95Frame).toBe(16);
    expect(DEFAULT_GATES.p95Patch).toBe(16);
    expect(DEFAULT_GATES.bulkAddCommits).toBe(3);
    expect(DEFAULT_GATES.panFrameGateMinNodes).toBe(1000);
  });
});
