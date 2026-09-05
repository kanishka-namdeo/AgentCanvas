// Design brief sub-agent — runs the "pre-generation design inspiration" pattern
// (Task 7-c P1.2 / T1 from the 7-b research report).
//
// Implements v0's `GenerateDesignInspiration` pattern: BEFORE the main agent
// starts creating shapes, this sub-agent takes the user prompt and produces a
// JSON design brief (primary color, accent, neutral ramp, typography, layout
// grid, information architecture). The main agent then uses the brief as the
// canonical palette/typography reference for ALL subsequent shape creation,
// instead of improvising colors / sizes / layouts mid-turn.
//
// Why a separate sub-agent (not inline)?
//   1. Context isolation: the brief is generated from the prompt alone — the
//      sub-agent doesn't see the current canvas state, so it isn't anchored
//      on what's already there (reduces confirmation bias).
//   2. JSON-first output: we ask for strict JSON, parsed once, returned as
//      a structured `DesignBrief`. The main agent reads the brief as a tool
//      result and uses it as the palette/typography source-of-truth.
//   3. Decouples "think about design" from "draw shapes" — the exact
//      failure mode the Task 7-a VLM baseline exposed (agent skipped
//      thinking and went straight to `pen_generate_wireframe`, bypassing
//      every Task 6-a system-prompt section).
//
// Reference: https://platform.claude.com/docs/en/sub-agents (Reflection /
// sub-agent isolation pattern).

import ZAI from 'z-ai-web-dev-sdk';
import type { SubAgentResult, SubAgentParams } from '../skills/types';
import type { LLMClientLike as LLMClient } from '../llm-retry';
import { callLLMWithRetry } from '../llm-retry';

// ---- Public types ----------------------------------------------------------

/**
 * The structured design brief returned by the sub-agent.
 *
 * Every field is a concrete value the main agent should bind to subsequent
 * `pen_create_shape` / `pen_generate_wireframe` / `pen_set_variable` calls.
 * The colors are hex strings so the agent can drop them straight into the
 * `palette` argument of `pen_apply_palette`.
 */
export interface DesignBrief {
  /** Brand primary color (hex), e.g. "#0ea5e9" — drives $color.primary. */
  primaryColor: string;
  /** Secondary accent color (hex), e.g. "#6366f1" — drives $color.accent. */
  accentColor: string;
  /** 5-7 neutral ramp hex codes (light→dark), used for surfaces, borders, text. */
  neutralPalette: string[];
  /** Typography system. */
  typography: {
    /** CSS font-family string, e.g. "Inter, system-ui, sans-serif". */
    fontFamily: string;
    /** Type-scale multiplier name, e.g. "1.25 Major Third" or "1.125 Major Second". */
    headingScale: string;
    /** Body text size in px (typically 14 or 16). */
    bodySize: number;
  };
  /** Approximate number of distinct components the design should contain. */
  componentCount: number;
  /** Suggested CSS grid for the main layout, e.g. { cols: 12, rows: 6 }. */
  layoutGrid: { cols: number; rows: number };
  /**
   * Information architecture — ordered list of section/component names
   * from top-left to bottom-right. e.g.
   *   ["Topbar / Navbar", "Sidebar", "Page title", "KPI cards (4)",
   *    "Main chart", "Recent transactions table"]
   */
  informationArchitecture: string[];
  /** Optional 1-sentence summary the brief generator returned (for telemetry). */
  summary?: string;
}

// ---- Sub-agent system prompt ----------------------------------------------
//
// Strict JSON output only. The model is told to pick from the canonical
// 50-900 ramps (Sky/Violet/Emerald/Amber/Rose/Indigo) so downstream shapes
// use the same ramp as the COMPONENT RECIPES in the system prompt. This
// closes the "5 different blues" failure mode T4 calls out.

const BRIEF_SYSTEM_PROMPT = `You are a senior product designer. Given a user prompt describing a UI design request, return a JSON design brief that the main agent will use as the canonical palette, typography, layout, and information-architecture reference.

Use these canonical brand-color 50-900 ramps (pick the one whose 500 matches your primary):
  Sky:     50 #f0f9ff  100 #e0f2fe  200 #bae6fd  300 #7dd3fc  400 #38bdf8  500 #0ea5e9  600 #0284c7  700 #0369a1  800 #075985  900 #0c4a6e
  Violet:  50 #f5f3ff  100 #ede9fe  200 #ddd6fe  300 #c4b5fd  400 #a78bfa  500 #8b5cf6  600 #7c3aed  700 #6d28d9  800 #5b21b6  900 #4c1d95
  Emerald: 50 #ecfdf5  100 #d1fae5  200 #a7f3d0  300 #6ee7b7  400 #34d399  500 #10b981  600 #059669  700 #047857  800 #065f46  900 #064e3b
  Amber:   50 #fffbeb  100 #fef3c7  200 #fde68a  300 #fcd34d  400 #fbbf24  500 #f59e0b  600 #d97706  700 #b45309  800 #92400e  900 #78350f
  Rose:    50 #fff1f2  100 #ffe4e6  200 #fecdd3  300 #fda4af  400 #fb7185  500 #f43f5e  600 #e11d48  700 #be123c  800 #9f1239  900 #881337
  Indigo:  50 #eef2ff  100 #e0e7ff  200 #c7d2fe  300 #a5b4fc  400 #818cf8  500 #6366f1  600 #4f46e5  700 #4338ca  800 #3730a3  900 #312e81

Rules:
  1. Pick ONE ramp (don't mix ramps — that creates the "5 different blues" failure).
  2. primaryColor = the 500 from your chosen ramp.
  3. accentColor = the 500 from a complementary ramp (e.g. Sky+Violet, Emerald+Indigo, Amber+Rose).
  4. neutralPalette = 6-8 shades from a Slate/Tailwind neutral ramp (light→dark):
       #f8fafc, #f1f5f9, #e2e8f0, #cbd5e1, #94a3b8 (BORDERS/DIVIDERS ONLY — never text,
       it fails WCAG 4.5:1), #64748b (subtle-text floor), #475569, #0f172a
     This is the neutral system used for bg, surfaces, borders, text — it stays constant
     regardless of the chosen brand color so the design feels coherent.
  5. typography.fontFamily = "Inter, system-ui, sans-serif" (the design system's default font).
  6. typography.headingScale = "1.25 Major Third" for marketing pages / "1.125 Major Second" for dashboards.
  7. typography.bodySize = 14 (web app) or 16 (marketing site).
  8. componentCount = a realistic number for the request — 8-12 for a single dashboard screen,
     15-25 for a multi-screen flow. NEVER under 5 (a wireframe-only output fails the validation gate).
  9. layoutGrid = { cols: 12, rows: 6 } for desktop dashboards / { cols: 4, rows: 8 } for mobile.
  10. informationArchitecture = ordered list of section names (top-left to bottom-right) — for a
      fintech dashboard: ["Topbar (logo + search + avatar)", "Sidebar (Dashboard, Transactions, Analytics, Settings)",
      "Page title", "KPI cards (Revenue, Expenses, Profit, Active Users)", "Main chart (Revenue over time)",
      "Recent transactions table"]. This list drives the agent's shape-creation sequence — every entry becomes
      at least one shape.

OUTPUT FORMAT: Respond with a SINGLE JSON object — no markdown fences, no commentary, just the JSON.
The JSON MUST have this shape:
{
  "primaryColor": "#0ea5e9",
  "accentColor": "#6366f1",
  "neutralPalette": ["#f8fafc", "#f1f5f9", "#e2e8f0", "#cbd5e1", "#94a3b8", "#64748b", "#475569", "#0f172a"],
  "typography": {
    "fontFamily": "Inter, system-ui, sans-serif",
    "headingScale": "1.25 Major Third",
    "bodySize": 14
  },
  "componentCount": 12,
  "layoutGrid": { "cols": 12, "rows": 6 },
  "informationArchitecture": [
    "Topbar (logo + search + avatar)",
    "Sidebar (Dashboard, Transactions, Analytics, Settings)",
    "Page title",
    "KPI cards (Revenue, Expenses, Profit, Active Users)",
    "Main chart (Revenue over time)",
    "Recent transactions table"
  ],
  "summary": "Sky+Indigo brand palette, 12-col dashboard grid, 12 components, 6 IA sections."
}`;

// ---- Public API ------------------------------------------------------------

/**
 * Dispatch the design brief sub-agent.
 *
 * The sub-agent runs in its own LLM context (no canvas tools — pure
 * analysis) and returns a structured `DesignBrief`. The main agent then
 * uses the brief as the palette/typography/layout source-of-truth for
 * every subsequent `pen_create_shape` / `pen_generate_wireframe` call.
 *
 * Returns a `SubAgentResult` whose `summary` is a compact JSON string of
 * the brief. The `pen_generate_design_brief` tool wraps this and parses
 * the JSON before returning to the agent.
 */
export async function dispatchDesignBriefSubAgent(
  params: SubAgentParams & { originalPrompt?: string },
): Promise<SubAgentResult & { brief?: DesignBrief }> {
  let toolCallCount = 0;
  const startTime = Date.now();

  try {
    // Provider-aware LLM client construction (mirrors design-critic.ts).
    // Use the caller-supplied client if provided; otherwise fall back to
    // ZAI.create() for the sandbox auto-credential path.
    const llm: LLMClient = params.llm ?? ((await ZAI.create()) as unknown as LLMClient);

    const userMessage = `Generate a design brief for this UI request:

${params.originalPrompt ?? params.task}

Return ONLY the JSON object per the system-prompt contract. No markdown, no commentary.`;

    const messages: Array<{
      role: 'system' | 'user' | 'assistant';
      content: string;
    }> = [
      { role: 'system', content: BRIEF_SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ];

    let finalSummary = '';
    let brief: DesignBrief | undefined;
    const MAX_ITERATIONS = 2; // Brief generation should be 1-2 calls — no tool loops.

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      const completion = await callLLMWithRetry(
        llm as any,
        {
          messages: messages as any,
          // No tools — the brief generator is pure analysis.
          temperature: 0.4, // Lower temperature = more deterministic JSON.
        },
        { maxRetries: 3, baseDelayMs: 3000 },
      );
      toolCallCount++;

      const msg = completion?.choices?.[0]?.message;
      if (!msg) break;

      const content = msg.content?.trim() || '';
      if (!content) break;

      // Try to parse the JSON out of the response. The model should emit pure
      // JSON per the contract, but be defensive: strip markdown fences + pick
      // the first { … } block.
      const parsed = parseBriefJson(content);
      if (parsed) {
        brief = parsed;
        finalSummary = JSON.stringify(parsed, null, 2);
        break;
      }

      // If the JSON didn't parse, ask the model to retry with strict format.
      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content:
          'Your previous response did not parse as JSON. Reply with ONLY the JSON object now — no markdown fences, no commentary, no leading text.',
      });
    }

    return {
      summary: finalSummary || 'Brief sub-agent produced no output.',
      toolCalls: toolCallCount,
      success: !!brief,
      brief,
    };
  } catch (err) {
    return {
      summary: `Brief sub-agent error: ${err instanceof Error ? err.message : String(err)}`,
      toolCalls: toolCallCount,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---- Helpers ---------------------------------------------------------------

/**
 * Parse a DesignBrief JSON out of an LLM response.
 *
 * The contract says "pure JSON", but be defensive: models sometimes wrap
 * JSON in markdown fences (```json … ```) or prepend a sentence. We:
 *   1. Strip ```json…``` / ```…``` fences if present.
 *   2. Find the first balanced { … } block.
 *   3. JSON.parse + validate required fields.
 *
 * Returns undefined if parsing fails (the caller retries).
 */
export function parseBriefJson(content: string): DesignBrief | undefined {
  // Strip markdown code fences.
  let s = content.trim();
  if (s.startsWith('```')) {
    // Remove opening fence + optional language tag.
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  }
  // Find the first balanced { … } block (handles nested braces).
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
  const jsonStr = s.slice(start, end);
  let obj: any;
  try {
    obj = JSON.parse(jsonStr);
  } catch {
    return undefined;
  }
  if (!obj || typeof obj !== 'object') return undefined;
  // Validate required fields. Fill in defensive defaults for missing ones
  // so a partial brief is still usable by the agent (better than failing).
  const brief: DesignBrief = {
    primaryColor: typeof obj.primaryColor === 'string' ? obj.primaryColor : '#0ea5e9',
    accentColor: typeof obj.accentColor === 'string' ? obj.accentColor : '#6366f1',
    neutralPalette: Array.isArray(obj.neutralPalette)
      ? obj.neutralPalette.filter((c: unknown) => typeof c === 'string').slice(0, 8)
      : ['#f8fafc', '#f1f5f9', '#e2e8f0', '#cbd5e1', '#94a3b8', '#64748b', '#475569', '#0f172a'],
    typography: {
      fontFamily:
        obj.typography && typeof obj.typography.fontFamily === 'string'
          ? obj.typography.fontFamily
          : 'Inter, system-ui, sans-serif',
      headingScale:
        obj.typography && typeof obj.typography.headingScale === 'string'
          ? obj.typography.headingScale
          : '1.25 Major Third',
      bodySize:
        obj.typography && typeof obj.typography.bodySize === 'number'
          ? obj.typography.bodySize
          : 14,
    },
    componentCount:
      typeof obj.componentCount === 'number' && obj.componentCount > 0
        ? obj.componentCount
        : 10,
    layoutGrid: {
      cols:
        obj.layoutGrid && typeof obj.layoutGrid.cols === 'number'
          ? obj.layoutGrid.cols
          : 12,
      rows:
        obj.layoutGrid && typeof obj.layoutGrid.rows === 'number'
          ? obj.layoutGrid.rows
          : 6,
    },
    informationArchitecture: Array.isArray(obj.informationArchitecture)
      ? obj.informationArchitecture
          .filter((s: unknown) => typeof s === 'string' && (s as string).length > 0)
          .slice(0, 20)
      : [],
    summary: typeof obj.summary === 'string' ? obj.summary : undefined,
  };
  // If componentCount is too low (< 5), bump it — the validation gate would
  // fail otherwise.
  if (brief.componentCount < 5) brief.componentCount = 5;
  return brief;
}
