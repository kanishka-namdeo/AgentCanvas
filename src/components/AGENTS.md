# AGENTS.md — `src/components/`

## Purpose

Component tree root. Owns the shared ThemeToggle component directly, and indexes the four component subfolders (canvas, sessions, settings, ui) that have their own AGENTS.md contracts.

## Ownership

- `ThemeToggle.tsx` — header button cycling system → light → dark; writes `themePreference` to the settings store (plus legacy `agentcanvas-theme` localStorage key for pre-settings installs) and toggles the `.dark` class on `<html>`; follows OS `prefers-color-scheme` in system mode. The single UI entry point for theme switching — Settings → Appearance writes the same `themePreference` field, so both controls stay in sync.

## Local Contracts

- All shared UI rules (design tokens, `--ac-*` usage, React subscription safety) are defined in the root `AGENTS.md` and restated in each child doc — follow the child doc of the folder you are editing.
- Theme changes MUST go through the settings store, never direct DOM class manipulation outside ThemeToggle/Appearance's effect.
- **Busy-state UI consistency contract (2026-09-05)** — while the agent or a sub-agent runs, every gated control derives from ONE source (`runPhase` in the canvas store, see `src/lib/canvas/run-phase.ts`):
  - **Disabled affordance**: the `.ac-busy` class (globals.css) — native `disabled` or `aria-disabled`, opacity .4 + no-allow cursor, with a tooltip that states WHY ("Stop the agent first"). Never a bare `disabled:opacity-*` variant, never a silent no-op handler.
  - **Spinners**: `Loader2 animate-spin` for controls; a single pulsing dot for compact rows. No `animate-ping` halos, no pulsing action icons.
  - **Vocabulary**: `RUN_PHASE_LABEL` is the only source of busy strings ("Thinking…", "Running <tool>…", "Writing response…", "Stopping…", "Waiting for you…"; terminal: Completed / Stopped / Run failed / Stuck). StatusBadge inputs (session run status) carry the same words.
  - **Entry semantics**: prompt surfaces (composer, preset chips, palette, slash prompt commands) QUEUE while busy — never disable; document mutations (toolbar shapes, keyboard chords, panels, undo/redo, clear, restore, snapshot-attach) are gated at the STORE choke points (`sendPatch` / `undo` / `redo` / `restoreSnapshot` / `promptAgent`), so keyboard/menu/panel paths can never disagree with the buttons; conversation structure (new chat / fork / switch / re-run) guards BEFORE creating anything (no orphan rows); viewport, selection, inspection and Stop/Steer stay live (Figma parity).
  - **Sub-agent rows** reuse `StatusBadge` (running / completed / failed) keyed by `dispatchId` — same component and vocabulary as the session header and run history.

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
