// LLM provider abstraction layer.
//
// This module defines the contracts every LLM provider adapter must satisfy,
// plus the shared message/tool-call shapes the agent runner consumes. The
// design borrows the best ideas from three reference implementations:
//
//   - Vercel AI SDK V4 — `LanguageModelV4` interface with `doGenerate` /
//     `doStream`, normalized tool-call deltas, and a `createOpenAICompatible`
//     factory that covers ~13 popular providers with one code path.
//   - LiteLLM — `provider/model-id` string-prefix routing, capability flags
//     (`supports_function_calling`, `supports_vision`), and a runtime
//     registry that's cheap to extend with a single `register_provider()`
//     call.
//   - Open WebUI / LibreChat — runtime provider-switching UX (provider
//     dropdown → model dropdown → optional custom-endpoint escape hatch).
//
// The contract here is intentionally narrower than Vercel's: we only need
// non-streaming `chat.completions.create` (the runner calls without
// `stream: true`), so the interface is a single `generate()` method that
// returns an OpenAI-shaped response. This keeps every existing test that
// imports `LLMClient` from `runner.ts` working unchanged.
//
// Capability flags are first-class so the runner can skip tool-spec wiring
// for providers that don't support function calling (e.g. some Ollama models
// — `llama2` lacks tool support entirely). Without this gating, Ollama
// silently breaks on every prompt that needs tools.

/// One message in a chat completion request. Mirrors the OpenAI message
/// shape — provider adapters that use a native SDK (Anthropic, Google) are
/// responsible for translating this into the native format.
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /// Present on assistant messages that requested tool calls.
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  /// Present on tool-result messages (role='tool').
  tool_call_id?: string;
}

/// A tool definition in OpenAI's function-calling format. All providers
/// accept this shape natively OR the adapter translates it.
export interface LLMToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/// Parameters for `LLMClient.generate`. Matches the existing shape that
/// `runner.ts` builds, so no changes are needed in the runner.
export interface LLMGenerateParams {
  messages: LLMMessage[];
  tools?: LLMToolSpec[];
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  temperature?: number;
  max_tokens?: number;
}

/// A single tool call extracted from the model's response.
export interface LLMToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/// Normalized LLM response. This is the OpenAI shape — every adapter
/// (including the native Anthropic and Google ones) translates into this
/// shape so the runner has a single code path.
export interface LLMResponse {
  choices: Array<{
    message: {
      content?: string | null;
      tool_calls?: LLMToolCall[];
    };
    finish_reason?: string;
  }>;
  /// Token-usage telemetry. Optional — some local providers omit it.
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/// The minimal client interface the runner needs. Every provider adapter
/// returns an object satisfying this shape. This is the SAME shape as the
/// existing `LLMClient` in `runner.ts` (which mirrors the OpenAI SDK), so
/// the runner code stays unchanged.
export interface LLMClient {
  chat: {
    completions: {
      create: (params: LLMGenerateParams) => Promise<LLMResponse>;
    };
  };
}

/// Capability flags for a provider. Used to gate features like tool calling
/// — passing tool specs to a provider that doesn't support them causes
/// silent breakage or 400 errors.
export interface LLMProviderCapabilities {
  /// Whether the provider's API supports OpenAI-style function calling.
  /// When false, the runner drops `tools` and `tool_choice` from the
  /// request and relies on prompt-only reasoning.
  supportsToolCalling: boolean;
  /// Whether the provider supports streaming responses. (Currently unused —
  /// the runner calls without `stream: true` — but flagged for future use.)
  supportsStreaming: boolean;
  /// Whether the provider supports vision (multimodal image inputs).
  /// Currently informational; the runner doesn't send images yet.
  supportsVision: boolean;
}

/// Static metadata about a provider, used by the registry and UI.
/// Defined here (not in `registry.ts`) so adapters can self-document.
export interface LLMProviderMetadata {
  /// Stable identifier, e.g. 'openai', 'anthropic', 'zai'. Used in the
  /// `llmProvider` setting and in the registry's Map key.
  id: string;
  /// Human-readable name for the settings UI.
  label: string;
  /// Short description shown under the label in the UI.
  description: string;
  /// The official SDK / docs URL. Shown as "Get an API key →" link.
  docsUrl: string;
  /// The env var name(s) the adapter reads for the API key, in priority
  /// order. Empty array = sandbox auto-resolution only (z.ai).
  apiKeyEnvVars: string[];
  /// Default base URL for OpenAI-compatible providers. Empty for native
  /// SDK providers (Anthropic, Google) — the SDK has its own default.
  defaultBaseURL: string;
  /// Suggested default model. Empty = let the user choose / provider default.
  defaultModel: string;
  /// Popular models for this provider — shown in the settings UI as a
  /// dropdown of suggestions. The user can still type a custom model name.
  popularModels: string[];
  /// Whether this provider is OpenAI-API-compatible (and thus uses the
  /// shared fetch-based client). Native SDK providers set this to false.
  openAICompatible: boolean;
  /// Capability flags.
  capabilities: LLMProviderCapabilities;
  /// Whether the API key is required at request time. False for z.ai
  /// sandbox auto-credentials and local providers (Ollama, LM Studio).
  apiKeyRequired: boolean;
}

/// A factory function that produces an `LLMClient` for a given configuration.
/// Each provider registers one of these in the registry.
export type LLMClientFactory = (config: LLMProviderConfig) => Promise<LLMClient>;

/// User-supplied configuration for a provider. Built by the settings store
/// from the `llmProvider` selection + `apiKey` + `modelName` + `apiBaseUrl`.
export interface LLMProviderConfig {
  /// The provider id, e.g. 'openai', 'anthropic'.
  providerId: string;
  /// API key. May be empty for sandbox/local providers — the adapter falls
  /// back to env vars or anonymous access.
  apiKey: string;
  /// Model name (e.g. 'gpt-4o', 'claude-3-5-sonnet-20241022'). Empty =
  /// provider default.
  model: string;
  /// Custom base URL override. Empty = provider default.
  baseURL: string;
  /// Per-request timeout in ms for the built client (sub-agent completions
  /// can be big JSON / VLM-image calls that legitimately run minutes).
  /// Default: 120_000.
  timeoutMs?: number;
}

/// A registered provider = metadata + factory.
export interface LLMProviderEntry {
  metadata: LLMProviderMetadata;
  factory: LLMClientFactory;
}
