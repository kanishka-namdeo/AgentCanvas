// Lucide icon integration tests (docs/lucide-icons.md).
//
// Covers the whole pipeline with the registry at the center:
//   1. Registry integrity — unique names, valid elements, catalog coverage.
//   2. Name resolution — exact, tolerant spellings, lucide- prefix, failures.
//   3. Search — exact/prefix/keyword scoring, category filter, limits.
//   4. SVG emitters — <g> form (server render) + inline svg form (code export).
//   5. Resolver — .pen icon node → icon Layer with normalized paint + 24×24
//      default sizing; PenIcon.fill promoted to stroke.
//   6. Render paths — render-to-png SVG emission + export.ts SVG emission
//      + serialize.ts html/react/tailwind code export.
//   7. html-import — lucide inline <svg> round-trips to a native icon node.
//   8. System prompt — the ICON SYSTEM section + catalog are injected.

import { describe, it, expect } from 'vitest';
import {
  LUCIDE_ICON_NAMES,
  LUCIDE_ICON_COUNT,
  LUCIDE_CATEGORIES,
  getLucideIcon,
  searchLucideIcons,
  lucidePromptCatalog,
  lucideIconGroupSvg,
  lucideIconInlineSvg,
  lucideIconElements,
  normalizeIconName,
  lucideCategories,
} from '@/lib/icons';
import { resolvePenTree } from '@/lib/pen/resolve';
import type { CanvasDocument } from '@/lib/canvas/types';
import type { PenChild } from '@/lib/pen/types';
import { renderCanvasToSvg } from '@/lib/canvas/render-to-png';
import { exportSvg } from '@/lib/canvas/export';
import { serializeNodes } from '@/lib/canvas/serialize';
import { parseHtmlFragment, htmlToPenTreeDetailed } from '@/lib/canvas/html-import';
import { buildSystemPrompt } from '@/lib/agent/runner-legacy';

function docWith(children: PenChild[]): CanvasDocument {
  return {
    id: 'doc-icons',
    name: 'Icons',
    background: '#ffffff',
    version: '2.17',
    children,
    viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes: [],
    tokens: { colors: [], textStyles: [] },
  };
}

// ---- 1. Registry integrity ---------------------------------------------------

describe('lucide registry', () => {
  it('has a non-trivial curated catalog across categories', () => {
    expect(LUCIDE_ICON_COUNT).toBeGreaterThanOrEqual(150);
    expect(Object.keys(LUCIDE_CATEGORIES).length).toBeGreaterThanOrEqual(12);
    // Every catalog name must exist in the registry proper.
    for (const names of Object.values(LUCIDE_CATEGORIES)) {
      for (const n of names) expect(LUCIDE_ICON_NAMES).toContain(n);
    }
  });

  it('names are unique, kebab-case, and elements are non-empty valid tags', () => {
    const seen = new Set<string>();
    const VALID_TAGS = new Set(['path', 'circle', 'rect', 'polyline', 'line', 'ellipse']);
    for (const name of LUCIDE_ICON_NAMES) {
      expect(seen.has(name)).toBe(false);
      seen.add(name);
      expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      const els = lucideIconElements(name);
      expect(els).not.toBeNull();
      expect(els!.length).toBeGreaterThan(0);
      for (const el of els!) {
        expect(VALID_TAGS.has(el.tag)).toBe(true);
        expect(Object.keys(el.attrs).length).toBeGreaterThan(0);
        expect(el.attrs).not.toHaveProperty('key'); // React-only prop stripped
      }
    }
  });

  it('includes the essential UI icon vocabulary', () => {
    for (const essential of ['lock', 'check', 'x', 'search', 'user', 'star', 'heart', 'arrow-right', 'trash-2', 'settings']) {
      expect(getLucideIcon(essential)).not.toBeNull();
    }
  });

  it('lucideCategories returns a defensive copy', () => {
    const cats = lucideCategories();
    cats.actions.push('bogus-icon');
    expect(LUCIDE_CATEGORIES.actions).not.toContain('bogus-icon');
  });
});

// ---- 2. Name resolution --------------------------------------------------------

describe('getLucideIcon resolution', () => {
  it('resolves exact names', () => {
    expect(getLucideIcon('lock')?.name).toBe('lock');
  });

  it('normalizes case, spaces, underscores, and camelCase', () => {
    expect(normalizeIconName('Trash 2')).toBe('trash-2');
    expect(normalizeIconName('Trash_2')).toBe('trash-2');
    expect(normalizeIconName('Trash2')).toBe('trash2');
    expect(getLucideIcon('Trash 2')?.name).toBe('trash-2');
    expect(getLucideIcon('ARROW_RIGHT')?.name).toBe('arrow-right');
  });

  it('strips the lucide- markup prefix and -icon suffix', () => {
    expect(getLucideIcon('lucide-lock')?.name).toBe('lock');
    expect(getLucideIcon('lock-icon')?.name).toBe('lock');
  });

  it('resolves numbered-family fallbacks (trash → trash-2)', () => {
    expect(getLucideIcon('trash')?.name).toBe('trash-2');
  });

  it('resolves semantic keywords (password → lock)', () => {
    expect(getLucideIcon('password')?.name).toBe('lock');
  });

  it('returns null for unknown names', () => {
    expect(getLucideIcon('definitely-not-an-icon')).toBeNull();
    expect(getLucideIcon('')).toBeNull();
  });
});

// ---- 3. Search -------------------------------------------------------------------

describe('searchLucideIcons', () => {
  it('ranks exact matches first', () => {
    const results = searchLucideIcons('lock');
    expect(results[0].name).toBe('lock');
  });

  it('maps multi-word meanings to keyword matches (password security → lock family)', () => {
    const results = searchLucideIcons('password security');
    expect(results.length).toBeGreaterThan(0);
    expect(results.map((r) => r.name)).toContain('lock');
  });

  it('maps revenue growth to the analytics set', () => {
    const results = searchLucideIcons('revenue growth');
    expect(results.map((r) => r.name)).toContain('trending-up');
  });

  it('filters by category', () => {
    const results = searchLucideIcons('', { category: 'commerce' });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(LUCIDE_CATEGORIES.commerce).toContain(r.name);
    }
  });

  it('respects the limit', () => {
    expect(searchLucideIcons('', { limit: 5 })).toHaveLength(5);
    expect(searchLucideIcons('arrow', { limit: 3 })).toHaveLength(3);
  });

  it('returns matches with categories attached', () => {
    const results = searchLucideIcons('lock');
    expect(results[0].category).toBe('security');
  });
});

// ---- 4. SVG emitters ---------------------------------------------------------------

describe('lucide svg emitters', () => {
  it('groupSvg emits a translated, scaled, stroke-painted <g>', () => {
    const g = lucideIconGroupSvg('lock', 100, 200, 48, { stroke: '#0ea5e9' });
    expect(g).toContain('transform="translate(100 200) scale(2)"');
    expect(g).toContain('stroke="#0ea5e9"');
    expect(g).toContain('fill="none"');
    expect(g).toContain('stroke-linecap="round"');
    expect(g).toContain('<path');
    expect(g).not.toContain('key='); // React key stripped
  });

  it('groupSvg scales stroke width with size (visual weight parity)', () => {
    const small = lucideIconGroupSvg('lock', 0, 0, 24, {});
    const big = lucideIconGroupSvg('lock', 0, 0, 48, {});
    expect(small).toContain('stroke-width="2"');
    expect(big).toContain('stroke-width="4"');
  });

  it('inlineSvg defaults to currentColor (idiomatic recolorable markup)', () => {
    const svg = lucideIconInlineSvg('lock', 20);
    expect(svg).toContain('class="lucide lucide-lock"');
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).toContain('stroke="currentColor"');
    expect(svg).toContain('width="20"');
  });

  it('inlineSvg pins an explicit stroke color when given', () => {
    const svg = lucideIconInlineSvg('lock', 20, { stroke: '#0f172a' });
    expect(svg).toContain('stroke="#0f172a"');
  });

  it('returns empty string for unknown icons', () => {
    expect(lucideIconGroupSvg('nope-not-real', 0, 0, 24)).toBe('');
    expect(lucideIconInlineSvg('nope-not-real', 24)).toBe('');
  });
});

// ---- 5. Resolver -----------------------------------------------------------------

describe('resolver: icon nodes', () => {
  it('maps .pen icon nodes to icon Layers carrying the name', () => {
    const layers = resolvePenTree(docWith([
      { id: 'i1', type: 'icon', name: 'Lock', x: 10, y: 20, width: 32, height: 32, icon: 'lock', library: 'lucide' } as PenChild,
    ]));
    expect(layers).toHaveLength(1);
    expect(layers[0].type).toBe('icon');
    expect(layers[0].iconName).toBe('lock');
    expect(layers[0].iconLibrary).toBe('lucide');
    expect(layers[0].text).toBeUndefined(); // no more [icon:lock] placeholder
  });

  it('defaults icon size to 24×24 when width/height are omitted', () => {
    const layers = resolvePenTree(docWith([
      { id: 'i2', type: 'icon', name: 'Star', x: 0, y: 0, icon: 'star' } as PenChild,
    ]));
    expect(layers[0].width).toBe(24);
    expect(layers[0].height).toBe(24);
  });

  it('promotes PenIcon.fill to the stroke color with lucide width', () => {
    const layers = resolvePenTree(docWith([
      { id: 'i3', type: 'icon', name: 'Heart', x: 0, y: 0, width: 24, height: 24, icon: 'heart', fill: '#ef4444' } as PenChild,
    ]));
    expect(layers[0].stroke).toBe('#ef4444');
    expect(layers[0].strokeWidth).toBe(2);
  });

  it('keeps an explicit stroke color and honors strokeWidth', () => {
    const layers = resolvePenTree(docWith([
      { id: 'i4', type: 'icon', name: 'Zap', x: 0, y: 0, width: 24, height: 24, icon: 'zap', stroke: '#0ea5e9', strokeWidth: 1.5 } as PenChild,
    ]));
    expect(layers[0].stroke).toBe('#0ea5e9');
    expect(layers[0].strokeWidth).toBe(1.5);
  });

  it('defaults to dark neutral paint when nothing is specified', () => {
    const layers = resolvePenTree(docWith([
      { id: 'i5', type: 'icon', name: 'Bell', x: 0, y: 0, width: 24, height: 24, icon: 'bell' } as PenChild,
    ]));
    expect(layers[0].stroke).toBe('#0f172a');
    expect(layers[0].strokeWidth).toBe(2);
  });
});

// ---- 6. Render paths ----------------------------------------------------------------

describe('render paths: icons', () => {
  const layers = resolvePenTree(docWith([
    { id: 'r1', type: 'icon', name: 'Lock', x: 40, y: 60, width: 24, height: 24, icon: 'lock', stroke: '#0f172a', strokeWidth: 2 } as PenChild,
  ]));

  it('renderCanvasToSvg (server PNG path) emits the lucide <g>', () => {
    const svg = renderCanvasToSvg(layers, 400, 300);
    expect(svg).toContain('<g transform="translate(40 60) scale(1)"');
    expect(svg).toContain('stroke="#0f172a"');
    expect(svg).toContain('<path');
  });

  it('exportSvg (client SVG export) emits the lucide <g>', () => {
    // exportSvg normalizes bounds to the drawing's bbox — a single icon at
    // (40,60) shifts to origin, so the glyph <g> lands at translate(0 0).
    const svg = exportSvg(layers) ?? '';
    expect(svg).toContain('<g transform="translate(0 0) scale(1)"');
    expect(svg).toContain('stroke="#0f172a"');
    expect(svg).toContain('viewBox'); // well-formed svg doc
  });

  it('serializeNodes emits lucide-style inline svg in html output', () => {
    const html = serializeNodes(layers, { framework: 'html' });
    expect(html).toContain('<svg');
    expect(html).toContain('viewBox="0 0 24 24"');
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain('stroke-width="2"');
    expect(html).toContain('data-node-id="r1"');
    // color participates via the `color` style so tokens still work
    expect(html).toMatch(/color:\s*#0f172a/);
  });

  it('serializeNodes emits camelCase stroke attrs in react output', () => {
    const jsx = serializeNodes(layers, { framework: 'react' });
    expect(jsx).toContain('strokeWidth={2}'.replace('{2}', '"2"')); // string attr form
    expect(jsx).toContain('strokeLinecap');
    expect(jsx).toContain('stroke="currentColor"');
    expect(jsx).not.toContain('stroke-width='); // dash-case would be invalid JSX
  });

  it('serializeNodes emits a color class in tailwind output', () => {
    const tw = serializeNodes(layers, { framework: 'tailwind' });
    expect(tw).toContain('<svg');
    expect(tw).toContain('text-slate-900'); // #0f172a → text-slate-900
    expect(tw).toContain('stroke="currentColor"');
  });

  it('unknown icon names render a visible placeholder, not silence', () => {
    const bad = resolvePenTree(docWith([
      { id: 'r2', type: 'icon', name: 'Bad', x: 0, y: 0, width: 24, height: 24, icon: 'zzz-unknown' } as PenChild,
    ]));
    // The renderer draws a dashed box (tested via the island's react render in
    // dom tests); here we assert the SVG paths simply omit it (no crash).
    expect(() => renderCanvasToSvg(bad, 100, 100)).not.toThrow();
    expect(renderCanvasToSvg(bad, 100, 100)).not.toContain('zzz-unknown');
  });
});

// ---- 7. html-import round-trip --------------------------------------------------------

describe('html-import: lucide svgs', () => {
  it('maps class="lucide lucide-lock" to a native icon node', () => {
    const html =
      '<div style="display:flex;align-items:center;gap:8px">' +
      '<svg xmlns="http://www.w3.org/2000/svg" class="lucide lucide-lock" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:#0f172a"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>' +
      '<span style="font-size:14px">Secure checkout</span>' +
      '</div>';
    const roots = parseHtmlFragment(html);
    expect(roots[0].tag).toBe('div');
    const svgEl = roots[0].children.find((c) => c.type === 'element' && c.el.tag === 'svg');
    expect(svgEl).toBeTruthy();

    const { nodes, stats } = htmlToPenTreeDetailed(roots);
    const walk = (n: PenChild): PenChild[] =>
      n.type === 'icon' ? [n] : (((n as { children?: PenChild[] }).children ?? []).flatMap(walk));
    const iconNode = nodes.flatMap(walk);
    expect(iconNode.length).toBe(1);
    expect(iconNode[0].type).toBe('icon');
    expect((iconNode[0] as { icon?: string }).icon).toBe('lock');
    expect((iconNode[0] as { library?: string }).library).toBe('lucide');
    expect((iconNode[0] as { width?: number }).width).toBe(18);
    expect((iconNode[0] as { fill?: unknown }).fill).toBe('#0f172a');
    expect(stats.typeCounts.icon).toBe(1);
    expect(stats.skippedSvg).toBe(0);
  });

  it('still skips non-lucide svgs', () => {
    const html = '<div><svg class="custom-logo" viewBox="0 0 100 100"><path d="M0 0"/></svg></div>';
    const roots = parseHtmlFragment(html);
    const { stats } = htmlToPenTreeDetailed(roots);
    expect(stats.skippedSvg).toBe(1);
    expect(stats.typeCounts.icon).toBeUndefined();
  });
});

// ---- 8. System prompt injection ----------------------------------------------------------

describe('system prompt: icon section', () => {
  const prompt = buildSystemPrompt('', '', '', docWith([]), 'slate', false);

  it('contains the ICON SYSTEM contract', () => {
    expect(prompt).toContain('ICON SYSTEM (Lucide');
    expect(prompt).toContain('NEVER hand-draw icons');
    expect(prompt).toContain('type:"icon"');
  });

  it('injects the icon count and the category catalog', () => {
    expect(prompt).toContain(`${LUCIDE_ICON_COUNT} curated Lucide icons`);
    const catalog = lucidePromptCatalog();
    expect(prompt).toContain(catalog.split('\n')[0]); // first category line
    expect(prompt).toContain('lock');
  });

  it('replaces every icon placeholder (no leftover template vars)', () => {
    expect(prompt).not.toContain('${LUCIDE_ICON_CATALOG}');
    expect(prompt).not.toContain('${LUCIDE_ICON_COUNT}');
  });
});
