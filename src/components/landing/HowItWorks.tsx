'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import NumberFlow from '@number-flow/react';
import { useInView, useReducedMotion } from 'motion/react';
import { BlurFade } from '@/components/ui/blur-fade';

const FLOW = [
  { id: 'prompt', label: 'Prompt', detail: 'plain-language brief' },
  { id: 'agent', label: 'Agent', detail: 'plans + executes' },
  { id: 'tools', label: 'Tools', detail: 'typed operations' },
  { id: 'canvas', label: 'Canvas', detail: 'live design' },
] as const;

const TOOL_COUNT = 60;
const PROVIDER_COUNT = 28;

const DEV_CHIPS = [
  'Portable canvas format',
  'Sessions + snapshots',
  'Socket.IO realtime',
  'Copy as HTML / React / Tailwind',
] as const;

/** Developer depth (spec §5.5) — the handoff point from designer-magic to
 * developer-substance. Pure CSS/flex diagram, no images; Geist Mono labels
 * via the --font-geist-mono variable loaded in src/app/layout.tsx.
 *
 * Stats (2026-09-19 uplift, audit #6): SSR/no-JS/reduced-motion all render
 * the FINAL values — the old 0-then-count-up shipped "0 typed tools" in the
 * SSR HTML, which crawlers indexed. When the row first approaches the
 * viewport (and motion is allowed), the counters remount at 0 and count up to
 * the same final values — the truth is on screen at every moment. */
export function HowItWorks() {
  const shouldReduceMotion = useReducedMotion();
  const statsRef = useRef<HTMLDivElement>(null);
  const [tools, setTools] = useState(0);
  const [providers, setProviders] = useState(0);

  // 'final' = static true values (SSR / no-JS / reduced-motion). 'count' =
  // remounted counters animating 0 → final after the row comes into view.
  // Derived from useInView (once) — no effect-driven mode state needed.
  const inView = useInView(statsRef, { once: true, margin: '200px' });
  const counting = Boolean(inView) && !shouldReduceMotion;

  // Approaching the stats triggers the count-up (200px before entry, so the
  // reset to 0 happens essentially offscreen).
  useEffect(() => {
    if (!counting) return;
    const timer = setTimeout(() => {
      setTools(TOOL_COUNT);
      setProviders(PROVIDER_COUNT);
    }, 50);
    return () => clearTimeout(timer);
  }, [counting]);

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

        {/* Stats — final values server-side; count-up only as an enhancement. */}
        <div ref={statsRef} className="mt-12 flex flex-wrap items-end gap-12" data-testid="stats">
          {counting ? (
            <>
              <div>
                <NumberFlow
                  key="flow-tools"
                  value={tools}
                  suffix="+"
                  data-testid="stat-tools"
                  className="text-5xl font-semibold text-white"
                />
                <p className="mt-1 text-sm text-white/50">typed tools</p>
              </div>
              <div>
                <NumberFlow
                  key="flow-providers"
                  value={providers}
                  data-testid="stat-providers"
                  className="text-5xl font-semibold text-white"
                />
                <p className="mt-1 text-sm text-white/50">LLM providers</p>
              </div>
            </>
          ) : (
            <>
              <div>
                <NumberFlow
                  value={TOOL_COUNT}
                  suffix="+"
                  data-testid="stat-tools"
                  className="text-5xl font-semibold text-white"
                />
                <p className="mt-1 text-sm text-white/50">typed tools</p>
              </div>
              <div>
                <NumberFlow
                  value={PROVIDER_COUNT}
                  data-testid="stat-providers"
                  className="text-5xl font-semibold text-white"
                />
                <p className="mt-1 text-sm text-white/50">LLM providers</p>
              </div>
            </>
          )}
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
