'use client';

// useModelCatalog — client hook that fetches the switchable-model listing
// from POST /api/models for the CURRENT settings (provider + key + base URL).
//
// Used by the AgentPanel model-badge switcher, the AgentPanel's image-input
// capability guard, and the Settings → LLM provider live-model loader.
// The heavy lifting (endpoint probe, catalog lookup, z.ai sandbox check) is
// server-side — this hook is a thin fetch + state wrapper with manual refresh
// (no polling; the catalog is stable).
//
// State is MODULE-LEVEL and shared: every hook instance sees the same
// listing, so one fetch serves the switcher, the capability guard, and
// Settings simultaneously (and they stay consistent when one refreshes).
// `autoFetch: true` mounts trigger at most one request per module lifetime
// unless `refresh()` is called again explicitly.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelsListing } from '@/lib/agent/model-catalog';
import { useSettings } from '@/lib/settings/store';

export interface ModelCatalogState {
  loading: boolean;
  data: ModelsListing | null;
  error: string | null;
}

// ---- Shared module state ----------------------------------------------------

let shared: ModelCatalogState = {
  loading: false,
  data: null,
  error: null,
};
const listeners = new Set<() => void>();
let inFlight = false;

function notify() {
  for (const l of listeners) l();
}

function setShared(patch: Partial<ModelCatalogState>) {
  shared = { ...shared, ...patch };
  notify();
}

async function fetchCatalog() {
  if (inFlight) return;
  inFlight = true;
  setShared({ loading: true, error: null });
  try {
    const settings = useSettings.getState();
    const res = await fetch('/api/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: settings.llmProvider,
        apiKey: settings.apiKey,
        apiBaseUrl: settings.apiBaseUrl,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as ModelsListing;
    setShared({ loading: false, data, error: null });
  } catch (err) {
    setShared({
      loading: false,
      error: err instanceof Error ? err.message : 'Failed to load models',
    });
  } finally {
    inFlight = false;
  }
}

// ---- Hook -------------------------------------------------------------------

export function useModelCatalog(opts?: {
  autoFetch?: boolean;
  /** UI-audit round 4 (2026-09): when true, clear the shared cache when the
   * user changes provider / apiKey / apiBaseUrl. Prevents stale models from
   * showing after the user edits a field but doesn't click "Live" again. */
  invalidateOnSettingsChange?: boolean;
}) {
  const autoFetch = opts?.autoFetch === true;
  const invalidateOnSettingsChange = opts?.invalidateOnSettingsChange === true;
  // Re-render on shared-state changes (classic observer subscription).
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);

  // Mount-triggered fetch (AgentPanel capability guard). Only fires when
  // nothing was ever fetched in this module's lifetime — the switcher's
  // open-triggered refresh or a Settings load may have already populated it.
  const autoFetched = useRef(false);
  useEffect(() => {
    if (!autoFetch || autoFetched.current) return;
    autoFetched.current = true;
    if (!inFlight && shared.data === null && shared.error === null) {
      void fetchCatalog();
    }
  }, [autoFetch]);

  // UI-audit round 4 (2026-09 LLM-config pass): invalidate the shared cache
  // when the user changes any of the settings that determine which models
  // are listed. Without this, the dropdown shows stale models from the
  // previous (provider, apiKey, apiBaseUrl) tuple after the user edits a
  // field but doesn't click "Live" again. We read settings via
  // useSettings.getState() (no re-render subscription) and key the effect
  // on the actual values so it only fires when one of them changes.
  // Exported separately as `invalidateOnSettingsChange` so callers
  // (LLMSection, ModelSwitcher) can opt in — the capability guard in
  // AgentPanel doesn't need to invalidate (it only reads modelSupportsImages
  // for the active model).
  const settings = useSettings.getState();
  // Subscribe to the three fields we care about so this hook re-runs when
  // any of them changes (and so the effect below fires).
  useSettings((s) => s.llmProvider);
  useSettings((s) => s.apiKey);
  useSettings((s) => s.apiBaseUrl);
  useEffect(() => {
    if (!invalidateOnSettingsChange) return;
    // Mark the cache as stale by clearing `data`. The next Live click or
    // autoFetch will re-fetch. Don't auto-refetch here — that would fire a
    // network request on every keystroke in the apiBaseUrl field.
    if (shared.data !== null) {
      setShared({ data: null, error: null });
    }
    void settings; // settings is read above for subscription; we don't use it here.
  }, [settings.llmProvider, settings.apiKey, settings.apiBaseUrl, invalidateOnSettingsChange]);

  const refresh = useCallback(() => {
    return fetchCatalog();
  }, []);

  return { ...shared, refresh };
}
