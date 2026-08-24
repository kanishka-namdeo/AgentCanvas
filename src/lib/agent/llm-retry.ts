// Shared LLM call helper with retry on rate-limit (429) and transient network errors.
//
// The z.ai sandbox LLM driver enforces a per-account rate limit. When the agent
// fires several LLM round-trips in quick succession (typical for a 10+ tool-call
// design turn, or when the classifier + planner + main loop all run back-to-back),
// a 429 mid-turn used to abort the whole turn — the user saw
// "LLM request failed: 429" and lost all in-flight work.
//
// This helper retries with exponential backoff:
//   attempt 1 → wait 5s
//   attempt 2 → wait 10s
//   attempt 3 → wait 20s
//   attempt 4 → wait 40s
//   attempt 5 → give up, throw
//
// Non-429 errors (auth failures, validation errors, malformed requests) are
// thrown immediately — retrying won't help.
//
// Used by:
//   - runner.ts (main agent loop)
//   - classifier.ts (LLM fallback for ambiguous intents)
//   - planner.ts (multi-step plan generation)
//   - subagents/web-research.ts (sub-agent LLM calls)
//
// NOTE: this module deliberately does NOT import from runner.ts to avoid a
// circular dependency. The LLMClient interface is duplicated here as a
// structural type — it matches the OpenAI tool-calling protocol shape that
// z-ai-web-dev-sdk exposes.

export interface LLMCallParams {
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_calls?: any[];
    tool_call_id?: string;
  }>;
  tools?: any[];
  tool_choice?: string | any;
  temperature?: number;
}

/// Minimal LLM client shape — matches LLMClient in runner.ts without importing it.
export interface LLMClientLike {
  chat: {
    completions: {
      create: (params: LLMCallParams) => Promise<{
        choices: Array<{
          message: {
            content?: string | null;
            tool_calls?: Array<{
              id: string;
              type: 'function';
              function: { name: string; arguments: string };
            }>;
          };
        }>;
      }>;
    };
  };
}

export async function callLLMWithRetry(
  llm: LLMClientLike,
  params: LLMCallParams,
  opts: { maxRetries?: number; baseDelayMs?: number } = {},
): Promise<any> {
  const maxRetries = opts.maxRetries ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 5000;
  let lastErr: any;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await llm.chat.completions.create(params);
    } catch (err: any) {
      lastErr = err;
      const msg: string = (err?.message ?? '').toLowerCase();
      const is429 =
        msg.includes('429') ||
        msg.includes('too many requests') ||
        msg.includes('rate limit') ||
        msg.includes('rate_limit');
      // 500 / 502 / 503 / "operation failed" / "internal server error" — server-side
      // errors that are often transient (the z.ai gateway occasionally returns
      // `{"error":{"code":"500","message":"操作失败"}}` under load). Retry these.
      const is5xx =
        msg.includes('500') ||
        msg.includes('502') ||
        msg.includes('503') ||
        msg.includes('504') ||
        msg.includes('internal server error') ||
        msg.includes('操作失败') ||
        msg.includes('bad gateway') ||
        msg.includes('service unavailable') ||
        msg.includes('gateway timeout') ||
        msg.includes('upstream');
      const isTransient =
        msg.includes('timeout') ||
        msg.includes('network') ||
        msg.includes('econnreset') ||
        msg.includes('socket hang up') ||
        msg.includes('fetch failed');
      if (!is429 && !is5xx && !isTransient) throw err;
      if (attempt === maxRetries - 1) throw err;
      const waitMs = baseDelayMs * Math.pow(2, attempt); // 5s, 10s, 20s, 40s
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

