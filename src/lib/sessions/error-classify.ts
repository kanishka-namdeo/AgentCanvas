// Run-error classification — surfaces whether a failed run's error is likely
// TRANSIENT (retryable: network, 5xx, rate-limit, timeout, abort) or
// PERMANENT (auth, schema, validation, 404 — fix the config, don't retry).
// Pure function — no React / store deps — so it can be unit-tested in
// isolation and called from the RunCard UI chip + (optionally) the canvas
// store's bounded auto-retry path.
//
// Complements `src/lib/agent-error.ts::classifyAgentError` (which carries 9
// granular codes for the typed wire envelope `agent:error` event). This
// helper is the SIMPLER 3-bucket view the UI error chip needs:
// transient | permanent | unknown. The wire envelope stays the source of
// truth for backend retryability; this helper classifies the user-visible
// `run.errorMessage` string when the wire code is absent (older server rows,
// legacy transcripts, manual error annotations).

export type RunErrorKind = 'transient' | 'permanent' | 'unknown';

export interface RunErrorClassification {
  kind: RunErrorKind;
  /// One-sentence user-facing hint. Empty string for 'unknown' (no hint).
  hint: string;
}

const TRANSIENT_HINT = 'Network error — retry often succeeds.';
const PERMANENT_HINT = 'Configuration issue — check Settings → LLM provider.';

/// Substring matches that indicate a TRANSIENT (auto-retryable) failure.
/// Case-insensitive. Order matters: PERMANENT_TOKENS are checked first so
/// that an auth failure mentioning a 5xx in passing is correctly classified
/// as permanent (mirrors `classifyAgentError`'s auth-before-rate-limit rule).
const TRANSIENT_TOKENS: readonly string[] = [
  'timeout',
  'etimedout',
  'econnreset',
  'socket hang up',
  '5xx',
  '503',
  '502',
  '429',
  'rate limit',
  'rate_limit',
  'ratelimit',
  'network',
  'fetch failed',
  'aborted',
];

/// Substring matches that indicate a PERMANENT (non-retryable) failure.
/// Case-insensitive. Checked BEFORE the transient tokens so a message
/// mentioning both 401 and 429 classifies as permanent (auth beats network).
const PERMANENT_TOKENS: readonly string[] = [
  '401',
  '403',
  'invalid api key',
  'incorrect api key',
  'schema',
  'validation',
  'not found',
  '404',
];

/// Classify a run error message as transient / permanent / unknown.
///
/// Heuristic: case-insensitive substring search against PERMANENT_TOKENS
/// first, then TRANSIENT_TOKENS. Empty / null input → 'unknown' with no
/// hint (the caller should not render the chip for empty messages).
///
/// Examples:
///   'HTTP 429: Too Many Requests'       → { kind: 'transient',   hint: TRANSIENT_HINT }
///   'fetch failed: ECONNRESET'          → { kind: 'transient',   hint: TRANSIENT_HINT }
///   'Invalid API key provided'          → { kind: 'permanent',   hint: PERMANENT_HINT }
///   'HTTP 404: Not Found'               → { kind: 'permanent',   hint: PERMANENT_HINT }
///   'Something odd happened'            → { kind: 'unknown',     hint: '' }
export function classifyRunError(
  message: string | null | undefined,
): RunErrorClassification {
  const msg = (message ?? '').toLowerCase();
  if (!msg) return { kind: 'unknown', hint: '' };

  for (const tok of PERMANENT_TOKENS) {
    if (msg.includes(tok)) return { kind: 'permanent', hint: PERMANENT_HINT };
  }
  for (const tok of TRANSIENT_TOKENS) {
    if (msg.includes(tok)) return { kind: 'transient', hint: TRANSIENT_HINT };
  }
  return { kind: 'unknown', hint: '' };
}
