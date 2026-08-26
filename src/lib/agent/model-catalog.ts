// Model catalog — lists the models a user can ACTUALLY switch to.
//
// Powers the model switcher (AgentPanel badge dropdown + Settings → LLM
// provider → "load live models"). Follows the Cursor / Cline pattern: click
// the model badge → pick from models that are genuinely available right now.
//
// Three sources, in priority order (mirroring the resolver's dispatch logic
// in pi-ai-model-resolver.ts so the listed models resolve exactly the same
// way on the next turn):
//
//   1. 'endpoint' — the configured OpenAI-compatible endpoint's own
//      `GET /models` list (custom providers, Ollama, vLLM, proxies). Model
//      ids are enriched with context-window/max-tokens metadata by matching
//      them against pi-ai's static catalog (1267 models) — unmatched ids
//      (e.g. a niche proxy model) show without window info.
//
//   2. 'catalog' — pi-ai's static built-in catalog for native providers
//      (zai, openai, anthropic, google, …). No API key needed to LIST these;
//      availability is the catalog itself.
//
//   3. 'error'   — endpoint unreachable / misconfigured. We still return the
//      registry's curated popularModels as unverified suggestions so the UI
//      has something to show, with the error surfaced.
//
// Additionally reports whether the z.ai sandbox fallback is available (the
// same ZAI.create() probe the resolver uses) — inside the z.ai sandbox this
// is the always-usable escape hatch when the primary endpoint is down.
//
// Server-only: imports the pi-coding-agent SDK + z-ai-web-dev-sdk.

import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Model, Api } from '@earendil-works/pi-ai';
import ZAI from 'z-ai-web-dev-sdk';
import { normalizeLLMProvider, DEFAULT_SETTINGS } from '../settings/types';
import { getProviderMetadata } from '../llm';

// ---- Public types (safe to `import type` from client code) -------------------

export interface CatalogModelSummary {
  id: string;
  /// Human-readable name (catalog `name`, or the id for endpoint models).
  name: string;
  /// Context window in tokens. Null = unknown (endpoint model with no
  /// catalog match) — the UI renders "—".
  contextWindow: number | null;
  /// Max output tokens. Null = unknown.
  maxTokens: number | null;
  /// Whether the model supports extended thinking/reasoning.
  reasoning: boolean;
  /// Input modalities: ['text'] or ['text','image'].
  input: string[];
  /// True when contextWindow/maxTokens came from a catalog match (endpoint
  /// mode only) — lets the UI badge metadata as "known" vs estimated.
  fromCatalog?: boolean;
}

export interface ProviderModelsResult {
  /// Normalized provider id ('custom', 'zai', 'openai', …).
  provider: string;
  /// Display label from the registry.
  label: string;
  /// Where the list came from — see module comment.
  source: 'endpoint' | 'catalog' | 'error';
  /// Whether models from this provider can be used right now.
  ready: boolean;
  /// Human-readable reason when ready=false.
  readyReason?: string;
  /// Model list (possibly the registry's unverified suggestions on error).
  models: CatalogModelSummary[];
  /// Error message when source='error'.
  error?: string;
}

export interface ZaiSandboxModels {
  /// True when ZAI.create() resolved sandbox credentials — models below can
  /// be used with zero configuration.
  available: boolean;
  models: CatalogModelSummary[];
  /// Note for the UI (e.g. why unavailable).
  note?: string;
}

export interface ModelsListing {
  provider: ProviderModelsResult;
  /// z.ai sandbox availability + catalog (null when the configured provider
  /// is already 'zai' — the provider section covers it).
  zaiSandbox: ZaiSandboxModels | null;
}

// ---- Caches -------------------------------------------------------------------

/// ModelRuntime reads the static catalog from disk on create — cache one
/// instance per process (the resolver creates one per turn; listing doesn't
/// need to pay that cost on every dropdown open).
let cachedRuntime: ModelRuntime | null = null;
async function getRuntime(): Promise<ModelRuntime> {
  if (!cachedRuntime) {
    cachedRuntime = await ModelRuntime.create({
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
  }
  return cachedRuntime;
}

/// Endpoint /models fetch cache — 30s TTL per (baseUrl, apiKeyPrefix).
/// Prevents hammering a fragile tunnel when the dropdown is opened
/// repeatedly; matches the resolver's preflight cache philosophy.
const ENDPOINT_CACHE_TTL_MS = 30_000;
const endpointCache = new Map<string, { ids: string[]; error?: string; expiresAt: number }>();

/// z.ai sandbox availability cache — 60s TTL (ZAI.create() reads config
/// files; cheap, but no need to re-probe on every open).
const ZAI_CACHE_TTL_MS = 60_000;
let zaiAvailableCache: { available: boolean; note?: string; expiresAt: number } | null = null;

const ENDPOINT_TIMEOUT_MS = 5000;
/// Cap endpoint model lists — some proxies list hundreds of aliases; the
/// dropdown is scrollable + searchable, but the payload shouldn't be huge.
const MAX_ENDPOINT_MODELS = 100;
/// Cap catalog lists similarly (openai/openrouter catalogs are large).
const MAX_CATALOG_MODELS = 60;

// ---- Pure helpers (unit-tested) ------------------------------------------------

/// Parse an OpenAI-compatible `GET /models` response body into model ids.
/// Handles the canonical `{ data: [{ id }] }` shape plus common variants
/// (bare array, `{ models: [...] }`, `{ data: ["id"] }`) defensively —
/// proxies are inconsistent.
export function parseModelsResponse(body: unknown): string[] {
  let arr: unknown[] | undefined;
  if (Array.isArray(body)) {
    arr = body;
  } else if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    if (Array.isArray(b.data)) arr = b.data;
    else if (Array.isArray(b.models)) arr = b.models;
  }
  if (!arr) return [];
  const ids: string[] = [];
  for (const item of arr) {
    if (typeof item === 'string') {
      ids.push(item);
    } else if (item && typeof item === 'object') {
      const id = (item as Record<string, unknown>).id;
      if (typeof id === 'string' && id) ids.push(id);
    }
  }
  return [...new Set(ids)];
}

/// Map a pi-ai catalog Model to the wire summary shape.
export function toSummary(m: Model<Api>): CatalogModelSummary {
  return {
    id: m.id,
    name: m.name || m.id,
    contextWindow: typeof m.contextWindow === 'number' ? m.contextWindow : null,
    maxTokens: typeof m.maxTokens === 'number' ? m.maxTokens : null,
    reasoning: m.reasoning === true,
    input: Array.isArray(m.input) ? [...m.input] : ['text'],
  };
}

/// Build a cross-provider id → catalog-model index for enrichment. The zai
/// catalog's 'glm-5.3' and OpenAI's 'gpt-4o' are both findable from one map,
/// regardless of which provider the endpoint belongs to.
export function buildCatalogIndex(all: readonly Model<Api>[]): Map<string, Model<Api>> {
  const idx = new Map<string, Model<Api>>();
  for (const m of all) {
    // First occurrence wins (deterministic catalog order).
    if (!idx.has(m.id)) idx.set(m.id, m);
  }
  return idx;
}

/// Enrich raw endpoint model ids with catalog metadata where the id matches.
export function endpointModelsFromIds(
  ids: string[],
  catalogIndex: Map<string, Model<Api>>,
): CatalogModelSummary[] {
  const out: CatalogModelSummary[] = [];
  for (const id of ids.slice(0, MAX_ENDPOINT_MODELS)) {
    const match = catalogIndex.get(id);
    if (match) {
      out.push({ ...toSummary(match), id, name: id, fromCatalog: true });
    } else {
      out.push({
        id,
        name: id,
        contextWindow: null,
        maxTokens: null,
        reasoning: false,
        input: ['text'],
        fromCatalog: false,
      });
    }
  }
  return out;
}

// ---- Endpoint fetch -------------------------------------------------------------

async function fetchEndpointModelIds(
  baseUrl: string,
  apiKey: string,
): Promise<{ ids: string[]; error?: string }> {
  const cacheKey = `${baseUrl}::${apiKey.slice(0, 12)}`;
  const cached = endpointCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return { ids: cached.ids, error: cached.error };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ENDPOINT_TIMEOUT_MS);
  let ids: string[] = [];
  let error: string | undefined;
  try {
    const url = `${baseUrl.replace(/\/+$/, '')}/models`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      error = `Endpoint responded ${res.status} ${res.statusText || ''}`.trim();
    } else {
      const body: unknown = await res.json().catch(() => null);
      ids = parseModelsResponse(body);
      if (ids.length === 0) {
        error = 'Endpoint reachable, but /models returned no model ids';
      }
    }
  } catch (err) {
    error =
      err instanceof Error && err.name === 'AbortError'
        ? `Endpoint unreachable (timeout after ${ENDPOINT_TIMEOUT_MS / 1000}s)`
        : `Endpoint unreachable (${err instanceof Error ? err.message : 'network error'})`;
  } finally {
    clearTimeout(timeout);
  }

  endpointCache.set(cacheKey, {
    ids,
    error,
    expiresAt: Date.now() + ENDPOINT_CACHE_TTL_MS,
  });
  return { ids, error };
}

// ---- z.ai sandbox probe -----------------------------------------------------------

async function probeZaiSandbox(): Promise<{ available: boolean; note?: string }> {
  if (zaiAvailableCache && Date.now() < zaiAvailableCache.expiresAt) {
    return { available: zaiAvailableCache.available, note: zaiAvailableCache.note };
  }
  let available = false;
  let note: string | undefined;
  try {
    const zai = await ZAI.create();
    const cfg = (zai as unknown as { config?: { apiKey?: string } }).config;
    if (cfg?.apiKey) {
      available = true;
    } else {
      note = 'No sandbox credentials reported';
    }
  } catch (err) {
    note = err instanceof Error ? err.message : 'ZAI.create() failed';
  }
  zaiAvailableCache = { available, note, expiresAt: Date.now() + ZAI_CACHE_TTL_MS };
  return { available, note };
}

// ---- Main entry point --------------------------------------------------------------

/// List switchable models for the given provider settings. Mirrors the
/// resolver's dispatch decision (endpoint vs catalog) so whatever the user
/// picks here resolves the same way on the next agent turn.
export async function listModelsForSettings(settings: {
  llmProvider?: string;
  apiKey?: string;
  apiBaseUrl?: string;
}): Promise<ModelsListing> {
  const providerId = normalizeLLMProvider(settings.llmProvider ?? DEFAULT_SETTINGS.llmProvider);
  const apiKey = settings.apiKey ?? DEFAULT_SETTINGS.apiKey;
  const apiBaseUrl = (settings.apiBaseUrl ?? DEFAULT_SETTINGS.apiBaseUrl).trim();
  const meta = getProviderMetadata(providerId);
  const label = meta?.label ?? providerId;

  const runtime = await getRuntime();
  const catalog = runtime.getModels(providerId);
  const allModels = runtime.getModels();
  const catalogIndex = buildCatalogIndex(allModels);

  // Does the resolver route this provider through the custom-endpoint path?
  // (pi-ai-model-resolver.ts: baseUrl set + OpenAI-compatible provider.)
  const effectiveBaseUrl = apiBaseUrl || meta?.defaultBaseURL || '';
  const endpointMode =
    effectiveBaseUrl !== '' && (meta?.openAICompatible ?? true) && providerId !== 'zai';

  let provider: ProviderModelsResult;

  if (providerId === 'custom' && effectiveBaseUrl === '') {
    provider = {
      provider: providerId,
      label,
      source: 'error',
      ready: false,
      readyReason: 'Custom provider needs an API base URL',
      models: [],
      error: 'Set the API base URL in Settings → LLM provider.',
    };
  } else if (endpointMode) {
    const { ids, error } = await fetchEndpointModelIds(effectiveBaseUrl, apiKey);
    if (error) {
      // Unreachable endpoint — surface the error AND offer the registry's
      // curated suggestions as unverified fallback options.
      const suggestions: CatalogModelSummary[] = (meta?.popularModels ?? []).map((id) => ({
        id,
        name: id,
        contextWindow: catalogIndex.get(id)?.contextWindow ?? null,
        maxTokens: catalogIndex.get(id)?.maxTokens ?? null,
        reasoning: catalogIndex.get(id)?.reasoning === true,
        input: ['text'],
        fromCatalog: catalogIndex.has(id),
      }));
      provider = {
        provider: providerId,
        label,
        source: 'error',
        ready: false,
        readyReason: error,
        models: suggestions,
        error,
      };
    } else {
      provider = {
        provider: providerId,
        label,
        source: 'endpoint',
        ready: true,
        models: endpointModelsFromIds(ids, catalogIndex),
      };
    }
  } else if (catalog.length > 0) {
    provider = {
      provider: providerId,
      label,
      source: 'catalog',
      ready: true,
      models: catalog.slice(0, MAX_CATALOG_MODELS).map(toSummary),
    };
  } else {
    // Registry-only provider with no pi-ai catalog and no base URL —
    // nothing listable without more configuration.
    provider = {
      provider: providerId,
      label,
      source: 'error',
      ready: false,
      readyReason: `No model list available for "${providerId}"`,
      models: (meta?.popularModels ?? []).map((id) => ({
        id,
        name: id,
        contextWindow: null,
        maxTokens: null,
        reasoning: false,
        input: ['text'],
      })),
      error: `Provider "${providerId}" has no catalog or endpoint to list models from. Type the model name in Settings.`,
    };
  }

  // z.ai sandbox section — the always-available escape hatch (skipped when
  // the configured provider is already zai; the provider section covers it).
  let zaiSandbox: ZaiSandboxModels | null = null;
  if (providerId !== 'zai') {
    const probe = await probeZaiSandbox();
    const zaiModels = runtime.getModels('zai').map(toSummary);
    zaiSandbox = {
      available: probe.available && zaiModels.length > 0,
      models: zaiModels,
      note: probe.note,
    };
  }

  return { provider, zaiSandbox };
}
