// Scale-tool geometry (spec Phase 7 — Figma's K tool).
//
// Figma's scale tool resizes layers PROPORTIONALLY from the dragged handle:
// width, height, font size and stroke width all multiply by the same factor
// (Figma `rescale()` semantics — constraints are ignored). The anchor is the
// opposite corner/edge of the dragged handle.
//
// Pure math — extracted so tests can exercise it without a renderer
// (tests/integration/canvas-interactions.test.tsx).

export interface ScaleGeometryInput {
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize?: number;
  strokeWidth?: number;
}

export interface ScaleGeometryResult {
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize?: number;
  strokeWidth?: number;
}

/// Minimum scale factor — prevents zero/negative sizes while dragging.
const MIN_FACTOR = 0.01;

/**
 * Proportionally scale a layer from one of its resize handles.
 *
 * @param orig     the layer's original geometry (ABSOLUTE canvas coords —
 *                 the same convention as the Canvas shell's drag originals)
 * @param handle   the drag handle ('nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w')
 * @param dxCanvas horizontal drag delta in canvas space (positive = right)
 * @param dyCanvas vertical drag delta in canvas space (positive = down)
 */
export function scaleGeometry(
  orig: ScaleGeometryInput,
  handle: string,
  dxCanvas: number,
  dyCanvas: number,
): ScaleGeometryResult {
  const w0 = Math.max(orig.width, 1);
  const h0 = Math.max(orig.height, 1);
  // Factor from the dominant axis of the handle: corner handles use the
  // horizontal drag, edge handles use their own axis.
  let factor: number;
  if (handle.includes('e')) factor = (orig.width + dxCanvas) / w0;
  else if (handle.includes('w')) factor = (orig.width - dxCanvas) / w0;
  else if (handle.includes('s')) factor = (orig.height + dyCanvas) / h0;
  else if (handle.includes('n')) factor = (orig.height - dyCanvas) / h0;
  else factor = 1;
  factor = Math.max(factor, MIN_FACTOR);

  const width = Math.max(orig.width * factor, 1);
  const height = Math.max(orig.height * factor, 1);
  // Anchor the opposite corner/edge so the layer grows toward the drag.
  let x = orig.x;
  let y = orig.y;
  if (handle.includes('w')) x = orig.x + (orig.width - width);
  if (handle.includes('n')) y = orig.y + (orig.height - height);

  const out: ScaleGeometryResult = { x, y, width, height };
  if (typeof orig.fontSize === 'number' && orig.fontSize > 0) {
    out.fontSize = Math.max(1, orig.fontSize * factor);
  }
  if (typeof orig.strokeWidth === 'number' && orig.strokeWidth > 0) {
    out.strokeWidth = Math.max(0, orig.strokeWidth * factor);
  }
  return out;
}
