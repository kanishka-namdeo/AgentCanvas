// plan-tools.ts — the `submit_plan` tool (PLAN mode only).
//
// Claude Code's ExitPlanMode contract (research p07 / raw evidence): the
// agent submits its plan through a TOOL (never as plain text) so the runtime
// can gate execution on human approval. Copying its phrasing discipline:
// the tool description tells the model exactly WHEN to call it (plan
// complete + unambiguous) and what happens next (approval → execution with
// the full build toolset).
//
// Registered in the runner's tool assembly ONLY when settings.mode ===
// 'plan' (see runner-native.ts) — in every other mode the tool does not
// exist, so the model cannot plan-submit where it shouldn't.

import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { submitPlanProposal, recordApprovedPlan } from './plan-gate';

export const SUBMIT_PLAN_TOOL_NAME = 'submit_plan';

/// LLM-calls the full plan-then-execute path saves vs. a blind build turn
/// (research §4.7: "Plan Mode saves tokens by avoiding generation
/// round-trips" — Bolt's rationale). Surfaced in the UI hint.
export const PLAN_MODE_SAVED_LLM_CALLS_ESTIMATE = 4;

export const submitPlanTool = defineTool({
  name: SUBMIT_PLAN_TOOL_NAME,
  label: 'Submit Plan for Approval',
  description:
    'Submit your completed plan for user approval (PLAN mode only). Call this ONCE your plan is complete and concrete — ' +
    'after you have inspected the canvas and resolved (or asked via ask_user_question) any genuinely plan-changing ambiguities. ' +
    'The user sees the plan as an approval card: "Build it" switches the run to Build mode and executes the plan verbatim with ' +
    'the full design toolset; "Keep planning" returns their feedback to you for revision. ' +
    'Do NOT answer with the plan as plain text — it MUST go through this tool. ' +
    'Research questions ("what is on the canvas?") are answered in text; only DESIGN PLANS go through submit_plan.',
  promptSnippet: 'Submit the plan artifact for user approval (plan mode).',
  promptGuidelines: [
    'Call only in PLAN mode, only when the plan is complete and unambiguous.',
    'Each step must be concrete: what gets built, where it is placed, key design decisions.',
    'State assumptions as openQuestions when you had to choose without asking.',
  ],
  parameters: Type.Object({
    title: Type.String({
      description: 'Short plan title, e.g. "5-screen onboarding flow (mobile, dark)"',
    }),
    summary: Type.String({
      description: '2-3 sentence overview: what the user gets when the plan is executed, and the key design decisions (palette direction, layout system, component approach).',
    }),
    steps: Type.Array(Type.Object({
      step: Type.Number({ description: 'Step number (1-based, execution order)' }),
      description: Type.String({
        description: 'What gets built in this step — the screen/section, its placement on the canvas (relative to existing screens), and the concrete components it contains. Specific enough that a builder with no other context could execute it.',
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

    // Normalize + clamp the steps (defensive: models stringify numbers,
    // re-order, or exceed the cap — normalizeAgentMode's sibling discipline).
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
          text: 'ERROR: a plan needs at least 2 concrete steps. Inspect the canvas, expand the plan (screens, sections, components, placement), and call submit_plan again.',
        }],
        details: { error: 'plan_too_small' },
        isError: true as any,
      };
    }

    // Heartbeat (pen_generate_variants pattern): the gate legitimately waits
    // up to 10 minutes for a human. The route's stream watchdog kills the run
    // after 120s of wire silence — onUpdate → SDK tool_execution_update →
    // agent:tool_progress feeds it AND tells the user we're waiting.
    const startedAt = Date.now();
    const report = (text: string) => {
      try {
        onUpdate?.({ content: [{ type: 'text', text }], details: { phase: 'plan_approval' } });
      } catch {
        // best-effort — never fail the tool over progress delivery
      }
    };
    report('Plan submitted — waiting for your approval…');
    const heartbeat = setInterval(() => {
      report(`Waiting for plan approval — ${Math.round((Date.now() - startedAt) / 1000)}s elapsed`);
    }, 20_000);

    let decision: import('./plan-gate').PlanDecision;
    try {
      decision = await submitPlanProposal({
        planId: toolCallId,
        title: String(typed.title ?? 'Plan').slice(0, 120),
        summary: String(typed.summary ?? '').slice(0, 2000),
        steps,
        openQuestions: (typed.openQuestions ?? []).slice(0, 5).map((q) => String(q).slice(0, 300)),
      });
    } finally {
      clearInterval(heartbeat);
    }

    if (decision.decision === 'build') {
      // Hand the approved plan to the runner (consumeApprovedPlan) so the
      // execution phase starts after this session's turn ends.
      recordApprovedPlan({
        planId: toolCallId,
        title: String(typed.title ?? 'Plan').slice(0, 120),
        summary: String(typed.summary ?? '').slice(0, 2000),
        steps,
        openQuestions: (typed.openQuestions ?? []).slice(0, 5).map((q) => String(q).slice(0, 300)),
      });
      return {
        content: [{
          type: 'text' as const,
          text:
            'PLAN APPROVED. The run is switching to Build mode now and will execute this plan step by step with the full design toolset. ' +
            'End your turn with a one-sentence confirmation — the builder session carries the plan.',
        }],
        details: { decision: 'build' },
      };
    }
    if (decision.decision === 'revise') {
      return {
        content: [{
          type: 'text' as const,
          text:
            `PLAN SENT BACK FOR REVISION. The user's feedback:\n"""${decision.feedback ?? '(no notes)'}"""\n\n` +
            'Revise the plan accordingly and call submit_plan again with the updated plan.',
        }],
        details: { decision: 'revise', feedback: decision.feedback },
      };
    }
    return {
      content: [{
        type: 'text' as const,
        text:
          'PLAN APPROVAL TIMED OUT (no response for 10 minutes). Do not wait further: end your turn with the plan written out as text so the user has it, ' +
          'and note they can re-run in Build mode directly.',
      }],
      details: { decision: 'timeout' },
    };
  },
});
