// Assets panel → canvas drop (spec Phase 7 §H.1, Appendix H §H.1).
//
// Figma behavior: drag a reusable Component card from the Assets tab in the
// left sidebar → drop it anywhere on the canvas → a linked instance
// (PenRef) is placed at the cursor's canvas-space coordinates.
//
// The drop is wired through the EXISTING `place_instance` patch op
// (patch.ts:752-787) — the comment there already documents this exact
// "Figma behavior: drag a component from the Assets panel → drops an
// instance" contract. We use HTML5 drag-and-drop (NOT pointer events) so
// the OS-native drag image, copy-cursor, and dataTransfer payload flow
// work in every modern browser without bespoke cursor juggling.
//
// This module is PURE (no React, no DOM access beyond the rect passed in)
// so it's trivially testable in jsdom — the Canvas component reads the
// drop event and calls `buildComponentDropPatch(...)`; the LayersPanel
// writes the dataTransfer payload on dragStart via `COMPONENT_DRAG_MIME`.

import type { CanvasPatch, Viewport } from './types';

/// The HTML5 dataTransfer MIME type carrying the dragged component's id.
/// Read by the Canvas onDrop handler in `getData()` and matched against
/// in `types.contains()` to enable the drop affordance.
export const COMPONENT_DRAG_MIME = 'application/x-agentcanvas-component-id';

/// Read the component id from a synthetic DragEvent-like object. Returns
/// null when the drag payload doesn't carry a component id (e.g. layer
/// reparent drags use the legacy `text/plain` mime). Centralizes the
/// `getData` call so test code can pass a stub.
export function readComponentIdFromDrop(dataTransfer: {
  getData: (mime: string) => string;
  types?: readonly string[];
}): string | null {
  const raw = dataTransfer.getData(COMPONENT_DRAG_MIME);
  if (!raw) return null;
  return raw;
}

/// Compute canvas-space drop coordinates from a screen-space event.
///
///   canvasX = (clientX - rect.left - panX) / zoom
///   canvasY = (clientY - rect.top  - panY) / zoom
///
/// `rect` is the canvas container's `getBoundingClientRect()` — already
/// the screen-space origin the browser uses for `clientX/Y`. The pan/zoom
/// transform maps world → screen, so the inverse maps screen → world.
/// Exported so tests can exercise the math directly without rendering.
export function screenToCanvas(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number },
  viewport: Viewport,
): { x: number; y: number } {
  const { zoom, panX, panY } = viewport;
  return {
    x: (clientX - rect.left - panX) / zoom,
    y: (clientY - rect.top - panY) / zoom,
  };
}

/// Build the `place_instance` patch for a drop on the canvas.
///
/// Returns `null` when `componentId` is empty (drop without payload —
/// e.g. an external file drop or a stale drag from a removed component)
/// so the caller can early-out without enqueuing an empty patch.
///
/// The patch is sent through the store's `sendPatch` (the same path
/// every other local edit uses); the applier (`patch.ts:752`) clones the
/// source component's tree under a fresh PenRef, so the dropped instance
/// is a fully linked copy — editing the master updates every instance.
export function buildComponentDropPatch(
  componentId: string,
  clientX: number,
  clientY: number,
  rect: { left: number; top: number },
  viewport: Viewport,
): CanvasPatch | null {
  if (!componentId) return null;
  const { x, y } = screenToCanvas(clientX, clientY, rect, viewport);
  return {
    op: 'place_instance',
    componentId,
    shape: { x, y },
    summary: `Dropped component instance from Assets panel`,
  };
}
