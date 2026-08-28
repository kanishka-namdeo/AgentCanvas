// Adaptive cost formatter for per-run cost badges.
//
// The audit (Task 4-a, Critical gaps §1) flagged the previous `costUsd.toFixed(4)`
// rendering as confusing: tiny runs showed "$0.0000" (truncated to zero) and
// 0.0001-cent runs showed "$0.0001" (the only visible digit being a rounding
// artifact). Users had no way to tell genuine-zero from genuinely-tiny.
//
// This helper picks precision by magnitude:
//   • usd === 0            → "$0"        (caller already gates on `> 0`)
//   • 0 < usd < 0.01       → "< $0.01"   (text label, no fake precision)
//   • 0.01 ≤ usd < 1       → "$0.0XXX"   (4 decimals — keeps the sub-cent digit)
//   • usd ≥ 1              → "$X.XX"     (2 decimals — dollars-and-cents view)
//
// Pure function — no React / store deps — so it can be unit-tested in
// isolation. Mirrors the pattern of `src/lib/sessions/error-classify.ts`.

/**
 * Format a USD cost value for display in the per-run cost badge.
 *
 * Returns:
 *   - "$0"            if usd is exactly 0 (or non-finite, treated as 0)
 *   - "< $0.01"       if 0 < usd < 0.01
 *   - "$0.0XXX"       if 0.01 ≤ usd < 1 (4 decimals)
 *   - "$X.XX"         if usd ≥ 1 (2 decimals)
 *
 * Negative inputs are clamped to 0 (defensive — a buggy caller could pass
 * a refund sentinel; the UI shouldn't render "-$0.50" against a Run row).
 */
export function formatCost(usd: number): string {
  // Non-finite (NaN / Infinity / -Infinity) → treat as zero. The store-level
  // guard already rejects non-finite at the API boundary; this is a defensive
  // backstop for client-side derived sums (NaN propagation through reduce).
  if (!Number.isFinite(usd) || usd <= 0) return '$0';
  if (usd < 0.01) return '< $0.01';
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
