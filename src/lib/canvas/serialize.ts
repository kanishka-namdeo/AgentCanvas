// One serializer, three frameworks (spec §5.3 — copy-as-code v2).
//
// `serializeNodes` consumes EITHER the resolver's pre-flattening tree
// (`ResolvedTreeNode[]` from `resolvePenTreeDetailed` — preferred: carries the
// .pen layout vocabulary) OR a flat resolved layer list (`Shape[]` — the
// client-side export path, where the parent/child map is rebuilt from
// `parentId` links) and emits:
//
//   - html:    semantic nested markup + inline styles
//   - react:   a JSX component with `style={{…}}` props
//   - tailwind: mapped class candidates + arbitrary values (`w-[347px]`)
//
// Auto-layout containers serialize as REAL flexbox (responsive-ready);
// `layout:'none'` containers serialize as relative containers with
// absolutely-positioned children — matching what the user sees, because the
// DOM is what the user sees. Every element carries
// `data-name="<layer.name>" data-node-id="<id>"`, and token-bound fills emit
// `var(--acv-<key>, <resolved>)` so token identity survives the handoff
// (Figma Dev Mode MCP's get_design_context contract).
//
// This module is server-safe (pure string building — no DOM) and shares the
// emission core between the agent tool (`pen_copy_as_code`,
// `pen_get_design_context`) and the client-side export (`export.ts`).

import type { Shape } from './types';
import type { ResolvedTreeNode } from '../pen/resolve';
import type { PenChild } from '../pen/types';

export interface SerializeOpts {
  framework: 'html' | 'react' | 'tailwind';
  /// Root element/component name (html data-name, react function name).
  /// Defaults to 'CanvasExport'. React: forced to PascalCase.
  rootName?: string;
}

// ---- Internal normalized tree ----------------------------------------------

interface SerNode {
  layer: Shape;
  pen: PenChild | null;
  children: SerNode[];
}

interface LayoutInfo {
  direction: 'horizontal' | 'vertical';
  gap: number;
  padding: number | [number, number, number, number];
  justify: 'start' | 'center' | 'end' | 'space_between' | 'space_around';
  align: 'start' | 'center' | 'end';
}

function num(v: unknown, def: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : def;
}

function getLayout(node: SerNode): LayoutInfo | null {
  if (node.pen) {
    const layout = (node.pen as { layout?: unknown }).layout;
    if (layout !== 'horizontal' && layout !== 'vertical') return null;
    const pad = (node.pen as { padding?: unknown }).padding;
    return {
      direction: layout,
      gap: num((node.pen as { gap?: unknown }).gap, 0),
      padding:
        typeof pad === 'number' ? pad
        : Array.isArray(pad) && pad.length === 4
          ? [num(pad[0], 0), num(pad[1], 0), num(pad[2], 0), num(pad[3], 0)]
          : 0,
      justify: ((node.pen as { justifyContent?: LayoutInfo['justify'] }).justifyContent ?? 'start'),
      align: ((node.pen as { alignItems?: LayoutInfo['align'] }).alignItems ?? 'start'),
    };
  }
  const al = node.layer.autoLayout;
  if (!al) return null;
  return {
    direction: al.direction,
    gap: al.gap,
    padding: al.padding,
    justify: al.alignX === 'max' ? 'end' : al.alignX === 'center' ? 'center' : 'start',
    align: al.alignY === 'max' ? 'end' : al.alignY === 'center' ? 'center' : 'start',
  };
}

const CONTAINER_TYPES = new Set([
  'frame', 'group', 'section', 'component', 'component_set', 'boolean_operation', 'instance',
]);

/// Build the normalized tree from a flat resolved layer list — the client-side
/// path (export.ts) where only `Shape[]` is available. Mirrors DomCanvas's
/// tree building: Map<parentId, children[]> sorted by zIndex; roots are
/// parentId null/absent/unknown; duplicate ids resolved last-writer-wins.
function treeFromLayers(layers: Shape[]): SerNode[] {
  const byId = new Map<string, Shape>();
  for (const s of layers) byId.set(s.id, s);
  const byParent = new Map<string, SerNode[]>();
  const nodes = new Map<string, SerNode>();
  for (const s of layers) {
    nodes.set(s.id, { layer: s, pen: null, children: [] });
  }
  const roots: SerNode[] = [];
  for (const s of layers) {
    const node = nodes.get(s.id)!;
    const p = s.parentId ?? null;
    if (p && byId.has(p)) {
      const list = byParent.get(p) ?? [];
      list.push(node);
      byParent.set(p, list);
    } else {
      roots.push(node);
    }
  }
  for (const [pid, list] of byParent) {
    list.sort((a, b) => a.layer.zIndex - b.layer.zIndex);
    const parent = nodes.get(pid);
    if (parent) parent.children = list;
  }
  roots.sort((a, b) => a.layer.zIndex - b.layer.zIndex);
  return roots;
}

function treeFromResolved(tree: ResolvedTreeNode[]): SerNode[] {
  return tree.map((n) => ({ layer: n.layer, pen: n.pen, children: treeFromResolved(n.children) }));
}

// ---- Style computation ------------------------------------------------------

type StyleMap = Record<string, string | number>;

function sanitizeVarKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9-]/g, '-');
}

/// Color value with token binding → `var(--acv-<key>, <resolved>)`.
function cssColor(layer: Shape, which: 'fill' | 'text' | 'stroke'): string {
  const resolved =
    which === 'fill' ? layer.fill : which === 'text' ? layer.textColor || layer.fill : layer.stroke;
  const tb = layer.tokenBinding;
  const key =
    which === 'fill' ? tb?.fillToken : which === 'text' ? tb?.textToken : tb?.strokeToken;
  if (key) return `var(--acv-${sanitizeVarKey(key)}, ${resolved})`;
  return resolved;
}

function isTransparent(v: string | undefined): boolean {
  return !v || v === 'transparent' || v === 'none';
}

/// Visual (non-positional) styles shared by all frameworks.
function visualStyles(node: SerNode): StyleMap {
  const l = node.layer;
  const styles: StyleMap = {};
  if (l.opacity < 1) styles['opacity'] = l.opacity;
  if (l.shadow && (l.shadow.x !== 0 || l.shadow.y !== 0 || l.shadow.blur > 0)) {
    const s = l.shadow;
    styles['box-shadow'] = `${s.inset ? 'inset ' : ''}${s.x}px ${s.y}px ${s.blur}px${s.spread ? ` ${s.spread}px` : ''} ${s.color}`;
  }
  if (l.blur && l.blur > 0) styles['filter'] = `blur(${l.blur}px)`;
  return styles;
}

function boxStyles(node: SerNode): StyleMap {
  const l = node.layer;
  const styles = visualStyles(node);
  if (!isTransparent(l.fill)) styles['background'] = cssColor(l, 'fill');
  if (l.radii) {
    styles['border-radius'] = `${l.radii.topLeft}px ${l.radii.topRight}px ${l.radii.bottomRight}px ${l.radii.bottomLeft}px`;
  } else if (l.radius > 0) {
    styles['border-radius'] = l.type === 'ellipse' ? '50%' : `${l.radius}px`;
  } else if (l.type === 'ellipse') {
    styles['border-radius'] = '50%';
  }
  if (l.strokeWidth > 0 && !isTransparent(l.stroke)) {
    styles['border'] = `${l.strokeWidth}px solid ${cssColor(l, 'stroke')}`;
  }
  return styles;
}

function textStyles(node: SerNode): StyleMap {
  const l = node.layer;
  const styles = visualStyles(node);
  styles['font-size'] = `${Math.round(l.fontSize)}px`;
  if (l.fontWeight && l.fontWeight !== 400) styles['font-weight'] = l.fontWeight;
  styles['color'] = cssColor(l, 'text');
  if (l.fontFamily) styles['font-family'] = String(l.fontFamily);
  if (l.lineHeight) styles['line-height'] = String(l.lineHeight);
  if (l.letterSpacing) styles['letter-spacing'] = `${l.letterSpacing}px`;
  if (l.textAlign && l.textAlign !== 'left') styles['text-align'] = l.textAlign;
  if (l.underline) styles['text-decoration'] = 'underline';
  return styles;
}

function flexStyles(layout: LayoutInfo): StyleMap {
  const styles: StyleMap = {
    'display': 'flex',
    'flex-direction': layout.direction === 'vertical' ? 'column' : 'row',
  };
  if (layout.gap > 0) styles['gap'] = `${Math.round(layout.gap)}px`;
  if (typeof layout.padding === 'number' && layout.padding > 0) {
    styles['padding'] = `${Math.round(layout.padding)}px`;
  } else if (Array.isArray(layout.padding)) {
    styles['padding'] = layout.padding.map((p) => `${Math.round(p)}px`).join(' ');
  }
  if (layout.justify !== 'start') {
    styles['justify-content'] = layout.justify === 'space_between' ? 'space-between' : layout.justify === 'space_around' ? 'space-around' : layout.justify;
  }
  if (layout.align !== 'start') styles['align-items'] = layout.align;
  return styles;
}

/// Full style map for a node given its positioning context.
///   mode 'root'      — top-level child of the relative wrapper: absolute at bbox offset
///   mode 'absolute'  — child of a layout:'none' container: absolute relative to parent
///   mode 'flexChild' — child of a flex container: fixed size, no position
function stylesFor(node: SerNode, mode: 'root' | 'absolute' | 'flexChild', offset: { x: number; y: number }): StyleMap {
  const l = node.layer;
  const layout = getLayout(node);
  const styles: StyleMap = {};
  if (mode === 'root' || mode === 'absolute') {
    styles['position'] = 'absolute';
    styles['left'] = `${Math.round(offset.x)}px`;
    styles['top'] = `${Math.round(offset.y)}px`;
  }
  styles['width'] = `${Math.round(l.width)}px`;
  styles['height'] = `${Math.round(l.height)}px`;
  if (layout) Object.assign(styles, flexStyles(layout));
  if (l.type === 'text') {
    Object.assign(styles, textStyles(node));
  } else if (l.type === 'line') {
    // line → thin rule (border-top carries the stroke)
    styles['height'] = '0px';
    styles['border-top'] = `${Math.max(1, l.strokeWidth)}px solid ${l.stroke || l.fill}`;
  } else if (l.type === 'image' && l.src) {
    // handled as <img> by the emitters; size only
  } else {
    Object.assign(styles, boxStyles(node));
  }
  return styles;
}

// ---- html emission -----------------------------------------------------------

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function styleToInlineCss(styles: StyleMap): string {
  return Object.entries(styles)
    .map(([k, v]) => `${k}:${v}`)
    .join(';');
}

function emitHtml(node: SerNode, mode: 'root' | 'absolute' | 'flexChild', offset: { x: number; y: number }, indent: string): string {
  const l = node.layer;
  const styles = stylesFor(node, mode, offset);
  const attrs =
    `data-name="${escapeHtmlAttr(l.name)}" data-node-id="${escapeHtmlAttr(l.id)}"` +
    (Object.keys(styles).length > 0 ? ` style="${escapeHtmlAttr(styleToInlineCss(styles))}"` : '');
  const ltype = l.type;

  if (ltype === 'image' && l.src) {
    return `${indent}<img ${attrs} src="${escapeHtmlAttr(l.src)}" alt="${escapeHtmlAttr(l.name)}" />`;
  }
  if (ltype === 'text') {
    return `${indent}<span ${attrs}>${escapeHtmlText(l.text ?? '')}</span>`;
  }

  const kids = node.children
    .map((child) => {
      const layout = getLayout(node);
      const childMode = layout ? 'flexChild' : 'absolute';
      const childOffset = { x: child.layer.x - l.x, y: child.layer.y - l.y };
      return emitHtml(child, childMode, childOffset, `${indent}  `);
    })
    .filter((s) => s !== '');
  if (kids.length === 0) return `${indent}<div ${attrs}></div>`;
  return `${indent}<div ${attrs}>\n${kids.join('\n')}\n${indent}</div>`;
}

function serializeHtml(roots: SerNode[], rootName: string, bbox: { w: number; h: number; minX: number; minY: number }): string {
  const inner = roots
    .map((r) => emitHtml(r, 'root', { x: r.layer.x - bbox.minX, y: r.layer.y - bbox.minY }, '    '))
    .join('\n');
  const wrapperStyle = `position:relative;width:${Math.round(bbox.w)}px;height:${Math.round(bbox.h)}px`;
  return `<div data-name="${escapeHtmlAttr(rootName)}" data-node-id="root" style="${wrapperStyle}">\n${inner}\n</div>`;
}

// ---- react emission ----------------------------------------------------------

function pascalCase(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9]+(.)?/g, (_m, c) => (c ? c.toUpperCase() : ''));
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1) || 'CanvasExport';
}

/// JS string literal with single quotes (idiomatic JSX style objects).
function jsString(v: string): string {
  return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function jsxText(text: string): string {
  // JSX text children can't contain raw <, >, {, } — emit a JS string child.
  if (/[<>{}]/.test(text)) return `{${jsString(text)}}`;
  return text;
}

/// JSX style prop value: `{{ k: v, … }}` (double braces — an expression
/// container wrapping an object literal). `{}` when empty.
function styleToJsxObject(styles: StyleMap): string {
  const entries = Object.entries(styles);
  if (entries.length === 0) return '{}';
  const inner = entries.map(([k, v]) => {
    const key = /-/.test(k) ? `'${k}'` : k;
    return `${key}: ${typeof v === 'number' ? String(v) : jsString(String(v))}`;
  }).join(', ');
  return `{{ ${inner} }}`;
}

function emitReact(node: SerNode, mode: 'root' | 'absolute' | 'flexChild', offset: { x: number; y: number }, indent: string): string {
  const l = node.layer;
  const styles = stylesFor(node, mode, offset);
  const styleProp = styleToJsxObject(styles);
  const attrs = `data-name="${escapeHtmlAttr(l.name)}" data-node-id="${escapeHtmlAttr(l.id)}"`;
  const ltype = l.type;

  if (ltype === 'image' && l.src) {
    return `${indent}<img ${attrs} src="${escapeHtmlAttr(l.src)}" alt="${escapeHtmlAttr(l.name)}" style=${styleProp} />`;
  }
  if (ltype === 'text') {
    return `${indent}<span ${attrs} style=${styleProp}>${jsxText(l.text ?? '')}</span>`;
  }

  const kids = node.children
    .map((child) => {
      const layout = getLayout(node);
      const childMode = layout ? 'flexChild' : 'absolute';
      const childOffset = { x: child.layer.x - l.x, y: child.layer.y - l.y };
      return emitReact(child, childMode, childOffset, `${indent}  `);
    })
    .filter((s) => s !== '');
  if (kids.length === 0) return `${indent}<div ${attrs} style=${styleProp} />`;
  return `${indent}<div ${attrs} style=${styleProp}>\n${kids.join('\n')}\n${indent}</div>`;
}

function serializeReact(roots: SerNode[], rootName: string, bbox: { w: number; h: number; minX: number; minY: number }): string {
  const componentName = pascalCase(rootName);
  const inner = roots
    .map((r) => emitReact(r, 'root', { x: r.layer.x - bbox.minX, y: r.layer.y - bbox.minY }, '      '))
    .join('\n');
  const wrapperStyle = styleToJsxObject(
    { position: 'relative', width: `${Math.round(bbox.w)}px`, height: `${Math.round(bbox.h)}px` },
  );
  return `export function ${componentName}() {\n  return (\n    <div data-name="${escapeHtmlAttr(rootName)}" data-node-id="root" style=${wrapperStyle}>\n${inner}\n    </div>\n  );\n}`;
}

// ---- tailwind emission -------------------------------------------------------

/// Common design-system hexes → Tailwind class candidates (best-effort).
const COLOR_CLASSES: Record<string, string> = {
  '#f8fafc': 'bg-slate-50', '#f1f5f9': 'bg-slate-100', '#e2e8f0': 'bg-slate-200',
  '#cbd5e1': 'bg-slate-300', '#94a3b8': 'bg-slate-400', '#64748b': 'bg-slate-500',
  '#475569': 'bg-slate-600', '#334155': 'bg-slate-700', '#1e293b': 'bg-slate-800',
  '#0f172a': 'bg-slate-900', '#ffffff': 'bg-white', '#000000': 'bg-black',
  '#0ea5e9': 'bg-sky-500', '#0284c7': 'bg-sky-600', '#6366f1': 'bg-indigo-500',
  '#8b5cf6': 'bg-violet-500', '#10b981': 'bg-emerald-500', '#ef4444': 'bg-red-500',
  '#f59e0b': 'bg-amber-500', '#14b8a6': 'bg-teal-500',
};

/// Map a color string → tailwind class fragment (without the bg-/text- prefix
/// context — COLOR_CLASSES values already carry it for bg usage).
function colorClasses(v: string): { bg: string; text: string } {
  const hexKey = v.toLowerCase();
  if (COLOR_CLASSES[hexKey]) {
    return { bg: COLOR_CLASSES[hexKey], text: COLOR_CLASSES[hexKey].replace(/^bg-/, 'text-') };
  }
  if (v.startsWith('var(')) {
    // var(--acv-key, fallback) → arbitrary value (no spaces allowed).
    const compact = v.replace(/\s+/g, '_');
    return { bg: `bg-[color:${compact}]`, text: `text-[color:${compact}]` };
  }
  const compact = v.replace(/\s+/g, '_');
  return { bg: `bg-[${compact}]`, text: `text-[${compact}]` };
}

/// spacing scale: N px → `-{N/4}` when divisible, else `-[Npx]`.
function spacingClass(prefix: string, px: number): string {
  const rounded = Math.round(px);
  if (rounded > 0 && rounded <= 96 && rounded % 4 === 0) return `${prefix}-${rounded / 4}`;
  return `${prefix}-[${rounded}px]`;
}

function radiusClass(px: number): string {
  const table: Record<number, string> = {
    0: 'rounded-none', 2: 'rounded-sm', 4: 'rounded', 6: 'rounded-md',
    8: 'rounded-lg', 12: 'rounded-xl', 16: 'rounded-2xl', 24: 'rounded-3xl',
    9999: 'rounded-full',
  };
  if (table[px]) return table[px];
  return `rounded-[${Math.round(px)}px]`;
}

function shadowClass(s: { x: number; y: number; blur: number; color: string }): string | null {
  const key = `${s.x} ${s.y} ${s.blur}`;
  const table: Record<string, string> = {
    '0 1 2': 'shadow-sm', '0 1 3': 'shadow', '0 4 6': 'shadow-md',
    '0 10 15': 'shadow-lg', '0 20 25': 'shadow-xl',
  };
  if (table[key]) return table[key];
  return null; // fall back to arbitrary property below
}

function classesFor(node: SerNode, mode: 'root' | 'absolute' | 'flexChild', offset: { x: number; y: number }): string {
  const l = node.layer;
  const layout = getLayout(node);
  const cls: string[] = [];
  const extras: string[] = []; // arbitrary-property fallbacks

  if (mode === 'root' || mode === 'absolute') {
    cls.push('absolute');
    cls.push(`left-[${Math.round(offset.x)}px]`);
    cls.push(`top-[${Math.round(offset.y)}px]`);
  }
  cls.push(`w-[${Math.round(l.width)}px]`);
  if (l.type === 'line') {
    cls.push(`h-[1px]`);
  } else {
    cls.push(`h-[${Math.round(l.height)}px]`);
  }

  if (layout) {
    cls.push('flex');
    if (layout.direction === 'vertical') cls.push('flex-col');
    if (layout.gap > 0) cls.push(spacingClass('gap', layout.gap));
    if (typeof layout.padding === 'number' && layout.padding > 0) {
      cls.push(spacingClass('p', layout.padding));
    } else if (Array.isArray(layout.padding)) {
      const [t, r, b, le] = layout.padding.map((p) => Math.round(p));
      if (t === r && r === b && b === le && t > 0) cls.push(spacingClass('p', t));
      else if (t === b && r === le) cls.push(`px-[${r}px]`, `py-[${t}px]`);
      else cls.push(`p-[${t}px_${r}px_${b}px_${le}px]`);
    }
    if (layout.justify === 'center') cls.push('justify-center');
    else if (layout.justify === 'end') cls.push('justify-end');
    else if (layout.justify === 'space_between') cls.push('justify-between');
    else if (layout.justify === 'space_around') cls.push('justify-around');
    if (layout.align === 'center') cls.push('items-center');
    else if (layout.align === 'end') cls.push('items-end');
  }

  if (l.type === 'text') {
    cls.push(`text-[${Math.round(l.fontSize)}px]`);
    if (l.fontWeight === 700) cls.push('font-bold');
    else if (l.fontWeight === 600) cls.push('font-semibold');
    else if (l.fontWeight === 500) cls.push('font-medium');
    cls.push(colorClasses(cssColor(l, 'text')).text);
    if (l.textAlign === 'center') cls.push('text-center');
    else if (l.textAlign === 'right') cls.push('text-right');
    if (l.lineHeight) cls.push(`leading-[${l.lineHeight}]`);
    if (l.letterSpacing) cls.push(`tracking-[${l.letterSpacing}px]`);
    if (l.underline) cls.push('underline');
  } else if (l.type === 'line') {
    cls.push(`border-t-[${Math.max(1, l.strokeWidth)}px]`);
    cls.push(colorClasses(l.stroke || l.fill).bg.startsWith('bg-')
      ? colorClasses(l.stroke || l.fill).bg.replace(/^bg-/, 'border-')
      : `border-[${(l.stroke || l.fill).replace(/\s+/g, '_')}]`);
  } else if (l.type !== 'image') {
    if (!isTransparent(l.fill)) cls.push(colorClasses(cssColor(l, 'fill')).bg);
    if (l.radii) {
      cls.push(`rounded-[${l.radii.topLeft}px_${l.radii.topRight}px_${l.radii.bottomRight}px_${l.radii.bottomLeft}px]`);
    } else if (l.radius > 0 || l.type === 'ellipse') {
      cls.push(radiusClass(l.type === 'ellipse' ? 9999 : l.radius));
    }
    if (l.strokeWidth > 0 && !isTransparent(l.stroke)) {
      cls.push(l.strokeWidth === 1 ? 'border' : `border-[${l.strokeWidth}px]`);
      const sc = colorClasses(cssColor(l, 'stroke'));
      cls.push(sc.bg.startsWith('bg-') ? sc.bg.replace(/^bg-/, 'border-') : sc.bg.replace(/^bg-\[color:/, 'border-[color:'));
    }
  }

  if (l.opacity < 1) cls.push(`opacity-[${Math.round(l.opacity * 100) / 100}]`);
  if (l.shadow && (l.shadow.x !== 0 || l.shadow.y !== 0 || l.shadow.blur > 0)) {
    const mapped = shadowClass(l.shadow);
    if (mapped) cls.push(mapped);
    else extras.push(`[box-shadow:${l.shadow.x}px_${l.shadow.y}px_${l.shadow.blur}px_${(l.shadow.color ?? '#0000001a').replace(/\s+/g, '_')}]`);
  }

  return [...cls, ...extras].join(' ');
}

function emitTailwind(node: SerNode, mode: 'root' | 'absolute' | 'flexChild', offset: { x: number; y: number }, indent: string): string {
  const l = node.layer;
  const cls = classesFor(node, mode, offset);
  const attrs = `data-name="${escapeHtmlAttr(l.name)}" data-node-id="${escapeHtmlAttr(l.id)}"`;

  if (l.type === 'image' && l.src) {
    return `${indent}<img class="${cls}" ${attrs} src="${escapeHtmlAttr(l.src)}" alt="${escapeHtmlAttr(l.name)}" />`;
  }
  if (l.type === 'text') {
    return `${indent}<span class="${cls}" ${attrs}>${escapeHtmlText(l.text ?? '')}</span>`;
  }

  const kids = node.children
    .map((child) => {
      const layout = getLayout(node);
      const childMode = layout ? 'flexChild' : 'absolute';
      const childOffset = { x: child.layer.x - l.x, y: child.layer.y - l.y };
      return emitTailwind(child, childMode, childOffset, `${indent}  `);
    })
    .filter((s) => s !== '');
  if (kids.length === 0) return `${indent}<div class="${cls}" ${attrs}></div>`;
  return `${indent}<div class="${cls}" ${attrs}>\n${kids.join('\n')}\n${indent}</div>`;
}

function serializeTailwind(roots: SerNode[], rootName: string, bbox: { w: number; h: number; minX: number; minY: number }): string {
  const inner = roots
    .map((r) => emitTailwind(r, 'root', { x: r.layer.x - bbox.minX, y: r.layer.y - bbox.minY }, '    '))
    .join('\n');
  return `<div class="relative" data-name="${escapeHtmlAttr(rootName)}" data-node-id="root" style="width:${Math.round(bbox.w)}px;height:${Math.round(bbox.h)}px">\n${inner}\n</div>`;
}

// ---- Entry point --------------------------------------------------------------

function bboxOf(roots: SerNode[]): { w: number; h: number; minX: number; minY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const walk = (nodes: SerNode[]) => {
    for (const n of nodes) {
      minX = Math.min(minX, n.layer.x);
      minY = Math.min(minY, n.layer.y);
      maxX = Math.max(maxX, n.layer.x + n.layer.width);
      maxY = Math.max(maxY, n.layer.y + n.layer.height);
      walk(n.children);
    }
  };
  walk(roots);
  if (!Number.isFinite(minX)) return { w: 0, h: 0, minX: 0, minY: 0 };
  return { w: maxX - minX, h: maxY - minY, minX, minY };
}

/// Serialize a canvas subtree to html / react / tailwind code.
/// `input` is EITHER the resolver's tree (`ResolvedTreeNode[]`, preferred) or
/// a flat resolved layer list (`Shape[]` — parent/child map rebuilt from
/// parentId links).
export function serializeNodes(input: ResolvedTreeNode[] | Shape[], opts: SerializeOpts): string {
  const roots: SerNode[] = input.length > 0 && 'layer' in input[0] && 'pen' in input[0]
    ? treeFromResolved(input as ResolvedTreeNode[])
    : treeFromLayers(input as Shape[]);
  const rootName = opts.rootName ?? 'CanvasExport';
  const bbox = bboxOf(roots);
  switch (opts.framework) {
    case 'react':
      return serializeReact(roots, rootName, bbox);
    case 'tailwind':
      return serializeTailwind(roots, rootName, bbox);
    case 'html':
    default:
      return serializeHtml(roots, rootName, bbox);
  }
}
