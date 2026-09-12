# AgentCanvas Landing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the root route `/` with a dark, cinematic, scroll-narrative landing page for AgentCanvas and relocate the untouched workspace to `/app`.

**Architecture:** The landing is a single server-rendered composition (`src/app/page.tsx`) of six client sections under a forced-dark subtree, sharing one light-chrome `BrowserFrame` mockup and one repo-URL constant. Smooth scrolling comes from a `lenis/react` client wrapper that renders children bare under `prefers-reduced-motion`; below-fold sections are `next/dynamic` imports; every motion behavior uses `transform`/`opacity` only and has a static fallback.

**Tech Stack:** Next.js 16 App Router, React 19, Tailwind 4 (CSS-first), motion v12 (`motion/react`), lenis 1.3 (`lenis/react`), Magic UI primitives via the shadcn CLI, `react-type-animation`, `@number-flow/react`, `react-wrap-balancer`, Vitest 5 + Testing Library + jsdom.

**Spec:** docs/superpowers/specs/2026-09-13-landing-page-design.md

## Global Constraints

- **Stack pins**: Next.js 16 App Router (`next@^16.3.4`), React 19 (`react@^19.2.8`), Tailwind 4 CSS-first (no config-globs), Vitest 5 with jsdom + `@testing-library/react` + jest-dom (globals on, `pool: 'forks'`, setup `tests/setup.ts`).
- **Free + OSS only**: no paid services; every dependency is open source.
- **Animations: composited properties only** — `transform` + `opacity` exclusively; never animate `width`/`height`/`top`/`left`/`margin`.
- **`prefers-reduced-motion` fallbacks are mandatory** for every motion behavior: parallax off, sticky crossfade → final screenshot, marquee → static chip row, typing → full prompt, NumberFlow → final value, lenis → disabled entirely. Motion's `useReducedMotion` from `motion/react` is the single detection source.
- **Canonical repo URL**: `https://github.com/kanishka-namdeo/co-canvas` — defined exactly once in `src/components/landing/repo-url.ts` and imported everywhere (git remote is ground truth; README's clone command gets fixed in Task 10).
- **Workspace move is verbatim**: `src/app/app/page.tsx` is byte-identical to the old `src/app/page.tsx` except ONE edit — the brand block in the header becomes a `<Link href="/">`.
- **Landing components must not import workspace code** — nothing from `src/components/canvas/`, `src/components/sessions/`, `src/lib/agent/`, `src/lib/canvas/`, `src/lib/settings/`, `src/lib/sessions/`, or hooks. Allowed: `next/*`, `motion/react`, `lenis/react`, `lucide-react`, `react` + the micro-libs, the Magic UI files in `src/components/ui/`, and `@/lib/utils` (`cn()`).
- **Design tokens**: reuse `--ac-*` tokens + the `.ac-brand-gradient` utility from `src/app/globals.css` (brand = violet `oklch(0.606 0.25 292.717)` → fuchsia `oklch(0.667 0.295 327.153)`, defined at `globals.css:243-245`, utility at `globals.css:490`). Never introduce a parallel token system, never raw `from-violet-500 to-fuchsia-500`.
- **Dark-first landing**: the landing root div carries `className="dark"` — globals.css redefines every `--ac-*` + shadcn token under a `.dark` ancestor (`globals.css:96` and `globals.css:254`), so the landing subtree is dark regardless of the visitor's workspace theme preference. No theme toggle on the landing.
- **No CLS**: every `next/image` carries explicit `width`/`height` (or is `object-cover` inside a fixed-aspect frame); every frame viewport has an explicit CSS `aspect-ratio`.
- **Verified library import facts** (do not re-research):
  - `motion@12` (resolves 12.43.0; spec pins v12 — latest 13.x exists but is NOT used): `import { motion, useScroll, useTransform, useReducedMotion } from "motion/react"` (subpath `./react` confirmed in the package exports map).
  - `lenis` 1.3.26: `import { ReactLenis, useLenis } from 'lenis/react'` (both exports confirmed in `dist/lenis-react.d.ts`) + `import 'lenis/dist/lenis.css'` (file confirmed in the package). Usage: `<ReactLenis root options={{ lerp: 0.1, smoothWheel: true }}>`.
  - `@number-flow/react` 0.6.2 (NOT `number-flow-react` — that package does not exist on npm; the spec's dep name is a typo this plan corrects): `import NumberFlow from '@number-flow/react'`, peers `react ^18 || ^19`.
  - `react-type-animation` 3.2.0: `import TypeAnimation from 'react-type-animation'` (default export), peers `react >= 15` — React 19 safe.
  - `react-wrap-balancer` 1.1.1: `import Balancer from 'react-wrap-balancer'` (default export); peer range says `^18` but `bun add` resolves cleanly under React 19 (verified: exit 0).
  - Magic UI registry URLs (all five verified live, each installs a `registry:ui` file into `src/components/ui/` via this repo's `components.json` aliases): `https://magicui.design/r/marquee.json`, `.../bento-grid.json` (extra dep `@radix-ui/react-icons` + registry dep `button`), `.../border-beam.json`, `.../blur-fade.json`, `.../scroll-progress.json` (border-beam/blur-fade/scroll-progress each declare `motion` as a dependency — the CLI installs latest, so Task 1 re-pins `motion@12` afterwards).
- **Source screenshot dimensions** (verified with sharp; use these exact numbers in `next/image` props):
  - `public/landing/hero-build.png` — 3840×2400 (16:10)
  - `public/landing/dashboard-complete.png` — 1280×577 (~2.22:1)
  - `public/landing/attention-heatmap.png` — 1280×577 (~2.22:1)
  - `public/landing/approval-dialog.png` — 1600×1000 (16:10)
- **Package manager: bun** (`bun.lock` present, bun 1.4.2 on this machine; all package.json scripts assume bun). Use `bun add`, `bun run test`, `bunx tsx`.
- **Section ids (stable, header anchors match)**: `top` (hero), `magic`, `tool`, `trust`, `how-it-works`, `open-source`.
- **Commit style** (from recent git log): conventional commits, lowercase, scoped — `feat(scope): …`, `fix(scope): …`, `docs: …`, `chore: …`.
- **Sandbox**: dev server on `:3000` only — NEVER `bun run build` / `next start` in the z.ai sandbox (CI/dev machines build normally). Windows dev: `bun run dev` directly (the shell launchers use Linux-only utilities).
- **Per-task TDD loop**: write the failing test → run it and confirm the expected failure → implement → run again and confirm green → commit. Run a single file with `bun run test tests/unit/<file>` (vitest accepts a path filter).

---

## File Structure

| File | Responsibility |
|------|----------------|
| `public/landing/` | 6 copied media assets (4 PNG screenshots + 2 optional MP4 b-roll clips) |
| `src/components/ui/marquee.tsx`, `bento-grid.tsx`, `border-beam.tsx`, `blur-fade.tsx`, `scroll-progress.tsx` | Magic UI primitives installed via the shadcn CLI |
| `src/app/app/page.tsx` | The workspace, moved verbatim from `src/app/page.tsx` (only edit: brand links to `/`) |
| `src/components/landing/repo-url.ts` | The canonical repo URL constants |
| `src/components/landing/BrowserFrame.tsx` | Shared light-chrome browser mockup with fixed-aspect viewport + bottom-crop treatment |
| `src/components/landing/LandingHeader.tsx` | Logo, anchor nav, GitHub star link, "Open the canvas" CTA |
| `src/components/landing/LandingFooter.tsx` | Minimal footer: logo, AGPL-3.0 line, GitHub link |
| `src/components/landing/Hero.tsx` | 100vh opener (§5.1) |
| `src/components/landing/MagicSequence.tsx` | Sticky scroll crossfade sequence (§5.2) |
| `src/components/landing/FeatureGallery.tsx` | Bento grid + full-width parallax band (§5.3) |
| `src/components/landing/TrustLoop.tsx` | Approval demo + 4 copy bullets (§5.4) |
| `src/components/landing/HowItWorks.tsx` | CSS/flex architecture diagram + animated stats (§5.5) |
| `src/components/landing/OpenSourceFinale.tsx` | Clone command + star + final CTA (§5.6) |
| `src/components/landing/SmoothScroll.tsx` | lenis wrapper that disables itself under reduced motion |
| `src/app/page.tsx` | NEW landing composition: metadata + section ids + dynamic imports + ScrollProgress |
| `src/app/opengraph-image.tsx` | `next/og` OG image (1200×630) |
| `scripts/screenshot-landing.ts` | Playwright visual-verification script (desktop + mobile + reduced-motion) |
| `tests/unit/landing-assets.test.ts` | Task 1: assets exist + deps declared |
| `tests/unit/landing-routes.test.ts` | Task 2: workspace at `/app`, verbatim, logo link |
| `tests/unit/landing-primitives.test.tsx` | Task 3: repo URL, BrowserFrame, header, footer |
| `tests/unit/landing-hero.test.tsx` | Task 4: hero |
| `tests/unit/landing-magic-sequence.test.tsx` | Task 5: MagicSequence |
| `tests/unit/landing-gallery-trust.test.tsx` | Task 6: FeatureGallery + TrustLoop |
| `tests/unit/landing-how-it-works-finale.test.tsx` | Task 7: HowItWorks + OpenSourceFinale |
| `tests/unit/landing-page.test.tsx` | Task 8: shell composition + metadata |
| `tests/unit/landing-og-image.test.ts` | Task 9: OG image exports |
| `tests/setup.ts` | Task 3 adds an IntersectionObserver stub (jsdom lacks it; motion `whileInView` needs it) |

---

### Task 1: Dependencies, media assets, and Magic UI primitives

**Files:**
- Modify: `package.json` (new deps via bun)
- Create: `public/landing/` (6 copied assets)
- Create (via CLI): `src/components/ui/marquee.tsx`, `bento-grid.tsx`, `border-beam.tsx`, `blur-fade.tsx`, `scroll-progress.tsx`
- Modify: `src/app/globals.css` (the shadcn CLI appends marquee/border-beam keyframes + cssVars)
- Test: `tests/unit/landing-assets.test.ts`

**Interfaces:**
- Produces: the dependency set + assets every later task consumes.
- `bento-grid.tsx` additionally pulls in `@radix-ui/react-icons` (CLI-managed).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/landing-assets.test.ts`:

```typescript
// Task 1 of the landing-page plan — asset + dependency contract.
// Everything the landing page consumes must exist on disk and in
// package.json before any component code lands.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();

const LANDING_ASSETS = [
  'public/landing/hero-build.png',
  'public/landing/dashboard-complete.png',
  'public/landing/attention-heatmap.png',
  'public/landing/approval-dialog.png',
  'public/landing/core-agent-chat.mp4',
  'public/landing/core-trust-loop.mp4',
];

const LANDING_DEPS = [
  'motion',
  'lenis',
  'react-type-animation',
  '@number-flow/react',
  'react-wrap-balancer',
];

const MAGIC_UI_FILES = [
  'src/components/ui/marquee.tsx',
  'src/components/ui/bento-grid.tsx',
  'src/components/ui/border-beam.tsx',
  'src/components/ui/blur-fade.tsx',
  'src/components/ui/scroll-progress.tsx',
];

describe('landing: assets and dependencies', () => {
  it.each(LANDING_ASSETS)('has %s', (asset) => {
    expect(existsSync(resolve(ROOT, asset)), `${asset} must exist`).toBe(true);
  });

  it('declares every landing dependency in package.json', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    for (const dep of LANDING_DEPS) {
      expect(pkg.dependencies[dep], `dependencies["${dep}"]`).toBeTruthy();
    }
  });

  it('pins motion to the v12 line (spec decision)', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies['motion']).toMatch(/^\^?12\./);
  });

  it('installs the five Magic UI primitives', () => {
    for (const file of MAGIC_UI_FILES) {
      expect(existsSync(resolve(ROOT, file)), `${file} must exist`).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test tests/unit/landing-assets.test.ts`
Expected: FAIL — every asset/deps/Magic-UI assertion fails (nothing installed or copied yet).

- [ ] **Step 3: Install the dependencies with bun**

```bash
bun add motion@12 lenis react-type-animation @number-flow/react react-wrap-balancer
```

Expected: installs `motion@12.x` (12.43.0 line), `lenis@1.3.x`, `react-type-animation@3.x`, `@number-flow/react@0.6.x`, `react-wrap-balancer@1.1.1`. A peer-dependency note about `react-wrap-balancer` wanting `^18` is expected and harmless — bun resolves it (verified exit 0 under React 19).

- [ ] **Step 4: Copy the six media assets (exact sources verified present in the repo)**

Note: the two MP4s are the spec §6 "optional motion b-roll" — no section component references them yet; they ship because the spec's asset manifest lists them, and a later pass may use them or drop them. The four PNGs are load-bearing.

```bash
mkdir -p public/landing
cp download/agent-ui-tests/07-hero-section.png public/landing/hero-build.png
cp download/dashboard-demo/05b-dashboard-full.png public/landing/dashboard-complete.png
cp download/dashboard-demo/08-dashboard-zoomed-out.png public/landing/attention-heatmap.png
cp download/agent-chat-trust/05-approval-dialog.png public/landing/approval-dialog.png
cp download/video-demos/core-agent-chat_dist.mp4 public/landing/core-agent-chat.mp4
cp download/video-demos/core-trust-loop_dist.mp4 public/landing/core-trust-loop.mp4
```

- [ ] **Step 5: Install the five Magic UI primitives via the shadcn CLI**

`components.json` exists at the repo root (`ui` alias → `@/components/ui`, css → `src/app/globals.css`), so the CLI writes into `src/components/ui/` and appends keyframes to globals.css. Run all five:

```bash
npx shadcn@latest add -y "https://magicui.design/r/marquee.json"
npx shadcn@latest add -y "https://magicui.design/r/bento-grid.json"
npx shadcn@latest add -y "https://magicui.design/r/border-beam.json"
npx shadcn@latest add -y "https://magicui.design/r/blur-fade.json"
npx shadcn@latest add -y "https://magicui.design/r/scroll-progress.json"
```

Notes:
- `bento-grid.json` declares the dependency `@radix-ui/react-icons` and the registry dependency `button` (already present) — the CLI installs the icon package automatically.
- `border-beam`, `blur-fade`, and `scroll-progress` each declare `motion` as a dependency, so the CLI may bump it to latest v13. **Re-pin motion to the spec decision:**

```bash
bun add motion@12
grep '"motion"' package.json
```

Expected: `"motion": "^12.43.0"` (or another `^12.x`).

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun run test tests/unit/landing-assets.test.ts`
Expected: PASS (all 12 assertions across the 4 tests).

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lock public/landing src/components/ui/marquee.tsx src/components/ui/bento-grid.tsx src/components/ui/border-beam.tsx src/components/ui/blur-fade.tsx src/components/ui/scroll-progress.tsx src/app/globals.css tests/unit/landing-assets.test.ts
git commit -m "chore(landing): add landing deps, media assets, and Magic UI primitives"
```

---

### Task 2: Workspace route move (`/` → `/app`)

**Files:**
- Move: `src/app/page.tsx` → `src/app/app/page.tsx` (verbatim, one edit)
- Test: `tests/unit/landing-routes.test.ts`

**Interfaces:**
- Produces: `/app` serves the workspace; `/` returns 404 until Task 8 lands the landing page.
- The moved file is a `'use client'` component — it exports NO metadata, so the move has no metadata implications. (The root `layout.tsx` metadata continues to apply.)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/landing-routes.test.ts`:

```typescript
// Task 2 of the landing-page plan — route-move contract.
// The workspace must live at src/app/app/page.tsx, be a verbatim copy of the
// old src/app/page.tsx (same client component, same 3-column tabbed layout),
// and carry exactly one functional edit: the brand block links back to /.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();

function workspaceSource(): string {
  return readFileSync(resolve(ROOT, 'src/app/app/page.tsx'), 'utf8');
}

describe('landing: workspace route move', () => {
  it('serves the workspace from src/app/app/page.tsx', () => {
    expect(existsSync(resolve(ROOT, 'src/app/app/page.tsx'))).toBe(true);
  });

  it('is still the verbatim workspace — client component with the tabbed 3-column layout', () => {
    const source = workspaceSource();
    expect(source.startsWith("'use client'")).toBe(true);
    // Body markers from the moved file (present in the original verbatim).
    expect(source).toContain('ResizablePanelGroup');
    expect(source).toContain('<LeftTabbedPanel');
    expect(source).toContain('<RightToolsPanel');
    expect(source).toContain('<Canvas');
  });

  it('does not export metadata (it is a client component — layout metadata applies)', () => {
    const source = workspaceSource();
    expect(source).not.toContain('export const metadata');
    expect(source).not.toContain('generateMetadata');
  });

  it('links the workspace brand back to the landing page', () => {
    const source = workspaceSource();
    expect(source).toContain("import Link from 'next/link'");
    expect(source).toContain('href="/"');
    // The link wraps the brand mark.
    expect(source).toMatch(/<Link href="\/"[\s\S]*AgentCanvas<\/span>\s*<\/Link>/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test tests/unit/landing-routes.test.ts`
Expected: FAIL — `src/app/app/page.tsx` does not exist yet.

- [ ] **Step 3: Move the file**

`git mv` works in Git Bash on Windows:

```bash
mkdir -p src/app/app
git mv src/app/page.tsx src/app/app/page.tsx
```

- [ ] **Step 4: Make the ONE allowed edit — the brand block links to `/`**

In `src/app/app/page.tsx`:

4a. Add the Link import. Find this exact line near the top (line 4 of the file):

```tsx
import dynamic from 'next/dynamic';
```

Add directly below it:

```tsx
import Link from 'next/link';
```

4b. Wrap the brand block in a link. Find this exact block in the app-header section (it sits inside `<header className="flex flex-wrap items-center justify-between px-3 h-11 …">`, under the `{/* Left: app menu + brand */}` comment — around line 1108 of the original file):

```tsx
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-md ac-brand-gradient flex items-center justify-center shadow-sm">
                <PenTool className="h-3.5 w-3.5 text-white" />
              </div>
              <span className="font-semibold text-[13px] tracking-tight ac-text-1 hidden sm:inline">AgentCanvas</span>
            </div>
```

Replace it with:

```tsx
            <Link href="/" className="flex items-center gap-2" aria-label="AgentCanvas home — back to the landing page">
              <div className="w-6 h-6 rounded-md ac-brand-gradient flex items-center justify-center shadow-sm">
                <PenTool className="h-3.5 w-3.5 text-white" />
              </div>
              <span className="font-semibold text-[13px] tracking-tight ac-text-1 hidden sm:inline">AgentCanvas</span>
            </Link>
```

Nothing else in the file changes — this is the only functional edit the spec allows (§3).

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun run test tests/unit/landing-routes.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Sanity-check the moved workspace still typechecks**

Run: `bunx tsc --noEmit`
Expected: no errors (the move + one edit must not break anything; note the OLD `src/app/page.tsx` is gone, so `/` 404s until Task 8 — expected).

- [ ] **Step 7: Commit**

```bash
git add src/app/app/page.tsx tests/unit/landing-routes.test.ts
git commit -m "feat(app): relocate the workspace to /app with the brand linking back to the landing"
```

---

### Task 3: Shared landing primitives (repo URL, BrowserFrame, header, footer)

**Files:**
- Create: `src/components/landing/repo-url.ts`
- Create: `src/components/landing/BrowserFrame.tsx`
- Create: `src/components/landing/LandingHeader.tsx`
- Create: `src/components/landing/LandingFooter.tsx`
- Modify: `tests/setup.ts` (IntersectionObserver stub)
- Test: `tests/unit/landing-primitives.test.tsx`

**Interfaces:**
- `REPO_URL = "https://github.com/kanishka-namdeo/co-canvas"`, `REPO_CLONE_URL = REPO_URL + ".git"` — the ONLY place the URL literal appears.
- `BrowserFrame` props: `children`, `className?`, `aspectRatio?` (CSS `aspect-ratio` value, default `"16 / 10"`), `crop?: 'bottom' | 'none'` (default `'none'`). `crop="bottom"` renders a light fade over the viewport's bottom edge — pair it with `object-cover object-top` on the child image so source-screenshot artifacts that sit at the bottom (the "202 Issues" toast) fall outside the visible crop (spec §6). Renders `data-testid="browser-frame"` + `data-crop`.
- `LANDING_SECTIONS` exported from `LandingHeader.tsx` — the single source of header anchor ids: `magic`, `tool`, `trust`, `how-it-works`, `open-source`.
- `LandingHeader` is `'use client'` (it uses `useLenis` from `lenis/react` for smooth anchor scrolling; when rendered without a lenis provider — reduced-motion path — `useLenis()` returns `null` and the handler does NOT preventDefault, so native anchor scrolling applies). `LandingFooter` is a server-safe component (no hooks).

- [ ] **Step 1: Add the IntersectionObserver stub to the test setup**

In `tests/setup.ts`, append to the end of the file (after the SVGElement block):

```typescript
// IntersectionObserver — motion's whileInView (Magic UI BlurFade etc.) needs
// it and jsdom doesn't implement it. The stub fires the callback immediately
// with isIntersecting: true so in-view content renders visible in tests.
// (Only defined when missing — production code is unaffected.)
if (!globalThis.IntersectionObserver) {
  globalThis.IntersectionObserver = class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element) {
      const entry = { isIntersecting: true, target } as unknown as IntersectionObserverEntry;
      this.callback([entry], this as unknown as IntersectionObserver);
    }
    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/unit/landing-primitives.test.tsx`:

```tsx
// Task 3 of the landing-page plan — shared landing primitives.
// Covers the repo-URL constants, the BrowserFrame crop contract, the header
// anchors/CTAs, and the footer. next/image is mocked to a plain <img> so
// alt/src assertions are direct (house suite has no next/image precedent).

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { REPO_URL, REPO_CLONE_URL } from '@/components/landing/repo-url';
import { BrowserFrame } from '@/components/landing/BrowserFrame';
import { LandingHeader, LANDING_SECTIONS } from '@/components/landing/LandingHeader';
import { LandingFooter } from '@/components/landing/LandingFooter';

vi.mock('next/image', () => ({
  default: (props: {
    src: string | { src: string };
    alt: string;
    width?: number;
    height?: number;
    className?: string;
  }) => {
    const src = typeof props.src === 'string' ? props.src : props.src.src;
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={props.alt} width={props.width} height={props.height} className={props.className} />;
  },
}));

// LandingHeader reads useLenis() — without a lenis provider (reduced-motion
// path) it returns null and anchor clicks fall back to native scrolling.
vi.mock('lenis/react', () => ({
  ReactLenis: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useLenis: () => null,
}));

describe('landing: repo-url constants', () => {
  it('defines the canonical repo URL exactly once', () => {
    expect(REPO_URL).toBe('https://github.com/kanishka-namdeo/co-canvas');
    expect(REPO_CLONE_URL).toBe('https://github.com/kanishka-namdeo/co-canvas.git');
  });
});

describe('landing: BrowserFrame', () => {
  it('renders a light-chrome frame with the default 16 / 10 viewport', () => {
    render(
      <BrowserFrame>
        <img src="/landing/hero-build.png" alt="demo screenshot" />
      </BrowserFrame>,
    );
    const frame = screen.getByTestId('browser-frame');
    expect(frame).toBeInTheDocument();
    expect(frame.getAttribute('data-crop')).toBe('none');
    const viewport = frame.lastElementChild as HTMLElement;
    expect(viewport.style.aspectRatio).toBe('16 / 10');
    expect(screen.getByAltText('demo screenshot')).toBeInTheDocument();
  });

  it('supports the bottom-crop treatment (spec §6 toast artifact)', () => {
    render(
      <BrowserFrame aspectRatio="4 / 3" crop="bottom">
        <img src="/landing/dashboard-complete.png" alt="cropped screenshot" />
      </BrowserFrame>,
    );
    const frame = screen.getByTestId('browser-frame');
    expect(frame.getAttribute('data-crop')).toBe('bottom');
    const viewport = frame.lastElementChild as HTMLElement;
    expect(viewport.style.aspectRatio).toBe('4 / 3');
    // The light bottom fade that blends the cropped edge.
    expect(viewport.lastElementChild).toHaveAttribute('aria-hidden', 'true');
  });

  it('applies a passthrough className', () => {
    render(
      <BrowserFrame className="mt-8 w-full max-w-4xl">
        <img src="/x.png" alt="frame" />
      </BrowserFrame>,
    );
    expect(screen.getByTestId('browser-frame')).toHaveClass('mt-8');
  });
});

describe('landing: LandingHeader', () => {
  it('renders the logo, section anchors, star link, and /app CTA', () => {
    render(<LandingHeader />);
    expect(screen.getByAltText('AgentCanvas logo')).toBeInTheDocument();
    for (const section of LANDING_SECTIONS) {
      expect(screen.getByRole('link', { name: section.label })).toHaveAttribute('href', `#${section.id}`);
    }
    expect(screen.getByTestId('header-star')).toHaveAttribute('href', REPO_URL);
    expect(screen.getByTestId('header-open')).toHaveAttribute('href', '/app');
  });

  it('anchors exactly to the five below-hero section ids', () => {
    expect(LANDING_SECTIONS.map((s) => s.id)).toEqual([
      'magic',
      'tool',
      'trust',
      'how-it-works',
      'open-source',
    ]);
  });
});

describe('landing: LandingFooter', () => {
  it('renders the logo, AGPL-3.0 line, and GitHub link', () => {
    render(<LandingFooter />);
    expect(screen.getByAltText('AgentCanvas logo')).toBeInTheDocument();
    expect(screen.getByText(/AGPL-3\.0/)).toBeInTheDocument();
    expect(screen.getByTestId('footer-github')).toHaveAttribute('href', REPO_URL);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun run test tests/unit/landing-primitives.test.tsx`
Expected: FAIL — cannot resolve `@/components/landing/repo-url` (module not found).

- [ ] **Step 4: Create `src/components/landing/repo-url.ts`**

```typescript
// The canonical repo URL — single source of truth (spec §3).
// git remote is ground truth: https://github.com/kanishka-namdeo/co-canvas

export const REPO_URL = "https://github.com/kanishka-namdeo/co-canvas";

export const REPO_CLONE_URL = `${REPO_URL}.git`;
```

- [ ] **Step 5: Create `src/components/landing/BrowserFrame.tsx`**

```tsx
'use client';

import type { ReactNode } from 'react';

export interface BrowserFrameProps {
  /** Frame contents — usually a next/image screenshot (see the sections). */
  children: ReactNode;
  /** Passthrough classes for the outer frame (width/margins). */
  className?: string;
  /** CSS aspect-ratio of the viewport area; the child is clipped to it.
   * Default "16 / 10". Use a NARROWER ratio than the source screenshot's
   * (e.g. "4 / 3" for the 2.22:1 dashboard shots) together with
   * crop="bottom" + object-cover object-top to cut the bottom edge. */
  aspectRatio?: string;
  /** 'bottom' overlays a light fade over the viewport's bottom edge so the
   * cropped edge reads as intentional (spec §6: artifacts are cropped in
   * CSS, never edited out of the source screenshots). */
  crop?: 'bottom' | 'none';
}

/**
 * Light-chrome browser mockup — the shared screenshot frame for the landing
 * (spec §6 light-on-dark contract). All screenshots are light-mode while the
 * landing is dark, so every screenshot is framed inside this LIGHT chrome +
 * light page background and never pasted raw onto the dark page.
 */
export function BrowserFrame({
  children,
  className = '',
  aspectRatio = '16 / 10',
  crop = 'none',
}: BrowserFrameProps) {
  return (
    <div
      data-testid="browser-frame"
      data-crop={crop}
      className={`overflow-hidden rounded-xl border border-white/10 bg-white shadow-2xl ${className}`}
    >
      {/* Light chrome bar — three traffic lights + a light address strip. */}
      <div aria-hidden="true" className="flex items-center gap-1.5 bg-[#e2e8f0] px-3 py-2">
        <span className="h-2.5 w-2.5 rounded-full bg-[#f87171]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#fbbf24]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#34d399]" />
        <span className="ml-2 h-4 flex-1 rounded bg-white/70" />
      </div>
      {/* Fixed-aspect viewport — overflow-hidden does the CSS crop (no CLS:
          the box keeps its shape regardless of child load state). */}
      <div className="relative w-full overflow-hidden bg-white" style={{ aspectRatio }}>
        {children}
        {crop === 'bottom' && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-b from-transparent to-white"
          />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Create `src/components/landing/LandingHeader.tsx`**

```tsx
'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useLenis } from 'lenis/react';
import { Star } from 'lucide-react';
import { REPO_URL } from './repo-url';

/** The five below-hero narrative beats — header anchors must match the
 * section ids rendered by the section components (spec §5.7). */
export const LANDING_SECTIONS = [
  { id: 'magic', label: 'The Magic' },
  { id: 'tool', label: 'The Tool' },
  { id: 'trust', label: 'Trust' },
  { id: 'how-it-works', label: 'How It Works' },
  { id: 'open-source', label: 'Open Source' },
] as const;

/** Fixed/absolute header over the hero (spec §5.7). Smooth anchor scrolling
 * goes through lenis when it is active; under prefers-reduced-motion no
 * provider exists, useLenis() returns null, and clicks fall through to
 * native anchor scrolling. */
export function LandingHeader() {
  const lenis = useLenis();

  const handleAnchorClick = (event: React.MouseEvent<HTMLAnchorElement>, hash: string) => {
    if (!lenis) return; // reduced motion → native anchor scroll
    event.preventDefault();
    lenis.scrollTo(hash, { offset: -72 });
  };

  return (
    <header data-testid="landing-header" className="absolute inset-x-0 top-0 z-40">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link href="/" className="flex items-center gap-2" aria-label="AgentCanvas home">
          <Image src="/logo.svg" alt="AgentCanvas logo" width={24} height={24} />
          <span className="text-sm font-semibold text-white">AgentCanvas</span>
        </Link>

        <nav aria-label="Landing sections" className="hidden items-center gap-6 md:flex">
          {LANDING_SECTIONS.map((section) => (
            <a
              key={section.id}
              href={`#${section.id}`}
              onClick={(event) => handleAnchorClick(event, `#${section.id}`)}
              className="text-sm text-white/70 transition-colors hover:text-white"
            >
              {section.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-3">
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="header-star"
            className="inline-flex items-center gap-1.5 rounded-full border border-white/20 px-3 py-1.5 text-xs font-medium text-white/80 transition-colors hover:bg-white/10"
          >
            <Star className="h-3.5 w-3.5" aria-hidden="true" />
            Star
          </a>
          <Link
            href="/app"
            data-testid="header-open"
            className="ac-brand-gradient inline-flex items-center rounded-full px-4 py-1.5 text-xs font-semibold text-white shadow-lg"
          >
            Open the canvas
          </Link>
        </div>
      </div>
    </header>
  );
}
```

- [ ] **Step 7: Create `src/components/landing/LandingFooter.tsx`**

```tsx
import Image from 'next/image';
import Link from 'next/link';
import { REPO_URL } from './repo-url';

/** Minimal footer — logo, AGPL-3.0 line, GitHub link. No link farm (§5.7). */
export function LandingFooter() {
  return (
    <footer data-testid="landing-footer" className="border-t border-white/10 py-10">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-3 px-6 text-center text-sm text-white/60">
        <Link href="/" className="flex items-center gap-2" aria-label="AgentCanvas home">
          <Image src="/logo.svg" alt="AgentCanvas logo" width={20} height={20} />
          <span className="font-semibold text-white">AgentCanvas</span>
        </Link>
        <p>Released under the AGPL-3.0 license. Free and open source, forever.</p>
        <a
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="footer-github"
          className="underline-offset-4 transition-colors hover:text-white hover:underline"
        >
          github.com/kanishka-namdeo/co-canvas
        </a>
      </div>
    </footer>
  );
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `bun run test tests/unit/landing-primitives.test.tsx`
Expected: PASS (10 tests).

- [ ] **Step 9: Run the full suite to confirm the setup.ts stub breaks nothing**

Run: `bun run test`
Expected: existing suite still green (the stub only defines `IntersectionObserver` when missing — nothing in the current suite uses it).

- [ ] **Step 10: Commit**

```bash
git add src/components/landing/repo-url.ts src/components/landing/BrowserFrame.tsx src/components/landing/LandingHeader.tsx src/components/landing/LandingFooter.tsx tests/setup.ts tests/unit/landing-primitives.test.tsx
git commit -m "feat(landing): shared primitives — repo URL, BrowserFrame, header, footer"
```

---

### Task 4: Hero (§5.1)

**Files:**
- Create: `src/components/landing/Hero.tsx`
- Test: `tests/unit/landing-hero.test.tsx`

**Interfaces:**
- Renders `<section id="top" data-testid="section-hero">`, `<h1>` "Design at the speed of thought" (the page's ONLY h1), subline "The open-source canvas where the AI agents do the drawing — and you direct.", a typing prompt line, dual CTAs (`data-testid="hero-star"` → `REPO_URL`, `data-testid="hero-open"` → `/app`), a tool-call chip marquee (`data-testid="hero-chips"`), a gradient glow, and the hero-build screenshot in a `BrowserFrame` with scroll parallax.
- Reduced motion: no parallax transform, no glow keyframes, chips render as a static row (`data-testid="hero-chips-static"`), typing renders the full prompt as static text (`data-testid="hero-typing-static"`).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/landing-hero.test.tsx`:

```tsx
// Task 4 of the landing-page plan — the Hero (spec §5.1).
// Every landing test file uses the same two module mocks:
//   1. next/image → plain <img> (direct src/alt assertions)
//   2. motion/react's useReducedMotion → controllable vi.fn
// restoreMocks resets the mock after each test, so beforeEach re-arms the
// default (reduced = false).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useReducedMotion } from 'motion/react';
import { REPO_URL } from '@/components/landing/repo-url';
import { Hero } from '@/components/landing/Hero';

vi.mock('next/image', () => ({
  default: (props: {
    src: string | { src: string };
    alt: string;
    width?: number;
    height?: number;
    className?: string;
    priority?: boolean;
  }) => {
    const src = typeof props.src === 'string' ? props.src : props.src.src;
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={props.alt} width={props.width} height={props.height} className={props.className} />;
  },
}));

vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return { ...actual, useReducedMotion: vi.fn(() => false) };
});

const useReducedMotionMock = vi.mocked(useReducedMotion);

beforeEach(() => {
  useReducedMotionMock.mockReturnValue(false);
});

describe('landing: Hero', () => {
  it('renders the headline, subline, and section anchor', () => {
    render(<Hero />);
    expect(screen.getByRole('heading', { level: 1, name: 'Design at the speed of thought' })).toBeInTheDocument();
    expect(screen.getByText(/The open-source canvas where the AI agents do the drawing/)).toBeInTheDocument();
    expect(screen.getByTestId('section-hero')).toHaveAttribute('id', 'top');
  });

  it('renders the dual CTAs with the right destinations', () => {
    render(<Hero />);
    expect(screen.getByTestId('hero-star')).toHaveAttribute('href', REPO_URL);
    expect(screen.getByTestId('hero-open')).toHaveAttribute('href', '/app');
  });

  it('shows the hero-build screenshot with alt text at the real 3840x2400 dims', () => {
    render(<Hero />);
    const img = screen.getByAltText('AgentCanvas building a hero section live on the canvas');
    expect(img).toHaveAttribute('src', '/landing/hero-build.png');
    expect(img).toHaveAttribute('width', '3840');
    expect(img).toHaveAttribute('height', '2400');
  });

  it('renders the tool-call chip marquee', () => {
    render(<Hero />);
    expect(screen.getByTestId('hero-chips')).toBeInTheDocument();
    expect(screen.getByText('pen_create_frame()')).toBeInTheDocument();
  });

  it('renders the typing prompt line', () => {
    render(<Hero />);
    expect(screen.getByTestId('hero-typing')).toBeInTheDocument();
  });

  describe('reduced motion', () => {
    beforeEach(() => {
      useReducedMotionMock.mockReturnValue(true);
    });

    it('renders the full prompt statically instead of the typing effect', () => {
      render(<Hero />);
      expect(screen.getByTestId('hero-typing-static')).toHaveTextContent(
        'Design a mobile login screen with social sign-in…',
      );
      expect(screen.queryByTestId('hero-typing')).not.toBeInTheDocument();
    });

    it('renders a static chip row instead of the marquee', () => {
      render(<Hero />);
      expect(screen.getByTestId('hero-chips-static')).toBeInTheDocument();
      expect(screen.queryByTestId('hero-chips')).not.toBeInTheDocument();
      expect(screen.getByText('pen_create_frame()')).toBeInTheDocument();
    });

    it('still renders the screenshot and both CTAs', () => {
      render(<Hero />);
      expect(screen.getByAltText('AgentCanvas building a hero section live on the canvas')).toBeInTheDocument();
      expect(screen.getByTestId('hero-star')).toHaveAttribute('href', REPO_URL);
      expect(screen.getByTestId('hero-open')).toHaveAttribute('href', '/app');
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test tests/unit/landing-hero.test.tsx`
Expected: FAIL — cannot resolve `@/components/landing/Hero`.

- [ ] **Step 3: Create `src/components/landing/Hero.tsx`**

```tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import Balancer from 'react-wrap-balancer';
import TypeAnimation from 'react-type-animation';
import { motion, useScroll, useTransform, useReducedMotion } from 'motion/react';
import { ArrowRight, Star } from 'lucide-react';
import { Marquee } from '@/components/ui/marquee';
import { BrowserFrame } from './BrowserFrame';
import { REPO_URL } from './repo-url';

/** The typed sample prompt (spec §5.1 — a real, representative prompt). */
const TYPED_PROMPT = 'Design a mobile login screen with social sign-in…';

/** Drifting tool-call chips — real tool names from the agent surface. */
const TOOL_CALLS = [
  'pen_create_frame',
  'pen_set_gradient',
  'bulk_update',
  'pen_create_text',
  'set_constraints',
  'pen_insert_html',
  'pen_bake_layout',
  'add_variant',
] as const;

function ToolCallChip({ tool }: { tool: string }) {
  return (
    <span className="mx-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/70 [font-family:var(--font-geist-mono),monospace]">
      {tool}()
    </span>
  );
}

/** Breakpoint guard — spec §10: no parallax on small screens. */
function useIsNarrow() {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 767px)');
    const update = () => setNarrow(mediaQuery.matches);
    update();
    mediaQuery.addEventListener('change', update);
    return () => mediaQuery.removeEventListener('change', update);
  }, []);
  return narrow;
}

/** 100vh cinematic opener (spec §5.1). */
export function Hero() {
  const shouldReduceMotion = useReducedMotion();
  const isNarrow = useIsNarrow();
  const applyParallax = !shouldReduceMotion && !isNarrow;

  // Scroll parallax on the browser mockup — scrollYProgress drives a
  // transform-only translateY (composited, spec §10).
  const frameRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: frameRef,
    offset: ['start end', 'end start'],
  });
  const frameY = useTransform(scrollYProgress, [0, 1], [0, 72]);

  return (
    <section
      id="top"
      data-testid="section-hero"
      className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-6 pb-16 pt-28 text-center"
    >
      {/* Background: subtle canvas grid + drifting brand glow. The glow's
          positioning wrapper owns the static transform so motion's inline
          transform never fights a Tailwind translate class. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.12] [background-image:linear-gradient(to_right,white_1px,transparent_1px),linear-gradient(to_bottom,white_1px,transparent_1px)] [background-size:56px_56px] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_40%,black,transparent)]"
      />
      <div aria-hidden="true" className="pointer-events-none absolute left-1/2 top-1/3 h-[480px] w-[720px] max-w-full -translate-x-1/2">
        <motion.div
          className="ac-brand-gradient h-full w-full rounded-full opacity-20 blur-3xl"
          animate={shouldReduceMotion ? undefined : { scale: [1, 1.08, 1], opacity: [0.15, 0.25, 0.15] }}
          transition={{ duration: 9, repeat: Infinity, ease: 'easeInOut' }}
        />
      </div>

      <p className="mb-4 text-sm font-medium uppercase tracking-widest text-white/50">
        AgentCanvas — Figma for AI agents
      </p>

      {/* The page's single h1, balanced with react-wrap-balancer. */}
      <Balancer as="h1" className="max-w-3xl text-balance text-5xl font-semibold tracking-tight text-white md:text-6xl">
        Design at the speed of thought
      </Balancer>

      <p className="mt-5 max-w-2xl text-lg text-white/70">
        The open-source canvas where the AI agents do the drawing — and you direct.
      </p>

      {/* Typing effect on the prompt fragment (spec §5.1). react-type-animation
          has no reduced-motion handling of its own → static fallback branch. */}
      <p className="mt-6 text-sm text-white/80 [font-family:var(--font-geist-mono),monospace]">
        <span aria-hidden="true" className="ac-brand-gradient mr-2 rounded px-1.5 py-0.5 text-white">
          prompt
        </span>
        {shouldReduceMotion ? (
          <span data-testid="hero-typing-static">{TYPED_PROMPT}</span>
        ) : (
          <TypeAnimation
            data-testid="hero-typing"
            sequence={[TYPED_PROMPT, 2500]}
            wrapper="span"
            speed={44}
            repeat={Infinity}
            cursor
          />
        )}
      </p>

      {/* Dual CTA (spec §5.1): gradient primary + ghost canvas link. */}
      <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
        <a
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="hero-star"
          className="ac-brand-gradient inline-flex items-center gap-2 rounded-full px-6 py-3 text-sm font-semibold text-white shadow-lg transition-transform hover:scale-[1.03]"
        >
          <Star className="h-4 w-4" aria-hidden="true" />
          Star on GitHub
        </a>
        <Link
          href="/app"
          data-testid="hero-open"
          className="inline-flex items-center gap-2 rounded-full border border-white/20 px-6 py-3 text-sm font-medium text-white/90 transition-colors hover:bg-white/10"
        >
          Open the canvas
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      </div>

      {/* Marquee of tool-call chips (Magic UI marquee) — static row under
          reduced motion (spec §10). */}
      {shouldReduceMotion ? (
        <div data-testid="hero-chips-static" className="mt-10 flex max-w-3xl flex-wrap justify-center gap-2 overflow-hidden">
          {TOOL_CALLS.map((tool) => (
            <ToolCallChip key={tool} tool={tool} />
          ))}
        </div>
      ) : (
        <div data-testid="hero-chips" className="mt-10 w-full max-w-3xl overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_15%,black_85%,transparent)]">
          <Marquee pauseOnHover className="[--duration:40s]">
            {TOOL_CALLS.map((tool) => (
              <ToolCallChip key={tool} tool={tool} />
            ))}
          </Marquee>
        </div>
      )}

      {/* Foreground: tilted browser mockup with the hero-build screenshot
          (3840x2400, 16:10 — exactly the frame's default aspect) + parallax. */}
      <div ref={frameRef} className="relative mt-14 w-full max-w-4xl [perspective:1200px]">
        <motion.div style={applyParallax ? { y: frameY } : undefined}>
          <BrowserFrame className="md:[transform:rotateX(4deg)]">
            <Image
              src="/landing/hero-build.png"
              alt="AgentCanvas building a hero section live on the canvas"
              width={3840}
              height={2400}
              priority
              className="h-auto w-full object-cover"
            />
          </BrowserFrame>
        </motion.div>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test tests/unit/landing-hero.test.tsx`
Expected: PASS (9 tests including the reduced-motion block).

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no errors. (`data-testid` passes through `TypeAnimation`'s props — it spreads extra props onto the wrapper element; if the installed version's types reject it, wrap it instead: `<span data-testid="hero-typing"><TypeAnimation … /></span>` and keep the assertions unchanged.)

- [ ] **Step 6: Commit**

```bash
git add src/components/landing/Hero.tsx tests/unit/landing-hero.test.tsx
git commit -m "feat(landing): hero — balanced headline, dual CTA, typing prompt, chip marquee, parallax mockup"
```

---

### Task 5: MagicSequence — sticky scroll crossfade (§5.2)

**Files:**
- Create: `src/components/landing/MagicSequence.tsx`
- Test: `tests/unit/landing-magic-sequence.test.tsx`

**Interfaces:**
- Renders `<section id="magic" data-testid="section-magic">`, heading "Describe it. Watch it appear.", three numbered steps, and one sticky `BrowserFrame` (aspect `4 / 3`, `crop="bottom"`) that crossfades `hero-build.png` (3840×2400) → `dashboard-complete.png` (1280×577) driven by `useScroll` + `useTransform` opacity over the section's scroll progress.
- Reduced motion: the sticky crossfade is replaced by ONE static frame showing `dashboard-complete.png` only (`data-testid="magic-final-static"`); the normal variant renders both images (`data-testid="magic-frame-build"` / `data-testid="magic-frame-done"`).
- Images use `object-cover object-top` inside the 4/3 viewport: the 2.22:1 dashboard shot is scaled by width so its height overflows and the bottom edge (the "202 Issues" toast) is cropped out (spec §6).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/landing-magic-sequence.test.tsx`:

```tsx
// Task 5 of the landing-page plan — the sticky Magic sequence (spec §5.2).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useReducedMotion } from 'motion/react';
import { MagicSequence } from '@/components/landing/MagicSequence';

vi.mock('next/image', () => ({
  default: (props: {
    src: string | { src: string };
    alt: string;
    width?: number;
    height?: number;
    className?: string;
    priority?: boolean;
  }) => {
    const src = typeof props.src === 'string' ? props.src : props.src.src;
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={props.alt} width={props.width} height={props.height} className={props.className} />;
  },
}));

vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return { ...actual, useReducedMotion: vi.fn(() => false) };
});

const useReducedMotionMock = vi.mocked(useReducedMotion);

beforeEach(() => {
  useReducedMotionMock.mockReturnValue(false);
});

describe('landing: MagicSequence', () => {
  it('renders the section anchor and heading', () => {
    render(<MagicSequence />);
    expect(screen.getByTestId('section-magic')).toHaveAttribute('id', 'magic');
    expect(screen.getByRole('heading', { name: 'Describe it. Watch it appear.' })).toBeInTheDocument();
  });

  it('renders the three steps in order', () => {
    render(<MagicSequence />);
    expect(screen.getByText('Prompt typed')).toBeInTheDocument();
    expect(screen.getByText('Agent plans and builds')).toBeInTheDocument();
    expect(screen.getByText('Dashboard complete')).toBeInTheDocument();
  });

  it('crossfade variant renders both screenshots (motion layers stacked in one sticky frame)', () => {
    render(<MagicSequence />);
    const build = screen.getByAltText('AgentCanvas building a hero section live on the canvas');
    const done = screen.getByAltText('Completed dashboard design with the agent task list visible');
    expect(build).toHaveAttribute('src', '/landing/hero-build.png');
    expect(done).toHaveAttribute('src', '/landing/dashboard-complete.png');
    expect(screen.getByTestId('magic-frame-build')).toBeInTheDocument();
    expect(screen.getByTestId('magic-frame-done')).toBeInTheDocument();
  });

  it('frames the screenshots with the bottom-crop viewport (toast artifact treatment)', () => {
    render(<MagicSequence />);
    const frame = screen.getByTestId('browser-frame');
    expect(frame.getAttribute('data-crop')).toBe('bottom');
    const viewport = frame.lastElementChild as HTMLElement;
    expect(viewport.style.aspectRatio).toBe('4 / 3');
  });

  describe('reduced motion', () => {
    beforeEach(() => {
      useReducedMotionMock.mockReturnValue(true);
    });

    it('renders only the final screenshot statically', () => {
      render(<MagicSequence />);
      expect(screen.getByTestId('magic-final-static')).toBeInTheDocument();
      expect(screen.getByAltText('Completed dashboard design with the agent task list visible')).toBeInTheDocument();
      expect(screen.queryByTestId('magic-frame-build')).not.toBeInTheDocument();
      expect(screen.queryByTestId('magic-frame-done')).not.toBeInTheDocument();
    });

    it('still renders the steps', () => {
      render(<MagicSequence />);
      expect(screen.getByText('Agent plans and builds')).toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test tests/unit/landing-magic-sequence.test.tsx`
Expected: FAIL — cannot resolve `@/components/landing/MagicSequence`.

- [ ] **Step 3: Create `src/components/landing/MagicSequence.tsx`**

```tsx
'use client';

import { useRef } from 'react';
import Image from 'next/image';
import { motion, useScroll, useTransform, useReducedMotion } from 'motion/react';
import { BlurFade } from '@/components/ui/blur-fade';
import { BrowserFrame } from './BrowserFrame';

const STEPS = [
  {
    index: '01',
    title: 'Prompt typed',
    body: 'You describe the screen you want in plain language — the prompt types itself out.',
  },
  {
    index: '02',
    title: 'Agent plans and builds',
    body: 'The agent turns the prompt into a visible task list and executes it tool by tool, live on the canvas.',
  },
  {
    index: '03',
    title: 'Dashboard complete',
    body: 'A finished, editable design — layers, components, and variables intact — ready to refine or export.',
  },
] as const;

/** The Magic — sticky scrolly core (spec §5.2). The right column pins with
 * CSS position:sticky; scroll progress crossfades hero-build → dashboard.
 * Both frames use aspect 4 / 3 + object-top so the dashboard screenshot's
 * bottom edge (the "202 Issues" toast) is cropped out in CSS (spec §6). */
export function MagicSequence() {
  const shouldReduceMotion = useReducedMotion();
  const sequenceRef = useRef<HTMLDivElement>(null);

  const { scrollYProgress } = useScroll({
    target: sequenceRef,
    offset: ['start start', 'end end'],
  });
  const buildOpacity = useTransform(scrollYProgress, [0, 0.45, 0.6], [1, 1, 0]);
  const doneOpacity = useTransform(scrollYProgress, [0.45, 0.6], [0, 1]);

  return (
    <section id="magic" data-testid="section-magic" className="scroll-mt-20 px-6 py-24">
      <div className="mx-auto max-w-6xl">
        <BlurFade inView>
          <h2 className="text-balance text-3xl font-semibold tracking-tight text-white md:text-4xl">
            Describe it. Watch it appear.
          </h2>
          <p className="mt-3 max-w-2xl text-white/60">
            One prompt in, a finished screen out — while you watch every step.
          </p>
        </BlurFade>

        <div ref={sequenceRef} className="mt-12 grid items-start gap-10 md:grid-cols-2">
          {/* Left column: the three steps. */}
          <ol className="space-y-6">
            {STEPS.map((step) => (
              <li key={step.index} className="rounded-xl border border-white/10 bg-white/5 p-5">
                <div className="flex items-baseline gap-3">
                  <span className="text-xs text-white/40 [font-family:var(--font-geist-mono),monospace]">
                    {step.index}
                  </span>
                  <h3 className="text-base font-semibold text-white">{step.title}</h3>
                </div>
                <p className="mt-2 text-sm text-white/60">{step.body}</p>
                {step.index === '02' && (
                  <ul className="mt-3 space-y-1.5" aria-label="Agent task list">
                    {['Plan the layout structure', 'Build the components', 'Apply tokens and polish'].map(
                      (task) => (
                        <li key={task} className="flex items-center gap-2 text-xs text-white/50">
                          <span aria-hidden="true" className="ac-brand-gradient flex h-3.5 w-3.5 items-center justify-center rounded-full text-[8px] font-bold text-white">
                            ✓
                          </span>
                          {task}
                        </li>
                      ),
                    )}
                  </ul>
                )}
              </li>
            ))}
          </ol>

          {/* Right column: the pinned browser frame (sticky on all sizes —
              single-column on mobile keeps the same content order, §10). */}
          <div className="sticky top-24">
            {shouldReduceMotion ? (
              <BrowserFrame aspectRatio="4 / 3" crop="bottom">
                <div data-testid="magic-final-static" className="absolute inset-0">
                  <Image
                    src="/landing/dashboard-complete.png"
                    alt="Completed dashboard design with the agent task list visible"
                    width={1280}
                    height={577}
                    className="h-full w-full object-cover object-top"
                  />
                </div>
              </BrowserFrame>
            ) : (
              <BrowserFrame aspectRatio="4 / 3" crop="bottom">
                <motion.div
                  data-testid="magic-frame-build"
                  style={{ opacity: buildOpacity }}
                  className="absolute inset-0"
                >
                  <Image
                    src="/landing/hero-build.png"
                    alt="AgentCanvas building a hero section live on the canvas"
                    width={3840}
                    height={2400}
                    className="h-full w-full object-cover object-top"
                  />
                </motion.div>
                <motion.div
                  data-testid="magic-frame-done"
                  style={{ opacity: doneOpacity }}
                  className="absolute inset-0"
                >
                  <Image
                    src="/landing/dashboard-complete.png"
                    alt="Completed dashboard design with the agent task list visible"
                    width={1280}
                    height={577}
                    className="h-full w-full object-cover object-top"
                  />
                </motion.div>
              </BrowserFrame>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test tests/unit/landing-magic-sequence.test.tsx`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/landing/MagicSequence.tsx tests/unit/landing-magic-sequence.test.tsx
git commit -m "feat(landing): sticky scroll MagicSequence with build-to-done crossfade"
```

---

### Task 6: FeatureGallery + TrustLoop (§5.3 / §5.4)

**Files:**
- Create: `src/components/landing/FeatureGallery.tsx`
- Create: `src/components/landing/TrustLoop.tsx`
- Test: `tests/unit/landing-gallery-trust.test.tsx`

**Interfaces:**
- `FeatureGallery` renders `<section id="tool" data-testid="section-tool">` with heading "Not a toy — a Figma-grade tool.", a Magic UI `BentoGrid` with two `BentoCard`s ("Figma-grade tooling" / "One-shot generators"), and a full-width parallax band with `attention-heatmap.png` (1280×577) in a `BrowserFrame` (aspect `16 / 7`, `crop="bottom"`, parallax via `useScroll`+`useTransform` y).
- `TrustLoop` renders `<section id="trust" data-testid="section-trust">` with heading "You approve. Every time.", `approval-dialog.png` (1600×1000 — exact 16:10 fit) in a `BrowserFrame`, and the four approved bullets (verbatim copy from spec §5.4).
- Reduced motion: both components skip their parallax transforms; all copy and images still render.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/landing-gallery-trust.test.tsx`:

```tsx
// Task 6 of the landing-page plan — FeatureGallery (§5.3) + TrustLoop (§5.4).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useReducedMotion } from 'motion/react';
import { FeatureGallery } from '@/components/landing/FeatureGallery';
import { TrustLoop } from '@/components/landing/TrustLoop';

vi.mock('next/image', () => ({
  default: (props: {
    src: string | { src: string };
    alt: string;
    width?: number;
    height?: number;
    className?: string;
    priority?: boolean;
  }) => {
    const src = typeof props.src === 'string' ? props.src : props.src.src;
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={props.alt} width={props.width} height={props.height} className={props.className} />;
  },
}));

vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return { ...actual, useReducedMotion: vi.fn(() => false) };
});

const useReducedMotionMock = vi.mocked(useReducedMotion);

beforeEach(() => {
  useReducedMotionMock.mockReturnValue(false);
});

describe('landing: FeatureGallery', () => {
  it('renders the section anchor and verbatim heading', () => {
    render(<FeatureGallery />);
    expect(screen.getByTestId('section-tool')).toHaveAttribute('id', 'tool');
    expect(screen.getByRole('heading', { name: 'Not a toy — a Figma-grade tool.' })).toBeInTheDocument();
  });

  it('renders the two bento cards with their copy', () => {
    render(<FeatureGallery />);
    expect(screen.getByText('Figma-grade tooling')).toBeInTheDocument();
    expect(screen.getByText(/Layers, properties, components, auto layout, variables, and gradients/)).toBeInTheDocument();
    expect(screen.getByText('One-shot generators')).toBeInTheDocument();
    expect(screen.getByText(/Flows, wireframes, and mindmaps appear from a single prompt/)).toBeInTheDocument();
  });

  it('renders the attention-heatmap parallax band with alt text and real dims', () => {
    render(<FeatureGallery />);
    const img = screen.getByAltText('Attention heatmap overlay over a zoomed-out AgentCanvas board');
    expect(img).toHaveAttribute('src', '/landing/attention-heatmap.png');
    expect(img).toHaveAttribute('width', '1280');
    expect(img).toHaveAttribute('height', '577');
  });

  describe('reduced motion', () => {
    beforeEach(() => {
      useReducedMotionMock.mockReturnValue(true);
    });

    it('still renders all content statically', () => {
      render(<FeatureGallery />);
      expect(screen.getByText('Figma-grade tooling')).toBeInTheDocument();
      expect(screen.getByAltText('Attention heatmap overlay over a zoomed-out AgentCanvas board')).toBeInTheDocument();
    });
  });
});

describe('landing: TrustLoop', () => {
  it('renders the section anchor and verbatim heading', () => {
    render(<TrustLoop />);
    expect(screen.getByTestId('section-trust')).toHaveAttribute('id', 'trust');
    expect(screen.getByRole('heading', { name: 'You approve. Every time.' })).toBeInTheDocument();
  });

  it('renders the approval-dialog screenshot in a frame with alt text and real dims', () => {
    render(<TrustLoop />);
    const img = screen.getByAltText('Approve destructive operation dialog with Deny and Allow actions');
    expect(img).toHaveAttribute('src', '/landing/approval-dialog.png');
    expect(img).toHaveAttribute('width', '1600');
    expect(img).toHaveAttribute('height', '1000');
  });

  it('renders the four approved trust bullets verbatim', () => {
    render(<TrustLoop />);
    expect(screen.getByText('Destructive-operation gating')).toBeInTheDocument();
    expect(screen.getByText(/the agent cannot delete or overwrite anything without an explicit Allow/i)).toBeInTheDocument();
    expect(screen.getByText('Diff cards')).toBeInTheDocument();
    expect(screen.getByText(/every proposed destructive change is shown as a before\/after diff/i)).toBeInTheDocument();
    expect(screen.getByText('Unattended auto-deny after 5 minutes')).toBeInTheDocument();
    expect(screen.getByText(/a pending approval with no human present is denied, never guessed/i)).toBeInTheDocument();
    expect(screen.getByText('Snapshot audit trail')).toBeInTheDocument();
    expect(screen.getByText(/every approved change is a restorable document snapshot/i)).toBeInTheDocument();
  });

  describe('reduced motion', () => {
    beforeEach(() => {
      useReducedMotionMock.mockReturnValue(true);
    });

    it('still renders the screenshot and bullets', () => {
      render(<TrustLoop />);
      expect(screen.getByAltText('Approve destructive operation dialog with Deny and Allow actions')).toBeInTheDocument();
      expect(screen.getByText('Snapshot audit trail')).toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test tests/unit/landing-gallery-trust.test.tsx`
Expected: FAIL — cannot resolve `@/components/landing/FeatureGallery`.

- [ ] **Step 3: Create `src/components/landing/FeatureGallery.tsx`**

```tsx
'use client';

import { useRef } from 'react';
import Image from 'next/image';
import { Layers, Sparkles, Wand2 } from 'lucide-react';
import { motion, useScroll, useTransform, useReducedMotion } from 'motion/react';
import { BentoCard, BentoGrid } from '@/components/ui/bento-grid';
import { BlurFade } from '@/components/ui/blur-fade';
import { BrowserFrame } from './BrowserFrame';

const BENTO_CARDS = [
  {
    name: 'Figma-grade tooling',
    Icon: Layers,
    description:
      'Layers, properties, components, auto layout, variables, and gradients — the full design-tool surface, operated by the agent.',
    background: (
      <div className="ac-brand-gradient absolute inset-0 opacity-[0.08]" aria-hidden="true" />
    ),
  },
  {
    name: 'One-shot generators',
    Icon: Sparkles,
    description:
      'Flows, wireframes, and mindmaps appear from a single prompt — then stay fully editable on the canvas.',
    background: (
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_20%,rgba(217,70,239,0.15),transparent_60%)]" aria-hidden="true" />
    ),
  },
] as const;

/** Real design tool — credibility for designers (spec §5.3). */
export function FeatureGallery() {
  const shouldReduceMotion = useReducedMotion();
  const bandRef = useRef<HTMLDivElement>(null);

  const { scrollYProgress } = useScroll({
    target: bandRef,
    offset: ['start end', 'end start'],
  });
  const bandY = useTransform(scrollYProgress, [0, 1], [-32, 32]);

  return (
    <section id="tool" data-testid="section-tool" className="scroll-mt-20 px-6 py-24">
      <div className="mx-auto max-w-6xl">
        <BlurFade inView>
          <h2 className="text-balance text-3xl font-semibold tracking-tight text-white md:text-4xl">
            Not a toy — a Figma-grade tool.
          </h2>
          <p className="mt-3 max-w-2xl text-white/60">
            Everything a designer expects from a real canvas, built by conversation.
          </p>
        </BlurFade>

        <BlurFade inView delay={0.1} className="mt-12">
          <BentoGrid className="md:grid-cols-2">
            {BENTO_CARDS.map((card) => (
              <BentoCard
                key={card.name}
                name={card.name}
                className="col-span-1"
                background={card.background}
                Icon={card.Icon}
                description={card.description}
                href="/app"
                cta="Open the canvas"
              />
            ))}
          </BentoGrid>
        </BlurFade>

        {/* Full-width parallax band — the attention-heatmap screenshot.
            1280x577 (~2.22:1) in a 16/7 viewport + object-top crops the
            bottom-edge toast artifact in CSS (spec §6). */}
        <div ref={bandRef} className="mt-12">
          <motion.div style={shouldReduceMotion ? undefined : { y: bandY }}>
            <BrowserFrame aspectRatio="16 / 7" crop="bottom">
              <div className="absolute inset-0">
                <Image
                  src="/landing/attention-heatmap.png"
                  alt="Attention heatmap overlay over a zoomed-out AgentCanvas board"
                  width={1280}
                  height={577}
                  className="h-full w-full object-cover object-top"
                />
              </div>
            </BrowserFrame>
          </motion.div>
          <p className="mt-4 flex items-center justify-center gap-2 text-center text-sm text-white/50">
            <Wand2 className="h-4 w-4" aria-hidden="true" />
            The agent draws — the heatmap shows where a viewer looks first.
          </p>
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Create `src/components/landing/TrustLoop.tsx`**

```tsx
'use client';

import Image from 'next/image';
import { FileDiff, History, ShieldCheck, Timer } from 'lucide-react';
import { BlurFade } from '@/components/ui/blur-fade';
import { BrowserFrame } from './BrowserFrame';

/** The four approved bullets — verbatim copy from spec §5.4. */
const TRUST_BULLETS = [
  {
    Icon: ShieldCheck,
    title: 'Destructive-operation gating',
    body: 'The agent cannot delete or overwrite anything without an explicit Allow.',
  },
  {
    Icon: FileDiff,
    title: 'Diff cards',
    body: 'Every proposed destructive change is shown as a before/after diff.',
  },
  {
    Icon: Timer,
    title: 'Unattended auto-deny after 5 minutes',
    body: 'A pending approval with no human present is denied, never guessed.',
  },
  {
    Icon: History,
    title: 'Snapshot audit trail',
    body: 'Every approved change is a restorable document snapshot.',
  },
] as const;

/** Trust loop — credibility for teams (spec §5.4). The approval-dialog
 * screenshot is exactly 16:10, so the default frame fits it with zero crop. */
export function TrustLoop() {
  return (
    <section id="trust" data-testid="section-trust" className="scroll-mt-20 px-6 py-24">
      <div className="mx-auto max-w-6xl">
        <BlurFade inView>
          <h2 className="text-balance text-3xl font-semibold tracking-tight text-white md:text-4xl">
            You approve. Every time.
          </h2>
          <p className="mt-3 max-w-2xl text-white/60">
            The agent moves fast because the dangerous steps stop and wait for a human.
          </p>
        </BlurFade>

        <div className="mt-12 grid items-center gap-12 md:grid-cols-5">
          <BlurFade inView delay={0.1} className="md:col-span-3">
            <BrowserFrame>
              <Image
                src="/landing/approval-dialog.png"
                alt="Approve destructive operation dialog with Deny and Allow actions"
                width={1600}
                height={1000}
                className="h-auto w-full object-cover"
              />
            </BrowserFrame>
          </BlurFade>

          <ul className="space-y-5 md:col-span-2">
            {TRUST_BULLETS.map(({ Icon, title, body }) => (
              <li key={title} className="flex gap-3">
                <span className="ac-brand-gradient mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg" aria-hidden="true">
                  <Icon className="h-4 w-4 text-white" />
                </span>
                <div>
                  <h3 className="text-sm font-semibold text-white">{title}</h3>
                  <p className="mt-1 text-sm text-white/60">{body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun run test tests/unit/landing-gallery-trust.test.tsx`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
git add src/components/landing/FeatureGallery.tsx src/components/landing/TrustLoop.tsx tests/unit/landing-gallery-trust.test.tsx
git commit -m "feat(landing): bento feature gallery + trust loop with verbatim approval copy"
```

---

### Task 7: HowItWorks + OpenSourceFinale (§5.5 / §5.6)

**Files:**
- Create: `src/components/landing/HowItWorks.tsx`
- Create: `src/components/landing/OpenSourceFinale.tsx`
- Test: `tests/unit/landing-how-it-works-finale.test.tsx`

**Interfaces:**
- `HowItWorks` renders `<section id="how-it-works" data-testid="section-how-it-works">`, a pure CSS/flex diagram (Prompt → Agent → Tools → Canvas boxes with arrow connectors, Geist Mono labels via `[font-family:var(--font-geist-mono),monospace]` — no images), animated stats (`NumberFlow` from `@number-flow/react`: 60+ tools, 28 providers — values set 0 → final after mount so the count-up animation runs; the library handles `prefers-reduced-motion` internally), and a mono chip row for the remaining approved content (`.pen` file format, sessions + snapshots, Socket.IO realtime, copy-as-code).
- `OpenSourceFinale` renders `<section id="open-source" data-testid="section-open-source">` with heading "Open source. AGPL-3.0. Free forever.", a plain styled `<pre>` clone command built from `REPO_CLONE_URL` (no syntax-highlighting library) with a copy button (`navigator.clipboard.writeText` + `copied` state, `data-testid="copy-clone"`, `data-copied="true"` when copied), a `BorderBeam` on the clone block, a star button (`data-testid="finale-star"` → `REPO_URL`), and the final CTA (`data-testid="finale-open"` → `/app`).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/landing-how-it-works-finale.test.tsx`:

```tsx
// Task 7 of the landing-page plan — HowItWorks (§5.5) + OpenSourceFinale (§5.6).

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { REPO_URL } from '@/components/landing/repo-url';
import { HowItWorks } from '@/components/landing/HowItWorks';
import { OpenSourceFinale } from '@/components/landing/OpenSourceFinale';

// NumberFlow upgrades a web component that jsdom can't render meaningfully —
// mock it to a span carrying the value so stat assertions are deterministic.
vi.mock('@number-flow/react', () => ({
  default: (props: { value: number; suffix?: string; 'data-testid'?: string; className?: string }) => (
    <span data-testid={props['data-testid'] ?? 'number-flow'} className={props.className}>
      {props.value}
      {props.suffix ?? ''}
    </span>
  ),
}));

describe('landing: HowItWorks', () => {
  it('renders the section anchor and heading', () => {
    render(<HowItWorks />);
    expect(screen.getByTestId('section-how-it-works')).toHaveAttribute('id', 'how-it-works');
    expect(screen.getByRole('heading', { name: 'How it works' })).toBeInTheDocument();
  });

  it('renders the CSS/flex diagram boxes in flow order with mono labels', () => {
    render(<HowItWorks />);
    expect(screen.getByTestId('flow-prompt')).toHaveTextContent('Prompt');
    expect(screen.getByTestId('flow-agent')).toHaveTextContent('Agent');
    expect(screen.getByTestId('flow-tools')).toHaveTextContent('Tools');
    expect(screen.getByTestId('flow-canvas')).toHaveTextContent('Canvas');
  });

  it('animates the stats to the final values (60+ tools, 28 providers)', async () => {
    vi.useFakeTimers();
    try {
      render(<HowItWorks />);
      // Values start at 0 and count up after the mount delay.
      expect(screen.getByTestId('stat-tools')).toHaveTextContent('0+');
      expect(screen.getByTestId('stat-providers')).toHaveTextContent('0');
      vi.advanceTimersByTime(500);
      await waitFor(() => {
        expect(screen.getByTestId('stat-tools')).toHaveTextContent('60+');
        expect(screen.getByTestId('stat-providers')).toHaveTextContent('28');
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders the remaining developer-depth chips', () => {
    render(<HowItWorks />);
    expect(screen.getByText('.pen file format')).toBeInTheDocument();
    expect(screen.getByText('Sessions + snapshots')).toBeInTheDocument();
    expect(screen.getByText('Socket.IO realtime')).toBeInTheDocument();
    expect(screen.getByText('Copy as HTML / React / Tailwind')).toBeInTheDocument();
  });
});

describe('landing: OpenSourceFinale', () => {
  it('renders the section anchor and verbatim heading', () => {
    render(<OpenSourceFinale />);
    expect(screen.getByTestId('section-open-source')).toHaveAttribute('id', 'open-source');
    expect(screen.getByRole('heading', { name: 'Open source. AGPL-3.0. Free forever.' })).toBeInTheDocument();
  });

  it('renders the clone command from the shared REPO_URL constant', () => {
    render(<OpenSourceFinale />);
    expect(screen.getByTestId('clone-command')).toHaveTextContent(
      'git clone https://github.com/kanishka-namdeo/co-canvas.git',
    );
  });

  it('copies the clone command and flips the copied state', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    try {
      render(<OpenSourceFinale />);
      const button = screen.getByTestId('copy-clone');
      expect(button.getAttribute('data-copied')).toBe('false');
      fireEvent.click(button);
      expect(writeText).toHaveBeenCalledWith('git clone https://github.com/kanishka-namdeo/co-canvas.git');
      await waitFor(() => {
        expect(button.getAttribute('data-copied')).toBe('true');
      });
    } finally {
      // Remove the instance property so other tests see stock jsdom navigator.
      delete (window.navigator as unknown as Record<string, unknown>).clipboard;
    }
  });

  it('renders the star button and the final /app CTA', () => {
    render(<OpenSourceFinale />);
    expect(screen.getByTestId('finale-star')).toHaveAttribute('href', REPO_URL);
    expect(screen.getByTestId('finale-open')).toHaveAttribute('href', '/app');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test tests/unit/landing-how-it-works-finale.test.tsx`
Expected: FAIL — cannot resolve `@/components/landing/HowItWorks`.

- [ ] **Step 3: Create `src/components/landing/HowItWorks.tsx`**

```tsx
'use client';

import { useEffect, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import NumberFlow from '@number-flow/react';
import { BlurFade } from '@/components/ui/blur-fade';

const FLOW = [
  { id: 'prompt', label: 'Prompt', detail: 'plain-language brief' },
  { id: 'agent', label: 'Agent', detail: 'plans + executes' },
  { id: 'tools', label: 'Tools', detail: 'typed operations' },
  { id: 'canvas', label: 'Canvas', detail: 'live design' },
] as const;

const DEV_CHIPS = [
  '.pen file format',
  'Sessions + snapshots',
  'Socket.IO realtime',
  'Copy as HTML / React / Tailwind',
] as const;

/** Developer depth (spec §5.5) — the handoff point from designer-magic to
 * developer-substance. Pure CSS/flex diagram, no images; Geist Mono labels
 * via the --font-geist-mono variable loaded in src/app/layout.tsx. */
export function HowItWorks() {
  // Start the counters at 0 and set the real values after mount so
  // NumberFlow animates the count-up (it renders the final value instantly
  // under prefers-reduced-motion — its own built-in fallback).
  const [tools, setTools] = useState(0);
  const [providers, setProviders] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => {
      setTools(60);
      setProviders(28);
    }, 300);
    return () => clearTimeout(timer);
  }, []);

  return (
    <section id="how-it-works" data-testid="section-how-it-works" className="scroll-mt-20 px-6 py-24">
      <div className="mx-auto max-w-6xl">
        <BlurFade inView>
          <h2 className="text-balance text-3xl font-semibold tracking-tight text-white md:text-4xl">
            How it works
          </h2>
          <p className="mt-3 max-w-2xl text-white/60">
            From a sentence to a shipped design — one typed-tool surface under the hood.
          </p>
        </BlurFade>

        {/* Pure CSS/flex architecture diagram — styled boxes + connectors. */}
        <BlurFade inView delay={0.1}>
          <div className="mt-12 flex flex-col items-stretch justify-center gap-3 md:flex-row md:items-center">
            {FLOW.map((node, index) => (
              <div key={node.id} className="contents">
                <div
                  data-testid={`flow-${node.id}`}
                  className="flex-1 rounded-xl border border-white/10 bg-white/5 p-4 text-center"
                >
                  <p className="text-sm font-semibold text-white [font-family:var(--font-geist-mono),monospace]">
                    {node.label}
                  </p>
                  <p className="mt-1 text-xs text-white/50">{node.detail}</p>
                </div>
                {index < FLOW.length - 1 && (
                  <ArrowRight
                    aria-hidden="true"
                    className="mx-auto h-4 w-4 flex-shrink-0 text-white/40 max-md:rotate-90"
                  />
                )}
              </div>
            ))}
          </div>
        </BlurFade>

        {/* Animated stats — NumberFlow counts up on mount. */}
        <div className="mt-12 flex flex-wrap items-end gap-12" data-testid="stats">
          <div>
            <NumberFlow
              value={tools}
              suffix="+"
              data-testid="stat-tools"
              className="text-5xl font-semibold text-white"
            />
            <p className="mt-1 text-sm text-white/50">typed tools</p>
          </div>
          <div>
            <NumberFlow
              value={providers}
              data-testid="stat-providers"
              className="text-5xl font-semibold text-white"
            />
            <p className="mt-1 text-sm text-white/50">LLM providers</p>
          </div>
        </div>

        {/* Remaining approved §5.5 content as mono chips. */}
        <ul className="mt-10 flex flex-wrap gap-2">
          {DEV_CHIPS.map((chip) => (
            <li
              key={chip}
              className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/70 [font-family:var(--font-geist-mono),monospace]"
            >
              {chip}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Create `src/components/landing/OpenSourceFinale.tsx`**

```tsx
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Check, Copy, Star } from 'lucide-react';
import { BorderBeam } from '@/components/ui/border-beam';
import { BlurFade } from '@/components/ui/blur-fade';
import { REPO_URL, REPO_CLONE_URL } from './repo-url';

const CLONE_COMMAND = `git clone ${REPO_CLONE_URL}`;

/** Open-source finale — the conversion (spec §5.6). Plain styled <pre>,
 * no syntax-highlighting library; copy button via navigator.clipboard. */
export function OpenSourceFinale() {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copyCloneCommand = async () => {
    try {
      await navigator.clipboard.writeText(CLONE_COMMAND);
      setCopied(true);
    } catch {
      // Clipboard unavailable (permissions / non-secure context) — no-op.
    }
  };

  return (
    <section
      id="open-source"
      data-testid="section-open-source"
      className="scroll-mt-20 px-6 py-24 text-center"
    >
      <div className="mx-auto max-w-3xl">
        <BlurFade inView>
          <h2 className="text-balance text-3xl font-semibold tracking-tight text-white md:text-4xl">
            Open source. AGPL-3.0. Free forever.
          </h2>
          <p className="mt-3 text-white/60">
            Clone it, star it, open the canvas. No signup, no pricing — ever.
          </p>
        </BlurFade>

        {/* Copyable clone command block with a border beam accent. */}
        <BlurFade inView delay={0.1}>
          <div className="relative mt-10 overflow-hidden rounded-xl border border-white/10 bg-white/5">
            <BorderBeam size={60} duration={6} />
            <div className="flex items-center justify-between gap-4 p-5">
              <pre
                data-testid="clone-command"
                className="overflow-x-auto text-left text-sm text-white/90 [font-family:var(--font-geist-mono),monospace]"
              >
                {CLONE_COMMAND}
              </pre>
              <button
                type="button"
                onClick={copyCloneCommand}
                data-testid="copy-clone"
                data-copied={copied ? 'true' : 'false'}
                aria-label={copied ? 'Copied' : 'Copy clone command'}
                className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-white/15 px-3 py-2 text-xs text-white/80 transition-colors hover:bg-white/10"
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        </BlurFade>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="finale-star"
            className="ac-brand-gradient inline-flex items-center gap-2 rounded-full px-6 py-3 text-sm font-semibold text-white shadow-lg"
          >
            <Star className="h-4 w-4" aria-hidden="true" />
            Star on GitHub
          </a>
          <Link
            href="/app"
            data-testid="finale-open"
            className="inline-flex items-center gap-2 rounded-full border border-white/20 px-6 py-3 text-sm font-medium text-white/90 transition-colors hover:bg-white/10"
          >
            Open the canvas
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun run test tests/unit/landing-how-it-works-finale.test.tsx`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add src/components/landing/HowItWorks.tsx src/components/landing/OpenSourceFinale.tsx tests/unit/landing-how-it-works-finale.test.tsx
git commit -m "feat(landing): how-it-works CSS diagram with animated stats + open-source finale"
```

---

### Task 8: Landing page shell — the new `/` (metadata, SmoothScroll, dynamic sections)

**Files:**
- Create: `src/components/landing/SmoothScroll.tsx`
- Create: `src/app/page.tsx` (NEW landing — the old one moved to `/app` in Task 2)
- Test: `tests/unit/landing-page.test.tsx`

**Interfaces:**
- `src/app/page.tsx` is a **server component** (it exports `metadata`) — it must NOT have `'use client'`. It statically imports `LandingHeader` + `Hero` (initial bundle, spec §8) and lazy-loads the four below-fold sections via `next/dynamic` (default `ssr: true` — App Router server components cannot use `ssr: false`; lazy chunking still applies).
- `SmoothScroll` (client) wraps everything: `useReducedMotion()` true → renders children bare (native scrolling); otherwise `<ReactLenis root options={{ lerp: 0.1, smoothWheel: true }}>` with `import 'lenis/dist/lenis.css'`.
- `ScrollProgress` (Magic UI) renders a fixed top progress bar for the whole page.
- Page metadata: title `AgentCanvas — Figma for AI agents`, landing description, `twitter.card = 'summary_large_image'` (the `opengraph-image.tsx` file convention in Task 9 auto-injects the `og:image`/`twitter:image` tags).
- The root div carries `className="dark"` to force the dark token subtree (see Global Constraints).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/landing-page.test.tsx`:

```tsx
// Task 8 of the landing-page plan — the landing shell at /.
// lenis is mocked (jsdom has no real layout for a smooth-scroll engine);
// every other piece is the real component tree composed through next/dynamic
// (dynamic chunks resolve async → assertions use findBy*).

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { metadata, default as LandingPage } from '@/app/page';

vi.mock('lenis/react', () => ({
  ReactLenis: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="lenis-root">{children}</div>
  ),
  useLenis: () => null,
}));

vi.mock('next/image', () => ({
  default: (props: {
    src: string | { src: string };
    alt: string;
    width?: number;
    height?: number;
    className?: string;
    priority?: boolean;
  }) => {
    const src = typeof props.src === 'string' ? props.src : props.src.src;
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={props.alt} width={props.width} height={props.height} className={props.className} />;
  },
}));

vi.mock('@number-flow/react', () => ({
  default: (props: { value: number; suffix?: string; className?: string }) => (
    <span className={props.className}>
      {props.value}
      {props.suffix ?? ''}
    </span>
  ),
}));

describe('landing: page metadata', () => {
  it('exports the landing title and description', () => {
    expect(metadata.title).toBe('AgentCanvas — Figma for AI agents');
    expect(typeof metadata.description).toBe('string');
    expect(metadata.description).toContain('AI agents');
  });

  it('opts into the large twitter card', () => {
    expect(metadata.twitter?.card).toBe('summary_large_image');
  });
});

describe('landing: page composition', () => {
  it('renders all six sections with their stable ids', async () => {
    render(<LandingPage />);
    expect(await screen.findByTestId('section-hero')).toHaveAttribute('id', 'top');
    expect(await screen.findByTestId('section-magic')).toHaveAttribute('id', 'magic');
    expect(await screen.findByTestId('section-tool')).toHaveAttribute('id', 'tool');
    expect(await screen.findByTestId('section-trust')).toHaveAttribute('id', 'trust');
    expect(await screen.findByTestId('section-how-it-works')).toHaveAttribute('id', 'how-it-works');
    expect(await screen.findByTestId('section-open-source')).toHaveAttribute('id', 'open-source');
  });

  it('renders the header and footer around the sections', async () => {
    render(<LandingPage />);
    expect(await screen.findByTestId('landing-header')).toBeInTheDocument();
    expect(await screen.findByTestId('landing-footer')).toBeInTheDocument();
  });

  it('forces the dark token subtree via the .dark class on the root div', async () => {
    render(<LandingPage />);
    const root = await screen.findByTestId('landing-root');
    expect(root).toHaveClass('dark');
  });

  it('wraps the page in the lenis smooth-scroll provider', async () => {
    render(<LandingPage />);
    expect(await screen.findByTestId('lenis-root')).toBeInTheDocument();
  });

  it('renders exactly one h1 on the page (the hero headline)', async () => {
    render(<LandingPage />);
    await screen.findByTestId('section-open-source');
    const headings = await screen.findAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('Design at the speed of thought');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test tests/unit/landing-page.test.tsx`
Expected: FAIL — `@/app/page` resolves but exports no `metadata` and no landing composition (the file currently 404s as the route is empty; vitest fails on the missing exports).

- [ ] **Step 3: Create `src/components/landing/SmoothScroll.tsx`**

```tsx
'use client';

import type { ReactNode } from 'react';
import { ReactLenis } from 'lenis/react';
import 'lenis/dist/lenis.css';
import { useReducedMotion } from 'motion/react';

const LENIS_OPTIONS = { lerp: 0.1, smoothWheel: true } as const;

/** Inertial scrolling for the cinematic arc (spec §4). Under
 * prefers-reduced-motion the provider is not mounted at all — anchor links
 * fall back to native scrolling (LandingHeader's useLenis() returns null). */
export function SmoothScroll({ children }: { children: ReactNode }) {
  const shouldReduceMotion = useReducedMotion();

  if (shouldReduceMotion) {
    return <>{children}</>;
  }

  return (
    <ReactLenis root options={LENIS_OPTIONS}>
      {children}
    </ReactLenis>
  );
}
```

- [ ] **Step 4: Create `src/app/page.tsx`**

```tsx
import type { Metadata } from 'next';
import dynamic from 'next/dynamic';
import { ScrollProgress } from '@/components/ui/scroll-progress';
import { SmoothScroll } from '@/components/landing/SmoothScroll';
import { LandingHeader } from '@/components/landing/LandingHeader';
import { LandingFooter } from '@/components/landing/LandingFooter';
import { Hero } from '@/components/landing/Hero';

// Below-fold sections are lazy (spec §8: hero + header in the initial
// bundle). This file is a SERVER component, so `ssr: false` is not allowed —
// dynamic() keeps its default SSR (better for content) and still splits the
// chunks. The loading skeleton reserves rough height to avoid CLS on slow
// connections when a user deep-scrolls before the chunk lands.

function SectionSkeleton() {
  return <div aria-hidden="true" className="min-h-[60vh]" />;
}

const MagicSequence = dynamic(
  () => import('@/components/landing/MagicSequence').then((m) => m.MagicSequence),
  { loading: SectionSkeleton },
);
const FeatureGallery = dynamic(
  () => import('@/components/landing/FeatureGallery').then((m) => m.FeatureGallery),
  { loading: SectionSkeleton },
);
const TrustLoop = dynamic(
  () => import('@/components/landing/TrustLoop').then((m) => m.TrustLoop),
  { loading: SectionSkeleton },
);
const HowItWorks = dynamic(
  () => import('@/components/landing/HowItWorks').then((m) => m.HowItWorks),
  { loading: SectionSkeleton },
);
const OpenSourceFinale = dynamic(
  () => import('@/components/landing/OpenSourceFinale').then((m) => m.OpenSourceFinale),
  { loading: SectionSkeleton },
);

export const metadata: Metadata = {
  title: 'AgentCanvas — Figma for AI agents',
  description:
    'The open-source canvas where AI agents do the drawing and you direct. 60+ typed tools, human-approved destructive steps, 28 LLM providers — AGPL-3.0 and free forever.',
  keywords: ['AgentCanvas', 'AI agents', 'design canvas', 'Figma', 'open source', 'AGPL-3.0'],
  twitter: {
    card: 'summary_large_image',
    title: 'AgentCanvas — Figma for AI agents',
    description:
      'The open-source canvas where AI agents do the drawing and you direct.',
  },
};

/** The landing page owns `/` (spec §3). Single scroll narrative:
 * hero → magic → tool → trust → how-it-works → open-source finale.
 * The `.dark` class on the root forces the dark token subtree regardless of
 * the visitor's workspace theme preference (spec §9 — the landing is the
 * movie trailer; the light workspace is the product). */
export default function LandingPage() {
  return (
    <div data-testid="landing-root" className="dark min-h-screen bg-background text-foreground">
      <SmoothScroll>
        <ScrollProgress className="fixed top-0 z-50" />
        <LandingHeader />
        <main>
          <Hero />
          <MagicSequence />
          <FeatureGallery />
          <TrustLoop />
          <HowItWorks />
          <OpenSourceFinale />
        </main>
        <LandingFooter />
      </SmoothScroll>
    </div>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun run test tests/unit/landing-page.test.tsx`
Expected: PASS (7 tests). If `findByTestId('section-magic')` times out, the dynamic import mock chain is broken — check that `vi.mock('next/image')` etc. are hoisted at the top of the test file (they are; vitest hoists `vi.mock` automatically).

- [ ] **Step 6: Boot the dev server and smoke the route**

```bash
bun run dev
```

(Windows dev machine. In the z.ai sandbox use `bash scripts/start-dev.sh` instead — the sandbox kills tool-call descendants, and `start-dev.sh`'s orphan-to-init pattern survives.)

Open `http://127.0.0.1:3000/` — the landing must render end to end; `http://127.0.0.1:3000/app` must still serve the workspace. Stop the server when done.

- [ ] **Step 7: Commit**

```bash
git add src/app/page.tsx src/components/landing/SmoothScroll.tsx tests/unit/landing-page.test.tsx
git commit -m "feat(app): landing page at / — metadata, forced-dark tokens, lenis scroll, lazy sections"
```

---

### Task 9: OG image + metadata polish

**Files:**
- Create: `src/app/opengraph-image.tsx`
- Test: `tests/unit/landing-og-image.test.ts`

**Interfaces:**
- The Next.js file convention auto-injects `og:image` / `twitter:image` meta tags pointing at the generated image for the `/` route (Task 8's `twitter.card` opt-in completes the card). Exports: `alt` (string), `size` ({ width: 1200, height: 630 }), `contentType` ('image/png'), default `OpengraphImage()`.
- `next/og`'s `ImageResponse` ships a default font, so no font-file embedding is needed; satori requires explicit flex layouts, hence the inline styles.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/landing-og-image.test.ts`:

```typescript
// Task 9 of the landing-page plan — the OG image file convention.
// next/og is mocked so the module imports cleanly under jsdom; the default
// export's options are then asserted against the declared size.

import { describe, it, expect, vi } from 'vitest';

vi.mock('next/og', () => ({
  ImageResponse: class MockImageResponse {
    constructor(
      public element: unknown,
      public options?: { width?: number; height?: number },
    ) {}
  },
}));

import OgImage, { alt, size, contentType } from '@/app/opengraph-image';

describe('landing: OG image', () => {
  it('exports alt text naming the product', () => {
    expect(typeof alt).toBe('string');
    expect(alt).toContain('AgentCanvas');
    expect(alt.length).toBeGreaterThan(10);
  });

  it('exports the 1200x630 size and png content type', () => {
    expect(size).toEqual({ width: 1200, height: 630 });
    expect(contentType).toBe('image/png');
  });

  it('builds the ImageResponse with the declared size', () => {
    const response = OgImage() as unknown as { options: { width: number; height: number } };
    expect(response.options).toEqual({ width: 1200, height: 630 });
    expect(response.element).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test tests/unit/landing-og-image.test.ts`
Expected: FAIL — cannot resolve `@/app/opengraph-image`.

- [ ] **Step 3: Create `src/app/opengraph-image.tsx`**

```tsx
import { ImageResponse } from 'next/og';

export const alt = 'AgentCanvas — the open-source canvas where AI agents do the drawing';

export const size = {
  width: 1200,
  height: 630,
};

export const contentType = 'image/png';

/** OG image for `/` (spec §3). Dark ground, brand-gradient accent bar
 * (violet → fuchsia, matching --ac-brand-from/to), product name + tagline.
 * Satori requires explicit flex styles; ImageResponse's bundled default font
 * covers the Latin copy — no font embedding needed. */
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: '80px',
          backgroundColor: '#0a0a0f',
          backgroundImage:
            'radial-gradient(circle at 75% 20%, rgba(168,85,247,0.22), transparent 55%)',
        }}
      >
        <div
          style={{
            display: 'flex',
            width: '160px',
            height: '10px',
            borderRadius: '9999px',
            backgroundImage: 'linear-gradient(to bottom right, #8b5cf6, #d946ef)',
            marginBottom: '40px',
          }}
        />
        <div style={{ display: 'flex', fontSize: 72, fontWeight: 700, color: '#ffffff', letterSpacing: '-2px' }}>
          AgentCanvas
        </div>
        <div
          style={{
            display: 'flex',
            fontSize: 34,
            color: 'rgba(255,255,255,0.72)',
            marginTop: '24px',
            maxWidth: '860px',
          }}
        >
          The open-source canvas where AI agents do the drawing — and you direct.
        </div>
        <div
          style={{
            display: 'flex',
            fontSize: 22,
            color: 'rgba(255,255,255,0.45)',
            marginTop: '48px',
          }}
        >
          Figma for AI agents · AGPL-3.0 · github.com/kanishka-namdeo/co-canvas
        </div>
      </div>
    ),
    size,
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test tests/unit/landing-og-image.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Verify the metadata in the served page (dev server up)**

With the dev server from Task 8 still running, confirm the tags Next injects for `/`:

```bash
curl -s http://127.0.0.1:3000/ | grep -E "og:image|twitter:card|twitter:image" | head -5
```

Expected: `twitter:card` = `summary_large_image`, an `og:image` URL pointing at the opengraph-image route. (On Windows Git Bash, `curl` ships with Git; if unavailable, check `<head>` in the browser DevTools instead.)

- [ ] **Step 6: Commit**

```bash
git add src/app/opengraph-image.tsx tests/unit/landing-og-image.test.ts
git commit -m "feat(app): next/og OG image for the landing route"
```

---

### Task 10: DOX pass, README fix, full verification, and visual sign-off

**Files:**
- Create: `src/components/landing/AGENTS.md`
- Modify: `src/components/AGENTS.md` (child index + purpose count)
- Modify: `src/app/AGENTS.md` (route ownership)
- Modify: root `AGENTS.md` (sandbox route line)
- Modify: `README.md` (clone command)
- Modify: `docs/AGENTS.md` (spec status)
- Modify: `tests/AGENTS.md` (new test files + setup note)
- Modify: `scripts/AGENTS.md` (new screenshot script)
- Create: `scripts/screenshot-landing.ts`

- [ ] **Step 1: Create `src/components/landing/AGENTS.md`** (Child Doc Shape, per root DOX)

```markdown
# AGENTS.md — `src/components/landing/`

## Purpose

The AgentCanvas landing page components: the cinematic scroll-narrative marketing page at `/` (spec `docs/superpowers/specs/2026-09-13-landing-page-design.md`). Fully static — no API routes, no server state, no database.

## Ownership

- `repo-url.ts` — the canonical repo URL constants (`REPO_URL`, `REPO_CLONE_URL`). The ONLY place the URL literal exists.
- `BrowserFrame.tsx` — shared light-chrome browser mockup (fixed-aspect viewport, `crop="bottom"` treatment for screenshot artifacts per spec §6).
- `LandingHeader.tsx` — fixed header: logo, anchor nav (`LANDING_SECTIONS` export = the anchor-id source of truth), GitHub star, `/app` CTA; lenis anchor scrolling with native fallback.
- `LandingFooter.tsx` — minimal footer: logo, AGPL-3.0 line, GitHub link.
- `Hero.tsx` — 100vh opener: balanced h1, typing prompt, dual CTA, tool-call marquee, parallax BrowserFrame.
- `MagicSequence.tsx` — sticky scroll crossfade (hero-build → dashboard-complete).
- `FeatureGallery.tsx` — bento grid + full-width attention-heatmap parallax band.
- `TrustLoop.tsx` — approval-dialog screenshot + the four verbatim trust bullets (spec §5.4 copy is approved — do not reword).
- `HowItWorks.tsx` — CSS/flex prompt→agent→tools→canvas diagram, NumberFlow stats (60+/28), mono chips.
- `OpenSourceFinale.tsx` — clone command (plain `<pre>` + copy button + BorderBeam), star button, final CTA.
- `SmoothScroll.tsx` — lenis provider that renders children bare under `prefers-reduced-motion`.

## Local Contracts

- **No workspace imports.** Nothing from `src/components/canvas|sessions|settings|design-systems`, `src/lib/agent|canvas|settings|sessions`, or `src/hooks` may be imported. Allowed: `next/*`, `motion/react`, `lenis/react`, `lucide-react`, `react`, `react-type-animation`, `@number-flow/react`, `react-wrap-balancer`, `@/components/ui/*` (incl. the five Magic UI files), `@/lib/utils`.
- **Dark-first**: rendered inside the landing root's `.dark` subtree (`src/app/page.tsx`) — never add a theme toggle here; the workspace stays light (spec §9).
- **Tokens**: reuse `--ac-*` + `.ac-brand-gradient`; no parallel token system, no raw palette classes.
- **Motion**: `transform`/`opacity` only; every behavior has a `useReducedMotion()` static fallback (parallax off, static final screenshot, static chip row, full prompt, bare children from SmoothScroll).
- **Copy is spec-frozen**: the §5.1 headline/subline and §5.4/§5.5/§5.6 content were approved verbatim with the owner — changes need a spec update first.
- **Section ids are API**: `top`, `magic`, `tool`, `trust`, `how-it-works`, `open-source` — `LANDING_SECTIONS` in `LandingHeader.tsx` must stay in sync; `tests/unit/landing-page.test.tsx` guards them.

## Work Guidance

- New sections get their own file here + a test in `tests/unit/landing-*.test.tsx` following the existing mock pattern (`next/image` → `<img>`, `motion/react`'s `useReducedMotion` → controllable `vi.fn` re-armed in `beforeEach`, `@number-flow/react` → span).
- Screenshot frames must use `BrowserFrame` — light chrome on the dark page (spec §6 light-on-dark contract); source screenshots are never edited, only CSS-cropped.

## Verification

- `bun run test tests/unit/landing-*.test.tsx tests/unit/landing-*.test.ts` — all landing suites green.
- `bunx tsc --noEmit` — typecheck.
- `bunx tsx scripts/screenshot-landing.ts` (dev server on :3000) — desktop/mobile/reduced-motion captures in `download/landing-verify/`; review against spec §5.

## Child DOX Index

No child `AGENTS.md` files. This folder is flat.
```

- [ ] **Step 2: Update `src/components/AGENTS.md`**

In the Purpose line, change "indexes the five component subfolders (canvas, sessions, settings, design-systems, ui)" to "indexes the six component subfolders (canvas, sessions, settings, design-systems, ui, landing)".

Add a row to the Child DOX Index table:

```markdown
| `landing/AGENTS.md` | Landing page UI: BrowserFrame + header/footer chrome, Hero, MagicSequence, FeatureGallery, TrustLoop, HowItWorks, OpenSourceFinale, SmoothScroll, repo-url constants |
```

- [ ] **Step 3: Update `src/app/AGENTS.md`**

In Ownership, replace the `- \`page.tsx\` — the main page. …` bullet's lead-in so the route ownership reflects the split. Concretely: keep the existing long `page.tsx` bullet's BODY (all the workspace behavior notes stay accurate) but change its opening to describe the new path, and add two new bullets right above it:

```markdown
- `page.tsx` — the LANDING page (2026-09-13): a server component exporting `metadata` (title "AgentCanvas — Figma for AI agents" + twitter card) and composing `src/components/landing/` — hero + header statically, the four below-fold sections via `next/dynamic`, everything inside `SmoothScroll` (lenis; disabled under prefers-reduced-motion) and a forced-`.dark` root div. Lazy `loading:` skeletons reserve height to avoid CLS.
- `opengraph-image.tsx` — `next/og` OG image (1200×630) for `/`; the file convention auto-injects og:image/twitter:image for the landing route.
- `app/page.tsx` — the WORKSPACE (moved verbatim from the old root `page.tsx` on 2026-09-13; sole edit: the header brand block links to `/`). All notes below about the workspace behavior apply to `app/page.tsx`.
```

Then rename the old bullet's identifier from `- \`page.tsx\` — the main page.` to `- \`app/page.tsx\` (continued) — the main workspace page.` and leave its body untouched.

- [ ] **Step 4: Update the root `AGENTS.md` sandbox line**

Find this line in "z.ai Sandbox Operations":

```
- Only port `:81` (Caddy gateway) is externally exposed: default → `:3000`, other ports via `?XTransformPort=<port>`. Browser code uses relative URLs only. The only user-visible route is `/`; users preview via the Preview Panel, never localhost links.
```

Replace the route clause so the line reads:

```
- Only port `:81` (Caddy gateway) is externally exposed: default → `:3000`, other ports via `?XTransformPort=<port>`. Browser code uses relative URLs only. `/` is the landing page and `/app` is the workspace (both user-visible); users preview via the Preview Panel, never localhost links.
```

- [ ] **Step 5: Fix the README clone command**

In `README.md` line 172, replace:

```
git clone https://github.com/kanishka-namdeo/AgentCanvas.git
```

with:

```
git clone https://github.com/kanishka-namdeo/co-canvas.git
```

- [ ] **Step 6: Update `docs/AGENTS.md` spec status**

In `docs/AGENTS.md`, replace the landing spec ownership row (the line starting `- \`superpowers/specs/2026-09-13-landing-page-design.md\``) with:

```markdown
- `superpowers/specs/2026-09-13-landing-page-design.md` — Landing page design spec: cinematic scroll-landing at `/` (6 sections, motion v12 + lenis + Magic UI), workspace moved verbatim to `src/app/app/page.tsx`. Status: Implemented (2026-09-13); plan `superpowers/plans/2026-09-13-landing-page.md`, tested by `tests/unit/landing-*.test.ts(x)` + `scripts/screenshot-landing.ts` visual pass. NOTE: the spec's `number-flow-react` dep name is a typo — the real package is `@number-flow/react`.
```

- [ ] **Step 7: Update `tests/AGENTS.md`**

Add rows to the Vitest unit-test table for the nine new test files:

```markdown
| `landing-assets.test.ts` | Landing Task 1 contract: the 6 `public/landing/` media assets exist, package.json declares the 5 landing deps with `motion` pinned to ^12, and the 5 Magic UI primitives are installed in `src/components/ui/`. |
| `landing-routes.test.ts` | Landing Task 2 contract: the workspace lives at `src/app/app/page.tsx` as a verbatim `'use client'` tabbed layout with no metadata export, and only the brand block is editable (links to `/` via `next/link`). |
| `landing-primitives.test.tsx` | repo-url constants (canonical URL single source), BrowserFrame (default/`4 / 3` aspect, `crop="bottom"` fade), LandingHeader (logo alt, 5 section anchors, star + `/app` CTAs), LandingFooter (AGPL line + GitHub link). |
| `landing-hero.test.tsx` | Hero (§5.1): h1 + subline, dual CTA hrefs, hero-build image alt/dims (3840×2400), marquee + typing presence; reduced-motion variants render the static prompt + static chip row. |
| `landing-magic-sequence.test.tsx` | MagicSequence (§5.2): section id, 3 steps, both crossfade layers present, `4 / 3` + `crop="bottom"` framing; reduced-motion renders only the final screenshot. |
| `landing-gallery-trust.test.tsx` | FeatureGallery (§5.3) bento cards + attention-heatmap band (alt/dims) and TrustLoop (§5.4) approval-dialog + the 4 verbatim bullets; reduced-motion static variants. |
| `landing-how-it-works-finale.test.tsx` | HowItWorks (§5.5) flow boxes + NumberFlow stats counting 0→60+/28 (fake timers) + mono chips; OpenSourceFinale (§5.6) clone command from REPO_URL, clipboard copy state flip, star + `/app` CTAs. |
| `landing-page.test.tsx` | The `/` shell: metadata (title + twitter card), all 6 section ids, header/footer presence, forced `.dark` root, lenis provider wrapper, exactly one h1. |
| `landing-og-image.test.ts` | `src/app/opengraph-image.tsx` exports alt text, 1200×630 size, png content type, and builds the ImageResponse with the declared size. |
```

Also update the `tests/setup.ts` bullet in that doc to append: "Also polyfills `IntersectionObserver` (immediate-fire stub) since 2026-09-13 — motion's `whileInView` needs it under jsdom."

- [ ] **Step 8: Update `scripts/AGENTS.md`**

Add an Ownership bullet:

```markdown
- `screenshot-landing.ts` — Playwright script for the landing page (2026-09-13): desktop 1440×900 full-page + per-section (id-anchored: top/magic/tool/trust/how-it-works/open-source), mobile 390×844 full-page, and a `prefers-reduced-motion: reduce` emulation pass over the hero. Output to `download/landing-verify/`. Run via `bunx tsx scripts/screenshot-landing.ts` with the dev server on `:3000`.
```

- [ ] **Step 9: Create `scripts/screenshot-landing.ts`**

```typescript
// Landing-page visual verification (2026-09-13) — modeled on
// scripts/screenshot-ui-after.ts (same Playwright setup + output
// convention per scripts/AGENTS.md, viewport default 1440x900).
//
// Captures, into download/landing-verify/:
//   01-desktop-full.png      desktop 1440x900 full page
//   02..06-desktop-<id>.png  per-section viewport shots (id-anchored)
//   07-mobile-full.png       mobile 390x844 full page
//   08-reduced-motion.png    hero under prefers-reduced-motion: reduce
//
// Run: bunx tsx scripts/screenshot-landing.ts   (dev server on :3000)

import { chromium } from 'playwright-core';
import * as fs from 'fs';
import * as path from 'path';

// Output relative to the repo root (scripts/AGENTS.md rule) — NOT the
// hardcoded sandbox path the older screenshot script uses.
const OUT_DIR = path.resolve(process.cwd(), 'download/landing-verify');
const BASE_URL = 'http://127.0.0.1:3000/';

const SECTION_IDS = ['top', 'magic', 'tool', 'trust', 'how-it-works', 'open-source'];

// playwright-core ships without browsers; try the default registry first,
// then system Chrome, then system Edge (Windows dev machines always have
// Edge; the sandbox has the default registry browsers).
async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true });
  } catch {
    try {
      return await chromium.launch({ headless: true, channel: 'chrome' });
    } catch {
      return await chromium.launch({ headless: true, channel: 'msedge' });
    }
  }
}

function twoDigit(index: number): string {
  return index < 10 ? `0${index}` : `${index}`;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await launchBrowser();

  // ── Desktop pass ──────────────────────────────────────────────────────
  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await desktop.newPage();
  console.log('→ navigating to', BASE_URL);
  await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30_000 });
  // Let React hydrate + the dynamic sections land.
  await page.waitForTimeout(3000);

  await page.screenshot({ path: path.join(OUT_DIR, '01-desktop-full.png'), fullPage: true });
  console.log('✓ 01-desktop-full.png');

  let shotIndex = 2;
  for (const id of SECTION_IDS) {
    const section = page.locator(`#${id}`);
    await section.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(600); // let whileInView reveals settle
    await page.screenshot({ path: path.join(OUT_DIR, `${twoDigit(shotIndex)}-desktop-${id}.png`) });
    console.log(`✓ ${twoDigit(shotIndex)}-desktop-${id}.png`);
    shotIndex += 1;
  }
  await desktop.close();

  // ── Mobile pass (spec §10: simplified animations, same content order) ─
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
  });
  const mobilePage = await mobile.newPage();
  await mobilePage.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30_000 });
  await mobilePage.waitForTimeout(3000);
  await mobilePage.screenshot({ path: path.join(OUT_DIR, `${twoDigit(shotIndex)}-mobile-full.png`), fullPage: true });
  console.log(`✓ ${twoDigit(shotIndex)}-mobile-full.png`);
  shotIndex += 1;
  await mobile.close();

  // ── Reduced-motion pass (spec §10 static fallbacks) ───────────────────
  const reduced = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
  });
  const reducedPage = await reduced.newPage();
  await reducedPage.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30_000 });
  await reducedPage.waitForTimeout(1500);
  await reducedPage.screenshot({ path: path.join(OUT_DIR, `${twoDigit(shotIndex)}-reduced-motion.png`) });
  console.log(`✓ ${twoDigit(shotIndex)}-reduced-motion.png`);
  await reduced.close();

  await browser.close();
  console.log('\nAll screenshots saved to', OUT_DIR);
}

main().catch((e) => {
  console.error('Screenshot script failed:', e);
  process.exit(1);
});
```

- [ ] **Step 10: Run the FULL test suite**

Run: `bun run test`
Expected: all landing suites pass and the pre-existing suite stays green (baseline per `tests/AGENTS.md`: ~2611 tests passing; two PRE-EXISTING failures — `agent-optimization-2026-09-05.test.ts` and `design-consistency-2026-09-06.test.ts` — are known and NOT regressions; rerun any flaky file in isolation before treating a failure as real). Report the exact final counts.

- [ ] **Step 11: Typecheck + lint**

Run: `bunx tsc --noEmit && bun run lint`
Expected: clean.

- [ ] **Step 12: Visual verification**

```bash
bun run dev          # Windows; in the sandbox: bash scripts/start-dev.sh
bunx tsx scripts/screenshot-landing.ts
```

Expected: 9 PNGs in `download/landing-verify/`. Review each against spec §5: hero (h1, CTAs, frame, chips), the sticky sequence (crossfade mid-scroll), bento + heatmap band, approval demo, diagram + stats, finale, mobile stacking, and the reduced-motion shot (static hero, full prompt, no parallax). Fix any visual defect found, re-running the relevant test + screenshot. (Screenshot artifacts land under `download/` which is transient — do not commit them.)

- [ ] **Step 13: Sandbox archive refresh (only when running in the z.ai sandbox)**

```bash
bash scripts/setup-zai-sandbox.sh --archive
```

Expected: `/home/sync/repo.tar` refreshed so the landing survives a container restart. Skip on dev machines/CI.

- [ ] **Step 14: Commit all docs + the screenshot script**

```bash
git add src/components/landing/AGENTS.md src/components/AGENTS.md src/app/AGENTS.md AGENTS.md README.md docs/AGENTS.md tests/AGENTS.md scripts/AGENTS.md scripts/screenshot-landing.ts
git commit -m "docs: landing page DOX pass, canonical README clone URL, screenshot harness"
```

---

## Summary

This plan implements the approved landing-page spec (docs/superpowers/specs/2026-09-13-landing-page-design.md) in 10 tasks:

1. **Dependencies + assets + Magic UI** — bun installs (motion pinned @12, lenis, react-type-animation, `@number-flow/react`, react-wrap-balancer), 6 assets copied to `public/landing/`, 5 Magic UI primitives via the shadcn CLI.
2. **Route move** — workspace verbatim to `/app`, brand links back to `/`.
3. **Primitives** — repo-url, BrowserFrame (light chrome + bottom crop), LandingHeader (anchors + CTAs), LandingFooter.
4. **Hero** — balanced h1, typing prompt, dual CTA, chip marquee, parallax mockup; full reduced-motion fallbacks.
5. **MagicSequence** — sticky scroll crossfade with CSS bottom-crop framing.
6. **FeatureGallery + TrustLoop** — bento grid, heatmap parallax band, approval demo + verbatim trust copy.
7. **HowItWorks + OpenSourceFinale** — CSS diagram, NumberFlow stats, clone block with copy + BorderBeam.
8. **Shell** — new `/` with metadata, forced-dark tokens, lenis SmoothScroll, dynamic below-fold sections.
9. **OG image** — next/og 1200×630 + twitter card.
10. **DOX pass + README + verification** — full suite, typecheck, lint, Playwright visual sign-off, sandbox archive refresh.

**Deviations from the spec text (documented):**
- The spec's dependency name `number-flow-react` does not exist on npm — this plan installs `@number-flow/react` (the actual NumberFlow React package) and records the correction in `docs/AGENTS.md`.
- `src/components/landing/` carries two files beyond the spec's 9-file sketch: `repo-url.ts` (required by spec §3's "define the URL once") and `SmoothScroll.tsx` (the client wrapper required to keep `src/app/page.tsx` a metadata-exporting server component while mounting lenis).
- `tests/setup.ts` gains an IntersectionObserver stub (motion's `whileInView` needs it under jsdom).

**Files touched:** ~30 (12 source/component files, 9 test files, 1 script, 7 docs).
**Estimated effort:** 1–2 sessions of subagent-driven work; each task is independently committed and testable.
