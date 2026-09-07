// prompt-intent.ts — Poor-prompt hardening: edit-reference detection.
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
