'use client';

// SvgCanvas — the classic single-<svg> renderer surface.
//
// Extracted VERBATIM from Canvas.tsx in the renderer split (spec Phase 1
// step 2 — docs/html-dom-renderer.md §6). Contains:
//   - the <svg> element sized to the container
//   - <defs>: the component-hatch pattern + one <clipPath> per clip:true frame
//   - the flat shape loop: dedupe by id (last-writer-wins), zIndex sort,
//     nearest-clipping-ancestor lookup, one <ShapeRenderer> per layer
//
// Canvas.tsx is now a pure shell (gestures, context menu, zoom UI, empty
// state, grid) that renders <SvgCanvas/> or <DomCanvas/> per the renderer
// setting. This file is the SVG parity baseline.

import type { CanvasDocument, Shape } from '@/lib/canvas/types';
import { ShapeRenderer, type ResizeHandle } from './ShapeRenderer';

export interface SvgCanvasProps {
  document: CanvasDocument;
  size: { w: number; h: number };
  zoom: number;
  panX: number;
  panY: number;
  selectedIds: Set<string>;
  highlightIds: Set<string>;
  onShapeMouseDown: (e: React.MouseEvent, shape: Shape) => void;
  onResizeHandleMouseDown: (e: React.MouseEvent, shape: Shape, handle: ResizeHandle) => void;
}

export function SvgCanvas({
  document,
  size,
  zoom,
  panX,
  panY,
  selectedIds,
  highlightIds,
  onShapeMouseDown,
  onResizeHandleMouseDown,
}: SvgCanvasProps) {
  return (
    <svg
      className="absolute inset-0"
      width={size.w}
      height={size.h}
      style={{ pointerEvents: 'none' }}
    >
      <defs>
        {/* Marker for component instance badge. */}
        <pattern id="component-hatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(14, 165, 233, 0.35)" strokeWidth="2" />
        </pattern>
        {/* Fix 3: clipPath definitions for frames with clip=true. */}
        {(() => {
          const clipShapes = (document.shapes ?? []).filter((s) => s.clip);
          return clipShapes.map((s) => (
            <clipPath key={`clip-${s.id}`} id={`clip-${s.id}`}>
              <rect x={s.x} y={s.y} width={s.width} height={s.height} />
            </clipPath>
          ));
        })()}
      </defs>
      <g transform={`translate(${panX}, ${panY}) scale(${zoom})`}>
        {/* Shapes — pointer events re-enabled per shape.
            Deduplicate by shape.id before rendering to prevent React
            "duplicate key" warnings when the canvas store transiently
            contains the same shape ID twice (e.g. during a bulk_add patch
            that hasn't fully resolved, or when the WebSocket + local-patch
            paths race). Last-writer-wins: the later shape in the array
            overrides earlier duplicates. */}
        {/* Fix 3: Build a set of shape IDs that have a clipping ancestor.
            For each such shape, we find the nearest clipping ancestor and
            apply its clipPath. This is computed once per render. */}
        {(() => {
          const shapes = Array.from(
            new Map((document.shapes ?? []).map((s) => [s.id, s] as const)).values(),
          );
          // Map: shapeId -> nearest clipping ancestor id (or undefined).
          const clipAncestor = new Map<string, string>();
          const shapeMap = new Map(shapes.map((s) => [s.id, s]));
          for (const s of shapes) {
            let current: string | null | undefined = s.parentId;
            while (current) {
              const parent = shapeMap.get(current);
              if (!parent) break;
              if (parent.clip) {
                clipAncestor.set(s.id, parent.id);
                break;
              }
              current = parent.parentId;
            }
          }
          return shapes
            .slice()
            .sort((a, b) => a.zIndex - b.zIndex)
            .map((shape) => {
              const clipId = clipAncestor.get(shape.id);
              const clipAttr = clipId ? `url(#clip-${clipId})` as string | undefined : undefined;
              return (
                <g key={shape.id} clipPath={clipAttr}>
                  <ShapeRenderer
                    shape={shape}
                    selected={selectedIds.has(shape.id)}
                    highlighted={highlightIds.has(shape.id)}
                    zoom={zoom}
                    onShapeMouseDown={onShapeMouseDown}
                    onResizeHandleMouseDown={onResizeHandleMouseDown}
                  />
                </g>
              );
            });
        })()}

      </g>
    </svg>
  );
}
