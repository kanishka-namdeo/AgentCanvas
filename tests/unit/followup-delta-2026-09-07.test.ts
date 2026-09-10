// Follow-up-turn delta gating (2026-09-07) — regression tests.
//
// BUG (reported: "followup prompts do not work correctly with our agent in
// the app"): every agent turn runs in a FRESH LLM session
// (SessionManager.inMemory per run — see runner-native.ts), so the model
// has NEVER seen the canvas. The WS path (the app's primary path) threaded
// `canvasDelta` from the journal watermark into the runner; on a pure
// follow-up turn (no manual edits between turns) the computed changed-set
// is an EMPTY ARRAY — truthy in JS — which selected the DELTA digest with
// ZERO expanded nodes. The model received only collapsed navigation lines
// (id/type/name/pos/size) and had to hydrate its own canvas blind via
// pen_get_metadata before every edit. The HTTP fallback path (no
// canvasDelta → full snapshot) worked fine — confirmed by a two-turn
// WS-vs-HTTP repro (scripts/agent-eval/repro-followup-ws.ts).
//
// FIX (two layers):
//   1. journal-fold.computeChangedNodeIdsSince: empty ids set → nodeIds
//      null (full-snapshot fallback) — behavioral test in
//      journal-fold.test.ts.
//   2. runner-native delta gating: delta mode requires a non-empty
//      changed-set AND a large canvas (> DELTA_MIN_SHAPES) — pinned here
//      as source invariants (the runner is network-facing; the established
//      pattern for its tests is source scans, see
//      agent-optimization-2026-09-05.test.ts).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, 'src', rel), 'utf-8');

describe('2026-09-07 follow-up-turn fix: runner delta gating (source invariants)', () => {
  const runnerSrc = read('lib/agent/runner-native.ts');

  it('gates delta mode on a NON-EMPTY changed-set (empty array must NOT select the digest)', () => {
    // The guard: deltaIds.length > 0 must gate the delta selection.
    // Speed-parity P0.10: DELTA_MIN_SHAPES lowered 60 → 20.
    expect(runnerSrc).toContain('const DELTA_MIN_SHAPES = 20;');
    expect(runnerSrc).toMatch(
      /const delta = deltaIds && deltaIds\.length > 0 && \(canvas\.shapes\?\.length \?\? 0\) > DELTA_MIN_SHAPES/,
    );
  });

  it('keeps the full snapshot as the fallback arm of the snapshot ternary', () => {
    // nodeIds:null / absent / empty / small canvas all flow to the full
    // canvasSnapshot — the same context the HTTP fallback path sends.
    expect(runnerSrc).toMatch(
      /const delta = [\s\S]*?\? deltaIds\s*\n\s*: undefined;/,
    );
    expect(runnerSrc).toContain('${canvasSnapshot(canvas)}');
  });

  it('the fix is documented at the gating site (fresh-session rationale)', () => {
    expect(runnerSrc).toContain('2026-09-07 follow-up-turn fix');
    expect(runnerSrc).toContain('SessionManager.inMemory per run');
  });
});

describe('2026-09-07 follow-up-turn fix: journal-fold empty-set fallback (source invariants)', () => {
  const foldSrc = read('lib/canvas/journal-fold.ts');

  it('computeChangedNodeIdsSince returns null on an empty ids set', () => {
    expect(foldSrc).toContain('if (ids.size === 0) return { nodeIds: null, throughSeq };');
  });
});

describe('2026-09-07 follow-up-turn fix: WS driveAgent threads the watermark only when set', () => {
  const serverSrc = read('lib/canvas/server.ts');

  it('computes the delta only above a positive watermark', () => {
    // lastTurnSeq = 0 (no checkpoint yet) → no canvasDelta → full snapshot,
    // even on the WS path.
    expect(serverSrc).toMatch(/if \(state\.lastTurnSeq > 0\) \{/);
    expect(serverSrc).toMatch(/nodeIds: delta\.nodeIds/);
  });
});
