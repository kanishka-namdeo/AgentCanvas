// Agent runner — NATIVE implementation using `createAgentSession` from
// `@earendil-works/pi-coding-agent`.
//
// This is the production path. It replaces the legacy hand-rolled LLM loop
// with the SDK's native agent session, while:
//
//   - Reusing the same tool catalog (defineTool ToolDefinitions).
//   - Reusing the same SYSTEM_PROMPT_TEMPLATE + skill/classifier/planner.
//   - Reusing the same web-research + design-critic subagents (now provider-aware).
//   - Emitting the same SyncEvent shapes the React UI and Socket.IO service
//     already consume (via `agent-session-translator.ts`).
//
// When `injectedLlm` is passed (test mode), the public `runAgent` in
// `runner.ts` delegates to `runAgentLegacy` in `runner-legacy.ts` instead —
// because tests pass a MockLLM that implements the OpenAI-shaped `LLMClient`
// interface, which can't be wrapped as a pi-ai `Model` object.
//
// ---- High-level flow ------------------------------------------------------
//
// 1. Normalize canvas + build CanvasToolContext + create 88 tools (unchanged).
// 2. Resolve pi-ai Model + ModelRuntime from user settings (z.ai sandbox
//    auto-credentials supported).
// 3. Build provider-aware LLMClient for the sub-agents (separate from the
//    main agent's pi-ai Model — sub-agents still use their OpenAI-shaped loop).
// 4. Classify intent (unchanged) → pick active skill → filter tools.
// 5. Optionally generate a plan (unchanged).
// 6. Optionally dispatch web-research sub-agent (now passes the LLM client).
// 7. Build the system prompt (unchanged) — used as the resourceLoader's
//    `getSystemPrompt()` return value.
// 8. Construct a stub ResourceLoader (no extensions, no skills dir, custom
//    system prompt) so createAgentSession doesn't pull in external resources.
// 9. Create the AgentSession with:
//      - model + modelRuntime
//      - customTools: our 88 tools (filtered to the active skill's allowlist)
//      - noTools: 'all' + tools: [filtered names]  → disable built-ins
//      - resourceLoader (stub)
//      - sessionManager: in-memory
//      - thinkingLevel from settings
// 10. Subscribe to AgentSessionEvents via `subscribeAndTranslate()` which
//     yields AgentStreamEvents onto an async queue.
// 11. Call `session.prompt(userMessage)` and await completion.
// 12. Drain any remaining events from the queue.
// 13. Dispose the session.
//
// The result is that the rest of the app (UI, Socket.IO, session store)
// sees the exact same AgentStreamEvent stream as before — but the loop
// underneath is now the native Pi Agent SDK, with all the benefits that
// brings (proper compaction, sub-session spawning, retry, telemetry, etc.).

import {
  createAgentSession,
  createExtensionRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { createCanvasTools, type CanvasToolContext } from './tools';
import { createPenTools, PEN_TOOL_NAMES, PEN_TOOL_LEGACY_NAMES } from './pen-tools';
import { createFigmaTools, FIGMA_TOOL_NAMES, FIGMA_TOOL_LEGACY_NAMES } from './figma-tools';
import { applyToolAliases, TOOL_ALIASES } from './tool-aliases';
import { applyExecutionModes } from './tool-execution-mode';
import type { CanvasDocument, CanvasPatch } from '../canvas/types';
import type { AgentRunSettings } from '../settings/types';
import { normalizeLLMProvider, DEFAULT_SETTINGS } from '../settings/types';
import { applyPatchToCanvas } from '../canvas/patch';
import { wrapToolsWithPriorContentGuard } from './prior-content-guard';
import { classifyIntent } from './classifier';
import { generatePlan, formatPlanForPrompt } from './planner';
import { dispatchWebResearchSubAgent } from './subagents/web-research';
import {
  getToolNamesForCategory,
  formatSkillMetadataForPrompt,
  formatSkillBodyForPrompt,
  type SkillCategory,
  type ClassificationResult,
  type Plan,
} from './skills';
import { resolveModel, resolveZaiSandboxFallback } from './pi-ai-model-resolver';
import { subscribeAndTranslate, createEventQueue } from './agent-session-translator';
import { registerActiveSession } from './active-sessions';
import { dataUrlToImageContent } from './attachments';
import { classifyAgentError, agentErrorMessage } from '../agent-error';
import type { AgentStreamEvent, AgentRunOptions } from './runner-types';
import {
  normalizeCanvas,
  buildSystemPrompt,
  buildSubAgentLLMClient,
  canvasSnapshot,
  canvasSnapshotDelta,
  PROMPT_VERSION,
} from './runner-legacy';
// Plugin integration.
import {
  getEnabledPluginTools,
  getEnabledPluginToolNames,
} from './plugins';
import { setEventSink } from './plugins/event-bus';
import {
  DESTRUCTIVE_TOOLS,
  buildApprovalRequest,
  requestApproval,
  deniedToolResult,
  seedAlwaysAllow,
} from './plugins/approval-gate';
import { setActiveSession as setTodoActiveSession } from './plugins/todo';
import { setActiveSession as setGoalActiveSession } from './plugins/goal-list-loop-audit';
import { setActiveSession as setBackgroundTaskActiveSession } from './plugins/background-tasks';
import { setActiveLLM as setSubagentActiveLLM, setActiveCanvas as setSubagentActiveCanvas } from './plugins/subagents';
import { getMemoryContextForPrompt } from './plugins/memory';
import { getJournalEvents } from './event-journal';

// ---- Cross-turn conversation history (audit 1 P3) ---------------------------
//
// Replay the last few journaled user/assistant text pairs into the first user
// message. The journal rows carry the full SyncEvent payloads; we keep only
// the text, newest-last, capped per message and in total so a long chat can't
// balloon the prompt. Exported for unit testing.
const HISTORY_MAX_TURNS = 6;
const HISTORY_PER_MSG_CAP = 1200;
const HISTORY_TOTAL_CAP = 6000;

export async function buildConversationHistory(documentId: string): Promise<string> {
  if (!documentId) return '';
  let rows: Array<{ type: string; payload: any }> = [];
  try {
    rows = await getJournalEvents(documentId, 0, 400);
  } catch {
    return '';
  }
  const pairs: Array<{ user: string; assistant: string }> = [];
  let pendingUser: string | null = null;
  for (const row of rows) {
    if (row.type === 'agent:user_message') {
      const text = typeof row.payload?.text === 'string' ? row.payload.text : '';
      if (text.trim()) {
        if (pendingUser !== null) pairs.push({ user: pendingUser, assistant: '' });
        pendingUser = text;
      }
    } else if (row.type === 'agent:turn_final' && pendingUser !== null) {
      const text = typeof row.payload?.text === 'string' ? row.payload.text : '';
      pairs.push({ user: pendingUser, assistant: text });
      pendingUser = null;
    }
  }
  if (pendingUser !== null) pairs.push({ user: pendingUser, assistant: '' });
  if (pairs.length === 0) return '';
  // Drop the LAST pair when its user message is the CURRENT prompt (the
  // journal row for this turn is written at run start, before the runner
  // reads history — replaying it verbatim would duplicate the prompt).
  const currentPromptRow = rows.filter((r) => r.type === 'agent:user_message').pop();
  const lastPair = pairs[pairs.length - 1];
  if (currentPromptRow && lastPair && lastPair.user === currentPromptRow.payload?.text && !lastPair.assistant) {
    pairs.pop();
  }
  if (pairs.length === 0) return '';
  const recent = pairs.slice(-HISTORY_MAX_TURNS);
  const clip = (s: string): string => {
    const t = s.replace(/\s+/g, ' ').trim();
    return t.length > HISTORY_PER_MSG_CAP ? `${t.slice(0, HISTORY_PER_MSG_CAP)}…` : t;
  };
  const lines: string[] = [];
  let total = 0;
  for (const p of recent) {
    const turn = `user: ${clip(p.user)}${p.assistant ? `\nassistant: ${clip(p.assistant)}` : ''}`;
    if (total + turn.length > HISTORY_TOTAL_CAP && lines.length > 0) break;
    lines.push(turn);
    total += turn.length;
  }
  if (lines.length === 0) return '';
  return `\n\n[CONVERSATION HISTORY — earlier turns on this canvas, most recent last. For context; the canvas snapshot below reflects the CURRENT state, so trust it over any geometry described in history:]\n${lines.join('\n---\n')}`;
}

// ---- Build the in-memory resource loader ----------------------------------
//
// We don't want pi-coding-agent to discover `~/.pi/agent/extensions/`,
// `.pi/skills/`, prompt templates, etc. — AgentCanvas has its own skill
// system and its own system prompt. The stub loader below returns empty
// results for every resource type, and returns our pre-built system
// prompt from `getSystemPrompt()`.
//
// This matches the "Full Control" pattern from
// `node_modules/@earendil-works/pi-coding-agent/examples/sdk/12-full-control.ts`.

function buildResourceLoader(systemPrompt: string): ResourceLoader {
  return {
    // Use `createExtensionRuntime()` to build a proper empty runtime —
    // the SDK's `bindCore()` accesses `runtime.pendingProviderRegistrations`
    // during session creation, so a stub `{ dispose() {} }` would crash.
    // `createExtensionRuntime()` returns a real ExtensionRunner with all
    // required internal fields initialized to empty arrays/maps.
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

// ---- Map settings.thinkingLevel (our enum) → pi-agent ThinkingLevel -------
//
// Our settings use: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
// pi-agent uses:    'off' | 'minimal' | 'low'  | 'medium' | 'high' | 'xhigh' | 'max'
// They match exactly. This function is a passthrough that exists so future
// divergence is one edit away.

function mapThinkingLevel(level: AgentRunSettings['thinkingLevel']): ThinkingLevel {
  return level as ThinkingLevel;
}

// ---- The native runner -----------------------------------------------------

export async function* runAgentNative(opts: AgentRunOptions): AsyncGenerator<AgentStreamEvent> {
  const { documentId, prompt, canvas: initialCanvas, signal, settings } = opts;

  // Resolve settings with defaults (mirror the legacy runner).
  const temperature = settings?.temperature ?? 0.4;
  const maxIterations = settings?.maxIterations ?? 20;
  const planFirst = settings?.planFirst ?? true;
  const thinkingLevel = settings?.thinkingLevel ?? 'medium';
  const defaultPalette = settings?.defaultPalette ?? 'slate';
  const skillSelectionMode = settings?.skillSelectionMode ?? 'auto';
  // Approval gate mode (Cursor/Cline human-in-the-loop pattern for
  // destructive ops). Default 'destructive' — matches DEFAULT_SETTINGS.
  //   - 'destructive': gate each clear/delete tool with an Allow/Deny dialog.
  //   - 'review':      no per-call gating; the agent runs freely, but the
  //                    diff card surfaces a "Restore from before this turn"
  //                    action for any turn that touched destructive tools
  //                    (post-hoc batch review).
  //   - 'off':         no gating AND no review affordance (autonomous).
  const approvalMode = settings?.approvalMode ?? 'destructive';
  // Seed the gate's in-memory always-allow set from the user's persisted
  // settings. Tools added during this run (via the approval dialog's
  // "Always allow" checkbox) persist in the set for the lifetime of this
  // server process AND in localStorage (so the next run re-seeds them).
  seedAlwaysAllow(settings?.alwaysAllowTools);

  // 1. Normalize canvas + build tool context (identical to legacy runner).
  let canvas: CanvasDocument = normalizeCanvas(initialCanvas);

  // Multi-screen prior-content bookkeeping (stress-test fix): the shapes that
  // exist at TURN START are the user's prior deliverables (screens from
  // earlier prompts). The critique loop must scope itself to the NEW shapes,
  // and the prior-content tool guard must refuse to delete prior shapes during
  // critique fix-turns — otherwise the critic can flag the login screen as a
  // "defect" and the fix-turn "fixes" it by deleting the user's work.
  const turnStartShapeIds = new Set((canvas.shapes ?? []).map((s) => s.id));
  const turnStartShapeNames = new Map(
    (canvas.shapes ?? []).map((s) => [s.id, s.name ?? s.id] as const),
  );
  // Per-run state (persists across attempt loop + critique loop). Declared
  // early — the prior-content tool guard (built below) closes over
  // inCritiqueReprrompt, so it must be initialized before any tool executes.
  let hasGeneratedBrief = false;
  let inCritiqueReprrompt = false;

  const ctx: CanvasToolContext = {
    getShapes: () => canvas.shapes ?? [],
    getTokens: () => canvas.tokens ?? { colors: [], textStyles: [] },
    getDocument: () => canvas,
    applyPatch(patch: CanvasPatch): CanvasPatch {
      canvas = applyPatchToCanvas(canvas, patch);
      return patch;
    },
  };

  // 2. Create the full tool set. These are already `ToolDefinition[]` (defined
  //    via `defineTool` from `@earendil-works/pi-coding-agent`), so they
  //    can be passed straight to `createAgentSession({ customTools })`.
  const canvasTools = wrapToolsWithPriorContentGuard(createCanvasTools(ctx) as unknown as ToolDefinition[], {
    getProtectedShapeIds: () => turnStartShapeIds,
    getProtectedShapeNames: () => turnStartShapeNames,
    isGuardActive: () => inCritiqueReprrompt,
  }) as unknown as ReturnType<typeof createCanvasTools>;
  const penTools = createPenTools(ctx);
  const figmaTools = createFigmaTools(ctx);
  // Plugin tools (ask_user_question, todo, memory, mega-compact,
  // goal-list-loop-audit, mcp-adapter, background-tasks, subagents).
  // These are added to the customTools array alongside the canvas tools
  // and always-available (not subject to skill filtering).
  const pluginTools = getEnabledPluginTools(settings);
  // Spec Phase 6 part 2 (§9.3 #4): applyToolAliases (a) wraps every canonical
  // tool's execute with normalizeToolParams (legacy param spellings never
  // reach execute bodies) and (b) appends legacy-name alias entries so the
  // SDK can dispatch deprecated spellings — each alias executes its TARGET
  // and appends the one-line deprecation notice to the result text.
  const allTools: ToolDefinition[] = applyToolAliases([
    ...canvasTools,
    ...penTools,
    ...figmaTools,
    ...pluginTools,
  ] as unknown as ToolDefinition[]);
  const pluginToolNames = getEnabledPluginToolNames(settings);

  // 3. Build a provider-aware LLM client for the sub-agents (web-research,
  //    design-critic). The main agent uses pi-ai's Model below — but the
  //    sub-agents still use the OpenAI-shaped LLMClient loop via
  //    callLLMWithRetry. Construct it here so we can pass it down.
  let subAgentLLM: Awaited<ReturnType<typeof buildSubAgentLLMClient>> | undefined;
  try {
    subAgentLLM = await buildSubAgentLLMClient(settings);
  } catch (err) {
    // If the sub-agent LLM can't be built (e.g. no API key for a non-zai
    // provider), we still let the main agent proceed — the sub-agent will
    // fall back to its own ZAI.create() if params.llm is undefined.
    subAgentLLM = undefined;
  }

  yield { kind: 'agent_event', event: { type: 'agent:message_start', role: 'assistant' } };

  // 4. Classify intent (identical to legacy runner).
  let classification: ClassificationResult;
  if (skillSelectionMode === 'manual') {
    classification = {
      category: 'multi',
      secondaryCategories: [],
      method: 'manual',
      confidence: 1,
      recommendPlan: false,
    };
  } else {
    try {
      classification = await classifyIntent({
        prompt,
        canvasShapeCount: canvas.shapes.length,
        // Audit 2-c S9: wire the LLM fallback via the provider-aware
        // sub-agent client (it's OpenAI-shaped — exactly what classifyIntent
        // wants). Previously `llm: undefined` meant keyword-regex-only routing
        // in production; the fallback code existed but could never run.
        llm: subAgentLLM as any,
        signal,
      });
    } catch {
      classification = {
        category: 'multi',
        secondaryCategories: [],
        method: 'fallback',
        confidence: 0,
        recommendPlan: false,
      };
    }
    // The keyword pass runs first inside classifyIntent; the LLM fallback
    // above only fires when keyword confidence is below threshold. If both
    // fail, the 'multi' fallback exposes all tools.
  }

  const activeCategory: SkillCategory = classification.category;

  // 5. Filter the tool set to the active skill (plus, where they're actually
  //    used, the .pen-file + Figma-ontology tools + all plugin tools).
  //    Plugin tools are always available regardless of the active skill —
  //    they're cross-cutting (ask_user_question, todo, memory, etc.) and the
  //    agent should be able to use them in any context.
  //
  //    Audit 2-b T3: the .pen-file tools (PEN_TOOL_NAMES) and the Figma
  //    page/component tools (FIGMA_TOOL_NAMES) used to ride along on EVERY
  //    turn, pushing even the narrowest skill to 45-80 visible tools. They
  //    now ride along only when a structural category (wireframe / multi) is
  //    in play — the other skills' explicit allowlists already name the
  //    variable/token/component tools they need individually.
  //
  //    Audit 2-c S9: secondary categories now widen the tool set too — a
  //    prompt like "align these cards then make them blue" (layout+styling)
  //    gets BOTH skills' ergonomic tools instead of doing styling work
  //    through generic pen_update_node calls.
  const structuralCategories = new Set<SkillCategory>([...classification.secondaryCategories, activeCategory]);
  const includePenFileTools = structuralCategories.has('wireframe') || activeCategory === 'multi';
  const allowedToolNames = new Set<string>([
    ...getToolNamesForCategory(activeCategory),
    ...classification.secondaryCategories.flatMap((c: SkillCategory) => getToolNamesForCategory(c)),
    ...(includePenFileTools ? [...PEN_TOOL_NAMES, ...FIGMA_TOOL_NAMES] : []),
    ...pluginToolNames,
  ]);
  // Legacy ALIAS entries no longer ride along (Agent Performance Package
  // change 6): the 26 deprecated-name clones duplicated ~28KB of schema
  // bytes on EVERY LLM call of the turn. Canonical names only — the alias
  // layer's normalizeToolParams wrapping still protects execution, and a
  // model that hallucinates a deprecated name gets a standard unknown-tool
  // error it self-corrects from (the deprecation window has been open for
  // many sessions; new contexts never teach the old spellings).
  const aliasNames = new Set(Object.keys(TOOL_ALIASES));
  const filteredTools = allTools.filter((t) =>
    allowedToolNames.has(t.name) && !aliasNames.has(t.name));

  // ---- Task 7-e Fix 2 — Architectural enforcement: pen_generate_design_brief
  //      MUST be the first tool call for design requests.
  //
  // The Task 7-d evaluation proved the system-prompt directive "DESIGN BRIEF
  // MANDATORY FIRST STEP" was bypassed by glm-5.3 (z.ai sandbox fallback
  // model). Prompt-only directives decay; this wrapper enforces the order
  // at the tool-execution layer so the agent CANNOT call pen_generate_wireframe
  // / pen_create_shape / pen_apply_palette / pen_set_variable until
  // pen_generate_design_brief has been called.
  //
  // Skipped for non-design prompts ("what is 2+2", "tell me a joke") via a
  // simple keyword heuristic. Skipped during critique-iteration re-prompts
  // (the agent has already produced a brief; we don't want to force another).
  // Skipped for tests (MockLLM doesn't have the brief scripted) — but the
  // native runner is only invoked when there's no injectedLlm, so this gate
  // is automatic.
  const isDesignRequest = (text: string): boolean => {
    const t = text.toLowerCase();
    return /\b(design|dashboard|landing\s*page|app|ui|build|create|make|draw|scaffold|layout|interface|website|page|screen)\b/.test(t);
  };
  const shouldEnforceBrief = isDesignRequest(prompt);

  // ---- Agent Performance Package change 9: pre-generate the design brief --
  //
  // Previously the brief cost a FULL-CONTEXT main-loop iteration: the model
  // called pen_generate_design_brief as its first tool call, waited for the
  // sub-agent, and only then started drawing — one guaranteed extra round
  // trip (~10s + ~45K tokens of re-sent prefix) on every design turn.
  // Dispatching the SMALL brief sub-agent up front (threaded with the
  // provider-aware subAgentLLM) and injecting its JSON into the first user
  // message deletes that round trip entirely. The tool-layer brief gate
  // below stays as the fallback for when pre-generation fails (endpoint
  // down / parse error / timeout).
  let preGeneratedBrief: string | null = null;
  // ---- Audit 2-c S11: RACE the brief against everything else ----------------
  //
  // The brief sub-agent used to be AWAITED here, before classification,
  // tool filtering and (most expensively) the web-research dispatch — a
  // guaranteed 10-40s of dead wall-clock before the main loop could even
  // start. It's now kicked off WITHOUT awaiting and joined just before the
  // user message is assembled (the first point that actually needs it), so
  // classification, tool-set construction and web research all overlap it.
  let preGeneratedBriefPromise: Promise<string | null> | null = null;
  // ---- Ambiguous-creation detection (multi-variant explorer path) --------
  //
  // "a pricing page" / "a profile card" with no palette, style, or
  // reference pinned: the brief would PRE-DECIDE the palette — exactly the
  // coin-flip pen_generate_variants exists to settle by exploring 2-3
  // directions in parallel and judging the renders. Skip the brief for
  // these turns and nudge the model toward the explorer instead.
  const isAmbiguousCreation = (() => {
    const t = prompt.toLowerCase();
    const creationVerb = /\b(create|make|build|design|draw|generate|add)\b/.test(t);
    const wholeThing = /\b(page|card|screen|panel|dashboard|hero|landing|layout|section|profile|form|chart)\b/.test(t);
    // Pinned-direction signals — ANY of these means NOT ambiguous.
    const pinned = /(dark\s*mode|light\s*theme|palette\s*of|#[0-9a-f]{6}|colou?rs?:|font:|like\s+(stripe|airbnb|linear|vercel|figma|notion)|in\s+the\s+style|minimalist|neubrutalist|glassmorphism|match\s+the|same\s+(style|colou?r|font)|monochrome|neon|pastel)/.test(t);
    // Follow-up EDIT turns reference existing content ("make the cards
    // darker", "add another tier") — not variant-exploration candidates.
    const isEdit = /\b(darker|lighter|bigger|smaller|move|rename|change|update|align|delete|remove|another|more|also|instead)\b/.test(t) && !/\b(create|build|generate)\b/.test(t);
    return creationVerb && wholeThing && !pinned && !isEdit;
  })();

  // ---- Tool-calling reliability: "did this turn OWE tool calls?" -----------
  //
  // A build-style design request ("Design a login screen…") is expected to
  // produce tool calls (brief / variants / shapes). A question ("what would
  // a good login screen look like?") legitimately answers with text only.
  // This predicate gates the mid-stream-death fallback + the text-only
  // silent-failure guard below, so we retry/error exactly the turns that
  // should have drawn — and never harass legit prose answers.
  //
  // Observed live failure this enables recovery for: the pinggy tunnel
  // closed the SSE stream mid-output (turn died at exactly 500 output
  // tokens, right after the model's preamble, with ZERO tool calls). The
  // old guards only handled "zero output at all" (sawActivity=false), so a
  // preamble-then-death turn fell through every safety net and the run
  // hung in in_progress.
  const QUESTIONISH_PROMPT =
    /^(what|who|when|where|why|how|which|can|could|should|would|will|is|are|do|does|did|tell|explain|describe|list|hi|hello|hey|thanks)\b|[?]\s*$/.test(
      prompt.trim(),
    );
  const expectsCanvasOutput = isDesignRequest(prompt) && !QUESTIONISH_PROMPT;

  if (shouldEnforceBrief && !isAmbiguousCreation) {
    preGeneratedBriefPromise = (async () => {
      try {
        const { dispatchDesignBriefSubAgent } = await import('./subagents/design-brief');
        const briefPromise = dispatchDesignBriefSubAgent({
          task: prompt,
          canvas,
          originalPrompt: prompt,
          ...(subAgentLLM ? { llm: subAgentLLM as any } : {}),
        });
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('brief pre-generation timed out')), 40_000));
        const briefResult = await Promise.race([briefPromise, timeoutPromise]);
        if (briefResult?.brief) {
          return JSON.stringify(briefResult.brief, null, 2);
        }
        return null;
      } catch {
        // Pre-generation failed — fall back to the tool-layer brief gate.
        return null;
      }
    })();
  }

  // (The pre-generated brief promise is joined further down — after web
  // research — so the sub-agent overlaps everything before the user message.)

  const BRIEF_TOOL_NAME = 'pen_generate_design_brief';
  // Audit 1 P4: the gate used to miss the tools the prompt actively steers
  // the model toward (pen_create_subtree, pen_insert_html, the generators)
  // while gating a deprecated alias name that is never registered
  // (pen_create_shape). It now covers every mutating construction tool, so
  // the "brief before any design work" contract holds whichever primitive
  // the model reaches for. Recovery is always available: every skill
  // allowlist carries pen_generate_design_brief.
  const GATED_TOOL_NAMES = new Set<string>([
    'pen_generate_wireframe',
    'pen_create_node',
    'pen_create_subtree',
    'pen_insert_html',
    'pen_generate_user_flow',
    'pen_generate_diagram',
    'pen_generate_copy',
    'pen_generate_variants',
    'pen_apply_palette',
    'pen_set_variable',
    'pen_set_variables',
  ]);

  // Ambiguous-creation turns skip the brief gate too — the variant explorer
  // settles the palette; if it fails, pen_create_subtree must be reachable
  // without a brief detour (the fallback message tells the model to use it).
  const enforcementWrappedTools: ToolDefinition[] = shouldEnforceBrief && !isAmbiguousCreation
    ? filteredTools.map((t) => {
        const toolAny = t as any;
        const origExecute = toolAny.execute;
        if (typeof origExecute !== 'function') return t;

        // Wrap pen_generate_design_brief to set hasGeneratedBrief=true after
        // a successful call (so subsequent gated tool calls are allowed).
        if (t.name === BRIEF_TOOL_NAME) {
          const wrapped = {
            ...t,
            execute: async (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => {
              const result = await origExecute(toolCallId, params, signal, onUpdate, ctx);
              hasGeneratedBrief = true;
              return result;
            },
          };
          return wrapped as unknown as ToolDefinition;
        }

        // Wrap gated tools to reject if brief hasn't been generated.
        if (GATED_TOOL_NAMES.has(t.name)) {
          const wrapped = {
            ...t,
            execute: async (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => {
              if (!hasGeneratedBrief && !inCritiqueReprrompt) {
                return {
                  content: [{
                    type: 'text' as const,
                    text: 'ERROR: You must call pen_generate_design_brief FIRST to establish the design brief (color palette, typography scale, information architecture) before any shape-creation tool. Call pen_generate_design_brief now with the user\'s prompt, then proceed.',
                  }],
                  details: { error: 'brief_required_first', toolName: t.name },
                  isError: true as any,
                };
              }
              return origExecute(toolCallId, params, signal, onUpdate, ctx);
            },
          };
          return wrapped as unknown as ToolDefinition;
        }

        return t;
      })
    : filteredTools;

  // ---- Destructive-op approval gate (Cursor "Run command?" / Cline Approve) --
  //
  // Wraps DESTRUCTIVE tools (pen_clear, pen_delete_shape, figma_delete_page,
  // pen_clear_pattern_memory) so that, before they execute, the agent BLOCKS
  // on a human Allow/Deny decision:
  //
  //   1. buildApprovalRequest() renders the tool args into a human
  //      description ("Delete 3 layers: Card, Button, Input") using the
  //      CURRENT canvas shape names.
  //   2. requestApproval() emits `agent:approval_request` through the turn's
  //      event sink (the frontend shows a dialog) and awaits the user's
  //      POST /api/agent/approvals.
  //   3. Approved → the original tool runs. Denied/timed out → an isError
  //      result is returned so the MODEL adapts (no retry, no workaround).
  //
  // Mode behavior:
  //   - 'destructive' (default): wrap each destructive tool with the gate.
  //   - 'review':  do NOT wrap. The agent runs destructive tools freely;
  //     the diff card on the affected turn surfaces a "Restore from before
  //     this turn" action so the user can post-hoc revert the entire batch
  //     (instead of being interrupted per call). Useful when you trust the
  //     agent but want a single bulk-undo affordance per turn.
  //   - 'off': no wrap, no review affordance (autonomous).
  //
  // The wrap composes AFTER the brief-enforcement wrap (both are plain
  // execute() decorators, and their gated tool sets are disjoint).
  const approvalWrappedTools: ToolDefinition[] =
    approvalMode === 'off' || approvalMode === 'review'
      ? enforcementWrappedTools
      : enforcementWrappedTools.map((t) => {
          if (!DESTRUCTIVE_TOOLS.has(t.name)) return t;
          const toolAny = t as any;
          const origExecute = toolAny.execute;
          if (typeof origExecute !== 'function') return t;
          return {
            ...t,
            execute: async (toolCallId: string, params: any, signal: any, onUpdate: any, runCtx: any) => {
              // Shape names from the LIVE canvas (mutates as the turn runs).
              const shapeLookup = canvas.shapes?.map((s) => ({ id: s.id, name: s.name, type: s.type })) ?? [];
              const request = buildApprovalRequest(toolCallId, t.name, params, shapeLookup);
              if (request) {
                const decision = await requestApproval(request);
                if (!decision.approved) {
                  return deniedToolResult(t.name, decision.timedOut);
                }
              }
              return origExecute(toolCallId, params, signal, onUpdate, runCtx);
            },
          } as unknown as ToolDefinition;
        });

  // ---- Agent Performance Package change 3: order-preserving batch execution.
  //
  // pi-agent-core executes ALL tool calls emitted in one assistant message
  // as a single iteration (parallel by default). The system prompt's new
  // PARALLEL TOOL EMISSION rule tells the model to batch independent calls;
  // marking canvas MUTATIONS executionMode:'sequential' guarantees they
  // still apply in emission order (create-then-style etc.), while read-only
  // tools (metadata/search/export/critique sub-agents) stay concurrent.
  //
  // Deterministic registration order (Vercel AI SDK toolOrder pattern): the
  // ~80 tool definitions are sorted alphabetically so the tool-schema bytes
  // sent to the provider are IDENTICAL every turn — provider-side prompt
  // caching keys on stable tool-definition order, and this is the single
  // registry both `customTools` and the `tools` allowlist are built from.
  // Sorted AFTER all wrapper layers (aliases → skill filter → brief gate →
  // approval gate → execution modes) so wrapping never reorders it.
  const orderedTools: ToolDefinition[] = [...applyExecutionModes(approvalWrappedTools)].sort(
    (a, b) => a.name.localeCompare(b.name),
  );

  // Emit skill selection event (UI parity with legacy runner).
  yield {
    kind: 'agent_event',
    event: {
      type: 'agent:skill_selected',
      category: activeCategory,
      confidence: classification.confidence,
      method: classification.method,
      toolCount: orderedTools.length,
    },
  };

  // 6. Optionally generate a plan (identical to legacy runner, but we skip
  //    the LLM-based planner because we don't have an OpenAI-shaped client
  //    readily available — the planner's LLM call would need an adapter).
  //    The keyword-based `recommendPlan` detection still works; the plan
  //    body will be empty unless we wire in a planner LLM later.
  let plan: Plan | null = null;
  if (classification.recommendPlan) {
    try {
      // generatePlan with llm=undefined falls back to keyword-based planning.
      plan = await generatePlan({
        prompt,
        classification,
        llm: undefined,
        signal,
      });
      if (plan) {
        yield {
          kind: 'agent_event',
          event: {
            type: 'agent:plan',
            steps: plan.steps.map((s) => ({
              step: s.step,
              description: s.description,
              skill: s.skill,
              status: s.status,
            })),
          },
        };
      }
    } catch {
      plan = null;
    }
  }

  // 7. Optionally dispatch the web-research sub-agent (provider-aware:
  //    pass the LLM client we built above so it uses the user's chosen
  //    provider instead of always hitting ZAI).
  let webResearchSummary: string | null = null;
  const needsWebResearch =
    activeCategory === 'web_research' ||
    (classification.secondaryCategories.includes('web_research') && classification.recommendPlan);

  if (needsWebResearch) {
    yield {
      kind: 'agent_event',
      event: {
        type: 'agent:subagent_dispatch',
        subAgentType: 'web_research',
        task: prompt,
      },
    };

    const subAgentResult = await dispatchWebResearchSubAgent({
      task: prompt,
      canvas,
      signal,
      llm: subAgentLLM,
    });

    webResearchSummary = subAgentResult.summary;

    yield {
      kind: 'agent_event',
      event: {
        type: 'agent:subagent_result',
        subAgentType: 'web_research',
        success: subAgentResult.success,
        summary: webResearchSummary.slice(0, 500),
        toolCalls: subAgentResult.toolCalls,
      },
    };

    // If the primary task WAS web research (not "research then design"),
    // the sub-agent's summary IS the answer.
    if (activeCategory === 'web_research' && !classification.recommendPlan) {
      yield {
        kind: 'agent_event',
        event: { type: 'agent:message_delta', text: webResearchSummary },
      };
      yield { kind: 'agent_event', event: { type: 'agent:message_end' } };
      yield { kind: 'agent_event', event: { type: 'agent:turn_end' } };
      return;
    }
  }

  // ---- Audit 2-c S11: join the pre-generated brief here (the first point
  //      that needs it) — classification, tool filtering and web research
  //      have all overlapped the sub-agent by now.
  if (preGeneratedBriefPromise) {
    const brief = await preGeneratedBriefPromise;
    if (brief) {
      preGeneratedBrief = brief;
      hasGeneratedBrief = true; // the tool-layer gate below becomes a no-op
    }
  }

  // 8. Build the system prompt (identical to legacy runner — uses the same
  //    template, skill metadata, plan section, and canvas snapshot). Plus
  //    memory context (long-term MEMORY.md + scratchpad + today's log).
  //
  //    Audit 1 P6 (cache stability): the plan / file-skills / memory sections
  //    are PER-TURN data. They used to be appended to the SYSTEM prompt,
  //    which mutated the supposedly byte-stable cacheable prefix every turn
  //    (skill body selection + plan + memory writes all busted the cache).
  //    They now ride the FIRST USER MESSAGE alongside the snapshot — the
  //    system prompt stays strictly static per document+settings, so the
  //    cross-turn provider prefix cache actually hits.
  const skillMetadata = formatSkillMetadataForPrompt();
  const skillBody = formatSkillBodyForPrompt(activeCategory);
  const planSection = plan
    ? `=== EXECUTION PLAN =========================================================\nFollow this plan. Complete each step before moving to the next.\n\n${formatPlanForPrompt(plan)}\n`
    : '';

  // Load file-based skills (.pi/skills/*.md) and append their guidelines.
  let fileSkillsSection = '';
  try {
    const { getFileSkills } = await import('./file-skills');
    const fileSkills = getFileSkills();
    if (fileSkills.length > 0) {
      fileSkillsSection =
        '\n\n=== FILE-BASED SKILL GUIDELINES ============================================\n' +
        fileSkills
          .map((s) => `--- ${s.name} ---\n${s.guidelines.map((g, i) => `${i + 1}. ${g}`).join('\n')}`)
          .join('\n\n');
    }
  } catch {
    // File skills are optional.
  }

  // Long-term memory context (from the memory plugin — MEMORY.md + scratchpad
  // + today's + yesterday's daily logs). This gives the agent persistent
  // recall of user preferences and past design decisions. Capped by the
  // memory plugin itself (audit 1 P7) so it can't grow without bound.
  let memorySection = '';
  try {
    const memCtx = getMemoryContextForPrompt();
    if (memCtx) {
      memorySection = '\n\n=== LONG-TERM MEMORY (from memory plugin) ==================================\n' + memCtx;
    }
  } catch {
    // Memory plugin failed to load — non-fatal.
  }

  // ---- Audit 1 P3: cross-turn conversation history --------------------------
  //
  // Every turn used to start from a blank session — the LLM saw the canvas
  // snapshot but NEVER the prior chat turns, so "as we discussed",
  // "use the other font you suggested", or a plain "yes, do that" after a
  // clarifying question were unintelligible. The journal already records
  // agent:user_message + agent:turn_final per turn; replay the last few
  // turns into the first user message (token-capped) — after the snapshot,
  // before the current prompt, never in the system prompt (cache).
  let conversationHistorySection = '';
  try {
    conversationHistorySection = await buildConversationHistory(documentId);
  } catch {
    // Journal unavailable (fresh doc / DB hiccup) — non-fatal.
  }

  const systemContent = buildSystemPrompt(
    skillMetadata,
    skillBody,
    /* planSection */ '', // per-turn data — rides the user message now (P6)
    canvas,
    defaultPalette,
    planFirst,
    settings?.pack,
    /* includeSnapshot */ false,
  );

  // ---- Agent Performance Package change 10: prompt caching -----------------
  //
  // pi-ai sends `prompt_cache_key` (session-stable) only when
  // cacheRetention==='long' AND the resolved model's compat declares
  // supportsLongCacheRetention (set for custom OpenAI-compatible endpoints
  // in pi-ai-model-resolver.ts). Verified live against the default kimi
  // endpoint: both cache fields are accepted and usage reports cached_tokens,
  // so the ~45K-token static prefix (tools + system prompt) is served from
  // cache on every call after the first within a turn. Respects an explicit
  // user override (||=, not =).
  process.env.PI_CACHE_RETENTION ||= 'long';

  // 9. Resolve the pi-ai Model + ModelRuntime from settings.
  //    Throws if no auth is configured (e.g. user picked OpenAI but didn't
  //    provide an API key).
  let model: Awaited<ReturnType<typeof resolveModel>>;
  try {
    model = await resolveModel(settings);
  } catch (err: any) {
    const message = `Model resolution failed: ${agentErrorMessage(err)}`;
    const cls = classifyAgentError(message);
    yield {
      kind: 'agent_event',
      event: { type: 'agent:error', message, code: cls.code, retryable: cls.retryable },
    };
    yield { kind: 'agent_event', event: { type: 'agent:turn_end' } };
    return;
  }

  // 10. Build the stub resource loader with our pre-built system prompt.
  const resourceLoader = buildResourceLoader(systemContent);

  // ---- Reactive z.ai sandbox fallback --------------------------------------
  //
  // The resolver's preflight (in `pi-ai-model-resolver.ts`) catches the
  // dead-endpoint case BEFORE the session is created — it swaps the model
  // to a z.ai-sandbox-resolved `glm-5.3` and marks `model.usedFallback=true`.
  //
  // But the preflight can't catch a turn that completes with HTTP 200 + an
  // EMPTY body (no text, no tool calls). For that case, the runner re-runs
  // the turn ONCE against a freshly-resolved z.ai-sandbox model. Bounded:
  //   - `attempt < 2` (at most one retry per turn).
  //   - `!currentModel.usedFallback` (skip if the resolver already swapped).
  //   - `providerId !== 'zai'` (no point falling back to the same provider).
  //   - `!sawActivity` (only retry if the previous attempt produced zero
  //     user-visible output — no `message_delta`, no `tool_call_start`).
  //
  // The cumulative `everSaw*` flags track closing events across ALL attempts
  // so the defensive tail after the loop doesn't double-emit. The `last*`
  // flags reflect the FINAL attempt and drive the silent-failure guard.
  const providerId = normalizeLLMProvider(
    settings?.llmProvider ?? DEFAULT_SETTINGS.llmProvider,
  );

  // 11. Build the user message. If we have a web-research summary, inject
  //     it as context (identical to legacy runner). Done once per turn
  //     (outside the attempt loop) — the user prompt doesn't change between
  //     attempts.
  //     Selection context: when the user had canvas layers selected, a
  //     targeting note rides in front of the prompt so "these/those/the
  //     selection" resolves to concrete layer names (Figma-AI-style
  //     selection awareness).
  const selectionNote = opts.selection
    ? `[SELECTION CONTEXT: the user currently has ${opts.selection.count} layer(s) selected on the canvas: ${opts.selection.names.join(', ')}. When the user says "this", "these", "that", "those", or "the selection", they mean THESE layers. Target them unless asked otherwise.]\n\n`
    : '';
  // Design-system pack reminder — when a pack is pinned, append a short
  // reminder to the END of the user's prompt so it's the last thing the
  // agent reads before its first tool call. The full pack section lives
  // in the system prompt (see `buildDesignSystemPackSection`); this is
  // just a final nudge to counter the agent's prior training bias
  // toward colorful + rounded defaults.
  const packReminder = settings?.pack
    ? `\n\n[PACK REMINDER: the "${settings.pack}" design-system pack is pinned. Use \`var(--color-*)\`, \`var(--radius-*)\`, \`var(--space-*)\`, \`var(--font-*)\`, \`var(--button-*)\` from the pack — NEVER hardcoded hex / px / font-family. The pack's tokens.css is already injected on the canvas root. See the "DESIGN-SYSTEM PACK" section in the system prompt for the full variable list + the FIDELITY POLICY OVERRIDES for this pack.]`
    : '';
  // ---- Agent Performance Package change 5: canvas snapshot moves from the
  //      system-prompt tail into the FIRST USER MESSAGE --------------------------------
  //
  // The snapshot was the only DYNAMIC section of the system prompt — every
  // turn rebuilt the whole block, so the ~43KB static prefix (fidelity
  // policy, recipes, palettes) could never hit a provider prefix cache across
  // turns. Moving the snapshot keeps identical information at identical
  // times (built once at turn start) but makes the system prompt
  // byte-stable. Also injects the pre-generated design brief (change 9)
  // directly into the first user message so the main loop needs no brief
  // round-trip.
  //
  // Phase C (R9a) delta mode: when the server could compute WHICH nodes
  // changed since the last settled turn (journal-fold watermark — a
  // non-null nodeIds array), the digest replaces the full tree: unchanged
  // subtrees collapse to navigation lines, globals (palette, collections,
  // text styles, screen placement) stay, and pen_get_metadata(detail:true)
  // re-hydrates any collapsed node on demand (tldraw getChangesSince +
  // Linear late-enrichment). nodeIds:null (global op / oversized window)
  // and absent canvasDelta (HTTP fallback) both keep the full snapshot.
  const delta = opts.canvasDelta?.nodeIds;
  const snapshotSection = delta
    ? `\n\nCURRENT CANVAS SNAPSHOT — DELTA since the last turn (unchanged subtrees are collapsed; call pen_get_metadata with a nodeId — detail:true — to expand any node's full fields):\n${canvasSnapshotDelta(canvas, delta)}`
    : `\n\nCURRENT CANVAS SNAPSHOT (at turn start — call pen_get_metadata for live state):\n${canvasSnapshot(canvas)}`;
  // Prompt versioning (make-real MIGRATION_VERSION pattern): stamped on the
  // first user message (NOT the system prompt — that would invalidate the
  // byte-stable cacheable prefix) so every run record / eval log / journal
  // entry is attributable to the exact prompt revision that produced it.
  const promptVersionSection = `\n\n[SYSTEM META: prompt v${PROMPT_VERSION}]`;
  const briefSection = preGeneratedBrief
    ? `\n\n[PRE-GENERATED DESIGN BRIEF — the palette / typography / layout source of truth for this whole turn. Do NOT call pen_generate_design_brief; build directly from this brief:]\n${preGeneratedBrief}`
    : '';
  // Ambiguous-creation nudge: steer the first tool call to the parallel
  // explorer (one call = 2-3 whole-design variants, VLM-judged, winner
  // applied) instead of the model guessing one direction.
  const variantNudge = isAmbiguousCreation
    ? `\n\n[VARIANT EXPLORATION — this request does not pin a visual direction. Call pen_generate_variants FIRST with the request verbatim: it explores 2-3 complete design directions in parallel, a vision judge picks the best render, and only the winner is applied. Do NOT call pen_generate_design_brief — the palette choice is exactly what the exploration settles.]`
    : '';
  // Per-turn context sections ride the user message (P6 cache stability):
  // plan, file-skills, memory. Order: history → snapshot → per-turn sections →
  // current prompt last-ish (brief/variant nudge + version stamp + pack nudge).
  const perTurnSections = planSection + fileSkillsSection + memorySection;
  const userMessage = (webResearchSummary
    ? `WEB RESEARCH SUMMARY (from sub-agent):\n${webResearchSummary}\n\n---\nNow use this information to complete the original request:\n${selectionNote}${prompt}`
    : `${selectionNote}${prompt}`) + briefSection + variantNudge + conversationHistorySection + snapshotSection + perTurnSections + promptVersionSection + packReminder;
  // The message actually sent to session.prompt() — the user message with
  // an attachment note appended when images ride along (see below).
  let userMessageWithAttachments = userMessage;

  // Image attachments (Task: vision-capable chat) — convert the compact
  // data URLs staged by the client into the pi-ai ImageContent shape.
  // `session.prompt(text, { images })` attaches them natively; models that
  // accept image input see them inline with the prompt. Malformed entries
  // are skipped rather than failing the whole turn (dataUrlToImageContent
  // returns null for anything that isn't a base64 image data URL).
  const promptImages = (opts.images ?? [])
    .map((a) => dataUrlToImageContent(a.dataUrl))
    .filter((c): c is { type: 'image'; data: string; mimeType: string } => c !== null);
  if (promptImages.length > 0) {
    // Make the attachment count visible in the prompt text too — text-only
    // models (no image input support) still get a mention that images were
    // attached, which keeps the conversation coherent after a model switch.
    const names = (opts.images ?? [])
      .map((a) => a.name ?? 'image')
      .slice(0, promptImages.length)
      .join(', ');
    userMessageWithAttachments = `${userMessage}\n\n[${promptImages.length} image${promptImages.length === 1 ? '' : 's'} attached: ${names}]`;
  }

  const sessionId = opts.documentId ?? `session-${Date.now()}`;

  let didFallback = false;
  let everSawMessageEnd = false;
  let everSawTurnEnd = false;
  // True when a translator-emitted agent:turn_end was WITHHELD from the
  // client stream (see the drain loops) — the tail must then emit the one
  // authoritative turn_end so the UI never hangs.
  let withheldTurnEnd = false;
  let lastSawActivity = false;
  // Tool-call visibility for the LAST attempt — drives the text-only-design-turn
  // silent-failure guard (a build request that settled with prose only and
  // zero tool calls is a failed turn even though text "activity" was seen).
  let lastSawToolCall = false;
  let lastSawErrorEvent = false;
  let lastPromptError: any = undefined;
  let currentModel = model;
  // finishReason of the LAST assistant message across attempts ('length' =
  // truncated by the token limit) — drives the auto-continue block after the
  // attempt loop (bolt.diy SwitchableStream pattern).
  let lastStopReason: string | undefined;

  // ---- Stuck detector (OpenHands conversation/stuck_detector pattern) -----
  //
  // Tracks consecutive failures of the SAME tool call signature
  // (toolName + args preview). At STUCK_STREAK identical consecutive failures
  // the loop is stopped at the next turn boundary (via shouldStopAfterTurn)
  // and a terminal `agent:stuck` event tells the client to mark the run
  // honestly instead of burning the whole iteration budget on a doomed
  // repetition (observed live: a model re-calling a failing pen_* tool 30×).
  const STUCK_STREAK = 3;
  const stuckTracker = {
    lastSignature: '',
    streak: 0,
    stuck: false,
    lastToolName: '',
    pendingSignatures: new Map<string, string>(),
    onStart(toolCallId: string, toolName: string, argsPreview: string) {
      if (toolCallId) this.pendingSignatures.set(toolCallId, `${toolName}|${argsPreview.slice(0, 400)}`);
    },
    onEnd(toolCallId: string, success: boolean) {
      const signature = this.pendingSignatures.get(toolCallId) ?? '';
      if (toolCallId) this.pendingSignatures.delete(toolCallId);
      if (success) {
        this.streak = 0;
        this.lastSignature = '';
        return;
      }
      if (signature && signature === this.lastSignature) {
        this.streak++;
      } else {
        this.lastSignature = signature;
        this.streak = 1;
      }
    },
  };

  // ---- Abort wiring (server-side Stop) -------------------------------------
  //
  // The route passes the request's AbortSignal. When it fires (client
  // disconnect / canvas-sync agent:stop / stream watchdog) we abort the LIVE
  // pi session — prompt() unblocks, drain loops end, and the runner emits a
  // terminal agent:turn_cancelled. Without this, Stop only hid the output
  // while the server kept spending tokens to completion.
  let session: AgentSession | undefined;
  // Real-steer registration (R8c): the live session's entry in the
  // active-sessions registry. `steerActiveSession` (canvas-sync's
  // agent:steer handler) looks the document's session up there — identity-
  // checked unregister so a retry attempt's cleanup never evicts the newer
  // session. Declared next to `session` because they share the exact same
  // lifecycle (assign on create, clear on dispose).
  let unregisterSteer: (() => void) | undefined;
  const onAbort = () => {
    try {
      void session?.abort?.();
    } catch {
      // Session already disposed — nothing to abort.
    }
  };
  if (signal) {
    signal.addEventListener('abort', onAbort);
    // Already aborted before we subscribed (e.g. watchdog fired during model
    // resolution) — the checks below short-circuit the run.
  }
  const wasAborted = () => signal?.aborted === true;

  // Task 7-e Fix 3: Lift `session` to the outer scope so the critique loop
  // can REUSE it for the fix-message re-prompt. Declared here, assigned in
  // the attempt loop, disposed in the outer finally at the end of the
  // function (or at the top of the next attempt on the fallback path).
  // (NOTE: `session` is now declared above, next to the abort wiring, so the
  // abort listener can reference it.)

  // Up to 2 attempts: primary, then (conditionally) one z.ai sandbox retry.
  for (let attempt = 0; attempt < 2; attempt++) {
    // Per-attempt translator state — re-create per attempt so a fresh
    // `agent_end` from the second attempt's SDK emits its own `turn_end`
    // without being suppressed by the first attempt's state.
    let sawMessageEnd = false;
    let sawTurnEnd = false;
    let sawActivity = false;
    let sawToolCall = false;
    let sawErrorEvent = false;
    let promptError: any = undefined;

    // 12. Construct the AgentSession.
    //     - noTools: 'all' → disable all built-in coding tools (bash, read, edit, write).
    //     - customTools: our 88 canvas tools.
    //     - tools: allowlist of the active skill's tool names → only those
    //              are visible to the LLM (mirrors the legacy runner's filterToolSpecs).
    //     - sessionManager: in-memory (we don't want file-based session journaling;
    //                       AgentCanvas has its own Zustand+localStorage session store).
    //     - settingsManager: in-memory with auto-compaction disabled (we have
    //                       our own context-manager; we don't want the SDK
    //                       compacting mid-turn without our translator knowing).
    //                       Re-enable later if we want native auto-compaction.
    //
    //     Task 7-e Fix 3: `session` is declared in the OUTER scope (before
    //     the attempt loop) so the critique loop can REUSE it for the
    //     fix-message re-prompt. Previously the critique loop created a NEW
    //     pi SDK session per iteration, which meant the LLM lost all
    //     conversation context from the main turn — by the time the
    //     fix-message reached the model, it had no memory of what it just
    //     designed, so it often responded with text-only "I've addressed
    //     the issues" without actually calling any tools. Reusing the main
    //     session preserves the full conversation history (system prompt +
    //     user message + assistant tool calls + tool results) so the LLM
    //     can continue from where it left off.
    //
    //     On the fallback path (attempt 1 = z.ai sandbox retry), we dispose
    //     the previous attempt's session at the top of the loop before
    //     creating the new one — fallback MUST use a fresh session because
    //     the model object is different.
    //
    //     The session is finally disposed in the outer try/finally after
    //     the critique loop completes.
    if (session) {
      // Disposing the previous attempt's session before creating a new one
      // (only happens on the fallback path — attempt 0 leaves session
      // undefined, so this is a no-op the first time through).
      try { session.dispose(); } catch {}
      session = undefined;
      if (unregisterSteer) { unregisterSteer(); unregisterSteer = undefined; }
    }
    try {
      const result = await createAgentSession({
        cwd: process.cwd(),
        model: currentModel.model,
        modelRuntime: currentModel.modelRuntime,
        thinkingLevel: mapThinkingLevel(thinkingLevel),
        noTools: 'all',
        customTools: orderedTools,
        tools: orderedTools.map((t) => t.name),
        resourceLoader,
        sessionManager: SessionManager.inMemory(process.cwd()),
        settingsManager: SettingsManager.inMemory({
          // Disable auto-compaction for now — our context-manager.ts already
          // handles truncation, and enabling SDK compaction would emit
          // compaction_start/end events that the UI doesn't yet render
          // meaningfully. Re-enable when we're ready to surface "Compacting…"
          // as a proper UI state.
          compaction: { enabled: false },
          retry: { enabled: true, maxRetries: 2 },
        } as any),
      });
      session = result.session;
      // Register for real steer (R8c): makes session.steer() reachable from
      // the canvas-sync socket handler while this turn is live. The
      // identity-checked unregister handles the retry/dispose paths.
      unregisterSteer = registerActiveSession(documentId, session);

      // ---- Agent Performance Package change 7: wire maxIterations -----------
      //
      // `settings.maxIterations` (default 20) was read at the top of this
      // runner but never used — the production loop was unbounded (the VLM
      // exercise saw 78-call turns spiral under endpoint rate-limits).
      // pi-agent-core exposes `shouldStopAfterTurn` on the Agent runtime
      // options, but createAgentSession doesn't plumb it through; the Agent
      // instance is public on the session, so set it defensively. The budget
      // spans the main loop AND critique fix re-prompts (continuation runs
      // share this closure). Exceeding it stops the loop; the critique phase
      // below still runs on whatever was produced.
      try {
        const agentAny = (session as unknown as { agent?: Record<string, unknown> }).agent;
        if (agentAny && typeof agentAny === 'object' && 'shouldStopAfterTurn' in agentAny) {
          let toolCallBudget = Math.max(1, maxIterations);
          (agentAny as { shouldStopAfterTurn: unknown }).shouldStopAfterTurn = (turnCtx: {
            message?: { content?: Array<{ type?: string }> };
          }) => {
            const toolCalls = turnCtx?.message?.content?.filter?.((c: { type?: string }) => c?.type === 'toolCall') ?? [];
            toolCallBudget -= toolCalls.length;
            // Stuck detector: once the SAME tool call failed identically
            // STUCK_STREAK times, stop the loop at this turn boundary — the
            // agent:stuck event has already been emitted in the drain loop.
            return toolCallBudget <= 0 || stuckTracker.stuck;
          };
        }
      } catch {
        // Capability probe failed — loop stays unbounded (pre-existing behavior).
      }
    } catch (err: any) {
      const message = `Failed to create agent session: ${agentErrorMessage(err)}`;
      const cls = classifyAgentError(message);
      yield {
        kind: 'agent_event',
        event: { type: 'agent:error', message, code: cls.code, retryable: cls.retryable },
      };
      lastSawErrorEvent = true;
      // Session-creation failures are usually model-resolution issues (already
      // handled by the resolver try/catch above) or runtime config issues —
      // not endpoint-down cases. Don't retry; surface the error and exit.
      break;
    }

    // 13. Subscribe to AgentSessionEvents via the translator. The translator
    //     pushes AgentStreamEvents onto an async queue; we drain it below.
    //     Pass the RESOLVED model's context window so `agent:context_update`
    //     events report the real window (the old translator hardcoded 128K).
    const { queue, unsubscribe } = subscribeAndTranslate(
      (listener) => session!.subscribe(listener),
      { contextWindow: currentModel.model.contextWindow },
    );

    // 13a. Emit the resolved-model info to the client BEFORE the turn starts.
    //      The client previously only knew the CONFIGURED model (settings
    //      store) — but the resolved one can differ (legacy-id mapping,
    //      first-available fallback, z.ai sandbox fallback) and the UI needs
    //      the true context window for the usage bar. Follows the Cline /
    //      Claude Code / Cursor pattern: model identity + context capacity
    //      surfaced next to the chat. Emitted per attempt so a fallback swap
    //      mid-run re-broadcasts the new model.
    yield {
      kind: 'agent_event',
      event: {
        type: 'agent:model_info',
        provider: String(currentModel.model.provider ?? 'unknown'),
        modelId: String(currentModel.model.id ?? 'unknown'),
        label: currentModel.label,
        contextWindow: currentModel.model.contextWindow,
        maxTokens: currentModel.model.maxTokens,
        usedFallback: currentModel.usedFallback === true,
      },
    };

    // 13b. Set per-turn plugin state.
    //      - Event sink: lets plugin tools emit SyncEvents through the same
    //        stream the runner uses (so ask_user_question, todo, mcp, etc.
    //        can fire UI events mid-turn).
    //      - Active session: lets the todo + goal-list + background-tasks
    //        plugins track per-session state.
    //      - Active LLM + canvas: lets the subagents plugin pass these to
    //        its dispatched sub-agents.
    //      Re-set per attempt so the event sink points at THIS attempt's
    //      queue (the previous attempt's `restoreEventSink` already restored
    //      the original sink in its finally block).
    const restoreEventSink = setEventSink((event) => {
      queue.push([{ kind: 'agent_event', event }]);
    });
    setTodoActiveSession(sessionId);
    setGoalActiveSession(sessionId);
    setBackgroundTaskActiveSession(sessionId);
    setSubagentActiveLLM(subAgentLLM ?? null);
    setSubagentActiveCanvas(() => canvas);

    // 14. Drain events from the queue while the prompt is running. We use
    //     a race between `session.prompt()` (which resolves when the turn
    //     completes) and the queue's async iterator (which yields events as
    //     they arrive). When prompt() resolves, we close the queue and drain
    //     any remaining buffered events.
    //
    //     Track which closing events the translator emitted so the defensive
    //     tail emission after the finally block doesn't duplicate them
    //     (previously BOTH were emitted unconditionally — every successful
    //     turn ended with a doubled agent:message_end + agent:turn_end, which
    //     fanned out to all viewers via canvas-sync and double-triggered run
    //     finalization).
    try {
      // Kick off the prompt — don't await yet.
      const promptPromise = session.prompt(userMessageWithAttachments, {
        // Disable prompt-template expansion — we built the system prompt
        // ourselves and don't want pi to expand `/skill:foo` commands.
        expandPromptTemplates: false,
        // Image attachments — pi-ai ImageContent parts; vision-capable
        // models receive them inline with the prompt (PromptOptions.images).
        ...(promptImages.length > 0 ? { images: promptImages } : {}),
      });

      // Drain events as they arrive. The queue's drain() async iterator
      // yields events until close() is called AND the buffer is empty.
      // We race it against promptPromise so that when prompt() resolves,
      // we close the queue and drain any remaining events.
      promptPromise.catch((err) => {
        promptError = err;
        queue.close();
      });

      // Iterate the queue. If prompt() resolves before the queue is drained,
      // we wait for the queue to finish. If prompt() throws, we close the
      // queue and surface the error.
      // We use a settled-flag pattern: when promptPromise resolves, we mark
      // settled=true and let the queue drain naturally (the SDK emits
      // `agent_end` as the last event, which the translator turns into
      // `agent:turn_end` — so the queue will close itself when the SDK is
      // done).
      let settled = false;
      void promptPromise.then(() => {
        settled = true;
        // Don't close the queue yet — the SDK might still be emitting final
        // events (agent_end, message_end). Give it a microtask to flush.
        // The translator will have processed everything by the time
        // prompt() resolves, but defensively wait one tick.
        setTimeout(() => queue.close(), 0);
      });

      // Track which closing events the translator already emitted (flags
      // declared above the try block — the defensive tail reads them after
      // the finally block).
      for await (const ev of queue.drain()) {
        if (ev.kind === 'agent_event') {
          if (ev.event.type === 'agent:message_end') {
            sawMessageEnd = true;
            if (ev.event.stopReason) lastStopReason = ev.event.stopReason;
          }
          if (ev.event.type === 'agent:turn_end') {
            sawTurnEnd = true;
            // WITHHOLD the per-attempt turn_end from the client stream: the
            // critique loop below may still run (critics + fix-turn can take
            // tens of seconds). Emitting it here made the client go idle
            // (agentBusy=false → queue flush → snapshot) while the server was
            // still working — racing a queued follow-up against the fix-turn
            // and misattributing critique events to the next turn's bubble.
            // The tail emits exactly ONE authoritative turn_end instead.
            withheldTurnEnd = true;
            continue;
          }
          if (ev.event.type === 'agent:error') sawErrorEvent = true;
          // ---- Stuck detector feed (C4) -----------------------------------
          if (ev.event.type === 'agent:tool_call_start') {
            sawToolCall = true;
            stuckTracker.onStart(ev.event.toolCallId, ev.event.toolName, ev.event.argsPreview);
          }
          if (ev.event.type === 'agent:tool_call_end') {
            stuckTracker.onEnd(ev.event.toolCallId, ev.event.success);
            if (
              !stuckTracker.stuck &&
              stuckTracker.streak >= STUCK_STREAK &&
              stuckTracker.lastSignature
            ) {
              stuckTracker.stuck = true;
              stuckTracker.lastToolName = stuckTracker.lastSignature.split('|')[0] ?? '';
              yield {
                kind: 'agent_event',
                event: {
                  type: 'agent:stuck',
                  message:
                    `The tool "${stuckTracker.lastToolName}" failed identically ${stuckTracker.streak} times in a row ` +
                    `(same arguments, same error). Stopping the loop instead of burning the remaining iteration budget — ` +
                    `change the approach or check the tool arguments, then resend.`,
                  toolName: stuckTracker.lastToolName,
                  streak: stuckTracker.streak,
                },
              };
              // shouldStopAfterTurn now returns true → the SDK loop ends at
              // this turn boundary and the tail closes the turn honestly.
            }
          }
          // "Activity" = USER-VISIBLE output only (text or tool calls). Thinking
          // deltas deliberately do NOT count: a 429'd attempt can emit partial
          // thinking before failing, and a turn with only thinking, no text, and
          // no tool calls is still a broken turn from the user's perspective.
          if (
            ev.event.type === 'agent:message_delta' ||
            ev.event.type === 'agent:tool_call_start'
          ) {
            sawActivity = true;
          }
        }
        yield ev;
        // Server-side Stop: the abort listener already called session.abort()
        // — the SDK is unwinding. Stop translating and let the tail emit the
        // terminal turn_cancelled.
        if (wasAborted()) {
          break;
        }
        if (promptError) {
          // prompt() threw — STOP draining. The error itself is surfaced
          // AFTER the fallback decision below: yielding here would paint the
          // run red (agent:error marks the run failed client-side) even when
          // the z.ai fallback retry on the next attempt then succeeds. The
          // deferred emission only fires when we're actually giving up.
          break;
        }
      }

      // If prompt() resolved without error but we never saw an agent:turn_end
      // event (e.g. the SDK short-circuited), emit one defensively.
      if (!promptError && !settled) {
        // prompt() is still pending but the queue drained — unusual. Wait
        // for prompt() to settle so we surface any error. The error is
        // DEFERRED to the fallback decision below (same rationale as the
        // drain-loop break above — a mid-stream death must not paint the
        // run failed before the z.ai fallback gets its chance).
        try {
          await promptPromise;
        } catch (err: any) {
          promptError = err;
        }
      }
    } finally {
      unsubscribe();
      queue.close();
      restoreEventSink();
      // Task 7-e Fix 3: DO NOT dispose `session` here. The critique loop
      // below reuses it for the fix-message re-prompt (preserves the
      // conversation context the LLM needs to actually act on the
      // critique). The session is disposed in the outer finally at the
      // end of the function. On the fallback path, the top of the next
      // attempt's loop body disposes the previous session before creating
      // the new one.
    }

    // Update cumulative state across attempts.
    if (sawMessageEnd) everSawMessageEnd = true;
    if (sawTurnEnd) everSawTurnEnd = true;
    lastSawActivity = sawActivity;
    lastSawToolCall = sawToolCall;
    lastSawErrorEvent = sawErrorEvent;
    lastPromptError = promptError;

    // Skip the z.ai fallback retry entirely when the run was aborted —
    // a stopped run must not kick off a SECOND LLM attempt.
    if (wasAborted()) break;

    // Decide whether to fall back to the z.ai sandbox for a second attempt.
    // Bounded: at most ONE retry per turn (attempt === 0 only).
    //
    // THREE failure shapes justify the retry (previously only the first):
    //
    //   1. ZERO-OUTPUT attempt (no text deltas, no tool calls) — the classic
    //      empty-200 / rate-limited-body case.
    //   2. DIED-MID-STREAM attempt — text streamed, then prompt() THREW
    //      (tunnel closed the SSE stream mid-output). The preamble the user
    //      already saw is not a deliverable; a fresh attempt on a different
    //      provider is the only recovery. The prompt error is DEFERRED (see
    //      the drain loop) so this retry can still produce a clean turn.
    //      Skipped when the resolver already swapped to the z.ai sandbox
    //      preflight (currentModel.usedFallback) — that would be a second
    //      fallback for the same turn, violating the one-retry bound. Also
    //      skipped when the configured provider is already 'zai' (no point
    //      falling back to the same provider).
    //   3. TEXT-ONLY DESIGN TURN — the attempt settled "normally" (clean
    //      message end, no throw) but produced ZERO tool calls on a
    //      build-style design request (expectsCanvasOutput). Observed live:
    //      the model streamed its preamble, the tunnel cut the stream at
    //      exactly 500 output tokens, and the SDK surfaced it as a clean
    //      message end — text "activity" with no drawing. The turn owed
    //      tool calls and produced none → retry. Questions ("what makes a
    //      good login screen?") never match expectsCanvasOutput, so legit
    //      prose answers are never retried.
    const diedMidStream = !!promptError && sawActivity;
    const textOnlyDesignTurn = sawActivity && !sawToolCall && expectsCanvasOutput;

    const shouldFallback =
      attempt === 0 &&
      !didFallback &&
      !currentModel.usedFallback &&
      providerId !== 'zai' &&
      (!sawActivity || diedMidStream || textOnlyDesignTurn);

    // VLM-exercise Fix 5: the FALLBACK ITSELF can return an empty body
    // (observed 3× during the exercise: pinggy primary down → preflight
    // swaps to glm-5.3 → glm-5.3 transiently rate-limited → empty 200 →
    // turn dies with a user-facing error and 0 tool calls). When the current
    // model is ALREADY the sandbox fallback (or the configured provider is
    // zai), retry the SAME model once after a backoff — bounded by the same
    // didFallback flag, so the total stays at one extra attempt per turn.
    // Extended to the text-only-design-turn shape (same reasoning — the
    // turn owed tool calls and produced none), but NOT to diedMidStream
    // with a thrown error on the same model: the SDK already burned its
    // internal retry budget on that exact model, so a thrown stream death
    // on zai only surfaces the deferred error instead of re-rolling.
    const shouldRetrySameModel =
      attempt === 0 &&
      !didFallback &&
      (currentModel.usedFallback === true || providerId === 'zai') &&
      (!sawActivity || (textOnlyDesignTurn && !promptError));

    // Emit the deferred prompt error now when we are NOT retrying — this is
    // the only honest exit for a mid-stream death that no safety net caught.
    // (When we ARE retrying, the error stays deferred: the next attempt's
    // output replaces it, and the tail guards below still fire if that
    // attempt fails too.)
    const surfaceDeferredError = () => {
      if (!promptError || sawErrorEvent || wasAborted()) return;
      const message = `Agent prompt failed: ${agentErrorMessage(promptError)}`;
      const cls = classifyAgentError(message);
      sawErrorEvent = true;
      lastSawErrorEvent = true;
      return {
        kind: 'agent_event' as const,
        event: { type: 'agent:error' as const, message, code: cls.code, retryable: cls.retryable },
      };
    };

    if (!shouldFallback && !shouldRetrySameModel) {
      const deferred = surfaceDeferredError();
      if (deferred) yield deferred;
      break;
    }

    if (shouldFallback) {
      // Try to resolve a z.ai-sandbox fallback model. If ZAI.create() throws
      // (not in the z.ai sandbox / no creds), log and skip — the deferred
      // error + silent-failure guard below will surface the failure to the
      // user.
      const fallbackModel = await resolveZaiSandboxFallback();
      if (!fallbackModel) {
        const deferred = surfaceDeferredError();
        if (deferred) yield deferred;
        break;
      }

      console.warn(
        `[llm-fallback] primary endpoint ${currentModel.label} produced ${
          sawActivity ? (sawToolCall ? 'partial output' : 'text-only output with zero tool calls') : 'no output'
        } (zero message_delta + zero tool_call events)${promptError ? ' — stream died mid-turn' : ''}; retrying turn with z.ai sandbox / glm-5.3`,
      );
      currentModel = fallbackModel;
    } else {
      console.warn(
        `[llm-fallback] ${currentModel.label} (already the fallback) produced ${
          sawActivity ? 'text-only output with zero tool calls' : 'no output'
        } — rate-limit backoff 8s, then one retry on the same model`,
      );
      await new Promise((r) => setTimeout(r, 8_000));
    }
    didFallback = true;
    // Loop continues to attempt 1 with the fallback (or same) model.
  }

  // ---- Auto-continue past truncation (bolt.diy SwitchableStream pattern) --
  //
  // When the model's output is cut by the token limit (stopReason 'length'),
  // the SDK already fails any truncated tool calls and keeps its internal
  // loop going. But when the FINAL message of the turn is truncated — prose
  // cut mid-sentence, no tool calls left to fail — the turn used to just end
  // mid-air. Re-prompt the SAME session (context preserved) with a synthetic
  // continue instruction, bounded to 2 continuation segments. The continued
  // text streams into the same assistant turn on the client (message deltas
  // append to the open turn).
  if (session && !wasAborted() && !lastPromptError && lastStopReason === 'length') {
    let continueSegments = 0;
    try {
      while (
        lastStopReason === 'length' &&
        continueSegments < 2 &&
        session &&
        !wasAborted()
      ) {
        continueSegments++;
        lastStopReason = undefined;
        yield {
          kind: 'agent_event',
          event: {
            type: 'agent:message_delta',
            text: '\n\n_[continuing — the previous message was truncated by the token limit]_\n',
          } as any,
        };
        const { queue: contQueue, unsubscribe: contUnsubscribe } = subscribeAndTranslate(
          (listener) => session!.subscribe(listener),
          { contextWindow: currentModel.model.contextWindow },
        );
        const contRestoreSink = setEventSink((event: any) => {
          contQueue.push([{ kind: 'agent_event', event }]);
        });
        let contError: any;
        try {
          const contMessage =
            'Your previous message was truncated mid-output because it hit the model token limit (finish reason: length). ' +
            'Continue EXACTLY where you stopped — do not repeat content you already produced, do not restart, do not re-emit tool calls that already ran. ' +
            'Finish the sentence/section you were writing, then end your turn with a one-sentence summary.';
          const contPromptPromise = session!.prompt(contMessage, { expandPromptTemplates: false });
          contPromptPromise.catch((err: any) => {
            contError = err;
            contQueue.close();
          });
          let contSettled = false;
          void contPromptPromise.then(() => {
            contSettled = true;
            setTimeout(() => contQueue.close(), 0);
          });
          for await (const ev of contQueue.drain()) {
            if (ev.kind === 'agent_event') {
              if (ev.event.type === 'agent:turn_end') {
                withheldTurnEnd = true;
                continue;
              }
              if (ev.event.type === 'agent:message_end' && ev.event.stopReason) {
                lastStopReason = ev.event.stopReason;
              }
            }
            yield ev;
            if (wasAborted() || contError) break;
          }
          if (!contSettled && !contError) {
            try { await contPromptPromise; } catch (err: any) { contError = err; }
          }
          if (contError) {
            const message = `Continuation prompt failed: ${agentErrorMessage(contError)}`;
            const cls = classifyAgentError(message);
            yield {
              kind: 'agent_event',
              event: { type: 'agent:error', message, code: cls.code, retryable: cls.retryable },
            };
            break;
          }
        } finally {
          contQueue.close();
          contUnsubscribe();
          contRestoreSink();
        }
      }
    } catch (err: any) {
      // Auto-continue is strictly best-effort: any unexpected failure here
      // must never kill the turn — the truncated-but-delivered output stands.
      console.warn(
        '[runner-native] auto-continue failed (non-fatal):',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Task 7-c P1.3 / T2 + P1.4 / T10 — MANDATORY self-critique loop with
  // pre-complete validation gate.
  //
  // The existing attempt loop above ran the agent's main turn (initial
  // design + tool calls). After it completes, we run a bounded outer loop:
  //   for (critiqueIteration = 0; critiqueIteration < maxCritiqueIterations; critiqueIteration++):
  //     1. Call dispatchDesignCriticSubAgent (text-critic) — reads canvas snapshot.
  //     2. Call dispatchDesignCriticVlmSubAgent (VLM critic, T3) — renders PNG,
  //        feeds to vision LLM with the SAME structured-critique prompt used for
  //        the Task 7-a baseline (so the "after" score is directly comparable).
  //     3. Call validateCanvasBeforeComplete (T10) — checks the canvas for
  //        the wireframe-only failure mode (too few shapes, no typography
  //        hierarchy, no shadows, no autoLayout).
  //     4. If validation passes AND critique severities are both "low", break —
  //        the design is good.
  //     5. Otherwise emit agent:critique event with the merged defects, then
  //        re-prompt the agent with a synthesized user message:
  //          "The design critic found these defects: [...]. Fix them by calling
  //           pen_update_shape or pen_create_shape. Do not declare done until
  //           each defect is addressed."
  //        And run another agent turn (a new pi SDK session — the previous one
  //        was disposed in the finally block above).
  //
  // Bounded by maxCritiqueIterations (default 2 — agent gets 1 chance to
  // self-correct after the critic). The loop is OPT-IN only via
  // settings.maxDesignCritiqueIterations === 0 (reverts to pre-7-c behavior).
  //
  // This is CRITICAL because the existing pen_self_critique tool is OPT-IN —
  // the agent never called it in the baseline. Making it MANDATORY is the
  // architectural enforcement the 7-b research report identified as the
  // single highest-leverage change.
  //
  // Task 7-e Fix 3 — REUSE the main session for the fix-message re-prompt
  // (previously a NEW session was created per iteration, losing all
  // conversation context — the LLM responded with text-only "I've addressed
  // the issues" without calling any tools, so the defects stayed). The fix
  // also adds:
  //   - noOpFixAttempts counter: after 2 consecutive re-prompts with ZERO
  //     tool calls, give up (don't waste iterations on a non-responsive LLM).
  //   - Strengthened fix-message: explicitly enumerates which tools the
  //     agent MUST call + which shapes to update, with a "Do NOT respond
  //     with text only" directive.
  //   - inCritiqueReprrompt flag: disables the brief-first enforcement
  //     during fix-turns (the agent already called pen_generate_design_brief
  //     in the main turn; we don't want to force another).
  const maxCritiqueIterations = settings?.maxDesignCritiqueIterations ?? 2;
  let noOpFixAttempts = 0;
  try {
  if (maxCritiqueIterations > 0 && session && !wasAborted()) {
    for (let critiqueIteration = 0; critiqueIteration < maxCritiqueIterations; critiqueIteration++) {
      // A stopped run never enters (or continues) the critique loop — critics
      // and fix-turns would spend more tokens after the user said Stop.
      if (wasAborted()) break;
      // Sync the local canvas with whatever patches the agent emitted.
      // (canvas is updated by ctx.applyPatch above as patches flow through.)
      const shapesForCritique = canvas.shapes ?? [];

      // Skip critique if the canvas is empty (agent never produced anything —
      // the silent-failure guard above already surfaced the error).
      if (shapesForCritique.length === 0) break;

      // Multi-screen scoping (stress-test fix): the turn's deliverable is the
      // NEW content. Shapes that existed at turn start are the user's prior
      // deliverables — they are NOT defects and must never be "fixed" by
      // deletion or restructuring. Pure edit turns (no new shapes) skip the
      // critique loop entirely — there is nothing new to critique, and a
      // whole-canvas critique would re-litigate prior screens forever.
      const newShapesForCritique = shapesForCritique.filter((s) => !turnStartShapeIds.has(s.id));
      if (newShapesForCritique.length === 0) break;
      const priorShapeIds = [...turnStartShapeIds];

      // Skip critique during an explicit wireframe / low-fi request — the
      // validation gate's typography/shadow rules don't apply to lofi output.
      const lowerPrompt = prompt.toLowerCase();
      const isWireframeRequest =
        /\bwireframe\b|\blow-fi\b|\blow-fidelity\b|\bsketch\b|\bskeleton\b|\bmockup\b|\bgraybox\b/.test(lowerPrompt);
      if (isWireframeRequest) break;

      // ---- 1. Pre-complete validation gate (T10) — FREE, so it runs FIRST --
      // Scoped to the NEW shapes: prior screens' typography/shadows are the
      // user's accepted history, not this turn's defects. min-count is
      // relaxed because edit turns legitimately add only a few shapes.
      const { validateCanvasBeforeComplete } = await import('./validators');
      const validation = validateCanvasBeforeComplete(newShapesForCritique, {
        relaxMinCount: true,
      });

      // ---- Agent Performance Package change 8: critique gating + -----------
      //      parallelism.
      //  - The validation gate is deterministic and free, so it now runs
      //    BEFORE any LLM critic and gates the expensive VLM pass: small
      //    CLEAN edits (validation.ok + < 8 new shapes) skip the
      //    render+vision call entirely — the text critic + validation
      //    already cover them.
      //  - When both critics run, they run CONCURRENTLY (Promise.all)
      //    instead of back-to-back — the text critic (~10-15s) and the VLM
      //    critic (~10-20s incl. screenshot render) overlap, saving one
      //    critic's wall-clock per iteration.
      const smallCleanEdit = validation.ok && newShapesForCritique.length < 8;

      // ---- 2. Text critic + VLM critic (T3), concurrently -------------------
      let textCritiqueSummary = '';
      let textCritiqueSeverity: 'low' | 'medium' | 'high' = 'medium';
      let vlmCritique: any = null;
      let vlmSeverity: 'low' | 'medium' | 'high' = 'medium';
      let vlmScreenshotSource: 'client' | 'server' | undefined;

      // ---- Audit 2-c S2: keep an event sink alive ACROSS the critique phase --
      //
      // The main attempt loop's finally restores the sink the moment the
      // turn ends — so when the VLM critic ran, hasSink() was always false
      // and it judged the resvg APPROXIMATION instead of the real rendered
      // canvas on 100% of mandatory runs. Installing a critique-phase sink
      // (pushed into a queue drained concurrently with the critics — the
      // same pattern the fix-turn uses) lets the critic's
      // agent:screenshot_request round-trip reach the browser while the
      // critics run, so the vision judge sees the REAL canvas.
      //
      // Audit 2-c S11: emit subagent_dispatch cards for the critics too —
      // the SubAgentsCard UI already exists; previously the 15-40s critic
      // phase was silent dead air (the run looked frozen).
      const critiqueQueue = createEventQueue();
      const restoreCritiqueSink = setEventSink((event) => {
        critiqueQueue.push([{ kind: 'agent_event', event }]);
      });
      if (!smallCleanEdit) {
        yield { kind: 'agent_event', event: { type: 'agent:subagent_dispatch', subAgentType: 'design_critic', task: 'Critique current canvas' } as any };
        yield { kind: 'agent_event', event: { type: 'agent:subagent_dispatch', subAgentType: 'design_critic_vlm', task: 'Critique rendered canvas' } as any };
      } else {
        yield { kind: 'agent_event', event: { type: 'agent:subagent_dispatch', subAgentType: 'design_critic', task: 'Critique current canvas' } as any };
      }

      const criticsPromise = Promise.all([
        (async () => {
          try {
            const { dispatchDesignCriticSubAgent } = await import('./subagents/design-critic');
            return await dispatchDesignCriticSubAgent({
              task: 'Critique the current canvas design.',
              canvas,
              originalPrompt: prompt,
              llm: subAgentLLM,
              priorShapeIds,
            });
          } catch (err: any) {
            return { summary: `(text critic failed: ${err.message ?? String(err)})` };
          }
        })(),
        smallCleanEdit
          ? Promise.resolve(null)
          : (async () => {
              try {
                const { dispatchDesignCriticVlmSubAgent } = await import('./subagents/design-critic-vlm');
                return await dispatchDesignCriticVlmSubAgent({
                  task: 'Critique the rendered canvas.',
                  canvas,
                  originalPrompt: prompt,
                  llm: subAgentLLM,
                  priorShapeIds,
                });
              } catch (err: any) {
                // VLM critic failure is non-fatal — the text critic +
                // validation gate still drive the loop. Common failure:
                // @resvg/resvg-js install missing, or the provider doesn't
                // support image_url.
                console.warn('[vlm-critic] failed (non-fatal):', err instanceof Error ? err.message : String(err));
                return null;
              }
            })(),
      ]);
      // Close the queue once the critics settle so the drain loop below
      // exits after yielding everything they emitted mid-flight.
      criticsPromise.then(
        () => setTimeout(() => critiqueQueue.close(), 0),
        () => setTimeout(() => critiqueQueue.close(), 0),
      );
      // Drain the critique queue CONCURRENTLY with the critics — this is
      // what lets the screenshot request reach the client (and its answer
      // return) while awaitClientResponse is still pending.
      for await (const ev of critiqueQueue.drain()) {
        yield ev;
      }
      const [textResult, vlmResult] = await criticsPromise;
      restoreCritiqueSink();

      textCritiqueSummary = textResult?.summary ?? '';
      // The text critic's summary includes a SCORE: line — parse the number.
      const scoreMatch = textCritiqueSummary.match(/SCORE:\s*(\d+)/i);
      if (scoreMatch) {
        const score = parseInt(scoreMatch[1], 10);
        textCritiqueSeverity = score >= 7 ? 'low' : score >= 4 ? 'medium' : 'high';
      }
      // Stress test 2026-08-30: resolve the text critic's SubAgentsCard row —
      // previously only the VLM critic emitted subagent_result, so every
      // design_critic row spun forever after the turn ended.
      if (textResult) {
        const failed = /^\(text critic failed/i.test(textResult.summary ?? '');
        yield {
          kind: 'agent_event',
          event: {
            type: 'agent:subagent_result',
            subAgentType: 'design_critic',
            success: !failed,
            summary: failed
              ? textResult.summary.slice(0, 120)
              : `Text critic finished${scoreMatch ? ` (score ${scoreMatch[1]}/10, severity ${textCritiqueSeverity})` : ''}`,
            toolCalls: 1,
          } as any,
        };
      }
      vlmCritique = vlmResult?.critique ?? null;
      if (vlmCritique) vlmSeverity = vlmCritique.severity;
      vlmScreenshotSource = vlmResult?.screenshotSource;
      if (vlmResult?.success && vlmScreenshotSource) {
        yield { kind: 'agent_event', event: { type: 'agent:subagent_result', subAgentType: 'design_critic_vlm', success: true, summary: `VLM critic finished (score ${vlmCritique?.overallScore ?? '?'}/10, screenshot: ${vlmScreenshotSource})`, toolCalls: 1 } as any };
      }

      // ---- 4. Exit decision --------------------------------------------------
      const defects = [
        ...validation.reasons,
        ...(textCritiqueSeverity !== 'low' ? [`Text critic (severity=${textCritiqueSeverity}): ${textCritiqueSummary.slice(0, 800)}`] : []),
        ...(vlmCritique && vlmSeverity !== 'low' ? [
          `VLM critic (score=${vlmCritique.overallScore}/10, severity=${vlmSeverity}):`,
          ...(vlmCritique.topFixes ?? []).slice(0, 5).map((f: any) => `  - [${f.impact}] ${f.fix}`),
        ] : []),
      ];

      // Emit the critique event so the UI can render the critic's findings.
      // screenshotSource (S2): tells the UI which picture the VLM critic
      // actually judged — 'client' (real DOM capture) vs 'server' (resvg
      // approximation) — so the "VLM 7/10" chip never overclaims.
      yield {
        kind: 'agent_event',
        event: {
          type: 'agent:critique' as any,
          iteration: critiqueIteration,
          defects,
          validation: validation.stats,
          textSeverity: textCritiqueSeverity,
          vlmSeverity,
          vlmScore: vlmCritique?.overallScore,
          vlmScreenshotSource,
        } as any,
      };

      // If both critiques say "low" AND validation passes, we're done.
      const allClear =
        validation.ok &&
        textCritiqueSeverity === 'low' &&
        (vlmCritique ? vlmSeverity === 'low' : true);
      if (allClear) {
        // The design passes — let the existing defensive tail fire + exit.
        break;
      }

      // On the last iteration, we've exhausted the budget — break and let
      // the existing tail fire. The agent's last attempt is what the user sees.
      if (critiqueIteration === maxCritiqueIterations - 1) break;

      // ---- 5. Re-prompt the agent with the defect list ----------------------
      // Emit a new sub-message so the UI shows the critique feedback to the user.
      yield {
        kind: 'agent_event',
        event: { type: 'agent:message_start', role: 'assistant' } as any,
      };
      const fixIntro = `\n\n_[Design critic iteration ${critiqueIteration + 1}/${maxCritiqueIterations}: ${defects.length} defect(s) found. Re-prompting the agent to fix them.]_`;
      yield {
        kind: 'agent_event',
        event: { type: 'agent:message_delta', text: fixIntro } as any,
      };
      yield { kind: 'agent_event', event: { type: 'agent:message_end' } as any };

      // Build a summary of the turn's NEW shapes so the agent has full
      // context (in case the conversation context isn't enough on its own).
      // Include id, type, name, fill, textColor, fontWeight, letterSpacing,
      // textAlign, shadow presence — the fields the defects usually target.
      // PRIOR shapes are deliberately excluded: listing them invites the
      // model to "fix" (or delete) the user's earlier screens.
      const shapeSummaries = newShapesForCritique.slice(0, 40).map((s, i) => {
        const parts = [`${i + 1}. id=${s.id} type=${s.type} name="${s.name ?? ''}"`];
        if (s.fill) parts.push(`fill=${s.fill}`);
        if (s.type === 'text') {
          parts.push(`textColor=${(s as any).textColor}`);
          parts.push(`fontWeight=${(s as any).fontWeight ?? 'default(400)'}`);
          parts.push(`letterSpacing=${(s as any).letterSpacing ?? 'default(0)'}`);
          parts.push(`textAlign=${(s as any).textAlign ?? 'default(left)'}`);
          parts.push(`fontSize=${(s as any).fontSize ?? 16}`);
        }
        if ((s as any).shadow) parts.push('hasShadow');
        if ((s as any).autoLayout) parts.push('hasAutoLayout'); else parts.push('NO_autoLayout');
        return parts.join(' ');
      }).join('\n');

      // Prior-content scope note for the fix message: names the user's earlier
      // deliverables so the model knows exactly what is off-limits.
      const priorTopLevelNames = shapesForCritique
        .filter((s) => turnStartShapeIds.has(s.id) && !s.parentId)
        .map((s) => `"${s.name ?? s.id}"`);
      const priorScopeNote = priorShapeIds.length > 0
        ? `\nSCOPE GUARD (critical): the canvas ALSO contains ${priorShapeIds.length} shapes created in EARLIER turns — the user's previous deliverables${priorTopLevelNames.length > 0 ? ` (${priorTopLevelNames.slice(0, 6).join(', ')}${priorTopLevelNames.length > 6 ? ', …' : ''})` : ''}. Do NOT delete, move, restyle, or replace ANY shape you did not create in THIS turn. Deleting or restructuring prior work is a critical failure — the user asked for a new screen, not a redesign of their existing ones. pen_delete_nodes / pen_clear on prior content will be REJECTED.\n`
        : '';

      // Task 7-e Fix 3 #5: Strengthened fix-message — explicitly enumerate
      // which tools the agent MUST call + a "Do NOT respond with text only"
      // directive.
      //
      // AUDIT FIX (audit 1 P2 / audit 2 T2 / audit 3 S1 — critical): the old
      // message mandated `pen_update_shape` / `pen_create_shape` with
      // `{ shapeId, … }` — names that are NOT registered on the native path
      // (they're filtered-out legacy aliases), so every fix-turn steered the
      // model into guaranteed "Tool not found" errors and stuck-detector
      // aborts. All recipes below now use the REGISTERED canonical contract:
      // pen_update_node { nodeId, changes: { … } } and friends.
      const fixMessage = `The design critic found these defects in your current design:

${defects.map((d, i) => `${i + 1}. ${d}`).join('\n\n')}

Shapes you created THIS turn (${newShapesForCritique.length} — these are the ONLY shapes you may modify):
${shapeSummaries}
${priorScopeNote}
You MUST call at least one of: pen_update_node, pen_bulk_update_by_filter, pen_create_node, pen_set_shadow, pen_apply_palette — to address these defects.

Do NOT respond with text only. Do NOT declare done until you have made at least one tool call to fix each defect.

Specifically (pass shape ids verbatim from the list above):
- If a text shape uses default weight 400, call pen_update_node with { nodeId, changes: { fontWeight: 700 for H1 / 600 for H2 / 500 for labels } }.
- If a text shape has letterSpacing=0, call pen_update_node with { nodeId, changes: { letterSpacing: -0.4 for headings / 0.4 for labels / 0 for body } }.
- If a text shape has no textAlign, call pen_update_node with { nodeId, changes: { textAlign: 'left' for body / 'center' for hero / 'right' for numeric } }.
- If a card lacks shadow, call pen_set_shadow with { shapeId, x:0, y:1, blur:2, color:"#0000000d" } (subtle sm shadow; use y:4/blur:6 only for raised states) — or batch it: pen_bulk_update_by_filter with a name filter matching the cards + changes: { shadow: { x:0, y:1, blur:2, color:"#0000000d" } }.
- If a card/sidebar/topbar has no autoLayout, call pen_update_node with { nodeId, changes: { autoLayout: { direction:"vertical", gap:8, padding:24, alignX:"min", alignY:"min" } } }. NEVER add autoLayout to chart/diagram frames (names containing "chart"/"diagram"/"graph") or any frame whose children are absolutely-positioned geometry (bars, points, paths, axes) — auto-layout restacks that geometry into a vertical column and destroys the chart.
- If a layer extends below its parent screen frame, call pen_update_node with { nodeId, changes: { y, height } } to move/resize it (and its siblings) so ALL content fits inside the frame — or deliberately enlarge the frame with pen_update_node first.
- If your screen is missing core components (KPI cards, chart, table, etc.) per the design brief's informationArchitecture, call pen_create_subtree to add them (ONE call with a nested tree — not many pen_create_node calls).

Apply ALL fixes via tool calls, then end your turn with a 1-sentence summary.`;

      // Task 7-e Fix 3 #7: REUSE the existing pi SDK session instead of
      // creating a new one. This preserves the full conversation context
      // (system prompt + user message + assistant tool calls + tool results)
      // so the LLM can continue from where it left off and actually act on
      // the critique. The previous fixSession approach lost all context and
      // the LLM responded with text-only "I've addressed the issues"
      // without calling any tools.
      //
      // Also: set inCritiqueReprrompt=true so the brief-first enforcement
      // (Fix 2) doesn't reject the gated tool calls during the fix turn.
      inCritiqueReprrompt = true;
      yield { kind: 'agent_event', event: { type: 'agent:message_start', role: 'assistant' } as any };
      // Same translator options as the main attempt loop — the critique fix
      // turn's message_end events also carry usage payloads, and the context
      // window must be the RESOLVED model's (not the translator's 128K
      // default, which would overwrite the UI's correct window on every
      // critique iteration).
      const { queue: fixQueue, unsubscribe: fixUnsubscribe } = subscribeAndTranslate(
        (listener) => session!.subscribe(listener),
        { contextWindow: currentModel.model.contextWindow },
      );
      const fixRestoreSink = setEventSink((event: any) => {
        fixQueue.push([{ kind: 'agent_event', event }]);
      });
      setTodoActiveSession(sessionId);
      setGoalActiveSession(sessionId);
      setBackgroundTaskActiveSession(sessionId);
      setSubagentActiveLLM(subAgentLLM ?? null);
      // Audit 2-c S5: pass a LIVE canvas provider (closure over the runner's
      // `canvas` variable) instead of a stale snapshot — the subagents plugin
      // previously read a turn-START copy, so a mid-turn reviewer critique
      // saw the pre-turn canvas (empty on a fresh document).
      setSubagentActiveCanvas(() => canvas);

      let fixError: any;
      let fixSawActivity = false;
      let fixSawToolCall = false;
      try {
        const fixPromptPromise = session!.prompt(fixMessage, { expandPromptTemplates: false });
        fixPromptPromise.catch((err: any) => { fixError = err; fixQueue.close(); });
        let fixSettled = false;
        void fixPromptPromise.then(() => {
          fixSettled = true;
          setTimeout(() => fixQueue.close(), 0);
        });
        for await (const ev of fixQueue.drain()) {
          if (ev.kind === 'agent_event') {
            if (ev.event.type === 'agent:message_delta') fixSawActivity = true;
            if (ev.event.type === 'agent:tool_call_start') {
              fixSawActivity = true;
              fixSawToolCall = true;
            }
            // Same turn_end withholding as the main drain loop — the
            // fix-turn's agent_end must not close the client's turn while
            // another critique iteration may follow.
            if (ev.event.type === 'agent:turn_end') {
              withheldTurnEnd = true;
              continue;
            }
          }
          yield ev;
          if (fixError) {
            yield {
              kind: 'agent_event',
              event: { type: 'agent:error', message: `Critique-fix prompt failed: ${fixError.message ?? String(fixError)}` },
            };
            break;
          }
        }
        if (!fixSettled) {
          try { await fixPromptPromise; } catch (err: any) { fixError = err; }
        }
      } finally {
        fixQueue.close();
        fixUnsubscribe();
        fixRestoreSink();
        inCritiqueReprrompt = false;
      }

      // Task 7-e Fix 3 #4: No-op fix detection. If the fix turn produced
      // ZERO tool calls (text-only "I've addressed the issues" without
      // actually doing anything), increment a counter. After 2 consecutive
      // no-ops, give up — don't waste the remaining critique iterations on
      // an LLM that won't act on the re-prompt.
      if (!fixSawActivity && !fixError) {
        yield {
          kind: 'agent_event',
          event: {
            type: 'agent:error',
            message: 'Critique-fix turn produced no output (rate-limit / transient outage). Skipping remaining critique iterations.',
          },
        };
        break;
      }
      if (!fixSawToolCall && !fixError) {
        noOpFixAttempts++;
        yield {
          kind: 'agent_event',
          event: {
            type: 'agent:error' as any,
            message: `Critique-fix turn ${critiqueIteration + 1}/${maxCritiqueIterations} produced text but no tool calls (no-op). noOpFixAttempts=${noOpFixAttempts}.`,
          } as any,
        };
        if (noOpFixAttempts >= 2) {
          yield {
            kind: 'agent_event',
            event: {
              type: 'agent:error' as any,
              message: 'Critique-fix: agent made no tool calls in 2 consecutive re-prompts. Stopping critique loop — accepting current canvas state.',
            } as any,
          };
          break;
        }
        // Continue to next iteration — the canvas hasn't changed, but the
        // critics will re-run and the defects will be the same. The next
        // fix-message will be even more directive (it includes the no-op
        // count in the intro).
      } else {
        // Successful fix — reset the no-op counter.
        noOpFixAttempts = 0;
      }

      // The canvas has been updated via ctx.applyPatch as the fix-turn's
      // patches flowed through. Continue to the next critique iteration
      // (which will re-dispatch the critics against the updated canvas).
    }
  }
  } finally {
    // Task 7-e Fix 3: dispose the main session here (after the critique loop
    // has had a chance to reuse it). This is the single disposition point —
    // the attempt loop's inner finally does NOT dispose (so the critique
    // loop can reuse the session).
    if (session) {
      try { session.dispose(); } catch {}
      session = undefined;
    }
    if (unregisterSteer) {
      unregisterSteer();
      unregisterSteer = undefined;
    }
    // Unhook the abort listener — the request-scoped signal outlives this
    // generator (the route's watchdog / client disconnect can fire later)
    // and a stale listener would call abort() on a disposed session.
    if (signal) {
      try { signal.removeEventListener('abort', onAbort); } catch {}
    }
  }

  // Defensive: if the translator never emitted closing events (e.g. the SDK
  // returned without firing agent_end), emit them so the UI doesn't hang —
  // but ONLY the ones actually missing across ALL attempts (guards against
  // double emission; the legacy runner has the same defensive tail).
  // Silent-failure guard: a turn with NO observable output (no text, no
  // thinking, no tool calls, no error already surfaced) from the LAST attempt
  // means every LLM attempt failed upstream — almost always provider
  // rate-limiting (HTTP 429) or a transient outage. The SDK resolves
  // prompt() without throwing, so we must emit the error here or the user
  // sees an empty bubble with no clue.
  // Emitted BEFORE the closing events so the UI records it on the run.
  //
  // Extended (tool-calling reliability): a build-style design turn that
  // settled with ZERO tool calls and an UNCHANGED canvas is a silent
  // failure even when prose streamed — the user asked for a screen and
  // got (at best) a preamble. Previously the guard required
  // `!lastSawActivity`, so a preamble-then-death turn (stream cut at
  // exactly 500 output tokens, 0 tool calls) exited "successfully" and
  // the run hung in in_progress with nothing on the canvas.
  const designTurnNeverDrew =
    expectsCanvasOutput &&
    !lastSawToolCall &&
    (canvas.shapes?.length ?? 0) === turnStartShapeIds.size;
  if (!lastPromptError && !lastSawErrorEvent && !wasAborted() && (!lastSawActivity || designTurnNeverDrew)) {
    const emptyMessage =
      designTurnNeverDrew && lastSawActivity
        ? 'The model responded with text but never called any tools — nothing was drawn on the canvas. ' +
          'This usually means the LLM provider connection dropped mid-generation (truncated output) or the model is rate-limited. ' +
          'Resend your prompt; if it keeps happening, switch to a different model in Settings.'
        : 'The model returned an empty response (no text and no tool calls). ' +
          'This usually means the LLM provider is rate-limited (HTTP 429) or temporarily unavailable. ' +
          'Wait about a minute and resend your prompt; if it keeps happening, try a different model in Settings.';
    const cls = classifyAgentError(emptyMessage);
    yield {
      kind: 'agent_event',
      event: { type: 'agent:error', message: emptyMessage, code: cls.code, retryable: cls.retryable },
    };
  }
  if (!everSawMessageEnd) {
    yield { kind: 'agent_event', event: { type: 'agent:message_end' } };
  }
  // A run stopped server-side (agent:stop / client disconnect / watchdog)
  // ends with turn_cancelled so every viewer finalizes the turn + run as
  // 'cancelled' instead of 'completed'. Emitted BEFORE the turn_end tail so
  // clients that only understand turn_end still close the turn (their
  // terminal-status guard prevents overwriting the cancelled state).
  if (wasAborted()) {
    yield { kind: 'agent_event', event: { type: 'agent:turn_cancelled' } };
  }
  // Exactly ONE turn_end reaches the client: either the translator's (when
  // none were withheld) or the authoritative tail emission below (when they
  // were — the critique loop has finished by this point).
  if (!everSawTurnEnd || withheldTurnEnd) {
    yield { kind: 'agent_event', event: { type: 'agent:turn_end' } };
  }
}
