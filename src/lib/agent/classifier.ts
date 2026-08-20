// Intent classifier — routes user prompts to the right skill category.
//
// This is the Tier 1 "routing workflow" pattern from Anthropic's
// "Building Effective Agents" guidance:
//   https://www.anthropic.com/engineering/building-effective-agents
//
// Architecture:
//   1. Keyword/regex pass (instant, zero cost) — matches the prompt against
//      each skill's keyword list. If a single skill matches with high
//      confidence, return it immediately.
//   2. If the keyword pass is ambiguous (multiple skills match, or none),
//      fall back to an LLM call that sees ONLY the 7 skill descriptions
//      (not all 56 tools). This is cheap (~200 tokens) and accurate.
//   3. If the LLM fallback also fails or is unavailable, return 'multi'
//      (load all skills — the safe fallback).
//
// The classifier also detects "multi-step" prompts (e.g. "research X then
// design Y") and recommends a planning phase.

import type { ClassificationResult, SkillCategory } from './skills/types';
import { SKILLS, getSkillMetadata } from './skills/registry';
import type { LLMClient } from './runner';
import { callLLMWithRetry } from './llm-retry';

// ---- Public API ------------------------------------------------------------

export interface ClassifyOptions {
  /// The user's prompt.
  prompt: string;
  /// Current canvas state (used to detect "modify existing" vs "create new").
  canvasShapeCount: number;
  /// Optional LLM client for the fallback pass. If omitted, only the keyword
  /// pass runs (and ambiguous prompts fall back to 'multi').
  llm?: LLMClient;
  /// Optional abort signal.
  signal?: AbortSignal;
}

/**
 * Classify the user's intent into a skill category.
 *
 * Returns the primary category, any secondary categories, the classification
 * method, a confidence score, and whether a planning phase is recommended.
 */
export async function classifyIntent(opts: ClassifyOptions): Promise<ClassificationResult> {
  // Normalize apostrophes: 'what's new' → "what's new" so both match.
  // The user may type either ASCII apostrophe, typographic ', or none at all.
  const prompt = opts.prompt
    .replace(/[\u2019\u2018`]/g, "'") // typographic apostrophes → ASCII
    .toLowerCase()
    .trim();

  // Step 1: keyword pass.
  const keywordResult = classifyByKeywords(prompt, opts.canvasShapeCount);
  if (keywordResult.confidence >= 0.7) {
    return keywordResult;
  }

  // Step 2: LLM fallback (if available).
  if (opts.llm) {
    try {
      const llmResult = await classifyWithLLM(opts.prompt, opts.llm, opts.signal);
      if (llmResult) {
        return {
          ...llmResult,
          recommendPlan: keywordResult.recommendPlan || llmResult.recommendPlan,
        };
      }
    } catch {
      // Fall through to the keyword result.
    }
  }

  // Step 3: if keyword pass found something (even if low confidence), use it.
  if (keywordResult.confidence > 0) {
    return keywordResult;
  }

  // Step 4: safe fallback — load all skills.
  return {
    category: 'multi',
    secondaryCategories: [],
    method: 'fallback',
    confidence: 0,
    recommendPlan: false,
  };
}

// ---- Keyword classifier ----------------------------------------------------
//
// Scores each skill by counting keyword matches. The skill with the highest
// score wins. If two skills have similar scores, confidence drops.

interface KeywordScore {
  category: SkillCategory;
  score: number;
  matchedKeywords: string[];
}

function classifyByKeywords(prompt: string, canvasShapeCount: number): ClassificationResult {
  const scores: KeywordScore[] = [];

  for (const [category, skill] of Object.entries(SKILLS)) {
    if (!skill) continue;
    const matched: string[] = [];
    let score = 0;
    for (const kw of skill.keywords) {
      const kwLower = kw.toLowerCase();
      // Bug fix (A): Short keywords (≤3 chars) cause substring false-positives
      // (e.g. "app" in "apply", "ui" in "build", "web" in "webpage"). Use
      // word-boundary matching for short keywords; substring for longer ones.
      const isShort = kwLower.length <= 3;
      const matches = isShort
        ? new RegExp(`\\b${escapeRegex(kwLower)}\\b`).test(prompt)
        : prompt.includes(kwLower);
      if (matches) {
        matched.push(kw);
        // Longer keywords get higher weight (more specific).
        // Multi-word keywords (e.g. "auto layout") get 3, single words ≥5 chars
        // get 2, short single words (≤4 chars) get 1.
        const weight = kw.includes(' ') ? 3 : (kwLower.length >= 5 ? 2 : 1);
        score += weight;
      }
    }
    if (score > 0) {
      scores.push({ category: category as SkillCategory, score, matchedKeywords: matched });
    }
  }

  // Bug fix (B): Deterministic tie-break. When two skills have the same score,
  // prefer the one with more specific (longer/weighted) keyword matches.
  // This prevents stable-sort from always picking wireframe (which is first
  // in the SKILLS object iteration order).
  scores.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Tie-break 1: prefer non-wireframe skills on ties. "design" is a very
    // generic wireframe keyword that matches too broadly; specific action
    // verbs like "audit", "export", "align" should win ties against it.
    if (a.category === 'wireframe' && b.category !== 'wireframe') return 1;
    if (b.category === 'wireframe' && a.category !== 'wireframe') return -1;
    // Tie-break 2: the skill whose longest matched keyword is longer wins
    // (longer keywords are more specific).
    const aMaxLen = Math.max(...a.matchedKeywords.map((k) => k.length));
    const bMaxLen = Math.max(...b.matchedKeywords.map((k) => k.length));
    return bMaxLen - aMaxLen;
  });

  if (scores.length === 0) {
    // No keyword matches. If the canvas has shapes, maybe the user wants to
    // modify them (layout/styling). If empty, maybe they want to create.
    if (canvasShapeCount > 0) {
      return {
        category: 'multi',
        secondaryCategories: [],
        method: 'keyword',
        confidence: 0.2,
        recommendPlan: false,
      };
    }
    return {
      category: 'wireframe',
      secondaryCategories: [],
      method: 'keyword',
      confidence: 0.3,
      recommendPlan: false,
    };
  }

  const top = scores[0];
  const second = scores[1];

  // If the top skill dominates (score is 2x+ the second), high confidence.
  const confidence = second ? Math.min(0.95, top.score / (top.score + second.score)) : 0.9;

  // Bug fix (C): Plan-overtrigger. The old rule `hasResearch && hasDesign`
  // fired on incidental co-occurrence (e.g. "search for design trends" has
  // both "search" and "design" but is a single research task, not multi-step).
  // Fix: require a connective word (then/and/after/next) to confirm the user
  // actually wants multiple steps.
  const hasResearch = scores.some((s) => s.category === 'web_research');
  const hasDesign = scores.some((s) => s.category === 'wireframe');
  const hasConnective = /\bthen\b|\band\b|\bafter\b|\bnext\b|→|->/.test(prompt);
  const recommendPlan = hasConnective && ((hasResearch && hasDesign) || scores.length >= 3);

  // Bug fix (D): For multi-step prompts with a connective ("research X then
  // design Y"), the LAST skill in the prompt is the final deliverable and
  // should be the primary category. We scan the prompt for the last occurrence
  // of each matched skill's keywords and pick the skill whose last match
  // appears furthest to the right.
  let primaryCategory = top.category;
  if (recommendPlan && scores.length >= 2) {
    let bestPos = -1;
    for (const sc of scores) {
      const skill = SKILLS[sc.category];
      if (!skill) continue;
      let lastPos = -1;
      for (const kw of skill.keywords) {
        const kwLower = kw.toLowerCase();
        const pos = prompt.lastIndexOf(kwLower);
        if (pos > lastPos) lastPos = pos;
      }
      if (lastPos > bestPos) {
        bestPos = lastPos;
        primaryCategory = sc.category;
      }
    }
  }

  // Secondary categories: any other skill that scored > 0, EXCLUDING the
  // primary category. This ensures that when the primary is overridden by
  // the "last deliverable" logic, the original top-scoring skill (e.g.
  // web_research) is included in secondary categories so the runner knows
  // to dispatch the sub-agent.
  const secondaryCategories = scores
    .filter((s) => s.category !== primaryCategory)
    .map((s) => s.category);

  return {
    category: primaryCategory,
    secondaryCategories,
    method: 'keyword',
    confidence,
    recommendPlan,
  };
}

/// Escape a string for use in a RegExp (for word-boundary matching).
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- LLM classifier --------------------------------------------------------
//
// A lightweight LLM call that sees only the 7 skill descriptions (not all 56
// tools). Returns the best-matching category. Used as a fallback when the
// keyword pass is ambiguous.

async function classifyWithLLM(
  prompt: string,
  llm: LLMClient,
  signal?: AbortSignal,
): Promise<ClassificationResult | null> {
  const metadata = getSkillMetadata();
  const skillList = metadata.map((s) => `- ${s.id}: ${s.description}`).join('\n');

  const systemPrompt = `You are an intent classifier for a design-canvas AI agent. Given the user's prompt, classify it into exactly ONE of these skill categories:

${skillList}

- multi: use ONLY if the prompt genuinely spans multiple unrelated skills and you can't pick a primary one.

Respond with ONLY a JSON object (no markdown, no explanation):
{"category": "<skill_id>", "confidence": 0.0-1.0, "recommendPlan": true|false}

Set recommendPlan=true if the prompt describes a multi-step task (e.g. "research X then design Y").`;

  try {
    const completion = await callLLMWithRetry(
      llm as any,
      {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        temperature: 0,
      },
      // The classifier is a cheap call — fewer retries, shorter backoff.
      { maxRetries: 3, baseDelayMs: 3000 },
    );
    const text = completion?.choices?.[0]?.message?.content?.trim() ?? '';
    // Extract JSON from the response (in case the model wraps it in markdown).
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    const category = parsed.category as SkillCategory;
    if (!SKILLS[category] && category !== 'multi') return null;
    return {
      category,
      secondaryCategories: [],
      method: 'llm',
      confidence: Math.min(1, Math.max(0, parsed.confidence ?? 0.5)),
      recommendPlan: !!parsed.recommendPlan,
    };
  } catch {
    return null;
  }
}
