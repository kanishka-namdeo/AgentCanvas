// Settings store — Zustand + persist middleware. Single source of truth for
// all user-tunable knobs. Components subscribe via useSettings() selectors;
// the agent runner + /api/agent route consume via agentRunSettings().
//
// Storage: localStorage key `agentcanvas.settings.v1`. Versioned so future
// schema changes can migrate (currently v3 — see the `migrate` function
// below; the key name is kept stable so stored values keep flowing through
// `migrate` instead of being silently discarded by a key rename).

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { AppSettings, DEFAULT_SETTINGS } from './types';

interface SettingsStore extends AppSettings {
  /// Replace a single field. Use this for atomic updates.
  set: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  /// Replace multiple fields at once (e.g. on import).
  patch: (partial: Partial<AppSettings>) => void;
  /// Reset to defaults.
  reset: () => void;
  /// Replace the entire settings object (e.g. on import).
  replaceAll: (next: AppSettings) => void;
}

export const useSettings = create<SettingsStore>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      set: (key, value) => set({ [key]: value } as Partial<SettingsStore>),
      patch: (partial) => set(partial),
      reset: () => set({ ...DEFAULT_SETTINGS }),
      replaceAll: (next) => set({ ...next }),
    }),
    {
      name: 'agentcanvas.settings.v1',
      version: 3,
      // Migrate chain:
      //   v1 → v2: the default inference endpoint moved from the z.ai sandbox
      //     (zai / glm-5.3 / no key / no base URL) to a custom OpenAI-compatible
      //     endpoint. Browsers that still hold the OLD first-run defaults are
      //     migrated to the new default endpoint; anything a user actually
      //     customized (their own provider, key, model, or URL) is preserved
      //     untouched.
      //   v2 → v3: SVG renderer was deleted (post-Phase-5 cleanup). Any
      //     persisted blob with `renderer: 'svg'` (set by a user before the
      //     cleanup) is coerced to 'dom' — the only live renderer. The
      //     Settings UI no longer exposes the renderer picker.
      migrate: (persisted, _version) => {
        const s = (persisted ?? {}) as Partial<AppSettings>;
        // v1 → v2: old-defaults inference-endpoint rewrite.
        const looksLikeOldDefaults =
          s.llmProvider === 'zai' &&
          s.modelName === 'glm-5.3' &&
          !s.apiKey &&
          !s.apiBaseUrl;
        const withLlm = looksLikeOldDefaults
          ? {
              ...s,
              llmProvider: DEFAULT_SETTINGS.llmProvider,
              apiKey: DEFAULT_SETTINGS.apiKey,
              modelName: DEFAULT_SETTINGS.modelName,
              apiBaseUrl: DEFAULT_SETTINGS.apiBaseUrl,
            }
          : s;
        // v2 → v3: coerce legacy `renderer: 'svg'` to 'dom'.
        const withRenderer = (withLlm.renderer && withLlm.renderer !== 'dom')
          ? { ...withLlm, renderer: 'dom' as const }
          : withLlm;
        return withRenderer as AppSettings;
      },
      // Only persist the data fields, not the setter functions.
      partialize: ({ set: _set, patch: _patch, reset: _reset, replaceAll: _replaceAll, ...data }) => data,
    },
  ),
);

/// Convenience selector for the agent-run subset. Components that need to
/// build a /api/agent request body can use this to avoid re-renders when
/// non-agent settings (like theme) change.
export function useAgentRunSettings(): AppSettings {
  return useSettings((s) => ({
    temperature: s.temperature,
    maxIterations: s.maxIterations,
    planFirst: s.planFirst,
    thinkingLevel: s.thinkingLevel,
    defaultPalette: s.defaultPalette,
    skillSelectionMode: s.skillSelectionMode,
    llmProvider: s.llmProvider,
    apiKey: s.apiKey,
    modelName: s.modelName,
    apiBaseUrl: s.apiBaseUrl,
    themePreference: s.themePreference,
    snapshotCadence: s.snapshotCadence,
    maxSessionsRetained: s.maxSessionsRetained,
    maxSnapshotsPerSession: s.maxSnapshotsPerSession,
    autoArchiveIdleAfter: s.autoArchiveIdleAfter,
    density: s.density,
    set: s.set,
    patch: s.patch,
    reset: s.reset,
    replaceAll: s.replaceAll,
  }));
}
