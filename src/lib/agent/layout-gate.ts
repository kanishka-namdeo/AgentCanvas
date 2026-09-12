// layout-gate.ts — `submit_layout_approval` tool (staged design flow) +
// the lo-fi toolset allowlist.
//
// Mirrors plan-tools.ts verbatim in structure. The staged flow is:
//
//   1. The runner detects a lo-fi request (Task 7: `shouldOfferStagedFlow`)
//      and offers the staged flow to the user.
//   2. The agent builds a GRAY-BOX layout on the canvas using ONLY the lo-fi
//      toolset (`lofiToolNames()` below — wireframe generators + structural
//      tools, NO hi-fi styling composites).
//   3. The agent calls `submit_layout_approval` with the layout sections as
//      steps. The user sees a Layout approval card: "Apply hi-fi" upgrades
//      the approved skeleton to the finished design (Task 9 wires the
//      upgrade phase); "Revise layout" returns their feedback.
//   4. On 'build', the tool calls `recordApprovedPlan({...proposal, kind:
//      'layout'})` — the shared approved-plan slot; the runner discriminates
//      by `kind` (Task 10 adds `kind` to the SyncEvent payload).
//
// The lo-fi allowlist is the wireframe category MINUS the hi-fi styling
// composites (palette/typography/variables/shadow/gradient/blur/bulk ops/
// find-replace/bake-layout) PLUS `ask_user_question` + `submit_layout_approval`.

import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { submitPlanProposal, recordApprovedPlan } from './plan-gate';
import { getToolNamesForCategory } from './skills/registry';

export const SUBMIT_LAYOUT_APPROVAL_TOOL_NAME = 'submit_layout_approval';

/// Hi-fi styling composites — excluded from the lo-fi toolset so the agent
/// CANNOT apply palette/typography/variables/shadow/gradient/blur/bulk ops
/// before the layout is approved. The upgrade phase (post-approval) brings
/// these back.
export const LOFI_EXCLUDED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'pen_apply_design_system',
  'pen_apply_typography',
  'pen_apply_palette',
  'pen_set_variable',
  'pen_set_variable_modes',
  'pen_set_shadow',
  'pen_set_gradient',
  'pen_set_blur',
  'pen_bulk_update_by_filter',
  'pen_find_replace',
  'pen_bake_layout',
]);

/// Lo-fi toolset = wireframe category minus hi-fi styling composites, plus
/// `ask_user_question` (clarifying questions) + `submit_layout_approval`
/// (the gate itself). Returned as a fresh array on each call (callers may
/// mutate / intersect).
export function lofiToolNames(): string[] {
  const wireframe = getToolNamesForCategory('wireframe');
  const out: string[] = [];
  for (const name of wireframe) {
    if (!LOFI_EXCLUDED_TOOL_NAMES.has(name)) out.push(name);
  }
  if (!out.includes('ask_user_question')) out.push('ask_user_question');
  if (!out.includes(SUBMIT_LAYOUT_APPROVAL_TOOL_NAME)) out.push(SUBMIT_LAYOUT_APPROVAL_TOOL_NAME);
  return out;
}

export const submitLayoutApprovalTool = defineTool({
  name: SUBMIT_LAYOUT_APPROVAL_TOOL_NAME,
  label: 'Submit Layout for Approval',
  description:
    'Submit your completed LO-FI LAYOUT for approval (staged design flow only). The user sees a Layout approval card: ' +
    "'Apply hi-fi' upgrades the approved skeleton to the finished design; 'Revise layout' returns their feedback. " +
    'Call it ONCE the gray-box layout is on the canvas and structurally complete — sections, hierarchy, placement — ' +
    'with NO palette/typography applied.',
  promptSnippet: 'Submit the lo-fi layout for user approval (staged design flow).',
  promptGuidelines: [
    'Call only in the staged design flow, only when the gray-box layout is structurally complete.',
    'Each step is a layout section: what it contains, where it sits in the hierarchy.',
    'Do NOT apply palette/typography/shadow/gradient before calling this tool.',
    'State assumptions as openQuestions when you had to choose without asking.',
  ],
  parameters: Type.Object({
    title: Type.String({
      description: 'Short layout title, e.g. "Dashboard lo-fi (stats + chart + table)"',
    }),
    summary: Type.String({
      description: '2-3 sentence overview: the layout sections, hierarchy, and placement decisions.',
    }),
    steps: Type.Array(Type.Object({
      step: Type.Number({ description: 'Step number (1-based, top-to-bottom / outer-to-inner)' }),
      description: Type.String({
        description: 'The layout section: what it contains, its placement in the hierarchy, key structural decisions.',
      }),
    }), { minItems: 2, maxItems: 12 }),
    openQuestions: Type.Optional(Type.Array(Type.String(), {
      maxItems: 5,
      description: 'Assumptions you made that the user should know about (resolved without asking).',
    })),
  }),
  async execute(toolCallId, params, _signal, onUpdate) {
    const typed = params as {
      title: string;
      summary: string;
      steps: Array<{ step: number; description: string }>;
      openQuestions?: string[];
    };

    // Normalize + clamp the steps (defensive: same discipline as submit_plan).
    const steps = (typed.steps ?? [])
      .slice(0, 12)
      .map((s, i) => ({
        step: Number.isFinite(Number(s.step)) ? Math.max(1, Math.round(Number(s.step))) : i + 1,
        description: String(s.description ?? '').slice(0, 2000),
      }))
      .filter((s) => s.description.length > 0);

    if (steps.length < 2) {
      return {
        content: [{
          type: 'text' as const,
          text: 'ERROR: a layout needs at least 2 sections. Build the gray-box layout on the canvas (sections, hierarchy, placement) and call submit_layout_approval again.',
        }],
        details: { error: 'layout_too_small' },
        isError: true as any,
      };
    }

    // Heartbeat — same pattern as submit_plan (10-min human wait, 20s pulse
    // feeds the route's stream watchdog).
    const startedAt = Date.now();
    const report = (text: string) => {
      try {
        onUpdate?.({ content: [{ type: 'text', text }], details: { phase: 'layout_approval' } });
      } catch {
        // best-effort — never fail the tool over progress delivery
      }
    };
    report('Layout submitted — waiting for your approval…');
    const heartbeat = setInterval(() => {
      report(`Waiting for layout approval — ${Math.round((Date.now() - startedAt) / 1000)}s elapsed`);
    }, 20_000);

    let decision: import('./plan-gate').PlanDecision;
    try {
      decision = await submitPlanProposal({
        planId: toolCallId,
        title: String(typed.title ?? 'Layout').slice(0, 120),
        summary: String(typed.summary ?? '').slice(0, 2000),
        steps,
        openQuestions: (typed.openQuestions ?? []).slice(0, 5).map((q) => String(q).slice(0, 300)),
      });
    } finally {
      clearInterval(heartbeat);
    }

    if (decision.decision === 'build') {
      // Hand the approved layout to the runner via the shared approved-plan
      // slot, discriminated by `kind: 'layout'` (Task 10 will add `kind` to
      // the SyncEvent payload; for now the runner reads it off the consumed
      // proposal).
      recordApprovedPlan({
        planId: toolCallId,
        title: String(typed.title ?? 'Layout').slice(0, 120),
        summary: String(typed.summary ?? '').slice(0, 2000),
        steps,
        openQuestions: (typed.openQuestions ?? []).slice(0, 5).map((q) => String(q).slice(0, 300)),
        kind: 'layout',
      });
      // Hard stop — same wording discipline as submit_plan. The runner's
      // post-approval tool blocker (runner-native.ts) enforces it
      // architecturally if the model still tries.
      return {
        content: [{
          type: 'text' as const,
          text:
            'LAYOUT APPROVED — LAYOUT SESSION COMPLETE. Your job is DONE. ' +
            'Do NOT apply palette/typography/shadow/gradient, do NOT call any more styling tools, ' +
            'and do NOT call any more tools at all: this session is read-only until the upgrade phase starts. ' +
            'A separate upgrade session with the full design toolset applies the hi-fi treatment automatically once you end your turn. ' +
            'Reply with exactly ONE short sentence confirming the handoff, then end your turn.',
        }],
        details: { decision: 'build' },
      };
    }
    if (decision.decision === 'revise') {
      return {
        content: [{
          type: 'text' as const,
          text:
            `LAYOUT SENT BACK FOR REVISION. The user's feedback:\n"""${decision.feedback ?? '(no notes)'}"""\n\n` +
            'Revise the layout accordingly and call submit_layout_approval again with the updated layout.',
        }],
        details: { decision: 'revise', feedback: decision.feedback },
      };
    }
    return {
      content: [{
        type: 'text' as const,
        text:
          'LAYOUT APPROVAL TIMED OUT (no response for 10 minutes). Do not wait further: end your turn with the layout description written out as text so the user has it, ' +
          'and note they can re-run the staged flow directly.',
      }],
      details: { decision: 'timeout' },
    };
  },
});
