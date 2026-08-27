// Unit tests for the destructive-op approval gate
// (src/lib/agent/plugins/approval-gate.ts).
//
// Covers:
//   - the destructive-tool registry
//   - buildApprovalRequest: human descriptions + shape-name resolution
//     (pen_clear / pen_delete_shape / figma_delete_page / pattern memory)
//   - null request for unresolvable deletes (tool will error on its own)
//   - requestApproval blocks until resolveApproval settles (approve + deny)
//   - timeout resolves as denied + timedOut
//   - resolving an unknown/already-settled id is a no-op
//   - deniedToolResult guidance copy (no-retry, no-workaround)
//   - always-allow set: seed / add / isAlwaysAllowed short-circuits
//   - getPendingToolName lookup for the /api/agent/approvals endpoint
//
// No event sink is installed during these tests → emitEvent is a no-op,
// which is fine: we drive the promises directly via resolveApproval.

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  DESTRUCTIVE_TOOLS,
  buildApprovalRequest,
  requestApproval,
  resolveApproval,
  getPendingApprovals,
  deniedToolResult,
  seedAlwaysAllow,
  addAlwaysAllow,
  isAlwaysAllowed,
  resetAlwaysAllowSet,
  getAlwaysAllowSet,
  getPendingToolName,
} from '../../src/lib/agent/plugins/approval-gate';

const SHAPES = [
  { id: 's1', name: 'Hero Card', type: 'frame' },
  { id: 's2', name: 'Primary Button', type: 'rectangle' },
  { id: 's3', name: 'Input Field', type: 'rectangle' },
  { id: 's4', name: 'Footer', type: 'frame' },
  { id: 's5', name: 'Logo', type: 'ellipse' },
  { id: 's6', name: 'Nav Bar', type: 'frame' },
  { id: 's7', name: 'Badge', type: 'rectangle' },
];

afterEach(() => {
  vi.useRealTimers();
  // Resolve any strays so later tests start clean.
  for (const id of getPendingApprovals()) resolveApproval(id, false);
  // Reset the always-allow set so tests don't leak into each other.
  resetAlwaysAllowSet();
});

describe('DESTRUCTIVE_TOOLS', () => {
  it('gates the four destructive tools', () => {
    expect(DESTRUCTIVE_TOOLS.has('pen_clear')).toBe(true);
    expect(DESTRUCTIVE_TOOLS.has('pen_delete_shape')).toBe(true);
    expect(DESTRUCTIVE_TOOLS.has('figma_delete_page')).toBe(true);
    expect(DESTRUCTIVE_TOOLS.has('pen_clear_pattern_memory')).toBe(true);
  });

  it('does NOT gate reversible restructuring tools', () => {
    expect(DESTRUCTIVE_TOOLS.has('pen_ungroup_shapes')).toBe(false);
    expect(DESTRUCTIVE_TOOLS.has('pen_detach_instance')).toBe(false);
    expect(DESTRUCTIVE_TOOLS.has('pen_reset_instance')).toBe(false);
    expect(DESTRUCTIVE_TOOLS.has('pen_create_shape')).toBe(false);
  });
});

describe('buildApprovalRequest', () => {
  it('describes a canvas clear with the layer count and names', () => {
    const req = buildApprovalRequest('tc1', 'pen_clear', {}, SHAPES);
    expect(req).not.toBeNull();
    expect(req!.description).toContain('Clear the entire canvas');
    expect(req!.description).toContain('7 layers');
    expect(req!.details.join(' ')).toContain('Hero Card');
    // Name list is capped at 8 — all 7 fit.
    expect(req!.details.join(' ')).toContain('Nav Bar');
  });

  it('truncates long name lists with a "+N more" marker', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, name: `Layer ${i}` }));
    const req = buildApprovalRequest('tc', 'pen_clear', {}, many)!;
    expect(req.details.join(' ')).toContain('+4 more');
  });

  it('resolves delete targets by shape name', () => {
    const req = buildApprovalRequest('tc2', 'pen_delete_shape', { shapeIds: ['s1', 's3'] }, SHAPES);
    expect(req!.description).toBe('Delete 2 layers');
    expect(req!.details[0]).toContain('Hero Card');
    expect(req!.details[0]).toContain('Input Field');
  });

  it('flags bulk deletes (>= threshold)', () => {
    const req = buildApprovalRequest(
      'tc', 'pen_delete_shape',
      { shapeIds: SHAPES.map((s) => s.id) }, SHAPES,
    )!;
    expect(req.description).toContain('bulk delete');
  });

  it('accepts the singular shapeId LLM arg-mistake', () => {
    const req = buildApprovalRequest('tc', 'pen_delete_shape', { shapeId: 's2' }, SHAPES);
    expect(req!.description).toBe('Delete 1 layer');
    expect(req!.details[0]).toContain('Primary Button');
  });

  it('returns null for a delete with no ids (tool errors on its own)', () => {
    expect(buildApprovalRequest('tc', 'pen_delete_shape', {}, SHAPES)).toBeNull();
  });

  it('falls back to raw ids when shapes are unknown', () => {
    const req = buildApprovalRequest('tc', 'pen_delete_shape', { shapeIds: ['ghost'] }, SHAPES)!;
    expect(req.description).toContain('1 layer');
    expect(req.details[0]).toContain('ghost');
  });

  it('describes page deletion', () => {
    const req = buildApprovalRequest('tc', 'figma_delete_page', { name: 'Cover' }, SHAPES)!;
    expect(req.description).toContain('Delete the page "Cover"');
    expect(req.details.join(' ')).toContain('All layers on that page');
  });

  it('describes pattern-memory wipe without canvas impact claim', () => {
    const req = buildApprovalRequest('tc', 'pen_clear_pattern_memory', {}, SHAPES)!;
    expect(req.description).toContain('pattern memory');
    expect(req.details.join(' ')).toContain('not affected');
  });

  it('generic copy for unknown destructive tools', () => {
    const req = buildApprovalRequest('tc', 'pen_some_future_wipe', { a: 1 }, SHAPES)!;
    expect(req.description).toContain('pen_some_future_wipe');
  });
});

describe('requestApproval / resolveApproval', () => {
  it('blocks until the user approves', async () => {
    const p = requestApproval({ toolCallId: 'ok1', toolName: 'pen_clear', description: 'd', details: [] });
    expect(getPendingApprovals()).toContain('ok1');
    resolveApproval('ok1', true);
    const decision = await p;
    expect(decision).toEqual({ approved: true, timedOut: false });
    expect(getPendingApprovals()).not.toContain('ok1');
  });

  it('blocks until the user denies', async () => {
    const p = requestApproval({ toolCallId: 'no1', toolName: 'pen_clear', description: 'd', details: [] });
    resolveApproval('no1', false);
    const decision = await p;
    expect(decision).toEqual({ approved: false, timedOut: false });
  });

  it('resolving an unknown id is a no-op (idempotent)', () => {
    expect(() => resolveApproval('never-registered', true)).not.toThrow();
  });

  it('resolves only ONCE — the second resolve is dropped', async () => {
    const p = requestApproval({ toolCallId: 'once', toolName: 'pen_clear', description: 'd', details: [] });
    resolveApproval('once', true);
    resolveApproval('once', false); // late duplicate — must not flip the decision
    const decision = await p;
    expect(decision.approved).toBe(true);
  });

  it('times out as DENIED after 5 minutes (safe default)', async () => {
    vi.useFakeTimers();
    const p = requestApproval({ toolCallId: 'slow', toolName: 'pen_clear', description: 'd', details: [] });
    // Still pending just before the timeout.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 100);
    expect(getPendingApprovals()).toContain('slow');
    // Cross the timeout → denied + timedOut.
    await vi.advanceTimersByTimeAsync(200);
    const decision = await p;
    expect(decision).toEqual({ approved: false, timedOut: true });
    expect(getPendingApprovals()).not.toContain('slow');
  });
});

describe('deniedToolResult', () => {
  it('tells the model not to retry and to acknowledge', () => {
    const r = deniedToolResult('pen_clear', false);
    expect(r.isError).toBe(true);
    expect(r.details).toEqual({ error: 'user_denied', toolName: 'pen_clear', timedOut: false });
    expect(r.content[0].text).toContain('DENIED');
    expect(r.content[0].text).toContain('Do NOT retry');
    expect(r.content[0].text).toContain('workaround');
  });

  it('distinguishes timeouts from explicit denials', () => {
    const r = deniedToolResult('pen_clear', true);
    expect(r.content[0].text).toContain('did not respond');
    expect(r.content[0].text).toContain('cancelled for safety');
  });
});

// ---- Always-allow set -------------------------------------------------------

describe('always-allow set', () => {
  it('starts empty', () => {
    resetAlwaysAllowSet();
    expect(getAlwaysAllowSet()).toEqual([]);
    expect(isAlwaysAllowed('pen_clear')).toBe(false);
  });

  it('seedAlwaysAllow populates the set from a string list', () => {
    resetAlwaysAllowSet();
    seedAlwaysAllow(['pen_clear', 'pen_delete_shape']);
    expect(isAlwaysAllowed('pen_clear')).toBe(true);
    expect(isAlwaysAllowed('pen_delete_shape')).toBe(true);
    expect(isAlwaysAllowed('figma_delete_page')).toBe(false);
  });

  it('seedAlwaysAllow is idempotent (dedupes via Set)', () => {
    resetAlwaysAllowSet();
    seedAlwaysAllow(['pen_clear', 'pen_clear', 'pen_clear']);
    expect(getAlwaysAllowSet()).toEqual(['pen_clear']);
  });

  it('seedAlwaysAllow ignores non-string / empty entries', () => {
    resetAlwaysAllowSet();
    seedAlwaysAllow(['pen_clear', '', null as any, undefined as any, 123 as any]);
    expect(getAlwaysAllowSet()).toEqual(['pen_clear']);
  });

  it('seedAlwaysAllow is a no-op for null / undefined input', () => {
    resetAlwaysAllowSet();
    seedAlwaysAllow(null);
    seedAlwaysAllow(undefined);
    expect(getAlwaysAllowSet()).toEqual([]);
  });

  it('addAlwaysAllow adds a single tool', () => {
    resetAlwaysAllowSet();
    addAlwaysAllow('pen_clear');
    expect(isAlwaysAllowed('pen_clear')).toBe(true);
    expect(getAlwaysAllowSet()).toEqual(['pen_clear']);
  });

  it('addAlwaysAllow ignores empty / non-string input', () => {
    resetAlwaysAllowSet();
    addAlwaysAllow('');
    addAlwaysAllow(null as any);
    expect(getAlwaysAllowSet()).toEqual([]);
  });

  it('addAlwaysAllow is additive (does NOT clear existing entries)', () => {
    resetAlwaysAllowSet();
    seedAlwaysAllow(['pen_clear']);
    addAlwaysAllow('pen_delete_shape');
    expect(getAlwaysAllowSet().sort()).toEqual(['pen_clear', 'pen_delete_shape']);
  });

  it('requestApproval short-circuits as approved when the tool is always-allowed', async () => {
    addAlwaysAllow('pen_clear');
    // Should NOT register a pending entry (no event emitted, no timeout).
    const p = requestApproval({ toolCallId: 'auto-ok', toolName: 'pen_clear', description: 'd', details: [] });
    expect(getPendingApprovals()).not.toContain('auto-ok');
    const decision = await p;
    expect(decision).toEqual({ approved: true, timedOut: false });
  });

  it('requestApproval still blocks for tools NOT in the always-allow set', async () => {
    // Pen_clear_pattern_memory is destructive but NOT in the allow-set.
    const p = requestApproval({ toolCallId: 'wait', toolName: 'pen_clear_pattern_memory', description: 'd', details: [] });
    expect(getPendingApprovals()).toContain('wait');
    resolveApproval('wait', true);
    const decision = await p;
    expect(decision.approved).toBe(true);
  });

  it('resetAlwaysAllowSet clears the set', () => {
    seedAlwaysAllow(['pen_clear', 'pen_delete_shape']);
    expect(getAlwaysAllowSet().length).toBe(2);
    resetAlwaysAllowSet();
    expect(getAlwaysAllowSet()).toEqual([]);
    expect(isAlwaysAllowed('pen_clear')).toBe(false);
  });
});

// ---- getPendingToolName -----------------------------------------------------

describe('getPendingToolName', () => {
  it('returns the toolName for a pending approval', () => {
    // Register a pending approval (don't await — it's still pending).
    void requestApproval({ toolCallId: 'look-me-up', toolName: 'pen_clear', description: 'd', details: [] });
    expect(getPendingToolName('look-me-up')).toBe('pen_clear');
    resolveApproval('look-me-up', true);
  });

  it('returns undefined for unknown / already-resolved ids', () => {
    expect(getPendingToolName('never-registered')).toBeUndefined();
    void requestApproval({ toolCallId: 'resolved-soon', toolName: 'pen_clear', description: 'd', details: [] });
    resolveApproval('resolved-soon', true);
    expect(getPendingToolName('resolved-soon')).toBeUndefined();
  });
});
