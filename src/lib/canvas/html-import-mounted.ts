// Phase 3 v2 — mounted-iframe HTML import (spec §5.2 v2 path).
//
// The v1 path (`html-import.ts`) is server-side, inline-style-only: a strict
// hand-rolled recursive-descent tokenizer parses a whitelisted HTML subset. It
// cannot see class-based CSS or computed cascade values, so pasted web pages
// come in flat and unstyled.
//
// The v2 path mounts the HTML in a hidden sandboxed `<iframe>` IN THE
// BROWSER, lets the browser's HTML+CSS parser + layout engine do its job,
// then walks the resulting DOM tree reading `getComputedStyle` (real cascade
// resolution, real box model) and `getBoundingClientRect` (real measured
// geometry). The extracted .pen tree carries full fidelity: real positions,
// real sizes, real colors, real borders, real shadows.
//
// SECURITY (spec §5.2 / R5):
//   The iframe is mounted with `sandbox="allow-same-origin"` and NO
//   `allow-scripts` token. We need same-origin access to read the iframe's
//   contentDocument + computed styles, but WITHOUT `allow-scripts` the
//   browser refuses to execute ANY script inside the iframe — so any
//   `<script>`/on*-handler content embedded in the imported HTML cannot
//   run. The extraction is read-only: we walk the parsed DOM tree and read
//   computed styles; we never execute or persist script content.
//
// ARCHITECTURE:
//   - `walkDomForPenTree(root, warnings)` is a PURE function: takes a real
//     DOM tree (jsdom can simulate one) and returns the .pen subtree. Tests
//     exercise this directly with constructed DOMs.
//   - `extractHtmlViaIframe(html, opts)` is the browser-only entry point: it
//     creates + writes the iframe, waits for layout, and delegates the walk
//     to `walkDomForPenTree`. Guarded by `typeof window !== 'undefined'`.
//
// CLIENT→SERVER WIRING (TODO, future iteration):
//   The agent-side `pen_insert_html` tool cannot mount iframes (it runs
//   server-side); only the browser can. The intended round-trip — emit a
//   `agent:extract_html_request` via `client-roundtrip.ts`, the connected
//   client calls `extractHtmlViaIframe(html)`, POSTs the extracted tree back
//   to `/api/agent/client-responses`, the tool converts the tree to a
//   `bulk_add` patch — is left as a documented TODO. v2 mode in the tool
//   currently falls back to the v1 server-side path with an explicit note.
//   The extraction module + tests land now so the wiring is the only
//   remaining piece.

import type {
  PenChild,
  PenFrame,
  PenText,
  PenRectangle,
} from '../pen/types';

// ---- Public types ---------------------------------------------------------

/** Parsed form of the computed-style fields the extractor reads. */
export interface ComputedStyleExtract {
  /** Cascade-resolved `display`. */
  display: string;
  /** Cascade-resolved `position` (static/relative/absolute/fixed/sticky). */
  position: string;
  /** Inline left/top when absolute/fixed/relative; undefined otherwise. */
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
  /** Computed width/height (px), when present. */
  width?: number;
  height?: number;
  /** Margins (parsed to px numbers). */
  marginTop?: number;
  marginRight?: number;
  marginBottom?: number;
  marginLeft?: number;
  /** Foreground color → .pen text fill. */
  color?: string;
  /** Background color → .pen frame/rectangle fill. */
  backgroundColor?: string;
  /** Typography fields (text-bearing tags only). */
  fontSize?: number;
  fontWeight?: string;
  fontFamily?: string;
  textAlign?: 'left' | 'center' | 'right' | 'justify';
  /** Border → .pen stroke. */
  borderWidth?: number;
  borderColor?: string;
  /** Parsed border-radius (scalar or 4-tuple [TL, TR, BR, BL]). */
  borderRadius?: number | [number, number, number, number];
  /** Parsed box-shadow (first shadow only; v2 best-effort). */
  boxShadow?: {
    type: 'shadow';
    shadowType: 'inner' | 'outer';
    offset: { x: number; y: number };
    blur: number;
    spread: number;
    color: string;
  };
  opacity?: number;
  visibility?: string;
}

/** Result of an iframe-extraction pass. */
export interface ExtractedPenTree {
  children: PenChild[];
  warnings: string[];
}

// ---- Caps (perf + cycle protection) --------------------------------------

const MAX_DEPTH = 20;
const MAX_NODES = 500;

// ---- Tag → .pen node type table ------------------------------------------

const FRAME_TAGS = new Set([
  'div', 'section', 'header', 'footer', 'nav', 'main',
  'ul', 'ol', 'li', 'form', 'button',
]);

const TEXT_TAGS = new Set([
  'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'em', 'label', 'textarea',
]);

const HEADING_FONT = {
  h1: { fontSize: 32, fontWeight: '700' },
  h2: { fontSize: 24, fontWeight: '700' },
  h3: { fontSize: 20, fontWeight: '600' },
  h4: { fontSize: 18, fontWeight: '600' },
  h5: { fontSize: 16, fontWeight: '500' },
  h6: { fontSize: 14, fontWeight: '500' },
} as const;

// ---- Pure helpers (exported for testing) ---------------------------------

/** Parse a CSS px value ("10px" / "10" / "1.5em") into a number. Returns
 *  `def` when the value is not a finite number. */
export function pxToNum(v: string | undefined | null, def: number): number {
  if (v === undefined || v === null) return def;
  const s = String(v).trim();
  if (s === '' || s === 'auto' || s === 'none' || s === 'initial' || s === 'inherit') return def;
  const m = /^(-?[\d.]+)\s*(px|em|rem|%)?$/.exec(s);
  if (!m) return def;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : def;
}

/** Is this a plain color value (hex / rgb / rgba / named)? Gradients,
 *  url() backgrounds, var() refs, and zero-alpha rgba()/hsla() (effectively
 *  transparent — not a meaningful fill) are NOT plain colors. */
export function isPlainColor(v: string | undefined | null): v is string {
  if (!v) return false;
  const s = String(v).trim().toLowerCase();
  if (s === '' || s === 'none' || s === 'inherit' || s === 'initial' || s === 'transparent') return false;
  if (s.includes('gradient') || s.includes('url(') || s.includes('var(')) return false;
  // Reject zero-alpha rgba()/hsla() — they're transparent, not a real fill.
  // Three comma-separated tokens required before the alpha, so this matches
  // rgba(0,0,0,0) but NOT rgb(0,0,0) (solid black has no alpha component).
  if (/^rgba?\([^,)]+,[^,)]+,[^,)]+,\s*0+(?:\.0+)?\s*\)$/.test(s)) return false;
  if (/^hsla?\([^,)]+,[^,)]+,[^,)]+,\s*0+(?:\.0+)?\s*\)$/.test(s)) return false;
  return true;
}

/** Parse a `border-radius` shorthand:
 *   "8px" → 8 (scalar, all corners equal)
 *   "8px 4px" → [8, 4, 8, 4] (TL+BR, TR+BL)
 *   "8px 4px 2px 1px" → [8, 4, 2, 1] (TL, TR, BR, BL)
 *   "50%" → 9999 (pill/round convention from v1)
 * Returns undefined when unparseable. */
export function parseBorderRadius(
  v: string | undefined | null,
): number | [number, number, number, number] | undefined {
  if (!v) return undefined;
  const s = String(v).trim();
  if (s === '') return undefined;
  if (s.endsWith('%')) return 9999; // pill/round
  const parts = s.split(/\s+/).map((p) => pxToNum(p, NaN));
  if (parts.some((p) => !Number.isFinite(p))) return undefined;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return [parts[0], parts[1], parts[0], parts[1]];
  if (parts.length === 3) return [parts[0], parts[1], parts[2], parts[1]];
  if (parts.length >= 4) return [parts[0], parts[1], parts[2], parts[3]];
  return undefined;
}

/** Parse a `box-shadow` value into a single shadow object:
 *   `offset-x offset-y blur [spread] color [inset]`
 * Returns undefined for `none` / unparseable. */
export function parseBoxShadow(
  v: string | undefined | null,
): ComputedStyleExtract['boxShadow'] | undefined {
  if (!v) return undefined;
  const s = String(v).trim();
  if (s === '' || s === 'none') return undefined;
  const collapsed = s.replace(/\s+/g, ' ');
  const inset = /\binset\b/.test(collapsed);
  const m = /(-?[\d.]+)(?:px)?\s+(-?[\d.]+)(?:px)?\s+(-?[\d.]+)(?:px)?(?:\s+(-?[\d.]+)(?:px)?)?\s+(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|[a-z]+)/.exec(collapsed);
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

/** Read the resolved computed style for an element. Returns a normalized
 *  ComputedStyleExtract; never throws (jsdom's getComputedStyle is always
 *  defined). */
export function extractComputedStyle(
  el: HTMLElement,
  cs: CSSStyleDeclaration,
): ComputedStyleExtract {
  const display = String(cs.display || 'block');
  const position = String(cs.position || 'static');
  const visibility = String(cs.visibility || 'visible');
  const out: ComputedStyleExtract = { display, position, visibility };

  if (position === 'absolute' || position === 'fixed' || position === 'relative') {
    const l = pxToNum(cs.left, NaN);
    const t = pxToNum(cs.top, NaN);
    if (Number.isFinite(l)) out.left = l;
    if (Number.isFinite(t)) out.top = t;
    const r = pxToNum(cs.right, NaN);
    const b = pxToNum(cs.bottom, NaN);
    if (Number.isFinite(r)) out.right = r;
    if (Number.isFinite(b)) out.bottom = b;
  }

  // Prefer measured geometry; fall back to computed px string when jsdom
  // returns a zero rect (no layout in jsdom).
  const rect = el.getBoundingClientRect();
  if (rect.width > 0) out.width = rect.width;
  else {
    const w = pxToNum(cs.width, NaN);
    if (Number.isFinite(w) && w > 0) out.width = w;
  }
  if (rect.height > 0) out.height = rect.height;
  else {
    const h = pxToNum(cs.height, NaN);
    if (Number.isFinite(h) && h > 0) out.height = h;
  }

  const mt = pxToNum(cs.marginTop, NaN);
  const mr = pxToNum(cs.marginRight, NaN);
  const mb = pxToNum(cs.marginBottom, NaN);
  const ml = pxToNum(cs.marginLeft, NaN);
  if (Number.isFinite(mt)) out.marginTop = mt;
  if (Number.isFinite(mr)) out.marginRight = mr;
  if (Number.isFinite(mb)) out.marginBottom = mb;
  if (Number.isFinite(ml)) out.marginLeft = ml;

  const bg = cs.backgroundColor;
  if (isPlainColor(bg)) out.backgroundColor = String(bg).trim();
  const color = cs.color;
  if (isPlainColor(color)) out.color = String(color).trim();

  const fs = pxToNum(cs.fontSize, NaN);
  if (Number.isFinite(fs) && fs > 0) out.fontSize = fs;
  const fw = String(cs.fontWeight || '').trim();
  if (fw !== '' && fw !== 'normal') out.fontWeight = fw;
  const ff = String(cs.fontFamily || '').trim();
  if (ff !== '') out.fontFamily = ff;
  const ta = String(cs.textAlign || '').trim().toLowerCase();
  if (ta === 'left' || ta === 'center' || ta === 'right' || ta === 'justify') {
    out.textAlign = ta;
  }

  const bw = pxToNum(cs.borderTopWidth ?? cs.borderWidth, NaN);
  if (Number.isFinite(bw) && bw > 0) out.borderWidth = bw;
  const bc = cs.borderTopColor ?? cs.borderColor;
  if (isPlainColor(bc)) out.borderColor = String(bc).trim();

  const br = parseBorderRadius(cs.borderRadius);
  if (br !== undefined) out.borderRadius = br;

  const bs = parseBoxShadow(cs.boxShadow);
  if (bs) out.boxShadow = bs;

  const opStr = String(cs.opacity || '').trim();
  if (opStr !== '' && opStr !== '1') {
    const op = Number(opStr);
    if (Number.isFinite(op)) out.opacity = Math.max(0, Math.min(1, op));
  }

  return out;
}

// ---- Position resolution --------------------------------------------------

/** Compute the (x, y) of an element relative to the walk root (typically
 *  the iframe body). For absolutely-positioned elements we use the explicit
 *  left/top; for static/relative elements we use getBoundingClientRect
 *  offset by the root's rect (real browser geometry). jsdom returns zeros
 *  for both, so static elements get (0, 0) — tests use absolute positioning
 *  for explicit-coordinate assertions. */
function resolvePosition(
  el: HTMLElement,
  root: HTMLElement,
  cs: ComputedStyleExtract,
): { x: number; y: number } {
  if (cs.position === 'absolute' || cs.position === 'fixed' || cs.position === 'relative') {
    return { x: cs.left ?? 0, y: cs.top ?? 0 };
  }
  const r = el.getBoundingClientRect();
  const rootR = root.getBoundingClientRect();
  return { x: Math.round(r.left - rootR.left), y: Math.round(r.top - rootR.top) };
}

// ---- Tree walker ---------------------------------------------------------

interface WalkState {
  warnings: string[];
  nodeCount: number;
  prefix: string;
  /** Set once the node-count cap fires; suppresses duplicate warnings. */
  nodeCapHit: boolean;
}

function newId(): string {
  // crypto.randomUUID is available in modern browsers + Node 19+; jsdom's
  // tests/setup.ts polyfills it for older runtimes.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `node-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

function slugify(text: string): string {
  return text.slice(0, 24).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function makeName(prefix: string, tag: string, text?: string): string {
  const slug = text ? slugify(text) : '';
  return slug ? `${prefix}-${tag}-${slug}` : `${prefix}-${tag}`;
}

/// Collect all descendant text of an element, joined.
function collectText(el: HTMLElement): string {
  let out = '';
  for (let i = 0; i < el.childNodes.length; i++) {
    const n = el.childNodes[i];
    if (n.nodeType === 3 /* Node.TEXT_NODE */) {
      out += n.nodeValue ?? '';
    } else if (n.nodeType === 1 /* Node.ELEMENT_NODE */) {
      const childTag = (n as HTMLElement).tagName.toLowerCase();
      if (childTag === 'br') out += '\n';
      else out += collectText(n as HTMLElement);
    }
  }
  return out;
}

function hasElementChildren(el: HTMLElement): boolean {
  for (let i = 0; i < el.children.length; i++) {
    const childTag = el.children[i].tagName.toLowerCase();
    if (childTag !== 'br') return true;
  }
  return false;
}

/// Apply a ComputedStyleExtract to a base node (frame/rectangle/text):
/// fill, stroke, cornerRadius, effect, opacity, padding-from-margins.
/// Never overwrites a fill already set by the caller (img tags set an
/// image fill first — background-color must not clobber it).
function applyStyleFields(
  target: {
    fill?: unknown;
    stroke?: unknown;
    strokeWidth?: unknown;
    cornerRadius?: unknown;
    effect?: unknown;
    opacity?: unknown;
    padding?: unknown;
  },
  cs: ComputedStyleExtract,
): void {
  if (cs.backgroundColor && target.fill === undefined) target.fill = cs.backgroundColor;
  if (cs.borderWidth && cs.borderColor) {
    target.stroke = cs.borderColor;
    target.strokeWidth = cs.borderWidth;
  }
  if (cs.borderRadius !== undefined) target.cornerRadius = cs.borderRadius;
  if (cs.boxShadow) target.effect = cs.boxShadow as unknown;
  if (cs.opacity !== undefined) target.opacity = cs.opacity;
  // Margins become padding (v2 best-effort: the .pen model has no margin;
  // container padding already captures parent→child spacing).
  const mt = cs.marginTop ?? 0;
  const mr = cs.marginRight ?? 0;
  const mb = cs.marginBottom ?? 0;
  const ml = cs.marginLeft ?? 0;
  if (mt || mr || mb || ml) {
    if (mt === mr && mr === mb && mb === ml) target.padding = mt;
    else target.padding = [mt, mr, mb, ml];
  }
}

/// Build a .pen text node from a text-bearing element.
function buildTextNode(
  el: HTMLElement,
  cs: ComputedStyleExtract,
  prefix: string,
  tag: string,
): PenText {
  const text = collectText(el).trim();
  const heading = HEADING_FONT[tag as keyof typeof HEADING_FONT];
  const fontSize = cs.fontSize ?? heading?.fontSize ?? 16;
  const fontWeight = cs.fontWeight ?? heading?.fontWeight ?? '400';
  const node: PenText = {
    id: newId(),
    type: 'text',
    name: makeName(prefix, tag, text),
    x: 0,
    y: 0,
    width: cs.width ?? 100,
    height: cs.height ?? Math.max(20, Math.round(fontSize * 1.4)),
    content: text,
    fontSize,
    fontWeight,
    textGrowth: 'fixed-width',
  };
  if (cs.color) node.fill = cs.color;
  if (cs.fontFamily) node.fontFamily = cs.fontFamily;
  if (cs.textAlign) node.textAlign = cs.textAlign;
  if (cs.opacity !== undefined) node.opacity = cs.opacity;
  return node;
}

/// Build a .pen rectangle with image fill (img tag).
function buildImageNode(
  el: HTMLElement,
  cs: ComputedStyleExtract,
  prefix: string,
): PenRectangle {
  const src = el.getAttribute('src') ?? undefined;
  const alt = el.getAttribute('alt') ?? undefined;
  const node: PenRectangle = {
    id: newId(),
    type: 'rectangle',
    name: makeName(prefix, 'img', alt),
    x: 0,
    y: 0,
    width: cs.width ?? 100,
    height: cs.height ?? 100,
    ...(src ? { fill: { type: 'image', url: src, mode: 'fill' as const } } : {}),
  };
  applyStyleFields(node, cs);
  return node;
}

/// Build a .pen frame (container) with style fields + children.
function buildFrameNode(
  cs: ComputedStyleExtract,
  children: PenChild[],
  prefix: string,
  tag: string,
  text?: string,
): PenFrame {
  const node: PenFrame = {
    id: newId(),
    type: 'frame',
    name: makeName(prefix, tag, text),
    x: 0,
    y: 0,
    ...(cs.width !== undefined ? { width: cs.width } : {}),
    ...(cs.height !== undefined ? { height: cs.height } : {}),
    ...(children.length > 0 ? { children } : {}),
  };
  applyStyleFields(node, cs);
  return node;
}

/// Process a single element into 0+ .pen nodes. `depth` is the depth of
/// `el` in the .pen tree being built (root's children = depth 1). Returns:
///   - 1 node for known tags (frame/text/image)
///   - 0 nodes + N hoisted grandchildren for unknown tags (UNWRAP)
///   - 0 nodes for display:none / visibility:hidden (subtree dropped)
function processElement(
  el: HTMLElement,
  depth: number,
  state: WalkState,
  root: HTMLElement,
): PenChild[] {
  // Node-count cap: checked here so we never build a node beyond the cap.
  // The duplicate-warning guard keeps the warning list at one entry.
  if (state.nodeCount >= MAX_NODES) {
    if (!state.nodeCapHit) {
      state.warnings.push(`Node count cap (${MAX_NODES}) hit; remaining siblings skipped.`);
      state.nodeCapHit = true;
    }
    return [];
  }

  const cs = extractComputedStyle(el, window.getComputedStyle(el));

  if (cs.display === 'none') {
    state.warnings.push(`<${el.tagName.toLowerCase()}> skipped (display:none).`);
    return [];
  }
  if (cs.visibility === 'hidden') {
    state.warnings.push(`<${el.tagName.toLowerCase()}> skipped (visibility:hidden).`);
    return [];
  }

  const tag = el.tagName.toLowerCase();

  // img → image-fill rectangle.
  if (tag === 'img') {
    state.nodeCount++;
    return [buildImageNode(el, cs, state.prefix)];
  }

  // input/textarea → text node carrying the placeholder.
  if (tag === 'input' || tag === 'textarea') {
    const placeholder = el.getAttribute('placeholder') ?? '';
    const value = el.getAttribute('value') ?? '';
    const text = placeholder || value;
    const node: PenText = {
      id: newId(),
      type: 'text',
      name: makeName(state.prefix, tag, text),
      x: 0,
      y: 0,
      width: cs.width ?? 200,
      height: cs.height ?? 36,
      content: text,
      fontSize: cs.fontSize ?? 14,
      fontWeight: cs.fontWeight ?? '400',
      textGrowth: 'fixed-width',
    };
    applyStyleFields(node, cs);
    state.nodeCount++;
    return [node];
  }

  // Text-bearing tags → text node.
  if (TEXT_TAGS.has(tag)) {
    state.nodeCount++;
    return [buildTextNode(el, cs, state.prefix, tag)];
  }

  // <a>: text when it has only text children, frame otherwise.
  if (tag === 'a') {
    if (hasElementChildren(el)) {
      const pos = resolvePosition(el, root, cs);
      const sub = processChildren(el, depth + 1, state, root);
      state.nodeCount++;
      const frame = buildFrameNode(cs, sub, state.prefix, tag, collectText(el).trim() || undefined);
      frame.x = pos.x;
      frame.y = pos.y;
      return [frame];
    }
    const text = collectText(el).trim();
    const href = el.getAttribute('href') ?? undefined;
    const node = buildTextNode(el, cs, state.prefix, tag);
    node.content = text;
    if (href) node.href = href;
    state.nodeCount++;
    return [node];
  }

  // Container tags → frame.
  if (FRAME_TAGS.has(tag)) {
    const pos = resolvePosition(el, root, cs);
    const sub = processChildren(el, depth + 1, state, root);
    state.nodeCount++;
    const frame = buildFrameNode(cs, sub, state.prefix, tag, collectText(el).trim() || undefined);
    frame.x = pos.x;
    frame.y = pos.y;
    return [frame];
  }

  // Unknown tag: UNWRAP — skip the element itself but walk its children
  // (hoisted into the parent) so we don't lose content. Children remain at
  // the same depth (the unknown tag's depth), matching v1's unwrap semantic.
  state.warnings.push(`<${tag}> unrecognized; element skipped, children hoisted.`);
  return processChildren(el, depth, state, root);
}

/// Iterate the children of `parent` (depth = the depth of those children in
/// the .pen tree). Returns the concatenated .pen nodes. Enforces the depth
/// cap by short-circuiting the entire subtree.
function processChildren(
  parent: HTMLElement,
  depth: number,
  state: WalkState,
  root: HTMLElement,
): PenChild[] {
  if (depth > MAX_DEPTH) {
    state.warnings.push(`Depth cap (${MAX_DEPTH}) hit under <${parent.tagName.toLowerCase()}>; subtree skipped.`);
    return [];
  }
  const out: PenChild[] = [];
  const children = Array.from(parent.children) as HTMLElement[];
  for (const child of children) {
    if (state.nodeCount >= MAX_NODES) {
      if (!state.nodeCapHit) {
        state.warnings.push(`Node count cap (${MAX_NODES}) hit; remaining siblings skipped.`);
        state.nodeCapHit = true;
      }
      return out;
    }
    const sub = processElement(child, depth, state, root);
    out.push(...sub);
  }
  return out;
}

/// Walk a DOM subtree and emit .pen PenChild[]. Pure: takes a real DOM
/// tree (jsdom or a browser DOM) and returns the extracted .pen tree.
/// The `root` element itself is NOT included — its children become the
/// top-level result (matches the iframe-body entry point).
export function walkDomForPenTree(
  root: HTMLElement,
  warnings: string[],
  opts: { namePrefix?: string } = {},
): PenChild[] {
  const state: WalkState = {
    warnings,
    nodeCount: 0,
    prefix: opts.namePrefix?.trim() || 'html',
    nodeCapHit: false,
  };
  return processChildren(root, 1, state, root);
}

// ---- Browser-only iframe extraction --------------------------------------

/** Mount the HTML in a hidden sandboxed iframe (allow-same-origin, NO
 *  allow-scripts), wait for layout, then walk the resulting DOM. Browser-
 *  only; returns an empty result with a warning when called outside a
 *  browser (e.g. server-side render path). */
export async function extractHtmlViaIframe(
  html: string,
  opts: { timeout?: number; namePrefix?: string } = {},
): Promise<ExtractedPenTree> {
  const warnings: string[] = [];
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    warnings.push('extractHtmlViaIframe called outside a browser; returning empty tree.');
    return { children: [], warnings };
  }
  const timeoutMs = opts.timeout ?? 5000;
  const iframe = document.createElement('iframe');
  iframe.style.display = 'none';
  // sandbox: same-origin so we can read contentDocument + computed styles;
  // NO allow-scripts so embedded <script>/on*-handler content cannot run.
  iframe.setAttribute('sandbox', 'allow-same-origin');
  document.body.appendChild(iframe);

  const cleanup = () => {
    try {
      iframe.remove();
    } catch {
      // ignore — already gone.
    }
  };

  try {
    const doc = iframe.contentDocument;
    if (!doc) {
      warnings.push('iframe.contentDocument was null (cross-origin?); returning empty tree.');
      return { children: [], warnings };
    }
    doc.open();
    doc.write(html);
    doc.close();

    // Wait for the browser to compute layout: rAF + a small setTimeout.
    // Cap at the timeout so a stuck layout never wedges the caller.
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      void timer;
      // requestAnimationFrame may not fire in jsdom (no rendering pipeline);
      // setTimeout(50) is the floor that guarantees layout in real browsers.
      try {
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => setTimeout(finish, 50));
        } else {
          setTimeout(finish, 50);
        }
      } catch {
        setTimeout(finish, 50);
      }
    });

    const body = doc.body ?? doc.documentElement;
    if (!body) {
      warnings.push('iframe document had no body; returning empty tree.');
      return { children: [], warnings };
    }
    const children = walkDomForPenTree(body as HTMLElement, warnings, {
      namePrefix: opts.namePrefix,
    });
    return { children, warnings };
  } finally {
    cleanup();
  }
}
