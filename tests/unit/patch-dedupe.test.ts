// Unit tests — idempotent agent-patch application (src/lib/canvas/patch-dedupe.ts).
//
// The canvas is append-only, so a double-applied patch is unfixable noise
// (duplicate-id nodes, phantom undo entries). The dedup key must:
//   - be stable for a verbatim duplicate delivery (same toolCallId + same content)
//   - DIFFER for two legitimate patches from one tool call (different content)
//   - be null for user edits (no toolCallId — never deduped)
// The bounded set must evict oldest keys past its cap.

import { describe, it, expect } from 'vitest';
import { patchDedupeKey, createBoundedDedupSet } from '@/lib/canvas/patch-dedupe';
import type { CanvasPatch } from '@/lib/canvas/types';

const addPatch = (id: string): CanvasPatch =>
  ({ op: 'add', shape: { type: 'rectangle', name: 'A', id }, summary: 'add' } as CanvasPatch);

describe('patchDedupeKey', () => {
  it('returns null when there is no toolCallId (user edit — never deduped)', () => {
    expect(patchDedupeKey(undefined, addPatch('s1'))).toBeNull();
    expect(patchDedupeKey('', addPatch('s1'))).toBeNull();
  });

  it('produces the same key for a verbatim duplicate delivery', () => {
    const a = patchDedupeKey('tc-1', addPatch('s1'));
    // A "re-delivery" is what the consumer sees after JSON parse — a fresh
    // object with identical shape. Key must be identical.
    const b = patchDedupeKey('tc-1', JSON.parse(JSON.stringify(addPatch('s1'))));
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it('produces different keys for different content under the same toolCallId', () => {
    // One tool call may legitimately emit MULTIPLE patches (details.patches).
    const a = patchDedupeKey('tc-1', addPatch('s1'));
    const b = patchDedupeKey('tc-1', addPatch('s2'));
    expect(a).not.toBe(b);
  });

  it('produces different keys for the same content under different toolCallIds', () => {
    const a = patchDedupeKey('tc-1', addPatch('s1'));
    const b = patchDedupeKey('tc-2', addPatch('s1'));
    expect(a).not.toBe(b);
  });

  it('tolerates patches with unserializable extras', () => {
    const weird = { ...addPatch('s1'), toJSON: undefined } as unknown as CanvasPatch;
    expect(patchDedupeKey('tc-1', weird)).not.toBeNull();
  });
});

describe('createBoundedDedupSet', () => {
  it('tracks membership like a set', () => {
    const set = createBoundedDedupSet(10);
    expect(set.has('k')).toBe(false);
    set.add('k');
    expect(set.has('k')).toBe(true);
    expect(set.size()).toBe(1);
    // Re-adding is a no-op.
    set.add('k');
    expect(set.size()).toBe(1);
  });

  it('evicts oldest keys past capacity (FIFO)', () => {
    const set = createBoundedDedupSet(3);
    for (const k of ['a', 'b', 'c', 'd']) set.add(k);
    expect(set.has('a')).toBe(false); // evicted
    expect(set.has('b')).toBe(true);
    expect(set.has('d')).toBe(true);
    expect(set.size()).toBe(3);
  });

  it('clears everything on clear()', () => {
    const set = createBoundedDedupSet(10);
    set.add('k');
    set.clear();
    expect(set.has('k')).toBe(false);
    expect(set.size()).toBe(0);
  });
});
