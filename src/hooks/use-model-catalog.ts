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

export function useModelCatalog(opts?: { autoFetch?: boolean }) {
  const autoFetch = opts?.autoFetch === true;
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

  const refresh = useCallback(() => {
    return fetchCatalog();
  }, []);

  return { ...shared, refresh };
}
