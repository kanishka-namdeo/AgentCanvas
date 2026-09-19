# AGENTS.md — `src/components/`

## Purpose

Component tree root. Owns the shared ThemeToggle + ErrorBoundary components directly, and indexes the seven component subfolders that have their own AGENTS.md contracts (canvas, sessions, settings, design-systems, ui, landing) plus the onboarding folder (owned directly by this doc).

## Ownership

- `ErrorBoundary.tsx` — app-level React error boundary (2026-09-07 UI hardening; wrapped around the page in `app/page.tsx`). Catches any render-time crash (poisoned persisted settings, malformed store state) that slips past the ingest guards, logs to console, and renders a neutral "Something broke" fallback with a one-click reload — previously ANY render crash unmounted the whole tree (white screen, no boundary existed anywhere in src/).
- `ThemeToggle.tsx` — header button cycling system → light → dark; writes `themePreference` to the settings store (plus legacy `agentcanvas-theme` localStorage key for pre-settings installs) and toggles the `.dark` class on `<html>`; follows OS `prefers-color-scheme` in system mode. The single UI entry point for theme switching — Settings → Appearance writes the same `themePreference` field, so both controls stay in sync.
- `onboarding/OnboardingDialog.tsx` — first-time user onboarding flow (2-step modal: welcome + template picker), shown once per browser when `useOnboarding.hasCompleted` is false. Step 1 is a welcome screen with an animated CSS demo; step 2 is a template picker showing 10 curated starters (from `ONBOARDING_TEMPLATES` in `src/lib/onboarding/store.ts`). Selecting a template pre-fills the chat input via the `agentcanvas:composer-prefill` CustomEvent. Mounted in `src/app/app/page.tsx` (lazily via `next/dynamic`, deferred-mount gated on `!hasCompleted`). The "Replay onboarding" ⌘K command (`view.onboarding`) calls `useOnboarding.getState().reset()` to re-trigger.

## Local Contracts

- All shared UI rules (design tokens, `--ac-*` usage, React subscription safety) are defined in the root `AGENTS.md` and restated in each child doc — follow the child doc of the folder you are editing.
- Theme changes MUST go through the settings store, never direct DOM class manipulation outside ThemeToggle/Appearance's effect.
- **Busy-state UI consistency contract (2026-09-05)** — while the agent or a sub-agent runs, every gated control derives from ONE source (`runPhase` in the canvas store, see `src/lib/canvas/run-phase.ts`):
  - **Disabled affordance**: the `.ac-busy` class (globals.css) — native `disabled` or `aria-disabled`, opacity .4 + no-allow cursor, with a tooltip that states WHY ("Stop the agent first"). Never a bare `disabled:opacity-*` variant, never a silent no-op handler.
  - **Spinners**: `Loader2 animate-spin` for controls; a single pulsing dot for compact rows. No `animate-ping` halos, no pulsing action icons.
  - **Vocabulary**: `RUN_PHASE_LABEL` is the only source of busy strings ("Thinking…", "Running <tool>…", "Writing response…", "Stopping…", "Waiting for you…"; terminal: Completed / Stopped / Run failed / Stuck). StatusBadge inputs (session run status) carry the same words.
  - **Entry semantics**: prompt surfaces (composer, preset chips, palette, slash prompt commands) QUEUE while busy — never disable; document mutations (toolbar shapes, keyboard chords, panels, undo/redo, clear, restore, snapshot-attach) are gated at the STORE choke points (`sendPatch` / `undo` / `redo` / `restoreSnapshot` / `promptAgent`), so keyboard/menu/panel paths can never disagree with the buttons; conversation structure (new chat / fork / switch / re-run) guards BEFORE creating anything (no orphan rows); viewport, selection, inspection and Stop/Steer stay live (Figma parity).
  - **Sub-agent rows** reuse `StatusBadge` (running / completed / failed) keyed by `dispatchId` — same component and vocabulary as the session header and run history.
- **Visual-recipe consistency contract (2026-09-06)** — one recipe per semantic role; raw values in components are a defect:
  - **Keyboard-key chips**: `<kbd className="ac-kbd">` (globals.css) — mono 10px, surface-2 fill, hairline subtle border, px-1.5/py-0.5, 4px radius, ac-text-3. Never re-compose a kbd from Tailwind classes (was 6 drifting recipes). Deliberately exempt from compact-density remaps — key hints never shrink below 10px.
  - **Overline/section labels**: `ac-label` — 10px semibold uppercase tracking-wide ac-text-4 (was 9px/10px/11px × medium/semibold drift across 10 files). Form FIELD labels in rename dialogs (10px medium) are a different role and stay hand-composed.
  - **Brand mark**: `ac-brand-gradient` (tokens `--ac-brand-from/--ac-brand-to`, violet→fuchsia) — never raw `from-violet-500 to-fuchsia-500` palette classes.
  - **Guide red**: `DEFAULT_GUIDE_COLOR` from `canvas/dom/Guides.tsx` is the single source (Rulers drag-preview, Canvas addGuideAction, Guides default). Do not re-type `#f24822`.
  - **Measure overlay**: `--ac-canvas-measure` + `--ac-canvas-bg` pill (both modes adapt; SVG attrs can't carry var() — use the style prop).
  - **Font sizes**: dense micro-type scale 9/10/11/12/13px only — 8px is forbidden (below dense-UI floor), 14px section headings forbidden in SettingsDialog (13px contract). `text-[10px]`+ sizes; compact density remaps 11→10, 12→11, 13→12.
  - **Spacing**: Tailwind 4px-grid scale classes only (`p-2`, `px-3`, `gap-1.5`…); arbitrary `p-[Npx]` is a defect in app chrome (shadcn upstream primitives exempt).
  - **Color**: no raw hex/oklch/hsl in component chrome — use `--ac-*`/shadcn tokens without literal fallbacks (globals.css always loads). Canvas CONTENT (shape fills, icon-island defaults, pack tokens) is artwork, not chrome — exempt by design.

## Work Guidance

- New top-level components (not canvas/session/settings/ui) land here and get an Ownership entry.
- `src/hooks/` sibling utilities (use-clipboard, use-toast) are shared hooks, not components — document usage at the call site. (use-scrub + use-mobile were deleted 2026-09-05: dead code, referenced nowhere; use-is-mobile in lib/canvas is the live mobile hook.)

## Verification

- `bun run lint` — ESLint.
- Manual: click the theme toggle through system → light → dark; reload — preference persists; verify Settings → Appearance shows the same value.

## Mistakes & Lessons

### Failure Modes

- Check for raw hex/oklch/hsl literals in component chrome before merging a UI change — they break dark-mode adaptation (canvas CONTENT fills are exempt).
- Check that any new busy-gated control routes through `runPhase` in the canvas store, not a parallel boolean, before wiring it — vocabulary drift is silent.
- Check that `<kbd>`, section labels, and brand gradients use the shared recipes (`ac-kbd`, `ac-label`, `ac-brand-gradient`) rather than recomposed Tailwind classes.
- Check that 8px font sizes never slip back in — the dense-UI floor is 9px.

### Lessons Learned

- Do not hardcode shape property access without `?.` and `?? 0` — the LLM emits patches referencing deleted shapes and the UI must not crash on the missing lookup.
- Do not pass selection/hover/zoom as props to `DomNode` — they belong to `DomChrome`; the memoized world tree must only see stable layer identities.
- Selection lookups must use a memoized `Map<id, shape>`, never `selectedIds.map(id => shapes.find(...))` — `⌘A` on a 20k-node canvas hit O(selection × canvas) and stalled the UI.
- Do not introduce a second design-token system alongside `--ac-*` — extend `--ac-*` in `globals.css` instead.
- Do not hardcode the repo URL or guide-red hex — route through `landing/repo-url.ts` and `canvas/dom/Guides.tsx`'s `DEFAULT_GUIDE_COLOR` so a single edit propagates.

## Child DOX Index

| Path | Scope |
|------|-------|
| `canvas/AGENTS.md` | Canvas UI: drawing surface, floating toolbar (+ undo/redo), command palette, layers panel, properties inspector, agent chat + PluginUI bundle, app menu, .pen file menu, shortcuts dialog |
| `sessions/AGENTS.md` | Session UI: sidebar, header (compact), run history panel, run/stop button, status badges |
| `settings/AGENTS.md` | Settings dialog: 8-section modal (agent, LLM provider, sessions, appearance, data, shortcuts, plugins, MCP servers) |
| `design-systems/AGENTS.md` | Design-system picker + pack showcase (the Design tab's pack browsing UI); iframe-isolated pack previews |
| `ui/AGENTS.md` | shadcn/ui primitives: 26 Radix UI wrappers + 5 Magic UI primitives (border-beam, blur-fade, scroll-progress are motion-backed; marquee is CSS-keyframe animated, bento-grid imports no motion); motion pinned ^12 |
| `landing/AGENTS.md` | Landing page: repo-url constants, SmoothScroll (lenis, reduced-motion fallback), BrowserFrame light-chrome mockup (+ bottom-crop), header/footer chrome, and all six section components (Hero, MagicSequence, FeatureGallery, TrustLoop, HowItWorks, OpenSourceFinale) |
| `onboarding/AGENTS.md` | First-run onboarding: 2-step modal (welcome + template picker) mounted in `/app`, dispatches `agentcanvas:composer-prefill` CustomEvent |
