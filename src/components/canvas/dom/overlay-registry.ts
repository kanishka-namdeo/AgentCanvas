'use client';

// OverlayUtil registry — the tldraw pattern 6.2 adapted to AgentCanvas.
//
// tldraw exposes transient canvas UI (selection handles, marquee, snap
// lines, collaborator cursors) via an `OverlayUtil` class hierarchy. Each
// overlay is a small class with `isActive()`, `getOverlays()`, `render()`.
// Custom overlays (e.g. an "agent thinking" halo, a "this shape is being
// edited by AI" badge) slot in without touching core. The `zIndex` per
// util gives stable paint + hit order.
//
// AgentCanvas's existing DomChrome component is the equivalent of tldraw's
// overlay layer — it renders selection outlines, resize handles, measure
// redlines, guides, and focus rings. This registry is a thin extension
// point that lets plugins register additional overlay renderers without
// editing DomChrome itself. Plugins receive the same props DomChrome
// receives (layers, selectedIds, viewport, etc.) and return JSX.
//
// Usage:
//   registerOverlayUtil({ id: 'agent-thinking-halo', zIndex: 5, Body: MyHalo })
//   unregisterOverlayUtil('agent-thinking-halo')
//
// The registry is module-scoped (one Map per page load). Plugins should
// register on first import of their host module (side-effect import).
//
// 2026-09-19 (competitor-research round 3 — tldraw pattern 6.2).

import type { Layer, Shape } from '@/lib/canvas/types';
import type { ResizeHandle } from '../handleMath';

export interface OverlayUtilProps {
  /// Flat layer list (deduped) — the lookup table for selected/highlighted ids.
  layers: Layer[];
  selectedIds: string[];
  highlightIds: string[];
  hoveredId: string | null;
  viewport: { zoom: number; panX: number; panY: number };
  /// Same pointer/measure/focus props DomChrome receives.
  pointerCanvas?: { x: number; y: number } | null;
  measureMode?: boolean;
  focusedId?: string | null;
}

export interface OverlayUtil {
  /// Stable id for lookups + React keys.
  id: string;
  /// Paint order — higher = painted later (on top). The built-in
  /// DomChrome overlays run at zIndex 0 (selection), 5 (handles), 10
  /// (measure / guides). Custom overlays should pick a zIndex that
  /// doesn't collide. Use 1-4 for "below selection" (e.g. a hover halo
  /// that shouldn't cover the selection outline), 6-9 for "above
  /// selection but below handles", 11+ for "above everything".
  zIndex: number;
  /// The React component to render. Receives OverlayUtilProps. Should
  /// return null when isActive is false (don't render an empty fragment —
  /// null lets the parent skip the wrapping div).
  Body: React.ComponentType<OverlayUtilProps>;
  /// Optional: gate the overlay on a runtime condition. When false, the
  /// overlay is not rendered at all. Defaults to always-active.
  isActive?: (props: OverlayUtilProps) => boolean;
}

const overlayRegistry = new Map<string, OverlayUtil>();

/// Register an overlay util. Returns an unsubscribe function for ergonomics.
/// Re-registering the same id replaces the prior registration.
export function registerOverlayUtil(util: OverlayUtil): () => void {
  overlayRegistry.set(util.id, util);
  return () => {
    // Only delete if the registered util is still the one we set (don't
    // clobber a newer registration of the same id).
    if (overlayRegistry.get(util.id) === util) {
      overlayRegistry.delete(util.id);
    }
  };
}

/// Remove a registered overlay util by id.
export function unregisterOverlayUtil(id: string): void {
  overlayRegistry.delete(id);
}

/// Get all registered overlay utils, sorted by zIndex ascending (paint
/// order). Used by the OverlayLayer component below to render them in the
/// correct stacking order.
export function listOverlayUtils(): OverlayUtil[] {
  return Array.from(overlayRegistry.values()).sort((a, b) => a.zIndex - b.zIndex);
}

/// Check whether any overlay util is registered with the given id.
export function hasOverlayUtil(id: string): boolean {
  return overlayRegistry.has(id);
}
