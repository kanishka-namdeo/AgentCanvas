// Design critic sub-agent (VLM — vision-based) for Task 7-c P2.1 / T3.
//
// Mirrors `design-critic.ts` (the text-based critic) but feeds the rendered
// canvas as a PNG screenshot to a vision LLM. The VLM catches what the
// text-critic can't see:
//   - Alignment issues (text not aligned with grid)
//   - Whitespace distribution (cramped vs sparse regions)
//   - "Generic AI look" (the v0 / Midjourney pattern — flat colored divs
//     with no real content density)
//   - Contrast problems that don't show up as raw color values
//   - Element density / information architecture issues
//
// The VLM critique prompt is the SAME as the baseline measurement prompt
// at `/home/z/my-project/scripts/vlm-critique-prompt.txt` (Task 7-a) — so
// the "after" score from this critic is directly comparable to the 2/10
// baseline. We embed the prompt as the system prompt and pass the rendered
// PNG as a base64 image_url in the user message.

import ZAI from 'z-ai-web-dev-sdk';
import type { Layer, CanvasDocument } from '../../canvas/types';
import type { SubAgentResult, SubAgentParams } from '../skills/types';
import type { LLMClientLike as LLMClient } from '../llm-retry';
import { callLLMWithRetry } from '../llm-retry';
import { renderCanvasToPng } from '../../canvas/render-to-png';
import { emitEvent, hasSink } from '../plugins/event-bus';
import { awaitClientResponse, ROUNDTRIP_DEFAULTS } from '../client-roundtrip';

// ---- Public types ----------------------------------------------------------

/**
 * The structured VLM critique parsed out of the LLM's JSON response.
 *
 * Mirrors the shape of the Task 7-a baseline critique JSON:
 *   {
 *     "dimensions": { "1_visual_hierarchy": [{defect, fix}], … },
 *     "overall_score": 2,
 *     "top_5_fixes": [{priority, fix, impact}]
 *   }
 *
 * We don't strictly validate every dimension — the critic is best-effort
 * and downstream code degrades gracefully if a dimension is missing.
 */
export interface VlmCritique {
  /** Overall 1-10 score (1=wireframe, 10=production-ready). */
  overallScore: number;
  /** Severity bucket derived from overallScore: low ≥ 7, medium 4-6, high ≤ 3. */
  severity: 'low' | 'medium' | 'high';
  /** Per-dimension defects keyed by dimension name (e.g. "1_visual_hierarchy"). */
  dimensions: Record<string, Array<{ defect: string; fix: string }>>;
  /** Top 5 prioritized fixes the agent should apply next. */
  topFixes: Array<{ priority: number; fix: string; impact: 'high' | 'med' | 'low' }>;
  /** The raw LLM response (for telemetry / worklog). */
  raw?: string;
}

// ---- Sub-agent system prompt ----------------------------------------------
//
// Identical to /home/z/my-project/scripts/vlm-critique-prompt.txt — keeps the
// "after" measurement directly comparable to the Task 7-a "before" baseline.

const VLM_CRITIC_SYSTEM_PROMPT = `You are a senior UI/UX designer with 15 years of experience shipping production SaaS dashboards. Critique this AI-generated dashboard screenshot. Be specific and harsh.

For EACH of these 8 dimensions, list every defect you see with a concrete fix:
1. VISUAL HIERARCHY — what draws the eye first? Is it the right element? Are headings larger than body? Is the most important metric the visual focal point?
2. SPACING & PADDING — cramped? inconsistent gutters? missing breathing room? elements touching edges?
3. COLOR PALETTE — coherent or random? Is there a clear primary/accent/neutral system? Background too white? Cards have differentiated surface color?
4. TYPOGRAPHY — font weights used correctly (body 400, labels 500, section heads 600, hero 700)? Letter spacing? Line heights? Alignment (left/center/right)?
5. COMPONENT POLISH — do cards have shadow, rounded corners, border? Buttons look clickable (primary vs secondary distinction)? Inputs have border + placeholder?
6. ALIGNMENT — do edges line up? Is there a grid? Are elements scattered or aligned?
7. INFORMATION DENSITY — too sparse (lots of empty space, looks like a wireframe)? Too dense (cluttered, hard to scan)?
8. OVERALL PROFESSIONALISM — does this look like a real product (Stripe, Linear, Vercel dashboard) or like a wireframe / child's drawing?

Then give a single overall score 1-10 and a prioritized TOP-5 fix list (each fix = concrete action the AI agent or renderer should take).

Output as JSON with this shape:
{
  "dimensions": {
    "1_visual_hierarchy": [{"defect": "...", "fix": "..."}, ...],
    "2_spacing_padding": [...],
    "3_color_palette": [...],
    "4_typography": [...],
    "5_component_polish": [...],
    "6_alignment": [...],
    "7_information_density": [...],
    "8_overall_professionalism": [...]
  },
  "overall_score": <1-10>,
  "top_5_fixes": [{"priority": 1, "fix": "...", "impact": "high|med|low"}, ...]
}

Respond with ONLY the JSON object — no markdown fences, no commentary.`;

// ---- Public API ------------------------------------------------------------

/**
 * Dispatch the VLM (vision) design critic sub-agent.
 *
 * Renders the canvas to a PNG, base64-encodes it, and calls the vision LLM
 * with the same structured-critique prompt used for the Task 7-a baseline.
 *
 * Returns a `SubAgentResult` whose `summary` is the JSON-stringified VlmCritique
 * and whose `brief`-like field is the parsed `VlmCritique`. The runner's
 * mandatory self-critique loop reads `brief.topFixes` + `brief.dimensions`
 * and feeds them back to the agent as a re-prompt.
 */
export async function dispatchDesignCriticVlmSubAgent(
  params: SubAgentParams & { originalPrompt?: string; priorShapeIds?: string[] },
): Promise<SubAgentResult & { critique?: VlmCritique; screenshotSource?: 'client' | 'server' }> {
  let toolCallCount = 0;

  try {
    const llm: LLMClient = params.llm ?? ((await ZAI.create()) as unknown as LLMClient);

    // Render the canvas to PNG at 1440×900 (desktop dashboard size).
    const shapes: Layer[] = params.canvas.shapes ?? [];
    if (shapes.length === 0) {
      return {
        summary: 'VLM critic skipped — empty canvas (no shapes to critique).',
        toolCalls: 0,
        success: false,
        error: 'empty canvas',
      };
    }

    // Ground-truth first (spec §5.4, M2-c): ask the connected client for a
    // REAL screenshot of the rendered canvas (html-to-image on the live
    // world element). 3s budget; on timeout / no sink fall back to the
    // server-side resvg render — the D8 fallback discipline (the critic
    // must still run, just on the approximate picture).
    let base64: string;
    let screenshotSource: 'client' | 'server' = 'server';
    const roundtripId = `vlm-critic-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const shot = hasSink()
      ? await awaitClientResponse<{ dataUrl?: string; error?: string }>(
          roundtripId,
          () => emitEvent({ type: 'agent:screenshot_request', toolCallId: roundtripId, scale: 2 }),
          ROUNDTRIP_DEFAULTS.criticScreenshotTimeoutMs,
        )
      : null;
    if (shot?.dataUrl) {
      // Strip the data: URL prefix — the multimodal message below wants raw base64.
      base64 = shot.dataUrl.slice(shot.dataUrl.indexOf(',') + 1);
      screenshotSource = 'client';
      console.log('[design-critic-vlm] VLM critic using real client screenshot');
    } else {
      // TODO(spec §3.8 / Phase 2): thread the browser's `measuredBounds` map
      // (canvas store runtime slice, client-side) through the runner's tool
      // context so this render prefers real measured geometry over the
      // resolver's predictions. The renderCanvasToPng `measuredBounds` param
      // can now read the server-side map — wired below when a document id is
      // available in SubAgentParams.
      const png = await renderCanvasToPng(shapes, 1440, 900);
      base64 = png.toString('base64');
    }
    toolCallCount++;

    // Prior-content scope note (multi-screen stress-test fix): the rendered
    // screenshot shows the WHOLE canvas — earlier screens included. Tell the
    // VLM critic which screens are prior deliverables so it doesn't flag
    // (and "fix") the user's earlier work.
    const priorScopeNote = (params.priorShapeIds ?? []).length > 0
      ? `\n\nSCOPE: the screenshot may show screens from EARLIER requests (e.g. a previously created login screen). Those are the user's prior deliverables — NOT defects. Do NOT flag them or recommend deleting/replacing/restyling them. Critique ONLY the newest screen, the one created for the current request: "${params.originalPrompt ?? params.task}".`
      : '';

    // Build the multimodal user message (text + image_url).
    // The ZAI client's chat.completions.create accepts the OpenAI-shape
    // messages array including the image_url content part.
    const userMessage: any = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Original user request (for context, do not let it bias your evaluation):
${params.originalPrompt ?? params.task}${priorScopeNote}

Critique this rendered canvas screenshot. Return ONLY the JSON per the system prompt.`,
        },
        {
          type: 'image_url',
          image_url: {
            url: `data:image/png;base64,${base64}`,
            detail: 'high',
          },
        },
      ],
    };

    const messages: Array<any> = [
      { role: 'system', content: VLM_CRITIC_SYSTEM_PROMPT },
      userMessage,
    ];

    let rawResponse = '';
    let critique: VlmCritique | undefined;
    const MAX_ITERATIONS = 2;

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      const completion = await callLLMWithRetry(
        llm as any,
        {
          messages,
          temperature: 0.4,
        } as any,
        { maxRetries: 3, baseDelayMs: 3000 },
      );
      toolCallCount++;

      const msg = completion?.choices?.[0]?.message;
      if (!msg) break;
      const content = typeof msg.content === 'string' ? msg.content.trim() : '';
      if (!content) break;

      rawResponse = content;
      critique = parseVlmCritique(content);
      if (critique) break;

      // Retry once with strict-format reminder.
      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content: 'Your previous response did not parse as JSON. Reply with ONLY the JSON object — no markdown fences, no commentary.',
      });
    }

    if (!critique) {
      return {
        summary: rawResponse || 'VLM critic produced no output.',
        toolCalls: toolCallCount,
        success: false,
        error: 'JSON parse failed',
      };
    }

    return {
      summary: JSON.stringify(critique, null, 2),
      toolCalls: toolCallCount,
      success: true,
      critique,
      // Telemetry: which picture the critic actually judged ('client' = real
      // DOM-renderer capture, 'server' = resvg approximation, spec §5.4).
      screenshotSource,
    };
  } catch (err) {
    return {
      summary: `VLM critic sub-agent error: ${err instanceof Error ? err.message : String(err)}`,
      toolCalls: toolCallCount,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---- Helpers ---------------------------------------------------------------

/**
 * Parse a VlmCritique out of the LLM's JSON response.
 *
 * Defensive against markdown fences, leading commentary, and partial
 * responses. Fills in defaults for missing fields so downstream code can
 * degrade gracefully.
 */
export function parseVlmCritique(content: string): VlmCritique | undefined {
  let s = content.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  }
  const start = s.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let end = -1;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) return undefined;
  let obj: any;
  try {
    obj = JSON.parse(s.slice(start, end));
  } catch {
    return undefined;
  }
  if (!obj || typeof obj !== 'object') return undefined;

  const score =
    typeof obj.overall_score === 'number' ? obj.overall_score
    : typeof obj.overallScore === 'number' ? obj.overallScore
    : 5;

  const severity: VlmCritique['severity'] =
    score >= 7 ? 'low' : score >= 4 ? 'medium' : 'high';

  const dimensions: VlmCritique['dimensions'] = {};
  if (obj.dimensions && typeof obj.dimensions === 'object') {
    for (const [k, v] of Object.entries(obj.dimensions)) {
      if (Array.isArray(v)) {
        dimensions[k] = v
          .filter((d: any) => d && typeof d === 'object')
          .map((d: any) => ({
            defect: typeof d.defect === 'string' ? d.defect : '',
            fix: typeof d.fix === 'string' ? d.fix : '',
          }))
          .filter((d) => d.defect || d.fix);
      }
    }
  }

  const topFixes: VlmCritique['topFixes'] = Array.isArray(obj.top_5_fixes)
    ? obj.top_5_fixes
        .filter((f: any) => f && typeof f === 'object')
        .map((f: any, i: number) => ({
          priority: typeof f.priority === 'number' ? f.priority : i + 1,
          fix: typeof f.fix === 'string' ? f.fix : '',
          impact: f.impact === 'high' || f.impact === 'med' || f.impact === 'low' ? f.impact : 'med',
        }))
        .filter((f) => f.fix)
    : [];

  return {
    overallScore: score,
    severity,
    dimensions,
    topFixes,
    raw: content,
  };
}
