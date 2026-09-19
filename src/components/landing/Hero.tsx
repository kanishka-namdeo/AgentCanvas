'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import Balancer from 'react-wrap-balancer';
import { TypeAnimation } from 'react-type-animation';
import { motion, useInView, useScroll, useTransform, useReducedMotion } from 'motion/react';
import { ArrowRight, Star } from 'lucide-react';
import { Marquee } from '@/components/ui/marquee';
import { BrowserFrame } from './BrowserFrame';
import { REPO_URL } from './repo-url';
import { GitHubStars, hasStars } from './GitHubStars';
import { setVideoPlaying } from './video-playback';

/** The typed sample prompt (spec §5.1 — a real, representative prompt). */
// The hero tells ONE story: this prompt is the one the footage and the
// finished still both show (the build-reveal capture types it verbatim), so
// the typed line, the playing video, and the reduced-motion poster agree.
const TYPED_PROMPT =
  'Build a modern analytics dashboard with a dark sidebar, three KPI cards, a revenue chart…';

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

/** 100vh cinematic opener (spec §5.1). `stars` comes from the server fetch
 * (GitHubStars contract) — the proof row hides just the star segment when the
 * GitHub API was unavailable, never rendering a fabricated count. */
export function Hero({ stars }: { stars?: number | null }) {
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

  // The video layer decodes only while the frame is on screen — offscreen it
  // would keep an autoplay loop running for nothing. `useInView` is called
  // unconditionally (hooks); the reduced-motion branch renders no <video>, so
  // the effect is a no-op there.
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameInView = useInView(frameRef, { amount: 0.2 });
  useEffect(() => {
    setVideoPlaying(videoRef.current, frameInView);
  }, [frameInView]);

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
        AgentCanvas — Design that draws itself.
      </p>

      {/* The page's single h1, balanced with react-wrap-balancer. The sub-tagline
          carries the workflow rhythm (research report Angle 3): describe the
          screen, direct the agent, refine the result. */}
      <Balancer as="h1" className="max-w-3xl text-balance text-5xl font-semibold tracking-tight text-white md:text-6xl">
        Describe. Direct. Refine.
      </Balancer>

      <p className="mt-5 max-w-2xl text-lg text-white/70">
        The open-source canvas where the AI agents do the drawing — and you direct.
      </p>

      {/* One specific proof point above the fold (benchmark P1/R3): a single
          muted mono row — live star count + hard product numbers. */}
      <p
        data-testid="hero-proof-row"
        className="mt-4 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm text-white/60 [font-family:var(--font-geist-mono),monospace]"
      >
        {hasStars(stars) && <GitHubStars stars={stars} className="text-white/70" />}
        {hasStars(stars) && <span aria-hidden="true">·</span>}
        <span>AGPL-3.0</span>
        <span aria-hidden="true">·</span>
        <span>60+ tools</span>
        <span aria-hidden="true">·</span>
        <span>28 providers</span>
      </p>

      {/* Typing effect on the prompt fragment (spec §5.1). react-type-animation
          has no reduced-motion handling of its own → static fallback branch.
          min-h-10 reserves two lines on mobile so the delete/retype cycle
          cannot shift the CTAs (audit #12 mobile CLS). */}
      <p className="mt-6 min-h-10 text-sm text-white/80 [font-family:var(--font-geist-mono),monospace] md:min-h-5">
        <span aria-hidden="true" className="ac-brand-gradient ac-cta-gradient mr-2 rounded px-1.5 py-0.5 text-white">
          prompt
        </span>
        {shouldReduceMotion ? (
          <span data-testid="hero-typing-static">{TYPED_PROMPT}</span>
        ) : (
          <span data-testid="hero-typing">
            <TypeAnimation
              sequence={[TYPED_PROMPT, 2500]}
              wrapper="span"
              speed={44}
              repeat={Infinity}
              cursor
            />
          </span>
        )}
      </p>

      {/* Dual CTA (spec §5.1): gradient primary + ghost canvas link. The
          ac-cta-gradient overlay keeps the label at AA contrast (audit #11). */}
      <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
        <a
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="hero-star"
          className="ac-brand-gradient ac-cta-gradient inline-flex items-center gap-2 rounded-full px-6 py-3 text-sm font-semibold text-white shadow-lg transition-transform hover:scale-[1.03]"
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
          reduced motion (spec §10). The loop duplicates every chip 4×, so the
          marquee is aria-hidden and screen readers get the list once. */}
      {shouldReduceMotion ? (
        <div data-testid="hero-chips-static" className="mt-10 flex max-w-3xl flex-wrap justify-center gap-2 overflow-hidden">
          {TOOL_CALLS.map((tool) => (
            <ToolCallChip key={tool} tool={tool} />
          ))}
        </div>
      ) : (
        <div data-testid="hero-chips" className="mt-10 w-full max-w-3xl overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_15%,black_85%,transparent)]">
          <p className="sr-only">Tool calls the agent runs live: {TOOL_CALLS.join(', ')}.</p>
          <div aria-hidden="true">
            <Marquee pauseOnHover className="[--duration:40s]">
              {TOOL_CALLS.map((tool) => (
                <ToolCallChip key={tool} tool={tool} />
              ))}
            </Marquee>
          </div>
        </div>
      )}

      {/* Foreground: tilted browser mockup with the build-reveal POSTER
          (1600x1000 = the frame's exact 16/10 box) + parallax. The still, the
          typed prompt above, and the video overlay are the same story: the
          dashboard from the prompt, mid-assembly here and finished on screen.
          The frame slot is max-w-4xl (896px); sizes keeps next/image from
          serving an oversized variant for this LCP element, and fetchPriority
          hoists it above the lazy below-fold requests.

          The 2026-09-19 video pass drops the build-reveal cut over the SAME
          viewport: zero-crop `absolute inset-0 object-cover` overlay, nothing
          under it moves. The next/image stays the LCP element and the
          no-JS/reduced-motion visual; the <video> is decorative (aria-hidden)
          and only mounted when motion is allowed. */}
      <div ref={frameRef} className="relative mt-14 w-full max-w-4xl [perspective:1200px]">
        <motion.div style={applyParallax ? { y: frameY } : undefined}>
          <BrowserFrame className="md:[transform:rotateX(4deg)]">
            <Image
              src="/landing/build-reveal-poster.png"
              alt="AgentCanvas building an analytics dashboard live on the canvas"
              width={1600}
              height={1000}
              sizes="(max-width: 767px) 100vw, 896px"
              priority
              fetchPriority="high"
              className="h-auto w-full object-cover"
            />
            {!shouldReduceMotion && (
              <video
                ref={videoRef}
                data-testid="hero-video"
                src="/landing/build-reveal.mp4"
                poster="/landing/build-reveal-poster.png"
                muted
                loop
                playsInline
                autoPlay
                preload="metadata"
                aria-hidden="true"
                tabIndex={-1}
                className="absolute inset-0 h-full w-full object-cover"
              />
            )}
          </BrowserFrame>
        </motion.div>
      </div>
    </section>
  );
}
