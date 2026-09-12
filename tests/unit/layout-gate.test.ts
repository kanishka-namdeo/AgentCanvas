// layout-gate.test.ts — submit_layout_approval gate tool + lo-fi allowlist.
//
// Mirrors modes-2026-08-30.test.ts patterns:
//   (a) source-invariant: submitLayoutApprovalTool registered only when
//       runner-native.ts contains the identifier (Task 9 wires it).
//   (b) gate behavior: mock plan-gate so submitPlanProposal resolves with
//       'revise' (feedback text surfaces) or 'build' (recordApprovedPlan
//       called with kind: 'layout').
//   (c) lofiToolNames() excludes every LOFI_EXCLUDED name and includes the
//       wireframe generator + ask_user_question + submit_layout_approval.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(process.cwd(), 'src');
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');

// ---- (a) source-invariant ---------------------------------------------------

describe('submit_layout_approval source invariant', () => {
  // Task 9 wires the registration in runner-native.ts. The identifier MUST
  // appear in runner-native.ts (registered in the allTools catalog).
  it('runner-native.ts references submitLayoutApprovalTool (Task 9 wires registration)', () => {
    const src = read('lib/agent/runner-native.ts');
    expect(src).toContain('submitLayoutApprovalTool');
  });
});

// ---- (b) gate behavior ------------------------------------------------------

describe('submit_layout_approval gate behavior', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the feedback text when the user clicks "Revise layout"', async () => {
    vi.doMock('@/lib/agent/plan-gate', async () => {
      const actual = await vi.importActual<any>('@/lib/agent/plan-gate');
      return {
        ...actual,
        submitPlanProposal: vi.fn().mockResolvedValue({
          decision: 'revise',
          feedback: 'Move the hero above the fold please',
        }),
        recordApprovedPlan: vi.fn(),
      };
    });
    const { submitLayoutApprovalTool } = await import('@/lib/agent/layout-gate');
    const execute = (submitLayoutApprovalTool as any).execute as (
      toolCallId: string,
      params: any,
      signal: any,
      onUpdate: any,
    ) => Promise<any>;

    const result = await execute('tc-layout-1', {
      title: 'Landing page lo-fi',
      summary: 'Hero + features + CTA',
      steps: [
        { step: 1, description: 'Hero section' },
        { step: 2, description: 'Features grid' },
      ],
    }, undefined, undefined);

    const text = result.content[0].text;
    expect(text).toContain('REVISION');
    expect(text).toContain('Move the hero above the fold please');
    // recordApprovedPlan must NOT be called on revise
    const { recordApprovedPlan } = await import('@/lib/agent/plan-gate');
    expect(recordApprovedPlan).not.toHaveBeenCalled();
  });

  it('records the approved layout with kind: "layout" when the user clicks "Apply hi-fi"', async () => {
    const recordMock = vi.fn();
    vi.doMock('@/lib/agent/plan-gate', async () => {
      const actual = await vi.importActual<any>('@/lib/agent/plan-gate');
      return {
        ...actual,
        submitPlanProposal: vi.fn().mockResolvedValue({ decision: 'build' }),
        recordApprovedPlan: recordMock,
      };
    });
    const { submitLayoutApprovalTool } = await import('@/lib/agent/layout-gate');
    const execute = (submitLayoutApprovalTool as any).execute as (
      toolCallId: string,
      params: any,
      signal: any,
      onUpdate: any,
    ) => Promise<any>;

    const result = await execute('tc-layout-2', {
      title: 'Dashboard lo-fi',
      summary: 'Stats + chart + table',
      steps: [
        { step: 1, description: 'Stats row' },
        { step: 2, description: 'Chart card' },
        { step: 3, description: 'Table' },
      ],
      openQuestions: ['Assumed dark theme'],
    }, undefined, undefined);

    expect(result.details.decision).toBe('build');
    expect(recordMock).toHaveBeenCalledTimes(1);
    const recorded = recordMock.mock.calls[0][0];
    expect(recorded.kind).toBe('layout');
    expect(recorded.planId).toBe('tc-layout-2');
    expect(recorded.title).toBe('Dashboard lo-fi');
    expect(recorded.steps).toHaveLength(3);
    expect(recorded.openQuestions).toEqual(['Assumed dark theme']);
  });

  it('returns an error when fewer than 2 steps are provided', async () => {
    vi.doMock('@/lib/agent/plan-gate', async () => {
      const actual = await vi.importActual<any>('@/lib/agent/plan-gate');
      return {
        ...actual,
        submitPlanProposal: vi.fn(),
        recordApprovedPlan: vi.fn(),
      };
    });
    const { submitLayoutApprovalTool } = await import('@/lib/agent/layout-gate');
    const execute = (submitLayoutApprovalTool as any).execute as (
      toolCallId: string,
      params: any,
      signal: any,
      onUpdate: any,
    ) => Promise<any>;

    const result = await execute('tc-layout-3', {
      title: 'Too small',
      summary: 'Only one step',
      steps: [{ step: 1, description: 'Only section' }],
    }, undefined, undefined);

    expect(result.isError).toBeTruthy();
    expect(result.details.error).toBe('layout_too_small');
    const { submitPlanProposal } = await import('@/lib/agent/plan-gate');
    expect(submitPlanProposal).not.toHaveBeenCalled();
  });
});

// ---- (c) lo-fi allowlist ----------------------------------------------------

describe('lofiToolNames allowlist', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('excludes every hi-fi styling composite in LOFI_EXCLUDED_TOOL_NAMES', async () => {
    const { lofiToolNames, LOFI_EXCLUDED_TOOL_NAMES } = await import('@/lib/agent/layout-gate');
    const names = new Set(lofiToolNames());
    for (const excluded of LOFI_EXCLUDED_TOOL_NAMES) {
      expect(names.has(excluded), `expected ${excluded} to be excluded`).toBe(false);
    }
  });

  it('includes pen_generate_wireframe + ask_user_question + submit_layout_approval', async () => {
    const { lofiToolNames } = await import('@/lib/agent/layout-gate');
    const names = new Set(lofiToolNames());
    expect(names.has('pen_generate_wireframe')).toBe(true);
    expect(names.has('ask_user_question')).toBe(true);
    expect(names.has('submit_layout_approval')).toBe(true);
  });
});
