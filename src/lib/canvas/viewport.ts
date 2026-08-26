// Pure viewport helpers (spec Phase 7 — zoom-to-fit / zoom-to-selection ⇧1/⇧2).
//
// Extracted from Canvas.tsx so the math is unit-testable without a mounted
// renderer (tests/integration/canvas-interactions.test.tsx).

import { clampZoom } from './use-canvas-gestures';

export interface ViewportState {
  zoom: number;
  panX: number;
  panY: number;
}

export interface BBoxLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const DEFAULT_VIEWPORT: ViewportState = { zoom: 1, panX: 120, panY: 80 };

/// Compute the bounding box of a set of layers (absolute canvas coords).
export function bboxOf(shapes: BBoxLike[]): BBoxLike | null {
  if (shapes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of shapes) {
    minX = Math.min(minX, s.x);
    minY = Math.min(minY, s.y);
    maxX = Math.max(maxX, s.x + s.width);
    maxY = Math.max(maxY, s.y + s.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Fit a bounding box into a viewport of `size` with `margin` px of breathing
 * room on all sides (Figma's ⇧1 "Zoom to fit"). Zoom is clamped to the
 * canvas zoom range; the content is centered. Empty input falls back to the
 * default (100%) viewport.
 */
export function fitViewport(
  shapes: BBoxLike[],
  size: { w: number; h: number },
  margin = 40,
): ViewportState {
  const bbox = bboxOf(shapes);
  if (!bbox) return { ...DEFAULT_VIEWPORT };
  const w = Math.max(bbox.width, 1);
  const h = Math.max(bbox.height, 1);
  const availW = Math.max(size.w - margin * 2, 1);
  const availH = Math.max(size.h - margin * 2, 1);
  const zoom = clampZoom(Math.min(availW / w, availH / h));
  // Center the scaled content inside the viewport.
  const panX = (size.w - w * zoom) / 2 - bbox.x * zoom;
  const panY = (size.h - h * zoom) / 2 - bbox.y * zoom;
  return { zoom, panX, panY };
}

/**
 * True when `bbox` (canvas-space) extends outside the viewport's visible
 * rect (also canvas-space). Drives the agent turn-end "reveal": zoom-to-fit
 * only when the turn's content landed off-screen (multi-screen designs grow
 * rightward); in-view work never disturbs the user's zoom/pan.
 */
export function contentOutsideViewport(
  bbox: BBoxLike,
  viewport: ViewportState,
  size: { w: number; h: number },
): boolean {
  const visX = -viewport.panX / viewport.zoom;
  const visY = -viewport.panY / viewport.zoom;
  const visW = size.w / viewport.zoom;
  const visH = size.h / viewport.zoom;
  return (
    bbox.x < visX ||
    bbox.y < visY ||
    bbox.x + bbox.width > visX + visW ||
    bbox.y + bbox.height > visY + visH
  );
}
