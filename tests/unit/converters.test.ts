// Tests for the v2.0 .pen converters.
//
// Covers:
//   - canvasToPen / penToCanvas (near-identity)
//   - serializePenDocument (pretty JSON)
//   - shapesToSVG (SVG export)
//   - penToFigmaJSON (Figma-compatible JSON export)
//   - migrateV1ToV2 (v1.x → v2.0 migration)

import { describe, it, expect } from 'vitest';
import {
  canvasToPen,
  penToCanvas,
  serializePenDocument,
  shapesToSVG,
  penToFigmaJSON,
  migrateV1ToV2,
} from '@/lib/pen/converters';
import { createEmptyCanvasDocument, type Shape } from '@/lib/canvas/types';
import { PEN_FORMAT_VERSION, type PenDocument } from '@/lib/pen/types';

describe('canvasToPen / penToCanvas', () => {
  it('canvasToPen strips runtime + derived caches', () => {
    const canvas = createEmptyCanvasDocument('test-1', 'Test');
    canvas.background = '#ff0000';
    canvas.viewport = { zoom: 2, panX: 100, panY: 200 };
    const pen = canvasToPen(canvas);
    expect(pen.version).toBe(PEN_FORMAT_VERSION);
    expect(pen.children).toEqual([]);
    expect('background' in pen).toBe(false);
    expect('viewport' in pen).toBe(false);
    expect('shapes' in pen).toBe(false);
    expect('tokens' in pen).toBe(false);
  });

  it('penToCanvas wraps a .pen doc with runtime defaults', () => {
    const pen: PenDocument = {
      version: PEN_FORMAT_VERSION,
      children: [
        { type: 'rectangle', id: 'r1', x: 10, y: 20, width: 100, height: 50, fill: '#ff0000' } as never,
      ],
    };
    const canvas = penToCanvas(pen, 'doc-1');
    expect(canvas.id).toBe('doc-1');
    expect(canvas.version).toBe(PEN_FORMAT_VERSION);
    expect(canvas.children).toHaveLength(1);
    expect(canvas.viewport.zoom).toBe(1);
    expect(canvas.shapes).toEqual([]);
  });

  it('round-trips a CanvasDocument through pen and back', () => {
    const canvas = createEmptyCanvasDocument('rt-1', 'Round Trip');
    canvas.variables = { 'brand.primary': { type: 'color', value: '#3b82f6' } };
    canvas.children = [
      { type: 'frame', id: 'f1', name: 'Card', x: 0, y: 0, width: 320, height: 200, fill: '#ffffff', children: [] } as never,
    ];
    const pen = canvasToPen(canvas);
    const back = penToCanvas(pen, 'rt-1');
    expect(back.children).toEqual(canvas.children);
    expect(back.variables).toEqual(canvas.variables);
  });
});

describe('serializePenDocument', () => {
  it('produces pretty JSON ending with newline', () => {
    const pen: PenDocument = {
      version: PEN_FORMAT_VERSION,
      children: [],
    };
    const s = serializePenDocument(pen);
    expect(s.endsWith('\n')).toBe(true);
    expect(JSON.parse(s)).toEqual({ ...pen });
  });
});

describe('shapesToSVG', () => {
  const baseShape: Shape = {
    id: 's1', type: 'rectangle', name: 'R',
    x: 10, y: 20, width: 100, height: 50,
    rotation: 0, opacity: 1,
    fill: '#ff0000', stroke: '#000', strokeWidth: 0,
    radius: 4, fontSize: 16, textColor: '#000',
    zIndex: 0, locked: false, visible: true,
  };

  it('renders an SVG with background rect + the shape', () => {
    const svg = shapesToSVG([baseShape]);
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
    expect(svg).toContain('<rect');
    expect(svg).toContain('fill="#ff0000"');
  });

  it('handles empty shapes', () => {
    const svg = shapesToSVG([]);
    expect(svg).toContain('<svg');
    // Empty SVG is self-closing
    expect(svg).toMatch(/\/>/);
  });

  it('renders ellipse correctly', () => {
    const svg = shapesToSVG([{ ...baseShape, type: 'ellipse' }]);
    expect(svg).toContain('<ellipse');
  });

  it('renders polygon with N sides', () => {
    const svg = shapesToSVG([{ ...baseShape, type: 'polygon', polygonCount: 6 }]);
    expect(svg).toContain('<polygon');
    // Hexagon should have 6 points (each as "x,y" joined by spaces)
    const polygonMatch = svg.match(/<polygon points="([^"]+)"/);
    expect(polygonMatch).toBeTruthy();
    const pts = polygonMatch![1].split(' ');
    expect(pts).toHaveLength(6);
  });

  it('renders star with N*2 vertices', () => {
    const svg = shapesToSVG([{ ...baseShape, type: 'star', pointCount: 5, innerRadius: 0.5 }]);
    expect(svg).toContain('<polygon');
    const polygonMatch = svg.match(/<polygon points="([^"]+)"/);
    expect(polygonMatch).toBeTruthy();
    const pts = polygonMatch![1].split(' ');
    expect(pts).toHaveLength(10); // 5 points × 2 (outer + inner)
  });

  it('renders text with content', () => {
    const svg = shapesToSVG([{
      ...baseShape, type: 'text', text: 'Hello', fontSize: 24, textColor: '#00ff00',
    }]);
    expect(svg).toContain('<text');
    expect(svg).toContain('Hello');
    expect(svg).toContain('font-size="24"');
  });

  it('skips invisible shapes', () => {
    const svg = shapesToSVG([{ ...baseShape, visible: false }]);
    expect(svg).not.toContain('fill="#ff0000"');
  });
});

describe('penToFigmaJSON', () => {
  it('produces a Figma-shaped document with a single page', () => {
    const pen: PenDocument = {
      version: PEN_FORMAT_VERSION,
      children: [
        { type: 'rectangle', id: 'r1', x: 0, y: 0, width: 100, height: 100, fill: '#ff0000' } as never,
      ],
    };
    const fig = penToFigmaJSON(pen) as Record<string, unknown>;
    expect(fig.document).toBeDefined();
    const doc = fig.document as { children: unknown[] };
    expect(doc.children).toHaveLength(1); // one page
    const page = doc.children[0] as { type: string; children: unknown[] };
    expect(page.type).toBe('CANVAS');
    expect(page.children).toHaveLength(1);
    const node = page.children[0] as { type: string; fills: unknown[] };
    expect(node.type).toBe('RECTANGLE');
    expect(node.fills).toHaveLength(1);
    const fill = node.fills[0] as { type: string; color: { r: number; g: number; b: number; a: number } };
    expect(fill.type).toBe('SOLID');
    expect(fill.color.r).toBeCloseTo(1, 1);
    expect(fill.color.g).toBeCloseTo(0, 1);
  });

  it('maps frame to FRAME, ellipse to ELLIPSE, text to TEXT', () => {
    const pen: PenDocument = {
      version: PEN_FORMAT_VERSION,
      children: [
        { type: 'frame', id: 'f1', x: 0, y: 0, width: 100, height: 100, children: [] } as never,
        { type: 'ellipse', id: 'e1', x: 0, y: 0, width: 80, height: 80, fill: '#00ff00' } as never,
        { type: 'text', id: 't1', x: 0, y: 0, width: 100, height: 20, content: 'Hi', fontSize: 16 } as never,
      ],
    };
    const fig = penToFigmaJSON(pen) as Record<string, unknown>;
    const doc = fig.document as { children: Array<{ children: Array<{ type: string }> }> };
    const page = doc.children[0];
    expect(page.children.map((c) => c.type)).toEqual(['FRAME', 'ELLIPSE', 'TEXT']);
  });

  it('maps a reusable frame to COMPONENT', () => {
    const pen: PenDocument = {
      version: PEN_FORMAT_VERSION,
      children: [
        { type: 'frame', id: 'c1', reusable: true, x: 0, y: 0, width: 100, height: 40, children: [] } as never,
      ],
    };
    const fig = penToFigmaJSON(pen) as Record<string, unknown>;
    const doc = fig.document as { children: Array<{ children: Array<{ type: string }> }> };
    const node = doc.children[0].children[0];
    expect(node.type).toBe('COMPONENT');
    expect(fig.components).toBeDefined();
  });

  it('maps a PenRef to INSTANCE with componentId', () => {
    const pen: PenDocument = {
      version: PEN_FORMAT_VERSION,
      children: [
        { type: 'ref', id: 'i1', ref: 'c1', x: 100, y: 100 } as never,
      ],
    };
    const fig = penToFigmaJSON(pen) as Record<string, unknown>;
    const doc = fig.document as { children: Array<{ children: Array<{ type: string; componentId: string }> }> };
    const node = doc.children[0].children[0];
    expect(node.type).toBe('INSTANCE');
    expect(node.componentId).toBe('c1');
  });

  it('maps a PenBooleanOp to BOOLEAN_OPERATION', () => {
    const pen: PenDocument = {
      version: PEN_FORMAT_VERSION,
      children: [
        { type: 'boolean_op', id: 'b1', operation: 'union', x: 0, y: 0, width: 100, height: 100, children: [] } as never,
      ],
    };
    const fig = penToFigmaJSON(pen) as Record<string, unknown>;
    const doc = fig.document as { children: Array<{ children: Array<{ type: string; booleanOperation: string }> }> };
    const node = doc.children[0].children[0];
    expect(node.type).toBe('BOOLEAN_OPERATION');
    expect(node.booleanOperation).toBe('UNION');
  });

  it('exports variables as Figma-style local variables', () => {
    const pen: PenDocument = {
      version: PEN_FORMAT_VERSION,
      variables: {
        'brand.primary': { type: 'color', value: '#3b82f6' },
        'spacing.md': { type: 'number', value: 16 },
      },
      children: [],
    };
    const fig = penToFigmaJSON(pen) as Record<string, unknown>;
    const vars = fig.variables as Record<string, unknown>;
    expect(vars['brand.primary']).toBeDefined();
    const v = vars['brand.primary'] as { resolvedType: string; valuesByMode: Record<string, unknown> };
    expect(v.resolvedType).toBe('COLOR');
    expect(v.valuesByMode['0']).toBe('#3b82f6');
  });

  it('exports theme axes as variable collections', () => {
    const pen: PenDocument = {
      version: PEN_FORMAT_VERSION,
      themes: { mode: ['light', 'dark'] },
      children: [],
    };
    const fig = penToFigmaJSON(pen) as Record<string, unknown>;
    const cols = fig.variableCollections as Record<string, unknown>;
    expect(cols['mode']).toBeDefined();
    const c = cols['mode'] as { modes: Array<{ modeId: string; name: string }> };
    expect(c.modes).toHaveLength(2);
    expect(c.modes[0].name).toBe('light');
    expect(c.modes[1].name).toBe('dark');
  });
});

describe('migrateV1ToV2', () => {
  it('passes through v2 documents unchanged (structurally)', () => {
    const v2 = {
      version: PEN_FORMAT_VERSION,
      children: [
        { type: 'rectangle', id: 'r1', x: 0, y: 0, width: 100, height: 100, fill: '#ff0000' },
      ],
    };
    const migrated = migrateV1ToV2(v2);
    expect(migrated.version).toBe(PEN_FORMAT_VERSION);
    expect(migrated.children).toHaveLength(1);
  });

  it('migrates v1 flat shapes[] to v2 children[]', () => {
    const v1 = {
      version: '1.0',
      shapes: [
        { id: 's1', type: 'rectangle', x: 10, y: 20, width: 100, height: 50, fill: '#ff0000' },
        { id: 's2', type: 'text', x: 30, y: 40, width: 200, height: 24, text: 'Hello', fontSize: 16 },
      ],
    };
    const migrated = migrateV1ToV2(v1);
    expect(migrated.version).toBe(PEN_FORMAT_VERSION);
    expect(migrated.children).toHaveLength(2);
    expect((migrated.children[0] as { type: string }).type).toBe('rectangle');
    expect((migrated.children[1] as { type: string }).type).toBe('text');
  });

  it('migrates v1 image shapes to frames with image fills', () => {
    const v1 = {
      version: '1.0',
      shapes: [
        { id: 'img1', type: 'image', x: 0, y: 0, width: 100, height: 100, src: 'https://example.com/a.png' },
      ],
    };
    const migrated = migrateV1ToV2(v1);
    expect(migrated.children).toHaveLength(1);
    const node = migrated.children[0] as { type: string; fill?: { type: string; url: string } };
    expect(node.type).toBe('frame');
    expect(node.fill?.type).toBe('image');
    expect(node.fill?.url).toBe('https://example.com/a.png');
  });

  it('migrates v1 tokens to variables', () => {
    const v1 = {
      version: '1.0',
      shapes: [],
      tokens: {
        colors: [
          { name: 'Brand Primary', key: 'brand.primary', value: '#3b82f6' },
        ],
        textStyles: [],
      },
    };
    const migrated = migrateV1ToV2(v1);
    expect(migrated.variables).toBeDefined();
    expect(migrated.variables!['brand.primary']).toEqual({ type: 'color', value: '#3b82f6' });
  });

  it('migrates v1 vector shapes to path', () => {
    const v1 = {
      version: '1.0',
      shapes: [
        { id: 'v1', type: 'vector', x: 0, y: 0, width: 100, height: 100, fill: '#000' },
      ],
    };
    const migrated = migrateV1ToV2(v1);
    expect((migrated.children[0] as { type: string }).type).toBe('path');
  });
});
