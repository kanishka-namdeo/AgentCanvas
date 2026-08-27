// pi-ai model resolver — translates user-facing provider settings into
// the `Model` + `ModelRuntime` objects expected by `createAgentSession`.
//
// The user picks an LLM provider in the Settings UI ("zai", "openai",
// "anthropic", "google", …) and optionally supplies an API key, model
// name, and base URL. This module resolves those into the typed objects
// the pi-coding-agent SDK needs:
//
//   const { model, modelRuntime } = await resolveModel(settings);
//   const { session } = await createAgentSession({ model, modelRuntime, ... });
//
// ---- Why this is non-trivial ------------------------------------------------
//
// Three credential paths must be handled:
//
// 1. **Explicit API key in settings** (production with user-supplied creds)
//    → Call `modelRuntime.setRuntimeApiKey(providerId, apiKey)` then
//      `modelRuntime.getModel(providerId, modelId)`.
//
// 2. **z.ai sandbox auto-credentials** (no API key, provider='zai', running
//    inside the z.ai sandbox) → The z-ai-web-dev-sdk auto-resolves credentials
//    from `~/.z-ai-config` / `/etc/.z-ai-config` / sandbox env. We instantiate
//    `ZAI.create()`, extract its private `config.apiKey`, and feed it to
//    pi-ai's `zai` provider via `setRuntimeApiKey`. This preserves the
//    zero-config sandbox experience while still routing through pi-ai.
//
// 3. **No credentials + non-z.ai provider** → Throw a clear error explaining
//    which env var to set.
//
// The `ModelRuntime` instance is constructed once per turn (cheap — it reads
// the static built-in model catalog) and shared between the main agent and
// any sub-agent spawning (sub-agents don't currently use pi-ai, but the
// runtime is reusable if we ever wire them in).
//
// ---- Custom OpenAI-compatible endpoints ----------------------------------
//
// 4. **Explicit `apiBaseUrl` in settings** (the DEFAULT since the endpoint
//    migration: provider 'custom', kimi-k2-5 on an OpenAI-compatible proxy)
//    → pi-ai's static catalog has no 'custom' provider and no knowledge of
//    user-supplied endpoints, so we register a minimal dispatch provider on
//    the runtime and build a SYNTHETIC `Model` (api 'openai-completions',
//    neutral compat profile) instead of spreading a catalog model — the
//    latter would carry the wrong model id plus provider-specific body
//    params (e.g. z.ai `thinking`/`tool_stream` fields).

import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createProvider, envApiKeyAuth } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import type { Model, Api } from '@earendil-works/pi-ai';
import ZAI from 'z-ai-web-dev-sdk';
import { normalizeLLMProvider, providerDefaultModel, DEFAULT_SETTINGS } from '../settings/types';
import { getProviderMetadata } from '../llm';
import type { AgentRunSettings } from '../settings/types';

/// Provider id used for the synthetic dispatch model on custom endpoints.
/// Registered on the per-turn ModelRuntime so `prepareRequest()` can find it.
const CUSTOM_PROVIDER_ID = 'custom';

// ---- Public types ----------------------------------------------------------

export interface ResolvedModel {
  /// The pi-ai Model object — pass to `createAgentSession({ model })`.
  model: Model<Api>;
  /// The runtime that owns the model + credentials. Pass to
  /// `createAgentSession({ modelRuntime })`.
  modelRuntime: ModelRuntime;
  /// Best-effort human-readable label for logging.
  label: string;
  /// True when this resolution already invoked the z.ai sandbox fallback
  /// (preflight detected the configured endpoint as unreachable). The
  /// reactive fallback in `runner-native.ts` reads this flag to honor the
  /// "at most ONE fallback retry per turn" bound — if the resolver already
  /// swapped to the z.ai sandbox, the runner does NOT retry again.
  usedFallback?: boolean;
}

// ---- z.ai sandbox fallback ------------------------------------------------
//
// When the configured endpoint is unreachable (network error, HTTP 5xx/429,
// or 401/403 from the endpoint), the resolver transparently swaps in a
// z.ai-sandbox-resolved Model (provider 'zai', model 'glm-5.3') using
// credentials auto-resolved by `z-ai-web-dev-sdk`. This keeps agent turns
// working even when a custom proxy is down.
//
// Two layers cooperate:
//   1. **Preflight** (here, in `resolveModel`): a 4s GET against
//      `${baseUrl}/models` BEFORE the session is created. Catches dead
//      tunnels, DNS failures, TLS resets, 5xx, 429, 401/403. Cached for
//      60s so we don't pay the latency on every turn.
//   2. **Reactive fallback** (in `runner-native.ts`): if the preflight
//      passed but the turn still produced zero `message_delta` AND zero
//      `tool_call_start` events (e.g. the endpoint returned an empty 200
//      body), the runner re-runs the turn ONCE with the z.ai sandbox model.
//      Bounded by `ResolvedModel.usedFallback` — if the preflight already
//      swapped, the runner does NOT retry.
//
// Both layers skip when the configured provider is already 'zai' (no point
// falling back to the same provider). If `ZAI.create()` throws (not in the
// z.ai sandbox / no creds), the fallback is skipped with a warn.

/// Module-level preflight cache. Keyed by `${baseUrl}::${apiKeyPrefix}`.
/// TTL: 60 seconds when healthy, 20 seconds when down — a flapping tunnel
/// (cold-connect > 4s on the first attempt, fine afterwards) recovers fast,
/// so a 'down' verdict must not poison the next turn for a full minute
/// (observed during the VLM exercise: probes succeeded while the app kept
/// serving cached 'down' → glm-5.3 fallback → rate-limited empty turns).
const PREFLIGHT_CACHE_TTL_MS = 60_000;
const PREFLIGHT_CACHE_DOWN_TTL_MS = 20_000;
const preflightCache = new Map<string, { result: 'ok' | 'down'; expiresAt: number }>();

async function fetchModels(baseUrl: string, apiKey: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${baseUrl.replace(/\/+$/, '')}/models`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    // Network error, TLS reset, DNS failure, abort timeout — all map to 'down'.
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/// Probe the configured OpenAI-compatible endpoint with a GET against
/// `${baseUrl}/models`. Returns 'ok' on HTTP 2xx, 'down' on network error
/// or any non-2xx status (5xx, 429, 401, 403, etc.). Cached per
/// (baseUrl, apiKeyPrefix): 60s for 'ok', 20s for 'down'.
///
/// VLM-exercise Fix 6: the first attempt uses a 4s timeout; on failure it
/// RETRIES once with 8s after a 500ms pause. Cold tunnels (pinggy) commonly
/// take >4s for the first TLS handshake and connect fine immediately after —
/// a single-attempt preflight declared them dead and forced the sandbox
/// fallback (which was itself rate-limited) for turns that would have worked.
async function preflightEndpoint(baseUrl: string, apiKey: string): Promise<'ok' | 'down'> {
  const cacheKey = `${baseUrl}::${apiKey.slice(0, 12)}`;
  const cached = preflightCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.result;
  }

  let ok = await fetchModels(baseUrl, apiKey, 4_000);
  if (!ok) {
    await new Promise((r) => setTimeout(r, 500));
    ok = await fetchModels(baseUrl, apiKey, 8_000);
  }
  const result: 'ok' | 'down' = ok ? 'ok' : 'down';

  preflightCache.set(cacheKey, {
    result,
    expiresAt: Date.now() + (result === 'ok' ? PREFLIGHT_CACHE_TTL_MS : PREFLIGHT_CACHE_DOWN_TTL_MS),
  });
  return result;
}

/// Build a z.ai-sandbox-resolved Model + ModelRuntime using credentials
/// auto-resolved by `z-ai-web-dev-sdk` (reads `~/.z-ai-config` /
/// `/etc/.z-ai-config` / sandbox env). Returns `null` if `ZAI.create()`
/// throws or reports no credentials (i.e. not in the z.ai sandbox).
///
/// The resolved model is `glm-5.3` (the previous default, known to work
/// inside the sandbox). The runtime applies the sandbox OAuth header
/// bundle when ZAI reports an OAuth token + non-default baseUrl (mirrors
/// the same logic in `resolveModel` for the `zai` provider path).
export async function resolveZaiSandboxFallback(): Promise<ResolvedModel | null> {
  let zaiConfig: {
    apiKey?: string;
    baseUrl?: string;
    token?: string;
    userId?: string;
    chatId?: string;
  };
  try {
    const zai = await ZAI.create();
    // `config` is private on ZAI; cast to access at runtime.
    zaiConfig = (zai as unknown as {
      config: {
        apiKey?: string;
        baseUrl?: string;
        token?: string;
        userId?: string;
        chatId?: string;
      };
    }).config;
  } catch (err) {
    console.warn(
      `[llm-fallback] z.ai sandbox unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  if (!zaiConfig?.apiKey) {
    console.warn('[llm-fallback] z.ai sandbox reported no API key — skipping fallback');
    return null;
  }

  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  await modelRuntime.setRuntimeApiKey('zai', zaiConfig.apiKey);

  // If ZAI gave us an OAuth token + a non-default baseUrl, we're in the
  // sandbox — use those credentials directly via header override on the
  // Model object. The z-ai-web-dev-sdk sends 5 headers; we mirror that.
  let sandboxOverride: { baseUrl: string; headers: Record<string, string> } | undefined;
  if (zaiConfig.token && zaiConfig.baseUrl && zaiConfig.userId && zaiConfig.chatId) {
    sandboxOverride = {
      baseUrl: zaiConfig.baseUrl,
      headers: {
        Authorization: `Bearer ${zaiConfig.apiKey ?? 'Z.ai'}`,
        'X-Token': zaiConfig.token,
        'X-User-Id': zaiConfig.userId,
        'X-Chat-Id': zaiConfig.chatId,
        'X-Z-AI-From': 'Z',
      },
    };
  }

  // glm-5.3 is the previous default, known to work inside the z.ai sandbox.
  let model = modelRuntime.getModel('zai', 'glm-5.3');
  if (!model) {
    // Fall back to the first available z.ai model if glm-5.3 disappears
    // from a future pi-ai catalog revision. Resilience > exact-match.
    const all = modelRuntime.getModels('zai');
    if (all.length === 0) {
      console.warn('[llm-fallback] no z.ai models in pi-ai catalog — skipping fallback');
      return null;
    }
    model = all[0];
  }

  if (sandboxOverride) {
    model = {
      ...model,
      baseUrl: sandboxOverride.baseUrl,
      headers: { ...model.headers, ...sandboxOverride.headers },
      // The z.ai sandbox endpoint caps max_tokens at 98304; pi-ai's default
      // catalog says maxTokens=131072 which the sandbox rejects. Cap it.
      maxTokens: Math.min(model.maxTokens, 81920),
    };
  }

  return {
    model,
    modelRuntime,
    label: `zai/${model.id} (sandbox fallback)`,
    usedFallback: true,
  };
}

// ---- Resolver --------------------------------------------------------------

/// Build a synthetic pi-ai Model for a custom OpenAI-compatible endpoint.
///
/// Mirrors the shape pi-coding-agent's llama.cpp extension uses for custom
/// OpenAI-compatible servers:
///   - `api: 'openai-completions'` → POST {baseUrl}/chat/completions
///   - neutral compat profile: no provider-specific thinking format, no
///     `store`/`developer`/`reasoning_effort` params, classic `max_tokens`
///     field, no strict tool mode — unknown servers get a plain OpenAI body
///   - `reasoning: false` → no thinking/reasoning params are ever sent
///   - tool calling is inherently enabled: the openai-completions API always
///     converts + sends `context.tools`, which the agent loop depends on
///   - cost 0 (unknown pricing), conservative context/output windows
function buildCustomEndpointModel(baseUrl: string, modelId: string): Model<Api> {
  return {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    provider: CUSTOM_PROVIDER_ID,
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 32768,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: true,
      supportsStrictMode: false,
      maxTokensField: 'max_tokens',
    },
  };
}

/// Resolve user-facing provider settings into a pi-ai Model + ModelRuntime.
///
/// Throws if no auth is configured for a non-zai provider.
export async function resolveModel(settings: AgentRunSettings | undefined): Promise<ResolvedModel> {
  // Settings-less callers (e.g. POST /api/agent with no `settings` field)
  // get the app defaults — which since the endpoint migration point at the
  // custom OpenAI-compatible server (kimi-k2-5), NOT the z.ai sandbox.
  const providerId = normalizeLLMProvider(settings?.llmProvider ?? DEFAULT_SETTINGS.llmProvider);
  const userApiKey = settings?.apiKey ?? DEFAULT_SETTINGS.apiKey;
  const userModelId = settings?.modelName ?? DEFAULT_SETTINGS.modelName;
  const meta = getProviderMetadata(providerId);
  // pi-ai's static built-in catalog uses different model IDs than our
  // legacy OpenAI-shaped registry. Map the legacy defaults to their
  // pi-ai equivalents. This is the only place that needs to know about
  // both naming schemes — the rest of the app keeps using the legacy IDs
  // in settings, and they get translated here.
  const legacyToPiAiModel: Record<string, string> = {
    // Our registry previously said zai's default is glm-4.6, but pi-ai's zai
    // catalog ships glm-4.7 (the successor). Existing user settings may still
    // hold glm-4.6 — map it so their config keeps resolving. The current
    // default (DEFAULT_SETTINGS.modelName) is kimi-k2-5 on a custom endpoint,
    // which never touches the pi-ai catalog (see the synthetic model path
    // below); a stored 'glm-5.3' still resolves via the zai catalog.
    'glm-4.6': 'glm-4.7',
  };
  const requestedModelId =
    userModelId || meta?.defaultModel || providerDefaultModel(providerId);
  const modelId = legacyToPiAiModel[requestedModelId] ?? requestedModelId;

  // Construct the runtime. `ModelRuntime.create()` is cheap — it loads the
  // built-in model catalog from disk (no network unless `allowModelNetwork: true`).
  const modelRuntime = await ModelRuntime.create({
    // Disable the network catalog refresh — we only need the static built-in
    // models that ship with pi-ai. This avoids a slow startup when the
    // sandbox has no outbound network.
    allowModelNetwork: false,
    refreshOnCreate: false,
  });

  // ---- Credential resolution ----------------------------------------------
  let effectiveApiKey = userApiKey;
  // Optional OAuth-style header bundle + custom baseUrl for the z.ai sandbox.
  // The z.ai sandbox uses an INTERNAL API at `https://internal-api.z.ai/v1`
  // with a multi-header auth scheme (Authorization + X-Token + X-Chat-Id +
  // X-User-Id + X-Z-AI-From). Pi-ai's `zaiProvider()` is hardcoded to
  // `https://api.z.ai/api/coding/paas/v4` with API-key auth — a different
  // endpoint with a different auth scheme. We override the model's `baseUrl`
  // + `headers` to use the sandbox endpoint + sandbox headers when
  // ZAI.create() reports an OAuth token.
  let sandboxOverride: { baseUrl: string; headers: Record<string, string> } | undefined;

  if (providerId === 'zai' && !effectiveApiKey) {
    try {
      const zai = await ZAI.create();
      // `config` is private on ZAI; cast to access at runtime. The shape is
      // `{ baseUrl, apiKey, chatId?, userId?, token? }` per z-ai-web-dev-sdk/dist/index.js.
      const zaiConfig = (zai as unknown as {
        config: {
          apiKey?: string;
          baseUrl?: string;
          token?: string;
          userId?: string;
          chatId?: string;
        };
      }).config;
      if (zaiConfig?.apiKey) {
        effectiveApiKey = zaiConfig.apiKey;
      }
      // If ZAI gave us an OAuth token + a non-default baseUrl, we're in the
      // sandbox — use those credentials directly via header override on the
      // Model object. The z-ai-web-dev-sdk sends 5 headers; we mirror that.
      if (zaiConfig?.token && zaiConfig?.baseUrl && zaiConfig?.userId && zaiConfig?.chatId) {
        sandboxOverride = {
          baseUrl: zaiConfig.baseUrl,
          headers: {
            Authorization: `Bearer ${zaiConfig.apiKey ?? 'Z.ai'}`,
            'X-Token': zaiConfig.token,
            'X-User-Id': zaiConfig.userId,
            'X-Chat-Id': zaiConfig.chatId,
            'X-Z-AI-From': 'Z',
          },
        };
      }
    } catch {
      // Fall through to the error below — no creds available.
    }
  }

  if (!effectiveApiKey && !sandboxOverride) {
    const envVars = meta?.apiKeyEnvVars?.join(' or ') ?? `${providerId.toUpperCase()}_API_KEY`;
    throw new Error(
      `No API key configured for provider "${providerId}". ` +
        `Set the ${envVars} environment variable, or open Settings → LLM provider and paste your API key. ` +
        (providerId === 'zai'
          ? 'Inside the z.ai sandbox, ensure ~/.z-ai-config exists (z-ai-web-dev-sdk auto-resolves it).'
          : ''),
    );
  }

  // ---- Custom OpenAI-compatible endpoint path ------------------------------
  // An explicit apiBaseUrl from settings points the runner at a user-supplied
  // endpoint (the DEFAULT since the endpoint migration: provider 'custom' →
  // kimi-k2-5 behind an OpenAI-compatible proxy; also Ollama / LM Studio /
  // vLLM / corporate proxies for any OpenAI-compatible provider). Checked
  // BEFORE the z.ai sandbox override so the auto-detected sandbox endpoint
  // still wins when running key-less inside the sandbox (where apiBaseUrl is
  // empty and ZAI.create() resolves the internal endpoint). Non-OpenAI-
  // compatible providers (anthropic / google) keep the legacy spread override
  // below — their native APIs don't route through a synthetic
  // openai-completions model.
  const customBaseUrl = settings?.apiBaseUrl?.trim() ?? DEFAULT_SETTINGS.apiBaseUrl.trim();
  const useCustomEndpoint =
    customBaseUrl !== '' && !sandboxOverride && (meta?.openAICompatible ?? true);

  if (useCustomEndpoint) {
    if (!modelId) {
      throw new Error(
        `Provider "${providerId}" with a custom endpoint needs a model name. ` +
          'Set it in Settings → LLM provider → Model.',
      );
    }

    // ---- Preflight the configured endpoint --------------------------------
    //
    // If the configured endpoint is dead (TLS reset / DNS failure / 5xx / 429 /
    // 401 / 403), swap to the z.ai sandbox fallback BEFORE building the
    // synthetic custom Model. The runner then creates the AgentSession against
    // the z.ai sandbox model directly — no double turn_end / streaming
    // weirdness, no half-finished attempt to clean up. Skipped when the
    // configured provider is already 'zai' (no point falling back to itself)
    // or when ZAI.create() reports no sandbox creds.
    //
    // The probe is cached for 60s per (baseUrl, apiKeyPrefix) so we don't pay
    // the 4s latency on every turn. A dead tunnel doesn't come back in 60s,
    // and a healthy endpoint doesn't go down in 60s — the cache TTL is safe.
    if (providerId !== 'zai') {
      const probe = await preflightEndpoint(customBaseUrl, effectiveApiKey);
      if (probe === 'down') {
        console.warn(
          `[llm-fallback] primary endpoint ${customBaseUrl} unreachable (network error or non-2xx on /models); retrying turn with z.ai sandbox / glm-5.3`,
        );
        const fallback = await resolveZaiSandboxFallback();
        if (fallback) {
          return fallback;
        }
        // No z.ai sandbox creds available — proceed against the configured
        // (dead) endpoint. The runner's silent-failure guard will surface
        // the empty response as an agent:error after the turn.
        console.warn(
          '[llm-fallback] z.ai sandbox fallback unavailable — proceeding against the configured endpoint',
        );
      }
    }

    const customModel = buildCustomEndpointModel(customBaseUrl, modelId);

    // Register a minimal dispatch provider on THIS runtime instance (the
    // runtime is created per turn, so there is no cross-turn state). Without
    // it, `modelRuntime.stream()` would fail with "Unknown provider: custom".
    // Pattern per pi-ai's createProvider() docs (custom OpenAI-compatible
    // endpoints) — the synthetic model is also exposed via getModel().
    const customProvider = createProvider({
      id: CUSTOM_PROVIDER_ID,
      name: 'Custom (OpenAI-compatible)',
      baseUrl: customBaseUrl,
      // The runtime API key (set right below) always wins over env vars, so
      // the env list is just a documented fallback for headless callers.
      auth: { apiKey: envApiKeyAuth('Custom endpoint API key', ['CUSTOM_API_KEY']) },
      models: [customModel],
      api: openAICompletionsApi(),
    });
    modelRuntime.registerNativeProvider(customProvider);

    // Push the API key into the runtime for the synthetic model's provider —
    // `prepareRequest()` resolves it via `getAuth()` and the request goes out
    // with `Authorization: Bearer <key>` to the custom baseUrl.
    await modelRuntime.setRuntimeApiKey(CUSTOM_PROVIDER_ID, effectiveApiKey);

    return {
      model: customModel,
      modelRuntime,
      label: `${CUSTOM_PROVIDER_ID}/${customModel.id}`,
    };
  }

  if (providerId === CUSTOM_PROVIDER_ID) {
    // 'custom' with no apiBaseUrl can't work (the registry has no default
    // base URL for it) — fail with a actionable message instead of the
    // generic "model not found" below.
    throw new Error(
      'Provider "custom" requires an API base URL. ' +
        'Set it in Settings → LLM provider → API base URL (e.g. https://your-endpoint.example.com/v1).',
    );
  }

  // Push the API key into the runtime. This makes it available to all
  // subsequent `getModel` / `stream` calls for this provider. We always
  // set this — even when using a sandbox OAuth token override, because
  // the SDK's `prompt()` method does its own auth check via
  // `modelRuntime.getAuth(provider)` and refuses to run if no API key
  // is registered. The actual request then uses the model's `headers`
  // (which we override below to use the OAuth Bearer token).
  if (effectiveApiKey) {
    await modelRuntime.setRuntimeApiKey(providerId, effectiveApiKey);
  } else if (sandboxOverride) {
    // Sandbox case: no real API key, but we have an OAuth token. Set a
    // placeholder so the SDK's auth check passes; the real auth is
    // delivered via the model's Authorization header.
    await modelRuntime.setRuntimeApiKey(providerId, 'sandbox-oauth-placeholder');
  }

  // ---- Model lookup -------------------------------------------------------
  let model = modelRuntime.getModel(providerId, modelId);
  if (!model) {
    // Fall back to the first available model from this provider. This makes
    // the resolver robust to pi-ai catalog changes between SDK versions —
    // if a specific model ID disappears, we use whatever's available rather
    // than crashing the turn.
    const all = modelRuntime.getModels(providerId);
    if (all.length > 0) {
      model = all[0];
    }
  }
  if (!model) {
    throw new Error(
      `Model "${modelId}" not found in provider "${providerId}". ` +
        `Check the model name spelling, or call modelRuntime.getModels("${providerId}") to list available models.`,
    );
  }

  // Non-OpenAI-compatible providers (anthropic / google) with an explicit
  // apiBaseUrl: keep the legacy baseUrl spread — their native APIs (anthropic-
  // messages / google-generative-ai) are dispatched from the catalog model.
  if (customBaseUrl && !sandboxOverride) {
    model = { ...model, baseUrl: customBaseUrl };
  }

  // Apply sandbox override: spread a new Model object with the sandbox
  // baseUrl + Authorization header. We don't mutate the original (it's
  // shared with other callers via the ModelRuntime cache).
  if (sandboxOverride) {
    model = {
      ...model,
      baseUrl: sandboxOverride.baseUrl,
      headers: { ...model.headers, ...sandboxOverride.headers },
      // The z.ai sandbox endpoint caps max_tokens at 98304; pi-ai's default
      // catalog says maxTokens=131072 which the sandbox rejects with
      // "max_tokens参数非法：限制数值范围[1,98304]". Cap it to 81920 to
      // leave headroom for the system prompt + conversation history.
      maxTokens: Math.min(model.maxTokens, 81920),
    };
  }

  return {
    model,
    modelRuntime,
    label: `${providerId}/${model.id}`,
  };
}

/// Build a label for logging without resolving the full model (lighter-weight
/// helper for non-runner call sites that just want a display string).
export function describeProvider(settings: AgentRunSettings | undefined): string {
  const providerId = normalizeLLMProvider(settings?.llmProvider ?? 'custom');
  const modelId = settings?.modelName || getProviderMetadata(providerId)?.defaultModel || providerDefaultModel(providerId);
  return `${providerId}/${modelId}`;
}
