// pen_audit_design — Phase 4 §4.5 node-budget warnings tests.
//
// Pins the three new node-budget findings the audit surfaces:
//   (a) Per-frame budget: top-level frames with > 300 descendants
//   (b) Per-page budget: total node count > 4000 approaching the 5k L5 threshold
//   (c) Component_set repeat detection: ≥ 3 top-level frames with the same
//       structural fingerprint (child types + per-child descendant count)
//
// Plus a regression: existing audit findings (color, font, contrast, tokens,
// alignment) are still emitted alongside the new node-budget findings.

import { describe, it, expect, beforeEach } from 'vitest';
import { createCanvasTools, executeTool } from '@/lib/agent/tools';
import type { CanvasToolContext } from '@/lib/agent/tools';
import type { CanvasDocument, CanvasPatch, DesignTokens } from '@/lib/canvas/types';
import type { PenChild } from '@/lib/pen/types';
import { applyPatchToCanvas } from '@/lib/canvas/patch';
import { resolvePenTreeDetailed } from '@/lib/pen/resolve';

// ---- Test harness (mirrors tests/unit/tools-mcp.test.ts) --------------------

interface TestHarness {
  doc: CanvasDocument;
  ctx: CanvasToolContext;
  addPenNode(node: PenChild): void;
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
  const ctx: CanvasToolContext = {
    getShapes: () => doc.shapes,
    getTokens: () => doc.tokens,
    getDocument: () => doc,
    applyPatch: (p) => {
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
    ctx,
    addPenNode(node) {
      doc.children.push(node);
      doc.shapes = resolvePenTreeDetailed(doc).layers;
    },
  };
}

let h: TestHarness;
beforeEach(() => {
  h = makeHarness();
});

async function runAudit(): Promise<{ text: string; details: any }> {
  const tool = createCanvasTools(h.ctx).find((t: any) => t.name === 'pen_audit_design') as any;
  expect(tool).toBeDefined();
  const result = await tool.execute('audit-test-call', {}, undefined, undefined, undefined);
  return {
    text: (result.content[0]?.text as string) ?? '',
    details: result.details ?? {},
  };
}

// ---- Helpers for building documents of various sizes ------------------------

function makeFrame(id: string, parentId: string | null = null): PenChild {
  return {
    id,
    type: 'frame',
    name: id,
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    parentId,
  } as PenChild;
}

function makeRect(id: string, parentId: string): PenChild {
  return {
    id,
    type: 'rectangle',
    name: id,
    x: 0,
    y: 0,
    width: 50,
    height: 50,
    fill: '#cccccc',
    parentId,
  } as PenChild;
}

function makeText(id: string, parentId: string, content = 'Text'): PenChild {
  return {
    id,
    type: 'text',
    name: id,
    x: 0,
    y: 0,
    width: 100,
    height: 20,
    fill: '#ffffff',
    textColor: '#000000',
    fontSize: 16,
    text: content,
    parentId,
  } as PenChild;
}

/// Find a node anywhere in the .pen tree (recursive DFS). Used to add
/// descendants to nested frames (the test setup pushes top-level frames
/// to `doc.children` and inner frames to their parent's `children` array).
function findNodeRecursive(nodes: PenChild[], id: string): PenChild | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    const children = (n as { children?: PenChild[] }).children;
    if (children) {
      const found = findNodeRecursive(children, id);
      if (found) return found;
    }
  }
  return undefined;
}

/// Generate N descendant rectangles under a frame. Pushes them INSIDE the
/// frame's `children` array so the resolver preserves the parent-child
/// relationship — flat-pushing to `doc.children` would make them siblings
/// at the top level instead.
function addDescendants(frameId: string, count: number, prefix = 'd') {
  const frame = findNodeRecursive(h.doc.children, frameId);
  if (!frame) throw new Error(`frame ${frameId} not found`);
  const frameWithChildren = frame as PenChild & { children: PenChild[] };
  if (!frameWithChildren.children) frameWithChildren.children = [];
  for (let i = 0; i < count; i++) {
    frameWithChildren.children.push({
      id: `${prefix}-${i}`,
      type: 'rectangle',
      name: `${prefix}-${i}`,
      x: 0,
      y: 0,
      width: 50,
      height: 50,
      fill: '#cccccc',
    } as PenChild);
  }
  h.doc.shapes = resolvePenTreeDetailed(h.doc).layers;
}

/// Add a child of any type inside a frame (push into the frame's children).
/// Searches the tree recursively for the frame (nested frames supported).
function addChildToFrame(frameId: string, child: PenChild) {
  const frame = findNodeRecursive(h.doc.children, frameId);
  if (!frame) throw new Error(`frame ${frameId} not found`);
  const frameWithChildren = frame as PenChild & { children: PenChild[] };
  if (!frameWithChildren.children) frameWithChildren.children = [];
  frameWithChildren.children.push(child);
  h.doc.shapes = resolvePenTreeDetailed(h.doc).layers;
}

// ---- Tests -------------------------------------------------------------------

describe('pen_audit_design node-budget warnings (Phase 4 §4.5)', () => {
  describe('(a) per-frame budget', () => {
    it('flags a top-level frame with > 300 descendants', async () => {
      h.addPenNode(makeFrame('huge-frame'));
      addDescendants('huge-frame', 310); // 310 rect descendants → over 300 budget
      const r = await runAudit();
      expect(r.text).toContain('huge-frame');
      expect(r.text).toMatch(/310 descendants/);
      expect(r.text).toMatch(/> 300 budget/);
      expect(r.details.nodeBudgetFindings).toBeGreaterThanOrEqual(1);
    });

    it('does NOT flag a top-level frame with exactly 300 descendants', async () => {
      h.addPenNode(makeFrame('ok-frame'));
      addDescendants('ok-frame', 300);
      const r = await runAudit();
      expect(r.text).not.toMatch(/ok-frame.*descendants.*> 300/);
    });

    it('does NOT flag a top-level frame with 50 descendants (well under budget)', async () => {
      h.addPenNode(makeFrame('small-frame'));
      addDescendants('small-frame', 50);
      const r = await runAudit();
      expect(r.text).not.toMatch(/small-frame.*descendants/);
    });

    it('counts NESTED descendants (transitive walk, not just direct children)', async () => {
      // outer frame contains an inner frame which contains 310 rects.
      h.addPenNode(makeFrame('outer'));
      addChildToFrame('outer', makeFrame('inner'));
      addDescendants('inner', 310);
      const r = await runAudit();
      // 310 rects + 1 inner frame = 311 descendants of 'outer'
      expect(r.text).toMatch(/outer.*311 descendants/);
    });

    it('ignores non-frame top-level shapes (rect/text/frame only)', async () => {
      // 400 loose top-level rects — none of them are frames, so no per-frame finding.
      for (let i = 0; i < 400; i++) {
        h.addPenNode(makeRect(`loose-${i}`, null as unknown as string));
      }
      const r = await runAudit();
      expect(r.text).not.toMatch(/> 300 budget/);
    });
  });

  describe('(b) per-page budget', () => {
    // 4001-node audit resolves the whole tree; runs ~4-5s standalone and
    // tips past the default 5s hook timeout under full-suite parallel load
    // (observed flake 2026-08-31, pre-existing before the resolver-warning
    // additions). Explicit budget keeps it deterministic.
    it('flags when page total exceeds 4000 nodes (approaching 5k L5 threshold)', { timeout: 30_000 }, async () => {
      // Build a doc with 4001 top-level rects. (Skip the 5k threshold to keep
      // the test fast — the audit checks >= 4000.)
      for (let i = 0; i < 4001; i++) {
        h.addPenNode(makeRect(`n-${i}`, null as unknown as string));
      }
      const r = await runAudit();
      expect(r.text).toMatch(/approaching the 5k L5-culling threshold/);
      expect(r.details.nodeBudgetFindings).toBeGreaterThanOrEqual(1);
    });

    it('does NOT flag a small page (under 4000 nodes)', async () => {
      h.addPenNode(makeFrame('small'));
      addDescendants('small', 100);
      const r = await runAudit();
      expect(r.text).not.toMatch(/L5-culling threshold/);
    });
  });

  describe('(c) component_set repeat detection', () => {
    it('flags when ≥ 3 top-level frames share the same child-type fingerprint', async () => {
      // 3 frames, each with the same structure: [rect, text]
      for (let i = 0; i < 3; i++) {
        const fid = `card-${i}`;
        h.addPenNode(makeFrame(fid));
        addChildToFrame(fid, makeRect(`${fid}-bg`, fid));
        addChildToFrame(fid, makeText(`${fid}-title`, fid, 'Title'));
      }
      const r = await runAudit();
      expect(r.text).toMatch(/Pattern repeat: 3 top-level frames/);
      expect(r.text).toMatch(/pen_combine_as_variants/);
    });

    it('does NOT flag when only 2 frames share a fingerprint (below ≥ 3 threshold)', async () => {
      for (let i = 0; i < 2; i++) {
        const fid = `card-${i}`;
        h.addPenNode(makeFrame(fid));
        addChildToFrame(fid, makeRect(`${fid}-bg`, fid));
        addChildToFrame(fid, makeText(`${fid}-title`, fid));
      }
      const r = await runAudit();
      expect(r.text).not.toMatch(/Pattern repeat/);
    });

    it('does NOT flag frames with different structures (different fingerprints)', async () => {
      // Frame A: [rect, text]. Frame B: [rect, rect, text]. Frame C: [text].
      h.addPenNode(makeFrame('a'));
      addChildToFrame('a', makeRect('a-bg', 'a'));
      addChildToFrame('a', makeText('a-t', 'a'));
      h.addPenNode(makeFrame('b'));
      addChildToFrame('b', makeRect('b-bg1', 'b'));
      addChildToFrame('b', makeRect('b-bg2', 'b'));
      addChildToFrame('b', makeText('b-t', 'b'));
      h.addPenNode(makeFrame('c'));
      addChildToFrame('c', makeText('c-t', 'c'));
      const r = await runAudit();
      expect(r.text).not.toMatch(/Pattern repeat/);
    });

    it('ignores empty frames (no children → no fingerprint)', async () => {
      for (let i = 0; i < 5; i++) {
        h.addPenNode(makeFrame(`empty-${i}`));
      }
      const r = await runAudit();
      expect(r.text).not.toMatch(/Pattern repeat/);
    });
  });

  describe('node-budget "good" status', () => {
    it('emits a "good" node-budget line when no findings', async () => {
      h.addPenNode(makeFrame('small'));
      addDescendants('small', 50);
      const r = await runAudit();
      expect(r.text).toMatch(/Node budget:.*within 300-descendant budget/);
      expect(r.details.nodeBudgetFindings).toBe(0);
    });
  });

  describe('regression: existing audit findings still emitted', () => {
    it('still reports color drift, font scale, contrast, tokens, alignment', async () => {
      h.addPenNode(makeFrame('frame'));
      addDescendants('frame', 5);
      const r = await runAudit();
      // The existing 5 audit sections still appear.
      expect(r.text).toMatch(/Color usage:/);
      expect(r.text).toMatch(/Type scale:/);
      expect(r.text).toMatch(/Text contrast:/);
      // Tokens message is one of two variants depending on whether tokens exist.
      expect(r.text).toMatch(/Design tokens:|No design tokens defined/);
    });
  });
});
