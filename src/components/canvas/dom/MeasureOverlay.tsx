'use client';

// MeasureOverlay — Phase 7 §H.2 (spec docs/html-dom-renderer.md Appendix
// H.2). When Alt/Option is held + the pointer is over the canvas, paints
// distance redlines (red lines + labels) from each selected layer to its
// nearby siblings and to the containing frame's edges.
//
// Pure renderer — the geometry is computed by the pure helper in
// `@/lib/canvas/measure-overlay` (jsdom-testable); this component just
// transforms the canvas-space guide endpoints into screen space and emits
// an SVG. The overlay is screen-space, above the world tree, and
// pointer-events: none so it never blocks canvas interaction.
//
// Mounted inside `DomChrome` (the screen-space chrome overlay) so it
// inherits the chrome's stacking context (zIndex 10) and pointer-events:
// none baseline. Rendered conditionally on `pointerCanvas != null` +
// `selection.length > 0` — the parent (DomChrome) is responsible for
// gating on `measureMode` (Canvas.tsx sets the store flag on Alt keydown/
// keyup).

import { useMemo } from 'react';
import {
  computeMeasureOverlay,
  formatDistance,
  type LayerLike,
  type MeasureGuide,
  type Rect,
} from '@/lib/canvas/measure-overlay';

export interface MeasureOverlayProps {
  /// Pointer position in canvas space. `null` when Alt is not held or the
  /// pointer has left the canvas (the parent gates this).
  pointerCanvas: { x: number; y: number } | null;
  /// Flat layer list (deduped — same one DomChrome receives).
  layers: ReadonlyArray<LayerLike>;
  /// Currently-selected layer ids.
  selection: ReadonlyArray<string>;
  /// Pan/zoom from the canvas viewport (screen ← canvas transform).
  panX: number;
  panY: number;
  zoom: number;
}

const RED = '#ff6b6b';
const LABEL_FONT_SIZE = 11;
const LABEL_HEIGHT = 14;
const LABEL_PADDING_X = 4;

/// Canvas → screen X transform.
function toScreenX(x: number, panX: number, zoom: number): number {
  return x * zoom + panX;
}
/// Canvas → screen Y transform.
function toScreenY(y: number, panY: number, zoom: number): number {
  return y * zoom + panY;
}

/// X-coordinate of a rect's named edge in canvas space.
function edgeXOf(rect: Rect, edge: 'left' | 'right'): number {
  return edge === 'left' ? rect.x : rect.x + rect.width;
}
/// Y-coordinate of a rect's named edge in canvas space.
function edgeYOf(rect: Rect, edge: 'top' | 'bottom'): number {
  return edge === 'top' ? rect.y : rect.y + rect.height;
}

/// Mid-Y of the y-range overlap of two rects, falling back to the smaller
/// rect's midpoint when they don't overlap (parent-edge case where the
/// child is fully inside the parent — overlap is the child's full range,
/// so this branch only triggers when one rect is degenerate or far away).
function midYOf(a: Rect, b: Rect): number {
  const lo = Math.max(a.y, b.y);
  const hi = Math.min(a.y + a.height, b.y + b.height);
  if (hi > lo) return (lo + hi) / 2;
  const smaller = a.height <= b.height ? a : b;
  return smaller.y + smaller.height / 2;
}

/// Mid-X of the x-range overlap of two rects (mirror of midYOf).
function midXOf(a: Rect, b: Rect): number {
  const lo = Math.max(a.x, b.x);
  const hi = Math.min(a.x + a.width, b.x + b.width);
  if (hi > lo) return (lo + hi) / 2;
  const smaller = a.width <= b.width ? a : b;
  return smaller.x + smaller.width / 2;
}

/// Compute the canvas-space line endpoints for a guide. The helper always
/// sets fromEdge/toEdge consistently with `axis` (left/right for 'h',
/// top/bottom for 'v'), so the casts here are sound at runtime.
function guideEndpoints(g: MeasureGuide): { x1: number; y1: number; x2: number; y2: number } {
  if (g.axis === 'h') {
    const x1 = edgeXOf(g.from, g.fromEdge as 'left' | 'right');
    const x2 = edgeXOf(g.to, g.toEdge as 'left' | 'right');
    const my = midYOf(g.from, g.to);
    return { x1, y1: my, x2, y2: my };
  }
  const y1 = edgeYOf(g.from, g.fromEdge as 'top' | 'bottom');
  const y2 = edgeYOf(g.to, g.toEdge as 'top' | 'bottom');
  const mx = midXOf(g.from, g.to);
  return { x1: mx, y1, x2: mx, y2 };
}

export function MeasureOverlay({
  pointerCanvas,
  layers,
  selection,
  panX,
  panY,
  zoom,
}: MeasureOverlayProps) {
  const guides = useMemo(
    () =>
      pointerCanvas && selection.length > 0
        ? computeMeasureOverlay(pointerCanvas, layers, selection)
        : [],
    [pointerCanvas, layers, selection],
  );

  if (guides.length === 0) return null;

  return (
    <div
      data-ac-measure=""
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        pointerEvents: 'none',
        overflow: 'visible',
      }}
    >
      <svg
        width="100%"
        height="100%"
        style={{ position: 'absolute', top: 0, left: 0, overflow: 'visible' }}
      >
        {guides.map((g, i) => {
          const { x1, y1, x2, y2 } = guideEndpoints(g);
          const sx1 = toScreenX(x1, panX, zoom);
          const sy1 = toScreenY(y1, panY, zoom);
          const sx2 = toScreenX(x2, panX, zoom);
          const sy2 = toScreenY(y2, panY, zoom);
          const lx = (sx1 + sx2) / 2;
          const ly = (sy1 + sy2) / 2;
          const label = formatDistance(g.distance);
          // Approximate label width: monospace digits ~6.5px each at 11px
          // (covers U+2212 which is wider than a digit) + horizontal padding.
          const labelWidth = Math.max(label.length * 7 + LABEL_PADDING_X * 2, 16);
          return (
            <g key={`measure-${i}`}>
              <line
                x1={sx1}
                y1={sy1}
                x2={sx2}
                y2={sy2}
                stroke={RED}
                strokeWidth={1}
              />
              {/* White background pill behind the label for readability on
                  any node fill color. */}
              <rect
                x={lx - labelWidth / 2}
                y={ly - LABEL_HEIGHT / 2}
                width={labelWidth}
                height={LABEL_HEIGHT}
                fill="#ffffff"
                opacity={0.9}
                rx={2}
              />
              <text
                x={lx}
                y={ly}
                fill={RED}
                fontSize={LABEL_FONT_SIZE}
                fontFamily="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
                textAnchor="middle"
                dominantBaseline="middle"
              >
                {label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
