# AgentCanvas Landing Page — Cinematic Scroll-Landing Design Spec

- **Status**: Approved, not started (2026-09-13). All decisions below were approved with the owner in the 2026-09-13 brainstorming session and are documented as-is — this spec does not re-open them.
- **Spec source**: Brainstorming session 2026-09-13 ("landing page for AgentCanvas"). Audience/tone **Option C approved** (both developers and designers; lead with the magic, descend into technical depth). Reference quality bar: Apple product pages, Linear, Vercel.
- **Code touchpoints** (planned):
  - `src/app/page.tsx` — replaced (new landing composition; old file moves, see §3)
  - `src/app/app/page.tsx` — new location for the workspace (moved verbatim from `src/app/page.tsx`, 1456-line self-contained file)
  - `src/app/opengraph-image.tsx` — new, `next/og` OG image generation
  - `src/components/landing/` — new directory (9 files, see §8)
  - `public/landing/` — new directory (6 copied media assets, see §6)
  - `package.json` — new deps: `motion`, `lenis`, `react-type-animation`, `number-flow-react`, `react-wrap-balancer` (rationale in §7)
- **Test coverage** (planned): Vitest 5 unit tests per landing component (render, CTA hrefs, reduced-motion fallback, alt text — details in §12); visual verification via a Playwright screenshot script modeled on `scripts/screenshot-ui-after.ts`. Details in §12.

---

## 1. Overview & Goals

**Product**: AgentCanvas — an AI-native collaborative design canvas ("Figma for AI agents"). Conversational-first: the user describes what they want ("Design a mobile login screen…"), the AI agent plans and executes 60+ typed tools to build the design live on an infinite canvas. Feature surface: Figma-grade design tooling (layers, properties, components, auto layout, variables, gradients), human-in-the-loop trust gating for destructive operations (Allow/Deny dialogs with diff cards), realtime collaboration (Socket.IO), session history with fork/restore + snapshots, export to JSON/SVG/PNG + Copy as HTML/React/Tailwind, the `.pen` file format, 28 LLM providers, 5 design-system packs. AGPL-3.0 open source, pre-launch, no pricing.

**Landing page goal**: invite users to the GitHub repo to test the app. The conversion actions are **starring/cloning the repo** and **opening the live canvas** — nothing else (no signup, no waitlist, no pricing).

**Audience & tone (approved Option C)**: both developers and designers. Lead with the magic (cinematic opening), then descend into technical depth. Reference quality bar: Apple product pages, Linear, Vercel.

**Deliverable**: a dark-first, cinematic, scroll-narrative landing page at `/` that replaces the current workspace route, with the workspace relocated to `/app` untouched except for the move.

## 2. Non-goals

Explicitly out of scope (owner-approved):

- No blog, no pricing, no testimonials, no docs section, no i18n, no analytics.
- No changes to workspace functionality beyond the route move + logo link (the workspace at `src/app/app/page.tsx` must be a verbatim move).
- No GSAP, Three.js/R3F, Lottie/Rive, shiki, or CSS scroll-driven animations API as the primary mechanism (rationale in §7).
- No image editing of source screenshots — the "202 Issues" toast artifacts are cropped in CSS (§6), not photoshopped.
- No new API routes, no server state, no database changes — the landing is fully static.

## 3. Routing & Page Ownership

- **The landing page owns `/`.** The workspace moves from `src/app/page.tsx` to `src/app/app/page.tsx` (verbatim move of the 1456-line self-contained file; no content edits during the move).
- Verified: nothing in `src/` links to `/` via `href="/"`, so the move breaks no internal links.
- **Landing header**: logo, anchor links to page sections (smooth-scrolled via lenis), GitHub star link, and the **"Open the canvas"** CTA linking to `/app`.
- **Workspace logo becomes a link back to `/`** — the only functional edit allowed inside the moved workspace file.
- **Metadata**: `src/app/page.tsx` gains a proper title/description; OG image generated via `next/og` in `src/app/opengraph-image.tsx`.
- **Canonical repo URL**: `https://github.com/kanishka-namdeo/co-canvas` (git remote is ground truth). Note: `README.md`'s clone command currently uses `https://github.com/kanishka-namdeo/AgentCanvas.git` — reconcile during implementation (update README to the remote URL); define the URL once as a shared constant in the landing components.
- **Sandbox note**: in the z.ai sandbox the externally exposed route is still `/` via the Caddy gateway (`:81` → `:3000`); `/app` is reached in-app. Root `AGENTS.md`'s "only user-visible route is `/`" line gets updated at implementation time (see §13).

## 4. Narrative Arc

The page is a single scroll narrative: **cinematic opener → the magic → real-tool depth → trust → architecture → open-source call to action.**

1. **Hero** — the hook. What it is, in one line, with motion.
2. **The Magic** — the core demo. Describe it, watch it appear (sticky scrolly sequence).
3. **Real design tool** — credibility for designers. "Not a toy."
4. **Trust loop** — credibility for teams. You approve every destructive step.
5. **How it works** — developer depth. Architecture, formats, providers.
6. **Open-source finale** — the conversion. Clone it, star it, open it.

Each section anchors into the header nav; scrolling is inertial (lenis); reveals are viewport-triggered (`whileInView`); the whole arc degrades to a static page under `prefers-reduced-motion` (§10).

## 5. Section-by-section Design

### 5.1 Hero (100vh)

- **Headline (verbatim)**: "Design at the speed of thought"
- **Subline (approved substance)**: the open-source canvas where AI agents do the drawing and you direct — rendered as: "The open-source canvas where the AI agents do the drawing — and you direct."
- **Dual CTA**: **"Star on GitHub"** (primary, `.ac-brand-gradient` fill) + **"Open the canvas"** (ghost, links to `/app`).
- **Background**: animated canvas-grid, drifting tool-call chips (Magic UI `marquee`), brand gradient glow built from `--ac-brand-from`/`--ac-brand-to`.
- **Foreground**: tilted browser-frame mockup (shared `BrowserFrame`, §8) containing the hero-build screenshot (`public/landing/hero-build.png`) with subtle scroll parallax.
- Hero typing effect on the subline's prompt fragment via `react-type-animation`; headline balanced via `react-wrap-balancer`.

### 5.2 The Magic (sticky scrolly core)

- **Heading**: "Describe it. Watch it appear."
- **Layout**: left column of three steps, right side a pinned browser frame.
  1. **Prompt typed** — the user's prompt types itself out (typing animation).
  2. **Agent plans and builds** — visible task list (the agent's todo items checking off).
  3. **Dashboard complete** — the finished product.
- The right-side browser frame is `position: sticky` and **crossfades screenshots in sync with scroll progress** — `useScroll` + `useTransform` (motion) driving opacity between frames; CSS `position: sticky` does the pinning.
- Screenshots: `public/landing/hero-build.png` (steps 1–2, modern UI mid-build) → `public/landing/dashboard-complete.png` (step 3, finished dashboard with agent task list).

### 5.3 Real design tool (parallax gallery / bento grid)

- **Heading**: "Not a toy — a Figma-grade tool."
- **Bento grid** (Magic UI `bento-grid`) cards:
  - **Layers / properties / components** — the design-tooling card.
  - **One-shot generators** — flows, wireframes, mindmaps.
  - **Wide parallax band** — the attention-heatmap screenshot (`public/landing/attention-heatmap.png`) in a full-width `BrowserFrame` with scroll parallax.

### 5.4 Trust loop

- **Heading**: "You approve. Every time."
- **Center stage**: the approval-dialog screenshot (`public/landing/approval-dialog.png` — the "Approve destructive operation" Deny/Allow modal) in a `BrowserFrame`.
- **Copy (approved)**:
  - Destructive-operation gating — the agent cannot delete/overwrite without an explicit Allow.
  - Diff cards — every proposed destructive change shown as a before/after diff.
  - Unattended auto-deny after 5 minutes — a pending approval with no human present is denied, never guessed.
  - Snapshot audit trail — every approved change is a restorable document snapshot.

### 5.5 How it works (developer depth)

- **Content (approved)**: 60+ typed tools · `.pen` file format · session persistence + snapshots · Socket.IO realtime · 28 LLM providers.
- **Pure CSS/flex diagram, no images** — a schematic of prompt → agent → tools → canvas rendered as styled boxes/connectors; stat numbers (60+, 28) animate in via `number-flow-react`.
- `Geist Mono` for the technical labels; this section is the handoff point from designer-magic to developer-substance.

### 5.6 Open-source finale

- **Heading**: "Open source. AGPL-3.0. Free forever."
- **Copyable clone command block**: `git clone https://github.com/kanishka-namdeo/co-canvas.git` (canonical URL per §3; copy button, Geist Mono, no syntax highlighting library — plain styled `<pre>`).
- **Star button** (GitHub) + final **"Open the canvas"** CTA (links to `/app`).

### 5.7 Header & Footer

- `LandingHeader` — fixed/absolute over the hero: logo (`public/logo.svg`, existing animated asset), anchor links to the six sections, GitHub star link, "Open the canvas" CTA (`/app`).
- `LandingFooter` — minimal: logo, AGPL-3.0 license line, GitHub link. No link farm.

## 6. Asset Manifest

All source assets verified present in the repo. Selected files are **copied** (not moved) into `public/landing/`.

| Source (repo) | Destination | Used in | Notes |
|---|---|---|---|
| `download/agent-ui-tests/07-hero-section.png` | `public/landing/hero-build.png` | Hero mockup + Magic steps 1–2 | Modern UI mid-build of a hero section on gradient canvas; best single asset |
| `download/dashboard-demo/05b-dashboard-full.png` | `public/landing/dashboard-complete.png` | Magic step 3 | Has a red "202 Issues" toast bottom-left — **crop via CSS framing** (`overflow: hidden` on the frame viewport), not image editing |
| `download/dashboard-demo/08-dashboard-zoomed-out.png` | `public/landing/attention-heatmap.png` | §5.3 parallax band | Attention-heatmap overlay; same toast issue, same CSS-framing treatment |
| `download/agent-chat-trust/05-approval-dialog.png` | `public/landing/approval-dialog.png` | §5.4 Trust loop | "Approve destructive operation" Deny/Allow modal |
| `download/video-demos/core-agent-chat_dist.mp4` (313 KB) | `public/landing/core-agent-chat.mp4` | Optional motion b-roll in browser frames | Lazy-loaded, `preload="none"`; skip if it complicates reduced-motion fallbacks |
| `download/video-demos/core-trust-loop_dist.mp4` (968 KB) | `public/landing/core-trust-loop.mp4` | Optional motion b-roll | Same treatment |
| `public/logo.svg` | *(already in place)* | Header, footer, OG image | Existing animated logo, reused as-is |

**Light-on-dark contract**: all screenshots are light-mode while the landing is dark. Screenshots are therefore always framed inside **light browser-chrome mockups** (`BrowserFrame` with a light chrome + light page background) so they read as "the product being shown" against the dark page — never pasted raw onto the dark background.

## 7. Library & Tooling Decisions

New dependencies (all free/OSS):

| Library | Role | Rationale |
|---|---|---|
| `motion` v12 | Scroll + reveal animation engine | framer-motion successor, React 19-compatible; `useScroll`/`useTransform` for the sticky sequence, `whileInView` reveals, `useReducedMotion`. ~16 kb |
| `lenis` (+ `lenis/react`) | Smooth inertial scrolling | The cinematic-scroll feel; ~4 kb |
| Magic UI (via shadcn CLI) | blur-fade, bento-grid, border-beam, marquee, scroll-progress | Copy-paste components through the existing shadcn setup — **no runtime dependency** |
| `react-type-animation` | Hero typing effect | Tiny, purpose-built |
| `number-flow-react` | Animated stat counters (§5.5) | Tiny, purpose-built |
| `react-wrap-balancer` | Headline line balancing | Tiny, purpose-built |

Deliberately skipped (owner-approved):

- **GSAP** — overlaps `motion`; two animation engines is a defect, not a feature.
- **Three.js / R3F** — off-brand for a 2D design tool and heavy.
- **Lottie / Rive** — no assets exist to animate.
- **shiki** — overkill for one clone-command block.
- **CSS scroll-driven animations API** — browser support not production-safe as the primary mechanism (motion covers it).

Already in the repo, reused: `sharp`, `lucide-react`, `tw-animate-css`, `next/image`, `next/font`, `next/og` (built-in OG image generation).

## 8. Component & File Structure

New directory `src/components/landing/` — one component file per section, plus shared chrome:

```
src/components/landing/
  LandingHeader.tsx      # logo, anchor nav, GitHub star, /app CTA
  Hero.tsx               # 100vh opener (§5.1)
  MagicSequence.tsx      # sticky scrolly sequence (§5.2)
  FeatureGallery.tsx     # bento grid + parallax band (§5.3)
  TrustLoop.tsx          # approval demo (§5.4)
  HowItWorks.tsx         # CSS/flex architecture diagram (§5.5)
  OpenSourceFinale.tsx   # clone block + star + final CTA (§5.6)
  LandingFooter.tsx      # minimal footer (§5.7)
  BrowserFrame.tsx       # shared light-chrome browser mockup (§6 contract)
```

Routes and app files:

```
src/app/page.tsx                  # NEW: landing composition + metadata (imports landing components)
src/app/app/page.tsx              # MOVED verbatim from src/app/page.tsx (1456 lines; only edit: logo links to /)
src/app/opengraph-image.tsx       # NEW: next/og OG image
public/landing/                   # NEW: media assets per §6
tests/unit/landing-*.test.tsx     # NEW: per-component tests (§12)
```

Each landing section is lazy-loaded below the fold via `next/dynamic`; the hero and header are in the initial bundle. Landing page components are self-contained — they must not import from `src/components/canvas/` or any workspace code.

## 9. Design Language & Visual Contracts

- **Dark-first cinematic landing**; the workspace stays light. The contrast is intentional — the landing is the movie trailer, the tool is the product. No dark/light toggle on the landing.
- **Tokens**: reuse the existing `--ac-*` design tokens from `src/app/globals.css`, especially `--ac-brand-from`/`--ac-brand-to` (violet → fuchsia, oklch) and the `.ac-brand-gradient` utility. Do not introduce a parallel token system.
- **Type**: Geist Sans + Geist Mono (already loaded in `src/app/layout.tsx` via `next/font`).
- **Screenshot framing**: light browser-chrome mockups per §6.

## 10. Animation & Accessibility Contracts

- **Composited properties only**: animations use `transform`/`opacity` exclusively (GPU-composited). No animating layout properties (width/top/left/margin).
- **`prefers-reduced-motion`**: every motion behavior has a static fallback via motion's `useReducedMotion` — parallax off, sticky crossfade renders the final screenshot, marquee rendered as a static chip row, typing effect renders the full prompt, `number-flow` renders final values.
- **Below-fold lazy loading**: sections after the hero are `next/dynamic` imports.
- **No CLS**: all `next/image` usage carries explicit width/height (or `fill` inside fixed-aspect frames); video containers get fixed aspect ratios.
- **Mobile**: simplified animations — no parallax on small screens (breakpoint-guarded), shorter marquee, same content order.
- **Semantics**: single `<h1>` (hero headline); one `<section>` per narrative beat with stable `id`s matching the header anchors; all images have alt text; CTA links are real `<a>` elements (not button-wrapping-jsx); focus-visible styles inherited from the existing token system.

## 11. Performance Budget

- **Incremental client JS from new deps**: `motion` ~16 kb + `lenis` ~4 kb gzipped; the three micro-utilities are single-digit kb each. Target: total incremental vendor JS ≤ 30 kb gzipped before landing component code; below-fold sections are dynamic imports so the initial route payload stays hero + header only.
- **LCP element**: the hero headline (server-rendered text). Hero screenshot uses `next/image` with `priority`; everything below the fold lazy-loads.
- **CLS**: 0 (explicit dimensions everywhere, §10).
- **Landing page weight**: static screenshots go through `next/image` optimization; the two MP4 b-roll clips (313 KB + 968 KB) are the only heavyweight media and are optional b-roll with `preload="none"` — they never block first paint.
- **OG image**: generated at build/request by `next/og` — zero cost to page JS.
- **Sandbox constraint**: in the z.ai sandbox the dev server runs on `:3000` only — never `bun run build` / `next start` there. CI and dev machines build normally.

## 12. Testing Plan

**Unit tests (Vitest 5, `tests/unit/landing-*.test.tsx`)** — per landing component:

1. Renders without crash.
2. **CTA hrefs correct**: GitHub CTAs point at the canonical repo URL (`https://github.com/kanishka-namdeo/co-canvas`), canvas CTAs point at `/app`, header anchors match section `id`s.
3. **Reduced-motion fallback**: with the reduced-motion condition set, the static variant renders (final screenshot visible, no parallax-driven transform, marquee static).
4. **Images have alt text** (every `next/image` in the component tree).

**Visual verification**: dev server + a new Playwright screenshot script modeled on `scripts/screenshot-ui-after.ts` (same setup and output convention per `scripts/AGENTS.md`; default viewport 1440×900) capturing full-page + per-section shots of the landing on desktop and mobile widths, reviewed against the §5 designs.

**Constraints honored**: Vitest 5, Tailwind 4 CSS-first config, React 19, Next.js 16 App Router; free/OSS tooling only; sandbox dev-server rule per §11.

## 13. DOX Pass (planned, at implementation)

When this spec is implemented:

- `docs/AGENTS.md` gains an Ownership row for this spec (done at spec-write time — see below).
- `src/app/AGENTS.md` must be updated when `page.tsx` moves: `page.tsx` ownership shifts to the landing composition, `src/app/app/page.tsx` becomes the workspace entry, and the metadata/OG ownership note is added.
- `src/components/AGENTS.md` gains a `landing/` child entry (create `src/components/landing/AGENTS.md` per the Child Doc Shape when the directory lands).
- Root `AGENTS.md` "z.ai Sandbox Operations" line "The only user-visible route is `/`" gets updated to reflect `/` (landing) + `/app` (workspace).

## 14. Open Questions

None. All decisions were approved with the owner on 2026-09-13 and are captured above as-is. The only implementation-time judgment calls (destination filenames in `public/landing/`, canonical repo URL per §3, exact subline wording per §5.1) are resolved inside this spec.
