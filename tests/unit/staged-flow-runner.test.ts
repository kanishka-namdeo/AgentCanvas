// tests/unit/staged-flow-runner.test.ts
//
// Task 9: Runner staged-flow wiring (spec §3.2–3.5).
//
// Source-invariant tests (the modes-2026-08-30 pattern — the native loop
// needs a live SDK, so we assert on runner-native.ts source text) + a unit
// test for the `stagedFlowSection('lofi')` message-section helper.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(process.cwd(), 'src');
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');

// ---- (a) runner-native.ts source invariants ---------------------------------

describe('runner-native.ts staged-flow wiring (source invariants)', () => {
  const src = read('lib/agent/runner-native.ts');

  it('imports and calls shouldOfferStagedFlow from ./prompt-intent', () => {
    // Detection is wired: the import exists and the predicate is invoked.
    expect(src).toMatch(/import\s*\{[^}]*shouldOfferStagedFlow[^}]*\}\s*from\s*['"]\.\/prompt-intent['"]/);
    expect(src).toContain('shouldOfferStagedFlow(');
  });

  it('resolves stagedFlow to "lofi" | "direct" at run start', () => {
    // The detection result is bound to a `stagedFlow` const (with type
    // annotation — `const stagedFlow: 'lofi' | 'direct' = …`).
    expect(src).toMatch(/const\s+stagedFlow\s*(?::[^=]*)?\s*=/);
    // The ternary produces 'lofi' or 'direct' (both literals appear near
    // the declaration — they may be on different lines).
    expect(src).toMatch(/['"]lofi['"]/);
    expect(src).toMatch(/['"]direct['"]/);
    // The stagedFlow const's type annotation names both arms.
    expect(src).toMatch(/stagedFlow:\s*['"]lofi['"]\s*\|\s*['"]direct['"]/);
  });

  it('uses lofiToolNames() in the toolset assembly', () => {
    // The lo-fi toolset is built by intersecting allTools against lofiToolNames().
    expect(src).toContain('lofiToolNames()');
    expect(src).toMatch(/stagedLoFiTools|stagedLofiTools/);
  });

  it('extends the approved-plan consumption gate to stagedFlow === "lofi"', () => {
    // The gate at consumeApprovedPlan(...) now also fires when stagedFlow is 'lofi'.
    expect(src).toMatch(/stagedFlow\s*===\s*['"]lofi['"]/);
    // The gate expression includes the staged-flow arm.
    expect(src).toMatch(/consumeApprovedPlan[^;]*stagedFlow\s*===\s*['"]lofi['"]|stagedFlow\s*===\s*['"]lofi['"][^;]*consumeApprovedPlan/);
  });

  it('emits the hi-fi instruction string in the layout-kind execution session', () => {
    // The hi-fi pass instruction is present verbatim.
    expect(src).toContain('Apply the hi-fi pass to this approved structure');
  });

  it('emits APPROVED LAYOUT marker for the layout-kind execution session', () => {
    // The layout-kind execution session's first message starts with this marker.
    expect(src).toContain('APPROVED LAYOUT');
  });

  it('guards the one-shot slimming gate with stagedFlow !== "lofi"', () => {
    // The one-shot slimming gate no longer strips ask_user_question on staged turns.
    expect(src).toMatch(/isOneShotBuildTurn\s*&&\s*stagedFlow\s*!==\s*['"]lofi['"]/);
  });

  it('registers submitLayoutApprovalTool in the tool catalog', () => {
    // Task 8's skipped invariant — Task 9 wires the tool.
    expect(src).toContain('submitLayoutApprovalTool');
  });

  it('applies planCompletionBlocker to the staged lo-fi tools', () => {
    // The blocker wraps the staged tools exactly like the plan-mode branch.
    // The stagedLoFiTools definition calls planCompletionBlocker(…).
    expect(src).toMatch(/stagedLoFiTools[^]*?planCompletionBlocker\s*\(/);
  });

  it('injects stagedFlowSection into the first user message when stagedFlow is lofi', () => {
    // The directive rides the first user message assembly.
    expect(src).toMatch(/stagedFlowSection\s*\(\s*['"]lofi['"]\s*\)/);
  });
});

// ---- (b) stagedFlowSection helper unit test ---------------------------------

describe('stagedFlowSection("lofi")', () => {
  it('mentions ask_user_question and the two options', async () => {
    const { stagedFlowSection } = await import('@/lib/agent/modes');
    const text = stagedFlowSection('lofi');
    expect(text).toContain('ask_user_question');
    expect(text).toMatch(/Lo-fi layout first/);
    expect(text).toMatch(/Straight to hi-fi/);
  });

  it('mentions submit_layout_approval', async () => {
    const { stagedFlowSection } = await import('@/lib/agent/modes');
    const text = stagedFlowSection('lofi');
    expect(text).toContain('submit_layout_approval');
  });

  it('includes the fallback instruction for when ask_user_question is unavailable', async () => {
    const { stagedFlowSection } = await import('@/lib/agent/modes');
    const text = stagedFlowSection('lofi');
    expect(text).toMatch(/plain text|unavailable/i);
  });

  it('returns empty string for unknown kind', async () => {
    const { stagedFlowSection } = await import('@/lib/agent/modes');
    const text = (stagedFlowSection as (kind: string) => string)('unknown');
    expect(text).toBe('');
  });
});
