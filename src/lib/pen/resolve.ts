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
} from './types';
import type { Shape, Layer, CanvasDocument, AutoLayout, GradientFill, ShadowEffect, CornerRadii } from '../canvas/types';
import { collectComponents, expandRef, walkTree } from './document';

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
 *  string if it's not a $-reference. */
function resolveValue<T extends string | number | boolean>(
  raw: T,
  variables: { [key: string]: PenVariableDef } | undefined,
  theme: PenTheme,
): T {
  if (typeof raw !== 'string') return raw;
  if (!raw.startsWith('$')) return raw;
  const key = raw.slice(1);
  const def = variables?.[key];
  if (!def) return raw; // unknown variable — leave as-is
  const themed = resolveThemedValue(def, theme);
  return themed as T;
}

/** Pick the winning value from a variable def given the effective theme. */
function resolveThemedValue(def: PenVariableDef, theme: PenTheme): string | number | boolean {
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
function resolveEffects(node: any, variables: any, theme: PenTheme): { shadow: ShadowEffect | null; blur: number } {
  const effects = node.effect;
  if (!effects) return { shadow: null, blur: 0 };
  const arr = Array.isArray(effects) ? effects : [effects];
  let shadow: ShadowEffect | null = null;
  let blur = 0;
  for (const e of arr) {
    if (e.enabled === false) continue;
    if (e.type === 'shadow' && !shadow) {
      shadow = {
        x: typeof e.offset?.x === 'number' ? e.offset.x : 0,
        y: typeof e.offset?.y === 'number' ? e.offset.y : 0,
        blur: typeof e.blur === 'number' ? e.blur : 0,
        color: resolveValue(e.color ?? '#000000', variables, theme),
        spread: typeof e.spread === 'number' ? e.spread : 0,
        inset: e.shadowType === 'inner',
      };
    } else if ((e.type === 'blur' || e.type === 'background_blur') && blur === 0) {
      // Per the .pen spec, both 'blur' (layer blur) and 'background_blur'
      // (background-only blur) carry a `radius` field. We collapse both into
      // the single `blur` number on the resolved Layer; the renderer applies
      // it via feGaussianBlur. (Surfacing them as distinct fields on the
      // Layer type is a future enhancement — for now, blurring is the same
      // visual effect either way.)
      blur = typeof e.radius === 'number' ? e.radius : 0;
    }
  }
  return { shadow, blur };
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

/** Compute the intrinsic size of a node, given its (already-sized) children.
 *  Uses a two-phase approach for fill_container children: first sizes
 *  non-fill children to determine the parent's fit_content size, then
 *  resolves fill_container children against the now-known parent size. */
function computeIntrinsicSize(
  node: PenChild,
  children: ResolvedNode[],
  parentContentW: number,
  parentContentH: number,
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

  if (isFillContainer(w)) width = parentContentW;
  else if (isFitContent(w) || implicitFitW) width = 0; // computed from children below
  else width = num(w, 100);

  if (isFillContainer(h)) height = parentContentH;
  else if (isFitContent(h) || implicitFitH) height = 0;
  else height = num(h, 100);

  // fit_content: derive from children.
  const layout = (node as PenLayout).layout;
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
    if ((isFitContent(w) || implicitFitW) && width === 0) {
      width = (node.type === 'group' || node.type === 'section') ? 0 : 100;
    }
    if ((isFitContent(h) || implicitFitH) && height === 0) {
      height = (node.type === 'group' || node.type === 'section') ? 0 : 100;
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
  switch (mode) {
    case 'right': return contentW - childW - storedX;
    case 'center': return (contentW - childW) / 2;
    case 'scale': return storedX * contentW;
    case 'left_right': return 0; // width override handled separately
    case 'left':
    default: return storedX;
  }
}

function applyConstraintV(mode: string, storedY: number, childH: number, contentH: number): number {
  switch (mode) {
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
 */
export function resolvePenTree(doc: CanvasDocument): Shape[] {
  const variables = doc.variables;
  const components = collectComponents(doc.children);
  const out: Shape[] = [];
  let zIndex = 0;

  // First, expand all refs into a working tree (refs become their resolved
  // subtrees). We do this recursively.
  function expandTree(children: PenChild[], inheritedTheme: PenTheme): PenChild[] {
    return (children ?? []).flatMap((child) => {
      if (child.type === 'ref') {
        const expanded = expandRef(child as PenRef, components);
        return expanded ? [expanded] : [];
      }
      if (isContainerNode(child) && child.children) {
        return [{ ...child, children: expandTree(child.children, inheritedTheme) }];
      }
      return [child];
    });
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
    }));

    // For leaf nodes (no children), compute size now.
    // For container nodes, resolve children first (bottom-up sizing), then
    // compute own size, then position children.
    for (const rn of nodes) {
      const n = rn.node;
      const parentContentW = parent ? parent.width - resolvePadding((parent.node as PenLayout).padding).left - resolvePadding((parent.node as PenLayout).padding).right : 0;
      const parentContentH = parent ? parent.height - resolvePadding((parent.node as PenLayout).padding).top - resolvePadding((parent.node as PenLayout).padding).bottom : 0;

      if (isContainerNode(n) && (n.children?.length ?? 0) > 0) {
        const kids = resolve(n.children!, rn, rn.theme);
        const { width, height } = computeIntrinsicSize(n, kids, parentContentW, parentContentH);
        rn.width = width;
        rn.height = height;
        rn._kids = kids;
      } else {
        const { width, height } = computeIntrinsicSize(n, [], parentContentW, parentContentH);
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
        const layout = (rn.node as PenLayout).layout;
        // Both flex and absolute-positioning paths go through layoutChildren
        // (which handles constraints in the 'none' branch).
        layoutChildren(rn, kids, layout ?? 'none');
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

  // Flatten depth-first, emitting Shape for each node.
  function emit(nodes: (ResolvedNode & { _kids?: ResolvedNode[] })[], parentId: string | null) {
    for (const rn of nodes) {
      const n = rn.node;
      const vars = variables;
      const theme = rn.theme;
      const fills = (n as any).fill as PenFills | undefined;
      const { shadow, blur } = resolveEffects(n, vars, theme);
      const stroke = resolveStroke(n, vars, theme);
      const cr = (n as any).cornerRadius;
      let radius = 0;
      let radii: CornerRadii | null = null;
      if (typeof cr === 'number') radius = cr;
      else if (Array.isArray(cr) && cr.length === 4) {
        radius = cr[0];
        radii = { topLeft: cr[0], topRight: cr[1], bottomRight: cr[2], bottomLeft: cr[3] };
      }

      const layout = (n as PenLayout).layout;
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
        // so ShapeRenderer can apply them.
        fontWeight: (n as any).fontWeight !== undefined ? num((n as any).fontWeight, 400) : undefined,
        fontFamily: (n as any).fontFamily !== undefined ? String((n as any).fontFamily) : undefined,
        letterSpacing: (n as any).letterSpacing !== undefined ? num((n as any).letterSpacing, 0) : undefined,
        lineHeight: (n as any).lineHeight !== undefined ? num((n as any).lineHeight, 1.4) : undefined,
        textAlign: (n as any).textAlign,
        underline: (n as any).underline === true ? true : undefined,
        strikethrough: (n as any).strikethrough === true ? true : undefined,
        parentId,
        zIndex: zIndex++,
        locked: (n as any).locked ?? false,
        visible: (n as any).enabled !== false,
        autoLayout,
        tokenBinding: (n as any).tokenBinding ?? null,
        componentId: (n as any).componentId ?? null,
        points: (n as any).points ?? null,
        closed: (n as any).closed ?? false,
        src: (n as any).src ?? null,
        gradient: resolveGradient(fills, vars, theme) ?? ((n as any).gradient ?? null),
        shadow,
        blur,
        maskId: (n as any).maskId ?? null,
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

      // Map .pen-specific fields onto Shape extensions.
      mapNodeExtras(shape, n, vars, theme);

      out.push(shape);
      if (rn._kids && rn._kids.length > 0) {
        emit(rn._kids as (ResolvedNode & { _kids?: ResolvedNode[] })[], n.id);
      }
    }
  }

  emit(resolved, null);
  return out;
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
    case 'icon': return 'text';
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
    return `[icon:${(node as any).icon ?? ''}]`;
  }
  return undefined;
}

/** Map extra .pen-specific fields onto the Shape (points for paths, src for images). */
function mapNodeExtras(
  shape: Shape,
  node: PenChild,
  _vars: any,
  _theme: PenTheme,
): void {
  if (node.type === 'path' && (node as any).geometry) {
    // Best-effort: parse "M x y L x y ..." into points.
    const pts = parsePathGeometry((node as any).geometry);
    if (pts.length > 0) {
      shape.points = pts;
      shape.closed = (node as any).geometry.includes('Z');
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
