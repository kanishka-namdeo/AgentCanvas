// Plan module — generates a step-by-step plan before execution.
//
// This is the Tier 2 "Plan module" from the Manus architecture:
//   https://gist.github.com/renschni/4fbc70b31bad8dd57f3370239dccd58f
//
// Manus's planner breaks high-level goals into an ordered list of steps with
// status and reflection. The plan is injected into context as a special
// "Plan" event, and can be updated on the fly as execution proceeds.
//
// In our implementation:
//   - For simple single-skill tasks, planning is skipped (the skill body
//     already contains the strategy).
//   - For multi-step tasks (recommendPlan=true from the classifier), the
//     planner makes a lightweight LLM call that sees only the skill
//     descriptions + the user's prompt. It returns an ordered step list.
//   - The plan is emitted as an `agent:plan` event so the UI can display it.
//   - As the main agent loop executes, each step's status is updated
//     (pending → in_progress → completed).

import type { Plan, PlanStep, SkillCategory, ClassificationResult } from './skills/types';
import { getSkillMetadata } from './skills/registry';
import type { LLMClient } from './runner';
import { callLLMWithRetry } from './llm-retry';

// ---- Public API ------------------------------------------------------------

export interface PlanOptions {
  prompt: string;
  classification: ClassificationResult;
  /// Optional LLM client. The planner makes a single LLM call to break
  /// multi-step prompts into ordered steps. If no LLM is provided (e.g.
  /// the native runner uses pi-ai's Model and doesn't have an OpenAI-shaped
  /// client readily available), the planner returns null and the runner
  /// proceeds without a plan — the agent will still execute the task, just
  /// without an explicit step list to follow.
  llm?: LLMClient;
  signal?: AbortSignal;
}

/**
 * Generate a plan for a multi-step task.
 *
 * Returns null if planning is not recommended (single-skill task) or if
 * no LLM is available to generate the plan.
 */
export async function generatePlan(opts: PlanOptions): Promise<Plan | null> {
  if (!opts.classification.recommendPlan) {
    return null;
  }
  if (!opts.llm) {
    // No LLM → can't generate a plan. The classifier's recommendPlan flag
    // is still respected by the runner (it just won't have a step list).
    return null;
  }

  const metadata = getSkillMetadata();
  const skillList = metadata.map((s) => `- ${s.id}: ${s.description}`).join('\n');

  const systemPrompt = `You are a planning module for a design-canvas AI agent. Given the user's request, break it into an ordered list of steps. Each step should map to one of these skills:

${skillList}

Rules:
- Keep it to 2-5 steps. Most tasks need 2-3.
- Each step should be a single, concrete action.
- Order steps logically (research before design, create before style, etc.).
- The last step should be the primary deliverable.

Respond with ONLY a JSON array (no markdown, no explanation):
[{"step": 1, "description": "...", "skill": "<skill_id>"}]`;

  try {
    const completion = await callLLMWithRetry(
      opts.llm as any,
      {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: opts.prompt },
        ],
        temperature: 0,
      },
      // Planner is a cheap call — fewer retries, shorter backoff.
      { maxRetries: 3, baseDelayMs: 3000 },
    );
    const text = completion?.choices?.[0]?.message?.content?.trim() ?? '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      step: number;
      description: string;
      skill: SkillCategory;
    }>;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;

    const steps: PlanStep[] = parsed.map((s) => ({
      step: s.step,
      description: s.description,
      skill: s.skill,
      status: 'pending' as const,
    }));

    return {
      steps,
      prompt: opts.prompt,
      createdAt: Date.now(),
    };
  } catch {
    return null;
  }
}

/**
 * Format a plan for display in the system prompt.
 * Shows the step list with current status so the agent knows where it is.
 */
export function formatPlanForPrompt(plan: Plan): string {
  const lines = plan.steps.map((s) => {
    let statusIcon = '[ ]';
    if (s.status === 'completed') statusIcon = '[x]';
    else if (s.status === 'in_progress') statusIcon = '[~]';
    else if (s.status === 'failed') statusIcon = '[!]';
    return `  ${statusIcon} Step ${s.step} (${s.skill}): ${s.description}`;
  });
  return `<plan>
${lines.join('\n')}
</plan>`;
}

/**
 * Mark a plan step's status. Returns a new Plan (immutable update).
 */
export function updatePlanStepStatus(
  plan: Plan,
  stepIndex: number,
  status: PlanStep['status'],
): Plan {
  const steps = plan.steps.map((s, i) =>
    i === stepIndex ? { ...s, status } : s,
  );
  return { ...plan, steps };
}
