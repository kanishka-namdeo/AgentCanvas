// prompt-intent.ts — Poor-prompt hardening: edit-reference detection +
// staged-flow detection (pure heuristics, no LLM round-trip).
//
// Real-world users open the app and type edit-shaped prompts against an
// EMPTY canvas: "make it blue", "make it bigger", "change the color",
// "make it pop". There is nothing to edit — the honest behavior is a short
// clarifying question ("what would you like to build — a login page, a
// dashboard?"), NOT an invented design. Observed live (poor-prompts battery
// 2026-09-07, qwen3.7-plus): the model EXPLICITLY reasoned "the request is
// ambiguous on an empty canvas — there's nothing to modify" and then built
// 8 shapes anyway (193s). The runner uses this predicate to inject an
// EMPTY-CANVAS EDIT GUARD block into the first user message and to stand
// down the build-shaped turn guards (brief enforcement, text-only retry,
// never-drew error) for that turn — the clarification IS the correct
// terminal output.
//
// Design notes:
//  - Pure string heuristics — no LLM round-trip, no async, no state.
//  - Anaphora only: a verb + BARE PRONOUN object ("make it/them/this…") or
//    a pronoun + comparative ("it bigger/darker…") or a canvas-relative
//    definite reference ("the color", "the selection", "the text").
//  - Creation counter-signal: if the prompt names a concrete artifact
//    ("make this landing page dark", "add a settings screen"), the model
//    should CREATE — the pronoun is just determiner style, not anaphora.
//  - On a NON-EMPTY canvas this predicate is NOT consulted by the guard
//    (the snapshot/selection context resolves "it" for the model).

import type { AgentMode } from './modes';
import { detectMultitaskPrompt } from './modes';

/** Verbs that take a direct object being edited. */
const EDIT_VERB =
  /\b(?:make|change|update|fix|move|delete|remove|turn|set|resize|adjust|restyle|recolor|shrink|enlarge|polish|style|tweak|nudge)\b/i;

/** Bare pronoun / definite-reference objects — anaphora with no noun. */
const PRONOUN_OBJECT =
  /\b(?:it|them|this|that|these|those|everything|all of it|all of this|all of them|the selection|the selected|the color|the colour|the text|the font|the background)\b/i;

/** Comparative/evaluative anaphora: "it bigger", "that pop", "them nicer". */
const COMPARATIVE_ANAPHORA =
  /\b(?:it|this|that|them|these|those)\s+(?:bigger|smaller|larger|taller|wider|thinner|darker|lighter|brighter|bolder|softer|sharper|better|worse|nicer|prettier|cooler|cleaner|simpler|faster|cheaper|modern|pop|shine|stand out)\b/i;

/**
 * Concrete artifact noun — when the prompt names one (with any determiner or
 * bare), it's a creation request, not pure anaphora. Deliberately broad:
 * screens, components, primitives, and app surfaces.
 */
const CONCRETE_ARTIFACT =
  /\b(?:page|screen|dashboard|form|card|button|table|chart|nav|navbar|navigation|hero|section|landing|layout|app|application|website|site|profile|panel|input|field|label|list|menu|sidebar|toolbar|footer|header|banner|modal|dialog|grid|gallery|timeline|graph|pricing|login|log-in|signin|sign-in|signup|sign-up|checkout|wireframe|mockup|component|badge|tag|chip|toggle|switch|checkbox|radio|dropdown|search bar|icon|avatar|logo|illustration|calendar|map|feed|timeline|kpi|metric|stat|table of contents|empty state|error state|toast|tooltip)\b/i;

/**
 * True when the prompt reads as an EDIT of existing content with no
 * concrete creation object — i.e. an anaphora ("make it blue", "change
 * that") that, on an empty canvas, has nothing to resolve to.
 *
 * Examples (true):
 *   "make it blue and bigger"      — verb + bare pronoun
 *   "make it pop"                  — evaluative anaphora
 *   "change the color to red"      — definite canvas-relative reference
 *   "update them"                  — verb + pronoun
 *   "make this bigger"             — pronoun + comparative
 *
 * Examples (false):
 *   "make me a login page"         — concrete artifact ("login page")
 *   "make this landing page dark"  — concrete artifact ("landing page")
 *   "create a dashboard"           — concrete artifact
 *   "what makes a good login?"     — question, no edit verb + pronoun pair
 *   "build a pricing page"         — concrete artifact
 */
export function looksLikeEditReference(prompt: string): boolean {
  const t = prompt.trim();
  if (!t) return false;
  const lower = t.toLowerCase();

  // Pronoun object must be the OBJECT of an edit verb (or a standalone
  // comparative anaphora) — "make it blue" yes, "a page that makes it pop"…
  // still fine to treat as creation because CONCRETE_ARTIFACT catches it.
  const verbThenPronoun = new RegExp(
    `${EDIT_VERB.source}\\s+(?:.*?)?\\s*${PRONOUN_OBJECT.source}`,
    'i',
  );
  const anaphora =
    COMPARATIVE_ANAPHORA.test(lower) ||
    (EDIT_VERB.test(lower) && PRONOUN_OBJECT.test(lower) && verbThenPronoun.test(lower)) ||
    // "make the color red" style definite references with an edit verb
    (EDIT_VERB.test(lower) && /\bthe\s+(?:selection|selected|color|colour|text|font|background)\b/i.test(lower));

  if (!anaphora) return false;

  // Creation counter-signal: a concrete artifact noun means the model
  // should build (or ask about) that artifact — not the empty-canvas guard.
  return !CONCRETE_ARTIFACT.test(lower);
}

// ---- Staged-flow detection (spec §3.1) --------------------------------------
//
// The staged lo-fi → approval → hi-fi flow is offered when the user's first
// prompt on an empty canvas is a screen-scale creation request ("build me a
// SaaS dashboard", "a login screen for the vaultly app"). The detection is
// PURE (no LLM round-trip) and co-located here with the other prompt-intent
// heuristics. Task 9 wires the predicate into the runner; this module only
// decides WHETHER to offer the flow.
//
// Fire conditions (ALL must be true):
//   1. mode === 'build'
//   2. repeatCount < 2 (default 0)
//   3. canvasEmpty === true OR explicit new-screen intent (≥2 screen-scale
//      words — "add a new dashboard screen" has "dashboard" + "screen")
//   4. NOT an edit reference (looksLikeEditReference === false)
//   5. NOT an opt-out prompt (opt-out regex doesn't match)
//   6. variantDispatchPlanned === false (mutual exclusion with variant path)
//   7. Screen-scale: a SCREEN_SCALE word matches AND either the word is
//      inherently a full-screen concept (dashboard, page, screen, …) or
//      there's an IA-structure signal (sidebar, chart, hero, grid, …)
//   8. NOT a multitask prompt (detectMultitaskPrompt(prompt).heuristic)

/** Screen-scale vocabulary — words that name a full screen or page. */
const SCREEN_SCALE =
  /\b(?:dashboard|landing|screen|page|home|settings|profile|onboarding|checkout|login|sign-?in|inbox|pricing)\b/i;

/**
 * Inherently full-screen concepts — the word itself denotes a complete screen,
 * so a single match is sufficient (no IA-structure signal needed). "pricing"
 * is deliberately excluded: "a pricing card" is a component, not a screen.
 */
const INHERENTLY_SCREEN_SCALE =
  /\b(?:dashboard|landing|screen|page|home|settings|profile|onboarding|checkout|login|sign-?in|inbox)\b/i;

/** IA-structure words — signal that the prompt describes a multi-section layout. */
const IA_WORD =
  /\b(?:sidebar|topbar|nav|table|chart|hero|grid|cards)\b/i;

/** Opt-out: the user explicitly asked to skip the staged flow. */
const OPT_OUT =
  /\b(?:don'?t ask|no questions|directly|straight to (?:hi-?fi|design)|just build|skip the wireframe)\b/i;

/**
 * True when the prompt's screen-scale match is backed by enough structural
 * signal to be a full screen rather than a small component. Inherently
 * full-screen words (dashboard, page, screen, …) pass unconditionally;
 * section-scale words (pricing) require an IA-structure word.
 */
function isScreenScalePrompt(prompt: string): boolean {
  if (!SCREEN_SCALE.test(prompt)) return false;
  if (INHERENTLY_SCREEN_SCALE.test(prompt)) return true;
  return IA_WORD.test(prompt);
}

/**
 * True when a non-empty-canvas prompt explicitly asks for a NEW screen
 * (≥2 distinct screen-scale vocabulary words — e.g. "add a new dashboard
 * screen" has "dashboard" + "screen"). A single screen-scale word on a
 * non-empty canvas is ambiguous (could be editing the existing screen).
 */
function hasExplicitNewScreenIntent(prompt: string): boolean {
  const matches = prompt.match(new RegExp(SCREEN_SCALE.source, 'gi'));
  if (!matches) return false;
  const distinct = new Set(matches.map((m) => m.toLowerCase()));
  return distinct.size >= 2;
}

export interface StagedFlowInput {
  prompt: string;
  canvasEmpty: boolean;
  mode: AgentMode;
  repeatCount?: number;
  variantDispatchPlanned: boolean;
}

/**
 * Pure predicate: should the runner offer the staged lo-fi → approval → hi-fi
 * flow for this prompt? See the fire-conditions list above.
 */
export function shouldOfferStagedFlow(input: StagedFlowInput): boolean {
  const { prompt, canvasEmpty, mode, variantDispatchPlanned } = input;
  const repeatCount = input.repeatCount ?? 0;
  const t = prompt.trim();
  if (!t) return false;

  // 1. Build mode only
  if (mode !== 'build') return false;

  // 2. Repeat-prompt guard (immediate-repeat exception)
  if (repeatCount >= 2) return false;

  // 3. Canvas-empty OR explicit new-screen intent
  if (!canvasEmpty && !hasExplicitNewScreenIntent(t)) return false;

  // 4. Not an edit reference (anaphora with no concrete artifact)
  if (looksLikeEditReference(t)) return false;

  // 5. Not an opt-out prompt
  if (OPT_OUT.test(t)) return false;

  // 6. Mutual exclusion with variant exploration
  if (variantDispatchPlanned) return false;

  // 7. Screen-scale check
  if (!isScreenScalePrompt(t)) return false;

  // 8. Not a multitask prompt (the parallel path handles multi-screen)
  if (detectMultitaskPrompt(t).heuristic) return false;

  return true;
}
