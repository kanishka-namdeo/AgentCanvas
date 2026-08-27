// handleMath.ts — renderer-agnostic resize-handle geometry + vocabulary.
//
// Extracted from the legacy `svg/ShapeRenderer.tsx` so the DOM renderer
// (`dom/DomChrome.tsx`, `dom/DomCanvas.tsx`) and the Canvas shell
// (`Canvas.tsx`) don't depend on the SVG renderer just for these five
// shared exports. Pure data + pure functions; no React, no DOM, no renderer
// imports — mirrors the tldraw `ShapeUtil` geometry/handles split (see
// `docs/html-dom-renderer.md` Appendix A).
//
// Vocab: 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w' (clockwise from
// top-left). Used by the Canvas shell's DragState, the DOM chrome overlay's
// 8-handle loop, and (historically) the SVG renderer's per-shape selection.

import type { Shape } from '@/lib/canvas/types';

/// The 8-way resize handle union. Shared vocabulary between the Canvas
/// shell's DragState and the DOM chrome overlay.
export type ResizeHandle = 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w';

/// Screen-space size of a resize handle before zoom compensation.
/// DOM chrome uses a constant 8px (screen-space); legacy SVG renderer
/// divided by zoom for world-space. Kept here as the canonical constant.
export const HANDLE_SIZE = 8;

/// Minimum width/height a shape can be resized to. Enforced in the
/// Canvas shell's resize handler (prevents 0×0 shapes from breaking
/// the layout engine + auto-layout fit_content calculations).
export const MIN_SIZE = 4;

/// Returns the canvas-space centerpoint of a given handle on a layer's
/// bounding box. Used by the DOM chrome to place the 8 screen-space
/// handle divs (sx = pos.x * zoom + panX).
export function handlePosition(shape: Pick<Shape, 'x' | 'y' | 'width' | 'height'>, handle: ResizeHandle): { x: number; y: number } {
  const { x, y, width, height } = shape;
  const cx = x + width / 2;
  const cy = y + height / 2;
  switch (handle) {
    case 'nw': return { x, y };
    case 'n':  return { x: cx, y };
    case 'ne': return { x: x + width, y };
    case 'e':  return { x: x + width, y: cy };
    case 'se': return { x: x + width, y: y + height };
    case 's':  return { x: cx, y: y + height };
    case 'sw': return { x, y: y + height };
    case 'w':  return { x, y: cy };
  }
}

/// Returns the CSS cursor keyword for a given handle (used on the
/// `cursor` style of resize-handle divs in the DOM chrome).
export function cursorForHandle(h: ResizeHandle): string {
  switch (h) {
    case 'nw': case 'se': return 'nwse-resize';
    case 'ne': case 'sw': return 'nesw-resize';
    case 'n':  case 's':  return 'ns-resize';
    case 'e':  case 'w':  return 'ew-resize';
  }
}
