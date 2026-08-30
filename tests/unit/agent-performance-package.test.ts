// Agent Performance Package — unit tests.
//
// Covers the round-trip-reduction behaviors added after the R1/R2/R3 research
// pass (see worklog.md Task 5):
//   1. pen_create_subtree multi-root (`nodes`) + id-manifest result
//      (kills the mandatory pen_get_metadata read-back round trip).
//   2. pen_duplicate_nodes batch duplication (count/direction/spacing) —
//      the "78 calls to turn one card into three" case.
//   3. patch applier duplicate back-compat (no count → legacy +24/+24).
//   4. applyExecutionModes — order-preserving sequential marking for canvas
//      mutations under parallel tool-call emission.
//   5. buildSystemPrompt includeSnapshot=false — byte-stable system prompt
//      for provider prefix caching.

import { describe, it, expect, beforeEach } from 'vitest';
import { createCanvasTools, executeTool } from '@/lib/agent/tools';
import type { CanvasToolContext } from '@/lib/agent/tools';
import type { CanvasDocument, CanvasPatch, Shape, DesignTokens } from '@/lib/canvas/types';
import { applyPatchToCanvas } from '@/lib/canvas/patch';
import { applyExecutionModes } from '@/lib/agent/tool-execution-mode';
import { buildSystemPrompt } from '@/lib/agent/runner-legacy';

// ---- In-memory test harness (mirrors tools.test.ts) --------------------------

interface TestHarness {
  doc: CanvasDocument;
  patches: CanvasPatch[];
  ctx: CanvasToolContext;
  reset(): void;
  addShape(s: Partial<Shape> & { id: string }): Shape;
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
      return p;
    },
  };

  return {
    doc,
    patches,
    ctx,
    reset() {
      doc.children = [];
      doc.shapes = [];
      doc.tokens = { colors: [], textStyles: [] };
      patches.length = 0;
    },
    addShape(s) {
      const shape: Shape = {
        type: 'rectangle', name: s.name ?? 'Shape', x: 0, y: 0, width: 100, height: 50,
        fill: '#ffffff', stroke: 'none', strokeWidth: 0, radius: 0, opacity: 1,
        visible: true, locked: false, zIndex: doc.shapes.length,
        ...s,
      } as Shape;
      doc.shapes.push(shape);
      doc.children.push(shape as never);
      return shape;
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

// ---- 1. pen_create_subtree: multi-root + manifest -----------------------------

describe('pen_create_subtree: multi-root batch', () => {
  it('creates several roots in ONE call, one patch each, and lists every id in the manifest', async () => {
    const r = await run('pen_create_subtree', {
      nodes: [
        { type: 'frame', name: 'Card A', x: 0, y: 0, width: 200, height: 120, children: [{ type: 'text', text: 'Basic' }] },
        { type: 'frame', name: 'Card B', x: 240, y: 0, width: 200, height: 120, children: [{ type: 'text', text: 'Pro' }] },
      ],
    });
    expect(r.isError).toBeFalsy();
    // One patch per root — the whole point (no extra round trips).
    expect(r.patches).toHaveLength(2);
    expect(r.patches!.every((p) => p.op === 'add_subtree')).toBe(true);
    // Both trees applied: 2 frames + 2 texts.
    expect(h.doc.shapes.length).toBe(4);
    // Result summarizes BOTH roots.
    expect(r.content).toContain('Created 2 subtrees');
    expect(r.content).toContain('Card A');
    expect(r.content).toContain('Card B');
    // The manifest lists every generated node id — including the auto-assigned
    // DESCENDANT ids (this is what previously required a pen_get_metadata
    // read-back round trip).
    expect(r.content).toContain('NEW NODE IDS');
    const textShapes = h.doc.shapes.filter((s) => s.type === 'text');
    expect(textShapes).toHaveLength(2);
    for (const t of textShapes) {
      expect(r.content).toContain(`id=${t.id}`);
    }
    // The read-back instruction is gone.
    expect(r.content).not.toContain('call pen_get_metadata {nodeId:"');
  });

  it('keeps the single-root `node` spelling working with the manifest', async () => {
    const r = await run('pen_create_subtree', {
      node: { type: 'frame', name: 'Solo', x: 10, y: 10, width: 100, height: 80, children: [{ type: 'text', text: 'Hello' }] },
    });
    expect(r.isError).toBeFalsy();
    expect(h.patches).toHaveLength(1);
    expect(r.content).toContain('Created subtree "Solo"');
    expect(r.content).toContain('NEW NODE IDS');
    const text = h.doc.shapes.find((s) => s.type === 'text');
    expect(text).toBeTruthy();
    expect(r.content).toContain(`id=${text!.id}`);
    // Back-compat: single root still exposes details.patch.
    expect((r.patch as CanvasPatch)?.op).toBe('add_subtree');
  });

  it('errors on an empty nodes array and enforces the root cap', async () => {
    const empty = await run('pen_create_subtree', { nodes: [] });
    expect(empty.isError).toBe(true);
    expect(empty.content).toContain('nodes');

    const tooMany = await run('pen_create_subtree', {
      nodes: Array.from({ length: 13 }, (_, i) => ({ type: 'rectangle', width: 10, height: 10, x: i * 20 })),
    });
    expect(tooMany.isError).toBe(true);
    expect(tooMany.content).toContain('max 12');
  });

  it('applies sibling roots without collision (second root sees the first)', async () => {
    // Both roots at the SAME coords with frame sizes large enough to
    // mutually overlap → the placement guard must separate them.
    const r = await run('pen_create_subtree', {
      nodes: [
        { type: 'frame', name: 'Screen 1', x: 0, y: 0, width: 400, height: 600, children: [{ type: 'text', text: 'One' }] },
        { type: 'frame', name: 'Screen 2', x: 0, y: 0, width: 400, height: 600, children: [{ type: 'text', text: 'Two' }] },
      ],
    });
    expect(r.isError).toBeFalsy();
    const roots = h.doc.shapes.filter((s) => s.name === 'Screen 1' || s.name === 'Screen 2');
    expect(roots).toHaveLength(2);
    // The second root must NOT sit exactly on the first (guard adjusted it).
    const [a, b] = roots;
    const sameSpot = Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1;
    expect(sameSpot).toBe(false);
  });
});

// ---- 2. pen_duplicate_nodes: batch duplication ---------------------------------

describe('pen_duplicate_nodes: batch duplication', () => {
  it('turns one card into a row of three with count + direction (ONE call)', async () => {
    const card = h.addShape({ id: 'card-1', type: 'frame', name: 'Pricing card', x: 0, y: 0, width: 100, height: 50 });
    const r = await run('pen_duplicate_nodes', {
      nodeIds: ['card-1'],
      count: 2,
      direction: 'horizontal',
      spacing: 20,
    });
    expect(r.isError).toBeFalsy();
    expect(h.patches).toHaveLength(1);
    expect(h.patches[0].op).toBe('duplicate');
    // 1 original + 2 copies.
    expect(h.doc.shapes.length).toBe(3);
    // Row layout: x = 0, 120, 240; same y.
    const xs = h.doc.shapes.map((s) => Math.round(s.x)).sort((a, b) => a - b);
    expect(xs).toEqual([0, 120, 240]);
    expect(h.doc.shapes.every((s) => Math.round(s.y) === 0)).toBe(true);
    // The result reports the new ids (manifest pattern — no read-back needed).
    expect(r.content).toContain('New node ids:');
    for (const s of h.doc.shapes) {
      if (s.id !== 'card-1') expect(r.content).toContain(s.id);
    }
    void card;
  });

  it('stacks copies vertically with source height + spacing stride', async () => {
    h.addShape({ id: 'row-1', type: 'frame', name: 'List row', x: 0, y: 0, width: 200, height: 40 });
    const r = await run('pen_duplicate_nodes', {
      nodeIds: ['row-1'],
      count: 2,
      direction: 'vertical',
      spacing: 8,
    });
    expect(r.isError).toBeFalsy();
    expect(h.doc.shapes.length).toBe(3);
    const ys = h.doc.shapes.map((s) => Math.round(s.y)).sort((a, b) => a - b);
    expect(ys).toEqual([0, 48, 96]);
    expect(h.doc.shapes.every((s) => Math.round(s.x) === 0)).toBe(true);
  });

  it('keeps the legacy default: no count → ONE copy at +24/+24 named "… copy"', async () => {
    h.addShape({ id: 'solo-1', type: 'frame', name: 'Badge', x: 10, y: 20, width: 60, height: 30 });
    const r = await run('pen_duplicate_nodes', { nodeIds: ['solo-1'] });
    expect(r.isError).toBeFalsy();
    expect(h.doc.shapes.length).toBe(2);
    const copy = h.doc.shapes.find((s) => s.id !== 'solo-1')!;
    expect(copy).toBeTruthy();
    expect(Math.round(copy.x)).toBe(34);
    expect(Math.round(copy.y)).toBe(44);
    expect(copy.name).toBe('Badge copy');
  });

  it('honors custom offsets now (previously silently ignored)', async () => {
    h.addShape({ id: 'off-1', type: 'frame', name: 'Tag', x: 0, y: 0, width: 40, height: 20 });
    const r = await run('pen_duplicate_nodes', { nodeIds: ['off-1'], offsetX: -60, offsetY: 0 });
    expect(r.isError).toBeFalsy();
    expect(h.doc.shapes.length).toBe(2);
    const copy = h.doc.shapes.find((s) => s.id !== 'off-1')!;
    expect(Math.round(copy.x)).toBe(-60);
  });
});

// ---- 3. applyExecutionModes -----------------------------------------------------

describe('applyExecutionModes (order-preserving batch execution)', () => {
  it('marks canvas MUTATIONS sequential, leaves reads and plugins untouched', () => {
    const tools: Array<{ name: string; executionMode?: 'sequential' | 'parallel' }> = [
      { name: 'pen_create_node' },
      { name: 'pen_create_subtree' },
      { name: 'pen_update_node' },
      { name: 'pen_delete_nodes' },
      { name: 'pen_set_variable' },
      { name: 'figma_create_page' },
      { name: 'pen_get_metadata' },
      { name: 'pen_search_icons' },
      { name: 'pen_export_json' },
      { name: 'todo_write' },
      { name: 'ask_user_question' },
    ];
    const out = applyExecutionModes(tools);
    const byName = (n: string) => out.find((t) => t.name === n)!;
    // Mutations → sequential (ordered application inside a batch).
    for (const n of ['pen_create_node', 'pen_create_subtree', 'pen_update_node', 'pen_delete_nodes', 'pen_set_variable', 'figma_create_page']) {
      expect(byName(n).executionMode).toBe('sequential');
    }
    // Reads stay parallel (pi default).
    for (const n of ['pen_get_metadata', 'pen_search_icons', 'pen_export_json']) {
      expect(byName(n).executionMode).toBeUndefined();
    }
    // Plugin tools manage their own concurrency.
    for (const n of ['todo_write', 'ask_user_question']) {
      expect(byName(n).executionMode).toBeUndefined();
    }
  });

  it('never overrides an explicit executionMode', () => {
    const out = applyExecutionModes([{ name: 'pen_create_node', executionMode: 'parallel' }]);
    expect(out[0].executionMode).toBe('parallel');
  });
});

// ---- 4. buildSystemPrompt: snapshot flag -----------------------------------------

describe('buildSystemPrompt includeSnapshot flag', () => {
  const emptyCanvas: CanvasDocument = {
    id: 'd', name: 'T', background: '#ffffff', version: '2.17',
    children: [], viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes: [], tokens: { colors: [], textStyles: [] },
  };

  it('appends the canvas snapshot by default (legacy behavior)', () => {
    const p = buildSystemPrompt('meta', 'body', 'plan', emptyCanvas, 'slate', true);
    expect(p).toContain('Current canvas state');
  });

  it('omits the snapshot when includeSnapshot=false (native runner caching path)', () => {
    const p = buildSystemPrompt('meta', 'body', 'plan', emptyCanvas, 'slate', true, undefined, false);
    expect(p).not.toContain('Current canvas state');
    // The rest of the prompt — including the new emission rules — is intact.
    expect(p).toContain('PARALLEL TOOL EMISSION RULE');
    expect(p).toContain('CALL BUDGET RULE');
  });
});
