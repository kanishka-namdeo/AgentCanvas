// Settings store — Zustand + persist middleware. Single source of truth for
// all user-tunable knobs. Components subscribe via useSettings() selectors;
// the agent runner + /api/agent route consume via agentRunSettings().
//
// Storage: localStorage key `agentcanvas.settings.v1`. Versioned so future
// schema changes can migrate (currently v5 — see the `migrate` function
// below; the key name is kept stable so stored values keep flowing through
// `migrate` instead of being silently discarded by a key rename).

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { toast } from 'sonner';
import { AppSettings, DEFAULT_SETTINGS } from './types';
import { quotaAwareSetItem } from '@/lib/storage/quota-aware';

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

/// Sanitize a persisted settings blob field-by-field (2026-09-07 UI
/// hardening, 12-c#3). Zustand v5's default merge does NO shape validation,
/// so a poisoned `agentcanvas.settings.v1` (manual edit / another tab
/// writing garbage) with a string/null `temperature` flowed straight into
/// the store and crashed `temperature.toFixed(1)` in SettingsDialog — a
/// white screen with no error boundary anywhere in src/. Only keys PRESENT
/// in the blob are emitted, so absent fields keep the in-store (default)
/// value. Returns a partial suitable for spreading over the current state.
export function sanitizePersistedSettings(persisted: unknown): Partial<AppSettings> {
  if (typeof persisted !== 'object' || persisted === null) return {};
  const s = persisted as Record<string, unknown>;
  const out: Partial<AppSettings> = {};
  // Numbers: temperature must be a finite number clamped to [0,2] (fallback
  // 0.6 = DEFAULT_SETTINGS.temperature); maxIterations a finite int in
  // [1,50] (fallback 24). Non-number types (string/null/undefined) fall back
  // rather than coercing — a poisoned "0.6" string should not silently pass
  // as a number.
  if ('temperature' in s) {
    const v = s.temperature;
    out.temperature =
      typeof v === 'number' && Number.isFinite(v)
        ? Math.min(2, Math.max(0, v))
        : 0.6;
  }
  if ('maxIterations' in s) {
    const v = s.maxIterations;
    out.maxIterations =
      typeof v === 'number' && Number.isFinite(v)
        ? Math.min(50, Math.max(1, Math.round(v)))
        : 24;
  }
  // String fields (provider/model/endpoint ids, apiKey, baseUrl): anything
  // non-string coerces to '' (an unknown provider id is normalized
  // downstream by normalizeLLMProvider; empty model/baseUrl mean "provider
  // default").
  for (const key of ['llmProvider', 'apiKey', 'modelName', 'apiBaseUrl'] as const) {
    if (key in s) out[key] = typeof s[key] === 'string' ? s[key] : '';
  }
  // Booleans → Boolean(x). Optional booleans (domCulling) only coerce when
  // the key is present, so a missing flag keeps the consumer default.
  if ('planFirst' in s) out.planFirst = Boolean(s.planFirst);
  if ('domCulling' in s) out.domCulling = Boolean(s.domCulling);
  return out;
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
      // Quota-aware storage: wraps localStorage.setItem with error detection
      // and toast notifications instead of silent failures (2026-09-11 fix).
      storage: createJSONStorage(() => ({
        getItem: (name: string) => {
          try {
            return window.localStorage.getItem(name);
          } catch {
            return null;
          }
        },
        setItem: (name: string, value: string) => {
          quotaAwareSetItem(name, value, { toast });
        },
        removeItem: (name: string) => {
          try {
            window.localStorage.removeItem(name);
          } catch {
            // ignore
          }
        },
      })),
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
      // (2026-09-07 UI hardening, 12-c#3) custom merge: sanitize the persisted
      // state (post-migrate — v5 migration semantics are untouched) before it
      // lands in the store. The default shallow merge trusted the blob's
      // shape, so a wrong-typed temperature crashed SettingsDialog's
      // `.toFixed(1)` on rehydrate. Unknown fields still flow through (the
      // sanitize list only covers the fields the UI renders numerically /
      // crashes on); the sanitized overrides land last.
      merge: (persistedState, currentState) => {
        const raw = typeof persistedState === 'object' && persistedState !== null
          ? (persistedState as Record<string, unknown>)
          : {};
        // Strip the action functions (same keys partialize omits) so a
        // poisoned blob can't clobber the store's API.
        const { set: _s, patch: _p, reset: _r, replaceAll: _ra, ...data } = raw;
        return {
          ...currentState,
          ...data,
          ...sanitizePersistedSettings(data),
        };
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
