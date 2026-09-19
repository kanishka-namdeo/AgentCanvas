'use client';

import { useRef, useState } from 'react';
import Image from 'next/image';
import {
  motion,
  useMotionValueEvent,
  useScroll,
  useTransform,
  useReducedMotion,
} from 'motion/react';
import { TypeAnimation } from 'react-type-animation';
import { BlurFade } from '@/components/ui/blur-fade';
import { BrowserFrame } from './BrowserFrame';
import { AgentTimeline } from './AgentTimeline';

/* Aligned with what the adjacent screenshot actually shows (internal audit
 * #b-10: the frame shows the hero-section build — the old dashboard prompt
 * contradicted the visual). */
const MAGIC_PROMPT = 'Design a hero section with a gradient headline…';

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

/* Scroll-telling ranges over the track's 0→1 progress. The track is 250vh so
 * the sticky grid pins for ~1.5 viewports of travel and the progress spans
 * the full traverse (the old ~470px grid made progress degenerate — the
 * dashboard layer peaked at 0.26 opacity and never completed). */
const BUILD_FADE = [0, 0.2, 0.34] as const;
const WORK_IN = [0.2, 0.34] as const;
const WORK_OUT = [0.52, 0.66] as const;
const DONE_IN = [0.52, 0.66] as const;

/** The Magic — 3-state sticky scroll-telling core (spec §5.2, rebuilt in the
 * 2026-09-19 landing-uplift): a 250vh scroll track pins the step grid (CSS
 * position:sticky on md+), and the track's useScroll progress crossfades
 * THREE stacked layers — hero-build (01 prompt) → AgentTimeline mock (02
 * working) → dashboard-complete (03 result) — while `useMotionValueEvent`
 * highlights the active step. The frame layers are absolutely stacked, so the
 * later video pass can drop a <video> layer in without re-architecting.
 * Both screenshot frames use aspect 4 / 3 + object-top so the dashboard
 * screenshot's bottom edge (the "202 Issues" toast) is cropped out in CSS
 * (spec §6). */
export function MagicSequence() {
  const shouldReduceMotion = useReducedMotion();
  const trackRef = useRef<HTMLDivElement>(null);
  const [activeStep, setActiveStep] = useState(0);

  const { scrollYProgress } = useScroll({
    target: trackRef,
    offset: ['start start', 'end end'],
  });
  const buildOpacity = useTransform(scrollYProgress, [...BUILD_FADE], [1, 1, 0]);
  const workOpacity = useTransform(
    scrollYProgress,
    [...WORK_IN, ...WORK_OUT],
    [0, 1, 1, 0],
  );
  const doneOpacity = useTransform(scrollYProgress, [...DONE_IN], [0, 1]);

  useMotionValueEvent(scrollYProgress, 'change', (progress) => {
    setActiveStep(progress < 0.27 ? 0 : progress < 0.59 ? 1 : 2);
  });

  const stepTone = (index: number) =>
    activeStep === index && !shouldReduceMotion
      ? 'border-white/25 bg-white/10'
      : 'border-white/10 bg-white/5';

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

        {/* Tall scroll track — gives useScroll real room (250vh) so the sticky
            grid pins and the crossfade completes. On mobile the track stays
            auto-height (no pinning); the crossfade simply compresses. */}
        <div ref={trackRef} className="relative mt-12 md:h-[250vh]">
          <div className="grid items-start gap-10 md:sticky md:top-24 md:h-[calc(100vh-12rem)] md:content-center md:grid-cols-2">
            {/* Left column: the three steps; the active beat highlights. */}
            <ol className="space-y-6">
              {STEPS.map((step, index) => (
                <li
                  key={step.index}
                  data-testid={`magic-step-${step.index}`}
                  data-active={activeStep === index && !shouldReduceMotion ? 'true' : 'false'}
                  className={`rounded-xl border p-5 transition-colors duration-300 ${stepTone(index)}`}
                >
                  <div className="flex items-baseline gap-3">
                    <span className="text-xs text-white/60 [font-family:var(--font-geist-mono),monospace]">
                      {step.index}
                    </span>
                    <h3 className="text-base font-semibold text-white">{step.title}</h3>
                  </div>
                  <p className="mt-2 text-sm text-white/60">{step.body}</p>
                  {step.index === '01' && (
                    /* Spec §5.2 step 1: the prompt types itself out.
                        react-type-animation has no reduced-motion handling of
                        its own → static full-prompt fallback (Hero pattern).
                        min-h reserves one line so the delete/retype cycle
                        cannot shift layout on narrow screens. */
                    <p className="mt-3 min-h-4 text-xs text-white/80 [font-family:var(--font-geist-mono),monospace]">
                      {shouldReduceMotion ? (
                        <span data-testid="magic-typing-static">{MAGIC_PROMPT}</span>
                      ) : (
                        <span data-testid="magic-typing">
                          <TypeAnimation
                            sequence={[MAGIC_PROMPT, 2500]}
                            wrapper="span"
                            speed={44}
                            repeat={Infinity}
                            cursor
                          />
                        </span>
                      )}
                    </p>
                  )}
                  {step.index === '02' && (
                    <ul className="mt-3 space-y-1.5" aria-label="Agent task list">
                      {['Plan the layout structure', 'Build the components', 'Apply tokens and polish'].map(
                        (task) => (
                          <li key={task} className="flex items-center gap-2 text-xs text-white/50">
                            <span aria-hidden="true" className="ac-brand-gradient ac-cta-gradient flex h-3.5 w-3.5 items-center justify-center rounded-full text-[9px] font-bold text-white">
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

            {/* Right column: the pinned 3-layer browser frame. */}
            <div>
              {shouldReduceMotion ? (
                <BrowserFrame aspectRatio="4 / 3" crop="bottom">
                  <div data-testid="magic-final-static" className="absolute inset-0">
                    <Image
                      src="/landing/dashboard-complete.png"
                      alt="Completed dashboard design with the agent task list visible"
                      width={1280}
                      height={577}
                      sizes="(max-width: 767px) 100vw, 50vw"
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
                      sizes="(max-width: 767px) 100vw, 50vw"
                      className="h-full w-full object-cover object-top"
                    />
                  </motion.div>
                  <motion.div
                    data-testid="magic-frame-work"
                    style={{ opacity: workOpacity }}
                    className="absolute inset-0"
                  >
                    <AgentTimeline />
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
                      sizes="(max-width: 767px) 100vw, 50vw"
                      className="h-full w-full object-cover object-top"
                    />
                  </motion.div>
                </BrowserFrame>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
