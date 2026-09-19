# AgentCanvas Landing Page — Internal Audit (2026-09-19)

- **Scope**: `src/components/landing/*`, `src/app/page.tsx`, `src/app/layout.tsx`, `src/app/opengraph-image.tsx`, `src/app/globals.css` (landing tokens), `public/landing/*`, `src/components/ui/{bento-grid,blur-fade,marquee,scroll-progress}.tsx`.
- **Method**: full source read + Playwright capture against `http://127.0.0.1:3100` (desktop 1440×900 @2x full-page + 6 per-section shots, mobile 390×844, reduced-motion) into `download/landing-verify/`, plus a runtime DOM probe (headings, LCP entry, img fetches, anchor landing positions, magic-crossfade opacities sampled at 8 scroll offsets, SSR HTML meta/stat extraction, keyboard copy test).
- **Caveat**: all captures are dev-mode (Next dev indicator "N" badge + "2 Issues" dev-overlay toast visible in shots — dev-only artifacts, not production defects).
- **Contract basis**: `src/components/landing/AGENTS.md`, `docs/superpowers/specs/2026-09-13-landing-page-design.md`.

---

## (a) Defect table

| # | Severity | Location | Description | Fix sketch |
|---|----------|----------|-------------|------------|
| 1 | **P0** | `src/components/landing/MagicSequence.tsx:38-43, 57, 109` | **The Magic scrolly crossfade never plays.** `useScroll` targets the 2-col grid (`sequenceRef`), which is only ~470px tall vs a 900px viewport → degenerate progress mapping. Runtime-sampled opacities across the section: build=1/done=0 → 0.74/0.26 → 0.885/0.11 → 1/0 and stays. `dashboard-complete.png` (the "Dashboard complete" payoff, step 03) never becomes visible on desktop scroll; the fade partially runs *backwards* mid-section. The "sticky" frame has only ~20px of travel (grid 470px − frame 450px) so nothing pins either — the spec §5.2 "pinned browser frame crossfading with scroll" is effectively absent. | Create real scroll room: make the left step column (or the grid) tall enough to exceed the viewport (e.g. `md:min-h-[160vh]` on the grid wrapper or spacer div), keep `sticky top-24` on the frame, and drive the crossfade from the **section** with `offset: ['start start', 'end center']` (or from the tall wrapper) so 0→1 spans the pin range. Update `landing/AGENTS.md` which currently claims the crossfade runs "over the section's scroll progress" (code targets the grid). |
| 2 | **P1** | `src/app/layout.tsx:31-42` / `src/app/page.tsx:40-51` | **No `metadataBase`** → OG/Twitter image URLs resolve against the request host. Observed: `og:image`/`twitter:image` = `http://localhost:3100/opengraph-image?…`. In production behind the Caddy gateway (or any proxy not forwarding the host), share previews break. | Set `metadataBase: new URL('https://<canonical-domain>')` in `layout.tsx` metadata (or page-level), per Next docs. |
| 3 | **P1** | `src/app/page.tsx:40-51` | Missing `alternates.canonical`, `og:url`, `og:type`, `og:site_name`. Twitter description also differs from OG description (shorter variant) — pick one wording. | Add `alternates: { canonical: '/' }` + an explicit `openGraph` object (type `website`, siteName `AgentCanvas`, url). Reuse the same description for both cards. |
| 4 | **P1** | `src/components/landing/Hero.tsx:165-172` (same pattern `MagicSequence.tsx:113-121,129-135,142-148`, `FeatureGallery.tsx:79-85`, `TrustLoop.tsx:50-56`) | **LCP image oversized / no `sizes` anywhere.** Runtime LCP entry = `/_next/image?url=%2Flanding%2Fhero-build.png&w=3840&q=75`, 245 KB fetched for a `max-w-4xl` (896px) slot; source PNG is 3840×2400, 905 KB. Every other landing image is also requested at `w=3840` candidates (dashboard/heatmap are 1280px sources — no upscale, but decode + wasted srcset work). | Add `sizes="(max-width: 767px) 100vw, 896px"` (frame slots: `50vw`/896px per context; heatmap band `~1152px`) and re-export `hero-build.png` at ~1920×1200 (2× of slot). Expect LCP payload roughly halved. |
| 5 | **P1** | `src/components/ui/bento-grid.tsx:61` + `:87-103`, used by `src/components/landing/FeatureGallery.tsx:56-69` | **Bento icons nearly invisible on the dark page** — `text-neutral-700` has no dark variant (≈1.9:1 on `#0a0a0f`; confirmed in `04-desktop-tool.png`: both cards read as empty black boxes). Additionally the "Open the canvas" CTA inside each card is `opacity-0` until `group-hover` on desktop (`lg:hidden`/`lg:flex` split), so at rest the cards show icon+title+description only, occupying ~352px-tall mostly-empty boxes. | Add `dark:text-neutral-300` (or use a token color) to the Icon, and make the CTA row always visible (at rest, not hover-gated) — or accept hover-only and add real card visuals (see enhancements). |
| 6 | **P1** | `src/components/landing/HowItWorks.tsx:29-38` | **SSR ships "0 typed tools / 0 LLM providers."** Stats initialize at 0 and bump to 60/28 after a 300ms mount timer; verified the SSR HTML's NumberFlow shadow DOM renders digit `0` for both. Crawlers and no-JS users index the wrong copy on a page whose headline stat is "60+". | Render final values from initial state (SSR = 60/28) and trigger the count-up client-side instead (e.g. set 0 only after mount, animate on in-view, or use NumberFlow's `spring`/`delay`), or gate the animation on `useInView` so SSR always has the true value. |
| 7 | **P1** | `src/components/landing/LandingHeader.tsx:29` + section `scroll-mt-20` (`MagicSequence.tsx:46`, `FeatureGallery.tsx:44`, `TrustLoop.tsx:36`, `HowItWorks.tsx:41`, `OpenSourceFinale.tsx:35`) | **Anchor links land 152px too low (double offset).** `lenis.scrollTo(hash, { offset: -72 })` runs on top of `scroll-mt-20` (80px), which modern lenis already honors when resolving the element. Verified: clicking `#magic` lands the section top at **+152px** (expected −72/−80); same for `#trust`. Inconsistent with the reduced-motion native path (−80). | Drop `offset: -72` from `lenis.scrollTo` (let `scroll-mt-20` own the offset), or remove `scroll-mt-*` and keep the JS offset — not both. |
| 8 | **P2** | `src/components/ui/blur-fade.tsx:85-105` wrapping all section headings/bento/trust screenshot/flow diagram/clone block | **All below-fold section content is JS-gated to opacity:0** (`initial="hidden"`, `animate` on `useInView`). No-JS visitors and non-JS-rendering crawlers see five blank bands; full-page captures show huge empty gaps where the hidden content reserves space. Raw SSR HTML does contain the text (fine for Google), but the progressive-enhancement floor is broken. | Lowest-risk improvement: switch BlurFade to a CSS-animation-on-inview pattern (content visible by default, animation adds the polish), or add a `<noscript>`/`.no-js` override that forces opacity:1. At minimum keep as-is knowingly. |
| 9 | **P2** | `src/app/layout.tsx:37-41` | Favicon set is `logo.svg` only — no `.ico` fallback, no `apple-touch-icon`, no `site.webmanifest`. iOS home-screen bookmark gets a screenshot tile. | Add 180px `apple-touch-icon.png` + 32/16 favicon.ico (+ optional manifest) in `src/app/` via Next file conventions. |
| 10 | **P2** | `src/components/landing/MagicSequence.tsx:63` (`text-white/40` step index), `HowItWorks.tsx:69` (arrow icon `text-white/40`, decorative) | Contrast: `white/40` ≈ 3.8:1 on `#0a0a0f` — fails AA (4.5:1) for the 12px step index. `white/50` pairs (Hero overline `Hero.tsx:86`, captions `FeatureGallery.tsx:89`, `HowItWorks.tsx:64,86,94`, task list `MagicSequence.tsx:93`) sit at ≈5.2–5.5:1 — pass but with little margin at 12–14px. | Bump step index to `white/50`+; keep `white/40` for decorative glyphs only. |
| 11 | **P2** | brand-gradient pills: `Hero.tsx:127`, `LandingHeader.tsx:67`, `OpenSourceFinale.tsx:84`, `prompt` chip `Hero.tsx:102`, check bullets `MagicSequence.tsx:94` | White text on the violet→fuchsia gradient measures ≈3.1–3.9:1 — below AA for the 14px CTA labels. Brand tradeoff, but the primary conversion buttons are the worst offenders. | Slightly darken the gradient stops for text-bearing fills (or add a subtle dark overlay/`shadow-inner`) to clear ~4.5:1. |
| 12 | **P2** | `Hero.tsx:101-118` (and `MagicSequence.tsx:73-88`) | **Mobile CLS from the typing line**: on 390px the prompt wraps to 2 lines; `repeat={Infinity}` delete/retype cycles oscillate the line count (1↔2), shifting CTAs/chips down every ~6s. Desktop unaffected. | Reserve height: `min-h-5 md:min-h-0` (or fixed 2-line block) on the typing paragraph. |
| 13 | **P2** | `Hero.tsx:151-157` + `src/components/ui/marquee.tsx` | Marquee renders 8 chips × `repeat=4` = **32 duplicated text nodes with no `aria-hidden`** — screen readers read the whole loop. Reduced-motion static row (8 chips) is fine. | Put `aria-hidden="true"` on the marquee (it's decorative) and keep an `sr-only` line naming the tool surface, or hide the duplicate copies. |
| 14 | **P2** | `public/landing/core-agent-chat.mp4` (306 KB), `core-trust-loop.mp4` (946 KB) | Dead assets: spec §6 listed them as *optional* b-roll; zero `<video>` elements anywhere (verified). 1.25 MB of dead weight shipped in `public/` (no runtime cost, but repo/archive bloat and a standing "unused" smell). | Either use them (enhancement #2) or delete before the next archive refresh. |
| 15 | **P2** | `src/app/page.tsx:40-51` | No JSON-LD structured data (spec §1 mentions OSS-project structure as an obvious fit; not required by spec). No `themeColor`/`viewport` export in layout (mobile browser chrome stays default). No `sitemap.xml` (robots.txt allows all; single-page site makes this near-moot). | One `<script type="application/ld+json">` SoftwareApplication entry (name, description, license AGPL-3.0, codeRepository, author) in `page.tsx`; `export const viewport = { themeColor: '#0a0a0f' }`. |
| 16 | **P3** | `TrustLoop.tsx:49-57` | The approval dialog occupies ~25% of the 1600×1000 screenshot inside the frame — the section's hero artifact is small relative to the frame (readable at 1440 but soft at laptop sizes). | Crop tighter in CSS: keep BrowserFrame but use a narrower `aspectRatio` + `object-cover object-center`-ish positioning (source is exact 16:10, so a modest zoom-crop is safe), or request a dialog-only capture. |

Non-defect notes:
- The stray "N" circle (bottom-left of every capture) and the red "2 Issues" toast in `09-reduced-motion.png` are the Next.js dev tools indicator — dev-only.
- `#open-source` anchor lands at +273px because finale+footer = 627px < 900px viewport: max-scroll clamp, not a bug. `pageH` ≈ 5304px at 1440w.

---

## (b) Enhancement opportunities (ranked by impact/effort)

1. **Make the Magic section actually cinematic (fixes #1) + use the idle MP4 b-roll.** The sticky crossfade is the centerpiece of the narrative and currently inert. While in there, consider a `<video muted loop playsInline preload="none">` layer using `core-trust-loop.mp4`/`core-agent-chat.mp4` as the final "complete" state (spec already sanctioned them; add a static poster for reduced-motion). Highest visible-quality win per hour.
2. **Give the bento cards product visuals.** Both cards are empty gradient boxes at rest (confirmed in capture). A mini layers-panel crop, a wireframe/flow thumbnail, or an animated CSS micro-demo inside each card + always-visible CTA (fixes #5) turns the weakest section into a strong one.
3. **OSS trust block**: live GitHub star count (client fetch of `api.github.com/repos/kanishka-namdeo/co-canvas` with graceful fallback, or a build-time constant) next to the Star CTAs; optionally "AGPL-3.0" + commit-shield badges in the finale. The page currently asserts OSS with zero social proof.
4. **SEO pack** (fixes #2, #3, #15): metadataBase + canonical + og:url/type/site_name + JSON-LD SoftwareApplication + favicon set + themeColor. Cheap, one sitting.
5. **Sticky header on scroll-up** (or a minimal scroll-spy dot rail): the anchor nav lives only in the absolute hero header, so past the first viewport there is no navigation and 5/6 CTAs are gone. ScrollProgress line exists but carries no affordance.
6. **Perf pass** (fixes #4): `sizes` everywhere + re-export `hero-build.png` at 1920×1200 + verify LCP drops to ~100–150 KB; consider `quality={80}` on the four screenshots.
7. **Richer HowItWorks stats row**: only two stats left-aligned with a large empty right side; add "20 node types" / "5 design-system packs" (both true per repo docs) and/or a mini `.pen` JSON snippet to balance the row.
8. **Trust screenshot zoom** (fixes #16): CSS-crop the approval dialog so the Deny/Allow modal fills more of the frame — it is the single most persuasive artifact on the page and currently renders small.
9. **Mobile heatmap band**: 16/7 at 390px ≈ 170px-tall slice — illegible. Either switch to `aspectRatio="4 / 3"` under `md` or drop the band on small screens.
10. **Copy nits**: Magic step-01 typed prompt says "Design a dashboard with KPI cards…" while the adjacent frame shows the *hero-section* build (agent chat in the screenshot literally says "Design a hero section…"). Align the prompt string with the visual (or swap the build screenshot) — the contradiction is visible to attentive readers.

---

## (c) LCP / performance notes

- **LCP element** = the hero `next/image` of `hero-build.png` (text headline renders earlier). Measured (dev, DPR1): URL `w=3840&q=75`, transfer 245,611 bytes, t≈2252ms (dev overhead inflates t; the payload is the actionable part).
- Root cause chain: source asset 3840×2400/905 KB (4× the display slot) + missing `sizes` on every landing image (default 100vw srcset candidates; browser selected the 3840 variant; dashboard/heatmap/approval requested at w=3840 too). Fixes in table rows #4.
- **Fonts**: Geist/Geist Mono/Inter via `next/font` (self-hosted, no external render-blocking) — good.
- **Route splitting**: below-fold sections via `next/dynamic` with a `min-h-[60vh]` skeleton (CLS-safe swap) — verified chunks; good.
- **CLS**: images sit in fixed-aspect frames or carry width/height — solid. Only real risk is the mobile typing-line oscillation (#12). NumberFlow digit animation is width-stable.
- **Animation hygiene**: all scroll motion is transform/opacity (composited) per spec §10 — verified in source. Lenis + `motion` are the only heavy client deps; within the spec §11 budget.
- **Videos**: none rendered; 1.25 MB of MP4s idle in `public/landing/` (#14).

## (d) Mobile findings (390×844 capture `08-mobile-full.png`)

- Single-column order preserved; parallax/tilt correctly disabled (breakpoint guard verified in source; static frame in capture); no horizontal overflow observed.
- Hero headline balances to 3 lines; CTAs stack full-width-ish; chip marquee shortened by mask — all fine.
- **Typing-line CLS** (#12) is mobile-only and repeats forever.
- Heatmap band becomes a ~170px sliver (#b-9); magic/heat frames keep `crop="bottom"` white fade — reads fine.
- Sticky magic frame on mobile has ~0 travel (same short-grid cause) — hidden behind #1's fix.
- Header shows logo + Star + Open CTA only (nav `hidden md:flex`) — acceptable; touch targets on the small pills ≈ 30–32px tall (below the 44px comfort guideline, P3).
- All BlurFade-gated content invisible in the full-page capture — same JS-gating artifact as desktop (#8); on-device scrolling reveals it, but it makes the page look broken in any no-JS/full-page context (link previews, some readers, print).

---

## What passed (verified, no action)

- Single `<h1>`; clean h1→h2→h3 hierarchy; all `<img>` have alt text; `header/nav/main/footer` landmarks; all 6 section ids match `LANDING_SECTIONS` (+ `top`).
- Reduced-motion: SmoothScroll provider unmounts (native anchors), static prompt, static 2-row chips, no parallax/blur/count-up, NumberFlow final values — all confirmed in `09-reduced-motion.png` + source.
- Copy button fully keyboard operable (Enter → `data-copied="true"`); default focus outline visible on dark.
- `opengraph-image` route renders 200 `image/png` 1200×630 with correct alt.
- Light-chrome BrowserFrame contract honored in all four screenshot placements; CSS-crop fades present; no raw light screenshots on the dark page.
- REPO_URL single-sourced in `repo-url.ts` everywhere (header, hero, finale, footer, clone command).

## Verification commands used / to re-run after fixes

- `LANDING_BASE_URL=http://127.0.0.1:3100 bunx tsx scripts/screenshot-landing.ts`
- `bun run test tests/unit/landing-hero.test.tsx tests/unit/landing-magic-sequence.test.tsx tests/unit/landing-gallery-trust.test.tsx tests/unit/landing-how-it-works-finale.test.tsx tests/unit/landing-primitives.test.tsx`
