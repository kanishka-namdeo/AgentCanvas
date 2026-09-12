'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import Balancer from 'react-wrap-balancer';
import { TypeAnimation } from 'react-type-animation';
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
