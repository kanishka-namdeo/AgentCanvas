// Unit tests — agent error classification (src/lib/agent-error.ts).
//
// The classifier powers the typed error envelope on the wire (server attaches
// code/retryable to every agent:error) and the classified toasts on the
// client. These tests pin the classification contract: stable codes for the
// failure families users actually hit (auth / rate-limit / quota / network /
// server / timeout / abort / truncation).

import { describe, it, expect } from 'vitest';
import {
  classifyAgentError,
  agentErrorMessage,
  agentErrorClassForCode,
  classifiedAgentError,
} from '@/lib/agent-error';

describe('classifyAgentError', () => {
  it('classifies auth failures (401/403/invalid key)', () => {
    expect(classifyAgentError('HTTP 401: Unauthorized').code).toBe('auth');
    expect(classifyAgentError('403 Forbidden').code).toBe('auth');
    expect(classifyAgentError('Invalid API key provided').code).toBe('auth');
    expect(classifyAgentError('No API key configured for provider "custom"').code).toBe('auth');
  });

  it('classifies rate limiting (429)', () => {
    const cls = classifyAgentError('HTTP 429: Too Many Requests');
    expect(cls.code).toBe('rate_limit');
    expect(cls.retryable).toBe(true);
    expect(classifyAgentError('rate limit exceeded for requests').code).toBe('rate_limit');
  });

  it('classifies quota / billing errors', () => {
    expect(classifyAgentError('You exceeded your current quota').code).toBe('quota');
    expect(classifyAgentError('insufficient credits').code).toBe('quota');
  });

  it('classifies network failures as retryable', () => {
    const cls = classifyAgentError('fetch failed: ECONNRESET');
    expect(cls.code).toBe('network');
    expect(cls.retryable).toBe(true);
    expect(classifyAgentError('socket hang up').code).toBe('network');
    expect(classifyAgentError('request timeout after 30000ms').code).toBe('network');
  });

  it('classifies 5xx provider errors', () => {
    const cls = classifyAgentError('HTTP 502: Bad Gateway');
    expect(cls.code).toBe('server');
    expect(cls.retryable).toBe(true);
    expect(classifyAgentError('503 Service Unavailable').code).toBe('server');
    expect(classifyAgentError('upstream connect error').code).toBe('server');
  });

  it('classifies stream-stall / abort / truncation', () => {
    expect(classifyAgentError('Agent stream stalled — no output for 2 minutes').code).toBe('timeout');
    expect(classifyAgentError('The operation was aborted').code).toBe('aborted');
    expect(classifyAgentError('Output truncated by max_tokens').code).toBe('length');
  });

  it('falls back to unknown for unmatched messages', () => {
    const cls = classifyAgentError('Something odd happened');
    expect(cls.code).toBe('unknown');
    expect(cls.retryable).toBe(false);
  });

  it('checks auth before rate-limit (401 beats everything)', () => {
    // A message mentioning both 401 and 429 must classify as auth — the
    // provider's real error body often contains many status-like tokens.
    expect(classifyAgentError('429 seen while retrying, but ultimately 401 Unauthorized').code).toBe('auth');
  });
});

describe('agentErrorMessage', () => {
  it('normalizes Error objects with a status prefix', () => {
    expect(agentErrorMessage(new Error('boom'))).toBe('boom');
    expect(agentErrorMessage({ message: 'nope', status: 503 })).toBe('HTTP 503: nope');
    expect(agentErrorMessage(undefined)).toBe('unknown error');
    expect(agentErrorMessage('plain string')).toBe('plain string');
  });
});

describe('classifiedAgentError (wire envelope)', () => {
  it('produces the additive agent:error payload', () => {
    const event = classifiedAgentError('HTTP 429: Too Many Requests');
    expect(event).toEqual({
      type: 'agent:error',
      message: 'HTTP 429: Too Many Requests',
      code: 'rate_limit',
      retryable: true,
    });
  });
});

describe('agentErrorClassForCode (client side)', () => {
  it('maps known wire codes to display classes', () => {
    expect(agentErrorClassForCode('auth').title).toBe('Authentication failed');
    expect(agentErrorClassForCode('rate_limit').retryable).toBe(true);
  });

  it('falls back for unknown / missing codes', () => {
    expect(agentErrorClassForCode(undefined).code).toBe('unknown');
    expect(agentErrorClassForCode('nonsense').code).toBe('unknown');
  });
});
