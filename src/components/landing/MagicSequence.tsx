'use client';

import { useRef } from 'react';
import Image from 'next/image';
import { motion, useScroll, useTransform, useReducedMotion } from 'motion/react';
import { TypeAnimation } from 'react-type-animation';
import { BlurFade } from '@/components/ui/blur-fade';
import { BrowserFrame } from './BrowserFrame';

const MAGIC_PROMPT = 'Design a dashboard with KPI cards…';

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
                {step.index === '01' && (
                  /* Spec §5.2 step 1: the prompt types itself out.
                      react-type-animation has no reduced-motion handling of
                      its own → static full-prompt fallback (Hero pattern). */
                  <p className="mt-3 text-xs text-white/80 [font-family:var(--font-geist-mono),monospace]">
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
