// Task 7-g regression tests — brief-first enforcement (pen_generate_design_brief
// must be visible to the agent AND gated tools must reject until the brief runs).
//
// BACKGROUND: Task 7-e shipped Fix 2 (brief-first enforcement) at commit
// 14d97ce. The enforcement wrapper in runner-native.ts intercepts the gated
// tools (pen_generate_wireframe / pen_create_shape / pen_apply_palette /
// pen_set_variable) and returns a tool-result error if no
// pen_generate_design_brief call has happened yet. The intended behavior is:
// the agent sees the rejection and recovers by calling
// pen_generate_design_brief on the next iteration.
//
// CATASTROPHIC REGRESSION (Task 7-f): the recovery path was broken because
// pen_generate_design_brief was registered in tools.ts's createCanvasTools()
// but NOT in ANY of:
//   - ALL_TOOL_NAMES (multi-skill fallback list)
//   - CORE_TOOL_NAMES (always-loaded core)
//   - PEN_TOOL_NAMES (always-loaded .pen tools)
//   - any skill's allowedTools (wireframe / layout / styling / vector)
//
// The runner's filter `allTools.filter((t) => allowedToolNames.has(t.name))`
// filters pen_generate_design_brief OUT — so when Fix 2 rejects the first
// pen_generate_wireframe call, the agent's recovery attempt to call
// pen_generate_design_brief fails with "Tool not found" → empty canvas.
//
// These tests guard against the same regression: they assert that
// pen_generate_design_brief is registered everywhere it needs to be AND
// that the enforcement wrapper behaves correctly when the brief has/hasn't
// been generated.

import { describe, it, expect } from 'vitest';
import {
  ALL_TOOL_NAMES,
  getSkill,
  getToolNamesForCategory,
} from '@/lib/agent/skills/registry';
import { createCanvasTools, type CanvasToolContext } from '@/lib/agent/tools';
import { applyPatchToCanvas } from '@/lib/canvas/patch';
import type { CanvasDocument, CanvasPatch, Shape } from '@/lib/canvas/types';
import type { PenChild } from '@/lib/pen/types';

// ---- Test fixtures ----------------------------------------------------------

function makeDoc(shapes: Shape[] = []): CanvasDocument {
  return {
    id: 'test-doc',
    name: 'Test',
    background: '#ffffff',
    version: '2.17',
    children: shapes as unknown as PenChild[],
    viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes,
    tokens: { colors: [], textStyles: [] },
  };
}

/// Minimal in-memory tool context — mirrors what the production runner uses
/// internally. Every applyPatch mutates `canvas` so subsequent tool calls see
/// the updated state.
function makeTestCtx(): { ctx: CanvasToolContext; patches: CanvasPatch[]; canvas: CanvasDocument } {
  let canvas = makeDoc([]);
  const patches: CanvasPatch[] = [];
  const ctx: CanvasToolContext = {
    getShapes: () => canvas.shapes,
    getTokens: () => canvas.tokens,
    getDocument: () => canvas,
    applyPatch(patch: CanvasPatch): CanvasPatch {
      patches.push(patch);
      canvas = applyPatchToCanvas(canvas, patch);
      return patch;
    },
  };
  return { ctx, patches, canvas };
}

// ---- Test helper: replica of the enforcement wrapper from runner-native.ts
//
// This is a faithful copy of the inline enforcementWrappedTools construction
// in src/lib/agent/runner-native.ts (Task 7-e Fix 2). We replicate it here
// because the production code is inlined inside runAgentNative (not exported
// as a standalone helper). Keeping the two in sync is important — if the
// production wrapper logic changes, this test should be updated to match.
interface EnforcementState {
  hasGeneratedBrief: boolean;
  inCritiqueReprrompt: boolean;
}

function buildEnforcementWrapper(
  filteredTools: any[],
  opts: { shouldEnforceBrief: boolean; state: EnforcementState },
): any[] {
  if (!opts.shouldEnforceBrief) return filteredTools;

  const BRIEF_TOOL_NAME = 'pen_generate_design_brief';
  const GATED_TOOL_NAMES = new Set<string>([
    'pen_generate_wireframe',
    'pen_create_shape',
    'pen_apply_palette',
    'pen_set_variable',
  ]);

  return filteredTools.map((t) => {
    const origExecute = t.execute;
    if (typeof origExecute !== 'function') return t;

    if (t.name === BRIEF_TOOL_NAME) {
      return {
        ...t,
        execute: async (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => {
          const result = await origExecute(toolCallId, params, signal, onUpdate, ctx);
          opts.state.hasGeneratedBrief = true;
          return result;
        },
      };
    }

    if (GATED_TOOL_NAMES.has(t.name)) {
      return {
        ...t,
        execute: async (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => {
          if (!opts.state.hasGeneratedBrief && !opts.state.inCritiqueReprrompt) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'ERROR: You must call pen_generate_design_brief FIRST to establish the design brief (color palette, typography scale, information architecture) before any shape-creation tool. Call pen_generate_design_brief now with the user\'s prompt, then proceed.',
                },
              ],
              details: { error: 'brief_required_first', toolName: t.name },
              isError: true,
            };
          }
          return origExecute(toolCallId, params, signal, onUpdate, ctx);
        },
      };
    }

    return t;
  });
}

// ---- Tests ------------------------------------------------------------------

describe('brief-first enforcement (Task 7-g regression tests)', () => {
  it('registers pen_generate_design_brief in the wireframe skill allowedTools', () => {
    // Fix 2 — the wireframe skill is the primary path for design prompts.
    // Without this entry, the runner's filter would drop pen_generate_design_brief
    // and the agent's recovery from the brief-first rejection would fail.
    const wireframeSkill = getSkill('wireframe');
    expect(wireframeSkill).not.toBeNull();
    expect(wireframeSkill!.allowedTools).toContain('pen_generate_design_brief');
    // Verify it's at the TOP of the list (per Fix 2 spec — it must be called
    // FIRST per the brief-first enforcement).
    expect(wireframeSkill!.allowedTools[0]).toBe('pen_generate_design_brief');
  });

  it('registers pen_generate_design_brief in ALL_TOOL_NAMES', () => {
    // Fix 1 — the 'multi' skill fallback uses ALL_TOOL_NAMES as its
    // allowedToolNames. Without this entry, ambiguous-intent design prompts
    // (which route to 'multi') would lose the brief tool.
    expect(ALL_TOOL_NAMES).toContain('pen_generate_design_brief');
  });

  it('enforcementWrappedTools includes pen_generate_design_brief when shouldEnforceBrief is true', () => {
    // This test reproduces what runner-native.ts does at startup: it builds
    // filteredTools = allTools.filter(t => allowedToolNames.has(t.name))
    // where allowedToolNames includes getToolNamesForCategory('wireframe').
    // After Fix 2, the wireframe skill's allowedTools includes
    // pen_generate_design_brief — so the filter keeps it.
    const { ctx } = makeTestCtx();
    const allTools = createCanvasTools(ctx);
    const allowedToolNames = new Set<string>(getToolNamesForCategory('wireframe'));
    const filteredTools = allTools.filter((t: any) => allowedToolNames.has((t as any).name));

    // Sanity: filteredTools is non-empty and includes both wireframe + brief.
    expect(filteredTools.length).toBeGreaterThan(0);
    const briefTool = filteredTools.find((t: any) => (t as any).name === 'pen_generate_design_brief');
    expect(briefTool).toBeDefined();

    // Apply the enforcement wrapper (shouldEnforceBrief=true) and verify
    // the brief tool is still in the resulting list (with its execute
    // wrapped to set hasGeneratedBrief after a successful call).
    const state: EnforcementState = { hasGeneratedBrief: false, inCritiqueReprrompt: false };
    const wrapped = buildEnforcementWrapper(filteredTools, {
      shouldEnforceBrief: true,
      state,
    });
    const wrappedBrief = wrapped.find((t: any) => (t as any).name === 'pen_generate_design_brief');
    expect(wrappedBrief).toBeDefined();
    expect(typeof (wrappedBrief as any).execute).toBe('function');
  });

  it('rejects pen_generate_wireframe with the brief-first error when no brief has been generated', async () => {
    // Build real filteredTools (post-Fix 2 — includes pen_generate_design_brief).
    const { ctx } = makeTestCtx();
    const allTools = createCanvasTools(ctx);
    const allowedToolNames = new Set<string>(getToolNamesForCategory('wireframe'));
    const filteredTools = allTools.filter((t: any) => allowedToolNames.has((t as any).name));

    const state: EnforcementState = { hasGeneratedBrief: false, inCritiqueReprrompt: false };
    const wrapped = buildEnforcementWrapper(filteredTools, {
      shouldEnforceBrief: true,
      state,
    });

    const wireframeTool = wrapped.find((t: any) => (t as any).name === 'pen_generate_wireframe');
    expect(wireframeTool).toBeDefined();

    // Call the wrapped wireframe execute BEFORE any brief call.
    // The wrapper should reject without invoking the underlying execute
    // (so we don't need to dispatch the real wireframe generator).
    const result = await (wireframeTool as any).execute(
      'call-test-1',
      { template: 'web_dashboard' },
      undefined,
      undefined,
      ctx,
    );

    // The result must be the rejection error.
    expect(result.isError).toBe(true);
    const contentText = JSON.stringify(result.content);
    expect(contentText).toContain('pen_generate_design_brief FIRST');
    // The underlying wireframe execute should NOT have been called (no
    // patches emitted — the wrapper short-circuits on rejection). The
    // error type + targeted tool name are in `details`, not `content`.
    expect((result as any).details?.error).toBe('brief_required_first');
    expect((result as any).details?.toolName).toBe('pen_generate_wireframe');
  });

  it('allows pen_generate_wireframe after pen_generate_design_brief has been called', async () => {
    // Build real filteredTools (post-Fix 2 — includes pen_generate_design_brief).
    const { ctx, patches } = makeTestCtx();
    const allTools = createCanvasTools(ctx);
    const allowedToolNames = new Set<string>(getToolNamesForCategory('wireframe'));
    const filteredTools = allTools.filter((t: any) => allowedToolNames.has((t as any).name));

    // Stub the brief tool's original execute so we don't dispatch the real
    // design-brief sub-agent (which is slow + requires LLM credentials).
    // The stub returns a successful result; the wrapper's execute will then
    // set hasGeneratedBrief=true.
    const filteredToolsWithStubbedBrief = filteredTools.map((t: any) => {
      if ((t as any).name === 'pen_generate_design_brief') {
        return {
          ...(t as any),
          execute: async () => ({
            content: [
              { type: 'text' as const, text: '{"primaryColor":"#10b981","accentColor":"#3b82f6"}' },
            ],
            details: { subAgent: 'design_brief', stubbed: true },
          }),
        };
      }
      return t;
    });

    const state: EnforcementState = { hasGeneratedBrief: false, inCritiqueReprrompt: false };
    const wrapped = buildEnforcementWrapper(filteredToolsWithStubbedBrief, {
      shouldEnforceBrief: true,
      state,
    });

    // 1. Call the brief first — should succeed and flip hasGeneratedBrief=true.
    const briefTool = wrapped.find((t: any) => (t as any).name === 'pen_generate_design_brief');
    expect(briefTool).toBeDefined();
    const briefResult = await (briefTool as any).execute(
      'call-brief',
      {},
      undefined,
      undefined,
      ctx,
    );
    expect(briefResult.isError).not.toBe(true);
    expect(state.hasGeneratedBrief).toBe(true);

    // 2. Call the wrapped wireframe execute — now that hasGeneratedBrief=true,
    // the wrapper should fall through to the REAL wireframe execute, which
    // generates shapes via ctx.applyPatch (buildWireframe is a local function
    // — no LLM call — so this is fast).
    const wireframeTool = wrapped.find((t: any) => (t as any).name === 'pen_generate_wireframe');
    expect(wireframeTool).toBeDefined();
    const wfResult = await (wireframeTool as any).execute(
      'call-wf',
      { template: 'web_dashboard' },
      undefined,
      undefined,
      ctx,
    );

    // The wireframe should NOT have returned the rejection error.
    expect(wfResult.isError).not.toBe(true);
    // The wireframe execute should have emitted at least one patch (the
    // bulk_add of all the wireframe shapes). This proves the wrapper let the
    // call through.
    expect(patches.length).toBeGreaterThan(0);
    expect(patches.some((p) => p.op === 'bulk_add')).toBe(true);
  });
});
