# External Benchmarks — Best-in-Class Landing Pages (AgentCanvas Landing Uplift)

- **Date:** 2026-09-19 · **Scope:** web research only, no code changes
- **Method:** live fetches of 12 benchmark sites (Linear, Vercel, Cursor, Raycast, Supabase, Figma, Stripe, Framer, Notion, Arc, Lovable, v0) + 10 searches across 2025–2026 trend reports, conversion benchmarks, video/LCP performance guides, OG-image and accessibility guidance. Sources listed at the end.
- **Purpose:** ground the AgentCanvas landing upgrade in concrete, implementable patterns. Every pattern below includes an implementation sketch for our exact stack: **Next.js App Router + Tailwind + motion (framer-motion v12) + lenis + Magic UI**.

Repo facts used throughout (verify against current code before shipping copy):
- Landing lives in `src/components/landing/` (Hero, MagicSequence, FeatureGallery, TrustLoop, HowItWorks, OpenSourceFinale, BrowserFrame, SmoothScroll, LandingHeader/Footer, `repo-url.ts`).
- `public/landing/` **already contains two unused MP4s**: `core-agent-chat.mp4` (1280×800, 35.1s, **313 KB**) and `core-trust-loop.mp4` (1280×800, 12.1s, **969 KB**) — both far under any reasonable video budget.
- `hero-build.png` is **927 KB** and is the hero/LCP image; the other PNGs are 115–233 KB.
- Stats currently on the page: 60+ tools, 28 providers. Product surface also includes: .pen format (v2.17, 20 node types), design-system packs, sessions + snapshots, Socket.IO realtime, export to HTML/React/Tailwind, AGPL-3.0.

---

## 1. Benchmark teardowns (what the best sites actually do)

### 1.1 Linear — linear.app
- **Hero:** "The product development system for teams and teams and agents" (rotating headline variants) + "Purpose-built for planning and building products. Designed for the AI era." Announcement pill ("New — Loops →").
- **Visuals:** no plain screenshots — the page renders **live product simulations**: an animated issue detail with an agent-activity timeline ("just now", "2min ago"), a backlog board, a Gantt roadmap, an agent chat panel, a real code-diff view. Motion is *diegetic* — the product appears to be running.
- **Proof:** customer logo strip → /customers; three named testimonials (OpenAI, Ramp, Opendoor); one metric: **"Linear powers over 40,000 product teams."**
- **Structure:** Hero → 3 value props labeled **Fig 0.1–0.3** (editorial "figure" numbering) → 4 capability sections each with "Learn more →" + expandable feature lists → **Changelog** (4 entries) → testimonials → 40k stat → final CTA band ("Built for the future. Available today.") → link footer.
- **Takeaway for us:** the "live simulation" hero (animated agent timeline) is exactly our product's story — our typing-prompt hero is a start, the tool-call *execution* is the missing spectacle. The changelog section and figure-numbered sections are cheap, high-craft additions.

### 1.2 Vercel — vercel.com
- **Hero:** "Agentic Infrastructure" + three concrete bullet lines (API/CLI/MCP/Skills, sandboxed VMs, agents that "autonomously investigate errors, plan fixes, and open PRs"). CTAs: "Deploy now" / "Talk to sales".
- **Proof:** one named metric per section — Notion "powers millions of agent conversations daily on Vercel", Zapier "100M monthly visits", Mintlify "20,000+ companies". **No logo walls, no testimonials** — metrics only.
- **Structure:** hero → 3 customer-anchored capability sections → "Recently shipped" (3 items) → closer "Built by you, or your agents".
- **Agent-friendliness:** ships **`/get-started.md`** — a markdown onboarding doc instructing coding agents to "fetch and follow". Marketing page doubles as agent-usable surface.
- **Takeaway:** one hard number beats five vague claims; "Recently shipped" communicates velocity; a markdown get-started doc is a perfect fit for an agent-product like ours.

### 1.3 Cursor — cursor.com
- **Hero:** "Cursor is your coding agent for building ambitious software." No subhead — instead **interactive demos** (desktop app + CLI mockups with live task lists "In Progress 2 / Ready for Review 3"). CTAs: "Download for macOS⤓", "Get started→".
- **Proof:** testimonial wall of **industry celebrities** (Jensen Huang, Andrej Karpathy, Patrick Collison, shadcn, Greg Brockman); "Trusted by over half of the Fortune 500"; "40,000 NVIDIA engineers"; **security badge row: SOC 2 | ISO27001 | ISO42001 | AIUC-1 Certified**.
- **Structure:** hero demo → capability sections each with its own mini-demo (cloud agent showing "Worked for 14m 22s", Slack bot mock, parallel agent fleets) → testimonials → model picker → enterprise → **changelog** → research → "Try Cursor now."
- **Takeaway:** every section carries a *working demo*, not prose. Status text with durations ("Worked for 14m 22s") makes autonomy legible. Security/trust badges convert enterprise visitors.

### 1.4 Raycast — raycast.com
- **Hero:** "Your shortcut to everything." + "A collection of powerful productivity tools all within an extendable launcher. Fast, ergonomic and reliable."
- **Proof:** **~24 testimonial cards** with name/handle/role (CEO Vercel, MKBHD, Tailwind creator); **"99.8% crash-free rate"**; community counts (**"37k members"** Slack, **"90k followers"** X).
- **Structure:** hero → keyboard tagline → 3 value props → tabbed extension grid (Productivity/Engineering/Design/Writing) → AI agent demo (animated status text "Fetching assigned tasks…") → testimonial wall → snippets/quicklinks demos → community + embedded YouTube thumbnails → developer-API section → final CTA "Take the short way."
- **Takeaway:** community numbers (Slack/X members) are social proof an OSS project *can* show from day one; testimonial cards with handles feel authentic; tabbed feature grids compress breadth.

### 1.5 Supabase — supabase.com
- **Hero:** "Build in a weekend. Scale to millions." Nav shows **"110K GitHub stars"** — star count as permanent nav furniture.
- **Proof:** "Trusted by fast-growing companies worldwide" logo strip; customer stories with **named quotes + photos**; a wall of community tweets; "Open source from day one" section; compliance badges (SOC2, HIPAA, ISO27001) in footer.
- **Structure:** hero → 6 product sections (each dark/light image pair) → differentiators → customers → community → open source → hero tagline repeated as final CTA.
- **Takeaway:** the canonical OSS landing pattern: **star count in nav + logo wall + tweet wall + open-source section + tagline-repeat closer**. Directly transferable to AgentCanvas.

### 1.6 Figma — figma.com
- **Hero:** "The intelligent canvas for infinite creativity" + "One workspace for your entire product development process." CTA "Get started for free".
- **Proof:** **"95% of the Fortune 500 uses Figma"** (with a dated caveat "Based on data from March 2025") + one testimonial + 3 logo strips.
- **Structure:** hero → one-workspace positioning → **"AI-native canvas"** section ("Teammates and AI agents work in the same space with shared context") → Design feature block → Make feature block → customers → community templates carousel (10 slides) → footer.
- **Takeaway:** our closest category language. "Intelligent canvas", "agents work in the same space with shared context" — validates our positioning vocabulary and the canvas-as-hero framing.

### 1.7 Stripe — stripe.com
- **Hero:** "Financial infrastructure to grow your revenue." + kicker "Global GDP running on Stripe:".
- **Proof (the deepest stack on the web):** infinite logo marquee (Amazon, Shopify, Ford, NVIDIA, Anthropic, Figma, Uber, Vercel, OpenAI…); **stats band: "$1.9T in payments volume processed in 2025", "99.999% historical uptime", "200M+ active subscriptions", "135+ currencies"**; "50% of the Fortune 100"; "88% of the Forbes AI 50"; customer stories with hard outcomes (Hertz: 160 countries; URBN: $5B consolidated); startup logos incl. **Lovable, Gamma, Supabase, Linear**.
- **Structure:** hero → logo carousel → solutions grid → stats band → "Powering businesses of all sizes" → developer section → news carousel → final CTA → mega-footer.
- **Takeaway:** the stats-band pattern; specificity as brand ("$1.9T", "99.999%"). For us the equivalent numbers are 60+ tools, 28 providers, 20 node types, 2,700+ tests.

### 1.8 Framer — framer.com
- **Hero:** "Framer is the design agent for every step from idea to launch" — an **agent-product landing an agent landing page**: simulated agent streaming ("Thinking… → Created a design plan → 2s"), agent chat transcripts, live-tagged canvases.
- **Proof via real telemetry:** platform cards show **actual Core Web Vitals ("LCP 1.1s, INP 95ms, CLS 0.01")**, an A/B-test card with a **"WINNER 14.1% lift"**, a token counter ("504,616,418,546 tokens processed this week"), community feed posts with engagement counts, "21,381 Resources".
- **Finale:** **prompt-chip CTA starters** — "Create personal portfolio", "Build startup site", "Launch landing page", "Start company blog" + a "Start without AI" fallback.
- **Takeaway:** the best current example of *agent-as-product* landing craft. Self-referential proof (the site's own perf numbers as content), prompt chips as CTAs, and simulated agent steps are all directly liftable.

### 1.9 Notion — notion.com
- **Hero:** "Where teams and agents Think together." + **hero video with a Play trigger**.
- **Proof:** "Trusted by 98% of the Forbes Cloud 100"; logo links (OpenAI, Figma, Ramp, Cursor, Vercel, Toyota…); 3 named testimonials — including **Cursor's CEO quoting Notion** (peer-logo testimonials); a McLuhan pull-quote as a brand beat.
- **Structure:** hero (+ video) → logos → 3 feature cards → use-case links → testimonials → pull-quote → footer.
- **Takeaway:** hero video is mainstream at the very top; a single editorial pull-quote is a cheap craft move; use-case links ("Automate weekly reporting") convert scanners.

### 1.10 Arc — arc.net
- **Hero:** a **quote as headline**: "Arc is the Chrome replacement I've been waiting for." Download CTAs repeated top and bottom.
- **Proof:** four text-only testimonials with handles; nothing else — deliberately minimal.
- **Takeaway:** quote-as-headline is a strong pattern for word-of-mouth products; also a cautionary example that minimal proof works only once you have distribution.

### 1.11 Lovable — lovable.dev
- **Hero:** "Build something Lovable" + **an actual prompt input as the hero object** ("Bring a new product, internal tool, or entire company to life…") with a Build button. Light theme (#fcfbf8). Typewriter hook in preload.
- **Proof:** "The proof is in production" — case cards with hard metrics (**"$2M+ saved"**, **"€130K ARR in 30 days"**, **"48 hours to build"**); logo wall (Adidas, Nvidia, Asana, ElevenLabs…); scale band **"Millions count on Lovable": 1.2M new projects/week, 60M projects, 900M monthly visits**.
- **Takeaway:** our most direct competitor's page is prompt-first: the input *is* the hero. Hard outcome metrics per customer story. A scale-metrics band once you have usage.

### 1.12 v0 — v0.app (client-rendered; structure via docs + analyses)
- **Hero:** a **large natural-language prompt input** ("What can I help you ship?") with model/variant chips — the product is the hero.
- **Below:** a **community showcase gallery** where every generation shows the prompt that produced it — social proof and prompt-education in one component.
- **Takeaway:** prompt-input hero + showcase-with-prompts is the category-standard conversion device for prompt-to-UI products (v0, Lovable, Bolt).

---

## 2. Pattern library (distilled, with implementation sketches)

Stack abbreviations: `motion` = framer-motion v12 (`useScroll`, `useTransform`, `useInView`, `useReducedMotion`), `MagicUI` = Magic UI primitives already in `src/components/ui/` (Marquee, BorderBeam, BlurFade, BentoGrid…), `lenis` = our `SmoothScroll` provider.

### P1. Outcome-led hero + ONE specific proof point above the fold
- **What:** h1 states the outcome, one line of specificity, then exactly **one** credible proof point directly under the headline — a named logo, a real number, or a star count. From 170 analyzed heros (Web Anatomy): one strong proof point beats five; be specific ("40,000 teams", not "thousands").
- **Who:** Linear ("40,000 product teams"), Figma ("95% of the Fortune 500"), Notion ("98% of the Forbes Cloud 100"), Cursor ("half of the Fortune 500").
- **Why it works:** proof under the headline resolves skepticism *before* the scroll; specificity reads as confidence.
- **Sketch:** in `Hero.tsx`, under the subcopy and above the CTAs, add a single proof row: `<GitHubStarCount />` + `AGPL-3.0` + `60+ tools` (one line, mono font, muted). Server component fetches `https://api.github.com/repos/{owner}/{repo}` with `next: { revalidate: 3600 }`; falls back to a static "Star on GitHub" if the API fails. Never show a fake number.

### P2. Prompt-input hero (the product is the hero)
- **What:** the hero's central object is a working prompt input (or a pixel-faithful simulation), not a sentence.
- **Who:** v0, Lovable (input + Build button), Framer (prompt-chip starters), Cursor (task-list demo).
- **Why it works:** for prompt-to-UI products the input communicates the entire workflow in 0.5s — no copy can do that. It also invites interaction (zero-cost demo).
- **Sketch (two options):**
  - *Simulation (S):* upgrade the existing `react-type-animation` line into a fake input row with caret, model chip ("GLM / OpenAI-compatible…"), and a gradient Build button; on "submit" flash, hand off to `/app`.
  - *Live (M):* render a real input; submit deep-links to `/app` with the prompt prefilled (`/app?prompt=…` — verify app support; if absent, P1 rec #10 covers wiring).

### P3. Autoplay muted product video (with the poster-swap LCP pattern)
- **What:** 6–20s screen recordings, `muted autoplay loop playsinline`, poster fallback, no sound-dependence. Hero video or per-feature video — both are mainstream (Notion hero Play; Cursor demos in every section).
- **Benchmarks:** duration sweet spot **5–12s** (up to ~20s for calm screen content); file target **≤ 3–5 MB** (H.264 MP4); **video is LCP-eligible**, so never let the video be the LCP element — preload the *poster* instead.
- **Who:** Notion (hero), Raycast (YouTube embeds), Lovable/v0 (in-app captures), Cursor (demos).
- **Why it works:** motion shows *process* — for an agent product, the process IS the product. Static PNGs show outcome only.
- **Sketch:** we already own the assets: `public/landing/core-trust-loop.mp4` (12.1s, 969KB — ideal) and `core-agent-chat.mp4` (35.1s, 313KB — calm content, fine to loop, or trim to ~15s). Pattern:
  ```tsx
  // Server-rendered poster is the LCP element; video hydrates on top.
  const ref = useRef<HTMLVideoElement>(null);
  const inView = useInView(ref, { margin: "200px" });
  useEffect(() => { // play only when visible; respect reduced motion
    if (reduced) return;
    inView ? ref.current?.play().catch(() => {}) : ref.current?.pause();
  }, [inView, reduced]);
  return (
    <BrowserFrame>
      <video ref={ref} muted loop playsInline preload="none"
        poster="/landing/approval-dialog.png"
        className="absolute inset-0 h-full w-full object-cover object-top">
        <source src="/landing/core-trust-loop.mp4" type="video/mp4" />
      </video>
    </BrowserFrame>
  );
  ```
  Reduced-motion branch = the current static PNG (already our pattern). Keep videos inside the light-chrome `BrowserFrame` (verify the captures are light-mode; if dark, re-record — the frame contract is not optional).

### P4. Live product simulation over static screenshot
- **What:** sections render *animated mock UIs* — agent timelines ticking, statuses flipping, cursors moving — rather than frozen PNGs.
- **Who:** Linear (agent activity timeline "just now"), Cursor ("Worked for 14m 22s"), Framer ("Thinking… → Created a design plan → 2s").
- **Why it works:** communicates autonomy and liveness — the two hardest things to prove about an agent — and photographs badly (competitors can't screenshot it).
- **Sketch:** build one `AgentTimeline` mock component (client): 4–6 rows (`create_frame`, `apply_tokens`, `insert_component`…) appearing sequentially with `BlurFade`/`AnimatePresence`, timestamps counting ("2s ago"), looping every ~8s. Place it beside the MagicSequence sticky frame or inside the FeatureGallery bento. Pure DOM + motion — no video needed, tiny bundle.

### P5. Social-proof stack: logo wall → named quotes → metric band
- **What:** three-tier proof: (1) logo strip ("Trusted by…"), (2) testimonial cards with name/role/handle (+ avatar), (3) a stats band of 3–4 hard numbers.
- **Who:** Stripe (logo marquee + $1.9T band + stories), Supabase (logo strip + quotes + tweet wall), Raycast (24 quote cards + community counts), Lovable (case metrics + scale band).
- **Why it works:** different visitors trust different evidence; logos = borrowed status, quotes = empathy, metrics = scale. Stripe stacks all three and converts everyone.
- **Sketch:** new `SocialProof` section between TrustLoop and HowItWorks (or immediately after MagicSequence): a Magic UI `Marquee` of tech/trust logos we can legitimately claim ("Built on": Next.js, Tailwind, Radix UI, Prisma, Socket.IO — plus "Featured" links when they exist), 3 `QuoteCard`s (Raycast style: quote + name + handle + repo role), and a stat row. **Honesty rule:** until we have real users/quotes, show the tech-stack strip + GitHub-derived numbers (stars, forks, contributors, commits) and omit testimonials entirely — fabricated proof is worse than none.

### P6. OSS proof furniture: live star count, contributors, clone command
- **What:** GitHub stars as a persistent nav/hero element; contributors + commit activity as proof of velocity; clone/copy command as the finale.
- **Who:** Supabase ("110K GitHub stars" in nav), Stripe's startup strip, our OpenSourceFinale (already has the clone command — good bones).
- **Why it works:** for OSS, the repo IS the product; stars are the single most trusted external signal developers have.
- **Sketch:** `src/components/landing/GitHubStars.tsx` (server component, `revalidate: 3600`, typed fallback): render `★ 1,234` inside the header star chip (`header-star`), the hero proof row, and `finale-star`. Optionally add a tiny `AvatarStack` of contributor avatars in OpenSourceFinale (from `api.github.com/repos/.../contributors`).

### P7. Bento feature grid (expand from 2 cards)
- **What:** asymmetric modular grid where each tile = one feature + one visual + one link. Still a dominant 2026 pattern, especially for data-dense/AI products.
- **Who:** Framer ("Not just vibes, a full platform" — 9 cards), Raycast (tabbed grid), Apple-originated; Magic UI ships `BentoGrid`.
- **Why it works:** high information density with scannable hierarchy; each tile is independently linkable/animatable.
- **Sketch:** extend `FeatureGallery.tsx` from 2 `BentoCard`s to 5: Figma-grade tooling (layers/properties), Design-system packs, .pen file format (show a mono JSON snippet tile), Sessions + snapshots, Export HTML/React/Tailwind (show a code chip). Give each tile a distinct visual device (mini mock, mono snippet, icon cluster); hover = border-glow + slight lift (motion, `whileHover`); keep the parallax heatmap band as the bento's closing row.

### P8. Sticky scroll-telling with 3+ states
- **What:** a sticky visual on one side; scrolling steps a numbered list on the other; the visual *changes state per step* (crossfade/swap). The core "scrollytelling" pattern of 2025–2026.
- **Who:** Linear capability sections, Cursor demos, Notion feature trio; our MagicSequence already does a 2-state version.
- **Why it works:** converts passive scroll into a guided narrative; each step is one message with one visual — ideal for a 3-beat agent story (describe → agent works → result).
- **Sketch:** extend `MagicSequence.tsx`: keep the sticky `BrowserFrame`; add a third motion layer (`magic-frame-agents`: the `AgentTimeline` mock from P4 or `core-agent-chat.mp4`) between typing and result. Drive layer opacity with the existing `useScroll`+`useTransform` over three scroll ranges; steps 01/02/03 highlight as their range activates (`useMotionValueEvent` → activeStep state). Reduced-motion: final static frame (unchanged contract).

### P9. Metric callouts with developer-specific numbers
- **What:** a stats band of 3–4 numbers that only a real product could know; count-up on scroll into view.
- **Who:** Stripe ($1.9T / 99.999% / 200M+), Linear (40k teams), Framer (CWV numbers as content), Vercel (one metric per customer).
- **Why it works:** specificity = credibility; for devs, *technical* numbers (node types, test counts) signal craft more than marketing numbers.
- **Sketch:** upgrade `HowItWorks.tsx` stats: keep 60+ tools / 28 providers, add `20` node types (".pen schema") and optionally `2,700+` tests. Same `NumberFlow` pattern (0 → value after mount timer). Label each stat in Geist Mono. Copy discipline: numbers must match reality — check current counts before shipping.

### P10. Ship-velocity / changelog strip
- **What:** 3 latest releases as cards/rows ("Recently shipped", "Changelog", "Stay on the frontier").
- **Who:** Linear (4 changelog entries), Cursor (changelog + research), Vercel ("Recently shipped").
- **Why it works:** proof of momentum; OSS visitors check activity before starring — surface it instead of making them open GitHub.
- **Sketch:** in `OpenSourceFinale.tsx` (above the clone block) add a "Recently shipped" row: 3 items fetched at build time from GitHub Releases API (server component, `revalidate: 3600`, static fallback list). Each: version tag (mono) + title + date + link.

### P11. Prompt-chip CTA starters
- **What:** finale CTAs rendered as example prompts the visitor can click.
- **Who:** Framer ("Create personal portfolio", "Build startup site"…), Lovable/v0 (suggestion chips).
- **Why it works:** removes blank-canvas anxiety; teaches the prompt format; converts "Open the canvas" into a 2-click magic moment.
- **Sketch:** in `OpenSourceFinale.tsx` (and/or under the hero input), a `Marquee`-or-wrap row of 4 mono chips: "Design a SaaS dashboard", "Build a mobile onboarding flow", "Redesign this pricing page", "Generate a design system". Click → `/app?prompt=<encoded>` (verify app reads the param; if not, chip copies the prompt and opens `/app`). Motion: `AnimatedShinyText`-style shimmer on hover; reduced-motion: static chips.

### P12. OG / share-image strategy
- **What:** every shareable route renders a deliberate 1200×630 preview: short value prop + product visual, safe-zone centered, minimal text, < ~300 KB.
- **Who:** Lovable (`opengraph-image.png`, `summary_large_image`), Vercel/Linear (branded OG per route).
- **Why it works:** stars and users arrive through links (X, Discord, HN, Reddit); the OG image is the landing page's landing page.
- **Sketch:** add `src/app/opengraph-image.tsx` (next/og `ImageResponse`, static): dark background + brand gradient, h1 line "Design at the speed of thought", one mono chip row ("AI agent · Figma-grade canvas · AGPL-3.0"), a cropped `BrowserFrame` visual if feasible within the 1200×630 canvas (or a simple canvas-grid motif drawn with divs). Add `twitter:card="summary_large_image"`, confirm `metadataBase`. Audit title/description: description should contain "AI design canvas", "open source", "Figma for AI agents".

### P13. Motion system: choreography + reduced-motion + lenis integration
- **What:** a small, consistent motion vocabulary: entrance stagger (opacity+y, 20–40ms stagger), scroll-linked transforms only for large visuals, one marquee, one count-up, hover micro-lifts; everything behind `prefers-reduced-motion`.
- **Who:** Linear/Framer (restrained, springy, diegetic motion); WCAG 2.2.2/2.3 + web.dev guidance: wrap motion in `no-preference`, swap parallax for fades under reduce, provide pause controls for long animations.
- **Why it works:** consistency reads as craft; restraint keeps LCP/CLS clean; our repo already has exemplary reduced-motion contracts — extend, don't reinvent.
- **Sketch:** codify in landing: all section headers/paragraphs get `BlurFade`-style entrances (`whileInView` once, `viewport={{ once: true, margin: "-80px" }}`); stagger = parent `variants` + `staggerChildren: 0.06`; keep parallax amplitude ≤ 32px (existing pattern); marquee pauses on hover (`[animation-play-state]`) and under reduced-motion (already static). Lenis: anchor offsets verified via `LANDING_SECTIONS`; add `lerp` tuning only if section reveals feel disconnected from scroll.

### P14. Performance budget (LCP < 2.5s, CLS ≈ 0) with the poster-swap video rule
- **What:** explicit budgets: LCP ≤ 2.5s (p75), INP < 200ms, CLS < 0.1 (target 0); hero media ≤ ~200 KB; total above-fold transfer ≤ ~1 MB; video never the LCP element.
- **Who:** Framer prints its own CWV on the landing page; web.dev/DebugBear/Mux guidance: preload poster with `fetchpriority="high"`, `preload="none"` on video, swap in on idle/in-view.
- **Why it works:** our #1 LCP risk today is `hero-build.png` (927 KB) — a direct LCP tax; videos added naively would make it worse.
- **Sketch:** (1) re-export hero-build.png as AVIF/WebP (~100–200 KB target; 1280px + 2x via `next/image` `sizes`), `priority` + `fetchPriority="high"`; (2) all videos: `preload="none"` + poster + in-view play (P3 sketch); (3) reserve aspect-ratio boxes everywhere (`BrowserFrame` already fixed-aspect → CLS 0 by construction); (4) fonts: verify only 2 weights of Geist land above fold; (5) check with Lighthouse CI after changes; if we adopt Framer's pattern, we can literally print our own CWV in the FeatureGallery later.

### P15. Dark-theme aesthetics discipline
- **What:** near-black surfaces (not pure #000), off-white text (not pure #FFF), desaturated accents, 4.5:1 minimum body contrast, glow used as emphasis only.
- **Who:** Linear/Supabase/Cursor/Raycast (the canonical dark dev-tool aesthetic).
- **Why it works:** WCAG AA (4.5:1 body, 3:1 large) + glare avoidance; pure black/white inverts badly and reads cheap.
- **Sketch:** audit landing tokens: body text ≥ 4.5:1 on the page background; screenshots are light-mode (good contrast by construction — keep the BrowserFrame contract); brand-gradient reserved for exactly two elements per viewport (primary CTA + one accent); glow keyframes already gated behind reduced-motion — also gate on `once` so the loop doesn't run permanently.

### P16. Agent-facing onboarding (`/get-started.md`, llms.txt)
- **What:** a markdown doc at a public URL that instructs coding agents how to use/deploy the product.
- **Who:** Vercel (`/get-started.md` linked from the homepage closer: "Built by you, or your agents").
- **Why it works:** for an agent-era product, agents ARE a traffic segment; it also reinforces the product thesis on the page itself.
- **Sketch:** add `public/get-started.md` + `public/llms.txt` (repo map, `/app` entry, `.pen` format pointer, API surface); link from OpenSourceFinale's dev chips or footer. Pure static files — zero runtime cost.

---

## 3. Scoring rubric (10 dimensions, weighted, 0–5 each)

Score = Σ weight × (score ÷ 5). Use: grade any landing page (benchmarks above, competitors, ours) with the same stick.

| # | Dimension | Weight | 0 (poor) | 5 (best-in-class) |
|---|-----------|-------:|----------|--------------------|
| 1 | **Hero clarity & fold** | 15 | Vague headline, no demo, no proof | Outcome h1 + one specific proof point + product visual/input in first viewport |
| 2 | **Proof & credibility** | 15 | None | Stacked & honest: stars/logos + named quotes + hard metrics |
| 3 | **Feature storytelling** | 12 | Feature list prose | Bento/sticky-telling; every claim has a visual; demos not descriptions |
| 4 | **Conversion path & CTA hierarchy** | 12 | Many equal CTAs, dead ends | One primary action per viewport, consistent labels, repeated at finale, low-friction |
| 5 | **Copy & voice** | 10 | Feature-led, generic | Outcome-led, specific numbers, developer voice, no fluff |
| 6 | **Motion craft** | 9 | None or chaotic | Small consistent vocabulary, diegetic demos, fully reduced-motion safe |
| 7 | **Performance** | 9 | LCP > 4s, heavy media | LCP ≤ 2.5s p75, hero media ≤ ~200KB, video never LCP, CLS ≈ 0 |
| 8 | **Accessibility** | 6 | Fails contrast, motion unguarded | WCAG AA contrast, reduced-motion branches, keyboard-visible CTAs |
| 9 | **Shareability & SEO** | 6 | No OG/missing metadata | Deliberate 1200×630 OG per route, twitter card, keyword-true description |
| 10 | **Distinctiveness** | 6 | Template look | One ownable visual motif, carried consistently |

**Baseline grade of the current AgentCanvas landing** (from the shipped implementation, `src/components/landing/`):

| Dimension | Score | Weighted | Note |
|---|---:|---:|---|
| 1 Hero clarity & fold | 3.5 | 10.5 | Strong h1 + typing demo + parallax; **no proof point** in fold |
| 2 Proof & credibility | 1.5 | 4.5 | Only AGPL line; no stars/quotes/metrics/logos |
| 3 Feature storytelling | 3.5 | 8.4 | 2-card bento + scroll crossfade are good bones; thin coverage (no design systems/.pen/export visuals) |
| 4 Conversion path | 4.0 | 9.6 | Dual CTA + finale + copy button; hierarchy slightly star-biased for a try-product |
| 5 Copy & voice | 3.0 | 6.0 | "Design at the speed of thought" good; some vague lines; numbers underused |
| 6 Motion craft | 4.5 | 8.1 | Typing, marquee, parallax, crossfade, count-up; exemplary reduced-motion contracts |
| 7 Performance | 2.5 | 4.5 | 927KB hero PNG as LCP risk; videos unused; unverified CWV |
| 8 Accessibility | 4.0 | 4.8 | Reduced-motion branches tested; contrast audit pending |
| 9 Shareability & SEO | 1.5 | 1.8 | OG strategy unconfirmed |
| 10 Distinctiveness | 3.5 | 4.2 | Light-in-dark BrowserFrame motif is ownable; underleveraged |
| **Total** | | **62.4 / 100** | Weakest: proof (4.5/15), shareability (1.8/6), performance (4.5/9) |

---

## 4. Top 15 prioritized recommendations

Effort: **S** ≤ half a day · **M** 1–3 days · **L** 3+ days (single dev, includes tests per the landing AGENTS.md verification suite).

### P0 — ship first (compounding, cheap)

**R1. Embed the two product videos we already have. (P0, S)**
- *Where:* `TrustLoop.tsx` (replace static `approval-dialog.png` with `core-trust-loop.mp4` 12.1s/969KB, poster = the PNG), `MagicSequence.tsx` (step 02/03 layer: `core-agent-chat.mp4` or P4 timeline mock).
- *Why:* Notion/Cursor/Lovable all show process in motion; our core message ("describe → agent builds → you approve") is a *process* and static PNGs can't show it. Files already exist in `public/landing/`, 313–969KB (budget: 3–5MB).
- *Sketch:* P3 pattern — `preload="none"`, poster, muted/loop/playsInline, in-view play via `useInView`, reduced-motion = current static image. Verify captures are light-mode (BrowserFrame contract).

**R2. Live GitHub star count as proof furniture. (P0, S)**
- *Where:* new `GitHubStars.tsx` server component; consumed by `LandingHeader.tsx` (star chip), `Hero.tsx` (proof row), `OpenSourceFinale.tsx` (`finale-star`).
- *Why:* Supabase puts "110K GitHub stars" in nav; for OSS the star count is the single highest-trust signal; we currently show none.
- *Sketch:* fetch `api.github.com/repos/{owner}/{repo}` with `next: { revalidate: 3600 }`; format `★ 1,234`; static fallback label on failure; `REPO_URL` from `repo-url.ts`.

**R3. One specific proof point above the fold. (P0, S)**
- *Where:* `Hero.tsx` — one muted mono row under the subcopy: `★ {stars} · AGPL-3.0 · 60+ tools · 28 providers`.
- *Why:* Web Anatomy (170 heros): one specific proof directly under the headline is the highest-leverage fold element; Linear/Figma/Notion all do exactly this; we show zero proof before the scroll.
- *Sketch:* static text + `<GitHubStars />`; no marquee, no animation, 4.5:1 contrast; it must survive the reduced-motion branch untouched.

**R4. OG image + share-metadata pass. (P0, S)**
- *Where:* new `src/app/opengraph-image.tsx`; metadata in `src/app/layout.tsx`.
- *Why:* stars arrive via shared links; current OG unconfirmed — every link to `/` currently renders an uncontrolled preview. Lovable/Vercel/Linear all ship deliberate 1200×630 previews.
- *Sketch:* P12 — static `ImageResponse`: dark bg, gradient accent, h1 line, mono chip row ("AI design canvas · AGPL-3.0 · 60+ tools"), `twitter:card summary_large_image`; verify `metadataBase`; test in X/LinkedIn/Discord validators.

**R5. Hero image diet + performance guardrails. (P0, S/M)**
- *Where:* `Hero.tsx` (`hero-build.png`, 927KB → AVIF/WebP ≈ 100–200KB, `sizes`, `priority`); `next.config.ts` (formats); Lighthouse check.
- *Why:* the hero PNG is the LCP element on a 100vh hero — the one metric that gates everything else; Framer prints "LCP 1.1s" as a *feature*, we're at risk of > 3s on 4G.
- *Sketch:* re-export from the source capture at 1280/1920 widths; `next/image` with `fetchPriority="high"`; verify CLS stays 0 (fixed-aspect frame already reserves space); budget: LCP ≤ 2.5s p75 lab, hero transfer ≤ ~1MB total.

### P1 — the uplift (this quarter)

**R6. MagicSequence → 3-state scroll-telling. (P1, M)**
- *Where:* `MagicSequence.tsx`.
- *Why:* current 2-state crossfade undersells the middle of the story — the agent *working* — which is precisely what Linear/Cursor/Framer animate (P4/P8). Three beats: prompt types → agent tool-calls stream (video or `AgentTimeline` mock) → result appears.
- *Sketch:* add third motion layer + widen `useTransform` ranges; `useMotionValueEvent` drives `activeStep` for step-list highlighting; reduced-motion keeps the single final static frame.

**R7. Diegetic `AgentTimeline` mock component. (P1, M)**
- *Where:* new `src/components/landing/AgentTimeline.tsx`; used in MagicSequence state 2 and/or a FeatureGallery bento tile.
- *Why:* P4 — animated mock tool-call rows ("create_frame ✓", "apply_design_tokens ✓", "2s ago") prove autonomy better than any copy; it's the Linear-hero trick and it's pure DOM (no video weight).
- *Sketch:* 5 rows, `AnimatePresence` sequential reveal, loop ~8s, pause off-screen, static list under reduced-motion.

**R8. Bento expansion: 2 cards → 5 tiles. (P1, M)**
- *Where:* `FeatureGallery.tsx`.
- *Why:* P7 — Framer/Raycast grids; we currently bury four differentiators (design systems, .pen format, snapshots, export) in one chip row in HowItWorks.
- *Sketch:* `BentoGrid` 6-col: tooling (2-col), design-system pack picker mini-mock, `.pen` JSON snippet tile (mono), sessions+snapshots (timeline mini-mock), export (HTML/React/Tailwind code chips). Each tile: name + 1 sentence + visual + `whileHover` lift; CTA per tile → `/app`.

**R9. Honest social-proof band. (P1, M)**
- *Where:* new `SocialProof.tsx` between TrustLoop and HowItWorks (register in `LANDING_SECTIONS`).
- *Why:* P5/P6 — the page's biggest rubric hole (4.5/15). Until real testimonials exist, use what we can prove: GitHub-derived numbers (stars, forks, contributors) + "Built on" tech-logo strip (Next.js, Tailwind, Radix, Prisma, Socket.IO) + AGPL/`get-started.md` links. Add real quote cards only when sourced from GitHub Discussions/X with permission.
- *Sketch:* `Marquee` logo strip + 4 stat tiles (`NumberFlow`) + slot for future quotes. Never fabricate.

**R10. Prompt-chip CTA starters wired to the app. (P1, M)**
- *Where:* `OpenSourceFinale.tsx` (+ optional hero input row per P2).
- *Why:* P11 — Framer's finale is a prompt picker; it converts "Open the canvas" from a dead-end button into a 2-click magic moment, and teaches prompt-writing.
- *Sketch:* 4 mono chips → `/app?prompt=…` (verify/patch the app to read the param; fallback: clipboard + open). `AnimatedShinyText` shimmer on hover; static chips under reduced-motion.

**R11. CTA hierarchy cleanup. (P1, S)**
- *Where:* `LandingHeader.tsx`, `Hero.tsx`, `FeatureGallery.tsx`, `OpenSourceFinale.tsx`.
- *Why:* primary action for a try-in-browser product is "Open the canvas"; star is the secondary. Keep one gradient CTA per viewport (P15 emphasis discipline); consistent labels ("Open the canvas" everywhere, not "Get started"-style drift).
- *Sketch:* audit `hero-open`/`header-open`/bento CTAs/`finale-open` for identical label + style; star CTAs carry the live count from R2.

**R12. Dev-specific stats band upgrade. (P1, S)**
- *Where:* `HowItWorks.tsx`.
- *Why:* P9 — Stripe/Linear specificity; "20 node types" and "2,700+ tests" are more convincing to developers than adjectives; verify current real counts before shipping.
- *Sketch:* extend existing `NumberFlow` stat pair to 3–4 tiles (60+ tools · 28 providers · 20 node types · 2,700+ tests), Geist Mono labels, same mount-timer pattern.

### P2 — polish & reach

**R13. Ship-velocity strip. (P2, S)**
- *Where:* `OpenSourceFinale.tsx` above the clone block.
- *Why:* P10 — Linear/Vercel changelogs; surfaces activity OSS visitors otherwise check manually on GitHub.
- *Sketch:* build-time fetch of 3 latest GitHub Releases (`revalidate: 3600`, static fallback); tag (mono) + title + relative date.

**R14. Agent-facing onboarding docs. (P2, S)**
- *Where:* `public/get-started.md` + `public/llms.txt`; linked from finale dev chips / footer.
- *Why:* P16 — Vercel ships `/get-started.md` from the homepage; for "Figma for AI agents" it doubles as a proof of thesis.
- *Sketch:* static markdown: what AgentCanvas is, `/app` entry, `.pen` format pointer, API/MCP surfaces, sandbox notes.

**R15. Motion choreography + contrast audit. (P2, M)**
- *Where:* all six section components.
- *Why:* P13/P15 — unify entrances (staggered BlurFade on headers/copy), keep parallax ≤ 32px, gate glow loops, verify WCAG AA contrast on muted text over dark bg; consistency is what separates "has animations" from "reads as crafted".
- *Sketch:* one shared `Reveal` wrapper (variants + `staggerChildren: 0.06`, `once: true`); apply per section; axe/Lighthouse a11y pass + manual contrast spot-check; extend the existing reduced-motion unit tests for any new animated component.

### Suggested sequencing
R1–R5 (P0 week) → R6–R8 + R12 (week 2, the visible uplift) → R9–R11 (week 3) → R13–R15 (polish). Each rec touches only `src/components/landing/` (+ new small server components / `src/app` OG file) — the landing DOX (`src/components/landing/AGENTS.md`) owns all of it; any new section must be registered in `LANDING_SECTIONS` and get the standard reduced-motion + vitest treatment.

---

## 5. Sources

Benchmark sites (fetched live, Sep 2026): [linear.app](https://linear.app), [vercel.com](https://vercel.com), [cursor.com](https://cursor.com), [raycast.com](https://www.raycast.com), [supabase.com](https://supabase.com), [figma.com](https://www.figma.com), [stripe.com](https://stripe.com), [framer.com](https://www.framer.com), [notion.com](https://www.notion.com), [arc.net](https://arc.net), [lovable.dev](https://lovable.dev), [v0.app](https://v0.app) (+ [v0 docs](https://v0.dev/docs/what-is-v0)).

Trends & patterns:
- [Userpilot — 13 SaaS Landing Page Examples 2026](https://userpilot.com) · [Swipe Pages — 12 Best SaaS Landing Pages 2026](https://swipepages.com) · [Apexure — SaaS Landing Pages With Analysis](https://www.apexure.com) · [Unbounce — 27 SaaS Landing Page Examples](https://unbounce.com)
- [Web Anatomy — 170 hero sections with social proof above the fold](https://www.webanatomy.ai) · [MailerLite — 11 Social Proof Examples](https://www.mailerlite.com) · [Magic UI — Social proof patterns](https://magicui.design) · [Prismic — Hero section best practices](https://prismic.io)
- [Framer — Landing page best practices (5-second test)](https://www.framer.com)
- [SitesPlaced — Cinematic landing pages with video backgrounds (≤4MB)](https://sitesplaced.com/blog/cinematic-landing-pages-with-video-backgrounds) · [Mux — Background video & the MP4 trap](https://www.mux.com/articles/add-background-video-website-hls-performance) · [Ignite — Autoplay video 5–12s](https://www.ignite.video/en/articles/basics/autoplay-videos) · [DebugBear — LCP for video](https://www.debugbear.com) · [Aaron T. Grogg — poster-swap LCP pattern](https://aarontgrogg.com) · [Simon Hearne — preload poster](https://simonhearne.com) · [Cloudinary — autoplay do's and don'ts](https://cloudinary.com/guides/video-effects/video-autoplay-in-html)
- [Colorlib — 40+ Landing Page Statistics 2026](https://colorlib.com/wp/landing-page-statistics) · [Sender.net — Landing page statistics](https://www.sender.net/blog/landing-page-statistics) · [Digital Applied — Landing page stats 2026](https://www.digitalapplied.com/blog/landing-page-statistics-2026-conversion-data-points) · [Daydream — Average landing page conversion rate](https://www.withdaydream.com/library/insights/average-landing-page-conversion-rate) · [Unbounce Conversion Benchmark Report](https://unbounce.com/conversion-benchmark-report)
- [DiviFlash — 19 Web Design Trends 2026 (bento grids)](https://diviflash.com) · [Studio Meyer — Web Design Trends 2026 + code](https://studiomeyer.io) · [Mockuuups — Best Bento Grid Designs 2026](https://mockuuups.studio)
- [scrollytelling.ai — 27 scrollytelling examples](https://scrollytelling.ai) · [Awwwards — scroll-driven sites](https://www.awwwards.com) · [Awwwards — Sites of the Year (2025 SOTY: offbrand.studio "Made in Webflow")](https://www.awwwards.com/websites/sites_of_the_year/) · [Shorthand — 12 scroll-driven stories](https://shorthand.com)
- [Google Search Central — Core Web Vitals](https://developers.google.com/search/docs/appearance/core-web-vitals) · [ogimage.gallery — OG image specs](https://www.ogimage.gallery) · [Krumzi — OG image sizes 2026](https://www.krumzi.com) · [NoGood — Open Graph SEO](https://nogood.io)
- [web.dev — prefers-reduced-motion](https://web.dev) · [Smashing Magazine — Designing with reduced motion](https://www.smashingmagazine.com) · [W3C — CSS prefers-reduced-motion technique](https://www.w3.org) · [MDN — prefers-reduced-motion](https://developer.mozilla.org)
- [Smashing Magazine — Inclusive dark mode](https://www.smashingmagazine.com) · [UX Collective — Dark UI best practices (WCAG 4.5:1)](https://uxdesign.cc) · [atmos.style — Dark mode UI practices](https://atmos.style)
