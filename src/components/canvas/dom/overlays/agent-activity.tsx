'use client';

// AgentActivityOverlay — example registered overlay util demonstrating
// the tldraw OverlayUtil pattern (round 3 milestone 4).
//
// Renders a subtle pulsing halo around each shape in `highlightIds`
// (the runner sets these via agent:canvas_ui_action 'focus_shape' or
// when the agent mentions a shape by name in its message). The pulse
// gives the user a visual cue that "the agent is talking about this
// shape" without the noise of a full re-render.
//
// This overlay self-registers via registerOverlayUtil on first import.
// To disable it, comment out the import in `./index.ts`.

import { useMemo } from 'react';
import {
  registerOverlayUtil,
  type OverlayUtilProps,
} from '../overlay-registry';

export function AgentActivityOverlay({ layers, highlightIds, viewport }: OverlayUtilProps) {
  const highlighted = useMemo(
    () => layers.filter((l) => highlightIds.includes(l.id)),
    [layers, highlightIds],
  );
  if (highlighted.length === 0) return null;

  const { zoom, panX, panY } = viewport;
  return (
    <svg
      data-ac-overlay="agent-activity"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      aria-hidden
    >
      <defs>
        <filter id="agent-pulse" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3" />
        </filter>
      </defs>
      {highlighted.map((l) => {
        const sx = l.x * zoom + panX;
        const sy = l.y * zoom + panY;
        const sw = l.width * zoom;
        const sh = l.height * zoom;
        return (
          <rect
            key={l.id}
            x={sx - 4}
            y={sy - 4}
            width={sw + 8}
            height={sh + 8}
            rx={6}
            ry={6}
            fill="none"
            stroke="var(--ac-agent-pulse, hsl(280 90% 60%))"
            strokeWidth={2}
            filter="url(#agent-pulse)"
            opacity={0.7}
            style={{
              animation: 'ac-agent-pulse-anim 1.4s ease-in-out infinite',
            }}
          />
        );
      })}
      <style>{`
        @keyframes ac-agent-pulse-anim {
          0%, 100% { opacity: 0.4; stroke-width: 1.5; }
          50% { opacity: 0.9; stroke-width: 3; }
        }
        @media (prefers-reduced-motion: reduce) {
          [data-ac-overlay="agent-activity"] rect {
            animation: none;
            opacity: 0.7;
            stroke-width: 2;
          }
        }
      `}</style>
    </svg>
  );
}

/// Self-register on import. zIndex 11 — above the built-in selection
/// outlines (zIndex 0) and measure / guides (zIndex 10) but below the
/// resize handles (which render later via DomChrome's internal handles
/// block at zIndex 15). The halo is pointer-events: none by virtue of
/// the parent div, so it never blocks canvas interaction.
const unregister = registerOverlayUtil({
  id: 'agent-activity',
  zIndex: 11,
  Body: AgentActivityOverlay,
  isActive: ({ highlightIds }) => highlightIds.length > 0,
});

/// Hot-reload cleanup (Next.js dev mode).
if (typeof module !== 'undefined' && module.hot) {
  module.hot.dispose(() => unregister());
}
