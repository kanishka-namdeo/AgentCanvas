// Design critic sub-agent — runs the reflection / self-critique pattern.
//
// Implements the "Reflection" agentic design pattern:
//   https://code.claude.com/docs/en/sub-agents
//   https://www.promptingtrust.ai/post/the-reflection-pattern-how-self-critique-makes-ai-smarter
//
// The pattern: after the main agent generates a design, this sub-agent
// reviews it from a senior-designer perspective and returns structured
// critique with severity-tagged findings. The main agent can then act on
// the findings to refine the design (closing the generate → critique →
// refine loop).
//
// Why a separate sub-agent (not inline)?
//   1. Context isolation: the critic doesn't see the generation prompt,
//      so it's not anchored on the original intent — it judges the result
//      on its own merits (reduces confirmation bias).
//   2. Different temperature / persona: critic runs at temperature 0.4
//      (more analytical) vs the main agent's 0.7 (more creative).
//   3. Token budget: a thorough critique can be 1-2k tokens; running it
//      inline would bloat the main context for every subsequent turn.

import ZAI from 'z-ai-web-dev-sdk';
import type { CanvasDocument, Shape } from '../../canvas/types';
import type { SubAgentResult, SubAgentParams } from '../skills/types';
import type { LLMClient } from '../runner';

// ---- Sub-agent system prompt ----------------------------------------------
//
// This prompt deliberately takes a "strict senior designer" persona to
// counter the LLM's tendency to be agreeable. The critique is structured
// (severity-tagged findings) so the main agent can act on each item.

const CRITIC_SYSTEM_PROMPT = `You are a strict senior UX/UI design critic reviewing a canvas design. Your job is to find concrete, actionable issues — NOT to praise.

You will receive:
1. The original user request (for context only — do NOT let it bias your evaluation)
2. A textual snapshot of the current canvas (shapes + their properties)
3. Design tokens + variables (if any)

Your review MUST cover these dimensions (skip any that don't apply):
- **Visual hierarchy**: Is the most important element the most prominent? Are there competing focal points?
- **Alignment & spacing**: Are elements aligned to a grid? Are spacing values consistent (4/8/12/16/24px scale)? Any near-misses?
- **Color usage**: Palette coherence, contrast (WCAG AA = 4.5:1 for body text, 3:1 for large), token binding
- **Typography**: Type scale consistency (ideally 4-5 steps), line-height, line-length, font weight hierarchy
- **Component reuse**: Are repeated patterns (e.g. 3 similar cards) candidates for a Component? (the canvas has a component system — recommend it where relevant)
- **Density**: Is the layout too cramped or too sparse for its purpose?
- **Accessibility**: Missing labels, low contrast, icon-only buttons without tooltips
- **Edge cases**: Empty states, long text overflow, narrow viewport breakpoints

=== OUTPUT FORMAT (strict) ===
End your response with a "CRITIQUE:" section, structured as a bulleted list. Each finding MUST be tagged with a severity prefix:

- [BLOCKER] <issue> — <suggested fix>
- [MAJOR]  <issue> — <suggested fix>
- [MINOR]  <issue> — <suggested fix>
- [PRAISE] <what works well>  (rare — only for genuinely excellent choices)

Examples:
- [BLOCKER] Submit button text "btn" is truncated and has 2.1:1 contrast on its fill — change label to "Submit" and use #ffffff text on the #0ea5e9 fill.
- [MAJOR] 3 card shapes have inconsistent border-radius (4/6/8px) — pick one value (recommend 6px) and apply uniformly.
- [MINOR] The header logo is 2px off the grid baseline — nudge to x=120.

Be specific. Quote shape names, hex codes, exact pixel values. Do not give generic advice like "improve hierarchy" — say exactly what to change and how.

After "CRITIQUE:", add a "SCORE:" line with a 1-10 rating (10 = production-ready) and a one-sentence justification.`;

// ---- Public API ------------------------------------------------------------

/**
 * Dispatch the design critic sub-agent.
 *
 * The sub-agent runs in its own LLM context (no canvas tools — it's
 * read-only analysis) and returns a structured critique.
 *
 * Returns a SubAgentResult with `summary` set to the formatted critique
 * text. The main agent can then act on each finding.
 */
export async function dispatchDesignCriticSubAgent(
  params: SubAgentParams & { originalPrompt: string },
): Promise<SubAgentResult> {
  let toolCallCount = 0;
  const startTime = Date.now();

  try {
    const zai = (await ZAI.create()) as unknown as LLMClient;

    // Serialize the canvas snapshot for the critic.
    const snapshot = serializeCanvasForCritic(params.canvas);

    const userMessage = `Original user request (for context, do not let it bias your evaluation):
${params.originalPrompt}

=== CANVAS SNAPSHOT =========================================================
${snapshot}
=== END SNAPSHOT ============================================================

Review this design critically. End your response with "CRITIQUE:" and "SCORE:" as instructed in your system prompt.`;

    const messages: Array<{
      role: 'system' | 'user' | 'assistant';
      content: string;
    }> = [
      { role: 'system', content: CRITIC_SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ];

    let finalSummary = '';
    const MAX_ITERATIONS = 2; // Critic should be 1-2 calls — no tool loops

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      const completion = await zai.chat.completions.create({
        messages: messages as any,
        // No tools — the critic is pure analysis.
        temperature: 0.4, // Lower temperature = more analytical, less agreeable.
      });
      toolCallCount++;

      const msg = completion?.choices?.[0]?.message;
      if (!msg) break;

      const content = msg.content?.trim() || '';
      if (!content) break;

      // Check for the critique marker.
      if (/CRITIQUE:/i.test(content) || iter === MAX_ITERATIONS - 1) {
        finalSummary = content;
        break;
      }

      // If the model didn't finish, ask it to finalize.
      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content: 'Please finalize your review now with the "CRITIQUE:" and "SCORE:" sections.',
      });
    }

    return {
      summary: finalSummary || 'Critic produced no output.',
      toolCalls: toolCallCount,
      success: finalSummary.length > 0,
    };
  } catch (err) {
    return {
      summary: `Critic sub-agent error: ${err instanceof Error ? err.message : String(err)}`,
      toolCalls: toolCallCount,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---- Helpers ---------------------------------------------------------------

/**
 * Serialize the canvas into a compact textual snapshot for the critic.
 *
 * The critic doesn't need every property — only the ones that affect
 * design quality. We deliberately omit internal ids (except for naming)
 * to keep the snapshot under 2k tokens for typical designs.
 */
function serializeCanvasForCritic(canvas: CanvasDocument): string {
  const shapes = canvas.shapes ?? [];
  if (shapes.length === 0) return '(empty canvas)';

  const lines: string[] = [];
  lines.push(`Background: ${canvas.background}`);
  lines.push(`Total shapes: ${shapes.length}`);
  lines.push('');

  // Group shapes by type for compactness.
  const byType = new Map<string, Shape[]>();
  for (const s of shapes) {
    const arr = byType.get(s.type) ?? [];
    arr.push(s);
    byType.set(s.type, arr);
  }

  for (const [type, group] of byType) {
    lines.push(`--- ${type.toUpperCase()} (${group.length}) ---`);
    for (const s of group.slice(0, 20)) { // cap at 20 per type to stay under token budget
      const parts: string[] = [`"${s.name}"`];
      parts.push(`@(${Math.round(s.x)},${Math.round(s.y)}) ${Math.round(s.width)}×${Math.round(s.height)}`);
      if (s.fill && s.fill !== '#e2e8f0') parts.push(`fill:${s.fill}`);
      if (s.stroke && s.stroke !== '#0f172a' && s.strokeWidth > 0) parts.push(`stroke:${s.stroke}@${s.strokeWidth}px`);
      if (s.radius > 0) parts.push(`r:${s.radius}`);
      if (s.type === 'text') {
        parts.push(`text:"${(s.text ?? '').slice(0, 40)}"`);
        parts.push(`size:${s.fontSize}`);
        parts.push(`color:${s.textColor}`);
      }
      if (s.componentId) parts.push(`component:${s.componentId === s.id ? 'master' : 'instance'}`);
      if (s.tokenBinding?.fillToken) parts.push(`token:${s.tokenBinding.fillToken}`);
      lines.push(`  • ${parts.join(' | ')}`);
    }
    if (group.length > 20) lines.push(`  ... (${group.length - 20} more)`);
    lines.push('');
  }

  // Token usage summary.
  const tokens = canvas.tokens;
  if (tokens.colors.length > 0) {
    lines.push(`--- DESIGN TOKENS (${tokens.colors.length} colors, ${tokens.textStyles.length} text styles) ---`);
    for (const c of tokens.colors.slice(0, 10)) {
      lines.push(`  • ${c.name} (${c.key}): ${c.value}`);
    }
  } else {
    lines.push(`--- DESIGN TOKENS: none defined ---`);
  }

  return lines.join('\n');
}
