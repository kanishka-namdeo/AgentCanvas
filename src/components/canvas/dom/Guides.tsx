'use client';

// Guides — Phase 7 §H.1 / §H.2 (spec docs/html-dom-renderer.md Appendix H).
//
// Renders user-authored horizontal/vertical guide lines in the screen-space
// chrome overlay (above the world tree, pointer-events: none baseline).
// Guides are stored in canvas space (y for horizontal, x for vertical) and
// projected to screen here so they stay put as the user pans/zooms.
//
// Right-click a guide line → calls onRemoveGuide(id). Drag-back-to-ruler to
// delete is a separate gesture (deferred — Figma also supports it but the
// right-click path is enough for the spec §H.2 acceptance criterion).
//
// Mounted inside DomChrome (the screen-space chrome overlay) so it inherits
// the chrome's stacking context (zIndex 10) + pointer-events baseline. The
// parent (DomChrome) is responsible for gating on `rulersVisible` (Figma
// behavior: guides only show when rulers are visible — dragging guides
// without rulers is a non-sequitur).

import type { GuideLine } from '@/lib/canvas/types';

export interface GuidesProps {
  /// Guides to render (from the canvas store's `guideLines` slice).
  guideLines: ReadonlyArray<GuideLine>;
  /// Pan/zoom from the canvas viewport (canvas → screen transform).
  panX: number;
  panY: number;
  zoom: number;
  /// Visible canvas size in screen pixels — the SVG spans this area so
  /// guides extend across the full viewport.
  width: number;
  height: number;
  /// Right-click a guide line → calls this with the guide's id. The parent
  /// wires this to the store's `removeGuide` action. Optional so the
  /// component is reusable in contexts without delete affordance (e.g.
  /// a read-only shared canvas).
  onRemoveGuide?: (id: string) => void;
}

/// Default guide color — Figma's guide red (#f24822). Used when a guide
/// doesn't specify a `color` field. Exported so tests + the Rulers preview
/// share the same constant.
export const DEFAULT_GUIDE_COLOR = '#f24822';

/// Pure helper — compute the screen-space line endpoints for a guide.
/// Horizontal guide → a y-line spanning the full viewport width; vertical
/// guide → an x-line spanning the full viewport height. Returns the four
/// coordinates the SVG <line> needs (x1, y1, x2, y2).
///
/// Extracted as a pure function so unit tests can verify the geometry
/// without rendering. Mirrors the MeasureOverlay helper pattern.
export function guideToScreenCoords(
  guide: GuideLine,
  panX: number,
  panY: number,
  zoom: number,
  width: number,
  height: number,
): { x1: number; y1: number; x2: number; y2: number } {
  if (guide.axis === 'horizontal') {
    // y-line at y = position * zoom + panY, spanning full viewport width.
    const y = guide.position * zoom + panY;
    return { x1: 0, y1: y, x2: width, y2: y };
  }
  // Vertical guide: x-line at x = position * zoom + panX, spanning full height.
  const x = guide.position * zoom + panX;
  return { x1: x, y1: 0, x2: x, y2: height };
}

/// Screen-space coordinate of the guide's position along its axis (used to
/// place the small handle circle at the ruler end). For a horizontal guide,
/// that's the screen Y; for a vertical guide, the screen X.
export function guideToScreenAxis(
  guide: GuideLine,
  panX: number,
  panY: number,
  zoom: number,
): number {
  return guide.axis === 'horizontal'
    ? guide.position * zoom + panY
    : guide.position * zoom + panX;
}

/// Resolve the stroke color for a guide — falls back to Figma red.
export function guideColor(guide: GuideLine): string {
  return guide.color ?? DEFAULT_GUIDE_COLOR;
}

const HANDLE_RADIUS = 4;
const HIT_PADDING = 6; // extends the right-click hit area beyond the 1px line

export function Guides({
  guideLines,
  panX,
  panY,
  zoom,
  width,
  height,
  onRemoveGuide,
}: GuidesProps) {
  if (guideLines.length === 0) return null;

  return (
    <div
      data-ac-guides=""
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
        {guideLines.map((g) => {
          const { x1, y1, x2, y2 } = guideToScreenCoords(g, panX, panY, zoom, width, height);
          const color = guideColor(g);
          // The handle circle sits at the ruler end (top for horizontal
          // guides, left for vertical) — a small visual affordance that
          // also widens the click target for right-click delete.
          const axisScreen = guideToScreenAxis(g, panX, panY, zoom);
          const handleX = g.axis === 'horizontal' ? 0 : axisScreen;
          const handleY = g.axis === 'horizontal' ? axisScreen : 0;
          return (
            <g key={g.id}>
              {/* Visible 1px guide line. */}
              <line
                data-ac-guide={g.id}
                data-ac-guide-axis={g.axis}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke={color}
                strokeWidth={1}
              />
              {/* Invisible wider hit area for right-click delete — 1px
                  lines are hard to hit precisely. pointer-events:stroke
                  would work but only on the exact 1px; an explicit wider
                  transparent line is more forgiving. */}
              {onRemoveGuide && (
                <line
                  data-ac-guide-hit={g.id}
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke="transparent"
                  strokeWidth={HIT_PADDING * 2}
                  style={{ pointerEvents: 'stroke', cursor: 'context-menu' }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onRemoveGuide(g.id);
                  }}
                />
              )}
              {/* Handle circle at the ruler end. */}
              <circle
                cx={handleX}
                cy={handleY}
                r={HANDLE_RADIUS}
                fill={color}
                style={{ pointerEvents: onRemoveGuide ? 'auto' : 'none', cursor: onRemoveGuide ? 'context-menu' : 'default' }}
                onContextMenu={onRemoveGuide ? (e) => {
                  e.preventDefault();
                  onRemoveGuide(g.id);
                } : undefined}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
