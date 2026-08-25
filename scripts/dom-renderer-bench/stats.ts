// stats.ts — pure statistics helpers for the DOM-renderer bench runner.
//
// Extracted from run.ts so they're trivially unit-testable: no I/O, no globals,
// no async. Both functions are deterministic and total (never throws, never
// returns NaN — `computeStats([])` yields all-zero stats instead).
//
// Spec: docs/html-dom-renderer.md Appendix F (p10/p50/p95/p99 frame-time
// percentiles + patch-to-paint latency + bulk_add commit count → CI gates).
//
// Percentile method: nearest-rank (the simplest method that produces integer
// indices — no interpolation). The phase-4 acceptance spec calls for "p95"
// against ≤ 16 ms / ≤ 16.7 ms thresholds; nearest-rank gives a stable,
// reproducible number with no fractional-index surprises.

export interface Stats {
  /// Sample count (mirrors the input length).
  n: number;
  /// 50th percentile (median).
  p50: number;
  /// 95th percentile.
  p95: number;
  /// 99th percentile.
  p99: number;
  /// Minimum sample.
  min: number;
  /// Maximum sample.
  max: number;
  /// Arithmetic mean.
  mean: number;
}

/// Compute summary statistics for a sample array. Pure + total:
///   - Empty array → all metrics = 0 (no NaN).
///   - Single sample → every metric equals that sample.
///   - Otherwise → nearest-rank percentiles + min/max/mean.
///
/// The array is copied before sorting so callers never observe a mutation.
export function computeStats(samples: number[]): Stats {
  if (samples.length === 0) {
    return { n: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0, mean: 0 };
  }
  if (samples.length === 1) {
    const v = samples[0];
    return { n: 1, p50: v, p95: v, p99: v, min: v, max: v, mean: v };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const percentile = (p: number): number => {
    // Nearest-rank: index = ceil(p/100 * n) - 1, clamped to [0, n-1].
    const idx = Math.max(0, Math.min(n - 1, Math.ceil((p / 100) * n) - 1));
    return sorted[idx];
  };
  let sum = 0;
  for (const v of sorted) sum += v;
  return {
    n,
    p50: percentile(50),
    p95: percentile(95),
    p99: percentile(99),
    min: sorted[0],
    max: sorted[n - 1],
    mean: sum / n,
  };
}

/// The thresholds Appendix F calls out for the Phase-4 exit criteria.
/// Exported so tests can assert against the same constants the runner uses.
export const DEFAULT_GATES: Required<PerfGates> = {
  /// p95 frame time @ ≥1k nodes (Appendix F: 60fps = 16.7ms; the task spec
  /// tightens this to 16ms as the gate).
  p95Frame: 16,
  /// p95 single-update patch-to-paint latency (Appendix F: ≤ 16 ms).
  p95Patch: 16,
  /// 500-node bulk_add commit count (Appendix F: ≤ 3 React commits).
  bulkAddCommits: 3,
  /// Below this node count, pan/zoom p95 is advisory only (the gate is only
  /// enforced on real workloads — Appendix F: "large" 5k / "medium" 1k).
  panFrameGateMinNodes: 1000,
};

export interface PerfGates {
  p95Frame?: number;
  p95Patch?: number;
  bulkAddCommits?: number;
  panFrameGateMinNodes?: number;
}

/// One corpus's measured metrics. `computeStats` runs per metric so the
/// gate function can inspect any percentile without re-walking the array.
export interface CorpusMetrics {
  name: string;
  nodes: number;
  panFrame: Stats;
  patchLatency: Stats;
  bulkAddCommits: number;
}

export interface GateResult {
  pass: boolean;
  violations: string[];
}

/// Evaluate the Appendix-F perf gates against a list of corpus metrics.
/// Pure + total. Returns `pass: true` + empty violations when every gate is
/// within tolerance; otherwise returns `pass: false` with one human-readable
/// violation string per exceeded gate (so CI logs can list every failure).
///
/// Gate rules (only enforced when the corresponding metric was actually
/// collected — a missing/zero sample is treated as "skip"):
///   - Pan/zoom p95 ≤ p95Frame (only for corpora with ≥ panFrameGateMinNodes).
///   - Patch latency p95 ≤ p95Patch (any corpus with samples).
///   - bulk_add commits ≤ bulkAddCommits (any corpus where the bulk_add
///     measurement ran; a value of 0 means the measurement was skipped).
export function gateEnforced(
  results: CorpusMetrics[],
  gates: PerfGates = DEFAULT_GATES,
): GateResult {
  const g = { ...DEFAULT_GATES, ...gates };
  const violations: string[] = [];
  for (const r of results) {
    // Pan/zoom gate — Appendix F: "large" 5k / "medium" 1k. The task spec
    // calls for the gate at ≥ 1000 nodes; below that, it's advisory only.
    if (
      r.panFrame.n > 0 &&
      r.nodes >= g.panFrameGateMinNodes &&
      r.panFrame.p95 > g.p95Frame
    ) {
      violations.push(
        `${r.name} (${r.nodes}n): pan/zoom p95 ${r.panFrame.p95.toFixed(1)}ms > ${g.p95Frame}ms gate`,
      );
    }
    // Patch latency gate — Appendix F: ≤ 16 ms at any corpus.
    if (r.patchLatency.n > 0 && r.patchLatency.p95 > g.p95Patch) {
      violations.push(
        `${r.name} (${r.nodes}n): patch p95 ${r.patchLatency.p95.toFixed(1)}ms > ${g.p95Patch}ms gate`,
      );
    }
    // Bulk_add commit gate — Appendix F: ≤ 3 React commits for 500-node build.
    if (r.bulkAddCommits > 0 && r.bulkAddCommits > g.bulkAddCommits) {
      violations.push(
        `${r.name} (${r.nodes}n): bulk_add ${r.bulkAddCommits} commits > ${g.bulkAddCommits} gate`,
      );
    }
  }
  return { pass: violations.length === 0, violations };
}
