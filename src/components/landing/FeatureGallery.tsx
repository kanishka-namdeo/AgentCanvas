'use client';

import { useEffect, useRef } from 'react';
import Image from 'next/image';
import { Command, History, Layers, Palette, Sparkles, Braces, Wand2 } from 'lucide-react';
import { motion, useInView, useScroll, useTransform, useReducedMotion } from 'motion/react';
import { BentoCard, BentoGrid } from '@/components/ui/bento-grid';
import { BlurFade } from '@/components/ui/blur-fade';
import { BrowserFrame } from './BrowserFrame';
import { setVideoPlaying } from './video-playback';

/* Bento tiles (expanded 2 → 5 in the 2026-09-19 uplift, benchmark P7/R8):
 * the four differentiators the page previously buried in one HowItWorks chip
 * row each get a tile. Every tile: visible icon, real copy, ALWAYS-visible
 * CTA (href /app). "background" is a low-opacity wash (+ optional mono
 * visual) that sits behind the copy — BentoCard renders it absolutely. */
const BENTO_CARDS = [
  {
    name: 'Figma-grade tooling',
    Icon: Layers,
    className: 'md:col-span-2',
    description:
      'Layers, properties, components, auto layout, variables, and gradients — the full design-tool surface, operated by the agent.',
    background: (
      <div className="ac-brand-gradient absolute inset-0 opacity-[0.08]" aria-hidden="true" />
    ),
  },
  {
    name: 'One-shot generators',
    Icon: Sparkles,
    className: 'col-span-1',
    description:
      'Flows, wireframes, and mindmaps appear from a single prompt — then stay fully editable on the canvas.',
    background: (
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_20%,rgba(217,70,239,0.15),transparent_60%)]" aria-hidden="true" />
    ),
  },
  {
    name: 'Design systems built in',
    Icon: Palette,
    className: 'col-span-1',
    description:
      'Five production token packs ship in the box — pick one and every generated screen speaks the same visual language.',
    background: (
      <div
        aria-hidden="true"
        className="absolute bottom-5 right-5 flex gap-1.5 opacity-70"
      >
        {['bg-violet-500', 'bg-fuchsia-500', 'bg-sky-500', 'bg-emerald-500', 'bg-amber-500'].map(
          (color) => (
            <span key={color} className={`h-6 w-6 rounded-md ${color}`} />
          ),
        )}
      </div>
    ),
  },
  {
    name: '.pen file format',
    Icon: Braces,
    className: 'col-span-1',
    description:
      'Every canvas is a portable .pen document — 20 node types, diffable and restorable, never locked in a black box.',
    background: (
      <pre
        aria-hidden="true"
        className="absolute bottom-5 right-5 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-left text-[10px] leading-relaxed text-white/50 [font-family:var(--font-geist-mono),monospace]"
      >
        {'{\n  "type": "frame",\n  "layout": "flex"\n}'}
      </pre>
    ),
  },
  {
    name: 'Sessions & snapshots',
    Icon: History,
    className: 'col-span-1',
    description:
      'Every run is a recorded session and every approved change is a restorable snapshot — fork any point in time.',
    background: (
      <div aria-hidden="true" className="absolute bottom-6 right-5 flex items-center gap-2 opacity-70">
        {[0, 1, 2, 3].map((dot) => (
          <span key={dot} className="flex flex-col items-center gap-1">
            <span className={`h-2 w-2 rounded-full ${dot === 3 ? 'bg-fuchsia-400' : 'bg-violet-400/50'}`} />
            {dot < 3 && <span className="h-px w-4 bg-white/20" />}
          </span>
        ))}
      </div>
    ),
  },
] as const;

/* "Product in motion" 2-up row (2026-09-19 video pass, capture-selection.md
 * §4): the two screen recordings that actually prove the tooling, side by
 * side in 16/10 frames. Both cuts are 1600x1000 = exactly 16/10, so the
 * frames carry them uncropped. The videos are decorative; the captions carry
 * the meaning (they are the accessible text in BOTH branches). */
const MOTION_TILES = [
  {
    id: 'tooling',
    Icon: Command,
    src: '/landing/tooling-tour.mp4',
    poster: '/landing/tooling-tour-poster.png',
    caption:
      'The tooling, live: ⌘K command palette, layers reparented by drag, property edits, and snapping guides.',
  },
  {
    id: 'design-pack',
    Icon: Palette,
    src: '/landing/design-pack.mp4',
    poster: '/landing/design-pack-poster.png',
    caption:
      'Pick a design system pack — every screen on the canvas follows its tokens.',
  },
] as const;

/** Real design tool — credibility for designers (spec §5.3). */
export function FeatureGallery() {
  const shouldReduceMotion = useReducedMotion();
  const bandRef = useRef<HTMLDivElement>(null);
  const motionRowRef = useRef<HTMLDivElement>(null);
  const videoRefs = useRef<Array<HTMLVideoElement | null>>([]);

  const { scrollYProgress } = useScroll({
    target: bandRef,
    offset: ['start end', 'end start'],
  });
  const bandY = useTransform(scrollYProgress, [0, 1], [-32, 32]);

  // ONE visibility source for the whole row: both clips play while the row is
  // on screen and are paused together once it leaves (no offscreen decoding,
  // no per-frame observers). Unconditional hook — the reduced-motion branch
  // renders no <video>, so the effect is a no-op there.
  const rowInView = useInView(motionRowRef, { amount: 0.2 });
  useEffect(() => {
    for (const video of videoRefs.current) setVideoPlaying(video, rowInView);
  }, [rowInView]);

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
          <BentoGrid className="grid-cols-1 md:grid-cols-3">
            {BENTO_CARDS.map((card) => (
              <BentoCard
                key={card.name}
                name={card.name}
                className={card.className}
                background={card.background}
                Icon={card.Icon}
                description={card.description}
                href="/app"
                cta="Open the canvas"
              />
            ))}
          </BentoGrid>
        </BlurFade>

        {/* Product in motion — two screen recordings, one frame each.
            preload="none" keeps ~1.3 MB of MP4 off the wire until the row is
            actually reached; the poster is the paint until then. */}
        <div
          ref={motionRowRef}
          data-testid="gallery-motion-row"
          className="mt-12 grid gap-6 md:grid-cols-2"
        >
          {MOTION_TILES.map((tile, index) => (
            <div key={tile.id}>
              <BrowserFrame aspectRatio="16 / 10">
                {shouldReduceMotion ? (
                  <div className="absolute inset-0">
                    <Image
                      data-testid={`gallery-poster-${tile.id}`}
                      src={tile.poster}
                      alt=""
                      aria-hidden="true"
                      width={1600}
                      height={1000}
                      sizes="(max-width: 767px) 100vw, 576px"
                      className="h-full w-full object-cover"
                    />
                  </div>
                ) : (
                  <video
                    ref={(element) => {
                      videoRefs.current[index] = element;
                    }}
                    data-testid={`gallery-video-${tile.id}`}
                    src={tile.src}
                    poster={tile.poster}
                    muted
                    loop
                    playsInline
                    preload="none"
                    aria-hidden="true"
                    tabIndex={-1}
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                )}
              </BrowserFrame>
              <p
                data-testid={`gallery-caption-${tile.id}`}
                className="mt-4 flex items-center justify-center gap-2 text-center text-sm text-white/50"
              >
                <tile.Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                {tile.caption}
              </p>
            </div>
          ))}
        </div>

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
                  sizes="(max-width: 767px) 100vw, 1152px"
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
