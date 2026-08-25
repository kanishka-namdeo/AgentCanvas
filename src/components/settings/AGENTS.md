# AGENTS.md — `src/components/settings/`

## Purpose

Settings UI: the `SettingsDialog` component — a modal dialog with a left vertical nav of section names + a right content pane showing the active section's form fields. Mirrors the pattern used by VS Code's Settings, Linear's Settings, and macOS System Preferences.

## Ownership

- `SettingsDialog.tsx` — the full settings workflow (8 sections). Reads from / writes to the Zustand settings store (`useSettings`). Changes apply immediately — no "Save" button required.

## Local Contracts

### Sections (8)

1. **Agent** — temperature slider, maxIterations slider, thinkingLevel select, planFirst toggle, defaultPalette select, skillSelectionMode select.
2. **LLM provider** — provider select (dynamic list from `listProviders()` in `src/lib/llm` — 28 providers; legacy `zai-auto` values normalized via `normalizeLLMProvider`), API key, model name, base URL. Contextual: shows fields only relevant to the selected provider.
3. **Sessions** — snapshotCadence select, maxSnapshotsPerSession input, maxSessionsRetained input, autoArchiveIdleAfter select.
4. **Appearance** — theme select (system / light / dark), density select (comfortable / compact), canvas renderer select (SVG classic / DOM experimental — the `renderer` settings flag consumed by `Canvas.tsx`, spec Phase 1). Applies theme immediately via `.dark` class toggle; renderer switch applies live.
5. **Data** — storage usage display (sessions/settings/theme bytes), Export all data (JSON download), Delete non-bookmarked snapshots, Clear ALL chats (danger zone).
6. **Shortcuts** — read-only reference list of all keyboard shortcuts.
7. **Plugins** — toggle list of agent plugins fetched from `GET /api/plugins`, merged with the user's `enabledPlugins` setting (Phase 5).
8. **MCP Servers** — add/remove/connect/disconnect MCP servers; persists the `mcpServers` setting and calls `POST /api/mcp/[id]`.

### Design token usage (root contract, restated)
- All components consume the `--ac-*` design tokens via utility classes. No hardcoded `slate-{n}` colors.
- The danger-zone buttons use `.ac-text-warning` / `.ac-text-danger` with `.ac-hover-warning` / `.ac-hover-danger` for the soft-background hover. These resolve to `--ac-{warning|danger}{,-soft,-fg}` tokens defined in `src/app/globals.css`, and they adapt to light/dark mode automatically.

### Component contracts
- `SettingsDialog` accepts `{ open, onOpenChange }` props. Controlled by the parent (`page.tsx`).
- Each section is a separate function component (`AgentSection`, `LLMSection`, etc.) to keep the main component readable.
- Left nav includes a "Reset to defaults" button (uses `confirm()`, calls `useSettings.getState().reset()`).
- The `Row` primitive (label + description + control) is shared across sections.
- The `UsageBar` primitive shows a labeled progress bar for storage usage.
- Appearance section's `useEffect` applies the theme immediately (toggles `.dark` class) AND subscribes to OS `prefers-color-scheme` changes when in `system` mode.
- Data section calls `estimateLocalStorageUsage()` from `src/lib/sessions/store.ts` to calculate byte sizes.
- Export button downloads a JSON file containing all sessions + settings.
- Danger-zone buttons use `confirm()` for now — a known anti-pattern (B1 in the UI audit). Should be replaced with `AlertDialog` in a future pass.

### Keyboard shortcut
- `⌘,` (Cmd/Ctrl + comma) toggles the Settings dialog. Wired in `page.tsx`.

## Work Guidance

- When adding a new section: add it to the `SECTIONS` array, create a `<SectionName>Section` function component, add it to the conditional render block.
- When adding a new setting field: add it to `AppSettings` in `src/lib/settings/types.ts` first, then add the UI control here.
- The settings dialog is `h-[80vh] max-h-[640px] min-h-[480px]` inside a `max-w-5xl` dialog — keep section content scrollable via `ScrollArea`.

## Verification

- `bunx tsc --noEmit` — typecheck.
- Manual: open settings via gear icon or `⌘,`, verify all 8 sections render, change a setting, verify it persists after reload.
- Manual: Settings → Plugins loads the plugin manifest list from `GET /api/plugins`; Settings → MCP Servers can add a server (placeholder connect).
- Manual: change theme to "dark" via Settings → verify ThemeToggle icon updates (no desync).
- Manual: change density to "compact" → verify `data-density="compact"` on root div + smaller fonts.

## Child DOX Index

No child AGENTS.md files in this folder.

*Siblings: `../canvas/AGENTS.md` (Canvas UI), `../sessions/AGENTS.md` (Session UI), `../ui/AGENTS.md` (shadcn/ui primitives).*
