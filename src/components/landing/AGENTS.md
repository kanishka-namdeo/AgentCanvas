# AGENTS.md — `src/components/landing/`

## Purpose

Shared chrome for the marketing landing page (route `/`, landing-page plan 2026-09-13). Every landing section component reuses these primitives; the workspace app itself lives at `/app` (`src/app/app/page.tsx`) and must not import from here.

## Ownership

- `repo-url.ts` — `REPO_URL` / `REPO_CLONE_URL`, the ONLY place the repo URL literal appears. Everything (header Star link, footer GitHub link, future sections) imports from here; never re-type the URL.
- `BrowserFrame.tsx` — light-chrome browser mockup (`data-testid="browser-frame"`): traffic-light chrome bar + fixed-aspect viewport (default `16 / 10`). All landing screenshots are LIGHT-mode captures on a DARK page, so they are always framed inside this light chrome — never pasted raw. `crop="bottom"` overlays a light fade over the viewport's bottom edge (spec §6: screenshot artifacts are cropped in CSS, never edited out of the source PNGs); pair with `object-cover object-top` on the child image and a NARROWER `aspectRatio` than the source shot.
- `LandingHeader.tsx` — `'use client'` absolute header over the hero. Exports `LANDING_SECTIONS`, the single source of the five below-hero anchor ids (`magic`, `tool`, `trust`, `how-it-works`, `open-source`) — section components MUST render elements with these ids. Anchor clicks scroll via `lenis` (`useLenis`); without a provider (prefers-reduced-motion) `useLenis()` returns `null` and clicks fall through to native anchor scrolling. CTAs: `header-star` → `REPO_URL`, `header-open` → `/app` (`.ac-brand-gradient` pill).
- `MagicSequence.tsx` — the Magic section (spec §5.2, landing-page plan Task 5): `<section id="magic" data-testid="section-magic">`, heading "Describe it. Watch it appear.", three numbered steps (step 02 carries the agent task list), and one sticky right-column `BrowserFrame` (`aspectRatio="4 / 3"` + `crop="bottom"`) whose two motion layers (`magic-frame-build` hero-build → `magic-frame-done` dashboard-complete) crossfade via `useScroll` + `useTransform` opacity over the section's scroll progress. Reduced-motion branch: ONE static dashboard frame (`magic-final-static`), no scroll transforms. Images use `object-cover object-top` so the dashboard shot's bottom edge ("202 Issues" toast) crops out in CSS (spec §6).
- `FeatureGallery.tsx` — the Feature section (spec §5.3, landing-page plan Task 6): `<section id="tool" data-testid="section-tool">`, heading "Not a toy — a Figma-grade tool.", a two-column `BentoGrid` of `BentoCard`s ("Figma-grade tooling" / "One-shot generators", each with href `/app` + CTA "Open the canvas"), and a full-width parallax band: `attention-heatmap.png` (1280×577) in a `BrowserFrame` (`aspectRatio="16 / 7"` + `crop="bottom"`, `object-cover object-top` so the bottom-edge toast artifact crops out in CSS per spec §6) with `useScroll` + `useTransform` y parallax (±32px). Reduced-motion branch: parallax transform omitted, all copy/images still render.
- `TrustLoop.tsx` — the Trust section (spec §5.4, landing-page plan Task 6): `<section id="trust" data-testid="section-trust">`, heading "You approve. Every time.", the `approval-dialog.png` (1600×1000, exact 16:10 → default BrowserFrame aspect, zero crop) at 3/5 width, and the four approved trust bullets (Destructive-operation gating / Diff cards / Unattended auto-deny after 5 minutes / Snapshot audit trail) at 2/5 width — the bullet copy is VERBATIM from spec §5.4; do not paraphrase. No scroll motion.
- `LandingFooter.tsx` — server-safe (no hooks): logo, AGPL-3.0 line, `footer-github` link → `REPO_URL`. No link farm.
- `Hero.tsx` — the 100vh cinematic opener (spec §5.1, landing-page plan Task 4): `<section id="top" data-testid="section-hero">`, the page's ONLY h1 ("Design at the speed of thought", wrapped in `Balancer as="h1"`), dual CTAs (`hero-star` → `REPO_URL`, `hero-open` → `/app`), typing prompt via `react-type-animation` (`hero-typing`), tool-call chip `Marquee` (`hero-chips`), gradient glow, and the hero-build screenshot in a `BrowserFrame` with scroll parallax (`useScroll` → transform-only `y`). Reduced-motion / narrow-screen branches (spec §10): static full-prompt text (`hero-typing-static`), static chip row (`hero-chips-static`), no glow keyframes, no parallax.

## Local Contracts

- Dark landing, light screenshots: the light-chrome BrowserFrame contract above is not optional.
- Header anchors and section ids both derive from `LANDING_SECTIONS` — a new below-hero section is added there AND rendered with the matching id by its section component.
- Components here are landing-only; shared app chrome stays out (root `src/components/AGENTS.md` owns ThemeToggle/ErrorBoundary).

## Verification

- `bun run test tests/unit/landing-primitives.test.tsx` — 7 tests covering the repo-URL constants, BrowserFrame crop/aspect/className contract, header anchors + CTAs, footer (next/image and lenis/react mocked).
- `bun run test tests/unit/landing-hero.test.tsx` — 8 tests covering the Hero headline/anchor, dual CTAs, hero-build screenshot dims, chip marquee, typing line, and the three reduced-motion branches (`useReducedMotion` module-mocked controllable; `next/image` mocked to a plain `<img>`).
- `bun run test tests/unit/landing-magic-sequence.test.tsx` — 6 tests covering the `#magic` anchor + heading, the three steps in order, both crossfade layers with their screenshot sources, the 4/3 + `data-crop="bottom"` viewport, and the two reduced-motion branches (same mock pattern as landing-hero).
- `bun run test tests/unit/landing-gallery-trust.test.tsx` — 8 tests covering the `#tool` anchor + heading, both bento cards' names + descriptions, the attention-heatmap band (source + real 1280×577 dims), the `#trust` anchor + heading, the approval-dialog screenshot (source + real 1600×1000 dims), the four verbatim trust bullets, and the reduced-motion variants of both sections (same mock pattern as landing-hero).

## Child DOX Index

No child `AGENTS.md` files. Section components added by later plan tasks land here and get an Ownership entry.
