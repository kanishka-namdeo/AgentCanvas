// CullingCoordinator — Phase 4 L5 mount culling (spec §4.2).
//
// The L5 layer takes over where L4 (CSS `content-visibility: auto`) runs out:
// L4 still leaves the React tree mounted (browser skips layout+paint, but
// React reconciliation + DOM memory still scale with total node count).
// Above ~10k mounted nodes the React commit cost on every patch + the DOM
// tree's memory footprint start dominating frame time, even with L4 doing
// its job. L5 swaps far-offscreen *top-level* frames for a placeholder div
// (`<div data-ac-placeholder data-node-id={id} style="width;height" />`),
// shedding the entire React subtree + its measured-bounds observers +
// their DOM nodes.
//
// The coordinator is a pure-math object: callers inject the viewport rect
// (canvas-space) + a list of top-level layer rects + the previous culled
// set, and it returns the next culled set. No DOM reads, no React state —
// it's a pure function the unit tests can pin to exact numbers. DomCanvas
// drives it via a debounced pan/zoom-end callback (150ms) plus an rAF-
// throttled callback during motion, and applies the result by swapping
// placeholder vs. DomNode rendering for roots only (per the spec, group/
// instance stay mounted because their bounds are derived from children).
//
// ACTIVATION BUDGET: the spec gates L5 on document size — only when a page
// has ≥ 2,000 mounted nodes does the coordinator start culling. Below that
// threshold the placeholder-swap churn costs more than it saves. The
// caller passes the current node count; the coordinator no-ops below the
// budget.
//
// HYSTERESIS: a node marked culled stays culled until its rect crosses
// the OUTER margin (1.5× the standard margin). A node marked visible stays
// visible until its rect crosses the INNER margin (1× the standard margin).
// The 0.5× gap prevents thrash when a frame sits exactly on the margin and
// the user pans by a pixel.

export interface LayerRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ViewportRect {
  /// Top-left of the visible canvas area in canvas-space coordinates (i.e.
  /// after dividing out the world transform: panX/zoom, panY/zoom, viewport
  /// width / zoom, viewport height / zoom).
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CullingDecision {
  /// IDs that should be culled (rendered as placeholders) after this pass.
  /// Includes everything previously culled that's still outside the outer
  /// margin, plus newly-culled nodes that left the outer margin.
  culledIds: Set<string>;
  /// True if the decision changed vs. the previous pass — callers can skip
  /// the React re-render when false (the common case during a pan that
  /// doesn't cross any margin).
  changed: boolean;
}

export interface CullingConfig {
  /// Margin multiplier applied to the viewport rect to grow the "stay
  /// visible" region. Default 2.0 — nodes within 2× viewport size of the
  /// visible area stay mounted. Larger = more nodes stay visible during
  /// pan, smaller = more aggressive culling.
  marginMultiplier?: number;
  /// Hysteresis multiplier — a culled node stays culled until its rect
  /// crosses the OUTER margin (margin × hysteresis). Default 1.5 — the
  /// outer margin is 3× viewport, the inner margin is 2× viewport. The
  /// 0.5× gap prevents thrash on margin-hugging frames.
  hysteresisMultiplier?: number;
  /// Minimum node count to engage L5 at all. Below this, all nodes stay
  /// mounted (L4 alone handles smaller documents). Default 2000 per spec.
  minNodeBudget?: number;
}

const DEFAULTS: Required<CullingConfig> = {
  marginMultiplier: 2.0,
  hysteresisMultiplier: 1.5,
  minNodeBudget: 2000,
};

/**
 * Compute the next culling decision given the current viewport, top-level
 * layer rects, and the previous decision. Pure function — no side effects.
 *
 * Algorithm:
 *   1. If node count < minNodeBudget → return empty culled set + changed
 *      flag = (previous was non-empty).
 *   2. Compute inner margin rect (viewport expanded by marginMultiplier).
 *   3. Compute outer margin rect (viewport expanded by margin × hysteresis).
 *   4. For each layer rect:
 *      - If it intersects the INNER margin → visible (unculled).
 *      - If it was previously culled AND doesn't intersect the OUTER margin
 *        → stays culled.
 *      - Otherwise (outside inner, inside outer) → keep previous state
 *        (hysteresis — this is the "no-man's-land" where we don't flip).
 *   5. Compute `changed` by comparing the new set to the previous set.
 */
export function computeCullingDecision(
  viewport: ViewportRect,
  layers: LayerRect[],
  previousCulled: Set<string>,
  nodeCount: number,
  config: CullingConfig = {},
): CullingDecision {
  const cfg = { ...DEFAULTS, ...config };

  // Budget gate — below the threshold L5 no-ops (L4 alone handles it).
  if (nodeCount < cfg.minNodeBudget) {
    if (previousCulled.size === 0) {
      return { culledIds: new Set(), changed: false };
    }
    return { culledIds: new Set(), changed: true };
  }

  const inner = expandRect(viewport, cfg.marginMultiplier);
  const outer = expandRect(viewport, cfg.marginMultiplier * cfg.hysteresisMultiplier);

  const next = new Set<string>();
  for (const layer of layers) {
    if (layer.width <= 0 || layer.height <= 0) {
      // Zero-size layer (e.g., not yet measured / degenerate) — never cull,
      // the cost of leaving it mounted is the same as the cost of a
      // placeholder and we don't risk hiding a freshly-added node.
      continue;
    }
    const rect = { x: layer.x, y: layer.y, width: layer.width, height: layer.height };
    if (rectsIntersect(rect, inner)) {
      // Inside inner margin → always visible.
      continue;
    }
    if (previousCulled.has(layer.id)) {
      // Previously culled — only re-mount if it crosses the OUTER margin
      // back into the visible region (which we just checked) OR if it's
      // still outside the outer margin (stays culled).
      if (!rectsIntersect(rect, outer)) {
        next.add(layer.id);
      }
      // Inside outer but outside inner = hysteresis zone → keep previous
      // state (culled). Add to next.
      else {
        next.add(layer.id);
      }
    } else {
      // Previously visible, now outside inner margin.
      // If outside outer margin too → newly culled.
      // If inside outer margin → hysteresis zone → keep visible (don't add).
      if (!rectsIntersect(rect, outer)) {
        next.add(layer.id);
      }
    }
  }

  // changed = symmetric difference is non-empty.
  let changed = false;
  if (next.size !== previousCulled.size) {
    changed = true;
  } else {
    for (const id of next) {
      if (!previousCulled.has(id)) {
        changed = true;
        break;
      }
    }
  }

  return { culledIds: next, changed };
}

/**
 * Expand a rect outward from its center by `multiplier`. A multiplier of
 * 1.0 returns the same rect; 2.0 doubles width and height (1.5× each side).
 * Used to compute the inner/outer margin rects.
 */
export function expandRect(rect: ViewportRect, multiplier: number): ViewportRect {
  if (multiplier <= 1) return { ...rect };
  const newW = rect.width * multiplier;
  const newH = rect.height * multiplier;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  return {
    x: cx - newW / 2,
    y: cy - newH / 2,
    width: newW,
    height: newH,
  };
}

/**
 * Standard rect intersection test. Touching edges (zero overlap area)
 * count as intersecting — panning with a frame exactly on the viewport
 * edge should NOT cull it.
 */
export function rectsIntersect(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  const aRight = a.x + a.width;
  const aBottom = a.y + a.height;
  const bRight = b.x + b.width;
  const bBottom = b.y + b.height;
  return a.x <= bRight && aRight >= b.x && a.y <= bBottom && aBottom >= b.y;
}

/**
 * DomCanvas-side hook: compute the canvas-space viewport rect from the
 * pan/zoom values + the world-element's bounding size. Extracted so tests
 * can pin the math without rendering.
 */
export function viewportFromPanZoom(
  panX: number,
  panY: number,
  zoom: number,
  worldWidthPx: number,
  worldHeightPx: number,
): ViewportRect {
  // World-space → canvas-space: divide out the zoom and the pan offset.
  // (The world div is positioned at panX,panY and scaled by zoom; the
  // visible canvas area is the world div's client rect, so the visible
  // canvas-space rect is (panX/zoom, panY/zoom, worldWidthPx/zoom,
  // worldHeightPx/zoom).)
  const w = Math.max(1, worldWidthPx / Math.max(zoom, 0.0001));
  const h = Math.max(1, worldHeightPx / Math.max(zoom, 0.0001));
  return {
    x: -panX / Math.max(zoom, 0.0001),
    y: -panY / Math.max(zoom, 0.0001),
    width: w,
    height: h,
  };
}

/**
 * Helper for DomCanvas: collect the rects of root-level layers (the
 * culling candidates). Non-root layers stay mounted because their
 * containing frame already handles culling via L4. Returns the rects in
 * the order they appear in the world tree (no sort — the order doesn't
 * affect culling decisions).
 */
export function rootLayerRects(roots: ReadonlyArray<{ id: string; x: number; y: number; width: number; height: number }>): LayerRect[] {
  return roots.map((r) => ({ id: r.id, x: r.x, y: r.y, width: r.width, height: r.height }));
}
