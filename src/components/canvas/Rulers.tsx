'use client';

// Rulers — Phase 7 §H.2 (spec docs/html-dom-renderer.md Appendix H.2).
//
// Top + left pixel rulers showing canvas-space coordinates with adaptive
// tick marks. Toggled via `settings.rulersVisible` (default off — View
// menu item). DOM-renderer-only feature; the SVG renderer would need its
// own implementation.
//
// Design (matches Figma UI3 ruler behavior at a high level):
//   - Top ruler: full-width strip, 18px tall, fixed at top of canvas
//   - Left ruler: full-height strip, 18px wide, fixed at left of canvas
//   - Top-left corner: 18×18 box where they meet (so neither overlaps)
//   - Tick marks: major every 100 canvas px (with label), minor every 20
//     canvas px (no label). At high zoom, ticks tighten to 50/10. At low
//     zoom, ticks loosen to 200/50. Adaptive: aim for ~80px between
//     major ticks on screen.
//   - Numbers represent CANVAS-SPACE coordinates — they change as you
//     pan/zoom (the world div's transform is the inverse).
//   - Pointer-events: none — clicks pass through to the canvas below.
//     (Future: drag-out guides — separate work, spec §H.1 bullet.)
//
// Rendered at the screen-space overlay layer (above the world, below the
// chrome selection overlay) so it doesn't get panned/zoomed with the world.

import { useMemo } from 'react';
import type { CanvasDocument } from '@/lib/canvas/types';

export interface RulersProps {
  /// Pan offset (screen pixels) — the world div's translate() values.
  panX: number;
  panY: number;
  /// Zoom factor — the world div's scale() value.
  zoom: number;
  /// The visible canvas size in screen pixels (used to size the rulers
  /// and to bound the tick range).
  width: number;
  height: number;
  /// The document being rendered (for ruler color theming via the canvas
  /// surface var; not currently used but reserved for future theming).
  document: CanvasDocument;
}

/// Decide the major + minor tick spacing for a given zoom level.
/// Goal: major tick on screen every ~80px, minor tick ~5-10× denser.
/// Adaptive ladder: powers-of-10 multiples of 1, 2, 5.
///   zoom 1.0 → major 100, minor 20
///   zoom 2.0 → major 50,  minor 10
///   zoom 0.5 → major 200, minor 50
///   zoom 4.0 → major 20,  minor 10 (tighter)
export function tickSpacingFor(zoom: number): { major: number; minor: number } {
  // Target ~80px between major ticks on screen.
  const target = 80 / Math.max(zoom, 0.0001);
  // Snap to the nearest 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, ...
  const ladder = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
  let major = ladder[0];
  for (const v of ladder) {
    if (v >= target) {
      major = v;
      break;
    }
    major = v;
  }
  // Minor = major / 5 (gives 4 minor ticks between each pair of majors).
  // Unless major is 1 — then minor stays 1 (can't sub-divide further).
  const minor = major >= 5 ? major / 5 : 1;
  return { major, minor };
}

/// Format a tick label — drop trailing zeros, abbreviate large numbers.
/// 0 → "0", 100 → "100", 1000 → "1k", 1500 → "1.5k", 10000 → "10k".
export function formatTickLabel(value: number): string {
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 10000) return `${(value / 1000).toFixed(0)}k`;
  if (abs >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(value);
}

/// Compute the tick positions + labels for one axis.
/// Returns an array of {pos, label?, major} where pos is in SCREEN pixels
/// relative to the ruler's start edge (0 = left or top of the ruler).
export function computeTicks(
  /// Pan offset in screen pixels along this axis.
  pan: number,
  /// Zoom factor.
  zoom: number,
  /// Ruler length in screen pixels.
  length: number,
): { pos: number; label: string | null; major: boolean }[] {
  // Edge case: zero or negative length → no visible ticks. Also guards
  // against division-by-zero in the canvas-space computation below.
  if (length <= 0) return [];

  const { major, minor } = tickSpacingFor(zoom);
  const ticks: { pos: number; label: string | null; major: boolean }[] = [];

  // Canvas-space range visible on screen: [(-pan)/zoom, (length-pan)/zoom].
  const canvasStart = -pan / Math.max(zoom, 0.0001);
  const canvasEnd = (length - pan) / Math.max(zoom, 0.0001);

  // Walk from the first major tick at or below canvasStart to canvasEnd.
  const firstMajor = Math.floor(canvasStart / major) * major;
  const firstMinor = Math.floor(canvasStart / minor) * minor;

  // Minor ticks (no labels) — denser, but skip every 5th (which is a major).
  for (let v = firstMinor; v <= canvasEnd; v += minor) {
    if (v % major === 0) continue; // skip — handled by major loop
    const screenPos = v * zoom + pan;
    if (screenPos < 0 || screenPos > length) continue;
    ticks.push({ pos: screenPos, label: null, major: false });
  }

  // Major ticks (with labels).
  for (let v = firstMajor; v <= canvasEnd; v += major) {
    const screenPos = v * zoom + pan;
    if (screenPos < 0 || screenPos > length) continue;
    ticks.push({ pos: screenPos, label: formatTickLabel(v), major: true });
  }

  // Sort by screen position so labels don't visually overlap.
  ticks.sort((a, b) => a.pos - b.pos);
  return ticks;
}

export function Rulers({ panX, panY, zoom, width, height }: RulersProps) {
  const xTicks = useMemo(() => computeTicks(panX, zoom, width), [panX, zoom, width]);
  const yTicks = useMemo(() => computeTicks(panY, zoom, height), [panY, zoom, height]);

  const RULER_SIZE = 18;
  const TICK_MAJOR_LEN = 10;
  const TICK_MINOR_LEN = 5;
  const LABEL_SIZE = 9;

  return (
    <div
      data-ac-rulers=""
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 50,
        color: 'var(--ac-canvas-default-text, #475569)',
        fontFamily: 'var(--font-inter, Inter), system-ui, sans-serif',
        fontSize: LABEL_SIZE,
        userSelect: 'none',
      }}
    >
      {/* Top-left corner box — covers the intersection. */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: RULER_SIZE,
          height: RULER_SIZE,
          background: 'var(--ac-canvas-bg, #f8fafc)',
          borderBottom: '1px solid var(--ac-canvas-default-stroke, #cbd5e1)',
          borderRight: '1px solid var(--ac-canvas-default-stroke, #cbd5e1)',
        }}
      />

      {/* Top ruler (horizontal ticks). */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: RULER_SIZE,
          right: 0,
          height: RULER_SIZE,
          background: 'var(--ac-canvas-bg, #f8fafc)',
          borderBottom: '1px solid var(--ac-canvas-default-stroke, #cbd5e1)',
          overflow: 'hidden',
        }}
      >
        <svg
          width={width - RULER_SIZE}
          height={RULER_SIZE}
          style={{ display: 'block', position: 'absolute', left: 0, top: 0 }}
        >
          {xTicks.map((t, i) => (
            <g key={`x-${i}`}>
              <line
                x1={t.pos}
                y1={0}
                x2={t.pos}
                y2={t.major ? TICK_MAJOR_LEN : TICK_MINOR_LEN}
                stroke="currentColor"
                strokeWidth={1}
                opacity={t.major ? 0.7 : 0.35}
              />
              {t.label && (
                <text
                  x={t.pos + 2}
                  y={RULER_SIZE - 2}
                  fontSize={LABEL_SIZE}
                  fill="currentColor"
                  opacity={0.7}
                >
                  {t.label}
                </text>
              )}
            </g>
          ))}
        </svg>
      </div>

      {/* Left ruler (vertical ticks). */}
      <div
        style={{
          position: 'absolute',
          top: RULER_SIZE,
          left: 0,
          bottom: 0,
          width: RULER_SIZE,
          background: 'var(--ac-canvas-bg, #f8fafc)',
          borderRight: '1px solid var(--ac-canvas-default-stroke, #cbd5e1)',
          overflow: 'hidden',
        }}
      >
        <svg
          width={RULER_SIZE}
          height={height - RULER_SIZE}
          style={{ display: 'block', position: 'absolute', left: 0, top: 0 }}
        >
          {yTicks.map((t, i) => (
            <g key={`y-${i}`}>
              <line
                x1={0}
                y1={t.pos}
                x2={t.major ? TICK_MAJOR_LEN : TICK_MINOR_LEN}
                y2={t.pos}
                stroke="currentColor"
                strokeWidth={1}
                opacity={t.major ? 0.7 : 0.35}
              />
              {t.label && (
                <text
                  x={2}
                  y={t.pos + LABEL_SIZE + 1}
                  fontSize={LABEL_SIZE}
                  fill="currentColor"
                  opacity={0.7}
                >
                  {t.label}
                </text>
              )}
            </g>
          ))}
        </svg>
      </div>
    </div>
  );
}
