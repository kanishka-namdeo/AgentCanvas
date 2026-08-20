# AGENTS.md — `src/lib/llm/`

## Purpose

The LLM provider abstraction layer: a unified interface (`LLMClient`) that normalizes 18 providers (17 named + 1 generic `custom`) into a single OpenAI-shaped `chat.completions.create` contract. The agent runner (`src/lib/agent/runner.ts`) consumes this interface exclusively — it has zero provider-specific code. The registry (`registry.ts`) is the single source of truth for provider metadata (UI labels, docs URLs, default models, capability flags) and factories.

## Ownership

- `types.ts` — Core contracts:
  - `LLMMessage` — chat message (system/user/assistant/tool) with OpenAI-style `tool_calls` + `tool_call_id`.
  - `LLMToolSpec` — OpenAI function-calling tool definition.
  - `LLMGenerateParams` — request params (`messages`, `tools`, `tool_choice`, `temperature`, `max_tokens`).
  - `LLMToolCall` / `LLMResponse` — normalized response shape (OpenAI format).
  - `LLMClient` — minimal client interface: `{ chat: { completions: { create: (params) => Promise<LLMResponse> } } }`. **This is the SAME shape as the previous inline `LLMClient` in `runner.ts`** — zero runner changes needed.
  - `LLMProviderCapabilities` — feature flags: `supportsToolCalling`, `supportsStreaming`, `supportsVision`. Used to gate tool-spec wiring (e.g., Ollama/Hugging Face models without tool support).
  - `LLMProviderMetadata` — static metadata for registry + UI: `id`, `label`, `description`, `docsUrl`, `apiKeyEnvVars`, `defaultBaseURL`, `defaultModel`, `popularModels[]`, `openAICompatible`, `capabilities`, `apiKeyRequired`.
  - `LLMClientFactory` — `(config) => Promise<LLMClient>`.
  - `LLMProviderConfig` — user config: `providerId`, `apiKey`, `model`, `baseURL`.
  - `LLMProviderEntry` — `{ metadata, factory }`.

- `registry.ts` — The `PROVIDERS` Map (18 entries). Exports: `getProvider(id)`, `getProviderMetadata(id)`, `listProviderIds()`, `listProviders()`, `createLLMClient(config)`, `registerProvider(id, entry)`.
  - **13 OpenAI-compatible providers** share `openAICompatibleFactory` (delegates to `createOpenAICompatible`): zai, openai, mistral, cohere, groq, together, deepseek, openrouter, fireworks, xai, perplexity, huggingface, ollama, lmstudio, vllm, custom.
  - **3 native adapters**: Anthropic (`createAnthropicClient`), Google Gemini (`createGeminiClient`), z.ai (uses OpenAI-compatible factory but auto-resolves credentials in sandbox).
  - Capability presets: `CAPS_FULL` (tools+streaming+vision), `CAPS_TOOLS_OK` (tools+streaming), `CAPS_NO_VISION`, `CAPS_NO_TOOLS` (streaming only).
  - `wrapNoTools(inner)` — strips `tools`/`tool_choice` from requests for providers lacking function calling.

- `openai-compatible.ts` — `createOpenAICompatible(opts)`: single fetch-based client for all OpenAI-compatible endpoints. Sends `stream: false`, passes `tools`/`tool_choice` as-is, Authorization Bearer auth, configurable timeout (default 120s), surfaces provider HTTP errors with body snippet.

- `anthropic.ts` — `createAnthropicClient(opts)`: native Anthropic Messages API adapter. Translates:
  - System message → top-level `system` field.
  - OpenAI `tool_calls` → Anthropic `tool_use` content blocks.
  - OpenAI `role: 'tool'` → Anthropic `tool_result` content blocks on `user` role.
  - Tool specs → `functionDeclarations` array.
  - Response: `text` + `tool_use` blocks → OpenAI `content` + `tool_calls`. Normalizes `stop_reason` → `finish_reason`. Auth: `x-api-key` header + `anthropic-version: 2023-06-01`.

- `gemini.ts` — `createGeminiClient(opts)`: native Gemini REST API (v1beta `generateContent`). Translates:
  - Messages → `contents` with `parts` (text/functionCall/functionResponse).
  - System → `systemInstruction`.
  - Tool specs → single `Tool` wrapper with `functionDeclarations` **array** (critical: all declarations in ONE wrapper, not one-per-tool — prior bug fixed).
  - Tool choice → `toolConfig.functionCallingConfig.mode` (AUTO/ANY/NONE + allowedFunctionNames).
  - Response: candidates → OpenAI `choices` with `content` + `tool_calls`. Normalizes `finishReason` → `finish_reason`. Auth: API key as query param `?key=`.

- `index.ts` — Barrel export re-exporting all types + registry functions.

## Local Contracts

### Provider Registration
- To add a provider: add entry to `PROVIDERS` in `registry.ts` with `metadata` + `factory`.
- For OpenAI-compatible providers: use `openAICompatibleFactory(metadata)` — handles env var fallback, baseURL/model validation, tool-support gating via `wrapNoTools`.
- For native providers: write a custom factory returning `LLMClient` (see `anthropic.ts`, `gemini.ts`).
- The `custom` provider is the escape hatch — no defaults, user supplies everything.

### Capability Gating
- `supportsToolCalling: false` → runner drops `tools` + `tool_choice` from request (via `wrapNoTools`). Critical for Ollama/Hugging Face/LM Studio models that lack function calling.
- `supportsStreaming: true` — informational; runner currently uses non-streaming only.
- `supportsVision: true` — informational; runner doesn't send images yet.

### Settings Integration
- `src/lib/settings/types.ts` `AppSettings` has: `llmProvider`, `apiKey`, `modelName`, `apiBaseUrl`.
- `agentRunSettings()` in `src/lib/settings/store.ts` extracts the runner-relevant subset.
- The canvas store's `promptAgent` injects settings into both WebSocket + HTTP paths.
- The runner's `LLMClient` is created via `createLLMClient({ providerId: settings.llmProvider, apiKey: settings.apiKey, model: settings.modelName, baseURL: settings.apiBaseUrl })` — see `runner.ts`.

### Error Handling
- All factories surface HTTP status + first 500 chars of error body.
- Timeout: 120s default (configurable via `timeoutMs`).
- AbortController + AbortSignal for cancellation (runner passes `signal` from fetch/WS).

## Work Guidance

- When adding a new provider: add to `registry.ts` `PROVIDERS`, use existing factory or write native adapter. Update `src/lib/settings/types.ts` `LLMProvider` union if it's a new named provider (not `custom`).
- When a provider changes API: update the corresponding adapter file only. The runner is isolated.
- When debugging LLM calls: check `dev.log` for HTTP status + error body. The factory throws with provider name + status.
- The `LLMClient` interface is **frozen** — do not add methods. If the runner needs new behavior, extend `LLMGenerateParams` / `LLMResponse` types.
- When changing `LLMMessage` / `LLMToolSpec` / `LLMResponse` shapes: update all 3 native adapters + OpenAI-compatible factory + runner (which builds the request).

## Verification

- `bunx tsc --noEmit` — typecheck.
- `bun run test` — `tests/unit/llm-providers.test.ts` tests the registry + factory creation (mocked).
- Manual: change provider in Settings → LLM provider, send a prompt — verify agent responds.
- Manual: test `custom` provider with a local Ollama/LM Studio endpoint.
- `bun run scripts/measure-tool-cost.ts` — measures token cost across providers.

## Child DOX Index

No child `AGENTS.md` files. This folder is flat: `types.ts`, `registry.ts`, `openai-compatible.ts`, `anthropic.ts`, `gemini.ts`, `index.ts`.

*Siblings: `../agent/AGENTS.md` (Agent layer), `../canvas/AGENTS.md` (Canvas state), `../sessions/AGENTS.md` (Session persistence), `../settings/AGENTS.md` (Settings store), `../pen/AGENTS.md` (.pen format), `../web/AGENTS.md` (Web search/fetch).*