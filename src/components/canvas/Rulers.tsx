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
//   - Pointer-events: none on the outer wrapper + corner box (clicks pass
//     through to the canvas). The ruler SVGs themselves ARE pointer-active
//     so the user can drag a guide out (Phase 7 §H.1 bullet).
//
// Rendered at the screen-space overlay layer (above the world, below the
// chrome selection overlay) so it doesn't get panned/zoomed with the world.

import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { CanvasDocument } from '@/lib/canvas/types';
import { DEFAULT_GUIDE_COLOR } from './dom/Guides';

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
  /// Phase 7 §H.1 drag-out guides callback — invoked when the user drags
  /// out of the ruler onto the canvas (moved >4px and released inside the
  /// canvas area). The parent wires this to `addGuide` on the canvas store.
  /// axis = 'horizontal' for a guide dragged from the TOP ruler (a y-line),
  /// 'vertical' for one dragged from the LEFT ruler (an x-line). position
  /// is in CANVAS-SPACE coordinates (already pan/zoom-corrected).
  onAddGuide?: (axis: 'horizontal' | 'vertical', position: number) => void;
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

/// Minimum pointer travel (screen pixels) before a pointer-down on the ruler
/// is treated as a drag-out-guide gesture rather than a click. 4px matches
/// the common "click vs. drag" threshold in UI frameworks (Figma uses ~3).
export const GUIDE_DRAG_THRESHOLD_PX = 4;

/// In-progress drag state held in component-local refs (no React state churn
/// per pointermove — the live preview line is drawn off this ref, not via
/// setState, so dragging is smooth even at 60+ Hz on a slow machine).
interface DragState {
  /// 'horizontal' = dragged from the TOP ruler (creates a y-line).
  /// 'vertical' = dragged from the LEFT ruler (creates an x-line).
  axis: 'horizontal' | 'vertical';
  /// Screen-space coordinate where pointerdown landed along the drag axis.
  /// Used only to measure travel against GUIDE_DRAG_THRESHOLD_PX.
  startScreen: number;
  /// Pointer id captured at pointerdown (so we can keep receiving move
  /// events even when the pointer leaves the ruler bounds).
  pointerId: number;
  /// The SVG element that captured the pointer (so we can release capture
  /// on pointerup). Stored because the active element may have changed by
  /// the time pointerup fires.
  capturedEl: SVGElement | null;
  /// Canvas-space coordinate of the most recent pointermove (the preview
  /// line is drawn at this position). Null until the first pointermove.
  currentCanvas: number | null;
}

export function Rulers({ panX, panY, zoom, width, height, onAddGuide }: RulersProps) {
  const xTicks = useMemo(() => computeTicks(panX, zoom, width), [panX, zoom, width]);
  const yTicks = useMemo(() => computeTicks(panY, zoom, height), [panY, zoom, height]);

  const RULER_SIZE = 18;
  const TICK_MAJOR_LEN = 10;
  const TICK_MINOR_LEN = 5;
  const LABEL_SIZE = 9;

  // Local drag state — kept in a ref so pointermove handlers don't trigger
  // React re-renders. The preview line is rendered from a `useState` mirror
  // that we bump only when the position visibly changes (≥1 canvas px) to
  // avoid spamming React with 60Hz updates during a drag.
  const dragRef = useRef<DragState | null>(null);
  const [preview, setPreview] = useState<{ axis: 'horizontal' | 'vertical'; position: number } | null>(null);

  /// Begin a potential guide drag from the top ruler (horizontal guide).
  /// We capture the pointer so we keep receiving move/up events even when
  /// the pointer leaves the ruler bounds (Figma behavior — drag the line
  /// onto the canvas, not just within the ruler strip).
  const onTopRulerPointerDown = (e: ReactPointerEvent<SVGElement>) => {
    if (e.button !== 0) return; // only left mouse button
    const el = e.currentTarget;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // setPointerCapture can throw if the pointer is already released
      // (race) — non-fatal; we'll still get move/up events while over the
      // ruler. The capture is for the out-of-ruler drag case.
    }
    dragRef.current = {
      axis: 'horizontal',
      startScreen: e.clientY,
      pointerId: e.pointerId,
      capturedEl: el,
      currentCanvas: null,
    };
    e.preventDefault();
  };

  /// Begin a potential guide drag from the left ruler (vertical guide).
  /// Mirror of onTopRulerPointerDown.
  const onLeftRulerPointerDown = (e: ReactPointerEvent<SVGElement>) => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* see above */
    }
    dragRef.current = {
      axis: 'vertical',
      startScreen: e.clientX,
      pointerId: e.pointerId,
      capturedEl: el,
      currentCanvas: null,
    };
    e.preventDefault();
  };

  /// Pointer move — when a drag is active, compute the canvas-space
  /// coordinate of the pointer along the drag axis and update the preview.
  /// Both rulers share this handler (the axis is in the drag state).
  const onPointerMove = (e: ReactPointerEvent<SVGElement>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const screen = drag.axis === 'horizontal' ? e.clientY : e.clientX;
    const pan = drag.axis === 'horizontal' ? panY : panX;
    const canvasPos = (screen - pan) / Math.max(zoom, 0.0001);
    drag.currentCanvas = canvasPos;
    // Bump React state only when the canvas-space position changes by ≥1
    // canvas px — keeps pointermove from saturating the React reconciler
    // at 60Hz during a fast drag. The render path reads `preview` for the
    // dashed preview line; the final commit reads dragRef on pointerup.
    setPreview((prev) => {
      if (prev && prev.axis === drag.axis && Math.abs(prev.position - canvasPos) < 1) {
        return prev; // unchanged — skip setState
      }
      return { axis: drag.axis, position: canvasPos };
    });
  };

  /// Pointer up — if the drag traveled more than the threshold AND ended
  /// inside the canvas area (not on the ruler itself), call onAddGuide.
  /// Always clears the drag state + releases pointer capture.
  const onPointerUp = (e: ReactPointerEvent<SVGElement>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) {
      dragRef.current = null;
      setPreview(null);
      return;
    }
    const endScreen = drag.axis === 'horizontal' ? e.clientY : e.clientX;
    const travel = Math.abs(endScreen - drag.startScreen);
    // The pointer must have moved past the threshold AND ended outside the
    // ruler strip (the ruler itself is RULER_SIZE tall/wide; ending inside
    // it means the user clicked-and-released without leaving the ruler — a
    // no-op drag, not a guide creation).
    let endedInsideRuler: boolean;
    if (drag.axis === 'horizontal') {
      // Top ruler — strip is y ∈ [0, RULER_SIZE). Ending inside means the
      // pointer was still in the ruler strip at release.
      endedInsideRuler = e.clientY < RULER_SIZE;
    } else {
      // Left ruler — strip is x ∈ [0, RULER_SIZE).
      endedInsideRuler = e.clientX < RULER_SIZE;
    }
    if (
      travel > GUIDE_DRAG_THRESHOLD_PX &&
      !endedInsideRuler &&
      drag.currentCanvas !== null &&
      onAddGuide
    ) {
      onAddGuide(drag.axis, drag.currentCanvas);
    }
    // Release capture + clear drag state.
    if (drag.capturedEl) {
      try {
        drag.capturedEl.releasePointerCapture(drag.pointerId);
      } catch {
        /* pointer already released — non-fatal */
      }
    }
    dragRef.current = null;
    setPreview(null);
  };

  /// Pointer cancel (e.g. browser interruption) — same cleanup as up, but
  /// no guide creation.
  const onPointerCancel = (e: ReactPointerEvent<SVGElement>) => {
    const drag = dragRef.current;
    if (drag && drag.capturedEl) {
      try {
        drag.capturedEl.releasePointerCapture(drag.pointerId);
      } catch {
        /* non-fatal */
      }
    }
    dragRef.current = null;
    setPreview(null);
  };

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
        color: 'var(--ac-canvas-default-text)',
        fontFamily: 'var(--font-inter, Inter), system-ui, sans-serif',
        fontSize: LABEL_SIZE,
        userSelect: 'none',
      }}
    >
      {/* Top-left corner box — covers the intersection. Pointer-events
          stay none so clicks at the corner pass through to the canvas. */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: RULER_SIZE,
          height: RULER_SIZE,
          background: 'var(--ac-canvas-bg)',
          borderBottom: '1px solid var(--ac-canvas-default-stroke)',
          borderRight: '1px solid var(--ac-canvas-default-stroke)',
        }}
      />

      {/* Top ruler (horizontal ticks). The SVG is pointer-active so the
          user can drag a guide out from it. */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: RULER_SIZE,
          right: 0,
          height: RULER_SIZE,
          background: 'var(--ac-canvas-bg)',
          borderBottom: '1px solid var(--ac-canvas-default-stroke)',
          overflow: 'hidden',
          cursor: 'default',
        }}
      >
        <svg
          width={width - RULER_SIZE}
          height={RULER_SIZE}
          style={{ display: 'block', position: 'absolute', left: 0, top: 0, pointerEvents: 'auto', touchAction: 'none' }}
          onPointerDown={onTopRulerPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
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

      {/* Left ruler (vertical ticks). Same pointer-active treatment. */}
      <div
        style={{
          position: 'absolute',
          top: RULER_SIZE,
          left: 0,
          bottom: 0,
          width: RULER_SIZE,
          background: 'var(--ac-canvas-bg)',
          borderRight: '1px solid var(--ac-canvas-default-stroke)',
          overflow: 'hidden',
          cursor: 'default',
        }}
      >
        <svg
          width={RULER_SIZE}
          height={height - RULER_SIZE}
          style={{ display: 'block', position: 'absolute', left: 0, top: 0, pointerEvents: 'auto', touchAction: 'none' }}
          onPointerDown={onLeftRulerPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
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

      {/* In-progress guide preview — a red dashed line at the live drag
          position. Rendered at the outermost wrapper so it can extend the
          full viewport (the rulers themselves are clipped). Pointer-events
          none so it doesn't block the move events. */}
      {preview && (
        <div
          data-ac-guide-preview=""
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
            zIndex: 51,
          }}
        >
          <svg width="100%" height="100%" style={{ position: 'absolute', top: 0, left: 0 }}>
            {preview.axis === 'horizontal' ? (
              <line
                x1={0}
                y1={preview.position * zoom + panY}
                x2={width}
                y2={preview.position * zoom + panY}
                style={{ stroke: DEFAULT_GUIDE_COLOR }}
                strokeWidth={1}
                strokeDasharray="4 3"
              />
            ) : (
              <line
                x1={preview.position * zoom + panX}
                y1={0}
                x2={preview.position * zoom + panX}
                y2={height}
                style={{ stroke: DEFAULT_GUIDE_COLOR }}
                strokeWidth={1}
                strokeDasharray="4 3"
              />
            )}
          </svg>
        </div>
      )}
    </div>
  );
}
