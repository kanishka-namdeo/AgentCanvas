// Tests for the Phase 3 Figma-MCP-aligned tools (spec §5.2 / Appendix D):
//
//   pen_insert_html       — sanitized HTML → ONE bulk_add patch with nested
//                           .pen children (round-trip: patch → apply → resolve
//                           → serialize semantic equivalence)
//   pen_get_metadata      — page-list default + sparse subtree tree
//   pen_get_variable_defs — variables + text styles with codeSyntax
//   pen_get_design_context— 4-part handoff payload
//   pen_bake_layout       — server-side v1 notice, no patch
//
// Uses the same in-memory CanvasToolContext harness as tools.test.ts.

import { describe, it, expect, beforeEach } from 'vitest';
import { createCanvasTools, executeTool } from '@/lib/agent/tools';
import type { CanvasToolContext } from '@/lib/agent/tools';
import type { CanvasDocument, CanvasPatch, Shape, DesignTokens } from '@/lib/canvas/types';
import type { PenChild } from '@/lib/pen/types';
import { applyPatchToCanvas } from '@/lib/canvas/patch';
import { serializeNodes } from '@/lib/canvas/serialize';
import { resolvePenTreeDetailed } from '@/lib/pen/resolve';

// ---- In-memory test harness (same pattern as tools.test.ts) -------------------

interface TestHarness {
  doc: CanvasDocument;
  patches: CanvasPatch[];
  ctx: CanvasToolContext;
  addPenNode(node: PenChild): void;
  setVariables(vars: CanvasDocument['variables']): void;
}

function makeHarness(): TestHarness {
  const doc: CanvasDocument = {
    id: 'doc-1',
    name: 'Test',
    background: '#ffffff',
    version: '2.17',
    children: [],
    viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes: [],
    tokens: { colors: [], textStyles: [] },
  };
  const patches: CanvasPatch[] = [];

  const ctx: CanvasToolContext = {
    getShapes: () => doc.shapes,
    getTokens: () => doc.tokens,
    getDocument: () => doc,
    applyPatch: (p) => {
      patches.push(p);
      const next = applyPatchToCanvas(doc, p);
      doc.shapes = next.shapes;
      doc.tokens = next.tokens;
      doc.children = next.children;
      doc.variables = next.variables;
      doc.themes = next.themes;
      doc.background = next.background;
      doc.viewport = next.viewport;
      doc.pages = next.pages;
      doc.activePageIndex = next.activePageIndex;
      return p;
    },
  };

  return {
    doc,
    patches,
    ctx,
    addPenNode(node) {
      doc.children.push(node);
      doc.shapes = resolvePenTreeDetailed(doc).layers;
    },
    setVariables(vars) {
      doc.variables = vars;
    },
  };
}

let h: TestHarness;
beforeEach(() => {
  h = makeHarness();
});

async function run(name: string, args: any = {}) {
  return executeTool(createCanvasTools(h.ctx), name, args);
}

/// Call a tool directly (full AgentToolResult incl. `details`).
async function runRaw(name: string, args: any = {}) {
  const tool = createCanvasTools(h.ctx).find((t: any) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.execute(`call-test`, args, undefined, undefined, undefined as any);
}

// ---- pen_get_metadata -----------------------------------------------------------

describe('tools-mcp: pen_get_metadata', () => {
  it('returns the page list when called without a nodeId', async () => {
    const r = await run('pen_get_metadata', {});
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/^page 0: /);
    expect(r.content).toContain('— "Test"');
    expect(r.content).toContain('nodes)');
    expect(r.content).toContain('Pass a nodeId (or page id) for the sparse tree');
  });

  it('lists every page with node counts for multi-page documents', async () => {
    h.doc.pages = [
      { id: 'p1', name: 'Home', children: [] },
      { id: 'p2', name: 'Dashboard', children: [] },
    ];
    h.doc.activePageIndex = 0;
    h.doc.children = [];
    h.addPenNode({ id: 'n1', type: 'frame', name: 'F', x: 0, y: 0 } as PenChild);
    h.doc.pages[0].children = h.doc.children;
    const r = await run('pen_get_metadata', {});
    expect(r.content).toContain('page 0: p1 — "Home" (1 nodes)');
    expect(r.content).toContain('page 1: p2 — "Dashboard" (0 nodes)');
    expect(r.content).toContain('*active*');
  });

  it('returns a sparse tree with id | name | type | x/y/w/h lines for a valid nodeId', async () => {
    h.addPenNode({
      id: 'card',
      type: 'frame',
      name: 'Card',
      x: 100,
      y: 80,
      width: 300,
      height: 200,
      layout: 'vertical',
      gap: 8,
      children: [
        { id: 'title', type: 'text', name: 'Title', content: 'Hi', x: 0, y: 0, width: 100, height: 20 } as PenChild,
        { id: 'badge', type: 'rectangle', name: 'Badge', x: 0, y: 0, width: 40, height: 40 } as PenChild,
      ],
    } as PenChild);
    const r = await run('pen_get_metadata', { nodeId: 'card' });
    const lines = r.content.split('\n');
    expect(lines[0]).toBe('card | Card | frame | x=100 y=80 w=300 h=200');
    expect(lines.some((l) => l.startsWith('  title | Title | text | x='))).toBe(true);
    expect(lines.some((l) => l.startsWith('  badge | Badge | rectangle | x='))).toBe(true);
    // Resolved absolute geometry from the resolver, not raw stored coords.
    expect(r.content).toContain('x=100');
  });

  it('scopes the tree to the requested subtree (excludes siblings)', async () => {
    h.addPenNode({ id: 'a', type: 'frame', name: 'A', x: 0, y: 0, children: [{ id: 'a1', type: 'text', name: 'A1', content: 'x', x: 0, y: 0, width: 10, height: 10 } as PenChild] } as PenChild);
    h.addPenNode({ id: 'b', type: 'rectangle', name: 'B', x: 500, y: 0, width: 10, height: 10 } as PenChild);
    const r = await run('pen_get_metadata', { nodeId: 'a' });
    expect(r.content).toContain('a1');
    expect(r.content).not.toContain('| B |');
  });

  it('recovers from an unknown nodeId with the page list (never an error dead-end)', async () => {
    const r = await run('pen_get_metadata', { nodeId: 'does-not-exist' });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('not found');
    expect(r.content).toMatch(/^nodeId "does-not-exist" not found/);
    expect(r.content).toContain('page 0:');
  });
});

// ---- pen_get_variable_defs --------------------------------------------------------

describe('tools-mcp: pen_get_variable_defs', () => {
  it('lists variables with type, value, and codeSyntax var(--acv-…)', async () => {
    h.setVariables({
      'color.primary': { type: 'color', value: '#0ea5e9' },
      'spacing.md': { type: 'number', value: 16 },
    });
    // Mirror into the derived tokens view the way the resolver does.
    h.doc.tokens = {
      colors: [{ name: 'color.primary', key: 'color.primary', value: '#0ea5e9' }],
      textStyles: [{ name: 'body', key: 'text.body', fontSize: 16, fontWeight: 400, lineHeight: 1.5, color: '#0f172a' }],
    };
    const r = await run('pen_get_variable_defs', {});
    expect(r.content).toContain('color.primary | color | #0ea5e9 | var(--acv-color-primary)');
    expect(r.content).toContain('spacing.md | number | 16 | var(--acv-spacing-md)');
    expect(r.content).toContain('body | fontSize=16');
    expect(r.content).toContain('var(--acv-text-body)');
  });

  it('reports themed values as themedValues in details', async () => {
    h.setVariables({
      'color.bg': {
        type: 'color',
        value: [
          { value: '#ffffff', theme: { mode: 'light' } },
          { value: '#0f172a', theme: { mode: 'dark' } },
        ],
      },
    });
    const r = await run('pen_get_variable_defs', {});
    expect(r.content).toContain('2 themed values');
  });

  it('sanitizes non-identifier characters in the CSS custom property name', async () => {
    h.setVariables({ 'color.primary 2': { type: 'color', value: '#fff' } });
    const r = await run('pen_get_variable_defs', {});
    expect(r.content).toContain('var(--acv-color-primary-2)');
  });
});

// ---- pen_insert_html ---------------------------------------------------------------

describe('tools-mcp: pen_insert_html', () => {
  const CARD_HTML =
    '<div style="display:flex;flex-direction:column;gap:12px;padding:24px;background:#ffffff;border-radius:12px;width:320px">' +
    '<span style="font-size:14px;font-weight:500;color:#475569">Monthly revenue</span>' +
    '<span style="font-size:32px;font-weight:600;color:#0f172a">$128.4K</span>' +
    '</div>';

  it('emits ONE bulk_add patch carrying nested .pen children', async () => {
    const r = await run('pen_insert_html', { html: CARD_HTML, x: 100, y: 100, namePrefix: 'card' });
    expect(r.isError).toBeFalsy();
    expect(h.patches).toHaveLength(1);
    const patch = h.patches[0];
    expect(patch.op).toBe('bulk_add');
    expect(patch.shapes!.length).toBe(1); // one root
    const root = patch.shapes![0] as any;
    expect(root.type).toBe('frame');
    expect(root.layout).toBe('vertical');
    expect(root.parentId).toBe(null);
    expect(root.x).toBe(100);
    expect(root.y).toBe(100);
    // Nested .pen children ride along inside the root's children array.
    expect(Array.isArray(root.children)).toBe(true);
    expect(root.children.length).toBe(2);
    expect(root.children[0].type).toBe('text');
    expect(root.children[0].content).toBe('Monthly revenue');
  });

  it('applies cleanly through applyPatchToCanvas into the .pen tree', async () => {
    await run('pen_insert_html', { html: CARD_HTML });
    expect(h.doc.children).toHaveLength(1);
    const root = h.doc.children[0] as any;
    expect(root.type).toBe('frame');
    expect(root.children.length).toBe(2);
    // Explicit style width is a fixed number; the unspecified height stays
    // fit_content (regression for the sizeValue fix — num() used to clobber
    // sizing strings to the 100 default).
    expect(root.width).toBe(320);
    expect(root.height).toBe('fit_content');
    // The resolved layer view contains the descendants with parentId links.
    const ids = h.doc.shapes.map((s) => s.id);
    expect(ids).toContain(root.children[0].id);
    expect(h.doc.shapes.find((s) => s.id === root.children[0].id)?.parentId).toBe(root.id);
  });

  it('returns created node ids + type counts + skipped note', async () => {
    const r = await run('pen_insert_html', {
      html: '<div><h1>T</h1><svg><path d="M0 0"/></svg></div>',
    });
    expect(r.content).toContain('frame×1');
    expect(r.content).toContain('text×1');
    expect(r.content).toContain('Skipped 1 svg/path element(s)');
    const raw = await runRaw('pen_insert_html', {
      html: '<div><h1>T</h1><svg><path d="M0 0"/></svg></div>',
    });
    const details = (raw as any).details ?? {};
    expect(details.nodeIds.length).toBe(2);
    expect(details.typeCounts).toMatchObject({ frame: 1, text: 1 });
    expect(details.skipped).toBe(1);
  });

  it('errors on an unknown parentId', async () => {
    const r = await run('pen_insert_html', { html: '<div>x</div>', parentId: 'nope' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('no node with id "nope"');
    expect(h.patches).toHaveLength(0);
  });

  it('inserts under an existing frame parentId when given', async () => {
    h.addPenNode({ id: 'target', type: 'frame', name: 'Target', x: 0, y: 0, width: 400, height: 400 } as PenChild);
    const r = await run('pen_insert_html', { html: '<p>inside</p>', parentId: 'target' });
    expect(r.isError).toBeFalsy();
    const target = h.doc.children.find((c) => c.id === 'target') as any;
    expect(target.children).toHaveLength(1);
    expect(target.children[0].type).toBe('text');
  });

  it('sanitizes malicious fragments before they reach the tree', async () => {
    const r = await run('pen_insert_html', {
      html: '<div onclick="evil()"><script>alert(1)</script><span>safe</span><a href="javascript:x">l</a></div>',
    });
    expect(r.isError).toBeFalsy();
    const json = JSON.stringify(h.doc.children);
    expect(json).not.toContain('onclick');
    expect(json).not.toContain('script');
    expect(json).not.toContain('javascript');
    expect(json).toContain('safe');
  });
});

// ---- pen_get_design_context ----------------------------------------------------------

describe('tools-mcp: pen_get_design_context', () => {
  beforeEach(() => {
    h.addPenNode({
      id: 'card',
      type: 'frame',
      name: 'Card',
      x: 0,
      y: 0,
      width: 300,
      height: 120,
      layout: 'vertical',
      gap: 8,
      children: [
        { id: 't1', type: 'text', name: 'Title', content: 'Revenue', x: 0, y: 0, width: 100, height: 20 } as PenChild,
        { id: 'img1', type: 'rectangle', name: 'Shot', x: 0, y: 0, width: 80, height: 60, fill: { type: 'image', url: 'https://example.com/a.png', mode: 'fill' } } as PenChild,
      ],
    } as PenChild);
  });

  it('returns the 4 labeled payload parts', async () => {
    const r = await run('pen_get_design_context', { nodeId: 'card', framework: 'html' });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('=== 1. REFERENCE CODE (html) ===');
    expect(r.content).toContain('=== 2. SCREENSHOT ===');
    expect(r.content).toContain('=== 3. CONVERSION INSTRUCTIONS ===');
    expect(r.content).toContain('=== 4. ASSETS ===');
  });

  it('part 1 carries data-name/data-node-id and flex structure scoped to the node', async () => {
    const r = await run('pen_get_design_context', { nodeId: 'card', framework: 'html' });
    expect(r.content).toContain('data-name="Card" data-node-id="card"');
    expect(r.content).toContain('data-node-id="t1"');
    expect(r.content).toContain('display:flex');
    expect(r.content).toContain('Revenue');
  });

  it('part 4 lists image asset URLs in the subtree', async () => {
    const r = await run('pen_get_design_context', { nodeId: 'card' });
    expect(r.content).toContain('https://example.com/a.png');
  });

  it('defaults the code flavor to react', async () => {
    const r = await run('pen_get_design_context', { nodeId: 'card' });
    expect(r.content).toContain('=== 1. REFERENCE CODE (react) ===');
    expect(r.content).toContain('export function Card()');
  });

  it('errors on an unknown nodeId with a navigation hint', async () => {
    const r = await run('pen_get_design_context', { nodeId: 'missing' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('pen_get_metadata');
  });
});

// ---- pen_bake_layout --------------------------------------------------------------------

describe('tools-mcp: pen_bake_layout', () => {
  it('returns the no-measured notice and makes NO patch', async () => {
    const r = await run('pen_bake_layout', { nodeIds: ['a', 'b'] });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('measured bounds require a connected client');
    expect(r.content).toContain('no changes made');
    expect(h.patches).toHaveLength(0);
  });

  it('accepts all=true with the same notice (schema stable from day one)', async () => {
    const r = await run('pen_bake_layout', { all: true });
    expect(r.content).toContain('all nodes');
    expect(h.patches).toHaveLength(0);
  });
});

// ---- Round-trip: insert HTML → apply → resolve → serialize ----------------------------------

describe('tools-mcp: html insert → serialize round-trip', () => {
  it('preserves text content and flex structure end-to-end (semantic equivalence)', async () => {
    const html =
      '<div style="display:flex;flex-direction:column;gap:10px;padding:20px;background:#ffffff;width:300px">' +
      '<h2>Sign in</h2>' +
      '<input type="email" placeholder="you@example.com">' +
      '<button>Continue</button>' +
      '</div>';
    const r = await run('pen_insert_html', { html, x: 40, y: 40, namePrefix: 'auth' });
    expect(r.isError).toBeFalsy();

    // The document now holds the .pen subtree (applied through the harness).
    const { tree } = resolvePenTreeDetailed(h.doc);
    const out = serializeNodes(tree, { framework: 'html' });

    // Text content survived the round-trip.
    expect(out).toContain('Sign in');
    expect(out).toContain('Continue');
    // The flex structure survived: nested flex div with the gap style.
    expect(out).toContain('display:flex');
    expect(out).toContain('flex-direction:column');
    expect(out).toContain('gap:10px');
    expect(out).toContain('padding:20px');
    // Every element carries the semantic layer contract.
    expect(out).toContain('data-name="auth-h2-sign-in"');
    expect(out).toMatch(/data-node-id="[^"]+"/);
    // The input became a rectangle with cornerRadius 6.
    const inputLayer = h.doc.shapes.find((s) => s.name.startsWith('auth-input'));
    expect(inputLayer).toBeTruthy();
    expect(inputLayer!.radius).toBe(6);
  });

  it('react + tailwind flavors also carry the round-tripped structure', async () => {
    await run('pen_insert_html', {
      html: '<div style="display:flex;flex-direction:column;gap:12px;padding:16px;width:347px"><p>hello</p></div>',
      namePrefix: 'rt',
    });
    const { tree } = resolvePenTreeDetailed(h.doc);
    const react = serializeNodes(tree, { framework: 'react' });
    expect(react).toContain('hello');
    expect(react).toContain("'flex-direction': 'column'");
    const tw = serializeNodes(tree, { framework: 'tailwind' });
    expect(tw).toContain('hello');
    expect(tw).toContain('flex-col');
    expect(tw).toContain('gap-3');
    expect(tw).toContain('w-[347px]');
  });
});

// ---- patch.ts regression: bulk_add + nested children + sizing strings ----------------------

describe('tools-mcp: bulk_add carries nested .pen children with sizing strings', () => {
  it('preserves fit_content / fill_container through normalizeToNode', () => {
    const doc = makeHarness().doc;
    const next = applyPatchToCanvas(doc, {
      op: 'bulk_add',
      shapes: [
        {
          id: 'root',
          type: 'frame',
          name: 'Root',
          x: 0,
          y: 0,
          width: 'fit_content',
          height: 'fit_content',
          layout: 'vertical',
          children: [
            { id: 'kid', type: 'rectangle', name: 'Kid', x: 0, y: 0, width: 'fill_container', height: 40 } as any,
          ],
        } as any,
      ],
      summary: 'test',
    });
    const root = next.children[0] as any;
    expect(root.width).toBe('fit_content');
    expect(root.height).toBe('fit_content');
    expect(root.children).toHaveLength(1);
    expect(root.children[0].width).toBe('fill_container');
    expect(root.children[0].height).toBe(40);
  });
});
