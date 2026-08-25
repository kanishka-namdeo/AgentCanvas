// Sanitized HTML fragment → .pen subtree (spec Phase 3, §5.2 `pen_insert_html`).
//
// SERVER-SAFE BY CONSTRUCTION: Node has no DOMParser and we add no
// dependencies, so this is a strict hand-rolled recursive-descent tokenizer
// for a whitelisted HTML subset. SECURITY-CRITICAL rules (each has tests in
// tests/unit/html-import.test.ts — the XSS corpus):
//
//   1. Tag whitelist (below). Unknown tags are UNWRAPPED (element dropped,
//      children hoisted into the parent) so text content survives. The
//      dangerous-content tags — <script>, <style>, <iframe>, <object>,
//      <embed> — are dropped WITH all their contents.
//   2. Attribute whitelist: style, src, alt, width, height, href, type,
//      placeholder, value. Everything else — on*, class, id, data-*,
//      srcset, formaction, style-adjacent exotics — is dropped.
//   3. href/src URL scheme whitelist: http://, https://, protocol-relative
//      //, root-relative /, ./, ../, #fragment, and data:image/ — anything
//      else (javascript:, vbscript:, data:text/…) drops the attribute.
//   4. Comments, doctypes, and processing instructions are dropped.
//   5. Malformed markup never throws: unclosed tags auto-close at their
//      parent's end; stray close tags are ignored; a bare '<' is text.
//
// v1 KNOWN LIMITATIONS (documented, deliberate):
//   - margins are ignored (no .pen concept; auto-layout flow replaces them)
//   - multi-selector / class-based CSS is not parsed (inline styles only)
//   - gradients / background images are dropped (solid colors only)
//   - <svg>/<path> subtrees are skipped (counted as skipped in stats)
//   - text node sizes are ESTIMATES (server cannot measure text); auto-layout
//     does the real placement of containers.

import type { PenChild } from '../pen/types';

// ---- Public types -----------------------------------------------------------

export interface ImportedNode {
  tag: string;
  attrs: Record<string, string>;
  children: ImportedChild[];
}

export type ImportedChild =
  | { type: 'element'; el: ImportedNode }
  | { type: 'text'; text: string };

export interface HtmlImportStats {
  /// Total .pen nodes produced (roots + descendants).
  nodeCount: number;
  /// Count of produced nodes by .pen type ('frame' | 'text' | ...).
  typeCounts: Record<string, number>;
  /// <svg>/<path> elements skipped in v1.
  skippedSvg: number;
}

export interface HtmlToPenResult {
  nodes: PenChild[];
  stats: HtmlImportStats;
}

// ---- Whitelists -------------------------------------------------------------

const ALLOWED_TAGS = new Set([
  'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'img', 'svg', 'path', 'button', 'label',
  'input', 'textarea', 'form', 'a', 'section', 'header', 'footer',
  'nav', 'main', 'hr', 'br', 'strong', 'em',
]);

/// Elements whose entire subtree is dropped (content + tag).
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed']);

/// Elements that never have children in HTML. `<embed>` is void by spec —
/// it never has a closing tag, so it must not open a dropped subtree.
const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'embed']);

const ALLOWED_ATTRS = new Set([
  'style', 'src', 'alt', 'width', 'height', 'href', 'type', 'placeholder', 'value',
]);

// ---- Entity decoding --------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+;|#\d+;|[a-zA-Z][a-zA-Z0-9]*;)/g, (all, ent: string) => {
    const body = ent.slice(0, -1); // strip trailing ';'
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
      try {
        return String.fromCodePoint(code);
      } catch {
        return '';
      }
    }
    return NAMED_ENTITIES[body] ?? '';
  });
}

// ---- URL scheme whitelist ---------------------------------------------------

export function isSafeUrl(raw: string): boolean {
  const s = raw.trim().toLowerCase();
  // Control characters / embedded whitespace are classic javascript: obfuscation.
  if (/[\u0000-\u001f\u007f]/.test(s)) return false;
  if (s.startsWith('data:image/')) return true;
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/.exec(s);
  if (schemeMatch) {
    return schemeMatch[1] === 'http' || schemeMatch[1] === 'https';
  }
  // No scheme → relative URL (//, /, ./, ../, #, bare path) — safe.
  return true;
}

// ---- Tokenizer --------------------------------------------------------------

interface ParsedTag {
  name: string;
  attrs: Record<string, string>;
  selfClosing: boolean;
  end: number;
}

/// Parse a start tag beginning at `start` (html[start] === '<').
/// Returns null when the text does not form a tag (caller emits '<' as text).
function parseTagAt(html: string, start: number): ParsedTag | null {
  const n = html.length;
  let i = start + 1;
  if (i >= n || !/[a-zA-Z]/.test(html[i])) return null;
  let name = '';
  while (i < n && /[a-zA-Z0-9:_-]/.test(html[i])) {
    name += html[i];
    i++;
  }
  name = name.toLowerCase();
  const attrs: Record<string, string> = {};
  let selfClosing = false;
  while (i < n) {
    const ch = html[i];
    if (ch === '>') {
      i++;
      break;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '/') {
      // Only a trailing `/` right before `>` (or whitespace then `>`) means self-close.
      selfClosing = true;
      i++;
      continue;
    }
    // Attribute name: anything up to whitespace, '=', '/', '>'.
    let aname = '';
    while (i < n && !/[\s=/>]/.test(html[i])) {
      aname += html[i];
      i++;
    }
    // Skip whitespace before '='.
    while (i < n && /\s/.test(html[i])) i++;
    let aval = '';
    if (html[i] === '=') {
      i++;
      while (i < n && /\s/.test(html[i])) i++;
      const q = html[i];
      if (q === '"' || q === "'") {
        i++;
        const endQ = html.indexOf(q, i);
        aval = html.slice(i, endQ === -1 ? n : endQ);
        i = endQ === -1 ? n : endQ + 1;
      } else {
        // Unquoted value: up to whitespace or '>'.
        while (i < n && !/[\s>]/.test(html[i])) {
          aval += html[i];
          i++;
        }
      }
    }
    if (aname) attrs[aname.toLowerCase()] = decodeEntities(aval);
  }
  return { name, attrs, selfClosing, end: i };
}

function sanitizeAttrs(attrs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (!ALLOWED_ATTRS.has(k)) continue; // drops on*, class, id, data-*, srcset, formaction, …
    if ((k === 'href' || k === 'src') && !isSafeUrl(v)) continue;
    out[k] = v;
  }
  return out;
}

/// HTML5-style implicit closes: a new <li> closes an open <li>; a new block
/// element closes an open <p>. Keyed by the STARTING tag; the value lists the
/// stack-top tags it implicitly closes.
const AUTO_CLOSE_BEFORE: Record<string, string[]> = {
  li: ['li'],
  p: ['p'],
  div: ['p'],
  ul: ['p'],
  ol: ['p'],
  h1: ['p'], h2: ['p'], h3: ['p'], h4: ['p'], h5: ['p'], h6: ['p'],
  section: ['p'], header: ['p'], footer: ['p'], nav: ['p'], main: ['p'], form: ['p'],
};

/**
 * Parse an HTML fragment into a sanitized element tree.
 *
 * Top-level bare text runs are wrapped in synthetic `<span>` elements so the
 * return type stays `ImportedNode[]` while the text survives conversion
 * (htmlToPenTree maps span → text node).
 */
export function parseHtmlFragment(html: string): ImportedNode[] {
  const roots: ImportedNode[] = [];
  const stack: ImportedNode[] = [];
  // While non-empty we are inside a dropped subtree (script/style/iframe/…):
  // the stack tracks open tag NAMES so the matching close of the dropped
  // element ends the drop — even with (invalid) nested tags inside.
  const dropStack: string[] = [];
  // The synthetic span that collects top-level bare text (runs merge).
  let syntheticRoot: ImportedNode | null = null;
  const n = html.length;
  let i = 0;

  const appendText = (text: string) => {
    if (text === '') return;
    if (dropStack.length > 0) return; // inside a dropped subtree
    const parent = stack.length > 0 ? stack[stack.length - 1] : null;
    if (parent) {
      parent.children.push({ type: 'text', text });
    } else if (syntheticRoot) {
      // Merge with the previous top-level text run.
      syntheticRoot.children.push({ type: 'text', text });
    } else {
      // Text outside any element — kept as a synthetic span node.
      syntheticRoot = { tag: 'span', attrs: {}, children: [{ type: 'text', text }] };
      roots.push(syntheticRoot);
    }
  };

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      appendText(decodeEntities(html.slice(i)));
      break;
    }
    if (lt > i) appendText(decodeEntities(html.slice(i, lt)));
    // Comments dropped entirely.
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    // Doctype / CDATA / processing instruction dropped.
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = html.indexOf('>', lt);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (html[lt + 1] === '/') {
      // Closing tag.
      const gt = html.indexOf('>', lt);
      const rawName = html.slice(lt + 2, gt === -1 ? n : gt).trim().toLowerCase();
      i = gt === -1 ? n : gt + 1;
      if (dropStack.length > 0) {
        const name = /^[a-z][a-z0-9:_-]*/.exec(rawName)?.[0] ?? '';
        // Pop through the matching open tag; when the stack empties, the
        // dropped subtree is over.
        const idx = name ? dropStack.lastIndexOf(name) : -1;
        if (idx !== -1) dropStack.length = idx;
        continue;
      }
      const name = /^[a-z][a-z0-9:_-]*/.exec(rawName)?.[0] ?? '';
      if (!name) continue;
      const idx = stack.findIndex((node) => node.tag === name);
      if (idx !== -1) {
        // Auto-close anything left open above the matching tag.
        stack.length = idx;
      }
      // Stray close tags (no matching open) are ignored.
      continue;
    }
    const parsed = parseTagAt(html, lt);
    if (!parsed) {
      // Malformed '<' — emit as literal text.
      appendText('<');
      i = lt + 1;
      continue;
    }
    i = parsed.end;
    if (dropStack.length > 0) {
      if (!VOID_TAGS.has(parsed.name) && !parsed.selfClosing) dropStack.push(parsed.name);
      continue;
    }
    if (DROP_WITH_CONTENT.has(parsed.name)) {
      if (!VOID_TAGS.has(parsed.name) && !parsed.selfClosing) dropStack.push(parsed.name);
      continue;
    }
    if (!ALLOWED_TAGS.has(parsed.name)) {
      // Unknown tag: UNWRAP — children (text + elements) attach to the
      // current parent naturally; the closing tag finds no stack match and
      // is ignored.
      continue;
    }
    // HTML5-style implicit close (new <li> closes open <li>, new block closes
    // open <p>) so sibling lists/paragraphs don't nest into each other.
    if (stack.length > 0) {
      const top = stack[stack.length - 1].tag;
      if ((AUTO_CLOSE_BEFORE[parsed.name] ?? []).includes(top)) {
        stack.pop();
      }
    }
    const node: ImportedNode = {
      tag: parsed.name,
      attrs: sanitizeAttrs(parsed.attrs),
      children: [],
    };
    const parent = stack.length > 0 ? stack[stack.length - 1] : null;
    if (parent) parent.children.push({ type: 'element', el: node });
    else {
      roots.push(node);
      syntheticRoot = null;
    }
    if (!VOID_TAGS.has(parsed.name) && !parsed.selfClosing) stack.push(node);
  }
  // Anything still open auto-closes at end of input (stack discarded).
  return roots;
}

// ---- Style helpers ----------------------------------------------------------

function parseStyle(style: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!style) return out;
  for (const decl of style.split(';')) {
    const idx = decl.indexOf(':');
    if (idx === -1) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const val = decl.slice(idx + 1).trim();
    if (prop && val) out[prop] = val;
  }
  return out;
}

function pxNum(v: string | undefined, def: number): number {
  if (v === undefined) return def;
  const m = /^(-?[\d.]+)px$/.exec(v.trim()) ?? /^(-?[\d.]+)$/.exec(v.trim());
  if (!m) return def;
  const num = Number(m[1]);
  return Number.isFinite(num) ? num : def;
}

/// Is this a plain color value (hex / rgb / hsl / named)? Gradients and
/// url() backgrounds are NOT supported in v1.
function isPlainColor(v: string | undefined): v is string {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  if (s === '' || s === 'none' || s === 'inherit' || s === 'initial') return false;
  if (s.includes('gradient') || s.includes('url(') || s.includes('var(')) return false;
  return true;
}

/// Padding: "8px" | "8px 16px" | "1px 2px 3px 4px" → .pen padding value.
function parsePadding(v: string | undefined): number | [number, number, number, number] | undefined {
  if (!v) return undefined;
  const parts = v.trim().split(/\s+/).map((p) => pxNum(p, NaN));
  if (parts.some((p) => !Number.isFinite(p))) return undefined;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return [parts[0], parts[1], parts[0], parts[1]];
  if (parts.length >= 4) return [parts[0], parts[1], parts[2], parts[3]];
  return undefined;
}

/// box-shadow: `Xpx Ypx Bpx [Spx] color [inset]` — best-effort regex.
/// Units are optional on the offsets ("0 4px 6px" is common).
function parseBoxShadow(v: string | undefined):
  | { type: 'shadow'; shadowType: 'inner' | 'outer'; offset: { x: number; y: number }; blur: number; spread: number; color: string }
  | undefined {
  if (!v || v === 'none') return undefined;
  const s = v.trim().replace(/\s+/g, ' ');
  const inset = /\binset\b/.test(s);
  const m = /(-?[\d.]+)(?:px)?\s+(-?[\d.]+)(?:px)?\s+(-?[\d.]+)(?:px)?(?:\s+(-?[\d.]+)(?:px)?)?\s+(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|[a-z]+)/.exec(s);
  if (!m) return undefined;
  return {
    type: 'shadow' as const,
    shadowType: inset ? ('inner' as const) : ('outer' as const),
    offset: { x: Number(m[1]) || 0, y: Number(m[2]) || 0 },
    blur: Number(m[3]) || 0,
    spread: m[4] !== undefined ? Number(m[4]) || 0 : 0,
    color: m[5],
  };
}

const JUSTIFY_MAP: Record<string, 'start' | 'center' | 'end' | 'space_between' | 'space_around'> = {
  'flex-start': 'start', start: 'start', left: 'start',
  center: 'center',
  'flex-end': 'end', end: 'end', right: 'end',
  'space-between': 'space_between',
  'space-around': 'space_around',
};

const ALIGN_MAP: Record<string, 'start' | 'center' | 'end'> = {
  'flex-start': 'start', start: 'start', stretch: 'start', baseline: 'start',
  center: 'center',
  'flex-end': 'end', end: 'end',
};

// ---- Converter: ImportedNode tree → .pen PenChild tree ----------------------

const CONTAINER_TAGS = new Set(['div', 'section', 'header', 'footer', 'nav', 'main', 'form']);

const HEADING_DEFAULTS: Record<string, { fontSize: number; fontWeight: number }> = {
  h1: { fontSize: 32, fontWeight: 600 },
  h2: { fontSize: 24, fontWeight: 600 },
  h3: { fontSize: 20, fontWeight: 600 },
  h4: { fontSize: 18, fontWeight: 600 },
  h5: { fontSize: 16, fontWeight: 400 },
  h6: { fontSize: 14, fontWeight: 400 },
};

function slugify(text: string): string {
  return text
    .slice(0, 24)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function nodeName(prefix: string, tag: string, text?: string): string {
  const slug = text ? slugify(text) : '';
  return slug ? `${prefix}-${tag}-${slug}` : `${prefix}-${tag}`;
}

/// Concatenate all descendant text of an element; <br> contributes '\n'.
function collectText(children: ImportedChild[]): string {
  let out = '';
  for (const c of children) {
    if (c.type === 'text') out += c.text;
    else if (c.el.tag === 'br') out += '\n';
    else out += collectText(c.el.children);
  }
  return out;
}

function hasElementChildren(children: ImportedChild[]): boolean {
  return children.some((c) => c.type === 'element' && c.el.tag !== 'br');
}

/// Estimate a text node's box: server cannot measure text, so width is a
/// character-count heuristic (clamped, wrapping beyond 480px) and height is
/// lines × fontSize × 1.4. Auto-layout does real placement of containers.
function estimateTextSize(text: string, fontSize: number): { width: number; height: number } {
  const lines = text.split('\n');
  const longest = lines.reduce((acc, l) => Math.max(acc, l.length), 0);
  const natural = Math.round(longest * fontSize * 0.6) || fontSize;
  const width = Math.min(480, Math.max(40, natural));
  const lineCount = lines.reduce((acc, l) => acc + Math.max(1, Math.ceil((l.length * fontSize * 0.6) / width)), 0);
  const height = Math.max(Math.round(fontSize * 1.4), Math.round(lineCount * fontSize * 1.4));
  return { width, height };
}

interface FrameStyleResult {
  fill?: string;
  cornerRadius?: number;
  stroke?: string;
  strokeWidth?: number;
  effect?: Record<string, unknown>;
  opacity?: number;
  width?: number | 'fit_content';
  height?: number | 'fit_content';
}

/// Extract .pen visual fields from a parsed inline style map.
function frameStyle(style: Record<string, string>): FrameStyleResult {
  const out: FrameStyleResult = {};
  const bg = style['background-color'] ?? style['background'];
  if (isPlainColor(bg)) out.fill = bg!.trim();
  const br = style['border-radius'];
  if (br) {
    if (br.trim().endsWith('%')) out.cornerRadius = 9999; // '50%' → pill/round
    else out.cornerRadius = pxNum(br, 0);
  }
  // border: <width>px <style> <color> | border-width + border-color
  const border = style['border'] ?? style['border-top'];
  if (border && border !== 'none') {
    const m = /^(\d+)px\s+(?:\w+\s+)?(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|[a-z]+)$/.exec(border.trim());
    if (m) {
      out.strokeWidth = Number(m[1]) || 1;
      out.stroke = m[2];
    }
  }
  if (out.stroke === undefined) {
    const bw = style['border-width'];
    const bc = style['border-color'];
    if (bw || bc) {
      out.strokeWidth = bw ? pxNum(bw, 1) : 1;
      out.stroke = isPlainColor(bc) ? bc!.trim() : '#e2e8f0';
    }
  }
  const shadow = parseBoxShadow(style['box-shadow']);
  if (shadow) out.effect = shadow as unknown as Record<string, unknown>;
  if (style['opacity'] !== undefined) {
    const op = Number(style['opacity']);
    if (Number.isFinite(op)) out.opacity = Math.max(0, Math.min(1, op));
  }
  const w = style['width'];
  if (w && /^\d+(\.\d+)?px$/.test(w.trim())) out.width = pxNum(w, 100);
  const h = style['height'];
  if (h && /^\d+(\.\d+)?px$/.test(h.trim())) out.height = pxNum(h, 100);
  return out;
}

/// Flex layout fields from a parsed inline style map.
function flexLayout(style: Record<string, string>): {
  layout: 'horizontal' | 'vertical';
  gap?: number;
  padding?: number | [number, number, number, number];
  justifyContent?: 'start' | 'center' | 'end' | 'space_between' | 'space_around';
  alignItems?: 'start' | 'center' | 'end';
} | null {
  if (style['display'] !== 'flex') return null;
  const dir = (style['flex-direction'] ?? 'row').startsWith('column') ? 'vertical' : 'horizontal';
  const gapRaw = style['gap'] ?? style['row-gap'] ?? style['column-gap'];
  const gap = gapRaw ? pxNum(gapRaw, 0) : 0;
  const pad = parsePadding(style['padding']);
  const justify = JUSTIFY_MAP[style['justify-content'] ?? 'flex-start'] ?? 'start';
  const align = ALIGN_MAP[style['align-items'] ?? 'flex-start'] ?? 'start';
  return {
    layout: dir,
    gap: gap > 0 ? gap : undefined,
    padding: pad,
    justifyContent: justify !== 'start' ? justify : undefined,
    alignItems: align !== 'start' ? align : undefined,
  };
}

/**
 * Convert a sanitized ImportedNode tree into .pen PenChild nodes.
 * See the module header for the mapping table and v1 limitations.
 */
export function htmlToPenTreeDetailed(
  fragment: ImportedNode[],
  opts: { namePrefix?: string } = {},
): HtmlToPenResult {
  const prefix = opts.namePrefix?.trim() || 'html';
  const stats: HtmlImportStats = { nodeCount: 0, typeCounts: {}, skippedSvg: 0 };
  const bump = (type: string) => {
    stats.nodeCount++;
    stats.typeCounts[type] = (stats.typeCounts[type] ?? 0) + 1;
  };

  const convert = (el: ImportedNode): PenChild[] => {
    const style = parseStyle(el.attrs.style);

    // svg/path → skipped in v1 (counted, subtree dropped).
    if (el.tag === 'svg' || el.tag === 'path') {
      stats.skippedSvg++;
      return [];
    }

    // img → image-fill node.
    if (el.tag === 'img') {
      const src = el.attrs.src;
      const w = pxNum(el.attrs.width ?? style['width'], 0) || 100;
      const h = pxNum(el.attrs.height ?? style['height'], 0) || 100;
      const alt = el.attrs.alt;
      const node: PenChild = {
        id: crypto.randomUUID(),
        type: 'rectangle',
        name: nodeName(prefix, 'img', alt),
        x: 0,
        y: 0,
        width: w,
        height: h,
        ...(src ? { fill: { type: 'image', url: src, mode: 'fill' } as const } : {}),
      };
      bump('rectangle');
      return [node];
    }

    // input → rectangle (placeholder text intentionally skipped in v1).
    if (el.tag === 'input') {
      const node: PenChild = {
        id: crypto.randomUUID(),
        type: 'rectangle',
        name: nodeName(prefix, 'input', el.attrs.placeholder || el.attrs.value),
        x: 0,
        y: 0,
        width: (frameStyle(style).width as number) ?? 200,
        height: 36,
        cornerRadius: 6,
        fill: '#ffffff',
        stroke: '#cbd5e1',
        strokeWidth: 1,
      };
      bump('rectangle');
      return [node];
    }

    // hr → line (PenLine: x2/y2 endpoint + width/height for the resolver).
    if (el.tag === 'hr') {
      const fs = frameStyle(style);
      const w = (fs.width as number) ?? 100;
      const color = fs.stroke ?? '#cbd5e1';
      const node = {
        id: crypto.randomUUID(),
        type: 'line' as const,
        name: nodeName(prefix, 'hr'),
        x: 0,
        y: 0,
        width: w,
        height: 0,
        x2: w,
        y2: 0,
        stroke: color,
        strokeWidth: fs.strokeWidth ?? 1,
      };
      bump('line');
      return [node];
    }

    // Text-bearing tags → text node.
    const isHeading = HEADING_DEFAULTS[el.tag] !== undefined;
    const isTextTag = isHeading || ['p', 'span', 'strong', 'em', 'label', 'a', 'button', 'textarea'].includes(el.tag);
    const liTextOnly = el.tag === 'li' && !hasElementChildren(el.children);
    if (isTextTag || liTextOnly) {
      const text = collectText(el.children).trim();
      const heading = HEADING_DEFAULTS[el.tag] ?? { fontSize: 16, fontWeight: 400 };
      let fontSize = heading.fontSize;
      let fontWeight = el.tag === 'button' ? 500 : heading.fontWeight;
      let fontStyle: string | undefined;
      let color: string | undefined;
      let lineHeight: number | undefined;
      let letterSpacing: number | undefined;
      let textAlign: 'left' | 'center' | 'right' | 'justify' | undefined;
      if (el.tag === 'strong') fontWeight = 700;
      if (el.tag === 'em') fontStyle = 'italic';
      if (style['font-size']) {
        const fs = pxNum(style['font-size'], fontSize);
        if (fs > 0) fontSize = fs;
      }
      if (style['font-weight']) {
        const fw = /^(\d{3})$/.exec(style['font-weight'].trim());
        if (fw) fontWeight = Number(fw[1]);
        else if (style['font-weight'] === 'bold') fontWeight = 700;
        else if (style['font-weight'] === 'normal') fontWeight = 400;
      }
      if (isPlainColor(style['color'])) color = style['color']!.trim();
      if (style['line-height']) {
        const lh = style['line-height'].trim();
        const mult = /^[\d.]+$/.test(lh) ? Number(lh) : pxNum(lh, NaN) / fontSize;
        if (Number.isFinite(mult) && mult > 0) lineHeight = Math.round(mult * 100) / 100;
      }
      if (style['letter-spacing']) letterSpacing = pxNum(style['letter-spacing'], 0);
      if (style['text-align'] === 'center') textAlign = 'center';
      else if (style['text-align'] === 'right') textAlign = 'right';
      else if (style['text-align'] === 'justify') textAlign = 'justify';
      const { width, height } = estimateTextSize(text, fontSize);
      const node: PenChild = {
        id: crypto.randomUUID(),
        type: 'text',
        name: nodeName(prefix, el.tag, text),
        x: 0,
        y: 0,
        width,
        height,
        content: text,
        fontSize,
        // .pen fontWeight is a string ("600"); the resolver coerces via num().
        fontWeight: String(fontWeight),
        ...(fontStyle ? { fontStyle } : {}),
        ...(color ? { fill: color } : {}), // .pen text nodes store color in `fill`
        ...(lineHeight !== undefined ? { lineHeight } : {}),
        ...(letterSpacing !== undefined ? { letterSpacing } : {}),
        ...(textAlign ? { textAlign } : {}),
        textGrowth: 'fixed-width',
      };
      bump('text');
      return [node];
    }

    // Containers (div/section/header/footer/nav/main/form/ul/ol/li).
    // frame + optional flex layout fields.
    const fs = frameStyle(style);
    const flex = flexLayout(style);
    const children: PenChild[] = [];
    for (const c of el.children) {
      if (c.type === 'text') {
        // Bare text inside a container → child text node.
        const trimmed = c.text.trim();
        if (trimmed === '') continue;
        const size = estimateTextSize(trimmed, 16);
        children.push({
          id: crypto.randomUUID(),
          type: 'text',
          name: nodeName(prefix, 'text', trimmed),
          x: 0,
          y: 0,
          ...size,
          content: trimmed,
          fontSize: 16,
          fontWeight: '400',
          textGrowth: 'fixed-width',
        });
      } else {
        children.push(...convert(c.el));
      }
    }

    let layout: 'horizontal' | 'vertical' | undefined;
    let gap: number | undefined;
    let padding: number | [number, number, number, number] | undefined;
    let justifyContent: 'start' | 'center' | 'end' | 'space_between' | 'space_around' | undefined;
    let alignItems: 'start' | 'center' | 'end' | undefined;
    if (el.tag === 'ul' || el.tag === 'ol') {
      layout = 'vertical';
      gap = pxNum(style['gap'] ?? style['row-gap'], 8) || 8;
      padding = parsePadding(style['padding']) ?? 8;
    } else if (flex) {
      layout = flex.layout;
      gap = flex.gap;
      justifyContent = flex.justifyContent;
      alignItems = flex.alignItems;
    } else if (el.tag === 'li') {
      layout = 'vertical';
      gap = 4;
    }
    // Padding applies to ANY container (flex or not) — .pen frames carry it
    // independently of the layout mode.
    if (padding === undefined) padding = parsePadding(style['padding']);

    // Sizing: explicit style px wins; else fit_content when the frame has
    // children (auto-layout / bbox computes the real size).
    const width = (fs.width as number | undefined) ?? (children.length > 0 ? ('fit_content' as const) : undefined);
    const height = (fs.height as number | undefined) ?? (children.length > 0 ? ('fit_content' as const) : undefined);

    const node: PenChild = {
      id: crypto.randomUUID(),
      type: 'frame',
      name: nodeName(prefix, el.tag, collectText(el.children).trim() || undefined),
      x: 0,
      y: 0,
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(fs.fill ? { fill: fs.fill } : {}),
      ...(fs.cornerRadius ? { cornerRadius: fs.cornerRadius } : {}),
      ...(fs.stroke ? { stroke: fs.stroke, strokeWidth: fs.strokeWidth ?? 1 } : {}),
      ...(fs.effect ? { effect: fs.effect as any } : {}),
      ...(fs.opacity !== undefined ? { opacity: fs.opacity } : {}),
      ...(layout ? { layout } : {}),
      ...(gap !== undefined ? { gap } : {}),
      ...(padding !== undefined ? { padding } : {}),
      ...(justifyContent ? { justifyContent } : {}),
      ...(alignItems ? { alignItems } : {}),
      ...(children.length > 0 ? { children } : {}),
    };
    bump('frame');
    return [node];
  };

  const nodes = fragment.flatMap((el) => convert(el));
  return { nodes, stats };
}

/// Convenience wrapper returning just the .pen nodes.
export function htmlToPenTree(
  fragment: ImportedNode[],
  opts: { namePrefix?: string } = {},
): PenChild[] {
  return htmlToPenTreeDetailed(fragment, opts).nodes;
}
