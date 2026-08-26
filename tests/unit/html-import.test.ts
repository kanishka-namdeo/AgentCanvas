// Tests for src/lib/canvas/html-import.ts (spec Phase 3, pen_insert_html
// pipeline — spec §5.2). SECURITY-CRITICAL: the sanitizer subset is covered by
// an XSS corpus; the converter subset by the tag→.pen mapping table.
//
// The tokenizer is hand-rolled (no DOMParser — Node has none), so every
// malicious-input shape that a browser parser would survive must be verified
// explicitly here.

import { describe, it, expect } from 'vitest';
import {
  parseHtmlFragment,
  htmlToPenTree,
  htmlToPenTreeDetailed,
  decodeEntities,
  isSafeUrl,
  type ImportedNode,
  type ImportedChild,
} from '@/lib/canvas/html-import';
import type { PenChild } from '@/lib/pen/types';

// ---- Helpers ----------------------------------------------------------------

function texts(children: ImportedChild[]): string {
  return children
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('');
}

function findTag(nodes: ImportedNode[], tag: string): ImportedNode | undefined {
  for (const n of nodes) {
    if (n.tag === tag) return n;
    for (const c of n.children) {
      if (c.type === 'element') {
        const found = findTag([c.el], tag);
        if (found) return found;
      }
    }
  }
  return undefined;
}

function flattenPen(nodes: PenChild[]): PenChild[] {
  const out: PenChild[] = [];
  const walk = (ns: PenChild[]) => {
    for (const n of ns) {
      out.push(n);
      const kids = (n as { children?: PenChild[] }).children;
      if (Array.isArray(kids)) walk(kids);
    }
  };
  walk(nodes);
  return out;
}

// ---- Tokenizer: XSS corpus (security-critical) -------------------------------

describe('html-import: XSS corpus (sanitizer)', () => {
  it('strips on* event handler attributes', () => {
    const [el] = parseHtmlFragment('<div onclick="alert(1)" onmouseover="steal()">Safe</div>');
    expect(el.tag).toBe('div');
    expect(el.attrs).toEqual({});
    expect(texts(el.children)).toBe('Safe');
  });

  it('strips javascript: hrefs', () => {
    const [a] = parseHtmlFragment('<a href="javascript:alert(1)">click</a>');
    expect(a.attrs).toEqual({});
    expect(texts(a.children)).toBe('click');
  });

  it('strips obfuscated javascript: hrefs (control chars, mixed case)', () => {
    const [a] = parseHtmlFragment('<a href=" \tJaVaScRiPt:alert(1)">x</a>');
    expect(a.attrs).toEqual({});
  });

  it('strips vbscript: and data:text/ URLs', () => {
    const [a] = parseHtmlFragment('<a href="vbscript:msgbox(1)">v</a>');
    const [img] = parseHtmlFragment('<img src="data:text/html;base64,PHNjcmlwdD4=">');
    expect(a.attrs).toEqual({});
    expect(img.attrs).toEqual({});
  });

  it('keeps http/https, protocol-relative, root-relative, ./ ../ # and data:image/ URLs', () => {
    const [a1] = parseHtmlFragment('<a href="https://example.com/x">1</a>');
    expect(a1.attrs.href).toBe('https://example.com/x');
    const [a2] = parseHtmlFragment('<a href="//cdn.example.com/x">2</a>');
    expect(a2.attrs.href).toBe('//cdn.example.com/x');
    const [a3] = parseHtmlFragment('<a href="/about">3</a>');
    expect(a3.attrs.href).toBe('/about');
    const [a4] = parseHtmlFragment('<a href="./local">4</a>');
    expect(a4.attrs.href).toBe('./local');
    const [a5] = parseHtmlFragment('<a href="#anchor">5</a>');
    expect(a5.attrs.href).toBe('#anchor');
    const [img] = parseHtmlFragment('<img src="data:image/png;base64,iVBORw0KGgo=">');
    expect(img.attrs.src).toBe('data:image/png;base64,iVBORw0KGgo=');
  });

  it('drops <script> elements with ALL their contents', () => {
    const roots = parseHtmlFragment('<div>Before<script>alert("evil")</script>After</div>');
    expect(roots).toHaveLength(1);
    expect(texts(roots[0].children)).toBe('BeforeAfter');
    expect(JSON.stringify(roots)).not.toContain('alert');
    expect(JSON.stringify(roots)).not.toContain('script');
  });

  it('drops <style>, <iframe>, <object>, <embed> with contents', () => {
    const roots = parseHtmlFragment(
      '<div>a<style>body{}</style>b<iframe src="x"></iframe>c<object data="x"></object>d<embed src="x">e</div>',
    );
    expect(texts(roots[0].children)).toBe('abcde');
    expect(JSON.stringify(roots)).not.toContain('iframe');
    expect(JSON.stringify(roots)).not.toContain('object');
    expect(JSON.stringify(roots)).not.toContain('embed');
  });

  it('recovers from a dropped-subtree close even with nested tags inside (script is raw text)', () => {
    const roots = parseHtmlFragment('<div><script>if (1 < 2) { evil() }</script>kept</div>');
    expect(texts(roots[0].children)).toBe('kept');
  });

  it('drops unknown tags but keeps their text children (unwrap)', () => {
    const roots = parseHtmlFragment('<div><custom-tag>Inner text</custom-tag></div>');
    expect(roots[0].children.every((c) => c.type === 'text')).toBe(true);
    expect(texts(roots[0].children)).toBe('Inner text');
  });

  it('unwraps unknown containers but keeps nested whitelisted elements', () => {
    const roots = parseHtmlFragment('<wrapper><div><p>Hi</p></div></wrapper>');
    expect(roots[0].tag).toBe('div');
    expect(roots[0].children[0].type).toBe('element');
  });

  it('drops id, data-*, srcset, formaction attributes (class survives for lucide svg detection)', () => {
    const [el] = parseHtmlFragment(
      '<div class="c" id="i" data-x="1" role="presentation">t</div>',
    );
    // `class` is now whitelisted so class="lucide lucide-<name>" inline svgs
    // can be detected and mapped to native icon nodes (docs/lucide-icons.md).
    expect(el.attrs).toEqual({ class: 'c' });
    const [img] = parseHtmlFragment('<img src="/ok.png" srcset="/ok.png 2x" alt="a">');
    expect(Object.keys(img.attrs).sort()).toEqual(['alt', 'src']);
  });

  it('drops comments and doctypes', () => {
    const roots = parseHtmlFragment('<!DOCTYPE html><!-- secret --><div>t</div>');
    expect(roots).toHaveLength(1);
    expect(roots[0].tag).toBe('div');
    expect(JSON.stringify(roots)).not.toContain('secret');
  });

  it('auto-closes unclosed tags at parent end (malformed nesting)', () => {
    const roots = parseHtmlFragment('<div><span>unclosed text');
    expect(roots).toHaveLength(1);
    expect(roots[0].tag).toBe('div');
    expect(roots[0].children[0].type).toBe('element');
    const span = roots[0].children[0] as { type: 'element'; el: ImportedNode };
    expect(texts(span.el.children)).toBe('unclosed text');
  });

  it('auto-closes intermediate unclosed tags when the outer tag closes', () => {
    const roots = parseHtmlFragment('<ul><li>one<li>two</ul><p>after</p>');
    expect(roots.map((r) => r.tag)).toEqual(['ul', 'p']);
    const ul = roots[0];
    expect(ul.children).toHaveLength(2);
    expect(texts((ul.children[0] as { type: 'element'; el: ImportedNode }).el.children)).toBe('one');
  });

  it('ignores stray closing tags', () => {
    const roots = parseHtmlFragment('</div><div>t</div></span>');
    expect(roots).toHaveLength(1);
    expect(texts(roots[0].children)).toBe('t');
  });

  it('keeps text outside any root element as a synthetic span node', () => {
    const roots = parseHtmlFragment('loose text');
    expect(roots).toHaveLength(1);
    expect(roots[0].tag).toBe('span');
    expect(texts(roots[0].children)).toBe('loose text');
  });

  it('treats a bare malformed "<" as literal text', () => {
    const roots = parseHtmlFragment('a < b');
    expect(roots).toHaveLength(1);
    expect(texts(roots[0].children)).toBe('a < b');
  });

  it('treats void tags (img/br/hr/input) as complete elements', () => {
    const roots = parseHtmlFragment('<div><img src="/a.png"><br><hr><input type="text"></div>');
    const tags = (roots[0].children as Array<{ type: string; el?: ImportedNode }>)
      .filter((c) => c.type === 'element')
      .map((c) => (c as { el: ImportedNode }).el.tag);
    expect(tags).toEqual(['img', 'br', 'hr', 'input']);
  });

  it('never produces a node named script/style regardless of case', () => {
    const roots = parseHtmlFragment('<SCRIPT>x</SCRIPT><DIV>y</DIV>');
    const tags = roots.map((r) => r.tag);
    expect(tags).toEqual(['div']);
    expect(texts(roots[0].children)).toBe('y');
  });
});

// ---- Entity decoding ---------------------------------------------------------

describe('html-import: entity decoding', () => {
  it('decodes the named set', () => {
    expect(decodeEntities('&amp;')).toBe('&');
    expect(decodeEntities('&lt;')).toBe('<');
    expect(decodeEntities('&gt;')).toBe('>');
    expect(decodeEntities('&quot;')).toBe('"');
    expect(decodeEntities('&#39;')).toBe("'");
    expect(decodeEntities('&nbsp;')).toBe('\u00a0');
  });

  it('decodes numeric decimal and hex entities', () => {
    expect(decodeEntities('&#65;&#66;')).toBe('AB');
    expect(decodeEntities('&#x41;&#x42;')).toBe('AB');
  });

  it('leaves unknown entities as empty (dropped, not passed through)', () => {
    expect(decodeEntities('&bogus;')).toBe('');
    expect(decodeEntities('plain')).toBe('plain');
  });

  it('decodes entities inside attribute values', () => {
    const [a] = parseHtmlFragment('<a href="/x?a=1&amp;b=2">l</a>');
    expect(a.attrs.href).toBe('/x?a=1&b=2');
  });
});

// ---- URL scheme whitelist ------------------------------------------------------

describe('html-import: isSafeUrl', () => {
  it('allows the whitelisted schemes', () => {
    expect(isSafeUrl('http://x')).toBe(true);
    expect(isSafeUrl('https://x')).toBe(true);
    expect(isSafeUrl('//x')).toBe(true);
    expect(isSafeUrl('/x')).toBe(true);
    expect(isSafeUrl('./x')).toBe(true);
    expect(isSafeUrl('../x')).toBe(true);
    expect(isSafeUrl('#frag')).toBe(true);
    expect(isSafeUrl('data:image/png;base64,xx')).toBe(true);
  });

  it('blocks dangerous schemes', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeUrl('JAVASCRIPT:alert(1)')).toBe(false);
    expect(isSafeUrl('vbscript:x')).toBe(false);
    expect(isSafeUrl('data:text/html,x')).toBe(false);
    expect(isSafeUrl('mailto:x')).toBe(false);
    expect(isSafeUrl('file:///etc/passwd')).toBe(false);
  });
});

// ---- Converter: element → .pen mapping ----------------------------------------

describe('html-import: converter mapping', () => {
  it('maps div → frame with fit_content sizing when it has children', () => {
    const nodes = htmlToPenTree(parseHtmlFragment('<div><p>a</p></div>'));
    expect(nodes).toHaveLength(1);
    const frame = nodes[0] as { type: string; width: unknown; height: unknown; children?: PenChild[] };
    expect(frame.type).toBe('frame');
    expect(frame.width).toBe('fit_content');
    expect(frame.height).toBe('fit_content');
    expect(frame.children).toHaveLength(1);
  });

  it('maps display:flex + flex-direction → .pen layout fields', () => {
    const nodes = htmlToPenTree(parseHtmlFragment(
      '<div style="display:flex;flex-direction:column;gap:12px;padding:16px;justify-content:center;align-items:center"></div>',
    ));
    const frame = nodes[0] as unknown as Record<string, unknown>;
    expect(frame.layout).toBe('vertical');
    expect(frame.gap).toBe(12);
    expect(frame.padding).toBe(16);
    expect(frame.justifyContent).toBe('center');
    expect(frame.alignItems).toBe('center');
  });

  it('maps flex-direction:row → horizontal', () => {
    const nodes = htmlToPenTree(parseHtmlFragment('<div style="display:flex"></div>'));
    expect((nodes[0] as unknown as Record<string, unknown>).layout).toBe('horizontal');
  });

  it('maps h1 → text node with fontSize 32 / fontWeight 600', () => {
    const nodes = htmlToPenTree(parseHtmlFragment('<h1>Title here</h1>'));
    const t = nodes[0] as unknown as Record<string, unknown>;
    expect(t.type).toBe('text');
    expect(t.fontSize).toBe(32);
    expect(t.fontWeight).toBe('600');
    expect(t.content).toBe('Title here');
  });

  it('maps h2..h6 to their scale (24/20/18/16/14)', () => {
    for (const [tag, size] of [['h2', 24], ['h3', 20], ['h4', 18], ['h5', 16], ['h6', 14]] as const) {
      const nodes = htmlToPenTree(parseHtmlFragment(`<${tag}>x</${tag}>`));
      expect((nodes[0] as unknown as Record<string, unknown>).fontSize).toBe(size);
    }
  });

  it('strong → fontWeight 700; em → fontStyle italic; text color → fill', () => {
    const strong = htmlToPenTree(parseHtmlFragment('<strong>bold</strong>'))[0] as unknown as Record<string, unknown>;
    expect(strong.fontWeight).toBe('700');
    const em = htmlToPenTree(parseHtmlFragment('<em>it</em>'))[0] as unknown as Record<string, unknown>;
    expect(em.fontStyle).toBe('italic');
    const colored = htmlToPenTree(parseHtmlFragment('<span style="color:#0ea5e9">c</span>'))[0] as unknown as Record<string, unknown>;
    expect(colored.fill).toBe('#0ea5e9');
  });

  it('maps ul → vertical frame with default gap 8; li text-only → text node', () => {
    const nodes = htmlToPenTree(parseHtmlFragment('<ul><li>a</li><li>b</li></ul>'));
    const ul = nodes[0] as unknown as Record<string, unknown> & { children: PenChild[] };
    expect(ul.layout).toBe('vertical');
    expect(ul.gap).toBe(8);
    expect(ul.children).toHaveLength(2);
    expect((ul.children[0] as unknown as Record<string, unknown>).type).toBe('text');
  });

  it('maps li with element children → nested frame', () => {
    const nodes = htmlToPenTree(parseHtmlFragment('<ul><li><span>x</span><span>y</span></li></ul>'));
    const li = ((nodes[0] as { children: PenChild[] }).children[0]) as unknown as Record<string, unknown>;
    expect(li.type).toBe('frame');
    expect((li.children as PenChild[]).length).toBe(2);
  });

  it('maps img → image fill node with width/height from attrs', () => {
    const nodes = htmlToPenTree(parseHtmlFragment('<img src="https://x/y.png" width="64" height="48" alt="logo">'));
    const img = nodes[0] as unknown as Record<string, any>;
    expect(img.type).toBe('rectangle');
    expect(img.fill).toEqual({ type: 'image', url: 'https://x/y.png', mode: 'fill' });
    expect(img.width).toBe(64);
    expect(img.height).toBe(48);
    expect(String(img.name)).toContain('img');
    expect(String(img.name)).toContain('logo');
  });

  it('maps img without dimensions → 100×100 default', () => {
    const nodes = htmlToPenTree(parseHtmlFragment('<img src="/a.png">'));
    const img = nodes[0] as unknown as Record<string, number>;
    expect(img.width).toBe(100);
    expect(img.height).toBe(100);
  });

  it('maps input → rectangle with cornerRadius 6, height 36', () => {
    const nodes = htmlToPenTree(parseHtmlFragment('<input type="email" placeholder="you@x.com">'));
    const input = nodes[0] as unknown as Record<string, number | string>;
    expect(input.type).toBe('rectangle');
    expect(input.cornerRadius).toBe(6);
    expect(input.height).toBe(36);
    expect(input.width).toBe(200);
  });

  it('maps hr → line node with width and stroke', () => {
    const nodes = htmlToPenTree(parseHtmlFragment('<hr style="width:200px;border-color:#cbd5e1">'));
    const hr = nodes[0] as unknown as Record<string, unknown>;
    expect(hr.type).toBe('line');
    expect(hr.width).toBe(200);
    expect(hr.stroke).toBe('#cbd5e1');
    expect(hr.x2).toBe(200);
  });

  it('maps br → newline in the parent text content', () => {
    const nodes = htmlToPenTree(parseHtmlFragment('<p>line one<br>line two</p>'));
    const t = nodes[0] as unknown as Record<string, string>;
    expect(t.content).toBe('line one\nline two');
  });

  it('skips svg/path subtrees and counts them', () => {
    const { nodes, stats } = htmlToPenTreeDetailed(
      parseHtmlFragment('<div><svg><path d="M0 0"/></svg><p>t</p></div>'),
    );
    expect(stats.skippedSvg).toBeGreaterThanOrEqual(1);
    const frame = nodes[0] as { children: PenChild[] };
    expect(frame.children).toHaveLength(1);
    expect((frame.children[0] as unknown as Record<string, unknown>).type).toBe('text');
  });
});

// ---- Converter: style → .pen visual fields --------------------------------------

describe('html-import: style mappings', () => {
  it('background/background-color → fill (colors only, gradients skipped)', () => {
    const solid = htmlToPenTree(parseHtmlFragment('<div style="background-color:#ffffff">x</div>'))[0] as unknown as Record<string, unknown>;
    expect(solid.fill).toBe('#ffffff');
    const grad = htmlToPenTree(parseHtmlFragment('<div style="background:linear-gradient(#fff,#000)">x</div>'))[0] as unknown as Record<string, unknown>;
    expect(grad.fill).toBeUndefined();
  });

  it('border-radius px → cornerRadius; 50% → 9999', () => {
    const r = htmlToPenTree(parseHtmlFragment('<div style="border-radius:12px">x</div>'))[0] as unknown as Record<string, unknown>;
    expect(r.cornerRadius).toBe(12);
    const pill = htmlToPenTree(parseHtmlFragment('<div style="border-radius:50%">x</div>'))[0] as unknown as Record<string, unknown>;
    expect(pill.cornerRadius).toBe(9999);
  });

  it('border shorthand → stroke + strokeWidth', () => {
    const n = htmlToPenTree(parseHtmlFragment('<div style="border:1px solid #e2e8f0">x</div>'))[0] as unknown as Record<string, unknown>;
    expect(n.stroke).toBe('#e2e8f0');
    expect(n.strokeWidth).toBe(1);
  });

  it('box-shadow → parsed shadow effect', () => {
    const n = htmlToPenTree(parseHtmlFragment('<div style="box-shadow:0 4px 6px -1px #0000001a">x</div>'))[0] as unknown as Record<string, any>;
    expect(n.effect).toMatchObject({
      type: 'shadow',
      shadowType: 'outer',
      offset: { x: 0, y: 4 },
      blur: 6,
      spread: -1,
      color: '#0000001a',
    });
  });

  it('inset box-shadow → inner shadow', () => {
    const n = htmlToPenTree(parseHtmlFragment('<div style="box-shadow:inset 0 2px 4px #000">x</div>'))[0] as unknown as Record<string, any>;
    expect(n.effect.shadowType).toBe('inner');
  });

  it('4-value padding → [top,right,bottom,left]', () => {
    const n = htmlToPenTree(parseHtmlFragment('<div style="padding:4px 8px 12px 16px">x</div>'))[0] as unknown as Record<string, unknown>;
    expect(n.padding).toEqual([4, 8, 12, 16]);
  });

  it('width/height px → fixed sizes (not fit_content)', () => {
    const n = htmlToPenTree(parseHtmlFragment('<div style="width:347px;height:200px">x</div>'))[0] as unknown as Record<string, unknown>;
    expect(n.width).toBe(347);
    expect(n.height).toBe(200);
  });

  it('opacity → opacity (clamped 0..1)', () => {
    const n = htmlToPenTree(parseHtmlFragment('<div style="opacity:0.5">x</div>'))[0] as unknown as Record<string, unknown>;
    expect(n.opacity).toBe(0.5);
  });

  it('font-size / font-weight / text-align / line-height / letter-spacing on text', () => {
    const n = htmlToPenTree(parseHtmlFragment(
      '<p style="font-size:18px;font-weight:700;text-align:center;line-height:1.5;letter-spacing:0.5px">t</p>',
    ))[0] as unknown as Record<string, unknown>;
    expect(n.fontSize).toBe(18);
    expect(n.fontWeight).toBe('700');
    expect(n.textAlign).toBe('center');
    expect(n.lineHeight).toBe(1.5);
    expect(n.letterSpacing).toBe(0.5);
  });

  it('ignores margins (v1 documented limitation) and multi-selector styles', () => {
    const n = htmlToPenTree(parseHtmlFragment('<div style="margin:24px;display:grid;grid-template-columns:1fr">x</div>'))[0] as unknown as Record<string, unknown>;
    expect(n.layout).toBeUndefined(); // grid is not flex
    expect((n as any).margin).toBeUndefined();
  });
});

// ---- Converter: naming + stats ---------------------------------------------------

describe('html-import: naming and stats', () => {
  it('names nodes namePrefix-tag-slug', () => {
    const nodes = htmlToPenTree(parseHtmlFragment('<h2>Monthly Revenue</h2>'), { namePrefix: 'card' });
    expect((nodes[0] as unknown as Record<string, unknown>).name).toBe('card-h2-monthly-revenue');
  });

  it('defaults the prefix to "html"', () => {
    const nodes = htmlToPenTree(parseHtmlFragment('<div>t</div>'));
    expect((nodes[0] as unknown as Record<string, unknown>).name).toBe('html-div-t');
  });

  it('gives every node a unique id', () => {
    const nodes = flattenPen(htmlToPenTree(parseHtmlFragment('<div><p>a</p><p>b</p></div>')));
    const ids = new Set(nodes.map((n) => n.id));
    expect(ids.size).toBe(nodes.length);
    expect(nodes.length).toBe(3);
  });

  it('stats count nodes by type', () => {
    const { stats } = htmlToPenTreeDetailed(
      parseHtmlFragment('<div><h1>t</h1><ul><li>a</li></ul></div>'),
    );
    expect(stats.nodeCount).toBe(4);
    expect(stats.typeCounts.frame).toBe(2); // div + ul
    expect(stats.typeCounts.text).toBe(2); // h1 + li (text-only)
  });
});
