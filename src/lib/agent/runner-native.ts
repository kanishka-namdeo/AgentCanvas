// Agent runner — NATIVE implementation using `createAgentSession` from
// `@earendil-works/pi-coding-agent`.
//
// This is the production path. It replaces the legacy hand-rolled LLM loop
// with the SDK's native agent session, while:
//
//   - Reusing the same 88 ToolDefinitions (already defined with `defineTool`).
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
import { createPenTools, PEN_TOOL_NAMES } from './pen-tools';
import { createFigmaTools, FIGMA_TOOL_NAMES } from './figma-tools';
import type { CanvasDocument, CanvasPatch } from '../canvas/types';
import type { AgentRunSettings } from '../settings/types';
import { normalizeLLMProvider, DEFAULT_SETTINGS } from '../settings/types';
import { applyPatchToCanvas } from '../canvas/patch';
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
import { subscribeAndTranslate } from './agent-session-translator';
import type { AgentStreamEvent, AgentRunOptions } from './runner-types';
import {
  normalizeCanvas,
  buildSystemPrompt,
  buildSubAgentLLMClient,
} from './runner-legacy';
// Plugin integration.
import {
  getEnabledPluginTools,
  getEnabledPluginToolNames,
} from './plugins';
import { setEventSink } from './plugins/event-bus';
import { setActiveSession as setTodoActiveSession } from './plugins/todo';
import { setActiveSession as setGoalActiveSession } from './plugins/goal-list-loop-audit';
import { setActiveSession as setBackgroundTaskActiveSession } from './plugins/background-tasks';
import { setActiveLLM as setSubagentActiveLLM, setActiveCanvas as setSubagentActiveCanvas } from './plugins/subagents';
import { getMemoryContextForPrompt } from './plugins/memory';

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

  // 1. Normalize canvas + build tool context (identical to legacy runner).
  let canvas: CanvasDocument = normalizeCanvas(initialCanvas);
  const ctx: CanvasToolContext = {
    getShapes: () => canvas.shapes ?? [],
    getTokens: () => canvas.tokens ?? { colors: [], textStyles: [] },
    getDocument: () => canvas,
    applyPatch(patch: CanvasPatch): CanvasPatch {
      canvas = applyPatchToCanvas(canvas, patch);
      return patch;
    },
  };

  // 2. Create all 88 tools. These are already `ToolDefinition[]` (defined
  //    via `defineTool` from `@earendil-works/pi-coding-agent`), so they
  //    can be passed straight to `createAgentSession({ customTools })`.
  const canvasTools = createCanvasTools(ctx);
  const penTools = createPenTools(ctx);
  const figmaTools = createFigmaTools(ctx);
  // Plugin tools (ask_user_question, todo, memory, mega-compact,
  // goal-list-loop-audit, mcp-adapter, background-tasks, subagents).
  // These are added to the customTools array alongside the canvas tools
  // and always-available (not subject to skill filtering).
  const pluginTools = getEnabledPluginTools(settings);
  const allTools: ToolDefinition[] = [
    ...canvasTools,
    ...penTools,
    ...figmaTools,
    ...pluginTools,
  ] as unknown as ToolDefinition[];
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
        llm: undefined, // keyword pass first; LLM fallback below if needed
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
    // For the LLM fallback, we'd need an OpenAI-shaped client. Since the
    // main agent now uses pi-ai, we can't easily pass a client here without
    // a pi-ai → OpenAI-shape adapter. The keyword pass is reliable enough
    // for production; the LLM fallback was a safety net for ambiguous
    // prompts. If confidence is low, the 'multi' fallback exposes all tools.
  }

  const activeCategory: SkillCategory = classification.category;

  // 5. Filter the tool set to the active skill (plus always-on pen_* + figma_*
  //    + all plugin tools). Plugin tools are always available regardless of
  //    the active skill — they're cross-cutting (ask_user_question, todo,
  //    memory, etc.) and the agent should be able to use them in any context.
  const allowedToolNames = new Set<string>([
    ...getToolNamesForCategory(activeCategory),
    ...PEN_TOOL_NAMES,
    ...FIGMA_TOOL_NAMES,
    ...pluginToolNames,
  ]);
  const filteredTools = allTools.filter((t) => allowedToolNames.has(t.name));

  // Emit skill selection event (UI parity with legacy runner).
  yield {
    kind: 'agent_event',
    event: {
      type: 'agent:skill_selected',
      category: activeCategory,
      confidence: classification.confidence,
      method: classification.method,
      toolCount: filteredTools.length,
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

  // 8. Build the system prompt (identical to legacy runner — uses the same
  //    template, skill metadata, plan section, and canvas snapshot). Plus
  //    memory context (long-term MEMORY.md + scratchpad + today's log).
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
  // recall of user preferences and past design decisions.
  let memorySection = '';
  try {
    const memCtx = getMemoryContextForPrompt();
    if (memCtx) {
      memorySection = '\n\n=== LONG-TERM MEMORY (from memory plugin) ==================================\n' + memCtx;
    }
  } catch {
    // Memory plugin failed to load — non-fatal.
  }

  const systemContent =
    buildSystemPrompt(skillMetadata, skillBody, planSection, canvas, defaultPalette, planFirst) +
    fileSkillsSection +
    memorySection;

  // 9. Resolve the pi-ai Model + ModelRuntime from settings.
  //    Throws if no auth is configured (e.g. user picked OpenAI but didn't
  //    provide an API key).
  let model: Awaited<ReturnType<typeof resolveModel>>;
  try {
    model = await resolveModel(settings);
  } catch (err: any) {
    yield {
      kind: 'agent_event',
      event: { type: 'agent:error', message: `Model resolution failed: ${err.message}` },
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
  const userMessage = webResearchSummary
    ? `WEB RESEARCH SUMMARY (from sub-agent):\n${webResearchSummary}\n\n---\nNow use this information to complete the original request:\n${prompt}`
    : prompt;

  const sessionId = opts.documentId ?? `session-${Date.now()}`;

  let didFallback = false;
  let everSawMessageEnd = false;
  let everSawTurnEnd = false;
  let lastSawActivity = false;
  let lastSawErrorEvent = false;
  let lastPromptError: any = undefined;
  let currentModel = model;

  // Up to 2 attempts: primary, then (conditionally) one z.ai sandbox retry.
  for (let attempt = 0; attempt < 2; attempt++) {
    // Per-attempt translator state — re-create per attempt so a fresh
    // `agent_end` from the second attempt's SDK emits its own `turn_end`
    // without being suppressed by the first attempt's state.
    let sawMessageEnd = false;
    let sawTurnEnd = false;
    let sawActivity = false;
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
    let session: AgentSession | undefined;
    try {
      const result = await createAgentSession({
        cwd: process.cwd(),
        model: currentModel.model,
        modelRuntime: currentModel.modelRuntime,
        thinkingLevel: mapThinkingLevel(thinkingLevel),
        noTools: 'all',
        customTools: filteredTools,
        tools: filteredTools.map((t) => t.name),
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
    } catch (err: any) {
      yield {
        kind: 'agent_event',
        event: { type: 'agent:error', message: `Failed to create agent session: ${err.message}` },
      };
      lastSawErrorEvent = true;
      // Session-creation failures are usually model-resolution issues (already
      // handled by the resolver try/catch above) or runtime config issues —
      // not endpoint-down cases. Don't retry; surface the error and exit.
      break;
    }

    // 13. Subscribe to AgentSessionEvents via the translator. The translator
    //     pushes AgentStreamEvents onto an async queue; we drain it below.
    const { queue, unsubscribe } = subscribeAndTranslate((listener) =>
      session!.subscribe(listener),
    );

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
    setSubagentActiveCanvas(canvas);

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
      const promptPromise = session.prompt(userMessage, {
        // Disable prompt-template expansion — we built the system prompt
        // ourselves and don't want pi to expand `/skill:foo` commands.
        expandPromptTemplates: false,
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
          if (ev.event.type === 'agent:message_end') sawMessageEnd = true;
          if (ev.event.type === 'agent:turn_end') sawTurnEnd = true;
          if (ev.event.type === 'agent:error') sawErrorEvent = true;
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
        if (promptError) {
          // prompt() threw — surface the error and stop.
          yield {
            kind: 'agent_event',
            event: { type: 'agent:error', message: `Agent prompt failed: ${promptError.message ?? String(promptError)}` },
          };
          sawErrorEvent = true;
          break;
        }
      }

      // If prompt() resolved without error but we never saw an agent:turn_end
      // event (e.g. the SDK short-circuited), emit one defensively.
      if (!promptError && !settled) {
        // prompt() is still pending but the queue drained — unusual. Wait
        // for prompt() to settle so we surface any error.
        try {
          await promptPromise;
        } catch (err: any) {
          yield {
            kind: 'agent_event',
            event: { type: 'agent:error', message: `Agent prompt failed: ${err.message ?? String(err)}` },
          };
          sawErrorEvent = true;
          promptError = err;
        }
      }
    } finally {
      unsubscribe();
      queue.close();
      restoreEventSink();
      try {
        session.dispose();
      } catch {
        // dispose() can throw if the session was already disposed (e.g.
        // aborted). Ignore.
      }
    }

    // Update cumulative state across attempts.
    if (sawMessageEnd) everSawMessageEnd = true;
    if (sawTurnEnd) everSawTurnEnd = true;
    lastSawActivity = sawActivity;
    lastSawErrorEvent = sawErrorEvent;
    lastPromptError = promptError;

    // Decide whether to fall back to the z.ai sandbox for a second attempt.
    // Bounded: at most ONE retry per turn (attempt === 0 only), and only if
    // the previous attempt produced ZERO user-visible output (no text deltas,
    // no tool calls). Skipped when the resolver already swapped to the
    // z.ai sandbox preflight (currentModel.usedFallback) — that would be a
    // second fallback for the same turn, violating the one-retry bound.
    // Also skipped when the configured provider is already 'zai' (no point
    // falling back to the same provider).
    const shouldFallback =
      attempt === 0 &&
      !didFallback &&
      !currentModel.usedFallback &&
      providerId !== 'zai' &&
      !sawActivity;

    if (!shouldFallback) break;

    // Try to resolve a z.ai-sandbox fallback model. If ZAI.create() throws
    // (not in the z.ai sandbox / no creds), log and skip — the silent-failure
    // guard below will surface an error to the user.
    const fallbackModel = await resolveZaiSandboxFallback();
    if (!fallbackModel) break;

    console.warn(
      `[llm-fallback] primary endpoint ${currentModel.label} produced no output (zero message_delta + zero tool_call events); retrying turn with z.ai sandbox / glm-5.3`,
    );
    currentModel = fallbackModel;
    didFallback = true;
    // Loop continues to attempt 1 with the fallback model.
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
  if (!lastPromptError && !lastSawErrorEvent && !lastSawActivity) {
    yield {
      kind: 'agent_event',
      event: {
        type: 'agent:error',
        message:
          'The model returned an empty response (no text and no tool calls). ' +
          'This usually means the LLM provider is rate-limited (HTTP 429) or temporarily unavailable. ' +
          'Wait about a minute and resend your prompt; if it keeps happening, try a different model in Settings.',
      },
    };
  }
  if (!everSawMessageEnd) {
    yield { kind: 'agent_event', event: { type: 'agent:message_end' } };
  }
  if (!everSawTurnEnd) {
    yield { kind: 'agent_event', event: { type: 'agent:turn_end' } };
  }
}
