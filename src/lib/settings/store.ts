// Settings store — Zustand + persist middleware. Single source of truth for
// all user-tunable knobs. Components subscribe via useSettings() selectors;
// the agent runner + /api/agent route consume via agentRunSettings().
//
// Storage: localStorage key `agentcanvas.settings.v1`. Versioned so future
// schema changes can migrate (currently v5 — see the `migrate` function
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
      version: 5,
      // Migrate chain:
      //   v1 → v2: the default inference endpoint moved from the z.ai sandbox
      //     (zai / glm-5.3 / no key / no base URL) to a custom OpenAI-compatible
      //     endpoint. Browsers that still held the OLD first-run defaults were
      //     migrated to the new default endpoint; anything a user actually
      //     customized (their own provider, key, model, or URL) was preserved
      //     untouched. [Superseded by v4 → v5 — kept here for history.]
      //   v2 → v3: SVG renderer was deleted (post-Phase-5 cleanup). Any
      //     persisted blob with `renderer: 'svg'` (set by a user before the
      //     cleanup) is coerced to 'dom' — the only live renderer. The
      //     Settings UI no longer exposes the renderer picker.
      //   v3 → v4: snapshots became document-scoped (shared canvas model) —
      //     `maxSnapshotsPerSession` renamed to `maxSnapshotsPerCanvas` with
      //     the value preserved.
      //   v4 → v5: the default inference provider moved BACK from the custom
      //     OpenAI-compatible endpoint (kimi-k2-5 behind a pinggy tunnel) to
      //     the z.ai sandbox (zai / glm-5.3 / no key / no base URL). Browsers
      //     that still hold the OLD custom-endpoint defaults (provider 'custom'
      //     + model 'kimi-k2-5' + the pinggy base URL + the placeholder key
      //     '123456') are rewritten to the CURRENT DEFAULT_SETTINGS values;
      //     anything a user actually customized (their own provider, key,
      //     model, or URL) is preserved untouched. [Since the 2026-09-07 BETA
      //     tuning the rewrite target is the BETA endpoint (custom /
      //     qwen3.7-plus / same pinggy URL / '123456') — the schema version
      //     stays 5 because the detection shape (kimi-k2-5 defaults) is
      //     unchanged. v5-era z.ai-sandbox blobs are NOT rewritten — they
      //     stay on 'zai' until the user picks a preset.]
      migrate: (persisted, _version) => {
        const s = (persisted ?? {}) as Partial<AppSettings> & { maxSnapshotsPerSession?: number };
        // v4 → v5: old-defaults custom-endpoint rewrite.
        // Detect the OLD first-run defaults (the kimi-k2-5 / pinggy / 123456
        // shape) and rewrite them to the CURRENT DEFAULT_SETTINGS values
        // (the BETA qwen3.7-plus endpoint since the 2026-09-07 tuning). Any
        // user customization — different provider, different model, a real
        // API key, or a different base URL — is preserved untouched.
        const looksLikeOldCustomDefaults =
          s.llmProvider === 'custom' &&
          s.modelName === 'kimi-k2-5' &&
          s.apiKey === '123456' &&
          s.apiBaseUrl === 'https://irhnglwoxe.a.pinggy.link/v1';
        const withLlm = looksLikeOldCustomDefaults
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
        // v3 → v4: rename the snapshot cap to its document-scoped name.
        const { maxSnapshotsPerSession: legacyCap, ...rest } = withRenderer;
        const withCanvasCap: Partial<AppSettings> = {
          ...rest,
          maxSnapshotsPerCanvas: rest.maxSnapshotsPerCanvas ?? legacyCap ?? DEFAULT_SETTINGS.maxSnapshotsPerCanvas,
        };
        return withCanvasCap as AppSettings;
      },
      // Only persist the data fields, not the setter functions.
      partialize: ({ set: _set, patch: _patch, reset: _reset, replaceAll: _replaceAll, ...data }) => data,
    },
  ),
);

// NOTE (perf pass, task 4): the former `useAgentRunSettings()` selector —
// which returned a FRESH object on every call (unstable reference →
// re-rendered its subscribers on every store flush) — had ZERO callers
// (verified by grep across src/ and tests/) and was deleted as dead code.
// The agent-run request body is built server-side via `useSettings.getState()`.
