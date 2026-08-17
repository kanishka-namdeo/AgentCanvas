// CanvasDocument <-> PenDocument converters.
//
// After the Phase C tree-model migration, CanvasDocument IS essentially a
// PenDocument (it extends PenDocument + adds runtime/derived fields). So
// conversion is now near-identity:
//
//   - canvasToPen: strip the runtime (id, name, viewport) and derived
//     (shapes, tokens, background) caches. Keep version, themes, imports,
//     variables, children — the canonical .pen fields.
//   - penToCanvas: wrap a .pen doc with runtime + derived caches (the
//     derived caches are recomputed lazily by the store / resolvePenTree).
//
// This module is kept for the /api/pen/export and /api/pen/import routes
// and for the pen_export_pen agent tool.

import type { CanvasDocument } from '../canvas/types';
import type { Shape } from '../canvas/types';
import type {
  PenDocument,
  PenChild,
  PenFrame,
  PenRectangle,
  PenEllipse,
  PenPolygon,
  PenStar,
  PenPath,
  PenText,
  PenRef,
  PenBooleanOp,
  PenGroup,
  PenNote,
  PenIcon,
  PenFill,
  PenBlendMode,
  PenTheme,
  PenVariableDef,
  PenComment,
} from './types';
import { PEN_FORMAT_VERSION } from './types';

// ============================================================================
// CanvasDocument <-> PenDocument
// ============================================================================

/**
 * Convert an AgentCanvas CanvasDocument into a .pen PenDocument.
 * Strips runtime + derived caches; keeps the canonical .pen tree.
 */
export function canvasToPen(canvas: CanvasDocument): PenDocument {
  const doc: PenDocument = {
    version: canvas.version,
    themes: canvas.themes,
    imports: (canvas as any).imports,
    variables: canvas.variables,
    children: canvas.children,
  };
  // Round-trip comments if the canvas carries them (runtime field).
  const comments = (canvas as CanvasDocument & { comments?: PenComment[] }).comments;
  if (comments && comments.length > 0) doc.comments = comments;
  return doc;
}

/**
 * Convert a .pen PenDocument into an AgentCanvas CanvasDocument.
 * The derived caches (shapes, tokens, background) are left empty here —
 * they are recomputed by resolvePenTree() + variablesToTokens() when the
 * store applies the document. We set sensible runtime defaults.
 */
export function penToCanvas(doc: PenDocument, documentId: string): CanvasDocument {
  const canvas = {
    id: documentId,
    name: 'Imported .pen',
    version: doc.version,
    themes: doc.themes,
    variables: doc.variables,
    children: doc.children ?? [],
    comments: doc.comments,
    viewport: { zoom: 1, panX: 120, panY: 80 },
    background: '#f8fafc',
    shapes: [], // recomputed by the store via resolvePenTree
    tokens: { colors: [], textStyles: [] }, // recomputed by variablesToTokens
  } as CanvasDocument;
  return canvas;
}

/** Serialize a PenDocument to a pretty JSON string (for file download). */
export function serializePenDocument(doc: PenDocument): string {
  return JSON.stringify(doc, null, 2) + '\n';
}

// ============================================================================
// SVG export
// ============================================================================

/**
 * Convert a list of resolved Shapes into an SVG string.
 * Used by the pen_export_svg tool and the /api/pen/export?format=svg route.
 *
 * The renderer is intentionally minimal — it covers the common shape
 * types and skips unsupported metadata (gradients on boolean ops, etc.).
 * For high-fidelity SVG, use the in-browser renderer (Canvas.tsx).
 */
export function shapesToSVG(shapes: Shape[], opts: { width?: number; height?: number; background?: string } = {}): string {
  if (shapes.length === 0) return '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';
  const minX = Math.min(...shapes.map((s) => s.x)) || 0;
  const minY = Math.min(...shapes.map((s) => s.y)) || 0;
  const maxX = Math.max(...shapes.map((s) => s.x + s.width)) || 1;
  const maxY = Math.max(...shapes.map((s) => s.y + s.height)) || 1;
  const w = opts.width ?? (Math.ceil(maxX - minX) || 1);
  const h = opts.height ?? (Math.ceil(maxY - minY) || 1);
  const bg = opts.background ?? '#ffffff';

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${minX} ${minY} ${maxX - minX} ${maxY - minY}">`);
  parts.push(`  <rect x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" fill="${bg}"/>`);

  const sorted = [...shapes].sort((a, b) => a.zIndex - b.zIndex);
  for (const s of sorted) {
    if (!s.visible) continue;
    const el = shapeToSVGElement(s);
    if (el) parts.push(el);
  }

  parts.push('</svg>');
  return parts.join('\n');
}

function shapeToSVGElement(s: Shape): string | null {
  const transform = s.rotation
    ? ` transform="rotate(${s.rotation} ${s.x + s.width / 2} ${s.y + s.height / 2})"`
    : '';
  const opacity = s.opacity !== 1 ? ` opacity="${s.opacity}"` : '';
  const fill = s.fill || 'none';
  const stroke = s.strokeWidth > 0 ? ` stroke="${s.stroke}" stroke-width="${s.strokeWidth}"` : '';
  const strokeAlign = s.strokeAlignment === 'inner' ? ' stroke-alignment="inner"' :
                     s.strokeAlignment === 'outer' ? ' stroke-alignment="outer"' : '';
  const strokeLinecap = s.strokeLinecap && s.strokeLinecap !== 'butt' ? ` stroke-linecap="${s.strokeLinecap}"` : '';
  const strokeLinejoin = s.strokeLinejoin && s.strokeLinejoin !== 'miter' ? ` stroke-linejoin="${s.strokeLinejoin}"` : '';
  const strokeDashes = s.strokeDashes?.length ? ` stroke-dasharray="${s.strokeDashes.join(',')}"` : '';
  const blendMode = s.blendMode && s.blendMode !== 'normal' ? ` mix-blend-mode="${figmaBlendToCSS(s.blendMode)}"` : '';
  const commonAttrs = `${transform}${opacity}${stroke}${strokeAlign}${strokeLinecap}${strokeLinejoin}${strokeDashes}${blendMode}`;

  switch (s.type) {
    case 'rectangle':
    case 'frame':
    case 'component':
    case 'component_set':
    case 'instance':
    case 'section':
    case 'slice':
    case 'note':
    case 'image': {
      const r = s.radii
        ? s.radii.topLeft
        : s.radius;
      const radiusAttr = r ? ` rx="${r}" ry="${r}"` : '';
      return `  <rect x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" fill="${fill}"${radiusAttr}${commonAttrs}/>`;
    }
    case 'ellipse': {
      const cx = s.x + s.width / 2;
      const cy = s.y + s.height / 2;
      const rx = s.width / 2;
      const ry = s.height / 2;
      return `  <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${fill}"${commonAttrs}/>`;
    }
    case 'polygon': {
      const pts = polygonPoints(s.x, s.y, s.width, s.height, s.polygonCount ?? 6);
      return `  <polygon points="${pts.map((p) => `${p.x},${p.y}`).join(' ')}" fill="${fill}"${commonAttrs}/>`;
    }
    case 'star': {
      const pts = starPoints(s.x, s.y, s.width, s.height, s.pointCount ?? 5, s.innerRadius ?? 0.5);
      return `  <polygon points="${pts.map((p) => `${p.x},${p.y}`).join(' ')}" fill="${fill}"${commonAttrs}/>`;
    }
    case 'line': {
      return `  <line x1="${s.x}" y1="${s.y}" x2="${s.x + s.width}" y2="${s.y + s.height}" stroke="${s.stroke || '#000'}" stroke-width="${s.strokeWidth || 1}"${strokeLinecap}${opacity}/>`;
    }
    case 'path': {
      const geom = (s as Shape & { geometry?: string }).geometry ?? '';
      const fillRule = (s as Shape & { fillRule?: string }).fillRule === 'evenodd' ? ' fill-rule="evenodd"' : '';
      return `  <path d="${geom}" fill="${fill}"${fillRule}${commonAttrs}/>`;
    }
    case 'text': {
      const fontSize = s.fontSize || 16;
      const textAlignHorizontal = ((s as Shape & { textAlignHorizontal?: string }).textAlignHorizontal) ??
        ((s as Shape & { textAlign?: string }).textAlign ?? 'left');
      const textAnchor = textAlignHorizontal === 'center' ? 'middle' :
                        textAlignHorizontal === 'right' ? 'end' : 'start';
      const anchorX = textAlignHorizontal === 'center' ? s.x + s.width / 2 :
                     textAlignHorizontal === 'right' ? s.x + s.width : s.x;
      const textContent = escapeXML(s.text ?? '');
      const fontWeight = ((s as Shape & { fontWeight?: number | string }).fontWeight)
        ? ` font-weight="${(s as Shape & { fontWeight?: number | string }).fontWeight}"`
        : '';
      const fontFamily = ((s as Shape & { fontFamily?: string }).fontFamily)
        ? ` font-family="${escapeXML((s as Shape & { fontFamily?: string }).fontFamily ?? '')}"`
        : '';
      return `  <text x="${anchorX}" y="${s.y + fontSize}" fill="${s.textColor || s.fill || '#000'}" font-size="${fontSize}"${fontWeight}${fontFamily} text-anchor="${textAnchor}"${opacity}>${textContent}</text>`;
    }
    case 'group':
    case 'boolean_op':
      // groups are containers — children are rendered separately
      return null;
    case 'icon':
      // icons need library-specific rendering; emit a placeholder rect
      return `  <rect x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" fill="${fill}"${commonAttrs} data-icon="${escapeXML(s.iconName ?? '')}" data-library="${escapeXML(s.iconLibrary ?? '')}"/>`;
    default:
      return null;
  }
}

function polygonPoints(x: number, y: number, w: number, h: number, sides: number): Array<{ x: number; y: number }> {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rx = w / 2;
  const ry = h / 2;
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < sides; i++) {
    const angle = (Math.PI * 2 * i) / sides - Math.PI / 2;
    pts.push({ x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) });
  }
  return pts;
}

function starPoints(x: number, y: number, w: number, h: number, points: number, innerRatio: number): Array<{ x: number; y: number }> {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rx = w / 2;
  const ry = h / 2;
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < points * 2; i++) {
    const angle = (Math.PI * i) / points - Math.PI / 2;
    const r = i % 2 === 0 ? 1 : innerRatio;
    pts.push({ x: cx + rx * r * Math.cos(angle), y: cy + ry * r * Math.sin(angle) });
  }
  return pts;
}

function escapeXML(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
  } as Record<string, string>)[c]);
}

function figmaBlendToCSS(blend: string): string {
  const map: Record<string, string> = {
    normal: 'normal', darken: 'darken', multiply: 'multiply',
    linearBurn: 'color-burn', colorBurn: 'color-burn',
    lighten: 'lighten', screen: 'screen',
    linearDodge: 'color-dodge', colorDodge: 'color-dodge',
    overlay: 'overlay', softLight: 'soft-light', hardLight: 'hard-light',
    difference: 'difference', exclusion: 'exclusion',
    hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity',
  };
  return map[blend] ?? 'normal';
}

// ============================================================================
// Figma-compatible JSON export
// ============================================================================

/**
 * Convert a .pen PenDocument into a Figma-compatible JSON tree.
 *
 * The output mimics the shape of Figma's REST API `GET /v1/files/:key`
 * response: a `document` with `children` pages, each Page a `CanvasNode`
 * with `children: Node[]`. We map every .pen node to its Figma
 * equivalent using the mapping in docs/figma-ontology.md.
 *
 * This is NOT a substitute for a real Figma import — Figma's binary
 * `.fig` format is closed. But this JSON is structurally compatible
 * with Figma's REST API shape, so tools that consume Figma JSON
 * (e.g. figma-to-code generators) will accept it.
 */
export function penToFigmaJSON(doc: PenDocument): Record<string, unknown> {
  const page = {
    id: '0:1',
    name: 'Page 1',
    type: 'CANVAS',
    children: doc.children.map((child, i) => penNodeToFigmaNode(child, `1:${i}`)),
  };
  return {
    name: 'Imported from .pen',
    lastModified: new Date().toISOString(),
    editorType: 'dev',
    schemaVersion: 0,
    version: doc.version,
    document: {
      id: '0:0',
      name: 'Document',
      type: 'DOCUMENT',
      children: [page],
    },
    components: collectComponents(doc),
    componentSets: collectComponentSets(doc),
    styles: collectStyles(doc),
    variables: collectVariables(doc),
    variableCollections: collectVariableCollections(doc),
    // v2.1: comments
    comments: (doc.comments ?? []).map(penCommentToFigma),
  };
}

/** Convert a .pen comment to Figma's comment shape. */
function penCommentToFigma(c: PenComment): Record<string, unknown> {
  return {
    id: c.id,
    message: c.body,
    created_at: c.createdAt,
    resolved: c.resolved ?? false,
    user: { handle: c.author },
    client_meta: c.anchor?.x !== undefined && c.anchor?.y !== undefined
      ? { node_id: c.anchor.nodeId ?? '0:1', node_offset: { x: c.anchor.x, y: c.anchor.y } }
      : c.anchor?.nodeId
        ? { node_id: c.anchor.nodeId }
        : undefined,
    reactions: (c.reactions ?? []).map((r) => ({ emoji: r.emoji, user: { handle: r.user } })),
    comment_id: c.id,
  };
}

/** Collect published styles (color/text/effect/grid) from the variables map. */
function collectStyles(doc: PenDocument): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!doc.variables) return out;
  for (const [key, def] of Object.entries(doc.variables)) {
    // Convention: keys prefixed with "style/" are published styles.
    if (key.startsWith('style/')) {
      const styleName = key.slice('style/'.length);
      out[key] = {
        key,
        name: styleName,
        styleType: def.type === 'color' ? 'FILL' : def.type === 'number' ? 'TEXT' : 'FILL',
        description: '',
      };
    }
  }
  return out;
}

function penNodeToFigmaNode(node: PenChild, id: string): Record<string, unknown> {
  const base = {
    id,
    name: (node as PenChild & { name?: string }).name ?? id,
    visible: node.enabled !== false,
    locked: (node as PenChild & { locked?: boolean }).locked ?? false,
  };

  switch (node.type) {
    case 'frame': {
      const f = node as PenFrame;
      const isComp = f.reusable === true;
      const isCompSet = (f.metadata as { isComponentSet?: boolean } | undefined)?.isComponentSet;
      const isSection = (f.metadata as { isSection?: boolean } | undefined)?.isSection;
      const isSlice = (f.metadata as { isSlice?: boolean } | undefined)?.isSlice;
      const type = isSlice ? 'SLICE' : isSection ? 'SECTION' : isCompSet ? 'COMPONENT_SET' : isComp ? 'COMPONENT' : 'FRAME';
      return {
        ...base,
        type,
        ...(f.x !== undefined ? { x: f.x } : {}),
        ...(f.y !== undefined ? { y: f.y } : {}),
        ...(f.width !== undefined ? { width: typeof f.width === 'number' ? f.width : 100 } : {}),
        ...(f.height !== undefined ? { height: typeof f.height === 'number' ? f.height : 100 } : {}),
        rotation: f.rotation ?? 0,
        clipsContent: f.clip ?? false,
        layoutMode: figmaLayoutMode(f.layout),
        fills: penFillsToFigma(f.fill),
        strokes: penFillsToFigma(f.stroke),
        strokeWeight: typeof f.strokeWidth === 'number' ? f.strokeWidth : 0,
        cornerRadius: typeof f.cornerRadius === 'number' ? f.cornerRadius : 0,
        opacity: f.opacity ?? 1,
        blendMode: penBlendToFigma(f.blendMode),
        children: (f.children ?? []).map((c, i) => penNodeToFigmaNode(c, `${id}:${i}`)),
      };
    }
    case 'group': {
      const g = node as PenGroup;
      return {
        ...base,
        type: 'GROUP',
        children: (g.children ?? []).map((c, i) => penNodeToFigmaNode(c, `${id}:${i}`)),
      };
    }
    case 'rectangle': {
      const r = node as PenRectangle;
      return {
        ...base,
        type: 'RECTANGLE',
        x: r.x ?? 0, y: r.y ?? 0,
        width: typeof r.width === 'number' ? r.width : 100,
        height: typeof r.height === 'number' ? r.height : 100,
        fills: penFillsToFigma(r.fill),
        strokes: penFillsToFigma(r.stroke),
        strokeWeight: typeof r.strokeWidth === 'number' ? r.strokeWidth : 0,
        cornerRadius: typeof r.cornerRadius === 'number' ? r.cornerRadius : 0,
        opacity: r.opacity ?? 1,
        blendMode: penBlendToFigma(r.blendMode),
      };
    }
    case 'ellipse': {
      const e = node as PenEllipse;
      return {
        ...base,
        type: 'ELLIPSE',
        x: e.x ?? 0, y: e.y ?? 0,
        width: typeof e.width === 'number' ? e.width : 100,
        height: typeof e.height === 'number' ? e.height : 100,
        fills: penFillsToFigma(e.fill),
        arcData: {
          startingAngle: (e.startAngle as number) ?? 0,
          endingAngle: ((e.startAngle as number) ?? 0) + ((e.sweepAngle as number) ?? 360),
          innerRadius: (e.innerRadius as number) ?? 0,
        },
      };
    }
    case 'polygon': {
      const p = node as PenPolygon;
      return {
        ...base,
        type: 'REGULAR_POLYGON',
        x: p.x ?? 0, y: p.y ?? 0,
        width: typeof p.width === 'number' ? p.width : 100,
        height: typeof p.height === 'number' ? p.height : 100,
        fills: penFillsToFigma(p.fill),
        // Figma doesn't expose point count via REST API directly; stashed in metadata
        ...({ pointCount: p.polygonCount ?? 6 }),
      };
    }
    case 'star': {
      const st = node as PenStar;
      return {
        ...base,
        type: 'STAR',
        x: st.x ?? 0, y: st.y ?? 0,
        width: typeof st.width === 'number' ? st.width : 100,
        height: typeof st.height === 'number' ? st.height : 100,
        fills: penFillsToFigma(st.fill),
        ...({ pointCount: st.pointCount ?? 5, innerRadius: st.innerRadius ?? 0.5 }),
      };
    }
    case 'path': {
      const p = node as PenPath;
      return {
        ...base,
        type: 'VECTOR',
        x: p.x ?? 0, y: p.y ?? 0,
        width: typeof p.width === 'number' ? p.width : 100,
        height: typeof p.height === 'number' ? p.height : 100,
        fills: penFillsToFigma(p.fill),
      };
    }
    case 'text': {
      const t = node as PenText;
      return {
        ...base,
        type: 'TEXT',
        x: t.x ?? 0, y: t.y ?? 0,
        width: typeof t.width === 'number' ? t.width : 100,
        height: typeof t.height === 'number' ? t.height : 20,
        characters: t.content ?? '',
        style: {
          fontFamily: t.fontFamily ?? 'Inter',
          fontSize: t.fontSize ?? 16,
          fontWeight: typeof t.fontWeight === 'number' ? t.fontWeight : 400,
          textAlignHorizontal: (t.textAlign ?? 'left').toUpperCase(),
          lineHeightPx: typeof t.lineHeight === 'number' ? t.lineHeight : (typeof t.fontSize === 'number' ? t.fontSize : 16) * 1.4,
        },
        fills: penFillsToFigma(t.fill),
      };
    }
    case 'note': {
      const n = node as PenNote;
      return {
        ...base,
        type: 'STICKY',
        x: n.x ?? 0, y: n.y ?? 0,
        width: typeof n.width === 'number' ? n.width : 200,
        height: typeof n.height === 'number' ? n.height : 160,
        characters: n.content ?? '',
      };
    }
    case 'icon': {
      const ic = node as PenIcon;
      return {
        ...base,
        type: 'VECTOR',
        x: ic.x ?? 0, y: ic.y ?? 0,
        width: typeof ic.width === 'number' ? ic.width : 24,
        height: typeof ic.height === 'number' ? ic.height : 24,
        ...({ iconLibrary: ic.library ?? 'lucide', iconName: ic.icon ?? '' }),
      };
    }
    case 'ref': {
      const r = node as PenRef;
      return {
        ...base,
        type: 'INSTANCE',
        componentId: r.ref,
        x: r.x ?? 0, y: r.y ?? 0,
        width: typeof r.width === 'number' ? r.width : 100,
        height: typeof r.height === 'number' ? r.height : 100,
        overrides: r.descendants ?? {},
        ...({ variantValues: r.variantValues ?? {} }),
      };
    }
    case 'boolean_op': {
      const b = node as PenBooleanOp;
      return {
        ...base,
        type: 'BOOLEAN_OPERATION',
        booleanOperation: (b.operation ?? 'union').toUpperCase(),
        children: (b.children ?? []).map((c, i) => penNodeToFigmaNode(c, `${id}:${i}`)),
      };
    }
    default:
      return { ...base, type: 'FRAME' };
  }
}

function figmaLayoutMode(layout: PenFrame['layout']): string {
  switch (layout) {
    case 'horizontal': return 'HORIZONTAL';
    case 'vertical': return 'VERTICAL';
    case 'grid': return 'GRID';
    default: return 'NONE';
  }
}

function penFillsToFigma(fill: unknown): unknown[] {
  if (!fill) return [];
  const fills = Array.isArray(fill) ? fill : [fill];
  return fills.map((f) => {
    if (typeof f === 'string') {
      return { type: 'SOLID', color: hexToRGBA(f) };
    }
    if (typeof f === 'object' && f !== null) {
      const ff = f as { type?: string; color?: string; gradientType?: string; colors?: Array<{ color?: string; position?: number }>; url?: string; mode?: string };
      if (ff.type === 'color' && ff.color) {
        return { type: 'SOLID', color: hexToRGBA(ff.color) };
      }
      if (ff.type === 'gradient') {
        return {
          type: `GRADIENT_${(ff.gradientType ?? 'linear').toUpperCase()}`,
          gradientStops: (ff.colors ?? []).map((c) => ({
            position: c.position ?? 0,
            color: hexToRGBA(c.color ?? '#000000'),
          })),
        };
      }
      if (ff.type === 'image') {
        return { type: 'IMAGE', imageRef: ff.url ?? '', scaleMode: (ff.mode ?? 'fill').toUpperCase() };
      }
    }
    return null;
  }).filter(Boolean);
}

function hexToRGBA(hex: string): { r: number; g: number; b: number; a: number } {
  if (typeof hex !== 'string' || !hex.startsWith('#')) {
    return { r: 0, g: 0, b: 0, a: 1 };
  }
  const clean = hex.slice(1);
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const a = clean.length >= 8 ? parseInt(clean.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, a };
}

function penBlendToFigma(blend: PenBlendMode | undefined): string {
  if (!blend) return 'NORMAL';
  const SCREAMING = blend.charAt(0).toUpperCase() + blend.slice(1);
  // Convert camelCase to SCREAMING_SNAKE
  return SCREAMING.replace(/([A-Z])/g, '_$1').toUpperCase().replace(/^_/, '');
}

function collectComponents(doc: PenDocument): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  walk(doc.children, (n) => {
    if ((n as PenChild & { reusable?: boolean }).reusable === true && n.type === 'frame') {
      const f = n as PenFrame;
      const key = f.id;
      out[key] = {
        key,
        name: f.name ?? f.id,
        description: '',
        componentSetId: null,
      };
    }
  });
  return out;
}

function collectComponentSets(doc: PenDocument): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  walk(doc.children, (n) => {
    if (n.type === 'frame' && (n as PenFrame).metadata && ((n as PenFrame).metadata as { isComponentSet?: boolean }).isComponentSet) {
      const f = n as PenFrame;
      out[f.id] = { key: f.id, name: f.name ?? f.id, description: '' };
    }
  });
  return out;
}

function collectVariables(doc: PenDocument): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!doc.variables) return out;
  for (const [key, def] of Object.entries(doc.variables)) {
    out[key] = {
      id: key,
      name: key,
      key,
      variableCollectionId: 'default',
      resolvedType: penVarTypeToFigma(def.type),
      valuesByMode: penVarValueToFigma(def),
      remote: false,
      description: '',
      hiddenFromPublishing: false,
      scopes: ['ALL_SCOPES'],
      codeSyntax: {},
    };
  }
  return out;
}

function collectVariableCollections(doc: PenDocument): Record<string, unknown> {
  if (!doc.themes) return {};
  const out: Record<string, unknown> = {};
  for (const [axis, values] of Object.entries(doc.themes)) {
    out[axis] = {
      id: axis,
      name: axis,
      key: axis,
      modes: values.map((v, i) => ({ modeId: `${i}`, name: v })),
      defaultModeId: '0',
      remote: false,
      hiddenFromPublishing: false,
      variableIds: [],
    };
  }
  return out;
}

function penVarTypeToFigma(t: PenVariableDef['type']): string {
  switch (t) {
    case 'color': return 'COLOR';
    case 'number': return 'FLOAT';
    case 'string': return 'STRING';
    case 'boolean': return 'BOOLEAN';
  }
}

function penVarValueToFigma(def: PenVariableDef): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (Array.isArray(def.value)) {
    def.value.forEach((tv, i) => {
      out[`${i}`] = tv.value;
    });
  } else {
    out['0'] = def.value;
  }
  return out;
}

function walk(nodes: PenChild[], fn: (n: PenChild) => void): void {
  for (const n of nodes) {
    fn(n);
    if ('children' in n && Array.isArray((n as PenFrame).children)) {
      walk((n as PenFrame).children!, fn);
    }
  }
}

// ============================================================================
// v1.x → v2.0 migration
// ============================================================================

/**
 * Migrate a v1.x .pen document to v2.0.
 *
 * v1.x had:
 *   - flat `shapes[]` array (now `children[]` tree)
 *   - `tokens` field (now `variables`)
 *   - `Shape.type === 'image'` (now a frame with image fill)
 *
 * The migration is one-way and lossless for all v1 features that have
 * v2 equivalents. See docs/pen-spec-v2.md#16-migration-from-v1x--v20.
 */
export function migrateV1ToV2(doc: Record<string, unknown>): PenDocument {
  const version = (doc.version as string) ?? '1.0';
  if (version.startsWith('2.')) {
    // Already v2 — just normalize.
    return {
      version: PEN_FORMAT_VERSION,
      themes: doc.themes as { [axis: string]: string[] } | undefined,
      imports: doc.imports as { [alias: string]: string } | undefined,
      variables: doc.variables as { [key: string]: PenVariableDef } | undefined,
      children: (doc.children as PenChild[]) ?? [],
    };
  }

  // v1.x → v2.0 migration
  const shapes = (doc.shapes as Array<Record<string, unknown>>) ?? [];
  const tokens = (doc.tokens as { colors?: unknown[]; textStyles?: unknown[] }) ?? undefined;

  // Convert flat shapes[] to a tree under a single root frame
  const children: PenChild[] = shapes.map((s) => migrateV1Shape(s));

  // Convert tokens to variables
  const variables: { [key: string]: PenVariableDef } = {};
  if (tokens?.colors) {
    for (const c of tokens.colors as Array<{ name?: string; key?: string; value?: string }>) {
      const k = c.key ?? c.name ?? '';
      if (k) variables[k] = { type: 'color', value: c.value ?? '#000000' };
    }
  }
  if (tokens?.textStyles) {
    for (const t of tokens.textStyles as Array<{ name?: string; key?: string; fontSize?: number; fontWeight?: number; lineHeight?: number; color?: string }>) {
      const k = t.key ?? t.name ?? '';
      if (k) {
        variables[`${k}.fontSize`] = { type: 'number', value: t.fontSize ?? 16 };
        variables[`${k}.fontWeight`] = { type: 'number', value: t.fontWeight ?? 400 };
        variables[`${k}.color`] = { type: 'color', value: t.color ?? '#000000' };
      }
    }
  }

  return {
    version: PEN_FORMAT_VERSION,
    themes: undefined,
    variables: Object.keys(variables).length ? variables : undefined,
    children,
  };
}

function migrateV1Shape(s: Record<string, unknown>): PenChild {
  const type = (s.type as string) ?? 'rectangle';
  const id = (s.id as string) ?? `node-${Math.random().toString(36).slice(2, 9)}`;
  const base = {
    id,
    name: (s.name as string) ?? id,
    x: (s.x as number) ?? 0,
    y: (s.y as number) ?? 0,
    width: (s.width as number) ?? 100,
    height: (s.height as number) ?? 100,
    rotation: (s.rotation as number) ?? 0,
    opacity: (s.opacity as number) ?? 1,
    fill: (s.fill as string) ?? '#e2e8f0',
    stroke: (s.stroke as string) ?? '#0f172a',
    strokeWidth: (s.strokeWidth as number) ?? 0,
    cornerRadius: (s.radius as number) ?? 0,
    visible: (s.visible as boolean) ?? true,
    locked: (s.locked as boolean) ?? false,
  };

  if (type === 'image') {
    // v1 'image' → v2 frame with image fill
    return {
      type: 'frame',
      ...base,
      fill: { type: 'image', url: (s.src as string) ?? '', mode: 'fill' },
    } as PenFrame;
  }

  // Map v1 type names to v2 type names
  const v2Type = type === 'vector' ? 'path' : type;
  return { type: v2Type, ...base } as PenChild;
}
