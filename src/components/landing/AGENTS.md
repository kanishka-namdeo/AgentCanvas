# AGENTS.md — `src/components/landing/`

## Purpose

Shared chrome for the marketing landing page (route `/`, landing-page plan 2026-09-13). Every landing section component reuses these primitives; the workspace app itself lives at `/app` (`src/app/app/page.tsx`) and must not import from here.

## Ownership

- `repo-url.ts` — `REPO_URL` / `REPO_CLONE_URL`, the ONLY place the repo URL literal appears. Everything (header Star link, footer GitHub link, future sections) imports from here; never re-type the URL.
- `BrowserFrame.tsx` — light-chrome browser mockup (`data-testid="browser-frame"`): traffic-light chrome bar + fixed-aspect viewport (default `16 / 10`). All landing screenshots are LIGHT-mode captures on a DARK page, so they are always framed inside this light chrome — never pasted raw. `crop="bottom"` overlays a light fade over the viewport's bottom edge (spec §6: screenshot artifacts are cropped in CSS, never edited out of the source PNGs); pair with `object-cover object-top` on the child image and a NARROWER `aspectRatio` than the source shot.
- `LandingHeader.tsx` — `'use client'` absolute header over the hero. Exports `LANDING_SECTIONS`, the single source of the five below-hero anchor ids (`magic`, `tool`, `trust`, `how-it-works`, `open-source`) — section components MUST render elements with these ids. Anchor clicks scroll via `lenis` (`useLenis`); without a provider (prefers-reduced-motion) `useLenis()` returns `null` and clicks fall through to native anchor scrolling. CTAs: `header-star` → `REPO_URL`, `header-open` → `/app` (`.ac-brand-gradient` pill).
- `LandingFooter.tsx` — server-safe (no hooks): logo, AGPL-3.0 line, `footer-github` link → `REPO_URL`. No link farm.

## Local Contracts

- Dark landing, light screenshots: the light-chrome BrowserFrame contract above is not optional.
- Header anchors and section ids both derive from `LANDING_SECTIONS` — a new below-hero section is added there AND rendered with the matching id by its section component.
- Components here are landing-only; shared app chrome stays out (root `src/components/AGENTS.md` owns ThemeToggle/ErrorBoundary).

## Verification

- `bun run test tests/unit/landing-primitives.test.tsx` — 7 tests covering the repo-URL constants, BrowserFrame crop/aspect/className contract, header anchors + CTAs, footer (next/image and lenis/react mocked).

## Child DOX Index

No child `AGENTS.md` files. Section components added by later plan tasks land here and get an Ownership entry.
