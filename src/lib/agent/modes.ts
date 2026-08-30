// modes.ts — Cursor-style agent modes (Build / Ask / Plan) for AgentCanvas.
//
// RESEARCH BASIS (download/research-modes/cursor-modes-research.md, §4):
//   - Cursor ships Agent / Ask / Plan (+ Debug) in ONE composer; a mode is
//     "what the AI is allowed to do", NOT a model tier (Amp counter-pattern:
//     keep model choice a separate dropdown).
//   - Mode restrictions MUST live in the tool registry, not the prompt —
//     Cursor's own forum documents plan-mode violations under prompt-only
//     enforcement (raw/p12-forum-plan-mode-violation), and our audit's
//     alias-bypass lesson (audit 2-b T2) says the same.
//   - Claude Code's permission modes are the approval-flow reference; the
//     plan → build handoff is ExitPlanMode-style (agent submits a plan
//     artifact, the user approves, execution switches toolsets).
//
// ENFORCEMENT MODEL:
//   build → the full category-filtered toolset (existing behavior).
//   ask   → READ-ONLY tools only (canvas reads, catalog reads, exports,
//           audit/critique sub-agents) + the interaction plugins
//           (ask_user_question, todo, memory READS). Mutating tools are
//           physically excluded from the LLM's tool list.
//   plan  → the ask set + `submit_plan` (the only "write" — a plan artifact).
//           The runner opens an approval gate; on "Build it" the run swaps to
//           a build-toolset session carrying the approved plan.
//
// This module is PURE (no runner imports) so it is unit-testable and usable
// from both the runner (server) and the settings store / AgentPanel (client).

import { PARALLEL_SAFE_TOOL_NAMES } from './tool-execution-mode';

/// LLM-calls the full plan-then-execute path saves vs. a blind build turn
/// (research §4.7: "Plan Mode saves tokens by avoiding generation
/// round-trips" — Bolt's rationale). Lives HERE (not plan-tools.ts) so this
/// module stays import-pure; plan-tools re-exports it for its tests.
export const PLAN_MODE_SAVED_LLM_CALLS_ESTIMATE = 4;

/// The agent mode union. 'build' is the default and preserves all pre-mode
/// behavior byte-for-byte when absent (old settings blobs, legacy callers,
/// tests that don't pass settings).
export type AgentMode = 'build' | 'ask' | 'plan';

export const AGENT_MODES: readonly AgentMode[] = ['build', 'ask', 'plan'] as const;

/// Coerce an arbitrary value (request body field, localStorage blob) to a
/// valid AgentMode. Unknown/absent → 'build' (the pre-mode behavior).
export function normalizeAgentMode(value: unknown): AgentMode {
  return value === 'ask' || value === 'plan' || value === 'build' ? value : 'build';
}

// ---- Per-mode tool allowlists ------------------------------------------------
//
// The runner intersects these with the category-filtered toolset at the
// single registry choke point (runner-native tool assembly). Ask/Plan can
// therefore NEVER see a mutating tool — even if the intent classifier routes
// the prompt to the 'wireframe' category (whose allowlist is full of
// creators).

/// Read-only + interaction tools available in ASK mode.
/// - Canvas/catalog reads + exports + audit sub-agents: PARALLEL_SAFE_TOOL_NAMES
///   (verified non-mutating — see tool-execution-mode.ts).
/// - ask_user_question: asking IS the primary action in Ask mode.
/// - todo tools: planning aid, document-scoped, no canvas writes.
/// - memory reads: recall user preferences while answering.
export const ASK_MODE_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...PARALLEL_SAFE_TOOL_NAMES,
  'ask_user_question',
  'todo_create',
  'todo_update',
  'todo_add',
  'todo_remove',
  'todo_list',
  'memory_read',
  'memory_search',
  'scratchpad',
]);

/// PLAN mode = the ask set + the plan-submission tool (Claude Code
/// ExitPlanMode pattern: the plan artifact is the only thing the agent
/// "writes"). Web research stays available at the runner level (dispatched
/// pre-loop, not a tool).
export const PLAN_MODE_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...ASK_MODE_TOOL_NAMES,
  'submit_plan',
]);

/// The mode's allowlist (undefined = no mode filter → full toolset).
export function modeToolAllowlist(mode: AgentMode): ReadonlySet<string> | undefined {
  if (mode === 'ask') return ASK_MODE_TOOL_NAMES;
  if (mode === 'plan') return PLAN_MODE_TOOL_NAMES;
  return undefined;
}

// ---- Mode prompt sections (per-turn, rides the FIRST USER MESSAGE) ----------
//
// Kept OUT of the system prompt on purpose: the system prompt is the
// byte-stable cacheable prefix (audit 1 P4/P6) — mode is per-turn data.
// The section is authoritative even though the (static) system prompt still
// describes a canvas-designing agent: it names the mode's contract, what the
// toolset already enforces, and what to do instead of mutating.

export function modeSectionFor(mode: AgentMode): string {
  if (mode === 'ask') {
    return (
      '\n\n[MODE: ASK — read-only. You are answering a question about this canvas/design, not building. ' +
      'Your toolset is READ-ONLY (canvas reads, search, exports, audits) — there are NO creation or mutation tools available, ' +
      'so do not attempt to create, edit, move, restyle, or delete anything. Inspect the canvas with the read tools as needed, ' +
      'then answer directly and concisely in text. If the user wants a change made, describe exactly WHAT you would change ' +
      '(and how) and tell them to switch to Build mode (the /build command or the mode picker next to the input).]'
    );
  }
  if (mode === 'plan') {
    return (
      '\n\n[MODE: PLAN — research and propose, do not build. Your toolset is READ-ONLY (canvas reads, search, audits) plus ' +
      'ask_user_question and submit_plan. There are NO creation or mutation tools available. Workflow: ' +
      '(1) inspect the current canvas with the read tools so the plan fits what already exists; ' +
      '(2) if the request is genuinely ambiguous in a way that changes the plan, ask ONE round of clarifying questions via ' +
      'ask_user_question (do not interrogate — default to sensible, stated assumptions); ' +
      '(3) produce a complete, concrete, step-by-step plan — each step names WHAT will be built (screens, sections, components), ' +
      'the placement on the canvas, and the design decisions (palette, typography, component structure); ' +
      '(4) call submit_plan with that plan. The user will review it: on approval the run switches to Build mode and executes ' +
      'the plan verbatim; on feedback you revise the plan and call submit_plan again. Do NOT answer with a plan in plain text — ' +
      'the plan MUST go through submit_plan so the user gets the approval card.]'
    );
  }
  return '';
}

// ---- Adaptive critique gate (research §4.4 — replaces always-on critique) ---
//
// The pre-mode runner dispatched text+VLM critics on EVERY design turn with
// ≥1 new shape (audit 2-c S3: +5-6 LLM calls/turn; stress test: 2.5-13.5
// min/turn). Evidence-based gating replaces the always-on cadence:
//
//   Gate 0 — deterministic validation (validators.ts) runs EVERY build turn:
//            free, and its violation count feeds the critic gate below.
//   Gate 1 — LLM critics (text + VLM + fix-turn) run only when the turn is
//            BIG (≥ CRITIC_NODE_THRESHOLD new nodes), a substantial fresh
//            document (≥ FRESH_DOC_THRESHOLD nodes on an empty canvas), the
//            deterministic gate found ≥ VIOLATION_THRESHOLD problems, or the
//            user asked for critique/polish in the prompt (incl. /critique).
//            Small/medium clean turns get validator-only repair — same
//            quality floor, 2-5 fewer LLM calls per turn.
//
// Tune for recall over precision (Replit: "false positives are cheap" — a
// redundant critique costs a call; a missed disaster ships).
export const CRITIC_NODE_THRESHOLD = 20;
export const FRESH_DOC_NODE_THRESHOLD = 12;
export const CRITIC_VIOLATION_THRESHOLD = 3;

export interface CriticGateInput {
  /// New shapes created THIS turn (turn deliverable — prior screens excluded).
  newShapeCount: number;
  /// Deterministic validator reasons found on the new shapes (Gate 0).
  validationReasonCount: number;
  /// True when the canvas was EMPTY at turn start (fresh document creation).
  freshDocument: boolean;
  /// True when the prompt itself asks for critique/polish (incl. /critique).
  promptWantsCritique: boolean;
}

export interface CriticGateDecision {
  /// Run the text + VLM critics (Gate 1)?
  runCritics: boolean;
  /// Machine-readable skip reason for the UI ("saved N LLM calls" row).
  skipReason?: 'small_clean_turn' | 'small_turn_validators_only';
}

/// LLM-calls the full critic path costs (text critic + VLM critic + one
/// fix-turn re-prompt) — surfaced in the skip notice so users see what the
/// gating saved (research §4.7 "show cost intent").
export const CRITIC_PATH_ESTIMATED_LLM_CALLS = 3;

export function shouldRunCritics(input: CriticGateInput): CriticGateDecision {
  if (
    input.promptWantsCritique ||
    input.newShapeCount >= CRITIC_NODE_THRESHOLD ||
    input.validationReasonCount >= CRITIC_VIOLATION_THRESHOLD ||
    (input.freshDocument && input.newShapeCount >= FRESH_DOC_NODE_THRESHOLD)
  ) {
    return { runCritics: true };
  }
  return {
    runCritics: false,
    skipReason: input.validationReasonCount > 0
      ? 'small_turn_validators_only'
      : 'small_clean_turn',
  };
}

/// Does the prompt itself request critique/polish? (Gate 1 user-trigger arm —
/// /critique, "make it beautiful", "polish this", "audit", "review".)
export function promptRequestsCritique(prompt: string): boolean {
  return /\b(critiqu|review|polish|audit|refine|make it beautiful|beautiful)\w*/i.test(prompt);
}

// ---- Multitask detection (Cursor /multitask adaptation) ----------------------
//
// Explicit: the /multitask prefix (always routes to the parallel executor).
// Heuristic (build mode only, conservative): the prompt names a COUNT of
// screens/pages/views, or lists multiple well-known screen types. The
// parallel executor decomposes + builds each screen concurrently in its own
/// canvas region (region-scoped isolation — the collision answer Cursor's
// v0 /multitask shipped without).

export interface MultitaskDetection {
  explicit: boolean;
  heuristic: boolean;
  /// The prompt with the /multitask prefix stripped (verbatim otherwise).
  effectivePrompt: string;
}

export function detectMultitaskPrompt(prompt: string): MultitaskDetection {
  const trimmed = prompt.trim();
  const explicit = /^\/multitask\b/i.test(trimmed);
  const effectivePrompt = explicit
    ? trimmed.replace(/^\/multitask\b/i, '').trim()
    : trimmed;
  if (explicit) return { explicit: true, heuristic: true, effectivePrompt };

  const t = effectivePrompt.toLowerCase();
  const countWord =
    /\b(\d+|two|three|four|five|six|seven)\s+[-\s]?(screens?|pages?|views?|flows?)\b/.test(t) ||
    /\bmulti[-\s]?screen\b/.test(t);
  const screenList =
    /\b(login|log[-\s]?in|sign[-\s]?up|dashboard|settings|profile|checkout|onboarding|landing|pricing|inbox|home|search|detail)\b[^.?!]{0,80}\b(and|,|\+|then|plus)\b[^.?!]{0,80}\b(login|log[-\s]?in|sign[-\s]?up|dashboard|settings|profile|checkout|onboarding|landing|pricing|inbox|home|search|detail|screen|page)s?\b/.test(
      t,
    );
  return { explicit: false, heuristic: countWord || screenList, effectivePrompt };
}

// ---- UI metadata (labels/descriptions for the mode picker) -------------------

export interface AgentModeMetadata {
  label: string;
  /// One-line description shown in the mode dropdown.
  description: string;
  /// Hint shown while the mode is active (title attr on the pill).
  hint: string;
}

export const MODE_METADATA: Record<AgentMode, AgentModeMetadata> = {
  build: {
    label: 'Build',
    description: 'Design and edit the canvas (default)',
    hint: 'Build mode — the agent designs and edits the canvas with the full toolset.',
  },
  ask: {
    label: 'Ask',
    description: 'Read-only questions about the canvas',
    hint: 'Ask mode — read-only. The agent answers questions about the canvas; nothing can be created or modified.',
  },
  plan: {
    label: 'Plan',
    description: 'Propose a plan first, approve, then build',
    hint:
      `Plan mode — the agent researches and proposes a step-by-step plan for your approval before building. ` +
      `Avoids wasted generation round-trips (typically saves ~${PLAN_MODE_SAVED_LLM_CALLS_ESTIMATE} LLM calls vs. blind building).`,
  },
};
