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

import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Model, Api } from '@earendil-works/pi-ai';
import ZAI from 'z-ai-web-dev-sdk';
import { normalizeLLMProvider, providerDefaultModel } from '../settings/types';
import { getProviderMetadata } from '../llm';
import type { AgentRunSettings } from '../settings/types';

// ---- Public types ----------------------------------------------------------

export interface ResolvedModel {
  /// The pi-ai Model object — pass to `createAgentSession({ model })`.
  model: Model<Api>;
  /// The runtime that owns the model + credentials. Pass to
  /// `createAgentSession({ modelRuntime })`.
  modelRuntime: ModelRuntime;
  /// Best-effort human-readable label for logging.
  label: string;
}

// ---- Resolver --------------------------------------------------------------

/// Resolve user-facing provider settings into a pi-ai Model + ModelRuntime.
///
/// Throws if no auth is configured for a non-zai provider.
export async function resolveModel(settings: AgentRunSettings | undefined): Promise<ResolvedModel> {
  const providerId = normalizeLLMProvider(settings?.llmProvider ?? 'zai');
  const userApiKey = settings?.apiKey ?? '';
  const userModelId = settings?.modelName ?? '';
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
    // default (DEFAULT_SETTINGS.modelName) is glm-5.3, which exists in the
    // pi-ai catalog directly — no mapping needed.
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

  // ---- Custom endpoint override --------------------------------------------
  // An explicit apiBaseUrl from settings points the model at the user's own
  // endpoint (Ollama / LM Studio / vLLM / a corporate proxy). Applied BEFORE
  // the z.ai sandbox override so the auto-detected sandbox endpoint still
  // wins when running key-less inside the sandbox (where apiBaseUrl is empty
  // and ZAI.create() resolves the internal endpoint).
  if (settings?.apiBaseUrl && !sandboxOverride) {
    model = { ...model, baseUrl: settings.apiBaseUrl };
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
  const providerId = normalizeLLMProvider(settings?.llmProvider ?? 'zai');
  const modelId = settings?.modelName || getProviderMetadata(providerId)?.defaultModel || providerDefaultModel(providerId);
  return `${providerId}/${modelId}`;
}
