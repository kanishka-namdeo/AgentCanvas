# AGENTS.md — `src/app/`

## Purpose

The Next.js App Router entry point: the root layout, the main page (the 4-pane AgentCanvas layout), and the global stylesheet that defines the `--ac-*` design token system.

## Ownership

- `layout.tsx` — root layout. Sets up `<html>`, `<body>`, font loading, theme provider, toaster. Owned by this folder.
- `page.tsx` — the main page. Renders the 4-pane layout: `SessionSidebar | (LayersPanel + PropertiesPanel) | Canvas | (SessionHeader + AgentPanel + RunHistoryPanel)`. Also renders the top status bar.
- `globals.css` — global styles + the `--ac-*` design token system. Owned by this folder; consumed by every component.

## Local Contracts

### Layout (`layout.tsx`)
- Sets `<html lang="en" suppressHydrationWarning>` + `<body>`. The `suppressHydrationWarning` is required because `ThemeToggle` mutates the `.dark` class on `<html>` before React hydrates.
- Loads fonts (Geist Sans + Geist Mono via `next/font/google`).
- Renders the `<Toaster />`. No theme provider — `ThemeToggle` manages the `.dark` class directly via `localStorage` (no `next-themes` Provider is wired up, though the dep is installed).
- Server component — do not add `'use client'` here.

### Page (`page.tsx`)
- The layout is a **tabbed 3-column** split: `LeftTabbedPanel (Chats/Layers) | Canvas | RightTabbedPanel (Chat/Design/History)`. The previous 4-pane layout (sessions | layers | canvas | properties+chat+history) was decluttered into 3 columns with tabs.
- Panels use `react-resizable-panels` (`ResizablePanel` + `ResizableHandle`) with `collapsible` + `collapsedSize={0}`. The `autoSaveId="co-canvas-layout-h"` persists panel sizes across reloads.
- **Collapsed-panel edge buttons**: when a panel is collapsed (width=0), a floating edge tab appears on the screen edge (left or right). Click to expand. This solves the "can't unhide the agent panel" dead-end. A `useEffect` on mount calls `imperativePanelHandle.isCollapsed()` to sync React state with the persisted layout (the library's autoSaveId restore doesn't fire `onCollapse`).
- **Tab strip also serves as panel header**: each tabbed panel's tab strip includes a collapse chevron on the right. The panel content is `hidden` (display:none) when collapsed to prevent overflow.
- Top header shows: brand, document name (inline-editable), session title (compact), ⌘K "Ask anything" button, "Ask" RunStopButton (opens Command Palette), connection status (single Bot icon with tooltip), Zen mode, .pen file menu, Settings (gear), ThemeToggle.
- Keyboard shortcuts: `⌘1` left panel, `⌘2` right panel, `⌘K` command palette, `⌘,` settings, `⌘\` zen mode, `⌘Z` undo, `⌘⇧Z` redo, `V` select tool, `H` pan tool. Non-meta shortcuts (`V`/`H`) are suppressed when typing in inputs/textareas.
- The page sets `data-density` attribute on the root div (reactively subscribed to `useSettings((s) => s.density)`).
- On mount, an effect calls `sweepIdleSessions()` + `enforceSessionCap()` from the session store, using the user's settings (`autoArchiveIdleAfter`, `maxSessionsRetained`). Shows a toast if any sessions were archived.
- The page is a client component (`'use client'`) because it composes client-only panels.

### Design token system (`globals.css`)
- The `--ac-*` custom properties are the project's semantic design system. They are the SINGLE source of truth for colors, borders, surfaces, and focus rings.
- Token groups:
  - `--ac-text-primary` ... `--ac-text-faint` — text hierarchy (primary → faint). Consumed via `.ac-text-1` ... `.ac-text-5` utility classes.
  - `--ac-border-subtle` / `--ac-border-default` / `--ac-border-strong` — border weight scale.
  - `--ac-surface-0` ... `--ac-surface-3` — surface elevation (page → card → popover → modal).
  - `--ac-accent` / `--ac-accent-soft` / `--ac-accent-border` — the violet brand accent + soft bg + border tint.
  - `--ac-success` / `--ac-warning` / `--ac-danger` / `--ac-info` (+ `-soft` variants) — OKLCH status colors.
- Utility classes (also in `globals.css`):
  - `.ac-active-row` — 2px left accent bar + soft violet bg (for active list items).
  - `.ac-focus-ring` — accessible focus outline (2px brand ring, offset).
  - `.ac-transition` — standard transition (150ms ease).
  - `.ac-hide-scrollbar` — invisible-but-functional scrollbar.
- Keyframes:
  - `ac-fade-in` — opacity 0→1 + 4px upward translate (240ms ease-out). Used by the empty-canvas drop zone and other subtle entrances.
- Do NOT introduce a parallel token system. Extend `--ac-*` if needed.

### Dark mode
- Dark mode activates when `<html>` or any ancestor has the `.dark` class. The project uses `.dark` (NOT `[data-theme="dark"]`) — see `@custom-variant dark (&:is(.dark *))` at the top of `globals.css`.
- A `.dark` block in `globals.css` redefines every `--ac-*` token (same hues, inverted L axis via OKLCH). All utility classes pick up the new values automatically — no component changes needed.
- The toggle is `src/components/ThemeToggle.tsx` — cycles through **3 states**: `system → light → dark → system`. Subscribes to `useSettings((s) => s.themePreference)` so it stays in sync with Settings → Appearance changes. On `system`, follows OS `prefers-color-scheme` and re-applies on OS change.
- Legacy compat: the toggle also writes to `localStorage['agentcanvas-theme']` (the pre-settings key) so `getInitialTheme()` can hydrate before the settings store loads.
- **Density**: `[data-density="compact"]` rules in `globals.css` scale down fonts (text-[11px]→10px, text-[12px]→11px, text-[13px]→12px) + tighten padding on `.p-2`/`.p-3`/`.px-3`/`.py-2` + tighten `space-y-2`/`space-y-3` gaps. Controlled by the `density` setting; the root div's `data-density` attribute is reactively subscribed in `page.tsx`.
- **The canvas workspace itself does NOT swap to dark** — `document.background` is a user-controlled document property (like Figma's canvas fill), not a UI surface. Only the chrome (panels, dialogs, dropdowns, toolbar) swaps. This is intentional.

### Tailwind
- Tailwind 4 via `@tailwindcss/postcss` (no `tailwind.config.ts` content globs — Tailwind 4 auto-detects).
- `tailwind.config.ts` exists for legacy compat but is minimal.
- The `@theme` directive in `globals.css` maps the `--ac-*` tokens to Tailwind utilities where needed.

## Work Guidance

- When changing the layout structure: update `page.tsx`, update the layout diagram in this doc, capture before/after screenshots.
- When adding a new design token: add it to `globals.css` under the right group, add a utility class if it will be used in more than one component, document it here.
- When changing fonts: update `layout.tsx` (font import + `<body>` className) and `globals.css` (the `--font-*` variables if used).
- The page must render without layout shift on first paint — the session store hydrates after mount, so the initial render shows the empty state.

## Verification

- `bunx tsc --noEmit` — typecheck.
- `bun run lint` — ESLint.
- `bun run build` — production build (note: `ignoreBuildErrors: true` in `next.config.ts` means build will NOT fail on type errors — run `tsc` separately).
- Manual: open `http://127.0.0.1:3000/`, verify the 4-pane layout renders, no console errors, no layout shift.
- `bunx tsx scripts/screenshot-ui-after.ts` — captures the initial state.

## Child DOX Index

| Path | Scope |
|------|-------|
| `api/AGENTS.md` | API routes: `/api/agent` (SSE agent run endpoint) and `/api` (health check) |

*Note: `src/components/` and `src/lib/` do not have their own AGENTS.md files; only their subfolders do.*
