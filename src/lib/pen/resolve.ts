// .pen tree → resolved flat render list.
//
// This is the bridge between the .pen object-tree source of truth and the
// existing SVG renderer (which consumes a flat list of `Shape` objects with
// absolute positions). The resolve engine:
//
//   1. Expands `ref` instances into their component subtrees (with descendants).
//   2. Computes absolute positions via a simplified flexbox layout engine
//      (layout / gap / padding / justifyContent / alignItems / fit_content /
//      fill_container).
//   3. Resolves `$variable` references to concrete values, honoring the
//      node's effective theme (inherited from ancestors) for theme-conditional
//      variables.
//   4. Maps each .pen node onto a `Shape` (the renderer's render-node type),
//      preserving parentId + a depth-first zIndex.
//
// The output is recomputed on every mutation, so the renderer/panels always
// see a consistent, up-to-date flat view.

import type {
  PenChild,
  PenDocument,
  PenFill,
  PenFills,
  PenLayout,
  PenTheme,
  PenVariableDef,
  PenThemedValue,
  PenRef,
  FigmaPaint,
  FigmaEffect,
} from './types';
import { PEN_NODE_TYPES } from './types';
import type { Shape, Layer, CanvasDocument, AutoLayout, GradientFill, ShadowEffect, CornerRadii } from '../canvas/types';
import { collectComponents, expandRef, walkTree } from './document';
import {
  normalizeLayoutMode,
  normalizeAxisAlign,
  normalizeLayoutSizing,
  normalizeLayoutPositioning,
  normalizeTextAutoResize,
  gradientAngleToHandles,
} from './normalize';

// ---- Native-layout tree export (spec Phase 2, §3.2/§3.4) -----------------

/// One node of the resolver's pre-flattening tree: the emitted flat `Shape`
/// (absolute geometry, resolved styles) paired with its SOURCE .pen node
/// (layout vocabulary: layout/gap/padding/justifyContent/alignItems, sizing
/// modes width/height: number | 'fit_content' | 'fill_container',
/// layoutPosition) plus the resolved children.
///
/// Consumed by the DOM renderer's NATIVE layout mode (dom/DomCanvas.tsx),
/// which lets the browser lay out `layout ≠ 'none'` containers via CSS
/// flexbox instead of using the resolver's predicted absolute geometry.
export interface ResolvedTreeNode {
  layer: Shape;
  pen: PenChild;
  children: ResolvedTreeNode[];
}

/// Optional inputs shared by both resolve entry points.
export interface ResolveOpts {
  /// Measured bounds readback (spec §3.8): REAL browser-measured sizes keyed
  /// by node id, produced by the DOM renderer's ResizeObserver pool in native
  /// layout mode. Used as an intrinsic-size HINT for `fit_content` nodes that
  /// have no intrinsic content size (the resolver cannot measure text) —
  /// instead of falling back to the 100×100 placeholder. Purely advisory:
  /// absent/unknown ids keep today's behavior.
  measuredBounds?: Record<string, { width: number; height: number }>;
  /// Optional external accumulator for resolver degradation warnings.
  /// Whenever provided, the warnings collected during this resolve are ALSO
  /// pushed here (in addition to being returned). Callers that resolve per
  /// patch can reuse one array across a turn and dedupe by (nodeId, kind).
  warnings?: ResolverWarning[];
}

// ---- Resolver warnings (agent-visible degradation reporting) ----------------
//
// The resolver historically degrades SILENTLY: fit_content frames fall back
// to a 100×100 placeholder, refs with missing targets VANISH, cycle-guarded
// refs render as plain rectangles, $variables without definitions leak the
// literal '$key' string into fills. The agent never learned its design was
// degraded, so it could not self-correct. Every degradation site now emits a
// ResolverWarning; the delivery layers (pen_get_metadata tool result, the
// runner's canvas snapshot) surface them to the LLM.
//
// Kinds are a closed set — treat them as stable API (the agent-facing text
// renders them, and evals may assert on them).

export type ResolverWarningKind =
  /// fit_content container rendered at the 100×100 placeholder (no intrinsic
  /// content, no measured-bounds hint) — size on screen is probably wrong.
  | 'placeholder_size'
  /// ref target missing (unknown id, or target not reusable) — the node was
  /// DROPPED from the render list entirely; it is invisible.
  | 'dropped_ref'
  /// ref survived expansion (cycle/depth guard) — rendered as a plain
  /// rectangle, losing its component identity.
  | 'ref_unexpanded'
  /// Node type outside the .pen ontology — rendered as a rectangle.
  | 'unknown_node_type'
  /// $variable with no matching definition — the literal '$key' string was
  /// used as the value (renders as a garbage color / text).
  | 'unresolved_variable'
  /// path geometry the simple M/L parser cannot read (curves, relative
  /// commands) — the path renders with no points.
  | 'path_geometry_dropped'
  /// More than one enabled shadow or blur — the resolved Layer model carries
  /// a single shadow + single blur, so extras were dropped.
  | 'effects_dropped'
  /// VLM-exercise Fix 3: a container's children extend beyond its declared
  /// bounds (fixed height/width too small for the flow content). The overflow
  /// now RENDERS (culling gate), but it escapes the frame's background —
  /// switch the container to height:'fit_content' or size it to its content.
  | 'container_overflow'
  /// Prompt-tuning deferred-critique fix: a text node's FIXED width is
  /// narrower than its estimated rendered content — the text will clip
  /// ("Growth Metrics" @38px in a 120px box). Widen it, use fit_content, or
  /// shorten the text.
  | 'text_overflow'
  /// Prompt-tuning deferred-critique fix: a FLOW child of an auto-layout
  /// container carries large absolute-style x/y — the layout engine IGNORES
  /// them, so the node renders in flow order, not at the coordinates. Pin it
  /// with layoutPosition:'absolute' or move it to the right flow index.
  | 'flow_child_absolute_coords'
  /// Depth-research 3-b #7 (2026-09-05): a text layer's resolved color fails
  /// WCAG AA contrast against its effective backdrop (nearest solid-filled
  /// ancestor, else a containing solid sibling painted below it, else the
  /// light page surface). 4.5:1 for normal text, 3:1 for large text
  /// (≥24px, or ≥19px bold). Programmatic arithmetic — runs BEFORE the VLM
  /// critic so contrast is never a matter of opinion (A11YN pattern).
  | 'contrast_failure'
  /// Depth-research 3-b #1 (Figma auto-layout guide): a fit_content (hug)
  /// container whose ONLY children are fill_container on that axis — the hug
  /// has nothing to measure (Figma: a fill child makes the parent stop
  /// hugging). Fix: fixed size on the parent, or a non-fill child.
  | 'hug_fill_conflict'
  /// Depth-research 3-b #1: fill_container sizing on a ROOT-level node — there
  /// is no parent to fill, so the axis resolves to 0 (invisible). Fix: set an
  /// explicit size or nest the node inside an auto-layout frame.
  | 'fill_without_parent';

export interface ResolverWarning {
  nodeId: string;
  nodeType?: string;
  kind: ResolverWarningKind;
  message: string;
}

/// Node types the renderer understands (PEN_NODE_TYPES + the legacy 'image'
/// Layer type that mapNodeType passes through). Set lookup — the unknown-type
/// warning check runs in the per-node hot path.
const KNOWN_NODE_TYPES: ReadonlySet<string> = new Set<string>([...PEN_NODE_TYPES, 'image']);

// ---- Container node predicate (Figma-canonical) --------------------------
//
// Returns true for any .pen node type that can contain children. Includes the
// legacy types (frame, group) plus the new Figma-canonical container types:
// section, component, component_set, boolean_operation.
//
// Acts as a TypeScript type guard so the compiler knows `node.children` is
// accessible after this check.
function isContainerNode(node: PenChild): node is
  | import('./types').PenFrame
  | import('./types').PenGroup
  | import('./types').PenSection
  | import('./types').PenComponent
  | import('./types').PenComponentSet
  | import('./types').PenBooleanOperation {
  return (
    node.type === 'frame' ||
    node.type === 'group' ||
    node.type === 'section' ||
    node.type === 'component' ||
    node.type === 'component_set' ||
    node.type === 'boolean_operation'
  );
}

// ---- Theme + variable resolution -----------------------------------------

/** Resolve a variable reference. Returns the concrete value, or the raw
 *  string if it's not a $-reference.
 *
 *  Audit 4 C14 (nested $var fix): a variable whose value is ANOTHER $ref
 *  ($brand.primary → $color.primary → #hex) used to leak the literal
 *  "$color.primary" into the rendered fill. Resolution is now iterative with
 *  a depth cap + cycle guard, so chains resolve to a concrete value. */
function resolveValue<T extends string | number | boolean>(
  raw: T,
  variables: { [key: string]: PenVariableDef } | undefined,
  theme: PenTheme,
): T {
  if (typeof raw !== 'string') return raw;
  if (!raw.startsWith('$')) return raw;
  const MAX_VAR_DEPTH = 5;
  let current: string | number | boolean = raw;
  const seen = new Set<string>();
  for (let depth = 0; depth < MAX_VAR_DEPTH; depth++) {
    if (typeof current !== 'string' || !current.startsWith('$')) break;
    const key = current.slice(1);
    if (seen.has(key)) break; // $a → $b → $a cycle guard — emit the literal.
    seen.add(key);
    const def = variables?.[key];
    if (!def) break; // unknown variable — leave as-is
    current = resolveThemedValue(def, theme);
  }
  return current as T;
}

/** Pick the winning value from a variable def given the effective theme.
 *  Exported for the DOM renderer's variable publishing (dom/variables.ts),
 *  which resolves document variables to CSS custom properties under the
 *  document-default theme (spec §3.6). */
export function resolveThemedValue(def: PenVariableDef, theme: PenTheme): string | number | boolean {
  const value = def.value as PenVariableDef['value'];
  if (!Array.isArray(value)) {
    // Single value — resolve nested $refs one level.
    return value as string | number | boolean;
  }
  // Themed values: the LAST value whose theme is satisfied wins; default = first.
  let winner: PenThemedValue<string | number | boolean> | undefined = value[0] as any;
  for (const tv of value as PenThemedValue<string | number | boolean>[]) {
    if (tv.theme && themeSatisfied(tv.theme, theme)) {
      winner = tv;
    }
  }
  return winner?.value as string | number | boolean;
}

/** Does the effective theme satisfy the required theme? (required ⊆ effective) */
function themeSatisfied(required: PenTheme, effective: PenTheme): boolean {
  for (const [axis, val] of Object.entries(required)) {
    if (effective[axis] !== val) return false;
  }
  return true;
}

/** Merge a node's own theme onto its inherited theme. */
function mergeTheme(inherited: PenTheme, own: PenTheme | undefined): PenTheme {
  return own ? { ...inherited, ...own } : inherited;
}

// ---- Fill / stroke / effect resolution -----------------------------------

/** Extract the first enabled solid color from a .pen Fills value.
 *  If the fill is a gradient, returns the first stop's color as the
 *  fallback solid fill (so `shape.fill` stays in sync with the gradient). */
function resolveSolidColor(fills: PenFills | undefined, variables: any, theme: PenTheme): string {
  if (!fills) return '#e2e8f0';
  const arr = Array.isArray(fills) ? fills : [fills];
  for (const f of arr) {
    if (typeof f === 'string') return resolveValue(f, variables, theme);
    if (f.enabled === false) continue;
    if (f.type === 'color') return resolveValue(f.color, variables, theme);
    if (f.type === 'gradient' && f.colors && f.colors.length > 0) {
      return resolveValue(f.colors[0].color, variables, theme);
    }
  }
  return '#e2e8f0';
}

/** Extract the first gradient (for our GradientFill). */
function resolveGradient(fills: PenFills | undefined, variables: any, theme: PenTheme): GradientFill | null {
  if (!fills) return null;
  const arr = Array.isArray(fills) ? fills : [fills];
  for (const f of arr) {
    if (typeof f === 'object' && f.type === 'gradient') {
      return {
        type: f.gradientType === 'radial' ? 'radial' : 'linear',
        angle: typeof f.rotation === 'number' ? f.rotation : 90,
        stops: (f.colors ?? []).map((c) => ({
          offset: typeof c.position === 'number' ? c.position : 0,
          color: resolveValue(c.color, variables, theme),
        })),
      };
    }
  }
  return null;
}

/** Resolve stroke: returns { color, width } (first enabled fill of the stroke). */
function resolveStroke(node: any, variables: any, theme: PenTheme): { color: string; width: number } {
  const stroke = node.stroke;
  if (!stroke) return { color: '#0f172a', width: 0 };
  const color = resolveSolidColor(stroke, variables, theme);
  const sw = node.strokeWidth;
  let width = 0;
  if (typeof sw === 'number') width = sw;
  else if (sw && typeof sw === 'object') width = Math.max(sw.top ?? 0, sw.right ?? 0, sw.bottom ?? 0, sw.left ?? 0);
  return { color, width };
}

/** Resolve effects: first shadow (drop or inner) + first blur (layer or background). */
function resolveEffects(node: any, variables: any, theme: PenTheme): { shadow: ShadowEffect | null; blur: number; shadows: ShadowEffect[] | null; backgroundBlur: number } {
  const effects = node.effect;
  const empty = { shadow: null, blur: 0, shadows: null, backgroundBlur: 0 };
  if (!effects) return empty;
  const arr = Array.isArray(effects) ? effects : [effects];
  let shadow: ShadowEffect | null = null;
  let blur = 0;
  // Audit 4 C4: collect ALL shadows (first → `shadow` for compat) and track
  // background blur separately from layer blur — the DOM renderer composes
  // multi-shadow box-shadow lists and applies backdrop-filter for
  // background blur (the Figma glass effect previously collapsed into a
  // self-blur, which is the wrong visual).
  const allShadows: ShadowEffect[] = [];
  let backgroundBlur = 0;
  for (const e of arr) {
    if (e.enabled === false) continue;
    if (e.type === 'shadow') {
      const s: ShadowEffect = {
        x: typeof e.offset?.x === 'number' ? e.offset.x : 0,
        y: typeof e.offset?.y === 'number' ? e.offset.y : 0,
        blur: typeof e.blur === 'number' ? e.blur : 0,
        color: resolveValue(e.color ?? '#000000', variables, theme),
        spread: typeof e.spread === 'number' ? e.spread : 0,
        inset: e.shadowType === 'inner',
      };
      allShadows.push(s);
      if (!shadow) shadow = s;
    } else if (e.type === 'blur') {
      // Layer blur (filter: blur on the node itself).
      if (blur === 0) blur = typeof e.radius === 'number' ? e.radius : 0;
    } else if (e.type === 'background_blur') {
      // Background blur (backdrop-filter — glass effect).
      if (backgroundBlur === 0) backgroundBlur = typeof e.radius === 'number' ? e.radius : 0;
    }
  }
  return { shadow, blur, shadows: allShadows.length > 1 ? allShadows : null, backgroundBlur };
}

// ---- Sizing ---------------------------------------------------------------

function num(v: unknown, def: number): number {
  if (v === null || v === undefined) return def;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    if (v === 'fit_content' || v === 'fill_container') return def;
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  }
  return def;
}

function isFitContent(v: unknown): boolean {
  return typeof v === 'string' && v.startsWith('fit_content');
}
function isFillContainer(v: unknown): boolean {
  return typeof v === 'string' && v.startsWith('fill_container');
}

/**
 * VLM-exercise Fix 7: normalize layout-direction spellings. Models send
 * 'VERTICAL'/'Vertical'/'row'/'column' (observed: 'VERTICAL' in an
 * add_subtree payload) — the strict `=== 'vertical'` checks silently fell
 * those to the absolute-positioning branch, stacking every child at the
 * parent origin (entire pricing cards rendered as overlapping piles).
 */
function normalizeLayoutDir(v: unknown): 'horizontal' | 'vertical' | 'none' {
  if (typeof v !== 'string') return 'none';
  const s = v.trim().toLowerCase();
  if (s === 'horizontal' || s === 'row') return 'horizontal';
  if (s === 'vertical' || s === 'column') return 'vertical';
  if (s === 'none' || s === '') return 'none';
  // Unknown spellings (including legacy uppercase variants already lowered
  // above) degrade to 'none' — layoutChildren only understands the union.
  return 'none';
}

// ---- Layout (simplified flexbox) -----------------------------------------
//
// Two-pass:
//   Pass 1 (bottom-up): compute intrinsic sizes (fit_content needs children).
//   Pass 2 (top-down): compute absolute positions from parent content box.

interface ResolvedNode {
  node: PenChild;
  parent: PenChild | null;
  depth: number;
  // Computed during layout:
  absX: number;
  absY: number;
  width: number;
  height: number;
  // Effective theme (inherited):
  theme: PenTheme;
  // Content stamp of the inherited-theme chain at this node (R9c — emit-cache
  // key; mergeTheme mints fresh merged objects per call for themed nodes, so
  // identity cannot key the cache).
  themeStamp?: string;
  // Resolved children (populated during bottom-up pass).
  _kids?: ResolvedNode[];
}

/**
 * Safely read `width`/`height` from any .pen node. These props exist on
 * most node types (rectangle, ellipse, frame, text, …) but `PenChild` is a
 * discriminated union and TS can't see them without narrowing. All node
 * types that lack an explicit width/height default to fit_content/auto.
 */
function nodeWidth(node: PenChild): unknown {
  return (node as { width?: unknown }).width;
}
function nodeHeight(node: PenChild): unknown {
  return (node as { height?: unknown }).height;
}

/**
 * VLM-exercise Fix 2: fontSize-based size ESTIMATE for text nodes with no
 * explicit width/height. Previously every such text fell to the generic
 * 100×100 placeholder — inflating auto-layout stacks (100px gaps between
 * labels), pushing children past container bounds, and (before the culling
 * gate fix) getting whole sections paint-clipped out of the render.
 *
 * Heuristic: average glyph advance ≈ 0.62 × fontSize (matches the system
 * prompt's TEXT LAYER WIDTH RULE — 0.55 proved too tight for digit- and
 * cap-heavy strings: "$12" rendered "$1", "Team" rendered "Tea") plus 6px
 * slack; line height ≈ 1.35 × fontSize (DomCanvas uses ~1.4 with paddingTop
 * 0). Slight over-estimation is safe (text left-aligns in its box); clipping
 * is not. The DOM renderer's measured-bounds readback replaces these with
 * real sizes in native mode.
 */
function estimateTextSize(node: PenChild): { width: number; height: number } | null {
  if (node.type !== 'text') return null;
  const content = (node as { content?: unknown; text?: unknown }).content ??
    (node as { text?: unknown }).text;
  if (content === undefined || content === null) return null;
  const str = String(content);
  const fontSize = num((node as { fontSize?: unknown }).fontSize, 16);
  const lines = str.split('\n');
  const longest = lines.reduce((acc, l) => Math.max(acc, l.length), 0);
  const estWidth = Math.max(1, Math.round(longest * fontSize * 0.62) + 6);
  const estHeight = Math.max(1, Math.round(lines.length * fontSize * 1.35));
  return { width: estWidth, height: estHeight };
}

/** Compute the intrinsic size of a node, given its (already-sized) children.
 *  Uses a two-phase approach for fill_container children: first sizes
 *  non-fill children to determine the parent's fit_content size, then
 *  resolves fill_container children against the now-known parent size.
 *  `measured` (spec §3.8 readback) supplies real browser-measured sizes for
 *  fit_content nodes with no intrinsic content — consulted before the
 *  100×100 placeholder fallback. `warn` (optional) receives the
 *  placeholder_size degradation warning when the fallback fires. */
function computeIntrinsicSize(
  node: PenChild,
  children: ResolvedNode[],
  parentContentW: number,
  parentContentH: number,
  measured?: Record<string, { width: number; height: number }>,
  warn?: (kind: ResolverWarningKind, message: string) => void,
): { width: number; height: number } {
  let width: number;
  let height: number;

  const w = nodeWidth(node);
  const h = nodeHeight(node);

  // Groups and sections without explicit dimensions auto-size (fit_content).
  // Frames/components without dimensions default to 100×100 (visible container).
  const hasExplicitW = w !== undefined && w !== null;
  const hasExplicitH = h !== undefined && h !== null;
  const implicitFitW = !hasExplicitW && (node.type === 'group' || node.type === 'section');
  const implicitFitH = !hasExplicitH && (node.type === 'group' || node.type === 'section');

  // VLM-exercise Fix 2: text nodes without explicit dimensions get a
  // fontSize-based estimate instead of the generic 100×100 placeholder.
  const textEstimate = estimateTextSize(node);

  if (isFillContainer(w)) width = parentContentW;
  else if (isFitContent(w) || implicitFitW) width = 0; // computed from children below
  else width = num(w, node.type === 'icon' ? 24 : textEstimate?.width ?? 100); // icons default to the lucide 24×24 grid

  if (isFillContainer(h)) height = parentContentH;
  else if (isFitContent(h) || implicitFitH) height = 0;
  else height = num(h, node.type === 'icon' ? 24 : textEstimate?.height ?? 100);

  // fit_content: derive from children.
  const layout = normalizeLayoutDir((node as PenLayout).layout);
  const gap = num((node as PenLayout).gap, 0);
  const pad = resolvePadding((node as PenLayout).padding);

  if (isFitContent(w) || isFitContent(h) || implicitFitW || implicitFitH) {
    // ---- Fix 5: two-phase sizing for fill_container children ----
    // Phase A: compute the parent's fit_content size from non-fill children
    // only (and children whose fill axis isn't the one we're computing).
    const nonFillKids = children.filter((c) => {
      const cw = nodeWidth(c.node);
      const ch = nodeHeight(c.node);
      if (isFitContent(w) && isFillContainer(cw)) return false;
      if (isFitContent(h) && isFillContainer(ch)) return false;
      return true;
    });

    // Depth-research 3-b #1 (Figma auto-layout guide): a hug (fit_content)
    // axis whose ONLY children are fill_container on that axis has nothing to
    // measure — in Figma a fill child makes the parent stop hugging (the
    // parent goes Fixed); here the hug falls through to the placeholder.
    // Fire only in the degenerate all-fill case — a healthy mix of fill and
    // non-fill siblings resolves correctly (Phase A/B) and must stay quiet.
    if (children.length > 0) {
      const allFillW = isFitContent(w) && children.every((c) => isFillContainer(nodeWidth(c.node)));
      const allFillH = isFitContent(h) && children.every((c) => isFillContainer(nodeHeight(c.node)));
      if (allFillW || allFillH) {
        const axis = allFillW && allFillH ? 'width and height' : allFillW ? 'width' : 'height';
        warn?.(
          'hug_fill_conflict',
          `fit_content ${axis} with ONLY fill_container children — the hug has nothing to measure (a fill child cannot size its parent; Figma turns the parent Fixed). Give the parent an explicit ${axis === 'width and height' ? 'width/height' : axis}, or make at least one child non-fill`,
        );
      }
    }

    if (layout === 'horizontal') {
      const main = nonFillKids.reduce((acc, c, i) => acc + c.width + (i > 0 ? gap : 0), 0);
      const cross = nonFillKids.reduce((acc, c) => Math.max(acc, c.height), 0);
      if (isFitContent(w)) width = main + pad.left + pad.right;
      if (isFitContent(h)) height = cross + pad.top + pad.bottom;
    } else if (layout === 'vertical') {
      const main = nonFillKids.reduce((acc, c, i) => acc + c.height + (i > 0 ? gap : 0), 0);
      const cross = nonFillKids.reduce((acc, c) => Math.max(acc, c.width), 0);
      if (isFitContent(w)) width = cross + pad.left + pad.right;
      if (isFitContent(h)) height = main + pad.top + pad.bottom;
    } else {
      // No layout — fit to bounding box of absolutely-positioned children.
      // Use stored x/y (not absX/absY, which aren't set yet in bottom-up pass).
      if (nonFillKids.length > 0) {
        const positions = nonFillKids.map((c) => ({ x: num(c.node.x, 0), y: num(c.node.y, 0) }));
        const maxX = Math.max(...positions.map((p, i) => p.x + nonFillKids[i].width));
        const maxY = Math.max(...positions.map((p, i) => p.y + nonFillKids[i].height));
        const minX = Math.min(...positions.map((p) => p.x));
        const minY = Math.min(...positions.map((p) => p.y));
        if (isFitContent(w) || implicitFitW) width = (maxX - minX) + pad.left + pad.right;
        if (isFitContent(h) || implicitFitH) height = (maxY - minY) + pad.top + pad.bottom;
      }
    }


    // Fallback if still 0 after sizing: 0×0 for groups/sections (invisible containers),
    // 100×100 for other types (frames, components) which need a minimum visible size.
    // Spec §3.8 measured-bounds readback: when the DOM renderer has measured
    // this node for real (native layout mode), prefer the measured size over
    // the 100×100 prediction placeholder. VLM-exercise Fix 2: text nodes use
    // the fontSize-based estimate before falling to the generic placeholder.
    const measuredFor = measured?.[node.id];
    const isIntentionalInvisible = node.type === 'group' || node.type === 'section';
    if ((isFitContent(w) || implicitFitW) && width === 0) {
      if (measuredFor && Number.isFinite(measuredFor.width) && measuredFor.width > 0) width = measuredFor.width;
      else if (textEstimate) width = textEstimate.width;
      else if (isIntentionalInvisible) width = 0;
      else {
        width = 100;
        warn?.('placeholder_size', `fit_content width resolved to the 100px placeholder (no intrinsic content and no measured-bounds hint) — set an explicit width or give the node measurable children`);
      }
    }
    if ((isFitContent(h) || implicitFitH) && height === 0) {
      if (measuredFor && Number.isFinite(measuredFor.height) && measuredFor.height > 0) height = measuredFor.height;
      else if (textEstimate) height = textEstimate.height;
      else if (isIntentionalInvisible) height = 0;
      else {
        height = 100;
        warn?.('placeholder_size', `fit_content height resolved to the 100px placeholder (no intrinsic content and no measured-bounds hint) — set an explicit height or give the node measurable children`);
      }
    }
  }


  // Fix 5: Phase B — always resolve fill_container children against the
  // computed parent size (even for parents with explicit dimensions).
  const finalContentW = Math.max(0, width - pad.left - pad.right);
  const finalContentH = Math.max(0, height - pad.top - pad.bottom);
  for (const c of children) {
    if (isFillContainer(nodeWidth(c.node))) {
      c.width = finalContentW;
    }
    if (isFillContainer(nodeHeight(c.node))) {
      c.height = finalContentH;
    }
  }

  // Prompt-tuning deferred-critique fix: clipped-text warning. A text node
  // whose EXPLICIT width (or height) is narrower than the estimated rendered
  // content will visually truncate — verified defect: "Growth Metrics" @38px
  // in a 120px box rendered as "Grow…". Tolerance is calibrated to the
  // estimator's error band (0.62 × fontSize average advance is a heuristic
  // with ±20% error): 30% / 12px on width, 25% / 6px on height. A designed
  // tight fit ("Card title" @16px in an 80px box, est. 105px) stays silent;
  // only definite clipping (120px box for a 336px string) fires. Native
  // (measured) mode replaces estimates with real bounds, so this only guards
  // the resolver/static path.
  if (node.type === 'text' && textEstimate) {
    const explicitW = w !== undefined && w !== null && !isFitContent(w) && !isFillContainer(w);
    const explicitH = h !== undefined && h !== null && !isFitContent(h) && !isFillContainer(h);
    const label = String((node as { name?: unknown }).name ?? 'text');
    if (explicitW && width + Math.max(12, textEstimate.width * 0.3) < textEstimate.width) {
      warn?.(
        'text_overflow',
        `"${label}" is ${Math.round(width)}px wide but its text needs ~${textEstimate.width}px — it will be CLIPPED. Widen it to ≥${textEstimate.width}px, set width:"fit_content", or shorten the text.`,
      );
    } else if (explicitH && height + Math.max(6, textEstimate.height * 0.25) < textEstimate.height) {
      warn?.(
        'text_overflow',
        `"${label}" is ${Math.round(height)}px tall but its text needs ~${textEstimate.height}px — lines will be CLIPPED. Set height:"fit_content" or size it to the line count.`,
      );
    }
  }

  return { width: Math.max(0, width), height: Math.max(0, height) };
}

interface Padding { top: number; right: number; bottom: number; left: number; }
function resolvePadding(pad: PenLayout['padding']): Padding {
  if (pad === undefined || pad === null) return { top: 0, right: 0, bottom: 0, left: 0 };
  if (typeof pad === 'number') return { top: pad, right: pad, bottom: pad, left: pad };
  if (Array.isArray(pad)) {
    if (pad.length === 2) {
      const v = num(pad[0], 0);
      const h = num(pad[1], 0);
      return { top: v, bottom: v, left: h, right: h };
    }
    if (pad.length === 4) {
      return { top: num(pad[0], 0), right: num(pad[1], 0), bottom: num(pad[2], 0), left: num(pad[3], 0) };
    }
  }
  return { top: 0, right: 0, bottom: 0, left: 0 };
}

// ---- Constraint helpers ---------------------------------------------------
//
// Figma constraints define how a child is pinned relative to its parent.
// The child's stored x/y is interpreted differently per constraint mode:
//   left    — x is distance from parent's left edge
//   right   — x is distance from parent's right edge (inverted)
//   center  — child is centered; stored x is ignored
//   scale   — x is a ratio (0..1) of parent content width
//   left_right — child stretches to fill (x = 0, width = contentW)

function applyConstraintH(mode: string, storedX: number, childW: number, contentW: number): number {
  // Phase 6 dual-field window: constraints may be stored in EITHER casing
  // (legacy lowercase from patches; SCREAMING from the v3 migration) —
  // normalize to lowercase so both spellings hit identical behavior.
  const m = typeof mode === 'string' ? mode.toLowerCase() : mode;
  switch (m) {
    case 'right': return contentW - childW - storedX;
    case 'center': return (contentW - childW) / 2;
    case 'scale': return storedX * contentW;
    case 'left_right': return 0; // width override handled separately
    case 'left':
    default: return storedX;
  }
}

function applyConstraintV(mode: string, storedY: number, childH: number, contentH: number): number {
  // See applyConstraintH — both spellings behave identically.
  const m = typeof mode === 'string' ? mode.toLowerCase() : mode;
  switch (m) {
    case 'bottom': return contentH - childH - storedY;
    case 'center': return (contentH - childH) / 2;
    case 'scale': return storedY * contentH;
    case 'top_bottom': return 0; // height override handled separately
    case 'top':
    default: return storedY;
  }
}

/** Position children inside a parent's content box per flexbox rules.
 *  Fix 1: handles layoutPosition:'absolute' by skipping flex entirely.
 *  Fix 2: applies Figma-style constraints in 'none' layout mode. */
function layoutChildren(
  parent: ResolvedNode,
  children: ResolvedNode[],
  layout: PenLayout['layout'],
): void {
  const pad = resolvePadding((parent.node as PenLayout).padding);
  const gap = num((parent.node as PenLayout).gap, 0);
  const justify = (parent.node as PenLayout).justifyContent ?? 'start';
  const align = (parent.node as PenLayout).alignItems ?? 'start';

  const contentW = parent.width - pad.left - pad.right;
  const contentH = parent.height - pad.top - pad.bottom;

  // Fix 1: separate absolutely-positioned children from flow children.
  // layoutPosition:'absolute' opts the child out of flex entirely (Figma behavior).
  const flowChildren: ResolvedNode[] = [];
  const absChildren: ResolvedNode[] = [];
  for (const c of children) {
    if ((c.node as any).layoutPosition === 'absolute') {
      absChildren.push(c);
    } else {
      flowChildren.push(c);
    }
  }

  const layoutFlow = (kids: ResolvedNode[]) => {
    if (layout === 'horizontal') {
      const totalChildMain = kids.reduce((acc, c) => acc + c.width, 0);
      const totalGap = kids.length > 1 ? gap * (kids.length - 1) : 0;
      const used = totalChildMain + totalGap;
      let cursor = pad.left;
      let betweenGap = gap;
      if (justify === 'center') cursor = pad.left + (contentW - used) / 2;
      else if (justify === 'end') cursor = pad.left + (contentW - used);
      else if (justify === 'space_between' && kids.length > 1) {
        betweenGap = (contentW - totalChildMain) / (kids.length - 1);
        cursor = pad.left;
      } else if (justify === 'space_around' && kids.length > 1) {
        betweenGap = (contentW - totalChildMain) / kids.length;
        cursor = pad.left + betweenGap / 2;
      }
      for (let i = 0; i < kids.length; i++) {
        const c = kids[i];
        c.absX = parent.absX + cursor;
        let cross = pad.top;
        if (align === 'center') cross = pad.top + (contentH - c.height) / 2;
        else if (align === 'end') cross = pad.top + (contentH - c.height);
        c.absY = parent.absY + cross;
        cursor += c.width + (i < kids.length - 1 ? betweenGap : 0);
      }
    } else if (layout === 'vertical') {
      const totalChildMain = kids.reduce((acc, c) => acc + c.height, 0);
      const totalGap = kids.length > 1 ? gap * (kids.length - 1) : 0;
      const used = totalChildMain + totalGap;
      let cursor = pad.top;
      let betweenGap = gap;
      if (justify === 'center') cursor = pad.top + (contentH - used) / 2;
      else if (justify === 'end') cursor = pad.top + (contentH - used);
      else if (justify === 'space_between' && kids.length > 1) {
        betweenGap = (contentH - totalChildMain) / (kids.length - 1);
        cursor = pad.top;
      } else if (justify === 'space_around' && kids.length > 1) {
        betweenGap = (contentH - totalChildMain) / kids.length;
        cursor = pad.top + betweenGap / 2;
      }
      for (let i = 0; i < kids.length; i++) {
        const c = kids[i];
        c.absY = parent.absY + cursor;
        let cross = pad.left;
        if (align === 'center') cross = pad.left + (contentW - c.width) / 2;
        else if (align === 'end') cross = pad.left + (contentW - c.width);
        c.absX = parent.absX + cross;
        cursor += c.height + (i < kids.length - 1 ? betweenGap : 0);
      }
    } else {
      // Fix 2: layout === 'none' — apply Figma-style constraints when present.
      for (const c of kids) {
        const constraints = (c.node as any).constraints as import('../canvas/types').Constraints | undefined;
        if (constraints) {
          c.absX = parent.absX + applyConstraintH(constraints.horizontal, num(c.node.x, 0), c.width, contentW);
          c.absY = parent.absY + applyConstraintV(constraints.vertical, num(c.node.y, 0), c.height, contentH);
        } else {
          c.absX = parent.absX + num(c.node.x, 0);
          c.absY = parent.absY + num(c.node.y, 0);
        }
      }
    }
  };

  layoutFlow(flowChildren);

  // Fix 1: position absolute children using their own x/y relative to parent.
  for (const c of absChildren) {
    c.absX = parent.absX + num(c.node.x, 0);
    c.absY = parent.absY + num(c.node.y, 0);
  }
}

// ---- Main resolve pass ----------------------------------------------------

/**
 * Resolve a .pen document tree into a flat list of `Shape` render nodes
 * with absolute positions, expanded refs, and resolved variables/themes.
 * Thin wrapper over `resolvePenTreeDetailed` — identical behavior.
 */
// ---- WCAG color utilities (depth-research 3-b: contrast as arithmetic) -----
//
// The contrast lint needs to turn resolved paint strings into numbers.
// Accepts the color vocabulary the agent + variables actually emit
// (#rgb / #rrggbb / #rrggbbaa / rgb() / rgba()); anything else (oklch(),
// named colors, unresolved '$var' strings) parses to null and the check
// silently skips — a lint that guesses is worse than one that stays quiet.

export interface RgbaColor { r: number; g: number; b: number; a: number }

/** Parse a CSS-ish color string to RGBA. Returns null when unsupported. */
export function parseCssColor(input: unknown): RgbaColor | null {
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  if (s === '' || s.startsWith('$')) return null;
  // #rgb / #rgba / #rrggbb / #rrggbbaa
  if (s[0] === '#') {
    const hex = s.slice(1);
    if (!/^[0-9a-f]+$/.test(hex)) return null;
    const expand = (h: string) => parseInt(h.length === 1 ? h + h : h, 16);
    if (hex.length === 3 || hex.length === 4) {
      return { r: expand(hex[0]), g: expand(hex[1]), b: expand(hex[2]), a: hex.length === 4 ? expand(hex[3]) / 255 : 1 };
    }
    if (hex.length === 6 || hex.length === 8) {
      return { r: expand(hex.slice(0, 2)), g: expand(hex.slice(2, 4)), b: expand(hex.slice(4, 6)), a: hex.length === 8 ? expand(hex.slice(6, 8)) / 255 : 1 };
    }
    return null;
  }
  // rgb() / rgba() — comma or space separated.
  const m = s.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const nums = parts.slice(0, 3).map((p) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p)));
    if (nums.some((n) => !Number.isFinite(n))) return null;
    const a = parts.length > 3 ? parseFloat(parts[3]) : 1;
    return { r: nums[0], g: nums[1], b: nums[2], a: Number.isFinite(a) ? Math.max(0, Math.min(1, a)) : 1 };
  }
  return null; // oklch(), hsl(), named colors — unsupported, check skips
}

/** WCAG 2.x relative luminance of an opaque sRGB color. */
export function relativeLuminance(c: RgbaColor): number {
  const lin = (v: number) => {
    const ch = Math.max(0, Math.min(255, v)) / 255;
    return ch <= 0.04045 ? ch / 12.92 : Math.pow((ch + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG contrast ratio between two colors (range 1..21). */
export function contrastRatio(a: RgbaColor, b: RgbaColor): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Alpha-composite `fg` over `bg` (both parsed colors). */
function compositeOver(fg: RgbaColor, bg: RgbaColor): RgbaColor {
  const a = fg.a + bg.a * (1 - fg.a);
  if (a <= 0) return { r: 255, g: 255, b: 255, a: 0 };
  return {
    r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
    g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
    b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
    a,
  };
}

export function resolvePenTree(doc: CanvasDocument, opts?: ResolveOpts): Shape[] {
  return resolvePenTreeDetailed(doc, opts).layers;
}

// ---- Incremental resolve caches (Phase C, R9c) ---------------------------------
//
// tldraw structural-sharing + createComputedCache pattern: resolvePenTreeDetailed
// runs on EVERY document mutation (recomputeDerived at the tail of every
// applyPatchToCanvas, DomCanvas's native-mode useMemo, canvasSnapshot per
// turn, the journal fold per row). Before R9c every call deep-cloned every
// container during ref expansion (regenerating instance-descendant UUIDs),
// re-ran the full emit (~45-field Shape literal per node), and minted
// brand-new objects — so the DomNode React.memo could NEVER hit and the whole
// world tree re-rendered on every patch.
//
// Two caches fix that, both keyed on PEN NODE OBJECT IDENTITY (WeakMap —
// entries die with their nodes):
//
//   1. Expansion cache (expandTree): while a container's children ARRAY keeps
//      its identity (the appliers' path-copy discipline), the previous
//      expansion RESULT is reused — same expanded array, same container clone
//      object, same ref-expansion subtrees. Unchanged containers are returned
//      AS-IS (identity preserved into ResolvedTreeNode.pen); containers whose
//      subtree actually changed get a CACHED clone (stable identity while the
//      structure is stable).
//
//   2. Emit cache: per node, the emitted Shape + resolved subtree are reused
//      when EVERY input the emit reads is unchanged. The stamp covers:
//        - `sub`  — an order-sensitive hash of the subtree: node id, version,
//          post-layout geometry (absX/absY/width/height), and the kids' hashes
//          recursively (so any descendant content OR geometry change
//          invalidates its ancestors, while a fixed-size ancestor whose
//          geometry did not move still hits);
//        - themeStamp — content-stamped effective theme chain (mergeTheme
//          returns the inherited identity only when the node has no own
//          theme, so identity alone is not enough);
//        - varsStamp — memoized serialization of doc.variables (patch.ts
//          shallow-copies it per patch, identity churns);
//        - parentId + zIndex — emit-context (a reparent or an insertion
//          before this node in DFS order shifts both).
//
//      measuredBounds is deliberately NOT a stamp field: hints only influence
//      the emit THROUGH phase-2 geometry, which IS stamped — so a measurement
//      of one node invalidates exactly that node's ancestors and subtree,
//      nothing else.
//
// Correctness contract: the pen tree is treated as immutable (path-copy on
// update — the same discipline Phase A's reconcile relies on). In-place
// mutation of a node or its children array would go unnoticed by these
// caches. The emit-cache slots are per-node and stamp-matched, so the
// with-hints (recomputeDerived) and no-hints (DomCanvas native) resolve
// flavors coexist without cross-contamination.

interface EmitCacheEntry {
  /// Order-sensitive subtree content/geometry hash (see module doc).
  sub: number;
  /// Content stamp of the effective theme chain.
  themeStamp: string;
  /// Content stamp of doc.variables.
  varsStamp: string;
  /// Parent id at emit time.
  parentId: string | null;
  /// This node's own zIndex (the DFS counter value when it was emitted).
  zIndex: number;
  /// DFS-flat Shape slice for the whole subtree (own shape at [0]).
  flat: Shape[];
  /// The subtree's ResolvedTreeNode (layer + pen + children).
  treeNode: ResolvedTreeNode;
  /// The DFS counter value AFTER this subtree was emitted.
  zIndexEnd: number;
  /// Warnings emitted inside this subtree during the storing call — replayed
  /// (with per-call dedupe) whenever the entry hits, so cached subtrees keep
  /// reporting their degradation.
  warnings: ResolverWarning[];
}

/// Slots per node: recomputeDerived-with-hints, DomCanvas-no-hints, and one
/// spare for a measured-flush transition. FIFO beyond that.
const EMIT_CACHE_SLOTS = 3;

let emitCache = new WeakMap<PenChild, EmitCacheEntry[]>();
let containerExpansionCache = new WeakMap<PenChild, { kids: PenChild[]; expandedKids: PenChild[]; outChild: PenChild }>();
let containerCloneCache = new WeakMap<PenChild, { kids: PenChild[]; clone: PenChild }>();
let refExpansionCache = new WeakMap<PenRef, { target: PenChild | null; expanded: PenChild | null }>();
const themeSerializedMemo = new WeakMap<object, string>();
const varsStampMemo = new WeakMap<object, string>();

/// Cache stats (test/diagnostic visibility only).
export const resolveCacheStats = { emitHits: 0, emitMisses: 0 };

/// Test hook: wipe every incremental-resolve cache + stats.
export function __clearResolveCachesForTests(): void {
  emitCache = new WeakMap();
  containerExpansionCache = new WeakMap();
  containerCloneCache = new WeakMap();
  refExpansionCache = new WeakMap();
  resolveCacheStats.emitHits = 0;
  resolveCacheStats.emitMisses = 0;
}

function varsStampOf(vars: unknown): string {
  if (!vars || typeof vars !== 'object') return '';
  const obj = vars as Record<string, unknown>;
  let s = varsStampMemo.get(obj);
  if (s === undefined) {
    try {
      s = JSON.stringify(obj);
    } catch {
      s = `unserializable-${Math.random()}`;
    }
    varsStampMemo.set(obj, s);
  }
  return s;
}

/// Content stamp for one link of the inherited-theme chain: the inherited
/// stamp plus this node's own theme (memoized serialization — the own-theme
/// OBJECT identity is stable across calls because it is a field of the pen
/// node, but mergeTheme mints a fresh merged object per call for themed
/// nodes, so identity cannot key it).
function stampTheme(inheritedStamp: string, own: unknown): string {
  if (!own || typeof own !== 'object') return inheritedStamp;
  const keys = Object.keys(own as Record<string, unknown>);
  if (keys.length === 0) return inheritedStamp;
  const obj = own as object;
  let s = themeSerializedMemo.get(obj);
  if (s === undefined) {
    s = JSON.stringify(own);
    themeSerializedMemo.set(obj, s);
  }
  return inheritedStamp + '|' + s;
}

/**
 * Resolve a .pen document tree into BOTH representations the renderers need
 * (spec Phase 2):
 *   - `layers`: the flat, depth-first `Shape[]` (identical to
 *     `resolvePenTree`'s output — the SVG renderer + parity-mode DOM
 *     renderer + panels consume this).
 *   - `tree`: the pre-flattening tree (`ResolvedTreeNode[]`) pairing each
 *     emitted Shape with its source .pen node and resolved children — the
 *     DOM renderer's NATIVE layout mode consumes this so it can emit real
 *     CSS flexbox for `layout ≠ 'none'` containers.
 */
export function resolvePenTreeDetailed(doc: CanvasDocument, opts?: ResolveOpts): { layers: Shape[]; tree: ResolvedTreeNode[]; warnings: ResolverWarning[] } {
  const measured = opts?.measuredBounds;
  const variables = doc.variables;
  const components = collectComponents(doc.children);
  const out: Shape[] = [];
  let zIndex = 0;

  // Degradation-warning collector: deduped by (nodeId, kind) — the resolver
  // may revisit a node id across ref-expansion clones. External accumulator
  // (opts.warnings) receives the same entries for cross-patch aggregation.
  const warnings: ResolverWarning[] = [];
  const warnSeen = new Set<string>();
  const warn = (node: PenChild | { id?: unknown; type?: unknown }, kind: ResolverWarningKind, message: string): void => {
    const id = typeof (node as { id?: unknown }).id === 'string' ? (node as { id: string }).id : '(no id)';
    const key = `${id}::${kind}`;
    if (warnSeen.has(key)) return;
    warnSeen.add(key);
    const nodeType = typeof (node as { type?: unknown }).type === 'string' ? (node as { type: string }).type : undefined;
    const entry: ResolverWarning = { nodeId: id, nodeType, kind, message };
    warnings.push(entry);
    opts?.warnings?.push(entry);
  };

  // First, expand all refs into a working tree (refs become their resolved
  // subtrees) — IDENTITY-PRESERVING (R9c): a container whose subtree has no
  // refs and unchanged children is returned AS-IS; containers that did change
  // get a CACHED clone (stable identity while the structure is stable); ref
  // expansions are cached per (ref node, target) so instance-descendant ids
  // stop regenerating on every resolve. The children ARRAY identity is the
  // validity key (path-copy discipline — see the R9c module doc).
  function expandTree(children: PenChild[], inheritedTheme: PenTheme): PenChild[] {
    const src = children ?? [];
    if (src.length === 0) return src;
    let anyChanged = false;
    const result: PenChild[] = [];
    for (const child of src) {
      if (child.type === 'ref') {
        const expanded = expandRefCached(child as PenRef);
        if (!expanded) {
          // Missing target (unknown id / not reusable) — the node is DROPPED
          // entirely. This is the agent's most likely ref mistake, so the
          // warning names the target id.
          warn(child, 'dropped_ref', `ref target "${(child as PenRef).ref}" not found (unknown id, or the target node is not reusable:true) — the instance was DROPPED and renders nothing`);
          anyChanged = true;
          continue;
        }
        result.push(expanded);
        anyChanged = true; // a ref is always replaced by its expansion
        continue;
      }
      if (isContainerNode(child) && child.children) {
        let expandedKids: PenChild[];
        let outChild: PenChild;
        const cached = containerExpansionCache.get(child);
        if (cached && cached.kids === child.children) {
          expandedKids = cached.expandedKids;
          outChild = cached.outChild;
        } else {
          expandedKids = expandTree(child.children, inheritedTheme);
          outChild = expandedKids === child.children ? child : cloneContainerCached(child, expandedKids);
          containerExpansionCache.set(child, { kids: child.children, expandedKids, outChild });
        }
        result.push(outChild);
        if (outChild !== child) anyChanged = true;
        continue;
      }
      result.push(child);
    }
    return anyChanged ? result : src;
  }

  /// Ref expansion through the (ref-node, target) cache. Same ref node + same
  /// component target ⇒ the SAME expanded subtree object across resolves
  /// (stable instance-descendant ids — they previously regenerated per call,
  /// churning React keys + WeakMap keys for every instance descendant).
  function expandRefCached(ref: PenRef): PenChild | null {
    const target = components.get(ref.ref) ?? null;
    const cached = refExpansionCache.get(ref);
    if (cached && cached.target === target) return cached.expanded;
    const expanded = expandRef(ref, components);
    refExpansionCache.set(ref, { target, expanded });
    return expanded;
  }

  /// Container clone with a stable identity while the (container, kids) pair
  /// is unchanged.
  function cloneContainerCached(child: PenChild, kids: PenChild[]): PenChild {
    const cached = containerCloneCache.get(child);
    if (cached && cached.kids === kids) return cached.clone;
    const clone = { ...child, children: kids } as PenChild;
    containerCloneCache.set(child, { kids, clone });
    return clone;
  }

  // Defensive: if doc.children is missing (e.g. legacy test fixtures), treat as empty.
  const expanded = expandTree(doc.children ?? [], {});

  // Recursive resolve: compute sizes bottom-up, then positions top-down.
  function resolve(
    children: PenChild[],
    parent: ResolvedNode | null,
    inheritedTheme: PenTheme,
  ): ResolvedNode[] {
    const nodes: ResolvedNode[] = children.map((node) => ({
      node,
      parent: parent?.node ?? null,
      depth: parent ? parent.depth + 1 : 0,
      absX: 0,
      absY: 0,
      width: 0,
      height: 0,
      theme: mergeTheme(inheritedTheme, (node as any).theme),
      themeStamp: stampTheme(parent ? parent.themeStamp ?? '' : '', (node as any).theme),
    }));

    // For leaf nodes (no children), compute size now.
    // For container nodes, resolve children first (bottom-up sizing), then
    // compute own size, then position children.
    for (const rn of nodes) {
      const n = rn.node;
      const parentContentW = parent ? parent.width - resolvePadding((parent.node as PenLayout).padding).left - resolvePadding((parent.node as PenLayout).padding).right : 0;
      const parentContentH = parent ? parent.height - resolvePadding((parent.node as PenLayout).padding).top - resolvePadding((parent.node as PenLayout).padding).bottom : 0;

      // Depth-research 3-b #1: fill_container at the PAGE ROOT has no parent
      // to fill, so the axis resolves to 0 (the node renders invisible).
      // Fire before sizing so the agent learns the intent is unresolvable
      // regardless of what the fallback does next.
      if (!parent) {
        if (isFillContainer(nodeWidth(n))) {
          warn(n, 'fill_without_parent', `fill_container width on a ROOT-level node — there is no parent to fill, so it resolves to 0 and the node is invisible. Set an explicit width or nest it inside an auto-layout frame`);
        }
        if (isFillContainer(nodeHeight(n))) {
          warn(n, 'fill_without_parent', `fill_container height on a ROOT-level node — there is no parent to fill, so it resolves to 0 and the node is invisible. Set an explicit height or nest it inside an auto-layout frame`);
        }
      }

      if (isContainerNode(n) && (n.children?.length ?? 0) > 0) {
        const kids = resolve(n.children!, rn, rn.theme);
        const { width, height } = computeIntrinsicSize(n, kids, parentContentW, parentContentH, measured, (kind, msg) => warn(n, kind, msg));
        rn.width = width;
        rn.height = height;
        rn._kids = kids;
      } else {
        const { width, height } = computeIntrinsicSize(n, [], parentContentW, parentContentH, measured, (kind, msg) => warn(n, kind, msg));
        rn.width = width;
        rn.height = height;
      }
    }

    // Position: top-level nodes use their own x/y; nested nodes are positioned
    // by the parent's layout — which now runs as a separate TOP-DOWN pass
    // after the whole tree is sized (see layoutTree below). Previously each
    // recursion level laid out its own children immediately, but a container
    // nested inside another container had absX/absY still 0 at that moment,
    // so grandchildren rendered missing all ancestor offsets above depth 1
    // (frames-in-frames, components-in-sections, grouped nested layers).
    if (!parent) {
      for (const rn of nodes) {
        rn.absX = num(rn.node.x, 0);
        rn.absY = num(rn.node.y, 0);
      }
    }

    return nodes;
  }

  /// Top-down layout pass: lay out each container's children only AFTER the
  /// container's own absolute position is final, then recurse. Guarantees
  /// layoutChildren never sees a stale parent.absX/absY.
  function layoutTree(nodes: (ResolvedNode & { _kids?: ResolvedNode[] })[]): void {
    for (const rn of nodes) {
      const kids = rn._kids;
      if (kids && kids.length > 0) {
        const layout = normalizeLayoutDir((rn.node as PenLayout).layout);
        // Both flex and absolute-positioning paths go through layoutChildren
        // (which handles constraints in the 'none' branch).
        layoutChildren(rn, kids, layout ?? 'none');

        // VLM-exercise Fix 3: agent-visible container_overflow warning. After
        // final positioning, does any direct child escape the container's
        // box? (1px tolerance for rounding.) Overflow now RENDERS (the L4
        // culling gate skips paint-clipping containers), but it escapes the
        // frame's background/fill — the design looks broken. This is almost
        // always a fixed height/width smaller than the flow content; the fix
        // is height:'fit_content' (hug). Warn only for containers with
        // EXPLICIT numeric dimensions — fit_content/implicit containers wrap
        // their children by construction and cannot overflow.
        const hasExplicitW = nodeWidth(rn.node) !== undefined && nodeWidth(rn.node) !== null && !isFitContent(nodeWidth(rn.node)) && !isFillContainer(nodeWidth(rn.node));
        const hasExplicitH = nodeHeight(rn.node) !== undefined && nodeHeight(rn.node) !== null && !isFitContent(nodeHeight(rn.node)) && !isFillContainer(nodeHeight(rn.node));
        if (hasExplicitW || hasExplicitH) {
          const escapees = kids.filter(
            (k) =>
              k.absX < rn.absX - 1 ||
              k.absY < rn.absY - 1 ||
              k.absX + k.width > rn.absX + rn.width + 1 ||
              k.absY + k.height > rn.absY + rn.height + 1,
          );
          if (escapees.length > 0) {
            // Prompt-tuning deferred-critique fix: report the WORST escape
            // across ALL overflow children, not the first child's worst axis
            // — the pricing defect (root frame h=100, 6 children flowing
            // ~1400px) previously understated as "extend ~0px".
            const overBy = Math.max(
              0,
              Math.round(
                Math.max(
                  ...escapees.map((k) =>
                    Math.max(
                      k.absY + k.height - (rn.absY + rn.height),
                      k.absX + k.width - (rn.absX + rn.width),
                      0,
                    ),
                  ),
                ),
              ),
            );
            warn(
              rn.node,
              'container_overflow',
              `"${String((rn.node as { name?: unknown }).name ?? 'container')}" has fixed dimensions but ${escapees.length} child${escapees.length > 1 ? 'ren' : ''} extend up to ~${overBy}px beyond its bounds (first escapee: "${String((escapees[0].node as { name?: unknown }).name ?? escapees[0].node.type)}") — the overflow renders OUTSIDE the frame's background. Set the container's height (and/or width) to "fit_content" so it hugs its content, or size it explicitly to fit.`,
            );
          }
        }

        // Prompt-tuning deferred-critique fix: auto-layout IGNORES x/y on
        // flow children. The pricing-toggle defect: the agent "moved" the
        // toggle up by setting y=-320 on a flow child of a vertical layout —
        // flex placed it LAST anyway (bottom-left, clipped). The login
        // defect: children carried sequential manual y-coordinates but the
        // array order contradicted them, so flow rendered them out of the
        // intended sequence.
        //
        // Detection compares INTENT vs REALITY: a flow child's stored axis
        // coordinate (≥40 magnitude — real intent, not padding leftovers)
        // against its ACHIEVED flow-relative position after layout. Both
        // must differ by ≥40px for a contradiction. A stale coordinate that
        // HAPPENS to match the flow position (YearlyOption x=160 landing at
        // 160) stays silent — the render already matches the intent.
        // At most ONE warning per container: the order-contradiction message
        // (≥2 contradicted, names the intended sequence) or the direct
        // message (1 contradicted).
        if (layout === 'horizontal' || layout === 'vertical') {
          const axis: 'x' | 'y' = layout === 'vertical' ? 'y' : 'x';
          const coordOf = (n: PenChild) => num((n as { x?: unknown; y?: unknown })[axis], 0);
          const achievedOf = (k: ResolvedNode) =>
            axis === 'y' ? k.absY - rn.absY : k.absX - rn.absX;
          const contradicted = kids.filter(
            (k) =>
              (k.node as { layoutPosition?: unknown }).layoutPosition !== 'absolute' &&
              Math.abs(coordOf(k.node)) >= 40 &&
              Math.abs(coordOf(k.node) - achievedOf(k)) >= 40,
          );
          if (contradicted.length >= 1) {
            const sorted = [...contradicted].sort((a, b) => coordOf(a.node) - coordOf(b.node));
            const k = sorted[0];
            warn(
              k.node,
              'flow_child_absolute_coords',
              contradicted.length >= 2
                ? `"${String((k.node as { name?: unknown }).name ?? k.node.type)}" (${axis}=${Math.round(coordOf(k.node))}) is in "${String((rn.node as { name?: unknown }).name ?? 'parent')}"'s ${layout} auto-layout, which IGNORES x/y and renders children in ARRAY order — the coordinate order you set (${sorted.map((s) => String((s.node as { name?: unknown }).name ?? s.node.type)).join(' → ')}) contradicts the render order. Either reorder the children to match, or set layoutPosition:"absolute" on the node you are pinning.`
                : `"${String((k.node as { name?: unknown }).name ?? k.node.type)}" has ${axis}=${Math.round(coordOf(k.node))} inside "${String((rn.node as { name?: unknown }).name ?? 'parent')}"'s ${layout} auto-layout — the layout engine IGNORES x/y on flow children and places them by ORDER, so this node is NOT at that coordinate (it renders in flow position ${kids.indexOf(k) + 1} of ${kids.length}). To pin it at specific coordinates: set layoutPosition:"absolute". To place it earlier/later: move it to that flow index.`,
            );
          }
        }

        layoutTree(kids as (ResolvedNode & { _kids?: ResolvedNode[] })[]);
      }
    }
  }

  // Augment ResolvedNode with an optional _kids slot (TS hack via any).
  const resolved = resolve(expanded, null, {}) as (ResolvedNode & { _kids?: ResolvedNode[] })[];
  // Sizing is done (bottom-up inside resolve); now position the whole tree
  // top-down so every level's parent offset is final before its children
  // are laid out.
  layoutTree(resolved);

  // Flatten depth-first, emitting Shape for each node. The walk builds BOTH
  // the flat list (`out` — parent pushed before its children, matching the
  // original emit order exactly) and the pre-flattening tree consumed by the
  // DOM renderer's native layout mode.
  // ---- R9c stamp machinery (per call) ------------------------------------
  const varsStamp = varsStampOf(doc.variables);
  const stampMemo = new Map<ResolvedNode, number>();
  const hashString = (s: string): number => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  };
  const mixNum = (h: number, v: number) => (Math.imul(h, 31) + v) | 0;
  const quant = (v: number) => Math.round((Number.isFinite(v) ? v : 0) * 256);

  /// Order-sensitive subtree stamp: node id + version + post-layout geometry,
  /// mixed with the kids' stamps recursively. Any descendant content or
  /// geometry change (including reorder — the mix is sequential) changes the
  /// value, invalidating every ancestor's cached emit.
  function stampOf(rn: ResolvedNode): number {
    const memo = stampMemo.get(rn);
    if (memo !== undefined) return memo;
    let h = 2166136261;
    h = mixNum(h, hashString(String((rn.node as { id?: unknown }).id ?? '')));
    const version = (rn.node as { version?: unknown }).version;
    h = mixNum(h, typeof version === 'number' ? version : 0);
    h = mixNum(h, quant(rn.width));
    h = mixNum(h, quant(rn.height));
    h = mixNum(h, quant(rn.absX));
    h = mixNum(h, quant(rn.absY));
    const kids = (rn as { _kids?: ResolvedNode[] })._kids;
    if (kids) for (const k of kids) h = mixNum(h, stampOf(k));
    stampMemo.set(rn, h);
    return h;
  }

  function emit(nodes: (ResolvedNode & { _kids?: ResolvedNode[] })[], parentId: string | null): ResolvedTreeNode[] {
    const treeNodes: ResolvedTreeNode[] = [];
    for (const rn of nodes) {
      // ---- R9c emit-cache lookup -------------------------------------------
      // Every input the emit reads is stamped (see the R9c module doc); on a
      // hit the whole subtree — flat Shape slice, tree node, and emit-time
      // warnings — is reused with ORIGINAL object identities, which is what
      // finally lets the DomNode React.memo hit on document changes.
      const ownZ = zIndex;
      const sub = stampOf(rn);
      const themeStamp = rn.themeStamp ?? '';
      const slots = emitCache.get(rn.node);
      let hit: EmitCacheEntry | undefined;
      if (slots) {
        for (const slot of slots) {
          if (
            slot.sub === sub &&
            slot.zIndex === ownZ &&
            slot.parentId === parentId &&
            slot.themeStamp === themeStamp &&
            slot.varsStamp === varsStamp
          ) {
            hit = slot;
            break;
          }
        }
      }
      if (hit) {
        resolveCacheStats.emitHits++;
        for (const w of hit.warnings) {
          const key = `${w.nodeId}::${w.kind}`;
          if (warnSeen.has(key)) continue;
          warnSeen.add(key);
          warnings.push(w);
          opts?.warnings?.push(w);
        }
        out.push(...hit.flat);
        treeNodes.push(hit.treeNode);
        zIndex = hit.zIndexEnd;
        continue;
      }
      resolveCacheStats.emitMisses++;
      const outStart = out.length;
      const warnStart = warnings.length;
      const n = rn.node;
      const vars = variables;
      const theme = rn.theme;
      const fills = (n as any).fill as PenFills | undefined;
      // Audit 4 C4: resolveEffects now returns ALL shadows + backgroundBlur
      // separately (the DOM renderer composes multi-shadow box-shadow lists
      // and backdrop-filter for background blur). `shadow`/`blur` keep their
      // single-value contracts for backward compat (first shadow / layer blur).
      const { shadow, blur, shadows, backgroundBlur } = resolveEffects(n, vars, theme);
      // Degradation: the resolved Layer carries ONE shadow + ONE blur; extra
      // enabled effects are silently dropped by resolveEffects. Surface it so
      // the agent stops stacking multiple shadows expecting them to render.
      // (Guarded on `effect` presence — this sits in the per-node hot path and
      // most nodes carry no effects at all.)
      if ((n as any).effect !== undefined && (n as any).effect !== null) {
        const rawEffects = (n as any).effect;
        const effArr: Array<Record<string, unknown>> = Array.isArray(rawEffects) ? rawEffects : [rawEffects];
        const enabled = effArr.filter((e) => e && (e as { enabled?: unknown }).enabled !== false);
        const shadowCount = enabled.filter((e) => e.type === 'shadow').length;
        const blurCount = enabled.filter((e) => e.type === 'blur').length;
        if (shadowCount > 3) {
          warn(n, 'effects_dropped', `${shadowCount} shadows on one node — the DOM renderer composes up to 3; extra ones drop`);
        }
        if (blurCount > 1) {
          warn(n, 'effects_dropped', `${blurCount} layer blurs on one node — only the first renders; merge them`);
        }
      }
      const stroke = resolveStroke(n, vars, theme);
      const cr = (n as any).cornerRadius;
      let radius = 0;
      let radii: CornerRadii | null = null;
      if (typeof cr === 'number') radius = cr;
      else if (Array.isArray(cr) && cr.length === 4) {
        radius = cr[0];
        radii = { topLeft: cr[0], topRight: cr[1], bottomRight: cr[2], bottomLeft: cr[3] };
      }

      const layout = normalizeLayoutDir((n as PenLayout).layout);
      let autoLayout: AutoLayout | null = null;
      if (layout && layout !== 'none') {
        autoLayout = {
          direction: layout as 'horizontal' | 'vertical',
          gap: num((n as PenLayout).gap, 0),
          padding: typeof (n as PenLayout).padding === 'number' ? (n as PenLayout).padding as number : 0,
          alignX: (n as PenLayout).justifyContent === 'end' ? 'max' : (n as PenLayout).justifyContent === 'center' ? 'center' : 'min',
          alignY: (n as PenLayout).alignItems === 'end' ? 'max' : (n as PenLayout).alignItems === 'center' ? 'center' : 'min',
        };
      }

      const shape: Shape = {
        id: n.id,
        type: mapNodeType(n),
        name: (n as any).name ?? n.id,
        x: rn.absX,
        y: rn.absY,
        width: rn.width,
        height: rn.height,
        rotation: num(n.rotation, 0),
        opacity: n.opacity !== undefined ? Math.max(0, Math.min(1, num(n.opacity, 1))) : 1,
        fill: resolveSolidColor(fills, vars, theme),
        stroke: stroke.color,
        strokeWidth: stroke.width,
        radius,
        radii,
        text: mapTextContent(n),
        fontSize: num((n as any).fontSize, 16),
        textColor: resolveSolidColor(fills, vars, theme),
        // Typography fields (from PenTextStyle on text/note/context/prompt
        // nodes). Previously dropped here, so the SVG renderer couldn't apply
        // weight / spacing / alignment even when the AI specified them via
        // pen_create_shape. Pass them through verbatim (with safe coercion)
        // so the DOM renderer's styleFor.ts can apply them.
        fontWeight: (n as any).fontWeight !== undefined ? num((n as any).fontWeight, 400) : undefined,
        fontFamily: (n as any).fontFamily !== undefined ? String((n as any).fontFamily) : undefined,
        letterSpacing: (n as any).letterSpacing !== undefined ? num((n as any).letterSpacing, 0) : undefined,
        lineHeight: (n as any).lineHeight !== undefined ? num((n as any).lineHeight, 1.4) : undefined,
        textAlign: (n as any).textAlign,
        textTransform: (n as any).textTransform,
        underline: (n as any).underline === true ? true : undefined,
        strikethrough: (n as any).strikethrough === true ? true : undefined,
        parentId,
        zIndex: zIndex++,
        locked: (n as any).locked ?? false,
        visible: (n as any).enabled !== false,
        autoLayout,
        tokenBinding: (n as any).tokenBinding ?? null,
        componentId: (n as any).componentId ?? null,
        // 2026-09-05 chart-line fix: path points are authored in the node's
        // PARENT coordinate space (pen_create_chart emits plot-local points;
        // subtree children are parent-relative by convention) while the
        // resolved Shape's x/y are ABSOLUTE. The DOM path island and the SVG
        // exporter both consume points in the absolute space (viewBox
        // `${layer.x} ${layer.y} w h` / root-space polylines), so rebase each
        // point by the node's (abs − authored) offset. Top-level paths have
        // offset 0 and are unchanged; the double-shift risk for
        // absolute-authored nested points is accepted because the subtree
        // convention (everything parent-relative) makes those rare.
        points: (n as any).points && Array.isArray((n as any).points) && (n as any).points.length > 0
          ? (n as any).points.map((p: { x?: unknown; y?: unknown }) => ({
              // num() coercion: LLM/test-authored points may carry string
              // numbers ("x": "10") — the geometry-string branch always
              // coerced these; keep that behavior here.
              x: num(p?.x, 0) + rn.absX - num((n as any).x, rn.absX),
              y: num(p?.y, 0) + rn.absY - num((n as any).y, rn.absY),
            }))
          : ((n as any).points ?? null),
        closed: (n as any).closed ?? false,
        src: (n as any).src ?? null,
        // Icon nodes (.pen PenIcon): library-qualified name, resolved to
        // geometry at render time from src/lib/icons (see docs/lucide-icons.md).
        iconName: n.type === 'icon' ? String((n as any).icon ?? '') || null : null,
        iconLibrary: n.type === 'icon' ? String((n as any).library ?? 'lucide') : null,
        gradient: resolveGradient(fills, vars, theme) ?? ((n as any).gradient ?? null),
        shadow,
        shadows,
        blur,
        backgroundBlur,
        maskId: (n as any).maskId ?? null,
        // Audit 4 C4/C6 fidelity fields: blend mode + flips flow to the DOM
        // renderer (mix-blend-mode / scaleX(-1) scaleY(-1)).
        blendMode: typeof (n as any).blendMode === 'string' ? (n as any).blendMode : null,
        flipX: (n as any).flipX === true ? true : undefined,
        flipY: (n as any).flipY === true ? true : undefined,
        // Effective theme (own + inherited) so the Properties panel can show
        // and edit it via set_node_theme patches.
        theme: rn.theme,
        // Figma-style layout constraints (passed through from the .pen node).
        constraints: (n as any).constraints ?? null,
        // Fix 3: clip — only set when explicitly true (undefined otherwise).
        clip: (n as any).clip === true ? true : undefined,
        // ---- Figma ontology extension fields (passed through from .pen node) ----
        componentPropertyDefinitions: (n as any).componentPropertyDefinitions ?? null,
        componentProperties: (n as any).componentProperties ?? null,
        variantPropertyAxes: (n as any).variantPropertyAxes ?? null,
        variantPropertyValues: (n as any).variantPropertyValues ?? null,
        label: (n as any).label ?? (n.type === 'section' ? ((n as any).name ?? null) : null),
        booleanOperationType: (n as any).booleanOperationType ?? null,
        pointCount: (n as any).pointCount ?? null,
        innerRadiusRatio: (n as any).innerRadius ?? null,
        polygonCount: (n as any).polygonCount ?? null,
        exportSettings: (n as any).exportSettings ?? null,
      };

      // Apply legacy token bindings: if the node has a tokenBinding, override
      // the resolved fill/stroke/textColor with the bound variable's value.
      // This preserves the "change a token → recolor every bound shape" behavior.
      const tb = (n as any).tokenBinding;
      if (tb && vars) {
        if (tb.fillToken) {
          const v = resolveValue(`$${tb.fillToken}`, vars, rn.theme);
          if (typeof v === 'string') shape.fill = v;
        }
        if (tb.strokeToken) {
          const v = resolveValue(`$${tb.strokeToken}`, vars, rn.theme);
          if (typeof v === 'string') shape.stroke = v;
        }
        if (tb.textToken) {
          const v = resolveValue(`$${tb.textToken}`, vars, rn.theme);
          if (typeof v === 'string') shape.textColor = v;
        }
      }

      // ---- Icon paint normalization (docs/lucide-icons.md) ----------------------
      // Lucide glyphs are STROKE-painted on a 24-unit grid. The .pen PenIcon
      // carries its paint in `fill` (per spec) — normalize so every renderer
      // can simply use layer.stroke / layer.strokeWidth:
      //   • explicit node.stroke + strokeWidth win (the agent's tool params)
      //   • else the icon's fill (PenIcon.paint) becomes the stroke color
      //   • width defaults to 2 (the lucide profile) when unspecified
      if (n.type === 'icon') {
        const nStroke = (n as any).stroke;
        const hasPaint = (n as any).fill !== undefined && (n as any).fill !== null;
        // Width: explicit strokeWidth wins, else the lucide profile (2).
        const iconStrokeWidth = stroke.width > 0 ? stroke.width : 2;
        if (nStroke) {
          // Explicit stroke color (the agent's `stroke` tool param): keep it.
          shape.stroke = stroke.color;
          shape.strokeWidth = iconStrokeWidth;
        } else if (hasPaint) {
          // PenIcon.paint lives in `fill` per the .pen spec — promote it.
          shape.stroke = shape.fill;
          shape.strokeWidth = iconStrokeWidth;
        } else {
          shape.stroke = '#0f172a';
          shape.strokeWidth = iconStrokeWidth;
        }
        if (shape.stroke === '#e2e8f0' && !hasPaint && !nStroke) {
          shape.stroke = '#0f172a'; // generic resolver default is a light gray — wrong for icons
        }
      }

      // Map .pen-specific fields onto Shape extensions.
      mapNodeExtras(shape, n, vars, theme, (kind, msg) => warn(n, kind, msg));

      // ---- Degradation checks (agent-visible warnings) -------------------------
      // 1. Leftover raw ref = cycle/depth guard survivor — rendered as a plain
      //    rectangle, losing its component identity.
      // 2. Unknown node type — mapNodeType's default quietly rendered it as
      //    a rectangle. (Set lookup: this is per-node hot path.)
      if (n.type === 'ref') {
        warn(n, 'ref_unexpanded', `ref survived expansion (cycle or depth > 16 guard) — rendered as a plain rectangle; break the reference cycle`);
      } else if (typeof n.type !== 'string' || !KNOWN_NODE_TYPES.has(n.type)) {
        warn(n, 'unknown_node_type', `unknown node type "${String((n as { type?: unknown }).type)}" — rendered as a rectangle`);
      }
      // 3. Unresolved $variable: resolveValue keeps the literal '$key' string,
      //    which then renders as a garbage color. (Checked AFTER tokenBinding
      //    overrides so a binding that fixes an unresolved fill isn't flagged.)
      if (typeof shape.fill === 'string' && shape.fill.startsWith('$')) {
        warn(n, 'unresolved_variable', `fill references undefined variable "${shape.fill}" — the literal string renders as an invalid color; define it via pen_set_variable or use a concrete hex`);
      } else if (typeof shape.stroke === 'string' && shape.stroke.startsWith('$') && stroke.width > 0) {
        warn(n, 'unresolved_variable', `stroke references undefined variable "${shape.stroke}" — the literal string renders as an invalid color`);
      }

      // ---- Figma ontology v3 mirrors (spec Phase 6 part 1 — dual-field) ----
      // Same source, two projections: the legacy fields above are UNCHANGED;
      // the v3 mirrors below let new consumers read canonical vocabulary
      // without a flag day (spec §9.3 #3).
      applyV3Mirrors(shape, n);

      out.push(shape);
      const kids =
        rn._kids && rn._kids.length > 0
          ? emit(rn._kids as (ResolvedNode & { _kids?: ResolvedNode[] })[], n.id)
          : [];
      const treeNode: ResolvedTreeNode = { layer: shape, pen: n, children: kids };
      treeNodes.push(treeNode);
      // ---- R9c emit-cache store ---------------------------------------------
      // The entry covers this whole subtree: flat slice + tree node + the
      // warnings emitted below `warnStart` (nested cache hits replay into
      // `warnings` mid-subtree, so the slice is complete either way).
      storeEmitEntry(rn, parentId, ownZ, sub, themeStamp, outStart, warnStart, treeNode);
    }
    return treeNodes;
  }

  /// Persist one subtree's emit result into the R9c cache.
  function storeEmitEntry(
    rn: ResolvedNode,
    parentId: string | null,
    ownZ: number,
    sub: number,
    themeStamp: string,
    outStart: number,
    warnStart: number,
    treeNode: ResolvedTreeNode,
  ): void {
    const entry: EmitCacheEntry = {
      sub,
      themeStamp,
      varsStamp,
      parentId,
      zIndex: ownZ,
      zIndexEnd: zIndex,
      flat: out.slice(outStart),
      treeNode,
      warnings: warnings.slice(warnStart),
    };
    let slots = emitCache.get(rn.node);
    if (!slots) {
      slots = [];
      emitCache.set(rn.node, slots);
    }
    // Replace the slot with the same stamp (re-emit settling back) or
    // FIFO-evict beyond the flavor budget.
    const staleIdx = slots.findIndex(
      (s) =>
        s.sub === entry.sub &&
        s.themeStamp === entry.themeStamp &&
        s.varsStamp === entry.varsStamp &&
        s.parentId === entry.parentId &&
        s.zIndex === entry.zIndex,
    );
    if (staleIdx >= 0) slots[staleIdx] = entry;
    else {
      slots.push(entry);
      if (slots.length > EMIT_CACHE_SLOTS) slots.shift();
    }
  }

  const tree = emit(resolved, null);

  // ---- WCAG contrast lint (depth-research 3-b #7/#9) -------------------------
  // Post-emit pass over the FLAT layer list — deliberately OUTSIDE emit so the
  // R9c subtree cache can never replay a stale contrast verdict (the verdict
  // depends on ancestor/sibling paints that the emit slot key does not cover).
  // Contrast is arithmetic here, not a VLM opinion: text a user must read
  // needs ≥4.5:1 (normal) / ≥3:1 (large ≥24px, or ≥19px bold) against its
  // effective backdrop (A11YN: rules need a checker; NN/g + WCAG 2.x floors).
  contrastLint(out, warn);

  return { layers: out, tree, warnings };
}

/// The light page surface every design sits on when no ancestor paints a
/// backdrop (--ac-canvas-bg, slate-50). Text directly on the page is checked
/// against this; dark-mode canvases carry their own root frames with fills, so
/// the assumption only ever applies to bare page-level text.
const PAGE_SURFACE: RgbaColor | null = parseCssColor('#f8fafc');

/** Effective-backdrop resolution for one layer, or null when unknown. */
function resolveBackdrop(
  shape: Shape,
  byId: Map<string, Shape>,
): { color: RgbaColor; source: 'ancestor' | 'sibling' | 'page' } | null {
  // Walk the ANCESTOR chain (nearest → farthest) compositing semi-transparent
  // paints; a gradient or image anywhere in the chain makes the backdrop
  // unknowable for everything below it (skip — the VLM critic owns visuals).
  const chain: Shape[] = [];
  let anc: Shape | undefined = shape.parentId ? byId.get(shape.parentId) : undefined;
  let guard = 0;
  while (anc && guard++ < 96) {
    if (anc.gradient || anc.src) return null;
    if (anc.opacity !== undefined && anc.opacity < 0.05) {
      // fully transparent ancestor — keep walking
    } else {
      chain.push(anc);
    }
    anc = anc.parentId ? byId.get(anc.parentId) : undefined;
  }
  if (chain.length > 0) {
    let acc = compositeOverShape(chain[chain.length - 1], PAGE_SURFACE);
    for (let i = chain.length - 2; i >= 0; i--) {
      acc = compositeOverShape(chain[i], acc);
    }
    if (acc) return { color: acc, source: 'ancestor' };
  }

  // Overlay pattern: text sitting ON a solid sibling painted earlier (classic
  // button = rectangle + label as siblings). Only a backdrop that fully
  // CONTAINS the text box counts; flow siblings (side-by-side) never do.
  let best: { color: RgbaColor; zIndex: number } | null = null;
  for (const other of byId.values()) {
    if (other === shape) continue;
    if (other.parentId !== shape.parentId) continue; // same stacking context
    if (other.zIndex >= shape.zIndex) continue; // painted later = on top
    if (other.type === 'text') continue; // text-on-text is mush, skip
    if (other.gradient || other.src) continue;
    if (other.opacity !== undefined && other.opacity < 0.9) continue;
    const c = parseCssColor(other.fill);
    if (!c || c.a < 0.9) continue; // solid backdrops only
    if (
      shape.x >= other.x - 4 &&
      shape.y >= other.y - 4 &&
      shape.x + shape.width <= other.x + other.width + 4 &&
      shape.y + shape.height <= other.y + other.height + 4
    ) {
      if (!best || other.zIndex > best.zIndex) best = { color: c, zIndex: other.zIndex };
    }
  }
  if (best) return { color: best.color, source: 'sibling' };

  return PAGE_SURFACE ? { color: PAGE_SURFACE, source: 'page' } : null;
}

function compositeOverShape(shape: Shape, base: RgbaColor | null): RgbaColor | null {
  const c = parseCssColor(shape.fill);
  if (!c) return null;
  if (base === null) return c.a >= 0.99 ? c : null;
  return compositeOver(c, base);
}

function contrastLint(shapes: Shape[], warn: (node: { id?: unknown; type?: unknown }, kind: ResolverWarningKind, message: string) => void): void {
  const byId = new Map<string, Shape>();
  for (const s of shapes) if (typeof s.id === 'string') byId.set(s.id, s);
  const textShapes = shapes.filter(
    (s) => s.type === 'text' && s.text && s.visible !== false && (s.opacity === undefined || s.opacity >= 0.99),
  );
  for (const s of textShapes) {
    const fg = parseCssColor(s.textColor);
    if (!fg || fg.a <= 0.1) continue;
    const backdrop = resolveBackdrop(s, byId);
    if (!backdrop) continue;
    const ratio = contrastRatio(fg, backdrop.color);
    const fontSize = num(s.fontSize, 16);
    const fontWeight = num(s.fontWeight, 400);
    const large = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
    const need = large ? 3 : 4.5;
    if (ratio + 0.005 < need) {
      const label = String(s.name ?? s.text ?? 'text').slice(0, 40);
      const fgHex = `#${[fg.r, fg.g, fg.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
      const bgHex = `#${[backdrop.color.r, backdrop.color.g, backdrop.color.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
      const tokenNote = s.tokenBinding?.textToken
        ? ` (this text is bound to $${s.tokenBinding.textToken} — change the variable's value or rebind the layer)`
        : '';
      warn(
        s,
        'contrast_failure',
        `"${label}" (${Math.round(fontSize)}px text) is ${fgHex} on a ${bgHex} backdrop — contrast ${ratio.toFixed(2)}:1, below the WCAG AA floor of ${need}:1${large ? ' for large text' : ''}. Darken the text (e.g. $color.text-muted #475569 on light surfaces) or lighten/darken the backdrop${tokenNote}. Fix it at the TOKEN level when the layer is bound`,
      );
    }
  }
}

// ---- Figma ontology v3 mirrors (spec Phase 6 part 1 — dual-field window) ---
//
// Populates the v3 projection on each emitted Shape from the SAME sources
// the legacy fields above use (or from already-normalized v3 fields when the
// node carries them — migrated .pen imports and normalized patch inserts do).
// Purely additive: legacy fields keep their exact pre-Phase-6 values.

function applyV3Mirrors(shape: Shape, node: PenChild): void {
  const n = node as any;
  const al = shape.autoLayout;

  // layoutMode: v3 field > autoLayout direction > legacy `layout`.
  if (n.layoutMode !== undefined) {
    shape.layoutMode = normalizeLayoutMode(n.layoutMode) as Shape['layoutMode'];
  } else if (al) {
    shape.layoutMode = al.direction === 'horizontal' ? 'HORIZONTAL' : 'VERTICAL';
  } else if (n.layout !== undefined) {
    shape.layoutMode = normalizeLayoutMode(n.layout) as Shape['layoutMode'];
  }

  // itemSpacing: v3 field > legacy gap (same source autoLayout.gap uses).
  if (n.itemSpacing !== undefined) {
    shape.itemSpacing = typeof n.itemSpacing === 'number' ? n.itemSpacing : num(n.itemSpacing, 0);
  } else if (al) {
    shape.itemSpacing = al.gap;
  } else if (n.gap !== undefined) {
    shape.itemSpacing = num(n.gap, 0);
  }

  // Per-side padding: v3 sides > legacy `padding` scalar/tuple expansion
  // (resolvePadding is the exact function the layout engine uses).
  const hasV3Pad =
    n.paddingLeft !== undefined || n.paddingRight !== undefined ||
    n.paddingTop !== undefined || n.paddingBottom !== undefined;
  if (hasV3Pad || n.padding !== undefined) {
    const pad = resolvePadding(n.padding);
    shape.paddingLeft = n.paddingLeft !== undefined ? num(n.paddingLeft, 0) : pad.left;
    shape.paddingRight = n.paddingRight !== undefined ? num(n.paddingRight, 0) : pad.right;
    shape.paddingTop = n.paddingTop !== undefined ? num(n.paddingTop, 0) : pad.top;
    shape.paddingBottom = n.paddingBottom !== undefined ? num(n.paddingBottom, 0) : pad.bottom;
  }

  // primaryAxisAlignItems: v3 field > justifyContent > alignX mapping.
  if (n.primaryAxisAlignItems !== undefined) {
    shape.primaryAxisAlignItems = normalizeAxisAlign(n.primaryAxisAlignItems) as Shape['primaryAxisAlignItems'];
  } else if (n.justifyContent !== undefined) {
    shape.primaryAxisAlignItems = normalizeAxisAlign(n.justifyContent) as Shape['primaryAxisAlignItems'];
  } else if (al) {
    shape.primaryAxisAlignItems = al.alignX === 'center' ? 'CENTER' : al.alignX === 'max' ? 'MAX' : 'MIN';
  }

  // counterAxisAlignItems: v3 field > alignItems > alignY mapping.
  if (n.counterAxisAlignItems !== undefined) {
    shape.counterAxisAlignItems = normalizeAxisAlign(n.counterAxisAlignItems) as Shape['counterAxisAlignItems'];
  } else if (n.alignItems !== undefined) {
    shape.counterAxisAlignItems = normalizeAxisAlign(n.alignItems) as Shape['counterAxisAlignItems'];
  } else if (al) {
    shape.counterAxisAlignItems = al.alignY === 'center' ? 'CENTER' : al.alignY === 'max' ? 'MAX' : 'MIN';
  }

  // layoutSizing*: v3 field > derived from the sizing strings/numbers.
  const sizingOf = (v: unknown, v3: unknown): Shape['layoutSizingHorizontal'] => {
    if (v3 !== undefined) return normalizeLayoutSizing(v3) as Shape['layoutSizingHorizontal'];
    if (typeof v === 'string') {
      if (v.startsWith('fit_content')) return 'HUG';
      if (v.startsWith('fill_container')) return 'FILL';
      return undefined;
    }
    if (typeof v === 'number') return 'FIXED';
    return undefined;
  };
  const sizingH = sizingOf(n.width, n.layoutSizingHorizontal);
  if (sizingH) shape.layoutSizingHorizontal = sizingH;
  const sizingV = sizingOf(n.height, n.layoutSizingVertical);
  if (sizingV) shape.layoutSizingVertical = sizingV;

  // layoutPositioning: v3 field > legacy layoutPosition.
  if (n.layoutPositioning !== undefined) {
    shape.layoutPositioning = normalizeLayoutPositioning(n.layoutPositioning) as Shape['layoutPositioning'];
  } else if (n.layoutPosition !== undefined) {
    shape.layoutPositioning = normalizeLayoutPositioning(n.layoutPosition) as Shape['layoutPositioning'];
  }

  // characters: the same content mapTextContent produced for `text`.
  if (shape.text !== undefined) {
    shape.characters = shape.text;
  }

  // textAutoResize: v3 field > legacy textGrowth.
  if (n.textAutoResize !== undefined) {
    shape.textAutoResize = normalizeTextAutoResize(n.textAutoResize) as Shape['textAutoResize'];
  } else if (n.textGrowth !== undefined) {
    shape.textAutoResize = normalizeTextAutoResize(n.textGrowth) as Shape['textAutoResize'];
  }

  // rectangleCornerRadii: v3 field > the radii object derived from the tuple.
  if (Array.isArray(n.rectangleCornerRadii) && n.rectangleCornerRadii.length === 4) {
    shape.rectangleCornerRadii = [
      num(n.rectangleCornerRadii[0], 0),
      num(n.rectangleCornerRadii[1], 0),
      num(n.rectangleCornerRadii[2], 0),
      num(n.rectangleCornerRadii[3], 0),
    ];
  } else if (shape.radii) {
    shape.rectangleCornerRadii = [
      shape.radii.topLeft,
      shape.radii.topRight,
      shape.radii.bottomRight,
      shape.radii.bottomLeft,
    ];
  }

  // fills: the single resolved paint array (SOLID from `fill`, or the typed
  // gradient entry carrying the resolved stops + angle-derived handles).
  if (shape.gradient) {
    const g = shape.gradient;
    const paint: FigmaPaint = {
      type: g.type === 'radial' ? 'GRADIENT_RADIAL' : 'GRADIENT_LINEAR',
      gradientStops: g.stops.map((s) => ({ position: s.offset, color: s.color })),
      gradientHandlePositions: gradientAngleToHandles(g.angle),
    };
    shape.fills = [paint];
  } else {
    shape.fills = [{ type: 'SOLID', color: shape.fill }];
  }

  // effects: the resolved shadow/blur as typed entries.
  const effects: FigmaEffect[] = [];
  if (shape.shadow) {
    const s = shape.shadow;
    effects.push({
      type: s.inset ? 'INNER_SHADOW' : 'DROP_SHADOW',
      offset: { x: s.x, y: s.y },
      radius: s.blur,
      spread: s.spread ?? 0,
      color: s.color,
    });
  }
  if (shape.blur && shape.blur > 0) {
    effects.push({ type: 'LAYER_BLUR', radius: shape.blur });
  }
  if (effects.length > 0) shape.effects = effects;
}

/** Map a .pen node type to our renderer's Layer type. */
function mapNodeType(node: PenChild): Layer['type'] {
  const t = (node as { type: string }).type;
  if (t === 'image' || t === 'line') return t as Layer['type'];
  switch (node.type) {
    case 'rectangle': return 'rectangle';
    case 'frame': return 'frame';
    case 'group': return 'group';
    case 'ellipse': return 'ellipse';
    case 'text':
    case 'note':
    case 'context':
    case 'prompt': return 'text';
    case 'path': return 'path';
    case 'icon': return 'icon';
    case 'polygon': return 'polygon';
    case 'star': return 'star';
    case 'line': return 'line';
    case 'script': return 'frame';
    case 'section': return 'section';
    case 'component': return 'component';
    case 'component_set': return 'component_set';
    case 'boolean_operation': return 'boolean_operation';
    case 'slice': return 'slice';
    case 'ref': return 'rectangle';
    default: return 'rectangle';
  }
}

function mapTextContent(node: PenChild): string | undefined {
  if (node.type === 'text' || node.type === 'note' || node.type === 'context' || node.type === 'prompt') {
    // .pen uses `content`; legacy shapes use `text`. Prefer content, fall back to text.
    const c = (node as any).content ?? (node as any).text;
    return c === undefined ? undefined : String(c);
  }
  if (node.type === 'icon') {
    // Icons are geometric library glyphs, not text — no text content to map.
    // (The name lives in `iconName` on the resolved Layer.)
    return undefined;
  }
  return undefined;
}

/** Map extra .pen-specific fields onto the Shape (points for paths, src for images). */
function mapNodeExtras(
  shape: Shape,
  node: PenChild,
  _vars: any,
  _theme: PenTheme,
  warn?: (kind: ResolverWarningKind, message: string) => void,
): void {
  if (node.type === 'path' && (node as any).geometry && !Array.isArray((node as any).points)) {
    // Best-effort: parse "M x y L x y ..." into points.
    const geometry = String((node as any).geometry);
    const pts = parsePathGeometry(geometry);
    if (pts.length > 0) {
      // 2026-09-05 chart-line fix: geometry coordinates are authored in the
      // node's PARENT space (same convention as points arrays — see the
      // points rebase in emit()); pathIsland and the SVG exporter consume
      // the ABSOLUTE space, so shift by the node's (abs − authored) offset.
      // Top-level paths have offset 0 and are unchanged.
      const dx = shape.x - num((node as any).x, shape.x);
      const dy = shape.y - num((node as any).y, shape.y);
      shape.points = dx === 0 && dy === 0
        ? pts
        : pts.map((p) => ({ x: p.x + dx, y: p.y + dy }));
      shape.closed = geometry.includes('Z');
    }
    // Curve/arc commands (C/Q/S/T/A, either case) are dropped by the
    // M/L-only parser — those segments render missing. Path data contains
    // no other letters, so this scan is unambiguous.
    if (/[cqsat]/i.test(geometry)) {
      warn?.('path_geometry_dropped', `path geometry contains curve/arc commands (C/Q/S/T/A) the resolver cannot parse — those segments render missing; use straight "M x y L x y" segments only`);
    }
  }
  // Image fills: extract the first image url into shape.src.
  const fills = (node as any).fill;
  if (fills) {
    const arr = Array.isArray(fills) ? fills : [fills];
    for (const f of arr) {
      if (typeof f === 'object' && f.type === 'image' && f.url) {
        shape.src = f.url;
        shape.type = 'image';
        break;
      }
    }
  }
}

/** Parse a simple "M x y L x y ..." SVG path into points. */
function parsePathGeometry(d: string): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  const re = /[ML]\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d)) !== null) {
    pts.push({ x: Number(m[1]) || 0, y: Number(m[2]) || 0 });
  }
  return pts;
}
