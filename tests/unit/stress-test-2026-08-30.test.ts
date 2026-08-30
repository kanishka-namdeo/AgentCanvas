// Unit tests — 2026-08-30 visual stress test regression guards.
//
// The stress test (S2 dashboard scenario) caught a silent-work-loss bug class:
// composite tools that call ctx.applyPatch but return WITHOUT the patch in
// `details.patch` / `details.patches`. The session translator
// (agent-session-translator.ts extractPatchesFromToolResult) is the ONLY path
// that fans patches out to clients + the journal — ctx.applyPatch alone
// mutates just the runner-local canvas. Result: the tool reports success,
// the model moves on, and the work never reaches any client or snapshot
// (observed live: a "successfully created" 18-node chart vanished).
//
// A second bug in the same tool: pen_create_chart nested its children under
// `patch.nodes`, a field the add_subtree applier never reads (it only reads
// `patch.shape`) — so even with details.patch restored, the subtree would
// have inserted as an EMPTY frame. Children must live in `shape.children`.

import { describe, it, expect } from 'vitest';
import { createCanvasTools, type CanvasToolContext } from '@/lib/agent/tools';
import { sanitizeAgentPatch } from '@/lib/canvas/patch-sanitizer';
import { applyPatchToCanvas } from '@/lib/canvas/patch';
import type { CanvasDocument, CanvasPatch } from '@/lib/canvas/types';

// ---- Fixtures ----------------------------------------------------------------

function emptyCanvas(): CanvasDocument {
  return {
    id: 'doc-stress',
    name: 'Test',
    version: '2.17',
    background: '#ffffff',
    shapes: [],
    tokens: { colors: [], textStyles: [] },
    children: [],
  } as unknown as CanvasDocument;
}

function makeCtx(doc?: CanvasDocument): CanvasToolContext & { patches: unknown[] } {
  const canvas = doc ?? emptyCanvas();
  const patches: unknown[] = [];
  return {
    getShapes: () => canvas.shapes ?? [],
    getTokens: () => canvas.tokens ?? { colors: [], textStyles: [] },
    getDocument: () => canvas,
    applyPatch(p: CanvasPatch) {
      patches.push(p);
      const { patch: sanitized } = sanitizeAgentPatch(p, canvas);
      if (sanitized) Object.assign(canvas, applyPatchToCanvas(canvas, sanitized));
      return p;
    },
    patches,
  } as any;
}

function toolByName(ctx: CanvasToolContext, name: string): any {
  const tools = createCanvasTools(ctx) as any[];
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
}

async function exec(ctx: CanvasToolContext & { patches: unknown[] }, name: string, params: Record<string, unknown>) {
  const tool = toolByName(ctx, name);
  const result = await tool.execute(`test-${name}`, params, undefined as any, undefined as any, ctx);
  return result;
}

// ---- The bug class: every ctx.applyPatch call must surface in details --------

describe('stress-test 2026-08-30 — composite tools propagate their patches', () => {
  it('pen_create_chart returns details.patch with the full subtree under shape.children', async () => {
    const ctx = makeCtx();
    const result = await exec(ctx, 'pen_create_chart', {
      type: 'line',
      title: 'Monthly Revenue',
      data: [
        { label: 'Jan', value: 85 },
        { label: 'Feb', value: 92 },
        { label: 'Mar', value: 88 },
        { label: 'Apr', value: 105 },
      ],
      x: 100,
      y: 100,
      width: 500,
      height: 300,
    });
    expect(result.isError).toBeFalsy();
    // THE regression: details.patch must exist (the translator reads it).
    const patch = (result.details as any)?.patch as CanvasPatch | undefined;
    expect(patch).toBeDefined();
    expect(patch?.op).toBe('add_subtree');
    // THE second regression: children nested in shape.children (patch.nodes
    // is silently ignored by the applier).
    const shape = (patch as any)?.shape ?? {};
    const kids = shape.children ?? [];
    expect(Array.isArray(kids)).toBe(true);
    expect(kids.length).toBeGreaterThanOrEqual(8); // area + line + 4 points + labels + axis
    expect((patch as any).nodes).toBeUndefined();
    // Root must NOT be auto-layout: chart geometry is absolutely positioned.
    expect(shape.autoLayout).toBeUndefined();
    // The frameId claim in the result text must match the patch's root id.
    expect((result.details as any).frameId).toBe(patch!.shapeId);
  });

  it('pen_create_chart patch survives the full sanitize+apply pipeline and lands on the canvas', async () => {
    // ctx.applyPatch in the fixture applies patches eagerly; for a clean
    // pipeline assertion, sanitize against a PRISTINE canvas (the route's
    // liveCanvas state before the patch — never the post-apply state).
    const pristine = emptyCanvas();
    const ctx = makeCtx();
    const result = await exec(ctx, 'pen_create_chart', {
      type: 'bar',
      data: [
        { label: 'A', value: 3 },
        { label: 'B', value: 7 },
      ],
      x: 0,
      y: 0,
    });
    const patch = (result.details as any).patch as CanvasPatch;
    const { patch: sanitized, warnings } = sanitizeAgentPatch(patch, pristine);
    expect(warnings).toEqual([]);
    expect(sanitized).toBeTruthy();
    const next = applyPatchToCanvas(pristine, sanitized!);
    // Root + children all present on the applied canvas.
    const names = (next.shapes ?? []).map((s: any) => s.name as string);
    expect(names.some((n) => /chart/i.test(n ?? ''))).toBe(true);
    expect(names.some((n) => /A bar/.test(n ?? ''))).toBe(true);
    expect(names.some((n) => /B bar/.test(n ?? ''))).toBe(true);
  });

  it('pen_apply_design_system returns details.patches for every applied patch', async () => {
    const ctx = makeCtx();
    const result = await exec(ctx, 'pen_apply_design_system', { pack: 'shadcn-default', rebind: false });
    expect(result.isError).toBeFalsy();
    const patches = (result.details as any)?.patches as CanvasPatch[] | undefined;
    expect(Array.isArray(patches)).toBe(true);
    expect(patches!.length).toBeGreaterThanOrEqual(2); // tokens + background
    const ops = patches!.map((p) => p.op);
    expect(ops).toContain('tokens');
    expect(ops).toContain('background');
  });

  it('pen_apply_design_system with rebind:true includes the palette patch too', async () => {
    const ctx = makeCtx();
    const result = await exec(ctx, 'pen_apply_design_system', { pack: 'shadcn-default', rebind: true });
    const patches = (result.details as any)?.patches as CanvasPatch[] | undefined;
    expect(Array.isArray(patches)).toBe(true);
    expect(patches!.map((p) => p.op)).toContain('palette');
  });

  it('pen_apply_typography returns details.patch for the update_many batch', async () => {
    // Seed one text layer to target.
    const ctx = makeCtx();
    await exec(ctx, 'pen_create_node', { type: 'text', text: 'Headline', x: 10, y: 10, fontSize: 32, name: 'Hero Title' });
    const result = await exec(ctx, 'pen_apply_typography', { mode: 'auto' });
    expect(result.isError).toBeFalsy();
    const patch = (result.details as any)?.patch as CanvasPatch | undefined;
    expect(patch).toBeDefined();
    expect(patch?.op).toBe('update_many');
    expect((patch!.updates as any[]).length).toBeGreaterThanOrEqual(1);
  });
});

// ---- F1: zero-extent containers hug instead of collapsing --------------------

describe('stress-test 2026-08-30 — zero-width/height containers become fit_content', () => {
  it('add_subtree converts a width=0 container with children to fit_content', async () => {
    const ctx = makeCtx();
    const result = await exec(ctx, 'pen_create_subtree', {
      node: {
        type: 'frame',
        name: 'FeatureCard',
        width: 311,
        height: 120,
        children: [
          { type: 'frame', name: 'FeatureContent', width: 0, height: 100, children: [
            { type: 'text', name: 'Title', text: 'Sleep Tracking' },
            { type: 'text', name: 'Desc', text: 'Automatic detection' },
          ] },
        ],
      },
    });
    expect(result.isError).toBeFalsy();
    const doc = (ctx as any).getDocument() as CanvasDocument;
    const content = (doc.shapes ?? []).find((s: any) => s.name === 'FeatureContent');
    expect(content).toBeDefined();
    // The zero width must NOT survive — the hug guard turns it into
    // fit_content, which the resolver then computes to real content bounds
    // (194px for these two text layers).
    expect(Number(content!.width)).toBeGreaterThan(0);
    expect(Number(content!.width)).not.toBe(100); // not the generic placeholder either
    // Sibling with a real width keeps it.
    const card = (doc.shapes ?? []).find((s: any) => s.name === 'FeatureCard');
    expect(Number(card!.width)).toBe(311);
  });

  it('a zero-height container with children also becomes fit_content', async () => {
    const ctx = makeCtx();
    const result = await exec(ctx, 'pen_create_subtree', {
      node: {
        type: 'frame',
        name: 'Row',
        width: 200,
        height: 0,
        children: [{ type: 'text', name: 'L', text: 'x' }],
      },
    });
    const doc = (ctx as any).getDocument() as CanvasDocument;
    const row = (doc.shapes ?? []).find((s: any) => s.name === 'Row');
    expect(Number(row!.height)).toBeGreaterThan(0);
    expect(Number(row!.width)).toBe(200);
  });
});

// ---- F13: charts are absolutely-positioned geometry, not auto-layout stacks --

describe('stress-test 2026-08-30 — validator Rule 4 never pushes autoLayout onto charts', () => {
  it('a lone chart frame (no autoLayout anywhere) does NOT trigger the autoLayout defect', async () => {
    const { validateCanvasBeforeComplete } = await import('@/lib/agent/validators');
    const ctx = makeCtx();
    await exec(ctx, 'pen_create_chart', {
      type: 'bar',
      title: 'Quarterly Revenue',
      data: [
        { label: 'Q1', value: 120 },
        { label: 'Q2', value: 150 },
        { label: 'Q3', value: 135 },
        { label: 'Q4', value: 180 },
      ],
      x: 0,
      y: 0,
    });
    const shapes = ctx.getShapes();
    expect(shapes.length).toBeGreaterThanOrEqual(5);
    const result = validateCanvasBeforeComplete(shapes, { relaxMinCount: true });
    const autoLayoutDefect = result.reasons.find((r: string) => /no autoLayout/i.test(r));
    expect(autoLayoutDefect).toBeUndefined();
  });

  it('a non-chart content stack with no autoLayout still triggers the defect', async () => {
    const { validateCanvasBeforeComplete } = await import('@/lib/agent/validators');
    const ctx = makeCtx();
    await exec(ctx, 'pen_create_subtree', {
      node: {
        type: 'frame',
        name: 'Profile Card',
        width: 300,
        height: 200,
        children: [
          { type: 'text', name: 'Name', text: 'Ada' },
          { type: 'text', name: 'Role', text: 'Engineer' },
          { type: 'text', name: 'Bio', text: 'Builds things' },
          { type: 'text', name: 'Loc', text: 'Berlin' },
          { type: 'text', name: 'Link', text: 'ada.dev' },
        ],
      },
    });
    const result = validateCanvasBeforeComplete(ctx.getShapes(), { relaxMinCount: true });
    expect(result.reasons.some((r: string) => /no autoLayout/i.test(r))).toBe(true);
  });
});

// ---- F14: cv:auto never clips overflowing children (C10a revert) -------------

describe('stress-test 2026-08-30 — overflowing non-clip frames skip L4 culling entirely', () => {
  it('childOverflows frame gets NO content-visibility (intrinsic paint containment would clip)', async () => {
    const { styleFor } = await import('@/components/canvas/dom/styleFor');
    const layer: any = { id: 'card', type: 'frame', width: 480, height: 164, x: 0, y: 0 };
    const style = styleFor(layer, { relX: 0, relY: 0, l4Culling: true, childOverflows: true });
    // cv:auto applies layout+style+PAINT containment intrinsically — it cannot
    // be opted out via the contain property — so it must not be set at all on
    // frames whose children legitimately overflow (Figma: frames don't clip).
    expect(style.contentVisibility).toBeUndefined();
    expect(style.contain).toBeUndefined();
  });

  it('childOverflows frame WITH clip=true keeps culling (clip containment is correct)', async () => {
    const { styleFor } = await import('@/components/canvas/dom/styleFor');
    const layer: any = { id: 'card', type: 'frame', width: 480, height: 164, x: 0, y: 0, clip: true };
    const style = styleFor(layer, { relX: 0, relY: 0, l4Culling: true, childOverflows: true });
    expect(style.contentVisibility).toBe('auto');
    expect(style.contain).toBe('layout style paint');
    expect(style.overflow).toBe('hidden');
  });

  it('non-overflowing frame keeps culling (the perf win stays)', async () => {
    const { styleFor } = await import('@/components/canvas/dom/styleFor');
    const layer: any = { id: 'card', type: 'frame', width: 480, height: 164, x: 0, y: 0 };
    const style = styleFor(layer, { relX: 0, relY: 0, l4Culling: true, childOverflows: false });
    expect(style.contentVisibility).toBe('auto');
    expect(style.contain).toBe('layout style paint');
  });
});

// ---- F19: palette tool never produces dark-on-dark text ----------------------

describe('stress-test 2026-08-30 — pen_apply_palette picks contrasting text swatch', () => {
  // Fixture mirrors the live dark-mode failure: surfaces already dark (the
  // agent updates tokens FIRST, so token-bound surfaces are dark by the time
  // the palette tool runs), text still dark → the state that must be fixed.
  async function makeCanvas(surfaces: { page: string; card: string; cta: string }) {
    const ctx = makeCtx();
    await exec(ctx, 'pen_create_subtree', {
      node: {
        type: 'frame',
        name: 'Pricing',
        width: 900,
        height: 600,
        fill: surfaces.page,
        children: [
          { type: 'text', name: 'Headline', text: 'Scale your team', textColor: '#0f172a' },
          { type: 'frame', name: 'StarterCard', width: 280, height: 400, fill: surfaces.card, children: [
            { type: 'text', name: 'TierName', text: 'Starter', textColor: '#0f172a' },
            { type: 'text', name: 'Price', text: '$0', textColor: '#0f172a' },
          ] },
          { type: 'rectangle', name: 'CTA', width: 160, height: 44, fill: surfaces.cta },
        ],
      },
    });
    return ctx;
  }

  it('dark-mode palette maps text to the LIGHTEST swatch (not near-black)', async () => {
    const ctx = await makeCanvas({ page: '#0f172a', card: '#1e293b', cta: '#8b5cf6' });
    const result = await exec(ctx, 'pen_apply_palette', {
      palette: ['#0f172a', '#1e293b', '#334155', '#475569', '#64748b', '#94a3b8', '#cbd5e1', '#f8fafc', '#8b5cf6', '#a78bfa'],
    });
    expect(result.isError).toBeFalsy();
    const doc = (ctx as any).getDocument() as CanvasDocument;
    const texts = (doc.shapes ?? []).filter((s: any) => s.type === 'text');
    expect(texts.length).toBeGreaterThanOrEqual(3);
    for (const t of texts) {
      expect(t.textColor).not.toBe('#0f172a'); // never the dark-on-dark trap
      expect(t.textColor).toBe('#f8fafc'); // lightest swatch vs dominant dark fill
    }
  });

  it('light palette still maps text to the darkest swatch', async () => {
    const ctx = await makeCanvas({ page: '#f8fafc', card: '#ffffff', cta: '#0ea5e9' });
    await exec(ctx, 'pen_apply_palette', {
      palette: ['#f8fafc', '#e2e8f0', '#cbd5e1', '#94a3b8', '#0f172a', '#0ea5e9'],
    });
    const doc = (ctx as any).getDocument() as CanvasDocument;
    const texts = (doc.shapes ?? []).filter((s: any) => s.type === 'text');
    for (const t of texts) {
      expect(t.textColor).toBe('#0f172a');
    }
  });
});

// ---- Static source guard: no ctx.applyPatch without a details.patch return ---

describe('stress-test 2026-08-30 — no tool calls ctx.applyPatch without surfacing the patch', () => {
  it('every defineTool body that applyPatches also returns patch/patches in details', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/lib/agent/tools.ts', 'utf8');
    // Split on defineTool boundaries; each chunk is one tool body.
    const chunks = src.split('defineTool({').slice(1);
    const offenders: string[] = [];
    for (const chunk of chunks) {
      const nameMatch = chunk.match(/name: '(pen_\w+|figma_\w+)'/);
      if (!nameMatch) continue;
      const applies = (chunk.match(/ctx\.applyPatch\(/g) ?? []).length;
      if (applies === 0) continue;
      // Strip comments, then look for patch/patches inside details objects.
      const noComments = chunk.replace(/\/\/[^\n]*/g, '');
      const detailsBodies = [...noComments.matchAll(/details:\s*\{([^}]*)\}/g)].map((m) => m[1]);
      const surfacesPatch = detailsBodies.some((d) => /\bpatch(es)?\b/.test(d));
      if (!surfacesPatch) offenders.push(`${nameMatch[1]} (${applies}x applyPatch)`);
    }
    expect(offenders, `tools that apply patches but never return them: ${offenders.join(', ')}`).toEqual([]);
  });
});
