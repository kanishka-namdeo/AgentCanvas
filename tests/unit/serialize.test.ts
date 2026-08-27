// Tests for src/lib/canvas/serialize.ts (spec §5.3 — copy-as-code v2).
//
// Builds a small .pen document (frame with auto-layout + text + rect + image
// + a loose absolute rect), resolves it with `resolvePenTreeDetailed`, and
// asserts the three framework outputs: nested flex markup (not flat
// absolutes), JSX shape, and Tailwind class candidates + arbitrary values.

import { describe, it, expect } from 'vitest';
import { serializeNodes } from '@/lib/canvas/serialize';
import { resolvePenTreeDetailed } from '@/lib/pen/resolve';
import type { CanvasDocument } from '@/lib/canvas/types';
import type { PenChild } from '@/lib/pen/types';
import type { Shape } from '@/lib/canvas/types';

// ---- Fixture -----------------------------------------------------------------

function makeDoc(): CanvasDocument {
  const children: PenChild[] = [
    {
      id: 'card',
      type: 'frame',
      name: 'Card',
      x: 100,
      y: 80,
      width: 347,
      height: 220,
      fill: '#ffffff',
      cornerRadius: 12,
      layout: 'vertical',
      gap: 12,
      padding: 16,
      children: [
        {
          id: 'title',
          type: 'text',
          name: 'Title',
          content: 'Monthly revenue',
          fontSize: 24,
          fontWeight: '600',
          fill: '#0f172a',
          x: 0,
          y: 0,
          width: 200,
          height: 32,
          textGrowth: 'fixed-width',
        } as PenChild,
        {
          id: 'body',
          type: 'text',
          name: 'Body',
          content: 'Up 18% this month',
          fontSize: 14,
          fill: '#475569',
          x: 0,
          y: 0,
          width: 180,
          height: 20,
          textGrowth: 'fixed-width',
        } as PenChild,
        {
          id: 'bar',
          type: 'rectangle',
          name: 'Bar',
          x: 0,
          y: 0,
          width: 120,
          height: 12,
          fill: '#0ea5e9',
          cornerRadius: 6,
        } as PenChild,
        {
          id: 'photo',
          type: 'rectangle',
          name: 'Photo',
          x: 0,
          y: 0,
          width: 80,
          height: 60,
          fill: { type: 'image', url: 'https://example.com/p.png', mode: 'fill' },
        } as PenChild,
      ],
    } as PenChild,
    // Loose absolute node at root (layout:none semantics).
    {
      id: 'loose',
      type: 'rectangle',
      name: 'Loose',
      x: 500,
      y: 90,
      width: 40,
      height: 40,
      fill: '#ef4444',
    } as PenChild,
  ];
  return {
    id: 'doc-1',
    name: 'Test',
    version: '2.17',
    background: '#ffffff',
    viewport: { zoom: 1, panX: 0, panY: 0 },
    children,
    shapes: [],
    tokens: { colors: [], textStyles: [] },
  };
}

function resolved() {
  const doc = makeDoc();
  return resolvePenTreeDetailed(doc);
}

// ---- html ----------------------------------------------------------------------

describe('serialize: html framework', () => {
  it('emits a nested flex div with gap + padding for auto-layout containers', () => {
    const { tree } = resolved();
    const html = serializeNodes(tree, { framework: 'html' });
    expect(html).toContain('display:flex');
    expect(html).toContain('flex-direction:column');
    expect(html).toContain('gap:12px');
    expect(html).toContain('padding:16px');
    // Children of the flex frame are FLEX ITEMS — no absolute positioning.
    const titleStart = html.indexOf('data-node-id="title"');
    const titleLine = html.slice(titleStart, html.indexOf('</span>', titleStart));
    expect(titleLine).not.toContain('position:absolute');
  });

  it('carries data-name and data-node-id on every element', () => {
    const { tree } = resolved();
    const html = serializeNodes(tree, { framework: 'html' });
    expect(html).toContain('data-name="Card" data-node-id="card"');
    expect(html).toContain('data-name="Title" data-node-id="title"');
    expect(html).toContain('data-name="Loose" data-node-id="loose"');
  });

  it('renders text content and typography', () => {
    const { tree } = resolved();
    const html = serializeNodes(tree, { framework: 'html' });
    expect(html).toContain('Monthly revenue');
    expect(html).toContain('font-size:24px');
    expect(html).toContain('font-weight:600');
    expect(html).toContain('color:#0f172a');
  });

  it('renders the image node as <img> with its src', () => {
    const { tree } = resolved();
    const html = serializeNodes(tree, { framework: 'html' });
    expect(html).toContain('<img');
    expect(html).toContain('src="https://example.com/p.png"');
  });

  it('keeps loose (layout:none) nodes absolutely positioned inside a relative wrapper', () => {
    const { tree } = resolved();
    const html = serializeNodes(tree, { framework: 'html' });
    expect(html).toContain('position:relative');
    const looseStart = html.indexOf('data-node-id="loose"');
    const looseBlock = html.slice(looseStart, html.indexOf('></div>', looseStart));
    expect(looseBlock).toContain('position:absolute');
    expect(looseBlock).toContain('left:400px'); // 500 - minX(100)
    expect(looseBlock).toContain('background:#ef4444');
  });

  it('escapes HTML in text content', () => {
    const doc = makeDoc();
    (doc.children[0] as { children: PenChild[] }).children[0] = {
      ...(doc.children[0] as { children: PenChild[] }).children[0],
      content: '<script>alert(1)</script>',
    } as PenChild;
    const { tree } = resolvePenTreeDetailed(doc);
    const html = serializeNodes(tree, { framework: 'html' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('emits var(--acv-key, fallback) for token-bound fills', () => {
    const { layers } = resolved();
    const bound: Shape[] = layers.map((s) =>
      s.id === 'bar' ? { ...s, tokenBinding: { fillToken: 'color.primary' } } : s,
    );
    const html = serializeNodes(bound, { framework: 'html' });
    expect(html).toContain('var(--acv-color-primary, #0ea5e9)');
  });
});

// ---- react ----------------------------------------------------------------------

describe('serialize: react framework', () => {
  it('emits a valid JSX component shape', () => {
    const { tree } = resolved();
    const jsx = serializeNodes(tree, { framework: 'react', rootName: 'Card' });
    expect(jsx.startsWith('export function Card()')).toBe(true);
    expect(jsx).toContain('style={{');
    expect(jsx).toContain("position: 'relative'");
    expect(jsx).toContain("'flex-direction': 'column'");
    expect(jsx).toContain("gap: '12px'");
    expect(jsx).toContain('data-name="Card" data-node-id="card"');
    expect(jsx).toContain('Monthly revenue');
    expect(jsx.trim().endsWith('}')).toBe(true);
  });

  it('pascal-cases the root name', () => {
    const { tree } = resolved();
    const jsx = serializeNodes(tree, { framework: 'react', rootName: 'monthly card' });
    expect(jsx).toContain('export function MonthlyCard()');
  });

  it('emits JS string children for text containing JSX-special characters', () => {
    const doc = makeDoc();
    (doc.children[0] as { children: PenChild[] }).children[0] = {
      ...(doc.children[0] as { children: PenChild[] }).children[0],
      content: 'a { b < c',
    } as PenChild;
    const { tree } = resolvePenTreeDetailed(doc);
    const jsx = serializeNodes(tree, { framework: 'react' });
    expect(jsx).toContain(`{'a { b < c'}`);
  });
});

// ---- tailwind -------------------------------------------------------------------

describe('serialize: tailwind framework', () => {
  it('maps flex + gap + padding to scale classes', () => {
    const { tree } = resolved();
    const tw = serializeNodes(tree, { framework: 'tailwind' });
    expect(tw).toContain('flex');
    expect(tw).toContain('flex-col');
    expect(tw).toContain('gap-3'); // 12px
    expect(tw).toContain('p-4'); // 16px
    expect(tw).toContain('rounded-xl'); // 12px radius
  });

  it('uses arbitrary values for odd sizes', () => {
    const { tree } = resolved();
    const tw = serializeNodes(tree, { framework: 'tailwind' });
    expect(tw).toContain('w-[347px]');
    expect(tw).toContain('h-[220px]');
    expect(tw).toContain('left-[400px]');
  });

  it('maps common design-system colors to named classes', () => {
    const { tree } = resolved();
    const tw = serializeNodes(tree, { framework: 'tailwind' });
    expect(tw).toContain('bg-sky-500'); // #0ea5e9
    expect(tw).toContain('text-slate-900'); // #0f172a
    expect(tw).toContain('bg-red-500'); // #ef4444
  });

  it('maps typography to text classes', () => {
    const { tree } = resolved();
    const tw = serializeNodes(tree, { framework: 'tailwind' });
    expect(tw).toContain('text-[24px]');
    expect(tw).toContain('font-semibold');
  });

  it('keeps var() token bindings as arbitrary color values', () => {
    const { layers } = resolved();
    const bound: Shape[] = layers.map((s) =>
      s.id === 'bar' ? { ...s, tokenBinding: { fillToken: 'color.primary' } } : s,
    );
    const tw = serializeNodes(bound, { framework: 'tailwind' });
    expect(tw).toContain('bg-[color:var(--acv-color-primary');
  });
});

// ---- flat-layer input path --------------------------------------------------------

describe('serialize: flat Shape[] input (client export path)', () => {
  it('rebuilds the tree from parentId links and matches the tree-path output', () => {
    const { tree, layers } = resolved();
    const fromTree = serializeNodes(tree, { framework: 'html' });
    const fromLayers = serializeNodes(layers, { framework: 'html' });
    expect(fromLayers).toBe(fromTree);
  });

  it('uses layer.autoLayout when no .pen node is available', () => {
    const { layers } = resolved();
    const card = layers.find((s) => s.id === 'card')!;
    expect(card.autoLayout).toMatchObject({ direction: 'vertical', gap: 12 });
    const tw = serializeNodes(layers, { framework: 'tailwind' });
    expect(tw).toContain('flex-col');
    expect(tw).toContain('gap-3');
  });
});

// ---- subtree scoping -----------------------------------------------------------------

describe('serialize: subtree scoping', () => {
  it('serializes a single subtree when given one tree node', () => {
    const { tree } = resolved();
    const card = tree.find((n) => n.layer.id === 'card')!;
    const html = serializeNodes([card], { framework: 'html' });
    expect(html).toContain('data-node-id="card"');
    expect(html).not.toContain('data-node-id="loose"');
    // Scoped bbox: the wrapper starts at the card, so no 400px offset.
    expect(html).not.toContain('left:400px');
  });
});
