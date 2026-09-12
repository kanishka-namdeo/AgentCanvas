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
