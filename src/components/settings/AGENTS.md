# AGENTS.md — `src/components/settings/`

## Purpose

Settings UI: the `SettingsDialog` component — a modal dialog with a left vertical nav of section names + a right content pane showing the active section's form fields. Mirrors the pattern used by VS Code's Settings, Linear's Settings, and macOS System Preferences.

## Ownership

- `SettingsDialog.tsx` — the full settings workflow (6 sections). Reads from / writes to the Zustand settings store (`useSettings`). Changes apply immediately — no "Save" button required.

## Local Contracts

### Sections (6)

1. **Agent** — temperature slider, maxIterations slider, planFirst toggle, defaultPalette select, skillSelectionMode select.
2. **LLM provider** — provider select (zai-auto / zai-key / openai-compatible), API key, model name, base URL. Contextual: shows fields only relevant to the selected provider.
3. **Sessions** — snapshotCadence select, maxSnapshotsPerSession input, maxSessionsRetained input, autoArchiveIdleAfter select.
4. **Appearance** — theme select (system / light / dark), density select (comfortable / compact). Applies theme immediately via `.dark` class toggle.
5. **Data** — storage usage display (sessions/settings/theme bytes), Export all data (JSON download), Delete non-bookmarked snapshots, Clear ALL chats (danger zone).
6. **Shortcuts** — read-only reference list of all keyboard shortcuts.

### Design token usage (root contract, restated)
- All components consume the `--ac-*` design tokens via utility classes. No hardcoded `slate-{n}` colors.
- The danger-zone buttons use `text-amber-700` / `text-rose-700` with `hover:bg-amber-50` / `hover:bg-rose-50` — these are status colors, not design tokens.

### Component contracts
- `SettingsDialog` accepts `{ open, onOpenChange }` props. Controlled by the parent (`page.tsx`).
- Each section is a separate function component (`AgentSection`, `LLMSection`, etc.) to keep the main component readable.
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
- The settings dialog is 560px tall — keep section content scrollable via `ScrollArea`.

## Verification

- `bunx tsc --noEmit` — typecheck.
- Manual: open settings via gear icon or `⌘,`, verify all 6 sections render, change a setting, verify it persists after reload.
- Manual: change theme to "dark" via Settings → verify ThemeToggle icon updates (no desync).
- Manual: change density to "compact" → verify `data-density="compact"` on root div + smaller fonts.

## Child DOX Index

No child AGENTS.md files in this folder.

*Siblings: `../canvas/AGENTS.md` (Canvas UI), `../sessions/AGENTS.md` (Session UI), `../ui/AGENTS.md` (shadcn/ui primitives).*
