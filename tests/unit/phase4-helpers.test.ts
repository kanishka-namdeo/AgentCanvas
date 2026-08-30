// Unit tests for the helpers added in Phase 4: error-classify, format, escape-like-pattern.
//
// These are pure-function tests (no React, no fetch, no DB). They cover the
// audit-flagged gaps the deep audit (Task 4-a) raised.

import { describe, it, expect } from 'vitest';
import { classifyRunError } from '@/lib/sessions/error-classify';
import { formatCost } from '@/lib/sessions/format';
import { escapeLikePattern } from '@/app/api/sessions/search/route';

describe('classifyRunError (P4-b — retry-whole-turn classification)', () => {
  it('classifies transient error tokens', () => {
    expect(classifyRunError('Connection timeout')).toEqual({
      kind: 'transient',
      hint: 'Network error — retry often succeeds.',
    });
    expect(classifyRunError('fetch failed: ETIMEDOUT')).toMatchObject({ kind: 'transient' });
    expect(classifyRunError('socket hang up')).toMatchObject({ kind: 'transient' });
    expect(classifyRunError('Request failed with status 503')).toMatchObject({ kind: 'transient' });
    expect(classifyRunError('502 Bad Gateway')).toMatchObject({ kind: 'transient' });
    expect(classifyRunError('429 Too Many Requests')).toMatchObject({ kind: 'transient' });
    expect(classifyRunError('Rate limit exceeded')).toMatchObject({ kind: 'transient' });
    expect(classifyRunError('network error')).toMatchObject({ kind: 'transient' });
    expect(classifyRunError('The request was aborted')).toMatchObject({ kind: 'transient' });
    expect(classifyRunError('fetch failed')).toMatchObject({ kind: 'transient' });
  });

  it('classifies permanent error tokens', () => {
    expect(classifyRunError('401 Unauthorized')).toEqual({
      kind: 'permanent',
      hint: 'Configuration issue — check Settings → LLM provider.',
    });
    expect(classifyRunError('403 Forbidden')).toMatchObject({ kind: 'permanent' });
    expect(classifyRunError('Invalid API key')).toMatchObject({ kind: 'permanent' });
    expect(classifyRunError('Schema validation error')).toMatchObject({ kind: 'permanent' });
    expect(classifyRunError('Not Found: 404')).toMatchObject({ kind: 'permanent' });
  });

  it('classifies unknown errors (no token match)', () => {
    expect(classifyRunError('Something weird happened')).toEqual({
      kind: 'unknown',
      hint: '',
    });
    expect(classifyRunError('')).toEqual({ kind: 'unknown', hint: '' });
    expect(classifyRunError(null as unknown as string)).toEqual({ kind: 'unknown', hint: '' });
  });

  it('permanent wins over transient when both tokens present (auth-beats-rate-limit)', () => {
    // A 401 with a 429 retry-after header should be classified as permanent —
    // retrying won't fix a bad API key.
    const result = classifyRunError('401 Unauthorized — rate limit reset after 429');
    expect(result.kind).toBe('permanent');
  });

  it('is case-insensitive', () => {
    expect(classifyRunError('TIMEOUT')).toMatchObject({ kind: 'transient' });
    expect(classifyRunError('Invalid API KEY')).toMatchObject({ kind: 'permanent' });
    expect(classifyRunError('Rate LIMIT')).toMatchObject({ kind: 'transient' });
  });
});

describe('formatCost (P4-c — smart cost formatting)', () => {
  it('returns $0 for zero', () => {
    expect(formatCost(0)).toBe('$0');
  });

  it('returns "< $0.01" for sub-cent costs', () => {
    expect(formatCost(0.0001)).toBe('< $0.01');
    expect(formatCost(0.0099)).toBe('< $0.01');
    expect(formatCost(0.001)).toBe('< $0.01');
  });

  it('formats 4-decimal precision for sub-dollar costs', () => {
    expect(formatCost(0.01)).toBe('$0.0100');
    expect(formatCost(0.1234)).toBe('$0.1234');
    expect(formatCost(0.5)).toBe('$0.5000');
    expect(formatCost(0.99)).toBe('$0.9900');
  });

  it('formats 2-decimal precision for ≥$1', () => {
    expect(formatCost(1)).toBe('$1.00');
    expect(formatCost(1.5)).toBe('$1.50');
    expect(formatCost(10)).toBe('$10.00');
    expect(formatCost(123.456)).toBe('$123.46'); // rounds
    expect(formatCost(999.99)).toBe('$999.99');
  });

  it('handles NaN + Infinity defensively (returns $0)', () => {
    expect(formatCost(NaN)).toBe('$0');
    expect(formatCost(Infinity)).toBe('$0');
    expect(formatCost(-Infinity)).toBe('$0');
  });

  it('handles negative values defensively (returns $0)', () => {
    expect(formatCost(-1)).toBe('$0');
    expect(formatCost(-0.01)).toBe('$0');
  });

  it('handles very large costs (≥$1000)', () => {
    expect(formatCost(1000)).toBe('$1000.00');
    expect(formatCost(12345.67)).toBe('$12345.67');
  });
});

describe('escapeLikePattern (P4-c — SQL LIKE wildcard escape)', () => {
  it('returns empty string unchanged', () => {
    expect(escapeLikePattern('')).toBe('');
  });

  it('returns plain text unchanged', () => {
    expect(escapeLikePattern('hello')).toBe('hello');
    expect(escapeLikePattern('Canvas · demo')).toBe('Canvas · demo');
    expect(escapeLikePattern('日本語')).toBe('日本語'); // CJK unaffected
  });

  it('escapes % wildcard', () => {
    // Without escape, "100%" would match "1000", "100X", etc. (LIKE wildcard).
    // With escape, "100\%" matches only the literal "100%".
    expect(escapeLikePattern('100%')).toBe('100\\%');
    expect(escapeLikePattern('%complete')).toBe('\\%complete');
    expect(escapeLikePattern('a%b%c')).toBe('a\\%b\\%c');
  });

  it('escapes _ wildcard', () => {
    // Without escape, "a_b" would match "aXb", "aYb", etc.
    expect(escapeLikePattern('a_b')).toBe('a\\_b');
    expect(escapeLikePattern('_start')).toBe('\\_start');
    expect(escapeLikePattern('foo_bar_baz')).toBe('foo\\_bar\\_baz');
  });

  it('escapes backslash itself FIRST (so escape char is not itself escaped)', () => {
    // A single backslash in input should become "\\\\" (two backslashes).
    expect(escapeLikePattern('\\')).toBe('\\\\');
    expect(escapeLikePattern('foo\\bar')).toBe('foo\\\\bar');
    // Mixed: backslash + % + _ — backslash must be doubled first so the \%
    // and \_ escapes don't get re-escaped.
    expect(escapeLikePattern('foo\\%_bar')).toBe('foo\\\\\\%\\_bar');
  });

  it('escapes a real-world query with both wildcards', () => {
    expect(escapeLikePattern('deploy_50%')).toBe('deploy\\_50\\%');
  });

  it('handles SQL-injection-style attempts (multi-wildcard)', () => {
    expect(escapeLikePattern('%; DROP TABLE--')).toBe('\\%; DROP TABLE--');
    expect(escapeLikePattern('_%_%')).toBe('\\_\\%\\_\\%');
  });
});
