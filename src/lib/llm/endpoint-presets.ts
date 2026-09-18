// Named OpenAI-compatible endpoint presets baked into the app code.
//
// A preset is a one-click (UI) or one-import (script) configuration for a
// SPECIFIC external OpenAI-compatible endpoint: provider id + base URL +
// API key + default model.
//
// ---- ACCESS RULE (durable — also recorded in the root AGENTS.md) ---------
//
// Endpoint presets must NEVER be invoked directly — no curl, bash, wget,
// fetch, or any other out-of-app tooling may talk to the preset's base URL.
// ALL interaction flows through the app's own code and HTTP surface:
//
//   - the Settings → LLM provider "Endpoint presets" chips (client store),
//   - POST /api/models (the app's own endpoint preflight / model listing),
//   - POST /api/agent (the app's own agent runner — the resolver builds a
//     synthetic openai-completions Model against the preset base URL).

import type { AppSettings } from '@/lib/settings/types';

/// A named, code-resident configuration for an external OpenAI-compatible
/// endpoint. Kept separate from the registry's 28 providers: a preset is
/// not a provider implementation, it is a filled-in configuration of the
/// generic `custom` provider.
export interface EndpointPreset {
  /// Stable id for lookups + React keys (e.g. 'beta').
  id: string;
  /// Short label rendered on the preset chip (e.g. 'BETA').
  label: string;
  /// What this endpoint is / why it exists. Tooltip in the Settings UI.
  description: string;
  /// The underlying registry provider the preset configures. Always
  /// 'custom' for now — presets target OpenAI-compatible endpoints the
  /// registry has no native entry for.
  provider: 'custom';
  /// OpenAI-compatible base URL (must end in /v1-style path, no trailing
  /// slash).
  baseURL: string;
  /// API key sent as `Authorization: Bearer <key>`. Baked into app code
  /// for placeholder-grade presets (not secrets).
  apiKey: string;
  /// Model id the endpoint serves (the agent run needs an explicit model
  /// name on the custom path — see pi-ai-model-resolver.ts).
  defaultModel: string;
}

/// All code-resident endpoint presets, in UI display order.
/// The array may be empty — the Settings UI "Endpoint presets" row renders
/// nothing when there are no presets defined.
export const ENDPOINT_PRESETS: readonly EndpointPreset[] = [];

/// Look up a preset by id. Returns undefined for unknown ids.
export function getEndpointPreset(id: string): EndpointPreset | undefined {
  return ENDPOINT_PRESETS.find((p) => p.id === id);
}

/// Settings patch that applies a preset in one step. Written to the
/// settings store via `patch()` (UI chip click) or spread into the
/// `settings` object of a POST /api/agent body (headless e2e callers).
/// The four field names are shared by AppSettings and AgentRunSettings,
/// so the same patch works for both.
export function endpointPresetPatch(preset: EndpointPreset): Pick<AppSettings, 'llmProvider' | 'apiKey' | 'modelName' | 'apiBaseUrl'> {
  return {
    llmProvider: preset.provider,
    apiKey: preset.apiKey,
    modelName: preset.defaultModel,
    apiBaseUrl: preset.baseURL,
  };
}

/// True when the given (partial) settings object is exactly this preset's
/// configuration — used to highlight the active chip in the Settings UI.
/// Tolerates missing fields (treats them as non-matching).
export function matchesEndpointPreset(
  s: Pick<Partial<AppSettings>, 'llmProvider' | 'apiKey' | 'modelName' | 'apiBaseUrl'> | undefined | null,
  preset: EndpointPreset,
): boolean {
  if (!s) return false;
  return (
    s.llmProvider === preset.provider &&
    (s.apiKey ?? '') === preset.apiKey &&
    (s.modelName ?? '') === preset.defaultModel &&
    (s.apiBaseUrl ?? '') === preset.baseURL
  );
}