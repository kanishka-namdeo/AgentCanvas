# AGENTS.md — `src/lib/settings/`

## Purpose

The settings layer: typed models for all user-tunable knobs (agent behavior, LLM provider, sessions/history, appearance, data/privacy), plus a Zustand store with `persist` middleware (localStorage) that survives reloads.

This is the single source of truth for every setting the user can change in the Settings dialog. The agent runner + `/api/agent` route consume the `AgentRunSettings` subset via the request body; the UI components (ThemeToggle, SettingsDialog, page.tsx) subscribe to the full `AppSettings` object.

## Ownership

- `types.ts` — `AppSettings`, `AgentRunSettings`, `DEFAULT_SETTINGS`, `PALETTES`, `McpServerConfig`, `ThinkingLevel`, all union types (`LLMProvider`, `SnapshotCadence`, `SkillSelectionMode`, `AutoArchiveIdleAfter`, `Density`, `ThemePreference`, `DefaultPalette`, `RendererMode`), plus provider helpers (`normalizeLLMProvider`, `providerRequiresApiKey`, `providerDefaultModel`, `providerDefaultBaseURL`). Owned by this folder.
- `store.ts` — Zustand store with `persist` (localStorage key `agentcanvas.settings.v1`). Exposes the `useSettings()` hook and `set()` / `patch()` / `reset()` / `replaceAll()` mutators. (The former `useAgentRunSettings()` convenience selector returned an unstable fresh object per call and had zero callers — deleted in the 2026-09 perf pass.)

## Local Contracts

### Settings shape (`AppSettings`)

| Field | Type | Default | Phase |
|-------|------|---------|-------|
| `temperature` | `number` | `0.6` | 1 — Agent behavior |
| `maxIterations` | `number` | `30` | 1 |
| `thinkingLevel` | `'low' \| 'medium' \| 'high'` | `'high'` | 5 — Agent behavior |
| `planFirst` | `boolean` | `true` | 1 |
| `defaultPalette` | `'slate' \| 'warm' \| 'forest' \| 'mono'` | `'slate'` | 1 |
| `enabledPlugins` | `string[]` (plugin ids) | (14 default-enabled tools' plugins) | 5 — Plugins |
| `mcpServers` | `McpServerConfig[]` | `[]` | 5 — MCP |
| `themePreference` | `'system' \| 'light' \| 'dark'` | `'system'` | 1 — Appearance |
| `renderer` | `'dom'` (optional — only `'dom'` is a live value; legacy persisted `'svg'` is silently coerced to `'dom'` by the store's migrate function) | `'dom'` | 1 — Appearance (post-Phase-5 cleanup: the SVG renderer was deleted; the Settings UI no longer exposes a renderer picker. Kept on the type for forward compat with persisted blobs.) |
| `canvasLayoutMode` | `'parity' \| 'native'` (optional — absent = `'parity'`) | `'parity'` | 1 — Appearance (DOM renderer layout strategy, spec Phase 2: `parity` uses resolver geometry; `native` uses browser CSS flexbox layout + measured-bounds readback) |
| `domCulling` | `boolean` (optional — absent = `true`) | `true` | 1 — Appearance (Phase 4 scale hardening: L4 CSS containment + L5 mount culling when ≥2k nodes; toggle in Settings → Appearance → “DOM Culling Switch”) |
| `llmProvider` | any registry provider id (`src/lib/llm`) + legacy values | `'zai'` | 2 — LLM provider |
| `apiKey` | `string` | `''` | 2 |
| `modelName` | `string` | `'glm-5.3'` | 2 |
| `apiBaseUrl` | `string` | `''` | 2 |
| `snapshotCadence` | `'every-turn' \| 'every-3-turns' \| 'every-5-turns' \| 'manual'` | `'every-turn'` | 2 — Sessions |
| `maxSessionsRetained` | `number` | `100` | 2 |
| `maxSnapshotsPerCanvas` | `number` | `50` | 2 |
| `skillSelectionMode` | `'auto' \| 'manual'` | `'auto'` | 3 — Power-user |
| `autoArchiveIdleAfter` | `'never' \| '7d' \| '30d'` | `'never'` | 3 |
| `density` | `'comfortable' \| 'compact'` | `'comfortable'` | 3 |

`normalizeLLMProvider()` migrates legacy `zai-auto` / `zai-key` / `openai-compatible` values to current registry ids.

`maxSnapshotsPerCanvas` (persist v4 rename of `maxSnapshotsPerSession`) is the per-document snapshot cap under the shared-canvas model — snapshots are document-scoped, and the oldest non-bookmarked ones are auto-deleted when the cap is exceeded.

**Default LLM (testing)**: `llmProvider='zai'` + `modelName='glm-5.3'` + `apiKey=''` + `apiBaseUrl=''` — the z.ai sandbox. `pi-ai-model-resolver.ts` calls `ZAI.create()` which auto-resolves sandbox credentials from `~/.z-ai-config` / `/etc/.z-ai-config` / sandbox env. An empty `modelName` falls back to the registry default (`glm-5.3` for `zai`). Legacy `glm-4.6` settings map to `glm-4.7` (zai catalog path). The `custom` provider (kimi-k2-5 behind an OpenAI-compatible proxy) is no longer the default but remains a registered provider id selectable in Settings → LLM provider.

### Agent-run subset (`AgentRunSettings`)

The `/api/agent` route consumes ONLY these fields (extracted via `agentRunSettings()`) — 12 fields:
- `temperature`, `maxIterations`, `thinkingLevel`, `planFirst`, `defaultPalette`, `skillSelectionMode`
- `llmProvider`, `apiKey`, `modelName`, `apiBaseUrl`
- `enabledPlugins`, `mcpServers`

The canvas store's `promptAgent()` calls `agentRunSettings(useSettings.getState())` and injects the result into both the WebSocket emit path and the HTTP fallback path.

### Persistence
- `persist` middleware with `localStorage` key `agentcanvas.settings.v1`.
- Schema version is `5`. v4 → v5 (default-provider migration): stored blobs that still look like the OLD custom-endpoint first-run defaults (`custom` + `kimi-k2-5` + `https://irhnglwoxe.a.pinggy.link/v1` + `123456`) are migrated to the new z.ai-sandbox defaults (`zai` + `glm-5.3` + empty key + empty base URL); anything user-customized is preserved untouched. Earlier migrations (v1→v2 endpoint swap, v2→v3 SVG-renderer coerce, v3→v4 snapshot cap rename) are kept in the migrate chain for history. Bump + add `migrate` if the shape changes again.
- `partialize` strips the setter functions (`set`, `patch`, `reset`, `replaceAll`) so only data is persisted.
- The `apiKey` field is stored in localStorage (client-side only). It is NEVER written to disk on the server. For production multi-user deployments, swap the storage adapter to a server-side secrets manager.

### Palettes (`PALETTES` constant)
- 4 named palettes: `slate`, `warm`, `forest`, `mono`.
- Each has: `name`, `bg`, `fills[]`, `accent`, `text`.
- The runner's `buildPalettesList(defaultPalette)` lists the user's default palette first in the system prompt, with `(default)` suffix.

## Work Guidance

- When adding a new setting: add the field to `AppSettings` in `types.ts`, add it to `DEFAULT_SETTINGS`, add it to `AgentRunSettings` if the runner needs it, add a UI control in `SettingsDialog.tsx`, wire the runner to read it.
- When changing the localStorage schema: bump the persist version, write a `migrate` function.
- The settings store is read-heavy from the UI — prefer narrow selectors (`useSettings((s) => s.temperature)`) over selecting the whole store; group multi-field reads with `useShallow` from `zustand/react/shallow` so the selector's returned object is compared shallowly instead of by identity.

## Verification

- `bunx tsc --noEmit` — typecheck.
- Manual: change a setting in the Settings dialog, reload the page — the setting persists.
- Manual: change `temperature` to 0.8, send a prompt — the agent should produce more creative output.
- Check `localStorage['agentcanvas.settings.v1']` in the browser console — should be a single JSON blob with `state.temperature`, etc.

## Child DOX Index

No child AGENTS.md files in this folder.

*Siblings: `../canvas/AGENTS.md` (Canvas state), `../agent/AGENTS.md` (Agent layer), `../sessions/AGENTS.md` (Session persistence).*
