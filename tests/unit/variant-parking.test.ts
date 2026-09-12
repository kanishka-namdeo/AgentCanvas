// Unit tests — `buildParkingPatches` (designer-workflow-parity spec §4.1/§4.2).
//
// The variant explorer's judged winner is applied to the canvas; the
// runner-ups are PARKED as labeled `section` nodes on a dedicated
// "Explorations" page (created via `add_page` when absent) with FIFO pruning
// at 5 sections per document. This suite pins the PURE patch builder.
//
// Brief adaptations (task-4 report documents each):
//   - `emptyDocument` lives in `@/lib/canvas/journal-fold` and takes a
//     documentId (Task 3 precedent).
//   - The "applies cleanly" test pre-creates [Page 1 (active), Explorations]:
//     the applier's `add_page` switches activePageIndex to the new page, so a
//     page-less document cannot keep runner-ups off the ACTIVE tree. The
//     asserted behavior is unchanged — `doc.children` stays empty and both
//     sections land on the Explorations page.
//   - The FIFO test setup was rewritten for clarity (controller ruling) and
//     uses the full 3-variant array so "4 existing + 2 new" holds; it also
//     applies the patches to pin the runtime prune (the builder brackets the
//     `remove` with `set_active_page` because the applier's remove op prunes
//     the ACTIVE tree only).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildParkingPatches } from '@/lib/agent/variant-parking';
import { applyPatchToCanvas } from '@/lib/canvas/patch';
import { emptyDocument } from '@/lib/canvas/journal-fold';

// The wiring test below drives pen_generate_variants.execute with a MOCKED
// dispatch (no LLM) — pinned contract: the parking patches ride the tool
// result's `details.patches` AFTER the winner patch, because the translator's
// extractPatchesFromToolResult (details.patch / details.patches) is the ONLY
// path from tool results to the patch stream / journal.
vi.mock('@/lib/agent/subagents/variant-generator', () => ({
  dispatchVariantGeneration: vi.fn(),
}));

const spec = (name: string) => ({ id: `v-${name}`, type: 'frame', name, x: 0, y: 0, width: 400, height: 300, children: [] });
const variants = [
  { direction: 'A', spec: spec('A'), warningCount: 0, nodeCount: 5 },
  { direction: 'B', spec: spec('B'), warningCount: 0, nodeCount: 5 },
  { direction: 'C', spec: spec('C'), warningCount: 0, nodeCount: 5 },
];
const judge = { winnerIndex: 0, scores: [8, 7, 6], reason: 'ok', method: 'vlm' as const };

describe('buildParkingPatches', () => {
  it('emits add_page + one labeled section per runner-up', () => {
    const doc = emptyDocument('doc-parking') as any;
    const { patches, parked } = buildParkingPatches({ doc, variants, judge, winnerIndex: 0 });
    expect(patches[0].op).toBe('add_page');
    expect(patches[0].pageName).toBe('Explorations');
    const sectionPatches = patches.filter((p) => p.op === 'add_subtree');
    expect(sectionPatches).toHaveLength(2);
    expect(sectionPatches.every((p) => (p as any).pageName === 'Explorations')).toBe(true);
    expect(parked.map((p) => p.label)).toEqual(['Variant B — 7', 'Variant C — 6']);
    expect(parked.every((p) => p.id.length > 0)).toBe(true);
  });

  it('applies cleanly to a document (runner-ups land off the active page)', () => {
    let doc = emptyDocument('doc-parking') as any;
    doc.pages = [{ id: 'p1', name: 'Page 1', children: [] }, { id: 'p2', name: 'Explorations', children: [] }];
    doc.activePageIndex = 0;
    const { patches } = buildParkingPatches({ doc, variants, judge, winnerIndex: 0 });
    for (const p of patches) doc = applyPatchToCanvas(doc, p as any);
    expect(doc.children).toHaveLength(0);
    expect(doc.pages.find((p: any) => p.name === 'Explorations').children).toHaveLength(2);
  });

  it('prunes oldest parked sections FIFO at 5', () => {
    let doc = emptyDocument('doc-parking') as any;
    // Pre-fill 4 parked sections + add 2 more => 6 total => prune to 5.
    doc.pages = [
      { id: 'p1', name: 'Page 1', children: [] },
      {
        id: 'p2',
        name: 'Explorations',
        children: Array.from({ length: 4 }, (_, i) => ({
          id: `old${i}`,
          type: 'section',
          name: `Old ${i}`,
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          children: [spec(`old${i}`)],
        })),
      },
    ];
    doc.activePageIndex = 0;
    const { patches } = buildParkingPatches({ doc, variants, judge, winnerIndex: 0 });
    const removePatches = patches.filter((p) => p.op === 'remove');
    expect(removePatches).toHaveLength(1); // 4 + 2 = 6 > 5 → drop the oldest
    expect((removePatches[0] as any).shapeIds).toEqual(['old0']);
    // Runtime verification: the applier's remove op prunes the ACTIVE tree
    // only, so the builder brackets the prune with set_active_page patches —
    // after the sequence the prune actually happened and the user's page is
    // restored.
    let applied: any = doc;
    for (const p of patches) applied = applyPatchToCanvas(applied, p as any);
    const explorations = applied.pages.find((p: any) => p.name === 'Explorations');
    expect(explorations.children).toHaveLength(5);
    expect(explorations.children.map((c: any) => c.id)).not.toContain('old0');
    expect(explorations.children[0].id).toBe('old1');
    expect(applied.activePageIndex).toBe(0); // user's page restored
    expect(applied.children).toHaveLength(0);
  });

  it('wraps each runner-up spec root in a section with a FRESH id (no collision with the applied winner)', () => {
    const doc = emptyDocument('doc-parking') as any;
    doc.pages = [{ id: 'p1', name: 'Page 1', children: [] }, { id: 'p2', name: 'Explorations', children: [] }];
    doc.activePageIndex = 0;
    const { patches, parked } = buildParkingPatches({ doc, variants, judge, winnerIndex: 0 });
    const sectionPatches = patches.filter((p) => p.op === 'add_subtree');
    for (const p of sectionPatches) {
      const shape = (p as any).shape as { id: string; type: string; children: Array<{ id: string }> };
      expect(shape.type).toBe('section');
      expect(shape.id).toBe((p as any).shapeId);
      expect(shape.children).toHaveLength(1);
      // The spec root's ORIGINAL id (v-B / v-C) is replaced with a fresh one —
      // the winner path already applied a tree carrying its own ids.
      expect(['v-B', 'v-C']).not.toContain(shape.children[0].id);
      expect(shape.children[0].id).not.toBe(shape.id);
    }
    // parked[].id IS the section node id (the promote route's key).
    expect(parked.map((p) => p.id)).toEqual(sectionPatches.map((p) => (p as any).shapeId));
  });

  it('keeps the builder pure — the input document is not mutated', () => {
    const doc = emptyDocument('doc-parking') as any;
    doc.pages = [{ id: 'p1', name: 'Page 1', children: [] }, { id: 'p2', name: 'Explorations', children: [] }];
    doc.activePageIndex = 0;
    const before = JSON.stringify(doc);
    buildParkingPatches({ doc, variants, judge, winnerIndex: 0 });
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('carries thumbnails as data URLs within the 150KB budget, omits over-budget ones', () => {
    const doc = emptyDocument('doc-parking') as any;
    doc.pages = [{ id: 'p1', name: 'Page 1', children: [] }, { id: 'p2', name: 'Explorations', children: [] }];
    doc.activePageIndex = 0;
    const small = Buffer.from('small-png-bytes');
    const big = Buffer.alloc(150_001, 7);
    const withPng = [
      { ...variants[0], png: small }, // winner — never parked, thumbnail irrelevant
      { ...variants[1], png: big }, // runner-up B — over budget → omitted
      { ...variants[2], png: small }, // runner-up C — within budget → data URL
    ];
    const { parked } = buildParkingPatches({ doc, variants: withPng, judge, winnerIndex: 0 });
    expect(parked).toHaveLength(2);
    expect(parked[0].label).toBe('Variant B — 7');
    expect(parked[0].thumbnail).toBeUndefined(); // 150_001 > 150_000 → omitted, never fails
    expect(parked[1].thumbnail).toBe(`data:image/png;base64,${small.toString('base64')}`);
  });

  it('parks nothing without a judge or a valid winnerIndex (fatal-path guard)', () => {
    const doc = emptyDocument('doc-parking') as any;
    expect(buildParkingPatches({ doc, variants, judge: null, winnerIndex: 0 })).toEqual({ patches: [], parked: [] });
    expect(buildParkingPatches({ doc, variants, judge, winnerIndex: 9 }).parked).toEqual([]);
    expect(buildParkingPatches({ doc: { ...doc, pages: [{ id: 'p1', name: 'Page 1', children: [] }] } as any, variants, judge, winnerIndex: -1 }).patches).toEqual([]);
  });
});

describe('pen_generate_variants parking wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits the parking patches through details.patches AFTER the winner patch', async () => {
    const { dispatchVariantGeneration } = await import('@/lib/agent/subagents/variant-generator');
    const mockedDispatch = dispatchVariantGeneration as unknown as ReturnType<typeof vi.fn>;
    mockedDispatch.mockResolvedValue({
      variants,
      judge,
      generationMs: 1,
      notes: [],
    });

    const { createCanvasTools } = await import('@/lib/agent/tools');
    let doc: any = emptyDocument('doc-parking-wiring');
    const applied: any[] = [];
    const ctx = {
      getShapes: () => doc.shapes ?? [],
      getTokens: () => doc.tokens ?? { colors: [], textStyles: [] },
      getDocument: () => doc,
      applyPatch: (p: any) => {
        applied.push(p);
        doc = applyPatchToCanvas(doc, p);
        return p;
      },
    };
    const tools = (createCanvasTools as unknown as (c: unknown) => any[])(ctx);
    const tool = tools.find((t) => t.name === 'pen_generate_variants');
    expect(tool).toBeTruthy();
    const result = await tool.execute('call-variants', { request: 'a pricing page' }, undefined, undefined, ctx);

    // The streamed patch sequence: winner first, then the parking sequence
    // (add_page → parked sections → active-page restore, because the page-less
    // doc migrates the winner into implicit "Page 1" and the builder returns
    // the user there).
    const patches = result.details.patches as any[];
    expect(Array.isArray(patches)).toBe(true);
    expect(patches[0].op).toBe('add_subtree');
    expect(patches[0].pageName).toBeUndefined(); // winner → active page
    expect(patches[1].op).toBe('add_page');
    expect(patches[1].pageName).toBe('Explorations');
    expect(patches.slice(2, 4).every((p) => p.op === 'add_subtree' && p.pageName === 'Explorations')).toBe(true);
    expect(patches[4].op).toBe('set_active_page'); // restore the user's page
    expect(patches).toHaveLength(5); // winner + add_page + 2 parked sections + restore
    // Back-compat: details.patch is still the winner patch.
    expect(result.details.patch).toBe(patches[0]);
    // Local application mirrors the stream (pageId read-back works).
    expect(applied.map((p) => p.op)).toEqual(patches.map((p) => p.op));
    const explorations = doc.pages.find((p: any) => p.name === 'Explorations');
    expect(explorations.children).toHaveLength(2);
    // The tool result text announces the parking.
    expect(result.content[0].text).toContain('2 runner-up variants parked on the Explorations page.');
  });
});
