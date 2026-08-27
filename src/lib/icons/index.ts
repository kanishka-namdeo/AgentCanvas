// Lucide icon library — the single runtime surface over the generated
// registry (see docs/lucide-icons.md for the architecture).
//
// Pure data + pure functions, safe on the server (string emitters for the SVG
// / PNG render paths) and on the client (React islands import the same
// registry). The .pen document stays SYMBOLIC: an icon node stores
// `library: 'lucide'` + `icon: 'lock'`; geometry is attached at render time
// from the registry, so files stay small and icons stay updatable by name.
//
// Consumers:
//   - resolve.ts          → maps .pen icon nodes to icon Layers (name only)
//   - dom/islands.tsx     → React <svg> island per icon layer
//   - canvas/export.ts    → SVG export string
//   - canvas/render-to-png.ts → server-side resvg SVG string
//   - canvas/serialize.ts → HTML/React/Tailwind code export
//   - agent/tools.ts      → pen_search_icons + pen_create_node validation
//   - runner-legacy.ts    → the system-prompt ICON catalog

import {
  LUCIDE_ICONS,
  LUCIDE_CATEGORIES,
  LUCIDE_ICON_KEYWORDS,
  LUCIDE_REGISTRY_SOURCE_VERSION,
  type LucideIconElement,
} from './lucide-registry.generated';

export type { LucideIconElement };
export { LUCIDE_REGISTRY_SOURCE_VERSION, LUCIDE_CATEGORIES };

/** The lucide default paint profile every icon assumes (24×24 grid). */
export const LUCIDE_VIEWBOX = 24;
export const LUCIDE_DEFAULT_STROKE_WIDTH = 2;

/** All registered icon names (sorted). */
export const LUCIDE_ICON_NAMES: string[] = Object.keys(LUCIDE_ICONS).sort();

/** Number of icons in the curated catalog. */
export const LUCIDE_ICON_COUNT = LUCIDE_ICON_NAMES.length;

/** category id → icon names (a copy, so callers can't mutate the registry). */
export function lucideCategories(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [cat, names] of Object.entries(LUCIDE_CATEGORIES)) out[cat] = [...names];
  return out;
}

/** The category an icon belongs to (first category that lists it). */
export function lucideIconCategory(name: string): string | null {
  for (const [cat, names] of Object.entries(LUCIDE_CATEGORIES)) {
    if (names.includes(name)) return cat;
  }
  return null;
}

/**
 * Normalize an arbitrary icon-name spelling to the registry's kebab-case
 * vocabulary: lowercases, converts spaces/underscores/CamelCase to dashes,
 * and strips the `lucide-` prefix real lucide markup carries
 * (`lucide-lock` → `lock`) plus a trailing `-icon` suffix.
 */
export function normalizeIconName(raw: string): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^lucide[-_]?/, '')
    .replace(/-icon$/, '')
    .replace(/[\s_]+/g, '-')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Resolve a name (or near-name) to a registered icon.
 *
 * Resolution ladder (first hit wins):
 *   1. exact match after normalization
 *   2. `x-2`/`x-3` suffix variants (`trash` → `trash-2`)
 *   3. prefix match (`arrow` → `arrow-right`) — only when unambiguous-ish
 *      (alphabetically first, deterministic)
 *   4. keyword match (`password` → `lock`)
 *
 * Returns null for unknown names — callers decide how to degrade (the agent
 * tool surfaces a "did you mean" list; the renderer draws a placeholder).
 */
export function getLucideIcon(raw: string): { name: string; elements: LucideIconElement[] } | null {
  const name = normalizeIconName(raw);
  if (!name) return null;
  if (LUCIDE_ICONS[name]) return { name, elements: LUCIDE_ICONS[name] };

  // Numbered-suffix variants (lucide's trash-2 style families).
  for (const suffix of ['-2', '-3', '-solid', '-outline', '-filled']) {
    const candidate = name + suffix;
    if (LUCIDE_ICONS[candidate]) return { name: candidate, elements: LUCIDE_ICONS[candidate] };
  }

  // Prefix match: prefer an exact shorter sibling, else alphabetical first.
  const prefixed = LUCIDE_ICON_NAMES.filter((n) => n.startsWith(name + '-'));
  if (prefixed.length > 0) {
    const pick = prefixed.find((n) => n === name + '-2') ?? prefixed[0];
    return { name: pick, elements: LUCIDE_ICONS[pick] };
  }

  // Keyword match (password → lock, trash → trash-2).
  const kw = name.replace(/-/g, ' ');
  for (const [iconName, keywords] of Object.entries(LUCIDE_ICON_KEYWORDS)) {
    if (keywords.includes(kw) || keywords.includes(name)) {
      return { name: iconName, elements: LUCIDE_ICONS[iconName] };
    }
  }
  return null;
}

// ---- Search -------------------------------------------------------------------

export interface IconSearchMatch {
  name: string;
  category: string | null;
  score: number;
}

export interface IconSearchOpts {
  /** Restrict to one category id (e.g. 'commerce'). */
  category?: string;
  /** Max results (default 12). */
  limit?: number;
}

/**
 * Rank icons against a free-text query. Scoring favors exact > prefix >
 * word-boundary > substring, then keyword hits — scored PER QUERY WORD so
 * multi-word intents ("password security") match keyword sets without
 * requiring the full phrase. Empty query returns the category listing.
 */
export function searchLucideIcons(query: string, opts: IconSearchOpts = {}): IconSearchMatch[] {
  const limit = Math.max(1, Math.min(48, opts.limit ?? 12));
  const q = normalizeIconName(query);
  const words = q ? q.split('-').filter((w) => w.length > 1) : [];
  const categoryNames = opts.category ? LUCIDE_CATEGORIES[opts.category] ?? null : null;

  const matches: IconSearchMatch[] = [];
  for (const name of LUCIDE_ICON_NAMES) {
    if (categoryNames && !categoryNames.includes(name)) continue;
    const nameWords = name.split('-');
    let score = 0;
    if (!q) {
      score = 1; // browsing mode — stable alphabetical order
    } else if (name === q) {
      score = 100;
    } else if (name.startsWith(q + '-') || name.startsWith(q)) {
      score = 60;
    } else if (nameWords.some((w) => w === q) || name.includes('-' + q)) {
      score = 40;
    } else if (name.includes(q)) {
      score = 25;
    } else {
      // Word-level keyword matching: each query word scored against the
      // icon's keywords and name words; 2+ hits (or one exact keyword hit)
      // makes the icon a match. This is what maps MEANING → icon.
      const kw = LUCIDE_ICON_KEYWORDS[name] ?? '';
      const kwWords = kw ? kw.split(/\s+/) : [];
      let kwScore = 0;
      for (const w of words) {
        if (kwWords.includes(w)) kwScore += 10;
        else if (nameWords.includes(w)) kwScore += 8;
        else if (kw.includes(w)) kwScore += 4;
      }
      score = kwScore >= 8 ? kwScore : 0;
    }
    if (score > 0) matches.push({ name, category: lucideIconCategory(name), score });
  }
  matches.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return matches.slice(0, limit);
}

// ---- Prompt catalog -----------------------------------------------------------

/**
 * Compact catalog for the system prompt: one line per category with its icon
 * names. ~2 KB — cheap enough to always include, and it is what stops the
 * model from inventing icon names that don't exist.
 */
export function lucidePromptCatalog(): string {
  const lines: string[] = [];
  for (const [cat, names] of Object.entries(LUCIDE_CATEGORIES)) {
    lines.push(`  ${cat}: ${names.join(', ')}`);
  }
  return lines.join('\n');
}

// ---- SVG emission (server-safe string builders) --------------------------------

export interface LucideSvgOpts {
  /** Stroke color (lucide paints with `currentColor` — we pin it). */
  stroke?: string;
  /** Stroke width on the 24-unit grid (default 2). */
  strokeWidth?: number;
  /** Scale stroke width with icon size (default true — keeps visual weight). */
  scaleStroke?: boolean;
}

function escapeXmlAttrValue(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The icon's child elements as SVG markup, wrapped in a `<g>` positioned at
 * (x, y) and scaled to `size` on a 24-unit grid — the resvg-safe form used by
 * the server SVG/PNG render paths (no nested <svg> needed).
 */
export function lucideIconGroupSvg(
  name: string,
  x: number,
  y: number,
  size: number,
  opts: LucideSvgOpts = {},
): string {
  const icon = getLucideIcon(name);
  if (!icon) return '';
  const scale = size / LUCIDE_VIEWBOX;
  const base = opts.strokeWidth ?? LUCIDE_DEFAULT_STROKE_WIDTH;
  // Scale stroke with size unless the caller pinned it: a 2-unit stroke on a
  // 48px icon looks anemic; 4 units on a 16px icon looks muddy.
  const sw = opts.scaleStroke === false ? base : Math.max(0.75, base * scale);
  const color = opts.stroke ?? 'currentColor';
  const inner = icon.elements
    .map((el) => {
      const attrs = Object.entries(el.attrs)
        .map(([k, v]) => `${k}="${escapeXmlAttrValue(String(v))}"`)
        .join(' ');
      return `<${el.tag} ${attrs}/>`;
    })
    .join('');
  return (
    `<g transform="translate(${round2(x)} ${round2(y)}) scale(${round4(scale)})" ` +
    `fill="none" stroke="${escapeXmlAttrValue(color)}" stroke-width="${round2(sw)}" ` +
    `stroke-linecap="round" stroke-linejoin="round">${inner}</g>`
  );
}

/**
 * The icon as a standalone inline `<svg>` element (lucide-style markup) —
 * the form the HTML/React/Tailwind code exporters emit.
 */
export function lucideIconInlineSvg(
  name: string,
  size: number,
  opts: LucideSvgOpts = {},
): string {
  const icon = getLucideIcon(name);
  if (!icon) return '';
  const base = opts.strokeWidth ?? LUCIDE_DEFAULT_STROKE_WIDTH;
  const sw = opts.scaleStroke === false ? base : Math.max(0.75, base * (size / LUCIDE_VIEWBOX));
  const color = opts.stroke ?? 'currentColor';
  const inner = icon.elements
    .map((el) => {
      const attrs = Object.entries(el.attrs)
        .map(([k, v]) => `${k}="${escapeXmlAttrValue(String(v))}"`)
        .join(' ');
      return `  <${el.tag} ${attrs}/>`;
    })
    .join('\n');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" class="lucide lucide-${icon.name}" ` +
    `width="${round2(size)}" height="${round2(size)}" viewBox="0 0 ${LUCIDE_VIEWBOX} ${LUCIDE_VIEWBOX}" ` +
    `fill="none" stroke="${escapeXmlAttrValue(color)}" stroke-width="${round2(sw)}" ` +
    `stroke-linecap="round" stroke-linejoin="round">\n${inner}\n</svg>`
  );
}

/** The icon's elements for React islands (DomNode rendering). */
export function lucideIconElements(name: string): LucideIconElement[] | null {
  const icon = getLucideIcon(name);
  return icon ? icon.elements : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
