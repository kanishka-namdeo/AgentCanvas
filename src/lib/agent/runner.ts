// Agent runner — the core agent loop with skill-aware tool routing.
//
// This is the Tier 0 + Tier 1 + Tier 2 integration point. The runner now:
//
//   Tier 0 (prompt-only):
//     - System prompt is organized into XML-tagged skill zones
//     - Includes a "plan first" instruction before tool calls
//     - Skill metadata (Level 1, ~100 tokens each) always loaded
//
//   Tier 1 (tool routing):
//     - Intent classifier routes the prompt to a skill category
//     - Only the relevant skill's tools (+ 9 core tools) are loaded
//     - Reduces per-turn tool count from 56 → ~15-20
//     - Per-tool response token caps (25K chars)
//     - Argument repair (poka-yoke) for array params passed as strings
//
//   Tier 2 (progressive disclosure + planning + sub-agents):
//     - Active skill's full body (Level 2) loaded into the system prompt
//     - Plan module generates step list for multi-step tasks
//     - Web research sub-agent runs in isolated context, returns summary
//
// The module ties together:
//   - The Pi Agent SDK's `defineTool` tool surface (from `./tools.ts`).
//   - The skill system (from `./skills/`).
//   - The intent classifier (from `./classifier.ts`).
//   - The plan module (from `./planner.ts`).
//   - The web research sub-agent (from `./subagents/web-research.ts`).
//   - An LLM driver (`z-ai-web-dev-sdk` in this sandbox).
//   - A patch sink + event stream forwarded to the WebSocket service.

import ZAI from 'z-ai-web-dev-sdk';
import { createCanvasTools, executeTool, toolsToOpenAISpec, type CanvasToolContext } from './tools';
import { createPenTools, PEN_TOOL_NAMES } from './pen-tools';
import type { CanvasDocument, CanvasPatch, Shape, SyncEvent } from '../canvas/types';
import type { AgentRunSettings, DefaultPalette } from '../settings/types';
import { PALETTES } from '../settings/types';
import { createEmptyCanvasDocument } from '../canvas/types';
import { applyPatchToCanvas } from '../canvas/patch';
import { resolvePenTree } from '../pen/resolve';

/// Normalize an incoming canvas into a valid CanvasDocument with a .pen tree
/// and populated derived caches. Handles:
///   - legacy flat-shape docs (no `children`): builds a tree from shapes[]
///   - missing derived caches (shapes/tokens): recomputes via resolvePenTree
///   - missing runtime fields (id/name/viewport): defaults
function normalizeCanvas(input: Partial<CanvasDocument> | null | undefined): CanvasDocument {
  if (!input || typeof input !== 'object') {
    return createEmptyCanvasDocument('default');
  }
  const doc = input as CanvasDocument;
  // Ensure runtime fields.
  if (!doc.id) doc.id = 'default';
  if (!doc.name) doc.name = 'Untitled';
  if (!doc.viewport) doc.viewport = { zoom: 1, panX: 120, panY: 80 };
  if (!doc.version) doc.version = '2.17';
  // Ensure the .pen tree exists.
  if (!Array.isArray(doc.children)) {
    // Legacy flat-shape doc: we can't reconstruct a meaningful tree from
    // absolute-positioned shapes here, so start with an empty tree. (The
    // agent will create new nodes via tools.)
    doc.children = [];
  }
  // Recompute derived caches if missing or stale.
  if (!Array.isArray(doc.shapes) || doc.shapes.length === 0) {
    doc.shapes = resolvePenTree(doc);
  }
  if (!doc.tokens) doc.tokens = { colors: [], textStyles: [] };
  if (!doc.background) doc.background = '#f8fafc';
  return doc;
}
import { classifyIntent } from './classifier';
import { generatePlan, formatPlanForPrompt, updatePlanStepStatus } from './planner';
import { dispatchWebResearchSubAgent } from './subagents/web-research';
import {
  getSkill,
  getToolNamesForCategory,
  formatSkillMetadataForPrompt,
  formatSkillBodyForPrompt,
  type SkillCategory,
  type ClassificationResult,
  type Plan,
} from './skills';

export interface AgentRunOptions {
  documentId: string;
  prompt: string;
  /// Snapshot of the canvas at the start of the turn.
  canvas: CanvasDocument;
  /// Optional LLM client override. Defaults to `z-ai-web-dev-sdk` (ZAI).
  /// Used by tests to inject a deterministic mock; in production this is
  /// always undefined and the runner constructs the ZAI client itself.
  llm?: LLMClient;
  /// Optional abort signal.
  signal?: AbortSignal;
  /// User-tunable run settings (temperature, maxIterations, planFirst,
  /// defaultPalette, skillSelectionMode, LLM provider config). When omitted,
  /// the runner uses the previous hard-coded defaults (0.4 / 20 / true / 'slate'
  /// / 'auto' / zai-auto). This keeps the existing test suite (which doesn't
  /// pass settings) working without modification.
  settings?: AgentRunSettings;
}

/// Minimal LLM client interface the runner needs. Mirrors the OpenAI
/// tool-calling protocol shape that `z-ai-web-dev-sdk` exposes, so the
/// real ZAI client satisfies this interface without adaptation.
///
/// Tests pass a `MockLLM` that returns scripted completions per iteration.
export interface LLMClient {
  chat: {
    completions: {
      create: (params: {
        messages: Array<{
          role: 'system' | 'user' | 'assistant' | 'tool';
          content: string;
          tool_calls?: any[];
          tool_call_id?: string;
        }>;
        tools?: any[];
        tool_choice?: string | any;
        temperature?: number;
      }) => Promise<{
        choices: Array<{
          message: {
            content?: string | null;
            tool_calls?: Array<{
              id: string;
              type: 'function';
              function: { name: string; arguments: string };
            }>;
          };
        }>;
      }>;
    };
  };
}

export interface AgentRunHandle {
  /// Streamed events. The caller reads these and forwards them to viewers.
  stream: AsyncIterable<AgentStreamEvent>;
}

export type AgentStreamEvent =
  | { kind: 'patch'; patch: CanvasPatch; toolCallId?: string }
  | { kind: 'agent_event'; event: SyncEvent };

// ---- System prompt (Tier 0 — reorganized with XML-tagged skill zones) ------
//
// The system prompt now:
//   1. Starts with the agent's role + a "plan first" instruction
//   2. Lists available skills (Level 1 metadata, always loaded)
//   3. Includes the active skill's full body (Level 2, loaded on activation)
//   4. Includes design principles + argument type rules
//   5. Includes the current canvas snapshot
//
// This is a template — the runner fills in ${SKILL_METADATA}, ${SKILL_BODY},
// and ${CANVAS_SNAPSHOT} at runtime.

const SYSTEM_PROMPT_TEMPLATE = `You are an AI design agent operating a Figma-like canvas powered by the Pi Agent SDK.

You can see the current canvas state and manipulate it through tools. Your job is to take the user's natural-language request and produce a visually pleasing, production-ready design on the canvas.

${'${PLAN_FIRST_SECTION}'}

=== AVAILABLE SKILLS =======================================================

The system has selected a skill for this turn based on your request. The active skill's detailed instructions are below. You also have access to core canvas tools (create, update, delete, list, clear, background, select, undo, redo).

All available skills (for reference):
${'${SKILL_METADATA}'}

=== ACTIVE SKILL INSTRUCTIONS ===============================================

${'${SKILL_BODY}'}

${'${PLAN_SECTION}'}

=== DESIGN PRINCIPLES ======================================================

- Be deliberate about layout: use a grid, align shapes, leave breathing room.
- Pick harmonious colors. Default to a modern, minimal palette unless told otherwise.
  Suggested palettes (the first one is your default — prefer it unless the user asks otherwise):
${'${PALETTES_LIST}'}
- When creating multiple shapes, give each a sensible name (e.g. "Header", "Card", "Avatar").
- Coordinates are canvas-space pixels. The viewport at zoom 1 shows roughly 0..1200 x 0..800.
  Center of visible area is around (600, 400). Place groups of shapes around a focal point.
- Always call pen_list_shapes before updating/deleting existing shapes so you know the ids.
- After creating shapes, briefly summarize what you did in 1-2 sentences. Do not narrate every step.
- If the user asks for something you cannot do with the available tools, say so clearly.
- Prefer HIGH-LEVEL generator tools (generate_wireframe, generate_user_flow, generate_diagram)
  over hand-placing many shapes — they produce well-structured output and conserve tool-call budget.
- Use pen_bulk_update_by_filter to update many shapes at once, NOT individual update_shape calls.

=== ARGUMENT TYPE RULES (CRITICAL — read before calling tools) ==============

- All numeric arguments (x, y, width, height, fontSize, opacity, radius, strokeWidth, rotation)
  MUST be passed as JSON numbers, not strings. Write "x": 400, NOT "x": "400".
- Colors are hex strings like "#ff0000" (with the # prefix).
- shapeIds / nodes / palette / points / stops MUST be arrays, even for a single item.
  WRONG: "palette": "[\\"#fff\\", \\"#000\\"]"  (stringified string)
  RIGHT: "palette": ["#fff", "#000"]             (real JSON array)
- For web_search: query is a plain string, recency is "day"|"week"|"month"|"year" (omit for no filter).
- For web_fetch: url is a plain string (https://example.com/page or bare example.com).

=== TURN FLOW ===============================================================

Build the full design in this turn — create every shape the user asked for, then stop.
You may call multiple tools in one turn if it helps. Stop calling tools when the design is done.

IMPORTANT: The skill names above (wireframe, layout, styling, etc.) are NOT tools — do not
call them as function calls. They are context zones that determine which tools you have access to.

If a "WEB RESEARCH SUMMARY" section is present in the user's message, the research has already
been done for you by a sub-agent. Use that summary directly — do NOT call web_search or web_fetch
again. Proceed straight to designing based on the research findings.

=== .pen FORMAT ALIGNMENT (pen.dev) =========================================
This canvas serializes to the pen.dev .pen file format (JSON, version 2.17).
When you build designs, prefer pen.dev terminology so the output is faithful
to the .pen ontology on export:

  - VARIABLES: use pen_set_variable to define design tokens keyed by dotted
    names ("color.primary", "spacing.md", "text.body.size"). Reference them
    via "$name". For theme-aware tokens pass 'themedValues' (e.g. one value
    for mode=light, another for mode=dark). Prefer variables over hardcoded
    colors so the design system stays editable.
  - THEMES: use pen_apply_theme to set a theme axis value (e.g. mode=dark)
    on a frame; descendants inherit it. Common axes: mode (light/dark),
    spacing (regular/condensed), device (phone/tablet/desktop).
  - COMPONENTS & INSTANCES: mark a reusable component with reusable=true
    (via pen_create_component), then create instances with pen_create_ref.
    Customize instances via 'descendants' (keyed by slash-separated ID path,
    e.g. "ok-button/label"). Include a 'type' in an override to fully
    replace a descendant node.
  - SLOTS: use pen_mark_slot on a frame inside a component to mark where
    recommended child components can be inserted (e.g. a content slot in a
    card that accepts round-button instances).
  - FLEXBOX LAYOUT: frames support flexbox via autoLayout (direction, gap,
    padding, alignX, alignY) which maps to .pen's layout/gap/padding/
    justifyContent/alignItems. Prefer flex layouts over manual x/y for
    contained UI.
  - NODE TYPES: the .pen format supports rectangle, ellipse, polygon, path
    (SVG geometry), text, frame, group, note, context, prompt, icon, script,
    ref. Our runtime maps these onto a flat shape list (Phase C will add the
    full tree model); the .pen exporter reconstructs the tree on save.
  - EXPORT: when the user asks to "export as .pen" or "save for pen.dev",
    call pen_export_pen. The UI also has a ".pen" menu in the header for
    manual export/import.

When you need real-world information that is NOT already provided, call web_search / web_fetch
(only available if the web_research skill is active).`;

/// Round to integer for compact snapshot display.
function round(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/// Build a textual snapshot of the canvas for the system message.
function canvasSnapshot(canvas: CanvasDocument): string {
  const shapes = canvas.shapes ?? [];
  const tokens = canvas.tokens ?? { colors: [], textStyles: [] };
  const shapeLines = shapes.length === 0
    ? '  (empty)'
    : shapes.map((s) =>
        `  • ${s.id} | ${s.type} "${s.name}" | pos=(${round(s.x)},${round(s.y)}) size=${round(s.width)}×${round(s.height)} fill=${s.fill}${s.text ? ` text="${s.text}"` : ''}${s.parentId ? ` parent=${s.parentId}` : ''}${s.componentId ? ` component=${s.componentId}` : ''}${s.autoLayout ? ` autoLayout=${s.autoLayout.direction}` : ''}`,
      ).join('\n');
  const tokenLines = tokens.colors.length === 0
    ? '  (no tokens)'
    : tokens.colors.map((c) => `  • ${c.key} = ${c.value}  (${c.name})`).join('\n');
  const varLines = !canvas.variables || Object.keys(canvas.variables).length === 0
    ? '  (no variables)'
    : Object.entries(canvas.variables).map(([k, v]) => {
        const val = Array.isArray(v.value) ? `${(v.value as any[]).length} themed value(s)` : String(v.value);
        return `  • $${k} (${v.type}) = ${val}`;
      }).join('\n');
  const themeLines = !canvas.themes || Object.keys(canvas.themes).length === 0
    ? '  (no theme axes)'
    : Object.entries(canvas.themes).map(([axis, vals]) => `  • ${axis}: [${vals.join(', ')}]`).join('\n');
  return `Current canvas state (.pen v${canvas.version}):
- Background: ${canvas.background}
- Variables (${canvas.variables ? Object.keys(canvas.variables).length : 0}):
${varLines}
- Theme axes:
${themeLines}
- Tokens (derived: ${tokens.colors.length} colors, ${tokens.textStyles.length} text styles):
${tokenLines}
- Resolved nodes (${shapes.length}):
${shapeLines}`;
}

/// Build the palettes list string with the user's default palette first.
/// Example output:
///   • Slate (default): bg #f8fafc, fills #e2e8f0 / #cbd5e1 / #94a3b8, accent #0ea5e9, text #0f172a
///   • Warm: bg #fff7ed, fills #fed7aa / #fdba74 / #fb923c, accent #ea580c, text #431407
///   • Forest: bg #f0fdf4, fills #dcfce7 / #bbf7d0 / #86efac, accent #16a34a, text #052e16
///   • Mono: bg #fafaf9, fills #e7e5e4 / #d6d3d1 / #a8a29e, accent #18181b, text #18181b
function buildPalettesList(defaultPalette: DefaultPalette): string {
  const order: DefaultPalette[] = [defaultPalette, ...(['slate', 'warm', 'forest', 'mono'] as DefaultPalette[]).filter((p) => p !== defaultPalette)];
  return order.map((key) => {
    const p = PALETTES[key];
    const isDefault = key === defaultPalette;
    const fillsStr = p.fills.join(' / ');
    return `  • ${p.name}${isDefault ? ' (default)' : ''}: bg ${p.bg}, fills ${fillsStr}, accent ${p.accent}, text ${p.text}`;
  }).join('\n');
}

/// Build the "PLAN FIRST" section. When planFirst is false, the section is
/// omitted entirely — the agent just calls tools without a preamble.
function buildPlanFirstSection(planFirst: boolean): string {
  if (!planFirst) return '';
  return `=== PLAN FIRST (critical) ==================================================

Before calling any tool, think briefly about:
  1. What the user wants (restate in one sentence)
  2. Which approach / tool sequence will achieve it most efficiently
  3. Whether you need to research anything first (web_search)

Output this plan as a short text message BEFORE your first tool call. This helps you avoid wasteful trial-and-error loops.`;
}

/// Build the full system prompt by filling in the template variables.
function buildSystemPrompt(
  skillMetadata: string,
  skillBody: string,
  planSection: string,
  canvas: CanvasDocument,
  defaultPalette: DefaultPalette,
  planFirst: boolean,
): string {
  return SYSTEM_PROMPT_TEMPLATE
    .replace('${PLAN_FIRST_SECTION}', buildPlanFirstSection(planFirst))
    .replace('${SKILL_METADATA}', skillMetadata)
    .replace('${SKILL_BODY}', skillBody || '(No skill-specific instructions — all tools available.)')
    .replace('${PLAN_SECTION}', planSection)
    .replace('${PALETTES_LIST}', buildPalettesList(defaultPalette))
    + '\n\n' + canvasSnapshot(canvas);
}

/// Filter the tool specs to only include the tools for the active skill.
/// The .pen-aligned tools (pen_*) are ALWAYS available regardless of skill,
/// because they expose pen.dev concepts (variables, themes, refs, slots)
/// that are relevant to every design task.
function filterToolSpecs(
  allSpecs: ReturnType<typeof toolsToOpenAISpec>,
  category: SkillCategory,
): ReturnType<typeof toolsToOpenAISpec> {
  const allowedNames = new Set(getToolNamesForCategory(category));
  const penNameSet = new Set<string>(PEN_TOOL_NAMES);
  return allSpecs.filter(
    (s) => allowedNames.has(s.function.name) || penNameSet.has(s.function.name),
  );
}

// ---- OpenAI-compatible LLM client ------------------------------------------
//
// A minimal fetch-based client that satisfies the LLMClient interface.
// Used when the user configures a custom OpenAI-compatible endpoint
// (Together AI, Groq, Anyscale, local Ollama, etc.).
//
// Only the chat.completions.create shape is implemented — that's all the
// runner needs. Streaming is NOT supported here (the runner calls without
// `stream: true` and reads `choices[0].message`); if the user's endpoint
// defaults to streaming, we explicitly pass `stream: false`.

function createOpenAICompatibleClient(opts: {
  apiKey: string;
  baseURL: string;
  model: string;
}): LLMClient {
  const { apiKey, baseURL, model } = opts;
  const url = baseURL.replace(/\/+$/, '') + '/chat/completions';

  return {
    chat: {
      completions: {
        create: async (params: any) => {
          const body: Record<string, unknown> = {
            model,
            messages: params.messages,
            temperature: params.temperature ?? 0.4,
            stream: false,
          };
          if (params.tools && params.tools.length > 0) {
            body.tools = params.tools;
            body.tool_choice = params.tool_choice ?? 'auto';
          }

          const res = await fetch(url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
            },
            body: JSON.stringify(body),
          });

          if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`OpenAI-compatible LLM error ${res.status}: ${text.slice(0, 300)}`);
          }

          const json = await res.json();
          // The OpenAI response shape is what the runner expects.
          return json;
        },
      },
    },
  };
}

// ---- Run the agent loop ---------------------------------------------------

export async function* runAgent(opts: AgentRunOptions): AsyncGenerator<AgentStreamEvent> {
  const { documentId, prompt, canvas: initialCanvas, llm: injectedLlm, signal, settings } = opts;

  // Resolve settings with defaults. Tests don't pass settings, so we fall back
  // to the previous hard-coded values to keep the existing test suite green.
  const temperature = settings?.temperature ?? 0.4;
  const maxIterations = settings?.maxIterations ?? 20;
  const planFirst = settings?.planFirst ?? true;
  const defaultPalette = settings?.defaultPalette ?? 'slate';
  const skillSelectionMode = settings?.skillSelectionMode ?? 'auto';

  // Per-session mutable state. The tools close over this via `ctx`.
  // Normalize the incoming canvas: ensure it has a .pen tree (`children`)
  // and derived caches (`shapes`, `tokens`). Older callers may send a
  // legacy flat-shape doc or omit the derived fields.
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

  // Create all tools (we'll filter the visible subset based on the skill).
  // The .pen-aligned tools (pen_set_variable, pen_create_ref, …) are always
  // available — they expose pen.dev concepts (variables, themes, refs,
  // slots) that complement the granular pen_* tool surface.
  const canvasTools = createCanvasTools(ctx);
  const penTools = createPenTools(ctx);
  const tools = [...canvasTools, ...penTools] as ReturnType<typeof createCanvasTools>;
  const allToolSpecs = toolsToOpenAISpec(tools);

  // Initialize the LLM client.
  // - If a mock is injected (tests), use it.
  // - If settings specify a custom OpenAI-compatible endpoint, build a fetch-based client.
  // - Otherwise (default), use ZAI.create() — which auto-resolves credentials in
  //   the z.ai sandbox, or uses ZAI_API_KEY / OPENAI_API_KEY env vars outside it.
  let llm: LLMClient;
  if (injectedLlm) {
    llm = injectedLlm;
  } else if (settings?.llmProvider === 'openai-compatible' && settings.apiBaseUrl) {
    llm = createOpenAICompatibleClient({
      apiKey: settings.apiKey,
      baseURL: settings.apiBaseUrl,
      model: settings.modelName || 'gpt-4o',
    });
  } else {
    // zai-auto OR zai-key (both go through ZAI.create; the env var or
    // sandbox auto-resolution handles credentialing. If the user explicitly
    // set ZAI_API_KEY via the settings UI, we'd ideally pass it to ZAI.create,
    // but the current SDK shape doesn't expose that — so we rely on the env
    // var being set. The settings field is still useful as documentation +
    // for the openai-compatible path.)
    llm = (await ZAI.create()) as unknown as LLMClient;
  }

  yield { kind: 'agent_event', event: { type: 'agent:message_start', role: 'assistant' } };

  // ---- TIER 1: Intent classification ---------------------------------------
  //
  // Classify the user's intent to determine which skill (and thus which tool
  // subset) to activate. This reduces the visible tools from 56 → ~15-20.
  //
  // If the user has set skillSelectionMode='manual' in Settings, we skip the
  // classifier and use the 'multi' category — which exposes all core tools +
  // all .pen tools. This is the "no skill pinning" escape hatch for power
  // users who don't want the classifier guessing.

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
        // Don't pass the LLM here — the classifier's keyword pass is enough,
        // and passing the LLM would consume an extra MockLLM script entry in
        // tests + add a round-trip in production. The production LLM fallback
        // for low-confidence cases runs below (guarded by !injectedLlm).
        llm: undefined,
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

    // If no injected LLM (production), try the LLM fallback for low-confidence cases.
    // BUT: skip the LLM fallback if the keyword classifier already detected a
    // multi-step prompt (recommendPlan=true), because the keyword classifier's
    // "last deliverable" logic is more reliable for multi-step prompts than an
    // LLM that might latch onto the first verb (e.g. "Research..." → web_research,
    // even when the final deliverable is "...then design a dashboard" → wireframe).
    if (!injectedLlm && classification.confidence < 0.5 && !classification.recommendPlan && classification.category !== 'multi') {
      try {
        const llmResult = await classifyIntent({
          prompt,
          canvasShapeCount: canvas.shapes.length,
          llm,
          signal,
        });
        if (llmResult.confidence > classification.confidence) {
          classification = llmResult;
        }
      } catch {
        // Keep the keyword result.
      }
    }
  }

  const activeCategory = classification.category;
  const filteredSpecs = filterToolSpecs(allToolSpecs, activeCategory);

  // Emit the skill selection event so the UI can display it.
  yield {
    kind: 'agent_event',
    event: {
      type: 'agent:skill_selected',
      category: activeCategory,
      confidence: classification.confidence,
      method: classification.method,
      toolCount: filteredSpecs.length,
    },
  };

  // ---- TIER 2: Planning phase (for multi-step tasks) -----------------------
  //
  // If the classifier recommends a plan, generate a step list before the
  // main loop starts. The plan is injected into the system prompt so the
  // agent can follow it.

  let plan: Plan | null = null;
  if (classification.recommendPlan) {
    try {
      plan = await generatePlan({
        prompt,
        classification,
        llm,
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

  // ---- TIER 2: Web research sub-agent dispatch ------------------------------
  //
  // If the primary skill is web_research (or it's a secondary skill in a
  // multi-step plan), dispatch the sub-agent to do the research in an
  // isolated context. The summary is injected into the main agent's context.

  let webResearchSummary: string | null = null;
  const needsWebResearch =
    activeCategory === 'web_research' ||
    (classification.secondaryCategories.includes('web_research') && classification.recommendPlan);

  if (needsWebResearch) {
    // Emit sub-agent dispatch event.
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
    });

    webResearchSummary = subAgentResult.summary;

    // Emit sub-agent result event.
    yield {
      kind: 'agent_event',
      event: {
        type: 'agent:subagent_result',
        subAgentType: 'web_research',
        success: subAgentResult.success,
        summary: webResearchSummary.slice(0, 500), // Preview for UI
        toolCalls: subAgentResult.toolCalls,
      },
    };

    // If the primary task WAS web research (not "research then design"),
    // the sub-agent's summary IS the answer. Emit it as the agent's message
    // and end the turn.
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

  // ---- Build the system prompt with skill metadata + body + plan -----------

  const skillMetadata = formatSkillMetadataForPrompt();
  const skillBody = formatSkillBodyForPrompt(activeCategory);
  const planSection = plan ? `=== EXECUTION PLAN =========================================================\nFollow this plan. Complete each step before moving to the next.\n\n${formatPlanForPrompt(plan)}\n` : '';
  const systemContent = buildSystemPrompt(skillMetadata, skillBody, planSection, canvas, defaultPalette, planFirst);

  // Build the initial message history.
  const messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: any[]; tool_call_id?: string }> = [
    { role: 'system', content: systemContent },
  ];

  // If we have a web research summary, inject it as context.
  if (webResearchSummary) {
    messages.push({
      role: 'user',
      content: `WEB RESEARCH SUMMARY (from sub-agent):\n${webResearchSummary}\n\n---\nNow use this information to complete the original request:\n${prompt}`,
    });
  } else {
    messages.push({ role: 'user', content: prompt });
  }

  // ---- Main agent loop -----------------------------------------------------

  // MAX_ITERATIONS comes from settings (default 20). Each iteration is one
  // LLM round-trip + zero or more tool calls. The loop exits early when the
  // LLM produces a message with no tool_calls (= final answer).
  let currentPlanStep = 0;

  for (let iter = 0; iter < maxIterations; iter++) {
    let completion: any;
    try {
      completion = await llm.chat.completions.create({
        messages: messages as any,
        tools: filteredSpecs,
        tool_choice: 'auto',
        temperature,
      });
    } catch (err: any) {
      yield { kind: 'agent_event', event: { type: 'agent:error', message: `LLM request failed: ${err.message}` } };
      return;
    }

    const choice = completion?.choices?.[0];
    const msg = choice?.message;
    if (!msg) {
      yield { kind: 'agent_event', event: { type: 'agent:error', message: 'LLM returned no message' } };
      return;
    }

    // 1. If the model produced text, stream it out.
    if (msg.content) {
      yield { kind: 'agent_event', event: { type: 'agent:message_delta', text: msg.content } };
    }

    // 2. If the model called tools, execute them.
    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) {
      // No tool calls → final answer. End the turn.
      yield { kind: 'agent_event', event: { type: 'agent:message_end' } };

      // Mark the current plan step as completed.
      if (plan && currentPlanStep < plan.steps.length) {
        plan = updatePlanStepStatus(plan, currentPlanStep, 'completed');
        yield {
          kind: 'agent_event',
          event: {
            type: 'agent:plan_step_update',
            step: currentPlanStep + 1,
            status: 'completed',
          },
        };
      }

      yield { kind: 'agent_event', event: { type: 'agent:turn_end' } };
      return;
    }

    // Append the assistant message (with tool_calls) to history.
    messages.push({
      role: 'assistant',
      content: msg.content ?? '',
      tool_calls: toolCalls.map((tc: any) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
    });

    // Execute each tool call sequentially.
    for (const tc of toolCalls) {
      const toolName: string = tc.function.name;
      let args: any;
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch {
        args = {};
      }
      const argsPreview = JSON.stringify(args).slice(0, 120);

      yield {
        kind: 'agent_event',
        event: {
          type: 'agent:tool_call_start',
          toolCallId: tc.id,
          toolName,
          argsPreview,
        },
      };

      const result = await executeTool(tools, toolName, args);

      if (result.patch) {
        yield { kind: 'patch', patch: result.patch, toolCallId: tc.id };
      }

      yield {
        kind: 'agent_event',
        event: {
          type: 'agent:tool_call_end',
          toolCallId: tc.id,
          success: !result.isError,
          summary: result.patch?.summary ?? result.content.slice(0, 160),
        },
      };

      // Append tool result to message history so the next LLM iteration sees it.
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: result.content,
      });
    }

    // Update plan step status if we have a plan.
    if (plan && currentPlanStep < plan.steps.length) {
      const step = plan.steps[currentPlanStep];
      if (step.status === 'pending') {
        plan = updatePlanStepStatus(plan, currentPlanStep, 'in_progress');
        yield {
          kind: 'agent_event',
          event: {
            type: 'agent:plan_step_update',
            step: currentPlanStep + 1,
            status: 'in_progress',
          },
        };
      }
    }

    // Refresh the system snapshot for the next iteration.
    messages[0] = {
      role: 'system',
      content: buildSystemPrompt(skillMetadata, skillBody, plan ? `=== EXECUTION PLAN =========================================================\nFollow this plan. Complete each step before moving to the next.\n\n${formatPlanForPrompt(plan)}\n` : '', canvas, defaultPalette, planFirst),
    };
  }

  // If we hit maxIterations, stop gracefully.
  yield { kind: 'agent_event', event: { type: 'agent:message_end' } };
  yield { kind: 'agent_event', event: { type: 'agent:turn_end' } };
}
