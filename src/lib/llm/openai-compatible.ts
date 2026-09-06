// OpenAI-compatible LLM client factory.
//
// ~13 of the 17 providers we support expose an OpenAI-API-compatible
// `/v1/chat/completions` endpoint:
//
//   OpenAI, Azure OpenAI, Groq, Together AI, DeepSeek, OpenRouter,
//   Fireworks AI, xAI (Grok), Perplexity, Mistral, Cohere (compat),
//   Ollama, LM Studio, vLLM, z.ai.
//
// One fetch-based client covers them all. We send `stream: false` because
// the runner reads `choices[0].message` directly (it doesn't consume SSE).
//
// Tool calling is supported per OpenAI's spec — we pass `tools` and
// `tool_choice` as-is. The shared client does NOT translate tool-call
// formats; native providers (Anthropic, Google) have their own adapters.
//
// Error handling: we surface HTTP status + the first 500 chars of the body
// so the user can see the actual provider error (rate limit, bad key,
// unsupported model, etc.) without leaking the full response.
//
// This file is a near-copy of the `createOpenAICompatibleClient` that
// previously lived inside `runner.ts`. The original is now a thin shim
// that calls `createOpenAICompatible` from here — see runner.ts.

import type { LLMClient, LLMGenerateParams, LLMResponse } from './types';

export interface OpenAICompatibleClientOptions {
  /// API key. Sent as `Authorization: Bearer <key>`. Empty = anonymous
  /// (e.g. local Ollama).
  apiKey: string;
  /// Base URL, e.g. 'https://api.openai.com/v1'. Trailing slashes are
  /// stripped before appending '/chat/completions'.
  baseURL: string;
  /// Model name. Required — every OpenAI-compatible provider needs this
  /// in the request body.
  model: string;
  /// Optional extra headers. Used by providers that need custom auth
  /// (e.g. Azure's `api-key` header).
  extraHeaders?: Record<string, string>;
  /// Optional request timeout in ms. Default 120_000 (matches the existing
  /// behavior in runner.ts).
  timeoutMs?: number;
}

/// Build a minimal LLMClient that talks to any OpenAI-compatible endpoint.
/// Used by every Tier-1 provider in the registry.
// UI-audit round 4 (2026-09 LLM-config pass): trim baseURL defensively so a
// trailing space from the Settings input doesn't produce an Invalid URL
// TypeError. (The model-catalog Live-fetch path already trims; this brings
// the agent-runner path to parity.)
export function createOpenAICompatible(opts: OpenAICompatibleClientOptions): LLMClient {
  const { apiKey, baseURL: rawBaseURL, model: rawModel, extraHeaders, timeoutMs = 120_000 } = opts;
  const baseURL = rawBaseURL.trim();
  const model = rawModel.trim();

  if (!baseURL) {
    throw new Error('OpenAI-compatible client requires a baseURL');
  }
  if (!model) {
    throw new Error('OpenAI-compatible client requires a model name');
  }

  const url = baseURL.replace(/\/+$/, '') + '/chat/completions';

  return {
    chat: {
      completions: {
        create: async (params: LLMGenerateParams): Promise<LLMResponse> => {
          const body: Record<string, unknown> = {
            model,
            messages: params.messages,
            temperature: params.temperature ?? 0.4,
            stream: false,
          };
          if (params.max_tokens != null) {
            body.max_tokens = params.max_tokens;
          }
          if (params.tools && params.tools.length > 0) {
            body.tools = params.tools;
            body.tool_choice = params.tool_choice ?? 'auto';
          }
          // Qwen3-series models served via OpenAI-compatible endpoints:
          // disable server-side thinking mode for sub-agent calls (design
          // brief / critic JSON). Thinking tokens are pure latency for
          // fixed-schema JSON outputs. Both DashScope-style (enable_thinking)
          // and vLLM-style (chat_template_kwargs) knobs are sent; servers
          // that do not recognize a field ignore it.
          if (/^qwen/i.test(model)) {
            body.enable_thinking = false;
            body.chat_template_kwargs = { enable_thinking: false };
          }

          // Use AbortController for the timeout so we don't leak sockets.
          const controller = new AbortController();
          const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

          try {
            const res = await fetch(url, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
                ...(extraHeaders ?? {}),
              },
              body: JSON.stringify(body),
              signal: controller.signal,
            });

            if (!res.ok) {
              const text = await res.text().catch(() => '');
              throw new Error(
                `LLM error ${res.status} from ${baseURL}: ${text.slice(0, 500)}`,
              );
            }

            return (await res.json()) as LLMResponse;
          } finally {
            clearTimeout(timeoutHandle);
          }
        },
      },
    },
  };
}
