// Settings store — Zustand + persist middleware. Single source of truth for
// all user-tunable knobs. Components subscribe via useSettings() selectors;
// the agent runner + /api/agent route consume via agentRunSettings().
//
// Storage: localStorage key `agentcanvas.settings.v1`. Versioned so future
// schema changes can migrate.

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
      version: 1,
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
