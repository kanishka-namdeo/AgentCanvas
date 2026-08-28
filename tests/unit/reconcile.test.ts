// Unit tests for the per-element document reconcile (R6 — the Excalidraw
// reconcileElements pattern ported to AgentCanvas's .pen tree).
//
// The module is pure: local doc + incoming doc → merged doc. Every rule from
// the module docs is pinned here, plus the idempotency property (re-running
// the same merge changes nothing — the reconnect/resync loop relies on it).

import { describe, it, expect } from 'vitest';
import { elementWins, reconcileDocuments } from '@/lib/canvas/reconcile';
import { applyPatchToCanvas } from '@/lib/canvas/patch';
import type { CanvasDocument, Shape } from '@/lib/canvas/types';
import type { PenChild } from '@/lib/pen/types';

// ---- Fixtures ----------------------------------------------------------------

function makeDoc(shapes: Shape[] = []): CanvasDocument {
  return {
    id: 'doc',
    name: 'Doc',
    background: '#ffffff',
    version: '2.17',
    children: shapes as unknown as PenChild[],
    viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes,
    tokens: { colors: [], textStyles: [] },
  };
}

function makeShape(
  id: string,
  fill = '#cccccc',
  version?: number,
  versionNonce?: number,
): Shape & { version?: number; versionNonce?: number } {
  return {
    id,
    type: 'rectangle',
    name: id,
    x: 0, y: 0, width: 100, height: 100,
    rotation: 0, opacity: 1,
    fill, stroke: '#000', strokeWidth: 0,
    radius: 0, fontSize: 16, textColor: '#000',
    parentId: null, zIndex: 0,
    locked: false, visible: true,
    autoLayout: null, tokenBinding: null, componentId: null,
    points: null, closed: false, src: null, radii: null,
    gradient: null, shadow: null, blur: 0, maskId: null,
    constraints: null,
    ...(version !== undefined ? { version } : {}),
    ...(versionNonce !== undefined ? { versionNonce } : {}),
  };
}

function findShapeById(doc: CanvasDocument, id: string) {
  const kids = doc.children as unknown as Array<{ id: string; fill?: string }>;
  const node = kids.find((c) => c.id === id);
  return node as (Shape & { version?: number; versionNonce?: number }) | undefined;
}

// ---- elementWins (the per-element conflict table) ----------------------------

describe('elementWins', () => {
  it('remote wins when local carries no version (legacy element)', () => {
    expect(elementWins({ id: 'a' }, { id: 'a', version: 1 })).toBe(false);
  });

  it('local wins when remote carries no version but local does (stale snapshot)', () => {
    expect(elementWins({ id: 'a', version: 1 }, { id: 'a' })).toBe(true);
  });

  it('higher version wins, both directions', () => {
    expect(elementWins({ id: 'a', version: 3 }, { id: 'a', version: 2 })).toBe(true);
    expect(elementWins({ id: 'a', version: 2 }, { id: 'a', version: 3 })).toBe(false);
  });

  it('equal versions break the tie by the LOWER nonce', () => {
    expect(elementWins({ id: 'a', version: 2, versionNonce: 10 }, { id: 'a', version: 2, versionNonce: 20 })).toBe(true);
    expect(elementWins({ id: 'a', version: 2, versionNonce: 20 }, { id: 'a', version: 2, versionNonce: 10 })).toBe(false);
  });

  it('equal version + equal nonce = identical lineage, local kept', () => {
    expect(elementWins({ id: 'a', version: 2, versionNonce: 7 }, { id: 'a', version: 2, versionNonce: 7 })).toBe(true);
  });
});

// ---- reconcileDocuments -------------------------------------------------------

describe('reconcileDocuments', () => {
  it('adopts remote-only elements (server has it, we do not)', () => {
    const local = makeDoc([makeShape('a', '#111', 1, 1)]);
    const incoming = makeDoc([makeShape('a', '#111', 1, 1), makeShape('b', '#222', 1, 2)]);
    const merged = reconcileDocuments(local, incoming);
    expect(findShapeById(merged, 'b')?.fill).toBe('#222');
    expect(merged.children).toHaveLength(2);
  });

  it('keeps local-only elements (unsynced local add survives the resync)', () => {
    const local = makeDoc([makeShape('a', '#111', 1, 1), makeShape('mine', '#0f0', 1, 5)]);
    const incoming = makeDoc([makeShape('a', '#111', 1, 1)]);
    const merged = reconcileDocuments(local, incoming);
    expect(findShapeById(merged, 'mine')?.fill).toBe('#0f0');
  });

  it('local newer version wins the value (offline edit survives)', () => {
    const local = makeDoc([makeShape('a', '#local-edit', 4, 10)]);
    const incoming = makeDoc([makeShape('a', '#server-stale', 2, 99)]);
    const merged = reconcileDocuments(local, incoming);
    expect(findShapeById(merged, 'a')?.fill).toBe('#local-edit');
    expect(findShapeById(merged, 'a')?.version).toBe(4);
  });

  it('remote newer version wins the value (we were stale)', () => {
    const local = makeDoc([makeShape('a', '#local-stale', 2, 99)]);
    const incoming = makeDoc([makeShape('a', '#server-edit', 4, 10)]);
    const merged = reconcileDocuments(local, incoming);
    expect(findShapeById(merged, 'a')?.fill).toBe('#server-edit');
  });

  it('equal version resolves by lower nonce deterministically', () => {
    const local = makeDoc([makeShape('a', '#local', 3, 111)]);
    const incoming = makeDoc([makeShape('a', '#remote', 3, 222)]);
    const merged1 = reconcileDocuments(local, incoming);
    const merged2 = reconcileDocuments(incoming, local);
    // Same winner regardless of merge direction — the tiebreak is symmetric.
    expect(findShapeById(merged1, 'a')?.fill).toBe('#local');
    expect(findShapeById(merged2, 'a')?.fill).toBe('#local');
  });

  it('versionless local elements fall back to remote-wins (legacy replace semantics)', () => {
    const local = makeDoc([makeShape('a', '#legacy-local')]);
    const incoming = makeDoc([makeShape('a', '#legacy-remote')]);
    const merged = reconcileDocuments(local, incoming);
    expect(findShapeById(merged, 'a')?.fill).toBe('#legacy-remote');
  });

  it('empty incoming keeps the whole local tree (server-restart rollback guard)', () => {
    const local = makeDoc([makeShape('a', '#111', 1, 1), makeShape('b', '#222', 1, 2)]);
    const incoming = makeDoc([]);
    const merged = reconcileDocuments(local, incoming);
    expect(merged.children).toHaveLength(2);
    expect(findShapeById(merged, 'a')?.fill).toBe('#111');
    expect(findShapeById(merged, 'b')?.fill).toBe('#222');
  });

  it('empty local adopts the incoming tree verbatim', () => {
    const local = makeDoc([]);
    const incoming = makeDoc([makeShape('a', '#111', 1, 1)]);
    const merged = reconcileDocuments(local, incoming);
    expect(merged.children).toHaveLength(1);
  });

  it('is idempotent: re-merging the same incoming document changes nothing', () => {
    const local = makeDoc([
      makeShape('a', '#local-edit', 5, 10),
      makeShape('mine', '#0f0', 1, 3),
    ]);
    const incoming = makeDoc([
      makeShape('a', '#server-stale', 2, 99),
      makeShape('b', '#222', 1, 2),
    ]);
    const merged1 = reconcileDocuments(local, incoming);
    const merged2 = reconcileDocuments(merged1, incoming);
    expect(merged2.children).toEqual(merged1.children);
  });

  it('recomputes the derived shape cache after merging', () => {
    const local = makeDoc([]);
    const incoming = makeDoc([makeShape('a', '#111', 1, 1)]);
    const merged = reconcileDocuments(local, incoming);
    expect(merged.shapes.map((s) => s.id)).toContain('a');
  });
});

// ---- Version stamping through the patch pipeline ------------------------------

describe('version stamping (pen/document.ts)', () => {
  it('insertNode stamps version 1 + a nonce on new nodes', () => {
    const doc = applyPatchToCanvas(makeDoc([]), {
      op: 'add',
      shapeId: 'n1',
      shape: { id: 'n1', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 } as Partial<Shape>,
      summary: 'add',
    });
    const node = findShapeById(doc, 'n1');
    expect(node?.version).toBe(1);
    expect(typeof node?.versionNonce).toBe('number');
  });

  it('updateNode bumps the version and re-rolls the nonce', () => {
    let doc = applyPatchToCanvas(makeDoc([]), {
      op: 'add',
      shapeId: 'n1',
      shape: { id: 'n1', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 } as Partial<Shape>,
      summary: 'add',
    });
    const before = findShapeById(doc, 'n1');
    doc = applyPatchToCanvas(doc, {
      op: 'update',
      shapeId: 'n1',
      shape: { fill: '#ff0000' } as Partial<Shape>,
      summary: 'recolor',
    });
    const after = findShapeById(doc, 'n1');
    expect(after?.version).toBe((before?.version ?? 0) + 1);
    expect(after?.fill).toBe('#ff0000');
  });

  it('server + client applying the same patch chain land on the same versions', () => {
    // The convergence invariant the relay relies on: applyPatchToCanvas is
    // the shared applier on both sides, so identical patch sequences produce
    // identical version lineages.
    const mk = () => applyPatchToCanvas(makeDoc([]), {
      op: 'add',
      shapeId: 'n1',
      shape: { id: 'n1', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 } as Partial<Shape>,
      summary: 'add',
    });
    const server = applyPatchToCanvas(mk(), { op: 'update', shapeId: 'n1', shape: { x: 5 } as Partial<Shape>, summary: 'x' });
    const client = applyPatchToCanvas(mk(), { op: 'update', shapeId: 'n1', shape: { x: 5 } as Partial<Shape>, summary: 'x' });
    expect(findShapeById(server, 'n1')?.version).toBe(findShapeById(client, 'n1')?.version);
  });
});
