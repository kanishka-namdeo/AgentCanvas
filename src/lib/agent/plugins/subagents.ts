// Plugin: subagents
//
// Multi-agent delegation. Inspired by pi-subagents but re-implemented
// natively — uses the existing LLMClient infrastructure instead of
// spawning child Pi sessions (which would require the full TUI runtime).
//
// Three sub-agent profiles:
//
//   reviewer  — code/design review with severity-tagged findings (REPLACES
//               the hand-rolled design-critic.ts)
//   oracle    — second opinion before acting. Challenges assumptions
//               without editing. Useful before risky operations.
//   worker    — implementation work. Currently a passthrough that just
//               runs the same prompt back to the main agent (placeholder
//               until we wire up real sub-session spawning).
//
// All three sub-agents use the provider-aware LLM client (the same one
// the main runner uses) — they don't hardcode ZAI like the old
// design-critic.ts did.

import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { emitEvent } from './event-bus';
import type { SyncEvent } from '../../canvas/types';
import type { CanvasDocument } from '../../canvas/types';
import type { LLMClientLike } from '../llm-retry';
import { callLLMWithRetry } from '../llm-retry';

// ---- Sub-agent system prompts --------------------------------------------

const REVIEWER_SYSTEM_PROMPT = `You are a strict senior UX/UI design reviewer. Your job is to find concrete, actionable issues — NOT to praise.

You will receive:
1. The original user request (for context only — do NOT let it bias your evaluation)
2. A textual snapshot of the current canvas (shapes + their properties)

=== FIDELITY BAR (CRITICAL) ================================================

This agent produces HIGH-FIDELITY designs by default. A high-fidelity design must have:
  - Full color palette applied (NOT grayscale). If every shape is slate/gray, that's a wireframe.
  - Drop shadows on every elevated surface (cards, buttons, modals, FABs).
  - At least one gradient on the hero/CTA/logo (unless the design has no hero).
  - Realistic domain content — NEVER "Lorem ipsum", "Item 1", "Label", "Heading", "Placeholder".
  - A consistent type scale (12/14/16/20/24/30/38) and 8px spacing grid.
  - Corner radii from a scale (6/8/12/16/20), not all 0.

Your review MUST cover these dimensions:
- **Fidelity (gate)**: Is this high-fidelity? If not, BLOCKER.
- **Visual hierarchy**: Is the most important element the most prominent?
- **Alignment & spacing**: Are elements aligned to a grid? Are spacing values consistent?
- **Color usage**: Palette coherence, contrast (WCAG AA), token binding, 60-30-10 distribution.
- **Typography**: Type scale consistency, line-height, line-length, font weight hierarchy.
- **Component reuse**: Are repeated patterns candidates for a Component?
- **Accessibility**: Missing labels, low contrast, icon-only buttons without tooltips, touch targets < 44px.
- **Content realism**: Is the text real domain content or placeholder?

=== OUTPUT FORMAT (strict) ===
End your response with a "CRITIQUE:" section, structured as a bulleted list. Each finding MUST be tagged with a severity prefix:

- [BLOCKER] <issue> — <suggested fix>
- [MAJOR]  <issue> — <suggested fix>
- [MINOR]  <issue> — <suggested fix>
- [PRAISE] <what works well>  (rare — only for genuinely excellent choices)

After "CRITIQUE:", add a "SCORE:" line with a 1-10 rating (10 = production-ready).`;

const ORACLE_SYSTEM_PROMPT = `You are an oracle — a senior designer's second opinion. The main agent is about to make a decision and wants your perspective.

Your job:
1. Challenge the agent's assumptions.
2. Point out what the agent might be missing.
3. Suggest alternative approaches.
4. Be honest — if the agent's plan is solid, say so. If it has flaws, name them.

Do NOT edit anything. Do NOT call tools. Just provide your critique as plain text, structured as:

=== ASSUMPTIONS ===
- (list each assumption the agent seems to be making)

=== RISKS ===
- (list specific risks, with severity)

=== ALTERNATIVES ===
- (list 2-3 alternative approaches, with trade-offs)

=== VERDICT ===
(One paragraph: is the agent's plan sound? What should they change?)`;

const WORKER_SYSTEM_PROMPT = `You are a worker sub-agent. You receive a specific task and execute it.
Use the same canvas tools the main agent has access to.
When done, return a summary of what you did.`;

// ---- Sub-agent dispatch ----------------------------------------------------

interface SubAgentResult {
  summary: string;
  toolCalls: number;
  success: boolean;
  error?: string;
}

async function dispatchSubAgent(
  params: { systemPrompt: string; userMessage: string; llm: LLMClientLike; signal?: AbortSignal; maxIterations?: number },
): Promise<SubAgentResult> {
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: params.systemPrompt },
    { role: 'user', content: params.userMessage },
  ];
  let finalSummary = '';
  const maxIter = params.maxIterations ?? 2;
  for (let iter = 0; iter < maxIter; iter++) {
    const completion = await callLLMWithRetry(
      params.llm as any,
      { messages: messages as any, temperature: 0.4 },
      { maxRetries: 3, baseDelayMs: 3000 },
    );
    const msg = completion?.choices?.[0]?.message;
    if (!msg) break;
    const content = msg.content?.trim() ?? '';
    if (!content) break;
    finalSummary = content;
    // For reviewer/oracle, 1 iteration is enough (no tools).
    break;
  }
  return {
    summary: finalSummary || '(no output)',
    toolCalls: 0,
    success: finalSummary.length > 0,
  };
}

// ---- Canvas snapshot for the reviewer --------------------------------------
//
// Reuse the design-critic's snapshot serializer if it exists; otherwise
// build a minimal one here.

function serializeCanvasForSubagent(canvas: CanvasDocument): string {
  const shapes = canvas.shapes ?? [];
  if (shapes.length === 0) return '(empty canvas)';
  const lines: string[] = [];
  lines.push(`Background: ${canvas.background}`);
  lines.push(`Total shapes: ${shapes.length}`);
  lines.push('');
  const byType = new Map<string, typeof shapes>();
  for (const s of shapes) {
    const arr = byType.get(s.type) ?? [];
    arr.push(s);
    byType.set(s.type, arr);
  }
  for (const [type, group] of byType) {
    lines.push(`--- ${type.toUpperCase()} (${group.length}) ---`);
    for (const s of group.slice(0, 20)) {
      const parts: string[] = [`"${s.name}" @(${Math.round(s.x)},${Math.round(s.y)}) ${Math.round(s.width)}×${Math.round(s.height)}`];
      if (s.fill && s.fill !== '#e2e8f0') parts.push(`fill:${s.fill}`);
      if (s.shadow) parts.push(`shadow:(${s.shadow.x},${s.shadow.y},${s.shadow.blur},${s.shadow.color})`);
      if (s.gradient) parts.push(`gradient:${s.gradient.type}@${s.gradient.angle}deg`);
      if (s.type === 'text') {
        parts.push(`text:"${(s.text ?? '').slice(0, 40)}"`);
        parts.push(`size:${s.fontSize}`);
      }
      lines.push(`  • ${parts.join(' | ')}`);
    }
    if (group.length > 20) lines.push(`  ... (${group.length - 20} more)`);
    lines.push('');
  }
  return lines.join('\n');
}

// ---- The LLM client — set by the runner before each turn -------------------

let activeLLM: LLMClientLike | null = null;

export function setActiveLLM(llm: LLMClientLike | null): void {
  activeLLM = llm;
}

/// Provider-aware LLM client the runner armed for this turn (setActiveLLM
/// before the main loop). Pen tools that need sub-agent completions
/// (pen_generate_variants) read it through here — falls back to null and
/// the caller degrades to ZAI.create() sandbox credentials.
export function getActiveLLM(): LLMClientLike | null {
  return activeLLM;
}

// ---- Tools ----------------------------------------------------------------

const reviewerTool = defineTool({
  name: 'subagent_reviewer',
  label: 'Sub-agent: Reviewer',
  description:
    'Dispatch the reviewer sub-agent to critically review the current canvas. The reviewer runs in an isolated LLM context (no canvas tools — pure analysis) and returns severity-tagged findings + a 1-10 score. Use after generating a design to catch issues before finalizing.',
  promptSnippet: 'Dispatch a senior-designer reviewer to critique the current design.',
  promptGuidelines: [
    'Call subagent_reviewer after generating a design to catch fidelity, alignment, and consistency issues.',
    'The reviewer returns [BLOCKER] / [MAJOR] / [MINOR] findings + a 1-10 score.',
    'Act on each [BLOCKER] immediately — call the appropriate tools to fix them.',
    'Re-run subagent_reviewer after fixes to verify the score improved.',
  ],
  parameters: Type.Object({
    originalPrompt: Type.Optional(Type.String({ description: 'The original user request (for context — the reviewer should not let it bias evaluation)' })),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const typed = params as { originalPrompt?: string };
    if (!activeLLM) {
      return { content: [{ type: 'text', text: 'Error: no LLM client available for sub-agent.' }], details: { error: 'no_llm' } };
    }
    // We need the canvas — pull it from the runner's live provider (S5: a
    // static turn-start snapshot used to make mid-turn reviews critique the
    // PRE-turn canvas).
    const canvas = getActiveCanvas();
    if (!canvas) {
      return { content: [{ type: 'text', text: 'Error: no canvas available.' }], details: { error: 'no_canvas' } };
    }
    emitEvent({ type: 'agent:subagent_dispatch', subAgentType: 'reviewer', task: 'Critique current canvas' } satisfies SyncEvent);
    const snapshot = serializeCanvasForSubagent(canvas);
    const userMessage = `Original user request (for context, do not let it bias your evaluation):\n${typed.originalPrompt ?? '(not provided)'}\n\n=== CANVAS SNAPSHOT ===\n${snapshot}\n=== END SNAPSHOT ===\n\nReview this design critically. End your response with "CRITIQUE:" and "SCORE:" as instructed in your system prompt.`;
    const result = await dispatchSubAgent({
      systemPrompt: REVIEWER_SYSTEM_PROMPT,
      userMessage,
      llm: activeLLM,
      maxIterations: 1,
    });
    emitEvent({
      type: 'agent:subagent_result',
      subAgentType: 'reviewer',
      success: result.success,
      summary: result.summary.slice(0, 500),
      toolCalls: result.toolCalls,
    } satisfies SyncEvent);
    return {
      content: [{ type: 'text', text: result.summary }],
      details: { success: result.success, toolCalls: result.toolCalls },
    };
  },
});

const oracleTool = defineTool({
  name: 'subagent_oracle',
  label: 'Sub-agent: Oracle',
  description:
    'Dispatch the oracle sub-agent for a second opinion before acting on a risky decision. The oracle challenges assumptions, points out risks, and suggests alternatives. Use before major changes (e.g. "delete all cards and rebuild", "switch to dark mode", "change the entire color palette").',
  promptSnippet: 'Get a second opinion before a risky decision.',
  promptGuidelines: [
    'Call subagent_oracle before any major irreversible change.',
    'Pass a clear description of the decision you are about to make.',
    'The oracle returns ASSUMPTIONS, RISKS, ALTERNATIVES, and a VERDICT.',
    'Do NOT blindly follow the oracle — weigh its critique against the user\'s request.',
  ],
  parameters: Type.Object({
    decision: Type.String({ description: 'The decision you are about to make (e.g. "Switch the entire design to dark mode with #0b0f1a background")' }),
    context: Type.Optional(Type.String({ description: 'Additional context — the user\'s request, the current canvas state, etc.' })),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const typed = params as { decision: string; context?: string };
    if (!activeLLM) {
      return { content: [{ type: 'text', text: 'Error: no LLM client available for sub-agent.' }], details: { error: 'no_llm' } };
    }
    emitEvent({ type: 'agent:subagent_dispatch', subAgentType: 'oracle', task: typed.decision.slice(0, 100) } satisfies SyncEvent);
    const userMessage = `=== DECISION UNDER REVIEW ===\n${typed.decision}\n\n=== CONTEXT ===\n${typed.context ?? '(no additional context)'}\n\nProvide your second opinion using the format in your system prompt.`;
    const result = await dispatchSubAgent({
      systemPrompt: ORACLE_SYSTEM_PROMPT,
      userMessage,
      llm: activeLLM,
      maxIterations: 1,
    });
    emitEvent({
      type: 'agent:subagent_result',
      subAgentType: 'oracle',
      success: result.success,
      summary: result.summary.slice(0, 500),
      toolCalls: result.toolCalls,
    } satisfies SyncEvent);
    return {
      content: [{ type: 'text', text: result.summary }],
      details: { success: result.success },
    };
  },
});

const workerTool = defineTool({
  name: 'subagent_worker',
  label: 'Sub-agent: Worker',
  description:
    'NOT AVAILABLE — returns an error directing the agent to do the work itself. (Reserved for future sub-session spawning.)',
  promptSnippet: 'Delegate focused implementation work to a sub-agent.',
  promptGuidelines: [
    'Use subagent_worker for focused sub-tasks that benefit from isolation.',
    'Currently a placeholder — returns the task description as the summary.',
  ],
  parameters: Type.Object({
    task: Type.String({ description: 'The task to delegate' }),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const typed = params as { task: string };
    emitEvent({ type: 'agent:subagent_dispatch', subAgentType: 'worker', task: typed.task.slice(0, 100) } satisfies SyncEvent);
    // Audit 2-b T8 / audit 2-c S4: this tool used to return `success: true`
    // for work it never did — success theater that lets the model believe a
    // sub-task is done. It now returns an honest ERROR the model can act on
    // (do the work itself with its own tools).
    const result = {
      summary:
        `Worker sub-agent is not available in this build (no sub-session spawning yet). ` +
        `Do the task yourself with your own tools: "${typed.task.slice(0, 200)}".`,
      toolCalls: 0,
      success: false,
    };
    emitEvent({
      type: 'agent:subagent_result',
      subAgentType: 'worker',
      success: result.success,
      summary: result.summary,
      toolCalls: result.toolCalls,
    } satisfies SyncEvent);
    return {
      content: [{ type: 'text', text: result.summary }],
      details: { task: typed.task, unavailable: true },
      isError: true as any,
    };
  },
});

// ---- Canvas slot (set by the runner) --------------------------------------
//
// Audit 2-c S5: the runner used to pass a TURN-START snapshot here, so a
// mid-turn subagent_reviewer call read the pre-turn canvas (empty on a fresh
// document). The slot now accepts either a static document or a LIVE
// provider (closure over the runner's `canvas` variable) — readers always
// see the current state.

let activeCanvas: CanvasDocument | (() => CanvasDocument | null) | null = null;

export function setActiveCanvas(
  canvas: CanvasDocument | (() => CanvasDocument | null) | null,
): void {
  activeCanvas = canvas;
}

/// The LIVE canvas for sub-agent tools — resolves the provider each call so
/// mid-turn reads see the agent's own patches (the runner's `canvas` closure
/// is reassigned by ctx.applyPatch on every patch).
export function getActiveCanvas(): CanvasDocument | null {
  if (activeCanvas === null) return null;
  if (typeof activeCanvas === 'function') {
    try {
      return activeCanvas() ?? null;
    } catch {
      return null;
    }
  }
  return activeCanvas;
}

export const tools = [reviewerTool, oracleTool, workerTool];
