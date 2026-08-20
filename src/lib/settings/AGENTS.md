# AGENTS.md — `src/lib/settings/`

## Purpose

The settings layer: typed models for all user-tunable knobs (agent behavior, LLM provider, sessions/history, appearance, data/privacy), plus a Zustand store with `persist` middleware (localStorage) that survives reloads.

This is the single source of truth for every setting the user can change in the Settings dialog. The agent runner + `/api/agent` route consume the `AgentRunSettings` subset via the request body; the UI components (ThemeToggle, SettingsDialog, page.tsx) subscribe to the full `AppSettings` object.

## Ownership

- `types.ts` — `AppSettings`, `AgentRunSettings`, `DEFAULT_SETTINGS`, `PALETTES`, plus all union types (`LLMProvider`, `SnapshotCadence`, `SkillSelectionMode`, `AutoArchiveIdleAfter`, `Density`, `ThemePreference`, `DefaultPalette`). Owned by this folder.
- `store.ts` — Zustand store with `persist` (localStorage key `agentcanvas.settings.v1`). Exposes `useSettings()` hook, `useAgentRunSettings()` convenience selector (returns all data fields + setters, scoped to avoid re-renders from unrelated store changes), and `set()` / `patch()` / `reset()` / `replaceAll()` mutators.

## Local Contracts

### Settings shape (`AppSettings`)

| Field | Type | Default | Phase |
|-------|------|---------|-------|
| `temperature` | `number` | `0.4` | 1 — Agent behavior |
| `maxIterations` | `number` | `20` | 1 |
| `planFirst` | `boolean` | `true` | 1 |
| `defaultPalette` | `'slate' \| 'warm' \| 'forest' \| 'mono'` | `'slate'` | 1 |
| `themePreference` | `'system' \| 'light' \| 'dark'` | `'system'` | 1 — Appearance |
| `llmProvider` | `'zai-auto' \| 'zai-key' \| 'openai-compatible'` | `'zai-auto'` | 2 — LLM provider |
| `apiKey` | `string` | `''` | 2 |
| `modelName` | `string` | `''` | 2 |
| `apiBaseUrl` | `string` | `''` | 2 |
| `snapshotCadence` | `'every-turn' \| 'every-3-turns' \| 'every-5-turns' \| 'manual'` | `'every-turn'` | 2 — Sessions |
| `maxSessionsRetained` | `number` | `100` | 2 |
| `maxSnapshotsPerSession` | `number` | `50` | 2 |
| `skillSelectionMode` | `'auto' \| 'manual'` | `'auto'` | 3 — Power-user |
| `autoArchiveIdleAfter` | `'never' \| '7d' \| '30d'` | `'never'` | 3 |
| `density` | `'comfortable' \| 'compact'` | `'comfortable'` | 3 |

### Agent-run subset (`AgentRunSettings`)

The `/api/agent` route consumes ONLY these fields (extracted via `agentRunSettings()`):
- `temperature`, `maxIterations`, `planFirst`, `defaultPalette`, `skillSelectionMode`
- `llmProvider`, `apiKey`, `modelName`, `apiBaseUrl`

The canvas store's `promptAgent()` calls `agentRunSettings(useSettings.getState())` and injects the result into both the WebSocket emit path and the HTTP fallback path.

### Persistence
- `persist` middleware with `localStorage` key `agentcanvas.settings.v1`.
- Schema version is `1`. Bump + add `migrate` if the shape changes.
- `partialize` strips the setter functions (`set`, `patch`, `reset`, `replaceAll`) so only data is persisted.
- The `apiKey` field is stored in localStorage (client-side only). It is NEVER written to disk on the server. For production multi-user deployments, swap the storage adapter to a server-side secrets manager.

### Palettes (`PALETTES` constant)
- 4 named palettes: `slate`, `warm`, `forest`, `mono`.
- Each has: `name`, `bg`, `fills[]`, `accent`, `text`.
- The runner's `buildPalettesList(defaultPalette)` lists the user's default palette first in the system prompt, with `(default)` suffix.

## Work Guidance

- When adding a new setting: add the field to `AppSettings` in `types.ts`, add it to `DEFAULT_SETTINGS`, add it to `AgentRunSettings` if the runner needs it, add a UI control in `SettingsDialog.tsx`, wire the runner to read it.
- When changing the localStorage schema: bump the persist version, write a `migrate` function.
- The settings store is read-heavy from the UI — prefer narrow selectors (`useSettings((s) => s.temperature)`) over selecting the whole store. For components that need most settings fields, use `useAgentRunSettings()` which returns all data fields + setters without subscribing to the entire store.

## Verification

- `bunx tsc --noEmit` — typecheck.
- Manual: change a setting in the Settings dialog, reload the page — the setting persists.
- Manual: change `temperature` to 0.8, send a prompt — the agent should produce more creative output.
- Check `localStorage['agentcanvas.settings.v1']` in the browser console — should be a single JSON blob with `state.temperature`, etc.

## Child DOX Index

No child AGENTS.md files in this folder.

*Siblings: `../canvas/AGENTS.md` (Canvas state), `../agent/AGENTS.md` (Agent layer), `../sessions/AGENTS.md` (Session persistence).*
