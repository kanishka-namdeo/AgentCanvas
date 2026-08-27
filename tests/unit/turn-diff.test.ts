// Unit tests for the turn-level diff summary engine
// (src/lib/agent/turn-diff.ts) — the "+12 −3 ~5" canvas-changes card.
//
// Covers:
//   - patch classification into created/updated/deleted/restructured
//   - ignored ops (select / undo / redo) never recorded
//   - shape counting per op shape (shapes[], updates[], shapeIds[], shapeId)
//   - clear flag + per-entry preservation
//   - formatDiffSummary one-line rendering
//   - serialize/parse round-trip + malformed JSON tolerance

import { describe, it, expect } from 'vitest';
import {
  patchToOpRecord,
  patchCategory,
  patchShapeCount,
  summarizeTurnDiff,
  diffSummaryFromPatches,
  formatDiffSummary,
  isDiffEmpty,
  serializeDiffEntries,
  parseDiffEntries,
} from '../../src/lib/agent/turn-diff';
import type { CanvasPatch } from '../../src/lib/canvas/types';

function patch(p: Partial<CanvasPatch> & { op: CanvasPatch['op'] }): CanvasPatch {
  return { summary: 'test', ...p } as CanvasPatch;
}

describe('patchCategory', () => {
  it('classifies creation ops', () => {
    expect(patchCategory(patch({ op: 'add' }))).toBe('created');
    expect(patchCategory(patch({ op: 'bulk_add' }))).toBe('created');
    expect(patchCategory(patch({ op: 'add_subtree' }))).toBe('created');
    expect(patchCategory(patch({ op: 'duplicate' }))).toBe('created');
  });

  it('classifies deletion ops', () => {
    expect(patchCategory(patch({ op: 'remove' }))).toBe('deleted');
    expect(patchCategory(patch({ op: 'clear' }))).toBe('deleted');
    expect(patchCategory(patch({ op: 'delete_page' }))).toBe('deleted');
  });

  it('classifies update ops', () => {
    expect(patchCategory(patch({ op: 'update' }))).toBe('updated');
    expect(patchCategory(patch({ op: 'update_many' }))).toBe('updated');
    expect(patchCategory(patch({ op: 'align' }))).toBe('updated');
    expect(patchCategory(patch({ op: 'set_variable' }))).toBe('updated');
  });

  it('classifies restructure ops', () => {
    expect(patchCategory(patch({ op: 'group' }))).toBe('restructured');
    expect(patchCategory(patch({ op: 'ungroup' }))).toBe('restructured');
    expect(patchCategory(patch({ op: 'reparent' }))).toBe('restructured');
    expect(patchCategory(patch({ op: 'swap_variant' }))).toBe('restructured');
  });

  it('ignores select/undo/redo', () => {
    expect(patchCategory(patch({ op: 'select' }))).toBeNull();
    expect(patchCategory(patch({ op: 'undo' }))).toBeNull();
    expect(patchCategory(patch({ op: 'redo' }))).toBeNull();
  });

  it('defaults unknown future ops to updated (never lost)', () => {
    expect(patchCategory(patch({ op: 'some_future_op' as any }))).toBe('updated');
  });
});

describe('patchShapeCount', () => {
  it('counts bulk_add shapes', () => {
    expect(
      patchShapeCount(patch({ op: 'bulk_add', shapes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] })),
    ).toBe(3);
  });

  it('counts update_many updates', () => {
    expect(
      patchShapeCount(patch({ op: 'update_many', updates: [{ id: 'a', changes: {} }, { id: 'b', changes: {} }] })),
    ).toBe(2);
  });

  it('counts remove shapeIds', () => {
    expect(patchShapeCount(patch({ op: 'remove', shapeIds: ['a', 'b'] }))).toBe(2);
  });

  it('counts single shapeId', () => {
    expect(patchShapeCount(patch({ op: 'update', shapeId: 'a' }))).toBe(1);
  });

  it('clear counts as 0 (unknown scale)', () => {
    expect(patchShapeCount(patch({ op: 'clear' }))).toBe(0);
  });
});

describe('patchToOpRecord', () => {
  it('produces a compact record with the patch summary', () => {
    const rec = patchToOpRecord(patch({ op: 'remove', shapeIds: ['a', 'b'], summary: 'Deleted 2 shapes' }));
    expect(rec).toEqual({ op: 'remove', count: 2, summary: 'Deleted 2 shapes' });
  });

  it('returns null for ignored ops', () => {
    expect(patchToOpRecord(patch({ op: 'select', shapeIds: ['a'] }))).toBeNull();
    expect(patchToOpRecord(patch({ op: 'undo' }))).toBeNull();
  });

  it('falls back to the op name when summary is empty', () => {
    const rec = patchToOpRecord(patch({ op: 'background', summary: '' }));
    expect(rec?.summary).toBe('background');
  });
});

describe('summarizeTurnDiff', () => {
  it('rolls up counts across categories', () => {
    const d = diffSummaryFromPatches([
      patch({ op: 'bulk_add', shapes: [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }], summary: 'Added 4' }),
      patch({ op: 'update', shapeId: 'x', summary: 'Updated 1' }),
      patch({ op: 'update_many', updates: [{ id: 'a', changes: {} }, { id: 'b', changes: {} }], summary: 'Updated 2' }),
      patch({ op: 'remove', shapeIds: ['z'], summary: 'Deleted 1' }),
      patch({ op: 'group', shapeIds: ['a', 'b'], summary: 'Grouped 2' }),
    ]);
    expect(d.created).toBe(4);
    expect(d.updated).toBe(3);
    expect(d.deleted).toBe(1);
    expect(d.restructured).toBe(2);
    expect(d.cleared).toBe(false);
    expect(d.entries.length).toBe(5);
  });

  it('flags cleared without counting shapes', () => {
    const d = diffSummaryFromPatches([
      patch({ op: 'add', summary: 'Added 1' }),
      patch({ op: 'clear', summary: 'Cleared canvas' }),
    ]);
    expect(d.cleared).toBe(true);
    expect(d.created).toBe(1);
    expect(d.deleted).toBe(0); // clear doesn't inflate the deleted count
  });

  it('never counts select/undo/redo', () => {
    const d = diffSummaryFromPatches([
      patch({ op: 'select', shapeIds: ['a', 'b', 'c'] }),
      patch({ op: 'undo' }),
      patch({ op: 'redo' }),
    ]);
    expect(isDiffEmpty(d)).toBe(true);
    expect(d.entries.length).toBe(0);
  });
});

describe('formatDiffSummary', () => {
  it('renders category counts in canonical order', () => {
    const d = summarizeTurnDiff([
      { op: 'bulk_add', count: 12, summary: 'x' },
      { op: 'update', count: 5, summary: 'x' },
      { op: 'remove', count: 2, summary: 'x' },
    ]);
    expect(formatDiffSummary(d)).toBe('12 created · 5 updated · 2 deleted');
  });

  it('omits zero categories', () => {
    const d = summarizeTurnDiff([{ op: 'add', count: 1, summary: 'x' }]);
    expect(formatDiffSummary(d)).toBe('1 created');
  });

  it('surfaces "canvas cleared"', () => {
    const d = summarizeTurnDiff([{ op: 'clear', count: 0, summary: 'Cleared' }]);
    expect(formatDiffSummary(d)).toBe('canvas cleared');
  });

  it('empty diff renders "no canvas changes"', () => {
    expect(formatDiffSummary(summarizeTurnDiff([]))).toBe('no canvas changes');
  });
});

describe('serializeDiffEntries / parseDiffEntries', () => {
  it('round-trips records', () => {
    const records = [
      { op: 'add', count: 3, summary: 'Added 3' },
      { op: 'remove', count: 1, summary: 'Deleted 1' },
    ];
    const parsed = parseDiffEntries(serializeDiffEntries(records));
    expect(parsed).toEqual(records);
    expect(summarizeTurnDiff(parsed)).toEqual(summarizeTurnDiff(records));
  });

  it('tolerates null / malformed / non-array JSON', () => {
    expect(parseDiffEntries(null)).toEqual([]);
    expect(parseDiffEntries(undefined)).toEqual([]);
    expect(parseDiffEntries('not json{')).toEqual([]);
    expect(parseDiffEntries('{"a":1}')).toEqual([]);
    expect(parseDiffEntries('[{"op":"add","count":"x","summary":1}]')).toEqual([]); // bad types filtered
  });
});
