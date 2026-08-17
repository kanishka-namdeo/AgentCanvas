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
  PenFrame,
  PenLayout,
  PenTheme,
  PenVariableDef,
  PenThemedValue,
  PenRef,
} from './types';
import type { Shape, CanvasDocument, AutoLayout, GradientFill, ShadowEffect, CornerRadii } from '../canvas/types';
import { collectComponents, expandRef, walkTree } from './document';

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

/** Resolve effects: first shadow + first blur. */
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
    } else if (e.type === 'blur' && blur === 0) {
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

/** Compute the intrinsic size of a node, given its (already-sized) children. */
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

  if (isFillContainer(w)) width = parentContentW;
  else if (isFitContent(w)) width = 0; // computed from children below
  else width = num(w, 100);

  if (isFillContainer(h)) height = parentContentH;
  else if (isFitContent(h)) height = 0;
  else height = num(h, 100);

  // fit_content: derive from children.
  const layout = (node as PenLayout).layout;
  const gap = num((node as PenLayout).gap, 0);
  const pad = resolvePadding((node as PenLayout).padding);

  if (isFitContent(w) || isFitContent(h)) {
    if (layout === 'horizontal') {
      const main = children.reduce((acc, c, i) => acc + c.width + (i > 0 ? gap : 0), 0);
      const cross = children.reduce((acc, c) => Math.max(acc, c.height), 0);
      if (isFitContent(w)) width = main + pad.left + pad.right;
      if (isFitContent(h)) height = cross + pad.top + pad.bottom;
    } else if (layout === 'vertical') {
      const main = children.reduce((acc, c, i) => acc + c.height + (i > 0 ? gap : 0), 0);
      const cross = children.reduce((acc, c) => Math.max(acc, c.width), 0);
      if (isFitContent(w)) width = cross + pad.left + pad.right;
      if (isFitContent(h)) height = main + pad.top + pad.bottom;
    } else {
      // No layout — fit to bounding box of absolutely-positioned children.
      if (children.length > 0) {
        const maxX = Math.max(...children.map((c) => c.absX + c.width));
        const maxY = Math.max(...children.map((c) => c.absY + c.height));
        const minX = Math.min(...children.map((c) => c.absX));
        const minY = Math.min(...children.map((c) => c.absY));
        if (isFitContent(w)) width = (maxX - minX) + pad.left + pad.right;
        if (isFitContent(h)) height = (maxY - minY) + pad.top + pad.bottom;
      }
    }
    // Fallback if no children.
    if (isFitContent(w) && width === 0) width = 100;
    if (isFitContent(h) && height === 0) height = 100;
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

/** Position children inside a parent's content box per flexbox rules. */
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

  if (layout === 'horizontal') {
    const totalChildMain = children.reduce((acc, c) => acc + c.width, 0);
    const totalGap = children.length > 1 ? gap * (children.length - 1) : 0;
    const used = totalChildMain + totalGap;
    let cursor = pad.left;
    let betweenGap = gap;
    if (justify === 'center') cursor = pad.left + (contentW - used) / 2;
    else if (justify === 'end') cursor = pad.left + (contentW - used);
    else if (justify === 'space_between' && children.length > 1) {
      betweenGap = (contentW - totalChildMain) / (children.length - 1);
      cursor = pad.left;
    } else if (justify === 'space_around' && children.length > 1) {
      betweenGap = (contentW - totalChildMain) / children.length;
      cursor = pad.left + betweenGap / 2;
    }
    for (let i = 0; i < children.length; i++) {
      const c = children[i];
      c.absX = parent.absX + cursor;
      let cross = pad.top;
      if (align === 'center') cross = pad.top + (contentH - c.height) / 2;
      else if (align === 'end') cross = pad.top + (contentH - c.height);
      c.absY = parent.absY + cross;
      cursor += c.width + (i < children.length - 1 ? betweenGap : 0);
    }
  } else if (layout === 'vertical') {
    const totalChildMain = children.reduce((acc, c) => acc + c.height, 0);
    const totalGap = children.length > 1 ? gap * (children.length - 1) : 0;
    const used = totalChildMain + totalGap;
    let cursor = pad.top;
    let betweenGap = gap;
    if (justify === 'center') cursor = pad.top + (contentH - used) / 2;
    else if (justify === 'end') cursor = pad.top + (contentH - used);
    else if (justify === 'space_between' && children.length > 1) {
      betweenGap = (contentH - totalChildMain) / (children.length - 1);
      cursor = pad.top;
    } else if (justify === 'space_around' && children.length > 1) {
      betweenGap = (contentH - totalChildMain) / children.length;
      cursor = pad.top + betweenGap / 2;
    }
    for (let i = 0; i < children.length; i++) {
      const c = children[i];
      c.absY = parent.absY + cursor;
      let cross = pad.left;
      if (align === 'center') cross = pad.left + (contentW - c.width) / 2;
      else if (align === 'end') cross = pad.left + (contentW - c.width);
      c.absX = parent.absX + cross;
      cursor += c.height + (i < children.length - 1 ? betweenGap : 0);
    }
  } else {
    // layout === 'none' or undefined: children keep their own x/y (relative to parent).
    for (const c of children) {
      c.absX = parent.absX + num(c.node.x, 0);
      c.absY = parent.absY + num(c.node.y, 0);
    }
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
      if ((child.type === 'frame' || child.type === 'group') && child.children) {
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

      if ((n.type === 'frame' || n.type === 'group' || n.type === 'boolean_op') && (n.children?.length ?? 0) > 0) {
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
    // by the parent's layout (done when processing the parent).
    if (!parent) {
      for (const rn of nodes) {
        rn.absX = num(rn.node.x, 0);
        rn.absY = num(rn.node.y, 0);
      }
    }

    // For each container, layout its children now that the container's own
    // size + position are known.
    for (const rn of nodes) {
      if (rn._kids && rn._kids.length > 0) {
        const layout = (rn.node as PenLayout).layout;
        if (layout && layout !== 'none') {
          layoutChildren(rn, rn._kids, layout);
        } else {
          // Absolute positioning: children use their x/y relative to parent.
          for (const k of rn._kids) {
            k.absX = rn.absX + num(k.node.x, 0);
            k.absY = rn.absY + num(k.node.y, 0);
          }
        }
      }
    }

    return nodes;
  }

  // Augment ResolvedNode with an optional _kids slot (TS hack via any).
  const resolved = resolve(expanded, null, {}) as (ResolvedNode & { _kids?: ResolvedNode[] })[];

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

/** Map a .pen node type to our renderer's Shape type. */
function mapNodeType(node: PenChild): Shape['type'] {
  // Legacy Shape types (image, line) are preserved as-is so they round-trip.
  const t = (node as { type: string }).type;
  if (t === 'image' || t === 'line') return t as Shape['type'];

  // v2.0: any node with reusable:true is a Component, regardless of base type.
  // (Figma's ComponentNode is always a Frame, but .pen allows reusable on any node.)
  if ((node as PenChild & { reusable?: boolean }).reusable) return 'component';

  switch (node.type) {
    case 'rectangle': return 'rectangle';
    case 'frame': {
      // Detect frame-like kinds via metadata flags.
      const meta = (node as PenFrame & { metadata?: Record<string, unknown> }).metadata;
      if (meta?.isComponentSet) return 'component_set';
      if (meta?.isSection) return 'section';
      if (meta?.isSlice) return 'slice';
      return 'frame';
    }
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
    case 'script': return 'frame'; // best-effort
    case 'ref': return 'instance';
    case 'boolean_op': return 'boolean_op';
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

/** Map extra .pen-specific fields onto the Shape (points for paths, src for images, v2.0 ontology fields). */
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

  // ---- v2.0 additions — propagate Figma-aligned ontology fields ----------------
  const n = node as PenChild & {
    blendMode?: string;
    cornerSmoothing?: number;
    strokeDashes?: number[];
    strokeMiterLimit?: number;
    strokeAlignment?: 'inner' | 'center' | 'outer';
    strokeLinejoin?: 'miter' | 'bevel' | 'round';
    strokeLinecap?: 'butt' | 'round' | 'square';
    layoutPosition?: 'auto' | 'absolute';
    metadata?: Record<string, unknown>;
  };

  // Blend mode + corner smoothing + stroke extras
  if (n.blendMode) shape.blendMode = n.blendMode;
  if (n.cornerSmoothing !== undefined) shape.cornerSmoothing = n.cornerSmoothing;
  if (n.strokeDashes) shape.strokeDashes = n.strokeDashes;
  if (n.strokeMiterLimit !== undefined) shape.strokeMiterLimit = n.strokeMiterLimit;
  if (n.strokeAlignment) shape.strokeAlignment = n.strokeAlignment;
  if (n.strokeLinejoin) shape.strokeLinejoin = n.strokeLinejoin;
  if (n.strokeLinecap) shape.strokeLinecap = n.strokeLinecap;

  // Per-side stroke weights
  const sw = (node as any).strokeWidth;
  if (typeof sw === 'object' && sw !== null && !Array.isArray(sw)) {
    shape.individualStrokeWeights = {
      top: num(sw.top, 0),
      right: num(sw.right, 0),
      bottom: num(sw.bottom, 0),
      left: num(sw.left, 0),
    };
  }

  // Layout position
  if (n.layoutPosition) shape.layoutPosition = n.layoutPosition;

  // Metadata-sourced fields
  const meta = n.metadata as Record<string, unknown> | undefined;
  if (meta) {
    if (meta.constraints) {
      shape.constraints = meta.constraints as { horizontal: string; vertical: string };
    }
    if (meta.gridLayout) {
      shape.gridLayout = meta.gridLayout as Shape['gridLayout'];
    }
    if (meta.overflow) {
      shape.overflow = meta.overflow as Shape['overflow'];
    }
    if (meta.isMask) {
      shape.isMask = true;
      shape.maskType = (meta.maskType as 'alpha' | 'vector' | 'luminance') ?? 'alpha';
    }
    if (meta.componentProperties) {
      shape.componentProperties = meta.componentProperties as Record<string, unknown>;
    }
    if (meta.variantProperties) {
      shape.variantProperties = meta.variantProperties as Record<string, string>;
    }
    if (meta.layoutGrids) {
      shape.layoutGrids = meta.layoutGrids as unknown[];
    }
    if (meta.isSection) shape.isSection = true;
    if (meta.isSlice) shape.isSlice = true;
  }

  // Type-specific fields
  switch (node.type) {
    case 'polygon': {
      const p = node as PenChild & { polygonCount?: number };
      if (p.polygonCount !== undefined) shape.polygonCount = typeof p.polygonCount === 'number' ? p.polygonCount : 6;
      break;
    }
    case 'star': {
      const s = node as PenChild & { pointCount?: number; innerRadius?: number };
      if (s.pointCount !== undefined) shape.pointCount = typeof s.pointCount === 'number' ? s.pointCount : 5;
      if (s.innerRadius !== undefined) shape.innerRadius = typeof s.innerRadius === 'number' ? s.innerRadius : 0.5;
      break;
    }
    case 'ellipse': {
      const e = node as PenChild & { innerRadius?: number; startAngle?: number; sweepAngle?: number };
      if (e.innerRadius !== undefined) shape.innerRingRadius = typeof e.innerRadius === 'number' ? e.innerRadius : 0;
      if (e.startAngle !== undefined) shape.startAngle = typeof e.startAngle === 'number' ? e.startAngle : 0;
      if (e.sweepAngle !== undefined) shape.sweepAngle = typeof e.sweepAngle === 'number' ? e.sweepAngle : 360;
      break;
    }
    case 'icon': {
      const ic = node as PenChild & { library?: string; icon?: string; weight?: number };
      shape.iconLibrary = typeof ic.library === 'string' ? ic.library : 'lucide';
      shape.iconName = typeof ic.icon === 'string' ? ic.icon : '';
      if (ic.weight !== undefined && typeof ic.weight === 'number') shape.iconWeight = ic.weight;
      break;
    }
    case 'boolean_op': {
      const b = node as PenChild & { operation?: string };
      if (b.operation) shape.booleanOperation = b.operation as 'union' | 'intersect' | 'subtract' | 'exclude';
      break;
    }
    case 'ref': {
      const r = node as PenChild & { ref?: string; variantValues?: Record<string, string> };
      if (r.ref) shape.componentId = r.ref;
      if (r.variantValues) shape.variantValues = r.variantValues;
      break;
    }
    case 'frame': {
      const f = node as PenChild & { clip?: boolean };
      if (f.clip !== undefined) shape.clip = !!f.clip;
      break;
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
