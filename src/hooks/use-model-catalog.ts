'use client';

// useModelCatalog — client hook that fetches the switchable-model listing
// from POST /api/models for the CURRENT settings (provider + key + base URL).
//
// Used by the AgentPanel model-badge switcher and the Settings → LLM
// provider live-model loader. The heavy lifting (endpoint probe, catalog
// lookup, z.ai sandbox check) is server-side — this hook is a thin fetch +
// state wrapper with manual refresh (no polling; the catalog is stable).

import { useCallback, useRef, useState } from 'react';
import type { ModelsListing } from '@/lib/agent/model-catalog';
import { useSettings } from '@/lib/settings/store';

export interface ModelCatalogState {
  loading: boolean;
  data: ModelsListing | null;
  error: string | null;
}

export function useModelCatalog() {
  const [state, setState] = useState<ModelCatalogState>({
    loading: false,
    data: null,
    error: null,
  });
  // Guard against overlapping refreshes (dropdown open + manual refresh).
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setState((s) => ({ ...s, loading: true, error: null }));
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
      setState({ loading: false, data, error: null });
    } catch (err) {
      setState((s) => ({
        ...s,
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to load models',
      }));
    } finally {
      inFlight.current = false;
    }
  }, []);

  return { ...state, refresh };
}
