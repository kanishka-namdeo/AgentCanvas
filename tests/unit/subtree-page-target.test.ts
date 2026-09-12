// Unit tests — `add_subtree` / `bulk_add` honor a pageName/pageId target page
// (designer-workflow-parity spec §4.1 patch layer).
//
// The variant-parking workflow emits `add_subtree` patches with
// `pageName: 'Explorations'`; those inserts must land on the NAMED page, not
// the active one. Contracts pinned here:
//   - a non-active target page receives the subtree; the active tree
//     (`next.children`) is untouched, so off-page inserts never appear in the
//     derived `shapes` render cache (no viewport reveal);
//   - an unknown `pageName` AUTO-CREATES the page (deterministic id
//     `page-<lowercased-name-with-hyphens-for-spaces>`) — a null-safe
//     defense, never the happy path (the tool layer emits `add_page` first);
//   - an unknown `pageId` with no name is a silent no-op (patch applier
//     null-safety convention);
//   - no pageName/pageId, or a target that IS the active page → behavior is
//     byte-identical to the pre-page-target applier (D1 write-back keeps
//     `pages[activePageIndex].children` in sync with `next.children`).
//
// Brief adaptation: the task brief imported `emptyDocument` from
// `@/lib/canvas/patch`; that helper actually lives in `@/lib/canvas/journal-fold`
// and takes a `documentId` argument — import/call adapted, assertions unchanged.

import { describe, it, expect } from 'vitest';
import { applyPatchToCanvas } from '@/lib/canvas/patch';
import { emptyDocument } from '@/lib/canvas/journal-fold';

const subtree = { id: 'root1', type: 'frame', name: 'Variant A', x: 0, y: 0, width: 100, height: 80, children: [] };

describe('add_subtree page target', () => {
  it('inserts into the named page when it is not active', () => {
    const doc = emptyDocument('doc-page-target');
    doc.pages = [{ id: 'p1', name: 'Page 1', children: [] }, { id: 'p2', name: 'Explorations', children: [] }];
    doc.activePageIndex = 0;
    const next = applyPatchToCanvas(doc as any, { op: 'add_subtree', shape: subtree, pageName: 'Explorations' } as any);
    expect(next.pages![1].children).toHaveLength(1);
    expect(next.children).toHaveLength(0); // active page untouched
    expect(next.pages![1].children[0].id).toBe('root1');
  });

  it('auto-creates the page for an unknown name (defense, never the happy path)', () => {
    const doc = emptyDocument('doc-page-target');
    const next = applyPatchToCanvas(doc as any, { op: 'add_subtree', shape: subtree, pageName: 'Explorations' } as any);
    const page = next.pages!.find((p) => p.name === 'Explorations');
    expect(page).toBeTruthy();
    expect(page!.children).toHaveLength(1);
    expect(next.children).toHaveLength(0);
  });

  it('auto-created page id is deterministic (page-<lowercased-slug>)', () => {
    const doc = emptyDocument('doc-page-target');
    const next = applyPatchToCanvas(doc as any, { op: 'add_subtree', shape: subtree, pageName: 'My Explorations' } as any);
    expect(next.pages!.some((p) => p.id === 'page-my-explorations')).toBe(true);
  });

  it('behaves byte-identically to today when no pageName is given', () => {
    const doc = emptyDocument('doc-page-target');
    const next = applyPatchToCanvas(doc as any, { op: 'add_subtree', shape: subtree } as any);
    expect(next.children).toHaveLength(1);
  });

  it('behaves byte-identically when the target page IS the active page', () => {
    const doc = emptyDocument('doc-page-target');
    doc.pages = [{ id: 'p1', name: 'Page 1', children: [] }, { id: 'p2', name: 'Explorations', children: [] }];
    doc.activePageIndex = 0;
    const next = applyPatchToCanvas(doc as any, { op: 'add_subtree', shape: subtree, pageName: 'Page 1' } as any);
    // Active-tree insert, and the D1 write-back keeps the active page in sync.
    expect(next.children).toHaveLength(1);
    expect(next.pages![0].children).toHaveLength(1);
    expect(next.pages![1].children).toHaveLength(0);
  });

  it('an unknown pageId with no name is a silent no-op', () => {
    const doc = emptyDocument('doc-page-target');
    const next = applyPatchToCanvas(doc as any, { op: 'add_subtree', shape: subtree, pageId: 'no-such-page' } as any);
    expect(next.children).toHaveLength(0);
    expect(next.pages).toBeUndefined();
  });

  it('off-page inserts never appear in the derived shapes cache', () => {
    const doc = emptyDocument('doc-page-target');
    doc.pages = [{ id: 'p1', name: 'Page 1', children: [] }, { id: 'p2', name: 'Explorations', children: [] }];
    doc.activePageIndex = 0;
    const next = applyPatchToCanvas(doc as any, { op: 'add_subtree', shape: subtree, pageName: 'Explorations' } as any);
    expect(next.shapes.some((s) => s.id === 'root1')).toBe(false);
    expect(next.shapes).toHaveLength(0);
  });

  it('the parked subtree loads when the target page is later activated (D1 write-back integrity)', () => {
    const doc = emptyDocument('doc-page-target');
    doc.pages = [{ id: 'p1', name: 'Page 1', children: [] }, { id: 'p2', name: 'Explorations', children: [] }];
    doc.activePageIndex = 0;
    const parked = applyPatchToCanvas(doc as any, { op: 'add_subtree', shape: subtree, pageName: 'Explorations' } as any);
    const next = applyPatchToCanvas(parked, { op: 'set_active_page', pageName: 'Explorations' } as any);
    expect(next.activePageIndex).toBe(1);
    expect(next.children.map((c) => c.id)).toContain('root1');
  });
});

describe('bulk_add page target', () => {
  it('inserts every root into the named page, leaving the active tree untouched', () => {
    const doc = emptyDocument('doc-page-target');
    doc.pages = [{ id: 'p1', name: 'Page 1', children: [] }, { id: 'p2', name: 'Explorations', children: [] }];
    doc.activePageIndex = 0;
    const next = applyPatchToCanvas(doc as any, {
      op: 'bulk_add',
      shapes: [
        { id: 'a1', type: 'frame', name: 'A', x: 0, y: 0, width: 10, height: 10, children: [] },
        { id: 'b1', type: 'frame', name: 'B', x: 20, y: 0, width: 10, height: 10, children: [] },
      ],
      pageName: 'Explorations',
    } as any);
    expect(next.pages![1].children.map((c) => c.id)).toEqual(['a1', 'b1']);
    expect(next.children).toHaveLength(0);
    expect(next.pages![0].children).toHaveLength(0);
  });

  it('behaves byte-identically to today when no pageName is given', () => {
    const doc = emptyDocument('doc-page-target');
    const next = applyPatchToCanvas(doc as any, {
      op: 'bulk_add',
      shapes: [{ id: 'a1', type: 'frame', name: 'A', x: 0, y: 0, width: 10, height: 10, children: [] }],
    } as any);
    expect(next.children).toHaveLength(1);
  });
});

// The variant-parking FIFO prune (designer-workflow-parity §4.1, controller
// ruling extending the Task 3 page target to `remove`): a `remove` carrying
// pageName/pageId prunes from THAT page's children — the variant parking
// workflow removes parked sections from the non-active Explorations page
// without any active-page switching. Removal NEVER auto-creates (an unknown
// pageName/pageId is a silent no-op — that defense is insert-only).
describe('remove page target', () => {
  const parked = (id: string): any => ({ id, type: 'section', name: id, x: 0, y: 0, width: 0, height: 0, children: [] });

  function docWithParkedPages() {
    const doc = emptyDocument('doc-remove-target');
    doc.pages = [
      { id: 'p1', name: 'Page 1', children: [] },
      { id: 'p2', name: 'Explorations', children: [parked('old0'), parked('old1'), parked('old2')] },
    ];
    doc.activePageIndex = 0;
    return doc as any;
  }

  it('removes ids from the named non-active page, leaving the active tree untouched', () => {
    const next = applyPatchToCanvas(docWithParkedPages(), { op: 'remove', shapeIds: ['old0'], pageName: 'Explorations' } as any);
    expect(next.pages![1].children.map((c) => c.id)).toEqual(['old1', 'old2']);
    expect(next.children).toHaveLength(0); // active tree untouched
    expect(next.activePageIndex).toBe(0);
  });

  it('removes a DEEP id inside a section on the named page (recursive prune)', () => {
    const doc = docWithParkedPages();
    (doc.pages[1].children[0] as any).children = [{ id: 'deep1', type: 'frame', name: 'deep', x: 0, y: 0, width: 10, height: 10, children: [] }];
    const next = applyPatchToCanvas(doc, { op: 'remove', shapeIds: ['deep1'], pageName: 'Explorations' } as any);
    expect((next.pages![1].children[0] as any).children).toHaveLength(0);
    expect(next.pages![1].children.map((c) => c.id)).toEqual(['old0', 'old1', 'old2']); // sections stay
    expect(next.children).toHaveLength(0);
  });

  it('behaves byte-identically to the legacy remove when no page target is given', () => {
    const doc = emptyDocument('doc-remove-target');
    doc.children = [parked('root1'), parked('root2')] as any;
    const next = applyPatchToCanvas(doc as any, { op: 'remove', shapeIds: ['root1'] } as any);
    expect(next.children.map((c) => c.id)).toEqual(['root2']);
  });

  it('behaves byte-identically when the target page IS the active page (D1 write-back sync)', () => {
    const doc = docWithParkedPages();
    doc.activePageIndex = 1;
    doc.children = doc.pages[1].children;
    const next = applyPatchToCanvas(doc, { op: 'remove', shapeIds: ['old1'], pageName: 'Explorations' } as any);
    expect(next.children.map((c) => c.id)).toEqual(['old0', 'old2']); // legacy active-tree removal
    expect(next.pages![1].children.map((c) => c.id)).toEqual(['old0', 'old2']); // write-back in sync
  });

  it('an unknown pageName is a silent no-op (removal never auto-creates)', () => {
    const doc = docWithParkedPages();
    const next = applyPatchToCanvas(doc, { op: 'remove', shapeIds: ['old0'], pageName: 'Nowhere' } as any);
    expect(next.pages![1].children.map((c) => c.id)).toEqual(['old0', 'old1', 'old2']);
    expect(next.pages).toHaveLength(2); // no auto-created page
    expect(next.children).toHaveLength(0);
  });

  it('an unknown pageId is a silent no-op', () => {
    const doc = docWithParkedPages();
    const next = applyPatchToCanvas(doc, { op: 'remove', shapeIds: ['old0'], pageId: 'no-such-page' } as any);
    expect(next.pages![1].children.map((c) => c.id)).toEqual(['old0', 'old1', 'old2']);
    expect(next.children).toHaveLength(0);
  });

  it('an off-page prune never surfaces the parked sections in the derived shapes cache', () => {
    const next = applyPatchToCanvas(docWithParkedPages(), { op: 'remove', shapeIds: ['old0'], pageName: 'Explorations' } as any);
    expect(next.shapes).toHaveLength(0); // active tree is empty; parked sections stay off the cache
  });
});
