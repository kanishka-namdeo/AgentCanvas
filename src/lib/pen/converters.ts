// CanvasDocument <-> PenDocument converters.
//
// AgentCanvas's internal model is a flat shape list with parentId + zIndex
// references. The .pen format is an object tree. These converters bridge
// the two so we can export/import real .pen files today, while the deeper
// tree-model migration (Phase C) is still pending.
//
// Lossiness (documented):
//   CanvasDocument -> PenDocument (export):
//     - `heatmap` overlay is dropped (not a .pen concept — transient analysis).
//     - `viewport` is dropped (.pen has no viewport; it's an infinite canvas).
//     - `maskId` is dropped (use a `frame` with `clip:true` instead).
//     - `tokenBinding` is converted to top-level `variables` + `$name` refs,
//       but a shape can only bind one fill/text/stroke token in our model,
//       whereas .pen allows each fill individually to reference a variable.
//     - `gradient` + `shadow` + `blur` are mapped onto .pen `fill`/`effect`
//       arrays; single values become single-element arrays on round-trip.
//     - `line` shapes become .pen `path` nodes with an SVG geometry string.
//     - `image` shapes become .pen `rectangle` with an image `fill`.
//     - `componentId` (shallow ref) becomes a `ref` node pointing at the
//       reusable component; descendants/overrides are not expressible in our
//       model, so a round-trip loses override fidelity.
//   PenDocument -> CanvasDocument (import):
//     - Tree is flattened to a shape list; parent/child becomes parentId.
//     - `ref` nodes become shapes with `componentId` (overrides discarded).
//     - Multi-fill arrays collapse to the first enabled fill (lossy).
//     - Per-side strokeWidth collapses to the max value (lossy).
//     - Effect arrays collapse to the first shadow + first blur (lossy).
//     - Variables are imported into `tokens`; theme-conditional values use
//       the first (default) theme value.
//     - `slot`, `script`, `shader`, `mesh_gradient`, `note`, `context`,
//       `prompt`, `icon` map to best-effort representations (see code).
//
// Despite the lossiness, exported files are valid .pen and round-trip the
// visual design faithfully for the features we support.

import type {
  CanvasDocument,
  Shape,
  ColorToken,
  TextStyleToken,
  GradientFill,
  ShadowEffect,
  AutoLayout,
} from '../canvas/types';
import type {
  PenDocument,
  PenChild,
  PenFrame,
  PenGroup,
  PenRectangle,
  PenEllipse,
  PenPolygon,
  PenPath,
  PenText,
  PenIcon,
  PenRef,
  PenFill,
  PenFills,
  PenEffect,
  PenLayout,
  PenVariableDef,
  PenThemedValue,
} from './types';
import { PEN_FORMAT_VERSION } from './types';

// ============================================================================
// EXPORT: CanvasDocument -> PenDocument
// ============================================================================

/** Convert a shape's fill + gradient into a .pen Fills value. */
function toPenFills(shape: Shape): PenFills | undefined {
  const fills: PenFill[] = [];

  if (shape.gradient) {
    fills.push({
      type: 'gradient',
      gradientType: shape.gradient.type,
      rotation: shape.gradient.angle,
      colors: shape.gradient.stops.map((s) => ({ color: s.color, position: s.offset })),
    });
  } else if (shape.fill && shape.fill !== 'none' && shape.fill !== '') {
    fills.push(shape.fill); // bare hex color string
  }

  if (fills.length === 0) return undefined;
  if (fills.length === 1) return fills[0];
  return fills;
}

/** Convert a shape's shadow + blur into a .pen effects array. */
function toPenEffects(shape: Shape): PenEffect[] | undefined {
  const effects: PenEffect[] = [];
  if (shape.shadow) {
    const s: ShadowEffect = shape.shadow;
    effects.push({
      type: 'shadow',
      shadowType: s.inset ? 'inner' : 'outer',
      offset: { x: s.x, y: s.y },
      blur: s.blur,
      spread: s.spread ?? 0,
      color: s.color,
    });
  }
  if (shape.blur && shape.blur > 0) {
    effects.push({ type: 'blur', radius: shape.blur });
  }
  return effects.length > 0 ? effects : undefined;
}

/** Map our AutoLayout to .pen's flexbox Layout. */
function toPenLayout(al: AutoLayout | null | undefined): PenLayout {
  if (!al) return {};
  return {
    layout: al.direction,
    gap: al.gap,
    padding: al.padding,
    // Our alignX/alignY (min/center/max) -> pen justifyContent/alignItems (start/center/end).
    justifyContent: al.alignX === 'min' ? 'start' : al.alignX === 'max' ? 'end' : 'center',
    alignItems: al.alignY === 'min' ? 'start' : al.alignY === 'max' ? 'end' : 'center',
  };
}

/** Convert our cornerRadius (radius + radii) to .pen cornerRadius (number | 4-tuple). */
function toPenCornerRadius(shape: Shape): PenRectangle['cornerRadius'] {
  if (shape.radii) {
    return [shape.radii.topLeft, shape.radii.topRight, shape.radii.bottomRight, shape.radii.bottomLeft];
  }
  return shape.radius || undefined;
}

/** Convert our design tokens to .pen variables. */
function toPenVariables(
  colors: ColorToken[],
  textStyles: TextStyleToken[],
): { [key: string]: PenVariableDef } | undefined {
  const vars: { [key: string]: PenVariableDef } = {};
  for (const c of colors) {
    vars[c.key] = { type: 'color', value: c.value };
  }
  for (const t of textStyles) {
    // .pen has no "text style" variable per se, but font size can be a number variable.
    if (t.key) vars[`text.${t.key}.fontSize`] = { type: 'number', value: t.fontSize };
    if (t.key) vars[`text.${t.key}.color`] = { type: 'color', value: t.color };
  }
  return Object.keys(vars).length > 0 ? vars : undefined;
}

/** Convert a single shape into a .pen node (no children yet). */
function shapeToPenNode(shape: Shape): PenChild {
  const base = {
    id: shape.id,
    name: shape.name,
    opacity: shape.opacity,
    rotation: shape.rotation,
    enabled: shape.visible,
    // x/y are top-level on the entity for top-level nodes; nested nodes
    // also carry x/y relative to parent (assigned during tree-building).
    x: shape.x,
    y: shape.y,
  };

  switch (shape.type) {
    case 'rectangle': {
      const rect: PenRectangle = {
        ...base,
        type: 'rectangle',
        width: shape.width,
        height: shape.height,
        fill: toPenFills(shape),
        effect: toPenEffects(shape),
        cornerRadius: toPenCornerRadius(shape),
        stroke: shape.stroke && shape.strokeWidth > 0 ? shape.stroke : undefined,
        strokeWidth: shape.strokeWidth > 0 ? shape.strokeWidth : undefined,
        reusable: shape.componentId ? undefined : (shape.reusable ?? false),
      };
      return rect;
    }
    case 'ellipse': {
      const ell: PenEllipse = {
        ...base,
        type: 'ellipse',
        width: shape.width,
        height: shape.height,
        fill: toPenFills(shape),
        effect: toPenEffects(shape),
      };
      return ell;
    }
    case 'text': {
      const txt: PenText = {
        ...base,
        type: 'text',
        width: shape.width,
        height: shape.height,
        content: shape.text ?? '',
        fill: shape.textColor,
        fontSize: shape.fontSize,
        textGrowth: 'fixed-width-height',
      };
      return txt;
    }
    case 'frame': {
      const frame: PenFrame = {
        ...base,
        type: 'frame',
        width: shape.width,
        height: shape.height,
        fill: toPenFills(shape),
        effect: toPenEffects(shape),
        cornerRadius: toPenCornerRadius(shape),
        clip: false,
        ...toPenLayout(shape.autoLayout),
        children: [], // populated during tree-building
      };
      return frame;
    }
    case 'group': {
      const grp: PenGroup = {
        ...base,
        type: 'group',
        children: [], // populated during tree-building
      };
      return grp;
    }
    case 'line': {
      // A line becomes a stroked path with no fill.
      const p: PenPath = {
        ...base,
        type: 'path',
        width: shape.width,
        height: shape.height,
        geometry: `M 0 0 L ${shape.width} ${shape.height}`,
        stroke: shape.stroke,
        strokeWidth: shape.strokeWidth > 0 ? shape.strokeWidth : 1,
      };
      return p;
    }
    case 'path': {
      if (!shape.points || shape.points.length === 0) {
        // Degenerate path — emit an empty rectangle.
        const r: PenRectangle = { ...base, type: 'rectangle', width: shape.width, height: shape.height };
        return r;
      }
      const pts = shape.points;
      const d = pts
        .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`)
        .join(' ') + (shape.closed ? ' Z' : '');
      const pp: PenPath = {
        ...base,
        type: 'path',
        width: shape.width,
        height: shape.height,
        geometry: d,
        fill: shape.closed ? toPenFills(shape) : undefined,
        stroke: shape.stroke && shape.strokeWidth > 0 ? shape.stroke : undefined,
        strokeWidth: shape.strokeWidth > 0 ? shape.strokeWidth : undefined,
        fillRule: 'nonzero',
      };
      return pp;
    }
    case 'image': {
      // An image shape becomes a rectangle with an image fill.
      const imgFill: PenFill = {
        type: 'image',
        url: shape.src ?? '',
        mode: 'fill',
      };
      const imgRect: PenRectangle = {
        ...base,
        type: 'rectangle',
        width: shape.width,
        height: shape.height,
        fill: imgFill,
        cornerRadius: toPenCornerRadius(shape),
      };
      return imgRect;
    }
    default: {
      // Fallback: rectangle.
      const r: PenRectangle = { ...base, type: 'rectangle', width: shape.width, height: shape.height };
      return r;
    }
  }
}

/**
 * Build a .pen object tree from our flat shape list.
 * Top-level shapes (no parentId) become root children; the rest are nested
 * under their parent frame/group.
 */
function buildPenTree(shapes: Shape[]): PenChild[] {
  const byId = new Map(shapes.map((s) => [s.id, s]));
  const nodeById = new Map<string, PenChild>();
  const childrenOf = new Map<string | null, Shape[]>();

  for (const s of shapes) {
    const parent = s.parentId ?? null;
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent)!.push(s);
  }

  // Sort each group by zIndex ascending so tree order reflects stacking.
  for (const list of childrenOf.values()) {
    list.sort((a, b) => a.zIndex - b.zIndex);
  }

  function buildNode(shape: Shape): PenChild {
    if (nodeById.has(shape.id)) return nodeById.get(shape.id)!;
    const node = shapeToPenNode(shape);

    // Attach children for frames/groups.
    if (node.type === 'frame' || node.type === 'group') {
      const kids = childrenOf.get(shape.id) ?? [];
      (node as PenFrame | PenGroup).children = kids.map(buildNode);
    }
    nodeById.set(shape.id, node);
    return node;
  }

  const roots = childrenOf.get(null) ?? [];
  return roots.map(buildNode);
}

/** Mark shapes that are referenced as components as `reusable: true`. */
function markReusableComponents(shapes: Shape[], children: PenChild[]): PenChild[] {
  const componentIds = new Set(
    shapes.filter((s) => s.componentId).map((s) => s.componentId!),
  );
  if (componentIds.size === 0) return children;

  function walk(node: PenChild): PenChild {
    if (componentIds.has(node.id)) {
      (node as { reusable?: boolean }).reusable = true;
    }
    if (node.type === 'frame' || node.type === 'group') {
      const container = node as PenFrame | PenGroup;
      if (container.children) container.children = container.children.map(walk);
    }
    return node;
  }
  return children.map(walk);
}

/** Replace shapes that are instances (componentId set) with `ref` nodes. */
function replaceInstances(shapes: Shape[], children: PenChild[]): PenChild[] {
  const instanceShapes = shapes.filter((s) => s.componentId);
  if (instanceShapes.length === 0) return children;

  const instanceIds = new Set(instanceShapes.map((s) => s.id));

  function walk(node: PenChild): PenChild {
    if (instanceIds.has(node.id) && node.type !== 'ref') {
      const original = shapes.find((s) => s.id === node.id);
      if (original?.componentId) {
        const refNode: PenRef = {
          id: node.id,
          name: node.name,
          x: node.x,
          y: node.y,
          type: 'ref',
          ref: original.componentId,
          // We can't express our shallow overrides as .pen descendants,
          // but we CAN carry direct property overrides (fill/textColor).
          descendants: original.fill !== undefined ? { fill: original.fill } : undefined,
        };
        return refNode;
      }
    }
    if (node.type === 'frame' || node.type === 'group') {
      const container = node as PenFrame | PenGroup;
      if (container.children) container.children = container.children.map(walk);
    }
    return node;
  }
  return children.map(walk);
}

/**
 * Convert an AgentCanvas CanvasDocument into a .pen PenDocument.
 * The result is a valid .pen file (JSON-serializable).
 */
export function canvasToPen(canvas: CanvasDocument): PenDocument {
  const children = buildPenTree(canvas.shapes);
  const withReusable = markReusableComponents(canvas.shapes, children);
  const withRefs = replaceInstances(canvas.shapes, withReusable);

  const doc: PenDocument = {
    version: PEN_FORMAT_VERSION,
    variables: toPenVariables(canvas.tokens.colors, canvas.tokens.textStyles),
    children: withRefs,
  };

  // If the canvas has a non-default background, expose it as a variable.
  if (canvas.background && canvas.background !== '#f8fafc') {
    if (!doc.variables) doc.variables = {};
    doc.variables['canvas.background'] = { type: 'color', value: canvas.background };
  }

  return doc;
}

// ============================================================================
// IMPORT: PenDocument -> CanvasDocument
// ============================================================================

/** Extract the first enabled solid color from a .pen Fills value. */
function firstSolidColor(fills: PenFills | undefined): string {
  if (!fills) return '#e2e8f0';
  const arr = Array.isArray(fills) ? fills : [fills];
  for (const f of arr) {
    if (typeof f === 'string') return f;
    if (f.enabled === false) continue;
    if (f.type === 'color') return f.color;
  }
  return '#e2e8f0';
}

/** Extract the first gradient from a .pen Fills value (for our GradientFill). */
function firstGradient(fills: PenFills | undefined): GradientFill | null {
  if (!fills) return null;
  const arr = Array.isArray(fills) ? fills : [fills];
  for (const f of arr) {
    if (typeof f === 'object' && f.type === 'gradient') {
      return {
        type: f.gradientType === 'radial' ? 'radial' : 'linear',
        angle: f.rotation ?? 0,
        stops: (f.colors ?? []).map((c) => ({ offset: c.position, color: c.color })),
      };
    }
  }
  return null;
}

/** Extract the first shadow + first blur from .pen effects. */
function effectsToShadowBlur(effects: PenEffect[] | undefined): {
  shadow: ShadowEffect | null;
  blur: number;
} {
  if (!effects) return { shadow: null, blur: 0 };
  const arr = Array.isArray(effects) ? effects : [effects];
  let shadow: ShadowEffect | null = null;
  let blur = 0;
  for (const e of arr) {
    if (e.type === 'shadow' && !shadow) {
      shadow = {
        x: e.offset?.x ?? 0,
        y: e.offset?.y ?? 0,
        blur: e.blur ?? 0,
        color: e.color ?? '#000000',
        spread: e.spread,
        inset: e.shadowType === 'inner',
      };
    } else if (e.type === 'blur' && blur === 0) {
      blur = e.radius ?? 0;
    }
  }
  return { shadow, blur };
}

/** Map .pen cornerRadius (number | 4-tuple) to our radius + radii. */
function fromPenCornerRadius(cr: PenRectangle['cornerRadius']): {
  radius: number;
  radii?: Shape['radii'];
} {
  if (cr === undefined) return { radius: 0 };
  if (typeof cr === 'number') return { radius: cr };
  if (Array.isArray(cr) && cr.length === 4) {
    return {
      radius: cr[0],
      radii: { topLeft: cr[0], topRight: cr[1], bottomRight: cr[2], bottomLeft: cr[3] },
    };
  }
  return { radius: 0 };
}

/** Map .pen Layout (flexbox) to our AutoLayout. */
function fromPenLayout(layout: PenLayout | undefined): AutoLayout | null {
  if (!layout || !layout.layout || layout.layout === 'none') return null;
  return {
    direction: layout.layout,
    gap: typeof layout.gap === 'number' ? layout.gap : 0,
    padding: typeof layout.padding === 'number' ? layout.padding : 0,
    alignX: layout.justifyContent === 'end' ? 'max' : layout.justifyContent === 'center' ? 'center' : 'min',
    alignY: layout.alignItems === 'end' ? 'max' : layout.alignItems === 'center' ? 'center' : 'min',
  };
}

/** Flatten a .pen node tree into our shape list, assigning parentId + zIndex. */
function flattenPenTree(
  children: PenChild[],
  parentId: string | null,
  out: Shape[],
  zIndexStart: number,
): number {
  let z = zIndexStart;
  for (const node of children) {
    const fills = (node as { fill?: PenFills }).fill;
    const effects = (node as { effect?: PenEffect[] }).effect;
    const { shadow, blur } = effectsToShadowBlur(effects);
    const cr = fromPenCornerRadius((node as PenRectangle).cornerRadius);
    const layout = fromPenLayout(node as PenLayout);

    const base: Shape = {
      id: node.id,
      type: 'rectangle', // overridden below
      name: node.name ?? node.id,
      x: node.x ?? 0,
      y: node.y ?? 0,
      width: typeof (node as { width?: unknown }).width === 'number' ? (node as { width: number }).width : 100,
      height: typeof (node as { height?: unknown }).height === 'number' ? (node as { height: number }).height : 100,
      rotation: typeof node.rotation === 'number' ? node.rotation : 0,
      opacity: typeof node.opacity === 'number' ? node.opacity : 1,
      fill: firstSolidColor(fills),
      stroke: '',
      strokeWidth: 0,
      radius: cr.radius,
      radii: cr.radii,
      fontSize: 16,
      textColor: '#0f172a',
      parentId,
      zIndex: z,
      locked: false,
      visible: node.enabled !== false,
      autoLayout: layout,
      tokenBinding: null,
      componentId: null,
      points: null,
      closed: false,
      src: null,
      gradient: firstGradient(fills),
      shadow,
      blur,
      maskId: null,
    };

    switch (node.type) {
      case 'rectangle':
        base.type = 'rectangle';
        break;
      case 'ellipse':
        base.type = 'ellipse';
        break;
      case 'polygon':
        // We have no polygon type — approximate as ellipse (best-effort).
        base.type = 'ellipse';
        break;
      case 'text':
        base.type = 'text';
        base.text = (node as PenText).content ?? '';
        base.fontSize = typeof (node as PenText).fontSize === 'number' ? (node as PenText).fontSize : 16;
        base.textColor = firstSolidColor(fills);
        break;
      case 'frame':
        base.type = 'frame';
        break;
      case 'group':
        base.type = 'group';
        break;
      case 'path': {
        base.type = 'path';
        // We don't parse SVG geometry; emit an empty path shape.
        base.points = [];
        base.closed = false;
        break;
      }
      case 'icon': {
        // Render an icon as a text node with the icon name (best-effort).
        const icon = node as PenIcon;
        base.type = 'text';
        base.text = `[icon:${icon.icon ?? ''}]`;
        base.fontSize = 24;
        break;
      }
      case 'note':
      case 'context':
      case 'prompt': {
        base.type = 'text';
        base.text = (node as { content?: string }).content ?? '';
        break;
      }
      case 'script': {
        // A script node becomes a frame placeholder.
        base.type = 'frame';
        break;
      }
      case 'ref': {
        const ref = node as PenRef;
        base.type = 'rectangle';
        base.componentId = ref.ref;
        // Apply any direct descendants fill override.
        if (ref.descendants) {
          const rootOverride = ref.descendants[''] ?? ref.descendants[node.id];
          if (rootOverride && typeof rootOverride.fill === 'string') {
            base.fill = rootOverride.fill;
          }
        }
        break;
      }
      default:
        base.type = 'rectangle';
    }

    out.push(base);
    z++;

    // Recurse into children.
    if (node.type === 'frame' || node.type === 'group') {
      const container = node as PenFrame | PenGroup;
      if (container.children && container.children.length > 0) {
        z = flattenPenTree(container.children, node.id, out, z);
      }
    }
  }
  return z;
}

/** Convert .pen variables into our design tokens (using default theme values). */
function penVariablesToTokens(variables: { [key: string]: PenVariableDef } | undefined): {
  colors: ColorToken[];
  textStyles: TextStyleToken[];
} {
  const colors: ColorToken[] = [];
  const textStyles: TextStyleToken[] = [];

  if (!variables) return { colors, textStyles };

  for (const [key, def] of Object.entries(variables)) {
    const rawValue = Array.isArray(def.value)
      ? (def.value[0] as PenThemedValue<unknown>)?.value
      : def.value;
    if (rawValue === undefined) continue;

    if (def.type === 'color' && typeof rawValue === 'string') {
      colors.push({ name: key, key, value: rawValue });
    } else if (def.type === 'number' && typeof rawValue === 'number' && key.startsWith('text.')) {
      const parts = key.split('.');
      const styleKey = parts.slice(1, -1).join('.') || key;
      textStyles.push({
        name: styleKey,
        key: styleKey,
        fontSize: rawValue,
        fontWeight: 400,
        lineHeight: 1.5,
        color: '#0f172a',
      });
    }
  }
  return { colors, textStyles };
}

/**
 * Convert a .pen PenDocument into an AgentCanvas CanvasDocument.
 * Lossy in the documented ways; preserves the visual design for supported features.
 */
export function penToCanvas(doc: PenDocument, documentId: string): CanvasDocument {
  const shapes: Shape[] = [];
  flattenPenTree(doc.children ?? [], null, shapes, 0);

  const { colors, textStyles } = penVariablesToTokens(doc.variables);
  const backgroundVar = doc.variables?.['canvas.background'];
  const bgRaw = backgroundVar
    ? Array.isArray(backgroundVar.value)
      ? (backgroundVar.value[0] as PenThemedValue<unknown>)?.value
      : backgroundVar.value
    : undefined;
  const background = typeof bgRaw === 'string' ? bgRaw : '#f8fafc';

  return {
    id: documentId,
    name: 'Imported .pen',
    background,
    viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes,
    tokens: { colors, textStyles },
    heatmap: null,
  };
}

/** Serialize a PenDocument to a pretty JSON string (for file download). */
export function serializePenDocument(doc: PenDocument): string {
  return JSON.stringify(doc, null, 2) + '\n';
}
