// Unit tests — 2026-09-06 one-shot/multi-shot design generation hardening.
//
// Two live bugs surfaced by the e2e design scenarios (scripts/e2e-design-scenarios.ts):
//
//  BUG 1 "card rectangle drops descendants": the model authored a login
//  screen as ONE add_subtree whose "Centered Card Container" was a
//  `rectangle` with 16 nested descendants. Every tree primitive + the
//  resolver only descended into TYPE-containers (frame/group/…), so the
//  18-node tree resolved to 2 shapes — the card rendered empty and later
//  update/remove patches could not even FIND the descendants.
//
//    Fix: (a) patch ingest PROMOTES structural leaves carrying children to
//    'frame' (normalizeToNode + normalizeSubtree, Figma's nesting-into-a-
//    rectangle behavior); (b) the container predicates in document.ts and
//    resolve.ts accept any non-content-leaf node that structurally HAS
//    children — healing trees persisted before (a); (c) insertNode /
//    insertUnderParent promote a bare non-container parentId target instead
//    of silently dropping the insert.
//
//  BUG 2 "stopReason error swallowed": a message ending with stopReason
//  'error' (mid-iteration provider failure) resolves prompt() WITHOUT
//  throwing, so every retry tier skipped it and the turn exited
//  "complete" with a half-built canvas. Fix: the runner tail surfaces an
//  honest agent:error (status=error → the UI retry banner) — pinned here
//    via source-scan invariants + the runner-legacy echo guard.

import { describe, it, expect } from 'vitest';
import { applyPatchToCanvas } from '@/lib/canvas/patch';
import type { CanvasDocument, CanvasPatch } from '@/lib/canvas/types';
import type { PenChild } from '@/lib/pen/types';
import { resolvePenTree } from '@/lib/pen/resolve';
import { findNode, insertNode, isContainerLike } from '@/lib/pen/document';
import { readFileSync } from 'node:fs';

function freshDoc(id = 'promo-doc'): CanvasDocument {
  return {
    id, name: 'Promo', background: '#ffffff', version: '2.17',
    children: [], viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes: [], tokens: { colors: [], textStyles: [] },
  } as CanvasDocument;
}

const CARD_TREE = {
  type: 'rectangle',
  name: 'Centered Card Container',
  x: 520, y: 200, width: 400, height: 'fit_content',
  fill: '#ffffff', radius: 16,
  autoLayout: { direction: 'vertical', gap: 24, padding: 40 },
  children: [
    { type: 'text', name: 'Title', text: 'Welcome back', fontSize: 28, fontWeight: 700 },
    { type: 'rectangle', name: 'Email Input Container', width: 320, height: 'fit_content', autoLayout: { direction: 'vertical', gap: 8 }, children: [
      { type: 'text', name: 'Email Label', text: 'Email', fontSize: 13 },
      { type: 'rectangle', name: 'Email Input Field', width: 320, height: 44, fill: '#f1f5f9' },
    ] },
    { type: 'rectangle', name: 'Button', width: 320, height: 48, fill: '#4f46e5', children: [
      { type: 'text', name: 'Button Text', text: 'Log in', textColor: '#ffffff' },
    ] },
  ],
} as unknown as Record<string, unknown>;

describe('card-rectangle container promotion (patch ingest)', () => {
  it('add_subtree promotes a rectangle root with children to a frame and resolves ALL descendants', () => {
    const doc = applyPatchToCanvas(freshDoc(), { op: 'add_subtree', shapeId: 'root', shape: CARD_TREE } as CanvasPatch);
    expect(doc.shapes.length).toBe(7); // card + title + email container + label + field + button + button text
    const card = doc.shapes.find((s) => s.name === 'Centered Card Container')!;
    expect(card.type).toBe('frame'); // promoted
    expect(card.width).toBe(400);
    expect(card.height).toBeGreaterThan(100); // hugs content, not the 100px default
    const root = doc.children[0] as { type: string; children: PenChild[] };
    expect(root.type).toBe('frame');
    expect((root.children ?? []).length).toBe(3);
  });

  it('nested rectangle-with-children inside a promoted tree also promotes (recursive)', () => {
    const doc = applyPatchToCanvas(freshDoc(), { op: 'add_subtree', shapeId: 'root', shape: CARD_TREE } as CanvasPatch);
    const email = doc.shapes.find((s) => s.name === 'Email Input Container')!;
    expect(email.type).toBe('frame');
    expect(doc.shapes.find((s) => s.name === 'Email Input Field')).toBeTruthy();
  });

  it('add (single) promotes a rectangle payload carrying children', () => {
    const doc = applyPatchToCanvas(freshDoc(), { op: 'add', shapeId: 'card', shape: { ...CARD_TREE, id: 'card' } } as CanvasPatch);
    expect(doc.children[0].type).toBe('frame');
    expect(doc.shapes.length).toBe(7);
  });

  it('content leaves (text) are NEVER promoted — children ride but do not resolve', () => {
    const doc = applyPatchToCanvas(freshDoc(), {
      op: 'add_subtree', shapeId: 't',
      shape: { type: 'text', name: 'Odd Text', text: 'hi', children: [{ type: 'text', name: 'Inner', text: 'nested' }] },
    } as unknown as CanvasPatch);
    expect(doc.children[0].type).toBe('text');
    // Pre-existing behavior for content leaves: children present in the tree,
    // ignored by the resolver (documented, unchanged).
    expect(doc.shapes.length).toBe(1);
  });

  it('inserting under a bare rectangle parentId promotes the target (Figma nesting behavior)', () => {
    let doc = applyPatchToCanvas(freshDoc(), { op: 'add', shapeId: 'plain', shape: { type: 'rectangle', name: 'Plain', x: 0, y: 0, width: 100, height: 100 } } as CanvasPatch);
    expect(doc.children[0].type).toBe('rectangle');
    doc = applyPatchToCanvas(doc, { op: 'add', shapeId: 'badge', shape: { type: 'rectangle', name: 'Badge', width: 80, height: 24, parentId: 'plain' } } as CanvasPatch);
    const plain = doc.children[0] as { type: string; children: PenChild[] };
    expect(plain.type).toBe('frame'); // promoted by the nested insert
    expect((plain.children ?? []).length).toBe(1);
    expect(doc.shapes.find((s) => s.name === 'Badge')).toBeTruthy();
  });

  it('update targeting a descendant of a promoted container FINDS it (walkers descend)', () => {
    let doc = applyPatchToCanvas(freshDoc(), { op: 'add_subtree', shapeId: 'root', shape: CARD_TREE } as CanvasPatch);
    // Legacy-shaped tree the OLD walkers could not search: rebuild children
    // with the ids the subtree assigned (root-1, root-1-1, …) is fragile —
    // instead drive the REAL id flow: the resolver produced shape ids.
    const field = doc.shapes.find((s) => s.name === 'Email Input Field')!;
    doc = applyPatchToCanvas(doc, { op: 'update', shapeId: field.id, shape: { fill: '#111827' } } as CanvasPatch);
    const updated = doc.shapes.find((s) => s.name === 'Email Input Field')!;
    expect(updated.fill).toBe('#111827');
  });

  it('remove targeting a descendant of a promoted container removes it', () => {
    let doc = applyPatchToCanvas(freshDoc(), { op: 'add_subtree', shapeId: 'root', shape: CARD_TREE } as CanvasPatch);
    const title = doc.shapes.find((s) => s.name === 'Title')!;
    doc = applyPatchToCanvas(doc, { op: 'remove', shapeIds: [title.id] } as CanvasPatch);
    expect(doc.shapes.find((s) => s.name === 'Title')).toBeUndefined();
    expect(doc.shapes.length).toBe(6);
  });
});

describe('structural container predicate heals pre-promotion trees', () => {
  it('resolvePenTree descends into a rectangle-with-children tree authored BEFORE the promotion fix', () => {
    // Simulate a legacy persisted tree: type stays 'rectangle' but children exist.
    const legacyTree: PenChild[] = [{
      id: 'legacy-root', type: 'frame', name: 'Page', x: 0, y: 0, width: 800, height: 600,
      children: [
        { id: 'legacy-card', type: 'rectangle', name: 'Legacy Card', x: 100, y: 100, width: 300, height: 'fit_content', fill: '#ffffff', children: [
          { id: 'legacy-title', type: 'text', name: 'Legacy Title', text: 'Hello', fontSize: 20 },
          { id: 'legacy-sub', type: 'rectangle', name: 'Legacy Sub', x: 0, y: 0, width: 200, height: 40, fill: '#e2e8f0' },
        ] } as unknown as PenChild,
      ],
    } as unknown as PenChild];
    const doc = { ...freshDoc('legacy'), children: legacyTree };
    const shapes = resolvePenTree(doc);
    expect(shapes.length).toBe(4); // page + card + title + sub — descendants NOT dropped
    expect(shapes.find((s) => s.name === 'Legacy Title')).toBeTruthy();
  });

  it('isContainerLike: structural children count; content leaves excluded', () => {
    const rectWithKids = { type: 'rectangle', children: [{ type: 'text' }] } as unknown as PenChild;
    const bareRect = { type: 'rectangle' } as unknown as PenChild;
    const textWithKids = { type: 'text', children: [{ type: 'text' }] } as unknown as PenChild;
    const frame = { type: 'frame' } as unknown as PenChild;
    expect(isContainerLike(rectWithKids)).toBe(true);
    expect(isContainerLike(bareRect)).toBe(false);
    expect(isContainerLike(textWithKids)).toBe(false);
    expect(isContainerLike(frame)).toBe(true);
  });

  it('findNode finds nodes inside a legacy rectangle-with-children subtree', () => {
    const tree: PenChild[] = [{
      id: 'p', type: 'frame', name: 'P', children: [
        { id: 'c', type: 'rectangle', name: 'C', children: [{ id: 'deep', type: 'text', name: 'Deep' }] } as unknown as PenChild,
      ],
    } as unknown as PenChild];
    expect(findNode(tree, 'deep')).toBeTruthy();
    expect(findNode(tree, 'missing')).toBeUndefined();
  });

  it('insertNode into a legacy rectangle-with-children appends (no drop)', () => {
    const tree: PenChild[] = [
      { id: 'c', type: 'rectangle', name: 'C', children: [{ id: 'deep', type: 'text', name: 'Deep' }] } as unknown as PenChild,
    ];
    const node: PenChild = { id: 'new', type: 'text', name: 'New' } as unknown as PenChild;
    const next = insertNode(tree, node, 'deep');
    // 'deep' is a text (content leaf) — the insert is dropped (pre-existing,
    // documented behavior: never promote content leaves). map() still returns
    // a fresh top-level array, so compare by CONTENT + absence of the node.
    expect(next).toStrictEqual(tree);
    expect(findNode(next, 'new')).toBeUndefined();
    const next2 = insertNode(tree, node, 'c');
    const card = findNode(next2, 'c') as unknown as { children?: PenChild[] };
    expect((card.children ?? []).length).toBe(2);
  });
});

describe('fill-container cascade (2026-09-06 dashboard e2e bug)', () => {
  // Screen 1280 > Content (fill) > StatsRow (fill): the bottom-up pass sizes
  // the parent AFTER its children, so a fill grandchild resolved against the
  // parent's pre-fill width (0) — Phase B only fixed DIRECT children. The
  // top-down fill-cascade in layoutTree re-resolves fill children at every
  // depth before positioning.
  it('fill chains two+ levels deep resolve to the parent content size (not 0)', () => {
    const doc = applyPatchToCanvas(freshDoc('fill-chain'), {
      op: 'add_subtree',
      shapeId: 'screen',
      shape: {
        type: 'frame', name: 'Screen', width: 1280, height: 800,
        children: [
          { type: 'frame', name: 'Content', width: 'fill_container', height: 'fit_content', autoLayout: { direction: "vertical", gap: 16, padding: 32 }, children: [
            { type: 'frame', name: 'StatsRow', width: 'fill_container', height: 120, autoLayout: { direction: "horizontal", gap: 24 }, children: [
              { type: 'rectangle', name: 'StatCard', width: 280, height: 120, fill: '#e2e8f0' },
              { type: 'rectangle', name: 'StatCard2', width: 280, height: 120, fill: '#e2e8f0' },
            ] },
            { type: 'frame', name: 'ChartArea', width: 'fill_container', height: 300 },
          ] },
        ],
      },
    } as unknown as CanvasPatch);
    const stats = doc.shapes.find((s) => s.name === 'StatsRow')!;
    const chart = doc.shapes.find((s) => s.name === 'ChartArea')!;
    const content = doc.shapes.find((s) => s.name === 'Content')!;
    expect(content.width).toBe(1280);
    expect(stats.width).toBe(1280 - 64); // 1216 = Content 1280 - 2*32 padding
    expect(chart.width).toBe(1280 - 64);
    expect(stats.width).toBeGreaterThan(0);
  });

  it('fill heights cascade too (fill_container height under a fill parent)', () => {
    const doc = applyPatchToCanvas(freshDoc('fill-h'), {
      op: 'add_subtree',
      shapeId: 'screen',
      shape: {
        type: 'frame', name: 'Screen', width: 1000, height: 600,
        children: [
          { type: 'frame', name: 'Sidebar', width: 240, height: 'fill_container', fill: '#f8fafc' },
          { type: 'frame', name: 'Main', width: 'fill_container', height: 'fill_container', autoLayout: { direction: "vertical" }, children: [
            { type: 'frame', name: 'Toolbar', width: 'fill_container', height: 48 },
          ] },
        ],
      },
    } as unknown as CanvasPatch);
    const main = doc.shapes.find((s) => s.name === 'Main')!;
    const sidebar = doc.shapes.find((s) => s.name === 'Sidebar')!;
    const toolbar = doc.shapes.find((s) => s.name === 'Toolbar')!;
    expect(sidebar.height).toBe(600);
    // Static fill semantics: fill_container = the parent's CONTENT area (the
    // DOM native renderer applies real flexbox on top). Main fills Screen's
    // full width; Toolbar cascades Main's width one level deeper.
    expect(main.width).toBe(1000);
    expect(main.height).toBe(600);
    expect(toolbar.width).toBe(main.width);
  });
});

describe('runner stopReason-error surfacing (source-scan invariants)', () => {
  const runnerSrc = readFileSync('src/lib/agent/runner-native.ts', 'utf8');

  it('the tail guard reads lastStopReason and surfaces stopReason "error" as agent:error', () => {
    // The guard must include the stopReason branch so a provider failure that
    // settles prompt() without throwing cannot exit status=complete.
    expect(runnerSrc).toContain('const stopReasonError = lastStopReason === \'error\';');
    expect(runnerSrc).toMatch(/designTurnNeverDrew \|\| stopReasonError/);
    expect(runnerSrc).toContain("finish reason: error");
  });

  it('container promotion is wired into the ingest boundary (patch.ts)', () => {
    const patchSrc = readFileSync('src/lib/canvas/patch.ts', 'utf8');
    expect(patchSrc).toContain('isPromotableToContainer');
    expect(patchSrc).toContain('isContainerLike');
    // The four former local type-list copies are gone (single source of truth).
    expect(patchSrc).not.toMatch(/const isContainer =\s*\n?\s*c\.type === 'frame'/);
  });

  it('document.ts exports the structural predicate and PEN_CONTENT_LEAF_TYPES exists', () => {
    const docSrc = readFileSync('src/lib/pen/document.ts', 'utf8');
    expect(docSrc).toContain('export const isContainerLike');
    expect(docSrc).toContain('isPromotableToContainer');
    const typesSrc = readFileSync('src/lib/pen/types.ts', 'utf8');
    expect(typesSrc).toContain('PEN_CONTENT_LEAF_TYPES');
  });

  it('resolve.ts container predicate has the structural branch', () => {
    const resolveSrc = readFileSync('src/lib/pen/resolve.ts', 'utf8');
    expect(resolveSrc).toContain('PEN_CONTENT_LEAF_TYPES.has(node.type)');
  });
});
