# AGENTS.md — `src/app/`

## Purpose

The Next.js App Router entry point: the root layout, the main page (the 4-pane AgentCanvas layout), and the global stylesheet that defines the `--ac-*` design token system.

## Ownership

- `layout.tsx` — root layout. Sets up `<html>`, `<body>`, font loading, theme provider, toaster. Owned by this folder.
- `page.tsx` — the main page. Renders the 4-pane layout: `SessionSidebar | (LayersPanel + PropertiesPanel) | Canvas | (SessionHeader + AgentPanel + RunHistoryPanel)`. Also renders the top status bar.
- `globals.css` — global styles + the `--ac-*` design token system. Owned by this folder; consumed by every component.

## Local Contracts

### Layout (`layout.tsx`)
- Sets `<html lang="en">` + `<body>`.
- Loads fonts (Inter for body, optionally a display font for headings — currently Inter only).
- Wraps the app in the theme provider (next-themes) and renders the `<Toaster />`.
- Server component — do not add `'use client'` here.

### Page (`page.tsx`)
- The 4-pane layout is the canonical layout. Do not introduce a 5th column without a parent-level decision.
- Top status bar shows: connection status (pill-style badge — "local-only" replaces the alarming "offline"), document name, agent status.
- The page is a client component (`'use client'`) because it composes client-only panels.
- The panes use `react-resizable-panels` (`ResizablePanel` + `ResizableHandle`) — keep the resize handles visible (do not set their width to 0).

### Design token system (`globals.css`)
- The `--ac-*` custom properties are the project's semantic design system. They are the SINGLE source of truth for colors, borders, surfaces, and focus rings.
- Token groups:
  - `--ac-text-1` ... `--ac-text-5` — text hierarchy (primary → faint). Consumed via `.ac-text-1` ... `.ac-text-5` utility classes.
  - `--ac-border-subtle` / `--ac-border-default` / `--ac-border-strong` — border weight scale.
  - `--ac-surface-0` ... `--ac-surface-3` — surface elevation (page → card → popover → modal).
  - `--ac-brand` / `--ac-brand-fg` — the violet brand accent + its readable foreground.
  - `--ac-status-success` / `--ac-status-warning` / `--ac-status-error` / `--ac-status-info` — OKLCH status colors.
- Utility classes (also in `globals.css`):
  - `.ac-active-row` — 2px left accent bar + soft violet bg (for active list items).
  - `.ac-focus-ring` — accessible focus outline (2px brand ring, offset).
  - `.ac-transition` — standard transition (150ms ease).
  - `.ac-hide-scrollbar` — invisible-but-functional scrollbar.
- Do NOT introduce a parallel token system. Extend `--ac-*` if needed.
- Dark mode: tokens are defined for light mode only. If dark mode is needed later, add a `[data-theme="dark"]` block that redefines the `--ac-*` variables — the utility classes will pick up the new values automatically.

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
| `api/AGENTS.md` | API routes: `/api/agent` (SSE-style agent run endpoint) and `/api` (health check). |
