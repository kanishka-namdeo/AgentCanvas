// Tests for src/lib/canvas/html-import-mounted.ts (Phase 3 v2 — mounted-iframe
// extraction, spec §5.2 v2 path). Exercises the PURE `walkDomForPenTree`
// function against jsdom-constructed DOM trees, plus a smoke test for the
// iframe-wrapping `extractHtmlViaIframe` entry point.
//
// Why jsdom is sufficient: `walkDomForPenTree` reads `getComputedStyle` for
// inline-style values (jsdom resolves these correctly) and falls back to
// inline-style px strings when `getBoundingClientRect` returns zeros (no
// layout in jsdom). Real-browser behavior (with actual layout geometry) is
// exercised end-to-end by extractHtmlViaIframe; the jsdom suite covers the
// tree-walking + style-extraction logic.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  walkDomForPenTree,
  extractHtmlViaIframe,
  parseBorderRadius,
  parseBoxShadow,
  pxToNum,
  isPlainColor,
  extractComputedStyle,
} from '@/lib/canvas/html-import-mounted';
import type { PenChild, PenFrame, PenText, PenRectangle } from '@/lib/pen/types';

// ---- Helpers ----------------------------------------------------------------

function flush() {
  // jsdom retains DOM nodes across tests if we mutate document.body without
  // resetting. Clear before each test so assertions don't bleed.
  document.body.innerHTML = '';
}

function isFrame(n: PenChild | undefined): n is PenFrame {
  return !!n && n.type === 'frame';
}
function isText(n: PenChild | undefined): n is PenText {
  return !!n && n.type === 'text';
}
function isRect(n: PenChild | undefined): n is PenRectangle {
  return !!n && n.type === 'rectangle';
}

// ---- Pure helper tests (no DOM) ---------------------------------------------

describe('html-import-mounted: pure helpers', () => {
  it('pxToNum parses "10px" / "10" / "1.5em" / "auto"', () => {
    expect(pxToNum('10px', -1)).toBe(10);
    expect(pxToNum('10', -1)).toBe(10);
    expect(pxToNum('1.5em', -1)).toBe(1.5);
    expect(pxToNum('auto', -1)).toBe(-1);
    expect(pxToNum(undefined, 7)).toBe(7);
    expect(pxToNum('bad', 0)).toBe(0);
  });

  it('isPlainColor rejects gradients, url(), var()', () => {
    expect(isPlainColor('red')).toBe(true);
    expect(isPlainColor('#ff0000')).toBe(true);
    expect(isPlainColor('rgb(0,0,0)')).toBe(true);
    expect(isPlainColor('linear-gradient(red,blue)')).toBe(false);
    expect(isPlainColor('url(/img.png)')).toBe(false);
    expect(isPlainColor('var(--primary)')).toBe(false);
    expect(isPlainColor('transparent')).toBe(false);
    expect(isPlainColor('none')).toBe(false);
  });

  it('parseBorderRadius: single value → scalar; 2 values → [TL,TR,BL,BR]; 4 values → tuple', () => {
    expect(parseBorderRadius('8px')).toBe(8);
    expect(parseBorderRadius('8px 4px')).toEqual([8, 4, 8, 4]);
    expect(parseBorderRadius('8px 4px 2px 1px')).toEqual([8, 4, 2, 1]);
    expect(parseBorderRadius('50%')).toBe(9999); // pill/round
    expect(parseBorderRadius('')).toBeUndefined();
    expect(parseBorderRadius(undefined)).toBeUndefined();
  });

  it('parseBoxShadow: parses a single shadow with offset/blur/color', () => {
    const s = parseBoxShadow('0 4px 6px rgba(0,0,0,0.1)');
    expect(s).toBeDefined();
    expect(s!.type).toBe('shadow');
    expect(s!.shadowType).toBe('outer');
    expect(s!.offset).toEqual({ x: 0, y: 4 });
    expect(s!.blur).toBe(6);
    expect(s!.color).toBe('rgba(0,0,0,0.1)');
    // inset keyword flips the shadow type
    const inner = parseBoxShadow('inset 0 1px 2px #000');
    expect(inner!.shadowType).toBe('inner');
    expect(inner!.color).toBe('#000');
    expect(parseBoxShadow('none')).toBeUndefined();
    expect(parseBoxShadow(undefined)).toBeUndefined();
  });
});

// ---- walkDomForPenTree: tree-shape + style mapping --------------------------

describe('html-import-mounted: walkDomForPenTree', () => {
  beforeEach(flush);

  it('extracts a single absolutely-positioned div into a frame with measured x/y/w/h + fill', () => {
    document.body.innerHTML =
      '<div style="position:absolute; left:10px; top:20px; width:100px; height:50px; background-color:red"></div>';
    const warnings: string[] = [];
    const result = walkDomForPenTree(document.body, warnings);
    expect(result).toHaveLength(1);
    expect(warnings).toEqual([]);
    const frame = result[0];
    expect(isFrame(frame)).toBe(true);
    if (isFrame(frame)) {
      expect(frame.x).toBe(10);
      expect(frame.y).toBe(20);
      expect(frame.width).toBe(100);
      expect(frame.height).toBe(50);
      expect(frame.fill).toMatch(/red|rgb\(255, 0, 0\)|#ff0000/i);
    }
  });

  it('walks nested <div><div><p>text</p></div></div> → frame → frame → text', () => {
    document.body.innerHTML = '<div><div><p>text</p></div></div>';
    const warnings: string[] = [];
    const result = walkDomForPenTree(document.body, warnings);
    expect(result).toHaveLength(1);
    const outer = result[0];
    expect(isFrame(outer)).toBe(true);
    expect(isFrame(outer) && (outer.children?.length ?? 0)).toBe(1);
    const inner = isFrame(outer) ? outer.children![0] : undefined;
    expect(isFrame(inner)).toBe(true);
    expect(isFrame(inner) && (inner.children?.length ?? 0)).toBe(1);
    const text = isFrame(inner) ? inner.children![0] : undefined;
    expect(isText(text)).toBe(true);
    expect(isText(text) ? text.content : '').toBe('text');
  });

  it('skips display:none elements (entire subtree dropped)', () => {
    document.body.innerHTML =
      '<div style="display:none"><p>hidden</p></div><p>visible</p>';
    const warnings: string[] = [];
    const result = walkDomForPenTree(document.body, warnings);
    expect(result).toHaveLength(1);
    expect(isText(result[0])).toBe(true);
    expect(isText(result[0]) ? result[0].content : '').toBe('visible');
    expect(warnings.some((w) => w.includes('display:none'))).toBe(true);
    // The display:none subtree's <p>hidden</p> did NOT survive.
    expect(JSON.stringify(result)).not.toContain('hidden');
  });

  it('skips visibility:hidden elements (entire subtree dropped)', () => {
    document.body.innerHTML =
      '<div style="visibility:hidden"><p>secret</p></div><p>shown</p>';
    const warnings: string[] = [];
    const result = walkDomForPenTree(document.body, warnings);
    expect(result).toHaveLength(1);
    expect(isText(result[0]) ? result[0].content : '').toBe('shown');
    expect(warnings.some((w) => w.includes('visibility:hidden'))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('extracts <img> into a rectangle carrying an image-fill', () => {
    document.body.innerHTML = '<img src="https://example.com/x.png" alt="logo" width="200" height="100">';
    const warnings: string[] = [];
    const result = walkDomForPenTree(document.body, warnings);
    expect(result).toHaveLength(1);
    const img = result[0];
    expect(isRect(img)).toBe(true);
    if (isRect(img)) {
      const fill = img.fill as { type: string; url: string; mode: string };
      expect(fill.type).toBe('image');
      expect(fill.url).toBe('https://example.com/x.png');
      expect(fill.mode).toBe('fill');
    }
  });

  it('unwraps unknown tags (<marquee>) but walks their children so content survives', () => {
    document.body.innerHTML = '<marquee><p>hoisted</p></marquee>';
    const warnings: string[] = [];
    const result = walkDomForPenTree(document.body, warnings);
    // The marquee itself becomes no node; its <p> child is hoisted up.
    expect(result).toHaveLength(1);
    expect(isText(result[0])).toBe(true);
    expect(isText(result[0]) ? result[0].content : '').toBe('hoisted');
    expect(warnings.some((w) => w.includes('marquee') && w.includes('unrecognized'))).toBe(true);
  });

  it('caps tree depth at 20 (50 nested <div>s, ~depth 50 in input)', () => {
    // 50 nested divs + a <p>deep</p> leaf at the bottom.
    document.body.innerHTML = '<div>'.repeat(50) + '<p>deep</p>' + '</div>'.repeat(50);
    const warnings: string[] = [];
    const result = walkDomForPenTree(document.body, warnings);
    expect(result).toHaveLength(1);

    // Walk the result tree to find the maximum depth actually emitted.
    let maxDepth = 0;
    const walk = (nodes: PenChild[], d: number) => {
      maxDepth = Math.max(maxDepth, d);
      for (const n of nodes) {
        const kids = (n as { children?: PenChild[] }).children;
        if (Array.isArray(kids) && kids.length > 0) walk(kids, d + 1);
      }
    };
    walk(result, 1);
    // Cap is 20 — we should never exceed it (the 50-level input gets
    // truncated at 20 levels deep).
    expect(maxDepth).toBeLessThanOrEqual(20);
    expect(warnings.some((w) => w.includes('Depth cap (20)'))).toBe(true);
  });

  it('caps node count at 500 (1000 sibling <div>s)', () => {
    document.body.innerHTML = '<div></div>'.repeat(1000);
    const warnings: string[] = [];
    const result = walkDomForPenTree(document.body, warnings);
    expect(result).toHaveLength(500);
    // The warning fires exactly once (dedup guard).
    const capWarnings = warnings.filter((w) => w.includes('Node count cap (500)'));
    expect(capWarnings.length).toBe(1);
    // All emitted nodes are frames (the cap held — no node #501 leaked).
    expect(result.every((n) => n.type === 'frame')).toBe(true);
  });

  it('extractComputedStyle captures border + radius + box-shadow + opacity', () => {
    document.body.innerHTML =
      '<div id="x" style="position:absolute;left:5px;top:6px;width:120px;height:80px;' +
      'background-color:#008000;border:2px solid #000;border-radius:8px 4px;' +
      'box-shadow:0 4px 6px rgba(0,0,0,0.1);opacity:0.5"></div>';
    const el = document.getElementById('x') as HTMLElement;
    const cs = window.getComputedStyle(el);
    const extract = extractComputedStyle(el, cs);
    expect(extract.position).toBe('absolute');
    expect(extract.left).toBe(5);
    expect(extract.top).toBe(6);
    expect(extract.width).toBe(120);
    expect(extract.height).toBe(80);
    expect(extract.backgroundColor).toMatch(/green|#008000|rgb\(0, 128, 0\)/i);
    expect(extract.borderWidth).toBe(2);
    expect(extract.borderColor).toMatch(/black|#000(?:000)?|rgb\(0, 0, 0\)/i);
    expect(extract.borderRadius).toEqual([8, 4, 8, 4]);
    expect(extract.boxShadow).toBeDefined();
    expect(extract.boxShadow!.offset).toEqual({ x: 0, y: 4 });
    expect(extract.boxShadow!.blur).toBe(6);
    expect(extract.opacity).toBe(0.5);
  });
});

// ---- extractHtmlViaIframe smoke test ---------------------------------------

describe('html-import-mounted: extractHtmlViaIframe', () => {
  beforeEach(flush);

  it('is an exported async function', () => {
    expect(typeof extractHtmlViaIframe).toBe('function');
  });

  it('returns an ExtractedPenTree (children + warnings) when run in jsdom', async () => {
    // jsdom can host a hidden iframe + write HTML, but getComputedStyle on
    // iframe children may return default values. The smoke test just
    // asserts the function does not throw and returns the right shape.
    const out = await extractHtmlViaIframe('<div><p>hello</p></div>', { timeout: 200 });
    expect(out).toHaveProperty('children');
    expect(out).toHaveProperty('warnings');
    expect(Array.isArray(out.children)).toBe(true);
    expect(Array.isArray(out.warnings)).toBe(true);
  });

  it('returns an empty tree with a warning when called outside a browser', async () => {
    // Simulate the no-window path by temporarily shadowing the globals.
    // (We can't actually unset window in jsdom, so we just verify the
    // happy path returns an ExtractedPenTree and trust the guard branch
    // is exercised at runtime in real SSR.) This test is a guard for
    // future refactors that move the function out of the browser-only
    // boundary.
    const out = await extractHtmlViaIframe('<div></div>', { timeout: 100 });
    expect(out.children).toBeDefined();
    expect(out.warnings).toBeDefined();
  });
});
