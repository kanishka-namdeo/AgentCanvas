// Shared agent-error classification — importable from BOTH the server (the
// NDJSON route + runner attach `code` / `retryable` to every agent:error event)
// and the client (the canvas store maps the class to a distinct toast), with
// no server-only dependencies so it stays bundle-safe.
//
// Pattern: bolt.diy's typed error envelope {statusCode, isRetryable, provider}
// + the Vercel AI SDK's APICallError.isRetryable classification. The wire
// stays backward compatible — `code` / `retryable` are ADDITIVE optional
// fields on the existing `agent:error` SyncEvent, and old clients that only
// read `message` keep working.

export type AgentErrorCode =
  | 'auth'
  | 'rate_limit'
  | 'quota'
  | 'network'
  | 'server'
  | 'timeout'
  | 'aborted'
  | 'length'
  | 'unknown';

export interface AgentErrorClass {
  code: AgentErrorCode;
  /// Whether retrying the same prompt is plausible to succeed soon.
  retryable: boolean;
  /// Short human title for toasts / error rows.
  title: string;
  /// One-line actionable hint (shown as the toast description prefix).
  hint: string;
}

const CLASSES: Record<AgentErrorCode, AgentErrorClass> = {
  auth: {
    code: 'auth',
    retryable: false,
    title: 'Authentication failed',
    hint: 'Check your API key in Settings → LLM provider.',
  },
  rate_limit: {
    code: 'rate_limit',
    retryable: true,
    title: 'Rate limited',
    hint: 'The provider is throttling requests — wait ~a minute and resend.',
  },
  quota: {
    code: 'quota',
    retryable: false,
    title: 'Quota exceeded',
    hint: 'Your provider account is out of credits — top up or switch models.',
  },
  network: {
    code: 'network',
    retryable: true,
    title: 'Network error',
    hint: 'Could not reach the LLM endpoint — check the API base URL / tunnel.',
  },
  server: {
    code: 'server',
    retryable: true,
    title: 'Provider error',
    hint: 'The endpoint returned a server error — retrying may work.',
  },
  timeout: {
    code: 'timeout',
    retryable: true,
    title: 'Stream stalled',
    hint: 'No agent output for a long time — the run was closed. Resend to retry.',
  },
  aborted: {
    code: 'aborted',
    retryable: false,
    title: 'Run stopped',
    hint: 'The run was cancelled before completing.',
  },
  length: {
    code: 'length',
    retryable: true,
    title: 'Output truncated',
    hint: 'The response hit the model token limit mid-output.',
  },
  unknown: {
    code: 'unknown',
    retryable: false,
    title: 'Agent error',
    hint: '',
  },
};

/// Normalize any thrown value into a displayable message string.
export function agentErrorMessage(err: unknown): string {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message || String(err);
  const anyErr = err as { message?: unknown; status?: unknown; statusCode?: unknown };
  if (typeof anyErr.message === 'string' && anyErr.message) {
    const status = anyErr.status ?? anyErr.statusCode;
    return typeof status === 'number' ? `HTTP ${status}: ${anyErr.message}` : anyErr.message;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/// Classify an agent error message into a stable code + retryability.
/// Order matters: check the most specific signals first.
export function classifyAgentError(message: string): AgentErrorClass {
  const msg = (message ?? '').toLowerCase();

  if (
    msg.includes('401') ||
    msg.includes('403') ||
    msg.includes('unauthorized') ||
    msg.includes('forbidden') ||
    msg.includes('invalid api key') ||
    msg.includes('incorrect api key') ||
    msg.includes('api key') && (msg.includes('invalid') || msg.includes('missing')) ||
    msg.includes('no api key configured')
  ) {
    return CLASSES.auth;
  }
  if (
    msg.includes('429') ||
    msg.includes('too many requests') ||
    msg.includes('rate limit') ||
    msg.includes('rate_limit') ||
    msg.includes('ratelimit')
  ) {
    return CLASSES.rate_limit;
  }
  if (
    msg.includes('quota') ||
    msg.includes('insufficient') ||
    msg.includes('billing') ||
    msg.includes('exceeded your current quota') ||
    msg.includes('credit')
  ) {
    return CLASSES.quota;
  }
  if (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('econnreset') ||
    msg.includes('socket hang up') ||
    msg.includes('fetch failed') ||
    msg.includes('network') ||
    msg.includes('enotfound') ||
    msg.includes('econnrefused') ||
    msg.includes('eai_again') ||
    msg.includes('tls')
  ) {
    return CLASSES.network;
  }
  if (
    msg.includes('500') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('504') ||
    msg.includes('internal server error') ||
    msg.includes('bad gateway') ||
    msg.includes('service unavailable') ||
    msg.includes('gateway timeout') ||
    msg.includes('upstream') ||
    msg.includes('操作失败')
  ) {
    return CLASSES.server;
  }
  if (msg.includes('stalled') || msg.includes('no agent output')) {
    return CLASSES.timeout;
  }
  if (msg.includes('abort') || msg.includes('cancel')) {
    return CLASSES.aborted;
  }
  if (msg.includes('truncated') || msg.includes('finish reason') || msg.includes('max_tokens')) {
    return CLASSES.length;
  }
  return CLASSES.unknown;
}

/// Build the extended agent:error payload (message + additive classification
/// fields) for the SyncEvent wire — keeps emit sites one-liner short.
export function classifiedAgentError(
  message: string,
): { type: 'agent:error'; message: string; code: AgentErrorCode; retryable: boolean } {
  const cls = classifyAgentError(message);
  return { type: 'agent:error', message, code: cls.code, retryable: cls.retryable };
}

/// Look up the display class for a wire `code` (client side of the typed
/// error envelope). Falls back to the 'unknown' class for unmapped codes.
export function agentErrorClassForCode(code: string | undefined): AgentErrorClass {
  if (code && code in CLASSES) {
    return CLASSES[code as AgentErrorCode];
  }
  return CLASSES.unknown;
}
