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
import { createFigmaTools, FIGMA_TOOL_NAMES } from './figma-tools';
import type { CanvasDocument, CanvasPatch, Shape, SyncEvent } from '../canvas/types';
import type { AgentRunSettings, DefaultPalette } from '../settings/types';
import { PALETTES, normalizeLLMProvider, providerDefaultModel } from '../settings/types';
import { createLLMClient, getProviderMetadata } from '../llm';
import type { LLMClient as RegistryLLMClient, LLMProviderConfig } from '../llm';
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

const SYSTEM_PROMPT_TEMPLATE = `You are an AI design agent operating a Figma-aligned canvas. You think and act like a senior product designer at a top studio: you reason in terms of FRAMES, LAYERS, COMPONENTS, VARIANTS, VARIABLES, STYLES, AUTO LAYOUT, and PAGES — never in terms of generic "shapes" or "tokens".

Your job: take the user's natural-language request and produce a visually polished, production-ready design on the canvas. You can see the current canvas state and manipulate it through ~70 typed tools.

${'${PLAN_FIRST_SECTION}'}

=== AVAILABLE SKILLS =======================================================

The system has selected a skill for this turn based on your request. The active skill's detailed instructions are below. You also have access to core canvas tools (create, update, delete, list, clear, background, select, undo, redo).

All available skills (for reference):
${'${SKILL_METADATA}'}

=== ACTIVE SKILL INSTRUCTIONS ===============================================

${'${SKILL_BODY}'}

${'${PLAN_SECTION}'}

=== FIGMA ONTOLOGY (CRITICAL — reason in these terms) ======================

The canvas is a Figma-like design surface. Use this vocabulary throughout:

FILE → PAGES → LAYERS (the tree)
  - FILE: the design document (one .pen file). Contains pages, variables, themes, component definitions.
  - PAGE: a top-level canvas surface within the file. Multi-screen designs belong on separate pages (e.g. "Home", "Dashboard", "Mobile flows"). Each page has its own layer tree + pan/zoom.
  - LAYER: any node in the page's layer tree. ALL nodes are "layers" — frames, rectangles, text, components, etc. Avoid the word "shape"; say "layer".

LAYER TYPES (the Figma-canonical node union):
  Containers (can have children):
    - FRAME       — the primary container. Hosts AUTO LAYOUT. Default for any UI grouping.
    - SECTION     — a large grouping container with a header label. Use to organize areas of the canvas ("Onboarding flow", "Dashboard sections").
    - COMPONENT   — a reusable design element. Define once, place many instances.
    - COMPONENT_SET — a container for VARIANTS of a component (e.g. Button with Size × State axes).
    - GROUP       — a loose grouping without its own properties. Use sparingly; prefer FRAME.
    - BOOLEAN_OPERATION — non-destructive union/subtract/intersect/exclude of child vectors.
  Leaves (no children):
    - RECTANGLE, ELLIPSE, LINE, STAR, POLYGON, PATH (SVG geometry), TEXT, SLICE (export region), INSTANCE (a placed component copy).

COMPONENTS & VARIANTS:
  - A COMPONENT is defined once (via figma_create_component). It can have COMPONENT PROPERTIES:
      • Boolean   — toggle (e.g. "showIcon": true/false)
      • Text      — string content (e.g. "label": "Submit")
      • Instance swap — swap to another component (e.g. "icon": <icon component id>)
      • Variant   — picks a variant from the component_set (e.g. "state": "default" | "hover" | "disabled")
      • Slot      — Figma SLOT (added 2024) — placeholder for instance swap locations.
                    Default value is a component ID or empty string.
  - A COMPONENT_SET holds multiple COMPONENT variants. Variant axes are defined on the set
    (e.g. ["size", "state"]). Each variant child is named "Size=Large, State=Hover"
    (Figma's naming convention — the agent MUST follow this).
  - An INSTANCE (PenRef) is a placed copy of a component. Override component properties
    via componentProperties (NOT via descendants — descendants are for deep tree overrides only).

VARIABLES & STYLES (the design-system layer):
  - VARIABLES: single reusable values, keyed by dotted names ("color.primary", "spacing.md",
    "text.body.size"). 4 types: color, number, string, boolean. Reference via "$name".
    Can be theme-conditional (one value for mode=light, another for mode=dark).
  - THEMES: axis → value (e.g. mode=light/dark, spacing=regular/condensed, device=phone/tablet).
    Apply to a frame via pen_apply_theme; descendants inherit.
  - The legacy "tokens" concept is collapsed into Variables here. When you see "tokens" in
    the canvas snapshot, treat them as Variables.

AUTO LAYOUT (Figma's flexbox):
  - Frames (and Components, Component Sets, Sections) support AUTO LAYOUT:
    direction (horizontal/vertical), gap, padding, alignX, alignY.
  - Prefer AUTO LAYOUT over manual x/y positioning for any contained UI (cards, lists, buttons,
    nav bars, form fields). Only use absolute x/y for top-level placement on the page canvas.

HIERARCHY & POSITIONING:
  - Children's stored x/y are RELATIVE to their parent's content origin. The resolver flattens
    to absolute coordinates for rendering.
  - Use pen_reparent_shape to move a layer to a new parent (default preserves absolute position).
  - Use pen_ungroup_shapes to dissolve a group — children promote to the grandparent.

=== DESIGN PRINCIPLES ======================================================

- Be deliberate about layout: use a grid, align layers, leave breathing room.
- Pick harmonious colors. Default to a modern, minimal palette unless told otherwise.
  Suggested palettes (the first one is your default — prefer it unless the user asks otherwise):
${'${PALETTES_LIST}'}
- When creating multiple layers, give each a sensible Figma-style name (e.g. "Header", "Card",
  "Avatar", "Primary Button", "Submit Button / Hover").
- Coordinates are canvas-space pixels. The viewport at zoom 1 shows roughly 0..1200 x 0..800.
  Center of visible area is around (600, 400). Place groups of layers around a focal point.
- ALWAYS call pen_list_shapes before updating/deleting existing layers so you know the ids.
  (pen_list_shapes returns the resolved layer tree — same as Figma's layers panel.)
- After creating layers, briefly summarize what you did in 1-2 sentences. Do not narrate every step.
- If the user asks for something you cannot do with the available tools, say so clearly.
- Prefer HIGH-LEVEL generator tools (generate_wireframe, generate_user_flow, generate_diagram)
  over hand-placing many layers — they produce well-structured output and conserve tool-call budget.
- Use pen_bulk_update_by_filter to update many layers at once, NOT individual update_shape calls.
- For reusable UI (buttons, cards, inputs): define a COMPONENT once, then create INSTANCES.
  Don't duplicate the same rectangle-stack 5 times — make it a component.
- For multi-state components (default / hover / disabled / sizes): use a COMPONENT_SET with
  variant axes. Name variants "Size=Large, State=Hover" per Figma convention.
- For multi-screen flows: create separate PAGES (Home, Dashboard, Settings) rather than cramming
  everything onto one canvas. Use figma_create_page.
- Bind fills/strokes/text to $variables (color.primary, text.body.size) so the design system
  stays editable. Avoid hardcoded hex values when a variable exists.

=== ARGUMENT TYPE RULES (CRITICAL — read before calling tools) ==============

- All numeric arguments (x, y, width, height, fontSize, opacity, radius, strokeWidth, rotation)
  MUST be passed as JSON numbers, not strings. Write "x": 400, NOT "x": "400".
- Colors are hex strings like "#ff0000" (with the # prefix).
- shapeIds / nodes / palette / points / stops MUST be arrays, even for a single item.
  WRONG: "palette": "[\\"#fff\\", \\"#000\\"]"  (stringified string)
  RIGHT: "palette": ["#fff", "#000"]             (real JSON array)
- For web_search: query is a plain string, recency is "day"|"week"|"month"|"year" (omit for no filter).
- For web_fetch: url is a plain string (https://example.com/page or bare example.com).
- Variant names follow Figma's convention: "Property=Value, Property=Value" (comma-separated,
  Property is capitalized, Value is capitalized). E.g. "Size=Large, State=Hover".

=== TURN FLOW ===============================================================

Build the full design in this turn — create every layer the user asked for, then stop.
You may call multiple tools in one turn if it helps. Stop calling tools when the design is done.

IMPORTANT: The skill names above (wireframe, layout, styling, etc.) are NOT tools — do not
call them as function calls. They are context zones that determine which tools you have access to.

If a "WEB RESEARCH SUMMARY" section is present in the user's message, the research has already
been done for you by a sub-agent. Use that summary directly — do NOT call web_search or web_fetch
again. Proceed straight to designing based on the research findings.

=== .pen FORMAT ALIGNMENT (pen.dev) =========================================
This canvas serializes to the pen.dev .pen file format (JSON, version 2.17).
The .pen format is the runtime source of truth — doc.children: PenChild[] is the layer tree.
A derived flat list (doc.shapes with absolute coords + depth-first zIndex) is recomputed by
resolvePenTree on every mutation. (Note: "shapes" is the legacy field name; conceptually
these ARE "layers" in Figma vocabulary — the field is kept for backward compat.)

When you build designs, prefer .pen terminology so the output is faithful to the .pen ontology
on export. The .pen node types are: frame, section, component, component_set, group,
boolean_operation, slice, rectangle, ellipse, star, polygon, path, line, text, note, context,
prompt, icon, script, ref (instance).

VARIABLES: use pen_set_variable to define design tokens keyed by dotted names
("color.primary", "spacing.md", "text.body.size"). Reference them via "$name".

THEMES: use pen_apply_theme to set a theme axis value (e.g. mode=dark) on a frame;
descendants inherit it.

COMPONENTS & INSTANCES: use figma_create_component to define a reusable component.
Create instances with pen_create_ref. Override component properties via componentProperties
on the ref (NOT descendants). Use descendants only for deep tree overrides.

COMPONENT SETS & VARIANTS: use figma_create_component_set to create a container for
variants. Add variants via figma_add_variant (each becomes a COMPONENT child). Define
variant axes on the set; each variant's name follows "Property=Value, Property=Value".

SLOTS: use pen_mark_slot on a frame inside a component to mark where recommended
child components can be inserted. Maps to Figma's "preferred instances" concept.

PAGES: use figma_create_page to add a new page to the file. Use figma_set_active_page
to switch the active page. Use pages for multi-screen designs — one page per screen.

FLEXBOX LAYOUT: frames/components/component_sets/sections support flexbox via autoLayout
(direction, gap, padding, alignX, alignY). Prefer flex layouts over manual x/y for contained UI.

EXPORT: when the user asks to "export as .pen" or "save for pen.dev", call pen_export_pen.

When you need real-world information that is NOT already provided, call web_search / web_fetch
(only available if the web_research skill is active).`;

/// Round to integer for compact snapshot display.
function round(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/// Build a textual snapshot of the canvas for the system message.
///
/// Renders the canvas as a TREE (indented by depth), mirroring Figma's layers
/// panel. Children appear nested under their parent frame/group, with their
/// absolute coords (resolved by `resolvePenTree`) and constraint info shown
/// inline. This lets the LLM reason about the hierarchy directly instead of
/// having to mentally reconstruct it from `parent=` annotations on a flat list.
function canvasSnapshot(canvas: CanvasDocument): string {
  const shapes = canvas.shapes ?? [];
  const tokens = canvas.tokens ?? { colors: [], textStyles: [] };

  // Index shapes by id and by parent for tree traversal.
  const byId = new Map(shapes.map((s) => [s.id, s] as const));
  const childrenOf = (parentId: string | null | undefined) =>
    shapes
      .filter((s) => (s.parentId ?? null) === (parentId ?? null))
      .sort((a, b) => b.zIndex - a.zIndex); // top-most paint layer first (matches Layers panel)

  const formatNode = (s: Shape, depth: number): string => {
    const indent = '  '.repeat(depth + 1);
    const bullet = depth === 0 ? '•' : '◦';
    const parent = s.parentId ? byId.get(s.parentId) : null;
    const parentLabel = parent ? ` (in ${parent.type} "${parent.name}")` : '';
    const constraintsLabel = s.constraints
      ? ` constraints=${s.constraints.horizontal}/${s.constraints.vertical}`
      : '';
    const textLabel = s.text ? ` text="${s.text}"` : '';
    const componentLabel = s.componentId ? ` component=${s.componentId}` : '';
    const autoLayoutLabel = s.autoLayout ? ` autoLayout=${s.autoLayout.direction}` : '';
    // Figma ontology extension fields:
    const sectionLabel = s.type === 'section' && s.label ? ` label="${s.label}"` : '';
    const variantAxesLabel = s.type === 'component_set' && s.variantPropertyAxes
      ? ` variantAxes=[${s.variantPropertyAxes.join(',')}]`
      : '';
    const variantValuesLabel = s.variantPropertyValues
      ? ` variant=${Object.entries(s.variantPropertyValues).map(([k, v]) => `${k}=${v}`).join(',')}`
      : '';
    const componentPropsLabel = s.componentPropertyDefinitions
      ? ` componentProps=[${Object.keys(s.componentPropertyDefinitions).join(',')}]`
      : '';
    const instancePropsLabel = s.componentProperties
      ? ` instanceProps=${JSON.stringify(s.componentProperties)}`
      : '';
    const booleanTypeLabel = s.booleanOperationType
      ? ` boolean=${s.booleanOperationType}`
      : '';
    const starLabel = s.type === 'star' && s.pointCount ? ` points=${s.pointCount}` : '';
    const polygonLabel = s.type === 'polygon' && s.polygonCount ? ` sides=${s.polygonCount}` : '';
    return `${indent}${bullet} ${s.id} | ${s.type} "${s.name}" | pos=(${round(s.x)},${round(s.y)}) size=${round(s.width)}×${round(s.height)} fill=${s.fill}${textLabel}${parentLabel}${componentLabel}${autoLayoutLabel}${constraintsLabel}${sectionLabel}${variantAxesLabel}${variantValuesLabel}${componentPropsLabel}${instancePropsLabel}${booleanTypeLabel}${starLabel}${polygonLabel}`;
  };

  const renderTree = (parentId: string | null, depth: number): string => {
    const kids = childrenOf(parentId);
    if (kids.length === 0) return '';
    return kids.map((s) => formatNode(s, depth) + '\n' + renderTree(s.id, depth + 1)).join('').trimEnd() + '\n';
  };

  const treeLines = shapes.length === 0 ? '  (empty)' : renderTree(null, 0).trimEnd();
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
  return `Current canvas state (.pen v${canvas.version}) — File: "${canvas.name}"${canvas.pages && canvas.pages.length > 0 ? `, Pages: ${canvas.pages.length} (active: "${canvas.pages[canvas.activePageIndex ?? 0]?.name ?? 'Page 1'}")` : ''}:
- Background: ${canvas.background}
- Variables (${canvas.variables ? Object.keys(canvas.variables).length : 0}):
${varLines}
- Theme axes:
${themeLines}
- Tokens (derived: ${tokens.colors.length} colors, ${tokens.textStyles.length} text styles):
${tokenLines}
- Layer tree (${shapes.length} layer(s), indented = nesting):
${treeLines}`;
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
  const penNameSet = new Set<string>([...PEN_TOOL_NAMES, ...FIGMA_TOOL_NAMES]);
  return allSpecs.filter(
    (s) => allowedNames.has(s.function.name) || penNameSet.has(s.function.name),
  );
}

// ---- LLM client construction --------------------------------------------------
//
// The runner now delegates to the provider registry in `src/lib/llm/`.
// Every supported provider (OpenAI, Anthropic, Google, Mistral, Groq,
// Together, DeepSeek, OpenRouter, Fireworks, xAI, Perplexity, Hugging Face,
// Ollama, LM Studio, vLLM, z.ai, and a generic "custom" escape hatch) is
// registered there with its metadata + factory. The runner just resolves
// the provider id (migrating legacy values like 'zai-auto' / 'openai-compatible'),
// fills in defaults if the user didn't specify them, and calls
// `createLLMClient(config)`.
//
// The legacy `createOpenAICompatibleClient` helper below is preserved as
// a thin wrapper for backward compatibility — tests and any external
// consumers that imported it directly still work. New code should use
// `createLLMClient` from `@/lib/llm` instead.

function createOpenAICompatibleClient(opts: {
  apiKey: string;
  baseURL: string;
  model: string;
}): LLMClient {
  // Delegate to the shared factory in src/lib/llm/openai-compatible.ts.
  // For safety, we use createOpenAICompatible directly to preserve the
  // exact sync behavior of the legacy function.
  return createOpenAICompatibleSync({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
    model: opts.model,
  });
}

/// Synchronous wrapper around the OpenAI-compatible client factory.
/// Imported lazily to avoid a circular dep.
import { createOpenAICompatible as createOpenAICompatibleSync } from '../llm/openai-compatible';

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
  // The Figma-aligned tools (figma_create_page, figma_create_component, …)
  // are also always available — they expose Figma-canonical concepts
  // (Pages, Sections, Components, Component Sets, Variants, Component
  // Properties) that the agent needs to reason like a Figma designer.
  const canvasTools = createCanvasTools(ctx);
  const penTools = createPenTools(ctx);
  const figmaTools = createFigmaTools(ctx);
  const tools = [...canvasTools, ...penTools, ...figmaTools] as ReturnType<typeof createCanvasTools>;
  const allToolSpecs = toolsToOpenAISpec(tools);

  // Initialize the LLM client.
  // - If a mock is injected (tests), use it.
  // - Otherwise, resolve the provider from settings (with legacy migration),
  //   fill in defaults, and call the registry's factory.
  let llm: LLMClient;
  if (injectedLlm) {
    llm = injectedLlm;
  } else {
    const rawProvider = settings?.llmProvider ?? 'zai';
    const providerId = normalizeLLMProvider(rawProvider);
    const meta = getProviderMetadata(providerId);

    // For z.ai inside the sandbox, we still prefer ZAI.create() because it
    // auto-resolves credentials in a way the fetch-based client can't
    // (sandbox-only headers, etc.). Outside the sandbox, we fall through
    // to the registry's openai-compatible factory for z.ai too.
    const isZaiSandbox = providerId === 'zai' && !settings?.apiKey;
    if (isZaiSandbox) {
      llm = (await ZAI.create()) as unknown as LLMClient;
    } else {
      // Build the config: user overrides > provider defaults.
      const config: LLMProviderConfig = {
        providerId,
        apiKey: settings?.apiKey ?? '',
        baseURL: settings?.apiBaseUrl || meta?.defaultBaseURL || '',
        model:
          settings?.modelName ||
          meta?.defaultModel ||
          providerDefaultModel(providerId),
      };
      // Use the registry. This handles OpenAI-compat + native Anthropic/Google
      // uniformly. We also fall back to ZAI.create() if the registry call
      // fails (e.g. when running in the z.ai sandbox without an explicit key).
      try {
        const registryClient: RegistryLLMClient = await createLLMClient(config);
        llm = registryClient as unknown as LLMClient;
      } catch (err) {
        // Last-resort fallback: if the registry fails and we're on z.ai,
        // try ZAI.create() which auto-resolves sandbox credentials.
        if (providerId === 'zai') {
          llm = (await ZAI.create()) as unknown as LLMClient;
        } else {
          throw err;
        }
      }
    }
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

  // Escape valve: track consecutive failures of the SAME tool with the SAME
  // args. If a tool fails 3x in a row identically, abort the turn to prevent
  // infinite retry loops (the LLM gets stuck calling the same failing tool
  // over and over, e.g. "no shape with id [\"abc\"]" was retried 16+ times
  // before the LLM hit a rate-limit 429 and the turn died).
  // The escape valve surfaces a clear error message to the LLM so it can
  // either try a different approach or finalize the turn gracefully.
  let consecutiveSameToolFailures = 0;
  let lastFailedToolName: string | null = null;
  let lastFailedArgsJson: string | null = null;
  const MAX_SAME_TOOL_FAILURES = 3;

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

      // Emit ALL patches the tool produced. Most tools emit exactly one patch
      // (returned as `result.patch`). A few tools emit multiple — e.g.
      // pen_update_shape, when the LLM passes a `parent` arg, emits BOTH an
      // `update` patch (for the recognized fields) AND a `reparent` patch
      // (for the parent change). The wrapper coalesces these into
      // `result.patches` (plural); we fall back to `result.patch` (singular)
      // for the common single-patch case.
      const emittedPatches = result.patches && result.patches.length > 0
        ? result.patches
        : (result.patch ? [result.patch] : []);
      for (const p of emittedPatches) {
        yield { kind: 'patch', patch: p, toolCallId: tc.id };
      }

      yield {
        kind: 'agent_event',
        event: {
          type: 'agent:tool_call_end',
          toolCallId: tc.id,
          success: !result.isError,
          summary: emittedPatches.at(-1)?.summary ?? result.content.slice(0, 160),
        },
      };

      // ---- Escape valve: track consecutive failures of the same tool+args.
      // If a tool fails 3x in a row with identical args, inject a system
      // message telling the LLM to stop retrying and try a different approach
      // (or finalize). This prevents the infinite-retry loop the LLM falls
      // into when a tool keeps failing (e.g. shapeId mismatch).
      const argsJson = JSON.stringify(args);
      if (result.isError) {
        if (toolName === lastFailedToolName && argsJson === lastFailedArgsJson) {
          consecutiveSameToolFailures++;
        } else {
          consecutiveSameToolFailures = 1;
          lastFailedToolName = toolName;
          lastFailedArgsJson = argsJson;
        }
        if (consecutiveSameToolFailures >= MAX_SAME_TOOL_FAILURES) {
          // Inject a clear "stop retrying" message + finalize the turn.
          messages.push({
            role: 'user',
            content: `The tool "${toolName}" has failed ${consecutiveSameToolFailures} times in a row with the same arguments. Stop retrying the same call. Either try a DIFFERENT tool, fix the arguments (the shape ID may not exist — call pen_list_shapes to see valid IDs), or finalize your response with what you have so far. Do NOT call "${toolName}" again with the same arguments.`,
          });
          // Reset so the next iteration gets a fresh chance (different tool / args).
          consecutiveSameToolFailures = 0;
          lastFailedToolName = null;
          lastFailedArgsJson = null;
        }
      } else {
        // Tool succeeded — reset the failure tracker.
        consecutiveSameToolFailures = 0;
        lastFailedToolName = null;
        lastFailedArgsJson = null;
      }

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
