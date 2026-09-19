'use client';

import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';

/**
 * Diegetic agent-timeline mock (2026-09-19 landing-uplift): the Magic
 * sequence's "02 — agent working" state. Pure DOM + motion (no video, no
 * screenshot): tool-call rows appear sequentially on the LIGHT surface so it
 * reads as the product's agent panel inside the light-chrome BrowserFrame.
 * The whole feed loops (~6s cycle) like a live session; under
 * prefers-reduced-motion it renders the completed list statically.
 */

const TIMELINE = [
  { tool: 'plan_response', detail: '4 steps' },
  { tool: 'pen_create_frame', detail: 'hero shell' },
  { tool: 'pen_create_text', detail: 'headline + copy' },
  { tool: 'pen_set_gradient', detail: 'brand fill' },
  { tool: 'bulk_update', detail: 'spacing pass' },
  { tool: 'pen_bake_layout', detail: 'auto layout' },
] as const;

const STEP_S = 0.55;
const HOLD_MS = 1800;
const CYCLE_MS = TIMELINE.length * STEP_S * 1000 + HOLD_MS;

export function AgentTimeline() {
  const shouldReduceMotion = useReducedMotion();
  const [cycle, setCycle] = useState(0);

  useEffect(() => {
    if (shouldReduceMotion) return;
    const timer = setInterval(() => setCycle((c) => c + 1), CYCLE_MS);
    return () => clearInterval(timer);
  }, [shouldReduceMotion]);

  return (
    <div data-testid="agent-timeline" className="absolute inset-0 flex flex-col bg-white p-5">
      {/* Panel header — mirrors the product's agent chat header. */}
      <div className="mb-3 flex items-center justify-between border-b border-neutral-200 pb-2.5">
        <span className="text-xs font-semibold text-neutral-700 [font-family:var(--font-geist-mono),monospace]">
          agent
        </span>
        <span className="flex items-center gap-1.5 text-xs text-neutral-500">
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 rounded-full bg-emerald-500 ${shouldReduceMotion ? '' : 'animate-pulse'}`}
          />
          Working…
        </span>
      </div>
      <ol aria-label="Agent tool calls" className="space-y-2.5">
        {TIMELINE.map(({ tool, detail }, index) => (
          <motion.li
            // Keyed per cycle so the feed remounts and replays its stagger.
            key={`${cycle}-${tool}`}
            initial={shouldReduceMotion ? false : { opacity: 0, x: 14 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: index * STEP_S, duration: 0.28, ease: 'easeOut' }}
            className="flex items-center justify-between gap-3 rounded-lg border border-neutral-200 bg-white px-3 py-2"
          >
            <span className="text-xs font-medium text-neutral-700 [font-family:var(--font-geist-mono),monospace]">
              {tool}()
            </span>
            <span className="flex items-center gap-2 text-xs text-neutral-500">
              {detail}
              <span
                aria-hidden="true"
                className="ac-brand-gradient flex h-3.5 w-3.5 items-center justify-center rounded-full text-[9px] font-bold text-white"
              >
                ✓
              </span>
            </span>
          </motion.li>
        ))}
      </ol>
      {/* Composer strip — fills the frame's lower third the way the real
          agent panel does, using the product's own placeholder copy. Purely
          diegetic: not an input, hidden from assistive tech. */}
      <div
        aria-hidden="true"
        className="mt-auto flex items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-xs text-neutral-400 [font-family:var(--font-geist-mono),monospace]"
      >
        Ask the agent to design something…
      </div>
    </div>
  );
}
