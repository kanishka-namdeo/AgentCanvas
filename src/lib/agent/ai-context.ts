// Three-tier AI canvas context (tldraw pattern 6.4 — three parallel
// representations of the canvas state for the LLM agent).
//
// The tldraw agent gathers context from THREE representations, each cheaper
// than the next in tokens but more lossy:
//
//   1. FOCUSED shapes — simplified JSON of shapes inside the request bounds.
//      IDs are stripped to short indices (`s0`, `s1`, ...), the coord system
//      is normalized to the bounds' top-left (so the model sees a self-
//      contained system starting near (0, 0) — no 4-digit negative offsets
//      to mentally project), and verbose fields are dropped. This is the
//      tier the model reasons against for direct edits.
//
//   2. PERIPHERAL shapes — shapes OUTSIDE the viewport, clustered by spatial
//      overlap, each cluster reduced to `{ clusterBounds, numberOfShapes }`.
//      Just a bounding box and a count — spatial awareness without paying
//      the token cost for full geometry. The model knows there's a dense
//      block of 38 shapes at (2400, 0)→(3100, 800) without knowing what
//      each one is.
//
//   3. VIEWPORT SCREENSHOT — a PNG of the viewport. Catches alignment /
//      whitespace / contrast issues that don't show up in a property dump
//      (the same insight the design-critic VLM subagent exploits — see
//      src/lib/agent/subagents/design-critic-vlm.ts).
//
// Performance guard: the clusterer is O(n²) on the peripheral set, so we
// gate the whole pipeline on a 500-shape ceiling. Above 500 shapes the
// runner falls back to the existing single-tier snapshot (don't try to
// cluster 500+ shapes per turn — log a warning to console).
//
// All helpers are PURE (no I/O outside the screenshot render call, which
// itself runs in an isolated worker process — see render-to-png.ts).

import type { Layer, CanvasDocument } from '../canvas/types';
import { renderCanvasToPng } from '../canvas/render-to-png';

// ---- Public types ----------------------------------------------------------

/// A canvas-space rectangle.
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/// Alias for `Bounds` used when the rect specifically denotes the visible
/// viewport region (semantic helper, not a distinct shape).
export type ViewportBounds = Bounds;

/// A focused shape — simplified JSON for the LLM. Field names are shortened
/// (`w`/`h`/`sw`/`r`) to trim token cost; verbose fields (zIndex, locked,
/// visible, componentId, tokenBinding, shadows[], radii, gradient, blendMode,
/// flipX/Y, clip, constraints, v3 mirrors) are dropped (the model can
/// re-derive them via pen_get_metadata if it needs the full payload).
export interface FocusedShape {
  id: string;          // 's0', 's1', ... — short index assigned by buildFocusedShapes
  type: string;
  name?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fill?: string;
  stroke?: string;
  sw?: number;          // strokeWidth
  r?: number;           // radius (uniform — per-corner radii dropped)
  text?: string;
  fontSize?: number;
  fontWeight?: number;
  textColor?: string;
  rotation?: number;
  opacity?: number;
  parentId?: string;    // remapped to focused short-id; dropped when parent isn't focused
}

/// A peripheral cluster — the bounding box and shape count of a spatially
/// contiguous group of shapes outside the viewport. The model gets spatial
/// awareness without paying token cost for full geometry.
export interface PeripheralCluster {
  clusterBounds: Bounds;
  numberOfShapes: number;
}

/// The orchestrator's return value. When `fallback` is true, the runner
/// skips the three-tier context and falls back to the existing single-tier
/// snapshot (the perf guard tripped).
export interface ThreeTierContext {
  focusedShapes: FocusedShape[];
  peripheralClusters: PeripheralCluster[];
  screenshotDataUrl: string | null;
  /// True when the canvas exceeded the 500-shape ceiling and the three-tier
  /// pipeline was skipped. The fields above are still populated best-effort
  /// (focused = empty, peripheral = empty, screenshot = full-canvas render)
  /// so a downstream consumer that always expects the shape is fine — but
  /// the runner typically uses `fallback` to swap in the legacy snapshot.
  fallback: boolean;
  /// A brief human-readable summary the runner can append to the system
  /// prompt as a peripheral-context section (e.g. "5 focused shapes; 3
  /// peripheral clusters spanning ~2800×900px").
  summary: string;
}

// ---- Internal helpers ------------------------------------------------------

/// Performance ceiling for the full three-tier pipeline. Above this, the
/// clusterer (O(n²)) starts adding latency the per-turn prompt budget
/// can't afford. The legacy single-tier snapshot handles big canvases
/// (it has its own SNAPSHOT_LINE_CAP collapse path).
const THREE_TIER_SHAPE_CEILING = 500;

const FALLBACK_SCREEN = { width: 1440, height: 900 };

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function shapeBounds(s: Layer): Bounds | null {
  if (s.visible === false) return null;
  if (!isFiniteNumber(s.x) || !isFiniteNumber(s.y)) return null;
  if (!isFiniteNumber(s.width) || !isFiniteNumber(s.height)) return null;
  if (s.width <= 0 || s.height <= 0) return null;
  return { x: s.x, y: s.y, width: s.width, height: s.height };
}

function intersects(a: Bounds, b: Bounds): boolean {
  // Open-interval overlap (touching edges don't count — a shape at x=100
  // width=0 next to a viewport at x=100 isn't "inside").
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function boundsUnion(a: Bounds, b: Bounds): Bounds {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

function round(n: number, dp = 0): number {
  const m = Math.pow(10, dp);
  return Math.round(n * m) / m;
}

/// Natural bounding box of a shape list — used when the canvas doesn't
/// carry viewport info (zoom=0 / missing) so we can't derive a real
/// viewport rect. Adds a small margin so shapes don't touch the PNG edge.
function naturalShapeBounds(shapes: Layer[]): ViewportBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const s of shapes) {
    const b = shapeBounds(s);
    if (!b) continue;
    any = true;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  if (!any) return { x: 0, y: 0, width: FALLBACK_SCREEN.width, height: FALLBACK_SCREEN.height };
  const PAD = 80;
  return {
    x: minX - PAD,
    y: minY - PAD,
    width: (maxX - minX) + PAD * 2,
    height: (maxY - minY) + PAD * 2,
  };
}

// ---- Public: viewport bounds ----------------------------------------------

/// Compute the canvas-space viewport rect from the canvas's `viewport`
/// field (zoom + panX/panY). Falls back to the natural shape bounds when
/// the canvas has no usable viewport info (zoom=0 / missing — the HTTP
/// fallback path that sends a bare-bones CanvasDocument).
///
/// The viewport rect is approximate: the server doesn't know the client's
/// exact screen dimensions, so we assume 1440x900 desktop. The model
/// interprets this as "what the user is looking at" alongside the focused
/// shapes JSON, not as pixel-perfect viewport bounds — for our use the
/// approximation is fine.
export function computeViewportBounds(
  canvas: Pick<CanvasDocument, 'viewport' | 'shapes'>,
  fallbackScreen: { width: number; height: number } = FALLBACK_SCREEN,
): ViewportBounds {
  const vp = canvas.viewport;
  if (!vp || typeof vp.zoom !== 'number' || vp.zoom <= 0) {
    return naturalShapeBounds(canvas.shapes ?? []);
  }
  return {
    x: -vp.panX / vp.zoom,
    y: -vp.panY / vp.zoom,
    width: fallbackScreen.width / vp.zoom,
    height: fallbackScreen.height / vp.zoom,
  };
}

// ---- Public: focused shapes ------------------------------------------------

/// Build the focused-shape JSON: simplified shapes inside the viewport,
/// IDs stripped to short indices (`s0`, `s1`, ...), coordinate system
/// normalized to the viewport's top-left (so the model sees coords near
/// (0, 0) instead of e.g. (-120, -80)).
///
/// Pure + total: an empty input returns an empty array; malformed shapes
/// (non-finite coords, 0 area) are skipped.
export function buildFocusedShapes(
  shapes: Layer[],
  viewportBounds: ViewportBounds,
): FocusedShape[] {
  // First pass: collect the focused shapes (visible + intersecting the
  // viewport) and assign each one a sequential short id. We keep a map
  // from internal id → short id so we can remap `parentId` references
  // after the first pass.
  const internalToShort = new Map<string, string>();
  const focusedRaw: Array<{ layer: Layer; shortId: string }> = [];
  let counter = 0;
  for (const s of shapes) {
    const b = shapeBounds(s);
    if (!b) continue;
    if (!intersects(b, viewportBounds)) continue;
    const shortId = `s${counter++}`;
    internalToShort.set(s.id, shortId);
    focusedRaw.push({ layer: s, shortId });
  }

  // Second pass: build the simplified JSON. Coords are normalized to the
  // viewport's top-left (subtract viewport.x / viewport.y). Parent ids
  // that aren't in the focused set are dropped (the parent is outside the
  // viewport — the model can't address it anyway).
  return focusedRaw.map(({ layer: s, shortId }) => {
    const out: FocusedShape = {
      id: shortId,
      type: s.type,
      x: round(s.x - viewportBounds.x, 1),
      y: round(s.y - viewportBounds.y, 1),
      w: round(s.width, 1),
      h: round(s.height, 1),
    };
    // Optional fields — only emit when set + non-default (keeps the JSON
    // lean: a default rectangle emits just `{ id, type, x, y, w, h }`).
    if (s.name && s.name !== s.type) out.name = s.name;
    if (s.fill && s.fill !== 'transparent') out.fill = s.fill;
    if (s.stroke && s.stroke !== 'transparent') {
      out.stroke = s.stroke;
      if (s.strokeWidth > 0) out.sw = s.strokeWidth;
    }
    if (s.radius > 0) out.r = s.radius;
    if (s.text) out.text = s.text;
    if (s.fontSize > 0) out.fontSize = s.fontSize;
    if (s.fontWeight && s.fontWeight !== 400) out.fontWeight = s.fontWeight;
    if (s.textColor && s.textColor !== '#000000') out.textColor = s.textColor;
    if (s.rotation) out.rotation = s.rotation;
    if (s.opacity !== undefined && s.opacity < 1) out.opacity = s.opacity;
    // Parent remap — drop when the parent isn't in the focused set.
    if (s.parentId) {
      const shortParent = internalToShort.get(s.parentId);
      if (shortParent) out.parentId = shortParent;
    }
    return out;
  });
}

// ---- Public: peripheral clusters -------------------------------------------

/// Build peripheral clusters: shapes OUTSIDE the viewport, grouped by
/// spatial overlap, each cluster reduced to `{ clusterBounds, numberOfShapes }`.
///
/// Uses a simple union-find on the overlap graph — O(n²) on the peripheral
/// set, fine for ≤500 shapes (the perf guard above the pipeline caps it).
/// A "cluster" is a connected component of the overlap graph: any two
/// shapes that overlap (even transitively) end up in the same cluster.
///
/// Pure + total: empty input → empty array.
export function buildPeripheralShapes(
  shapes: Layer[],
  viewportBounds: ViewportBounds,
): PeripheralCluster[] {
  // First pass: collect the peripheral shapes (visible + NOT intersecting
  // the viewport). Same visibility/finite-coord filters as the focused pass.
  const peripheral: Layer[] = [];
  for (const s of shapes) {
    const b = shapeBounds(s);
    if (!b) continue;
    if (intersects(b, viewportBounds)) continue;
    peripheral.push(s);
  }
  if (peripheral.length === 0) return [];

  // Union-find on the overlap graph.
  const parent = new Array(peripheral.length).fill(0).map((_, i) => i);
  const find = (x: number): number => {
    // Iterative find with path compression (recursive find blew the
    // stack on the worst-case 500-shape chain in profiling).
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== root) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  // Compute pairwise overlaps. Bounds are precomputed once.
  const bounds = peripheral.map((s) => shapeBounds(s)!);
  for (let i = 0; i < peripheral.length; i++) {
    for (let j = i + 1; j < peripheral.length; j++) {
      if (intersects(bounds[i], bounds[j])) union(i, j);
    }
  }

  // Group by root and compute the union bounds of each cluster.
  const groups = new Map<number, Layer[]>();
  for (let i = 0; i < peripheral.length; i++) {
    const r = find(i);
    let g = groups.get(r);
    if (!g) { g = []; groups.set(r, g); }
    g.push(peripheral[i]);
  }
  const clusters: PeripheralCluster[] = [];
  for (const group of groups.values()) {
    let cluster = shapeBounds(group[0])!;
    for (let k = 1; k < group.length; k++) {
      cluster = boundsUnion(cluster, shapeBounds(group[k])!);
    }
    clusters.push({
      clusterBounds: {
        x: round(cluster.x, 0),
        y: round(cluster.y, 0),
        width: round(cluster.width, 0),
        height: round(cluster.height, 0),
      },
      numberOfShapes: group.length,
    });
  }
  // Sort clusters by descending shape count — the largest cluster first
  // (most likely to be relevant to the model's task).
  clusters.sort((a, b) => b.numberOfShapes - a.numberOfShapes);
  return clusters;
}

// ---- Public: viewport screenshot -------------------------------------------

/// Render the viewport to a PNG and return a base64 data URL.
///
/// Translates the focused shapes' coords by `(-viewport.x, -viewport.y)` so
/// the viewport's top-left lands at (0, 0) in the PNG (the render util's
/// SVG viewBox is fixed at `0 0 width height` — without translation the
/// viewport would render at the canvas's absolute coords and most of the
/// PNG would be empty / the visible content would be clipped).
///
/// Returns null on failure (no focused shapes, render error). The runner
/// treats null as "no screenshot this turn" — the focused JSON + peripheral
/// clusters still ride the prompt; only the vision portion drops.
export async function buildViewportScreenshot(
  shapes: Layer[],
  viewportBounds: ViewportBounds,
): Promise<string | null> {
  const focusedRaw: Layer[] = [];
  for (const s of shapes) {
    const b = shapeBounds(s);
    if (!b) continue;
    if (!intersects(b, viewportBounds)) continue;
    focusedRaw.push(s);
  }
  if (focusedRaw.length === 0) return null;
  // Translate each shape so the viewport's top-left becomes (0, 0) in the
  // PNG. We clone shallow + override x/y — the render util only reads
  // x/y/width/height + style fields, never mutates.
  const translated = focusedRaw.map((s) => ({
    ...s,
    x: s.x - viewportBounds.x,
    y: s.y - viewportBounds.y,
  }));
  const w = Math.max(1, Math.round(viewportBounds.width));
  const h = Math.max(1, Math.round(viewportBounds.height));
  try {
    const png = await renderCanvasToPng(translated, w, h);
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch (err) {
    // The render util runs in an isolated worker process; a native resvg
    // panic surfaces here as a normal Error. Don't fail the turn over a
    // missing screenshot — the focused JSON + peripheral clusters carry
    // the structural context the model needs to act on the prompt.
    console.warn(
      '[ai-context] viewport screenshot render failed — proceeding without screenshot:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

// ---- Public: orchestrator --------------------------------------------------

/// Build the full three-tier AI context: focused shapes + peripheral
/// clusters + viewport screenshot.
///
/// PERFORMANCE GUARD: if the canvas has > 500 shapes, the perf-sensitive
/// steps (peripheral clustering, screenshot render) are skipped — the
/// legacy single-tier snapshot the runner already builds handles large
/// canvases (its own SNAPSHOT_LINE_CAP collapses long sibling lists).
/// A `console.warn` is logged so the operator can see the trip.
/// `fallback: true` is set in the return value so the runner knows to
/// skip the three-tier prompt section entirely (or render it as a one-
/// line "canvas too large for three-tier context" note).
export async function buildAIThreeTierContext(
  canvas: CanvasDocument,
  viewportBounds?: ViewportBounds,
): Promise<ThreeTierContext> {
  const shapes = (canvas.shapes ?? []).filter(
    (s) => s.visible !== false && isFiniteNumber(s.x) && isFiniteNumber(s.y)
      && isFiniteNumber(s.width) && isFiniteNumber(s.height)
      && s.width > 0 && s.height > 0,
  );
  const bounds = viewportBounds ?? computeViewportBounds(canvas);
  const fallback = shapes.length > THREE_TIER_SHAPE_CEILING;
  if (fallback) {
    console.warn(
      `[ai-context] canvas has ${shapes.length} shapes (ceiling ${THREE_TIER_SHAPE_CEILING}) — ` +
      `falling back to single-tier snapshot; skipping three-tier context build.`,
    );
    return {
      focusedShapes: [],
      peripheralClusters: [],
      screenshotDataUrl: null,
      fallback: true,
      summary: `(canvas too large for three-tier context — ${shapes.length} shapes; see existing CANVAS SNAPSHOT)`,
    };
  }
  const focusedShapes = buildFocusedShapes(shapes, bounds);
  const peripheralClusters = buildPeripheralShapes(shapes, bounds);
  const screenshotDataUrl = await buildViewportScreenshot(shapes, bounds);
  const summary =
    `${focusedShapes.length} focused shape${focusedShapes.length === 1 ? '' : 's'}; ` +
    `${peripheralClusters.length} peripheral cluster${peripheralClusters.length === 1 ? '' : 's'} ` +
    `(${peripheralClusters.reduce((n, c) => n + c.numberOfShapes, 0)} shapes total)` +
    `${screenshotDataUrl ? '; viewport screenshot attached' : ''}`;
  return {
    focusedShapes,
    peripheralClusters,
    screenshotDataUrl,
    fallback: false,
    summary,
  };
}

// ---- Public: prompt-section renderer ---------------------------------------

/// Render the three-tier context as a prompt-text section the runner can
/// append to the user message (alongside the existing CANVAS SNAPSHOT).
/// The screenshot is NOT included here — it rides as an image_url content
/// part (the runner pushes it onto the same `images` array used for user
/// image attachments). Returns an empty string when `ctx.fallback` is true
/// (the runner falls back to the legacy snapshot in that case).
export function renderThreeTierContextSection(ctx: ThreeTierContext): string {
  if (ctx.fallback) return '';
  const focused = ctx.focusedShapes.length === 0
    ? '  (empty viewport)'
    : ctx.focusedShapes.map((s) => {
        const parts = [s.id, s.type];
        if (s.name) parts.push(`name="${s.name}"`);
        parts.push(`@(${s.x},${s.y}) ${s.w}×${s.h}`);
        if (s.fill) parts.push(`fill=${s.fill}`);
        if (s.stroke) parts.push(`stroke=${s.stroke}${s.sw ? `(${s.sw})` : ''}`);
        if (s.r) parts.push(`r=${s.r}`);
        if (s.text) parts.push(`text="${s.text.length > 40 ? s.text.slice(0, 37) + '…' : s.text}"`);
        if (s.fontSize) parts.push(`fs=${s.fontSize}`);
        if (s.fontWeight) parts.push(`fw=${s.fontWeight}`);
        if (s.parentId) parts.push(`parent=${s.parentId}`);
        return `  ${parts.join(' ')}`;
      }).join('\n');
  const peripheral = ctx.peripheralClusters.length === 0
    ? '  (none — viewport contains the whole canvas)'
    : ctx.peripheralClusters.slice(0, 8).map((c) =>
        `  • ${c.numberOfShapes} shape${c.numberOfShapes === 1 ? '' : 's'} @ (${c.clusterBounds.x},${c.clusterBounds.y}) ${c.clusterBounds.width}×${c.clusterBounds.height}`,
      ).join('\n') +
      (ctx.peripheralClusters.length > 8
        ? `\n  … ${ctx.peripheralClusters.length - 8} more cluster(s)` : '');
  const screenshotNote = ctx.screenshotDataUrl
    ? '\n- Viewport screenshot: ATTACHED as image content part (vision-capable models only)'
    : '\n- Viewport screenshot: unavailable this turn (render skipped or failed)';
  return `AI THREE-TIER CONTEXT (tldraw pattern 6.4):
- ${ctx.summary}
- Focused shapes (inside viewport; ids are short indices s0/s1/…; coords normalized to viewport top-left):
${focused}
- Peripheral clusters (OUTSIDE viewport — bounding box + count only; call pen_get_metadata or pen_find_nodes to expand):
${peripheral}${screenshotNote}`;
}
