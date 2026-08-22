# AGENTS.md — `src/components/`

## Purpose

Component tree root. Owns the shared ThemeToggle component directly, and indexes the four component subfolders (canvas, sessions, settings, ui) that have their own AGENTS.md contracts.

## Ownership

- `ThemeToggle.tsx` — header button cycling system → light → dark; writes `themePreference` to the settings store (plus legacy `agentcanvas-theme` localStorage key for pre-settings installs) and toggles the `.dark` class on `<html>`; follows OS `prefers-color-scheme` in system mode. The single UI entry point for theme switching — Settings → Appearance writes the same `themePreference` field, so both controls stay in sync.

## Local Contracts

- All shared UI rules (design tokens, `--ac-*` usage, React subscription safety) are defined in the root `AGENTS.md` and restated in each child doc — follow the child doc of the folder you are editing.
- Theme changes MUST go through the settings store, never direct DOM class manipulation outside ThemeToggle/Appearance's effect.

## Work Guidance

- New top-level components (not canvas/session/settings/ui) land here and get an Ownership entry.
- `src/hooks/` sibling utilities (use-clipboard, use-scrub, use-mobile, use-toast) are shared hooks, not components — document usage at the call site.

## Verification

- `bun run lint` — ESLint.
- Manual: click the theme toggle through system → light → dark; reload — preference persists; verify Settings → Appearance shows the same value.

## Child DOX Index

| Path | Scope |
|------|-------|
| `canvas/AGENTS.md` | Canvas UI: drawing surface, floating toolbar (+ undo/redo), command palette, layers panel, properties inspector, agent chat + PluginUI bundle, top menu bar, .pen file menu, shortcuts dialog |
| `sessions/AGENTS.md` | Session UI: sidebar, header (compact + full), run history panel, run/stop button, status badges |
| `settings/AGENTS.md` | Settings dialog: 8-section modal (agent, LLM provider, sessions, appearance, data, shortcuts, plugins, MCP servers) |
| `ui/AGENTS.md` | shadcn/ui primitives: Radix UI wrappers, 48-component inventory |
