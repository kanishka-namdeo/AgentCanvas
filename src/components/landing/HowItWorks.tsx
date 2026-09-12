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
