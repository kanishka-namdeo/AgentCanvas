// Agent runner — LEGACY implementation (hand-rolled LLM loop).
//
// This file is the original `runAgent` implementation: a hand-rolled LLM
// loop that calls `llm.chat.completions.create(...)` directly with OpenAI-
// shaped tool specs. It's preserved here for two reasons:
//
// 1. **Test compatibility**: the integration test suite (`tests/integration/`)
//    passes a `MockLLM` that implements the `LLMClient` interface. The new
//    `runAgentNative` in `runner-native.ts` uses `createAgentSession` from
//    `@earendil-works/pi-coding-agent`, which expects a pi-ai `Model` object
//    — not an OpenAI-shaped `LLMClient`. MockLLM can't satisfy that
//    interface, so tests still go through this legacy loop.
//
// 2. **Reference / fallback**: if the pi-ai path ever needs to be disabled
//    (e.g. a breaking change in the SDK), production can be temporarily
//    routed through `runAgentLegacy` by passing `injectedLlm` to the public
//    `runAgent` wrapper in `runner.ts`.
//
// All shared helpers (system prompt template, canvas snapshot, skill
// filtering, LLM client construction) are exported below and consumed by
// `runner-native.ts` so the two paths produce identical prompts and identical
// tool surfaces.

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

// Re-export the shared types from runner-types.ts so existing imports
// (`import { runAgent, type LLMClient } from '@/lib/agent/runner'`) keep
// working without modification.
export type { LLMClient, AgentStreamEvent, AgentRunOptions } from './runner-types';
import type { LLMClient, AgentStreamEvent, AgentRunOptions } from './runner-types';

/// Normalize an incoming canvas into a valid CanvasDocument with a .pen tree
/// and populated derived caches. Handles:
///   - legacy flat-shape docs (no `children`): builds a tree from shapes[]
///   - missing derived caches (shapes/tokens): recomputes via resolvePenTree
///   - missing runtime fields (id/name/viewport): defaults
export function normalizeCanvas(input: Partial<CanvasDocument> | null | undefined): CanvasDocument {
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

export interface AgentRunHandle {
  /// Streamed events. The caller reads these and forwards them to viewers.
  stream: AsyncIterable<AgentStreamEvent>;
}

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
//
// Exported so `runner-native.ts` can reuse the same prompt.

export const SYSTEM_PROMPT_TEMPLATE = `You are an AI design agent operating a Figma-aligned canvas. You think and act like a senior product designer at a top studio: you reason in terms of FRAMES, LAYERS, COMPONENTS, VARIANTS, VARIABLES, STYLES, AUTO LAYOUT, and PAGES — never in terms of generic "shapes" or "tokens".

Your job: take the user's natural-language request and produce a visually polished, production-ready, HIGH-FIDELITY design on the canvas. You can see the current canvas state and manipulate it through ~70 typed tools.

${'${PLAN_FIRST_SECTION}'}

=== FIDELITY POLICY (CRITICAL — read first) =================================

You ALWAYS produce HIGH-FIDELITY designs by default. A high-fidelity design has:
  - Full color palette applied (60% background / 30% surfaces / 10% accent), NOT grayscale.
  - Drop shadows on every elevated surface (cards, modals, FABs, app bars, dropdowns).
  - Gradients on hero areas, primary CTAs, and brand/logo marks (never on body text or full-page bg).
  - Realistic domain content (real names, real numbers, real labels) — NEVER "Lorem ipsum" or "Item 1".
  - The user's exact strings: when the prompt names a product/brand ("an app called 'Vaultly'") or gives
    concrete copy ("Revenue $128.4K", "Sign In"), those EXACT strings MUST appear as text layers — the
    brand name typically as the wordmark at the top of the design. Never omit, rename, or paraphrase them.
  - A consistent type scale (12 / 14 / 16 / 20 / 24 / 30 / 38 px) with weights 400/500/600/700.
  - An 8px spacing grid (4, 8, 12, 16, 24, 32, 48, 64) for all x/y/width/height/padding/gap.
  - Corner radii from a scale (sm 6 / md 8 / lg 12 / xl 16 / 2xl 20) — larger for containers, pills=9999.
  - Named iconography (lucide set via pen_search_icons) at consistent stroke widths — not emoji.

You produce a LOW-FIDELITY WIREFRAME (grayscale, flat, no shadows) ONLY when the user EXPLICITLY asks for one
using words like "wireframe", "low-fi", "low-fidelity", "sketch", "skeleton", "mockup", "rough draft",
"quick draft", "boxy", "graybox", or "blocking". If unsure, default to HIGH fidelity — it is always
cheaper to simplify a rich design than to add polish to a bare one.

WIREFRAME MODE (when triggered): use ONLY grayscale fills from the neutral ramp (#f8fafc / #e5e7eb /
#d1d5db / #9ca3af / #6b7280 / #374151 / #111827), 1px #d1d5db borders for definition, solid black text.
If a template fits the request, call pen_generate_wireframe / pen_generate_user_flow with fidelity="lofi"
(the generator then emits a grayscale wireframe for you). Otherwise scaffold manually with grayscale fills.
Do NOT define color tokens, do NOT call pen_apply_palette, do NOT add shadows, gradients, or icons.
Realistic labels still apply (real words, not "Lorem ipsum") — just monochrome.

You have NO vision — you cannot see images the user pastes and you cannot see your own output. You produce
visually rich results purely by committing to specific coordinates, colors, shadows, gradients, radii, and
typography values drawn from the design system below. Never leave a visual property unspecified "to be
decided later" — pin every value to a token or a concrete number so the rendered output matches your intent.

=== HIGH-FIDELITY DESIGN SYSTEM (your default vocabulary) ====================

SEMANTIC COLOR TOKENS — define these via pen_set_variable / pen_update_tokens on EVERY design, then bind
shapes to them. Never scatter raw hex across shapes; raw hex lives only in the token definition.

  $color.bg            page background (dominant 60%)        e.g. #f8fafc (light) / #0b0f1a (dark)
  $color.surface       cards, elevated panels (secondary 30%) e.g. #ffffff / #1e293b
  $color.surface-2     nested surfaces, inputs                e.g. #f1f5f9 / #334155
  $color.border        hairline dividers, input borders        e.g. #e2e8f0 / #334155
  $color.text          primary text                            e.g. #0f172a / #f1f5f9
  $color.text-muted    secondary text, labels                  e.g. #475569 / #94a3b8
  $color.text-subtle   placeholders, captions                  e.g. #94a3b8 / #64748b
  $color.primary       brand accent, primary CTA (10%)         e.g. #0ea5e9 / #38bdf8
  $color.primary-fg    text/icon on primary fill               e.g. #ffffff
  $color.accent        secondary accent, links                 e.g. #6366f1 / #818cf8
  $color.success       positive states, trends                 e.g. #10b981
  $color.danger        destructive actions, errors             e.g. #ef4444
  $color.warning       cautions, pending                       e.g. #f59e0b

PALETTE DISTRIBUTION (60-30-10): bg covers ~60% of pixels; surface+surface-2 cover ~30%; primary+accent
cover ~10%. If your design is mostly one color, rebalance. WCAG AA: body text vs bg ≥ 4.5:1; large/UI ≥ 3:1.

TYPE SCALE (1.25 Major Third, 16px base) — use these EXACT sizes:
  caption 12  | label 14 | body 16 | subtitle 20 | h3 24 | h2 30 | h1 38 | display 48
  weights: body 400, labels 500, subtitles/section-heads 600, page titles 700.
  line-height: 1.6 for body, 1.25 for headings. Font: Inter / system-ui sans-serif.

SPACING SCALE (8px grid) — use ONLY these values for x/y/w/h/padding/gap:
  4, 8, 12, 16, 24, 32, 48, 64, 80, 96. Page padding: 16 (mobile) / 24-32 (web). Section gap: 24-32.

RADIUS SCALE:
  sm 6 (inputs, chips) | md 8 (buttons) | lg 12 (cards) | xl 16 (modals, large cards) | 2xl 20 (sheets) | pill 9999 (avatars, toggles).

ELEVATION / SHADOW SCALE — apply via pen_set_shadow. A shape with NO shadow looks flat/wireframe-y.
  flat      none                                  (page bg, list rows)
  sm        0 1 2 0 #0000000d                     (cards resting, chips)
  md        0 4 6 -1 #0000001a                     (raised cards, sticky headers)
  lg        0 10 15 -3 #00000026                   (dropdowns, popovers)
  xl        0 20 25 -5 #00000033                   (modals, FABs)
  The shadow COLOR uses 8-digit hex with alpha (#RRGGBBAA). Use #0000001a for a soft 10% black.

GRADIENT GUIDANCE: use pen_set_gradient_fill on hero backgrounds, primary CTA fills, logo/avatar marks.
  CTA gradient example: linear, angle 135, stops [{0, $color.primary}, {1, $color.accent}].
  Hero gradient example: linear, angle 165, stops [{0, #0ea5e9}, {1, #6366f1}].
  NEVER gradient body text. NEVER gradient the entire page background (use a solid $color.bg).

ICONOGRAPHY: call pen_search_icons (name) to get a lucide stroked polyline. Stroke width 2, size 20-24.
  Do NOT use emoji (✨📷🔔) as icons — they render inconsistently. Use named lucide icons.

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

- HIGH FIDELITY BY DEFAULT. Every design you produce must look like a finished product, not a sketch.
  That means: full color palette, shadows on elevated surfaces, gradients on hero/CTA, real content,
  consistent type scale, 8px spacing grid, radii from the scale. See the FIDELITY POLICY above.
- Be deliberate about layout: use the 8px grid, align layers, leave breathing room (24-32px section gaps).
- Pick harmonious colors. Default to a modern, minimal palette unless told otherwise.
  Suggested palettes (the first one is your default — prefer it unless the user asks otherwise):
${'${PALETTES_LIST}'}
- When creating multiple layers, give each a sensible Figma-style name (e.g. "Header", "Card",
  "Avatar", "Primary Button", "Submit Button / Hover").
- BRAND FIDELITY: when the user names a product, brand, or app (e.g. "a fintech app called
  'Vaultly'"), that exact name MUST appear as real text in the design — typically as the
  wordmark/logo lockup at the top of the screen or in the header. Never omit, abbreviate, or
  substitute the brand name. If the user gives concrete copy (numbers, labels, names), use those
  EXACT strings in text layers — do not invent replacements.
- Coordinates are canvas-space pixels. The viewport at zoom 1 shows roughly 0..1200 x 0..800.
  Center of visible area is around (600, 400). Place groups of layers around a focal point.
- ALWAYS call pen_list_shapes before updating/deleting existing layers so you know the ids.
  (pen_list_shapes returns the resolved layer tree — same as Figma's layers panel.)
- After creating layers, briefly summarize what you did in 1-2 sentences. Do not narrate every step.
- If the user asks for something you cannot do with the available tools, say so clearly.
- GENERATE THEN STYLE. You may use pen_generate_wireframe to scaffold a layout fast, but that is only
  step 1. You MUST then: (a) define $color.* tokens via pen_set_variable, (b) apply a palette via
  pen_apply_palette with bindToTokens=true, (c) add shadows to every card/button/modal via pen_set_shadow,
  (d) add gradients to the hero/CTA/logo via pen_set_gradient_fill, (e) replace placeholder text with
  realistic domain copy via pen_generate_copy, (f) add lucide icons via pen_search_icons. A bare
  generate_wireframe output with no styling pass is NOT a finished design — it is a wireframe.
- Use pen_bulk_update_by_filter to update many layers at once, NOT individual update_shape calls.
- For reusable UI (buttons, cards, inputs): define a COMPONENT once, then create INSTANCES.
  Don't duplicate the same rectangle-stack 5 times — make it a component.
- For multi-state components (default / hover / disabled / sizes): use a COMPONENT_SET with
  variant axes. Name variants "Size=Large, State=Hover" per Figma convention.
- For multi-screen flows: create separate PAGES (Home, Dashboard, Settings) rather than cramming
  everything onto one canvas. Use figma_create_page.
- Bind fills/strokes/text to $variables (color.primary, text.body.size) so the design system
  stays editable. Avoid hardcoded hex values when a variable exists.
- SELF-CRITIQUE IS MANDATORY for high-fidelity work. After you finish the styling pass, call
  pen_self_critique. Address every [BLOCKER] and [MAJOR] finding before declaring the design done.
  Skip the critique ONLY if the user explicitly asked for a quick wireframe.

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

Build the full HIGH-FIDELITY design in this turn. The mandatory sequence is:

  1. SCAFFOLD (optional) — if a template matches, call pen_generate_wireframe to lay out the structure.
     If no template fits, place frames + shapes manually with pen_create_shape using coordinates from
     the 8px grid. Set type/size/fill/radius on every shape you create — never leave them default.
     COPY RULE: templates ship PLACEHOLDER text. When the user gave exact copy (names, numbers, labels),
     pass it via the generator's 'texts' param in the SAME call (keyed by layer name, e.g.
     {"Stat 1 value": "$128.4K"}) — or update the text layers with pen_find_replace_text / pen_update_shape
     immediately after. A design showing template placeholder values ($12.4k, 1,284) instead of the
     user's numbers is a FAILURE, even if the layout is perfect.
  2. TOKENIZE — define $color.* variables (bg, surface, surface-2, border, text, text-muted, primary,
     primary-fg, accent, success, danger) via pen_set_variable / pen_update_tokens.
  3. PALETTE — call pen_apply_palette with bindToTokens=true so shapes bind to the tokens.
  4. ELEVATE — add shadows to every card, button, modal, FAB, dropdown, sticky header via pen_set_shadow.
     A design with zero shadows is a wireframe, not a finished product.
  5. GRADIENTS — add a gradient to the hero area / primary CTA / logo via pen_set_gradient_fill.
  6. CONTENT — replace any "Lorem ipsum" / "Item 1" / "Label" placeholder text with realistic domain
     copy via pen_generate_copy or pen_update_shape (text field). Use real names, real numbers, real labels.
  7. ICONS — add lucide icons (pen_search_icons) for nav items, buttons, status indicators. Not emoji.
  8. CRITIQUE — call pen_self_critique. Address every [BLOCKER] and [MAJOR] finding with another tool call.
  9. SUMMARIZE — give the user a 1-2 sentence summary of what you designed.

You may call multiple tools per turn. Stop calling tools when the design is done AND the critique
has no outstanding [BLOCKER]/[MAJOR] findings. For an EXPLICIT wireframe / low-fi / sketch request,
after step 1 use ONLY grayscale fills (see WIREFRAME MODE above) and skip steps 2-8 entirely — no
tokens, no palette, no shadows, no gradients, no critique — then summarize.

NEVER repeat a failed tool call with identical arguments — if a call errors, change the arguments or
switch to a different tool. Two identical calls in a row is always a bug in your plan, not a retry.

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
export function round(v: unknown): number {
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
export function canvasSnapshot(canvas: CanvasDocument): string {
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
export function buildPalettesList(defaultPalette: DefaultPalette): string {
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
export function buildPlanFirstSection(planFirst: boolean): string {
  if (!planFirst) return '';
  return `=== PLAN FIRST (critical) ==================================================

Before calling any tool, think briefly about:
  1. What the user wants (restate in one sentence)
  2. Which approach / tool sequence will achieve it most efficiently
  3. Whether you need to research anything first (web_search)

Output this plan as a short text message BEFORE your first tool call. This helps you avoid wasteful trial-and-error loops.`;
}

/// Build the full system prompt by filling in the template variables.
export function buildSystemPrompt(
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
export function filterToolSpecs(
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
import { callLLMWithRetry as sharedCallLLMWithRetry } from './llm-retry';
import { calculateContextTokens, shouldCompact, compactToolResults, formatTokens } from './context-manager';

// ---- Sub-agent LLM client construction -------------------------------------
//
// The web-research and design-critic sub-agents use OpenAI-shaped LLM
// clients (their own internal `chat.completions.create` loop via
// `callLLMWithRetry`). This is SEPARATE from the main runner's pi-ai Model:
//
//   Main agent (production) → pi-ai Model + createAgentSession (handles streaming)
//   Sub-agent               → OpenAI-shaped LLMClient (legacy loop, isolated context)
//
// The sub-agents need their own client because:
//   1. Their loop is hand-rolled around `callLLMWithRetry` (small + simple).
//   2. They run in isolated contexts — the main `ModelRuntime` shouldn't be
//      touched by a sub-agent's retry / temperature settings.
//
// This helper is provider-aware: it constructs an LLMClient using the user's
// settings (provider + apiKey + baseURL + model), falling back to ZAI.create()
// for the z.ai sandbox auto-credential path. Exported so the new native
// runner can pass the same client to the sub-agent as the legacy runner did.

export async function buildSubAgentLLMClient(settings?: AgentRunSettings): Promise<LLMClient> {
  const rawProvider = settings?.llmProvider ?? 'custom';
  const providerId = normalizeLLMProvider(rawProvider);
  const meta = getProviderMetadata(providerId);

  // z.ai sandbox path: no API key → ZAI.create() auto-resolves from
  // ~/.z-ai-config / /etc/.z-ai-config / sandbox env.
  const isZaiSandbox = providerId === 'zai' && !settings?.apiKey;
  if (isZaiSandbox) {
    return (await ZAI.create()) as unknown as LLMClient;
  }

  // Build config from user settings + provider defaults.
  const config: LLMProviderConfig = {
    providerId,
    apiKey: settings?.apiKey ?? '',
    baseURL: settings?.apiBaseUrl || meta?.defaultBaseURL || '',
    model:
      settings?.modelName ||
      meta?.defaultModel ||
      providerDefaultModel(providerId),
  };

  try {
    const registryClient: RegistryLLMClient = await createLLMClient(config);
    return registryClient as unknown as LLMClient;
  } catch (err) {
    // Fallback to ZAI.create() if the provider is 'zai' (sandbox case).
    if (providerId === 'zai') {
      return (await ZAI.create()) as unknown as LLMClient;
    }
    throw err;
  }
}

// ---- Run the agent loop ---------------------------------------------------

/// Wrapper preserved for backward compat — see llm-retry.ts for the shared impl.
export async function callLLMWithRetry(llm: LLMClient, params: {
  messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: any[]; tool_call_id?: string }>;
  tools?: any[];
  tool_choice?: string | any;
  temperature?: number;
}): Promise<any> {
  return sharedCallLLMWithRetry(llm, params);
}

export async function* runAgentLegacy(opts: AgentRunOptions): AsyncGenerator<AgentStreamEvent> {
  const { documentId, prompt, canvas: initialCanvas, llm: injectedLlm, signal, settings } = opts;

  // Resolve settings with defaults. Tests don't pass settings, so we fall back
  // to the previous hard-coded values to keep the existing test suite green.
  const temperature = settings?.temperature ?? 0.4;
  const maxIterations = settings?.maxIterations ?? 20;
  const planFirst = settings?.planFirst ?? true;
  const thinkingLevel = settings?.thinkingLevel ?? 'medium';
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
    // Use the shared provider-aware helper (also used by runner-native.ts).
    llm = await buildSubAgentLLMClient(settings);
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

  // Load file-based skills (.pi/skills/*.md) and append their guidelines
  // to the system prompt. This supplements the hardcoded skills.
  let fileSkillsSection = '';
  try {
    const { getFileSkills } = await import('./file-skills');
    const fileSkills = getFileSkills();
    if (fileSkills.length > 0) {
      fileSkillsSection = '\n\n=== FILE-BASED SKILL GUIDELINES ============================================\n' +
        fileSkills.map((s) =>
          `--- ${s.name} ---\n${s.guidelines.map((g, i) => `${i + 1}. ${g}`).join('\n')}`
        ).join('\n\n');
    }
  } catch {
    // File skills are optional — ignore errors.
  }

  const systemContent = buildSystemPrompt(skillMetadata, skillBody, planSection, canvas, defaultPalette, planFirst) + fileSkillsSection;

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
      // Map the thinking level to the z-ai SDK's thinking parameter.
      // 'off' → disabled; anything else → enabled (the model decides the budget).
      const thinkingParam = thinkingLevel === 'off' ? { type: 'disabled' as const } : { type: 'enabled' as const };
      // When a mock LLM is injected (tests), skip retry — test errors are
      // deterministic and should propagate immediately. In production, the
      // retry wrapper handles 429/5xx/transient errors with exponential backoff.
      if (injectedLlm) {
        completion = await llm.chat.completions.create({
          messages: messages as any,
          tools: filteredSpecs,
          tool_choice: 'auto',
          temperature,
          thinking: thinkingParam,
        } as any);
      } else {
        completion = await callLLMWithRetry(llm, {
          messages: messages as any,
          tools: filteredSpecs,
          tool_choice: 'auto',
          temperature,
          thinking: thinkingParam,
        } as any);
      }
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

    // ---- Context management (Phase 1) ----------------------------------------
    // Track token consumption + compact if approaching the context window.
    const tokenCount = calculateContextTokens(messages);
    const CONTEXT_WINDOW = 128_000; // GLM-4.6 context window
    yield {
      kind: 'agent_event',
      event: {
        type: 'agent:context_update',
        tokenCount,
        contextWindow: CONTEXT_WINDOW,
      },
    };
    if (shouldCompact(tokenCount, CONTEXT_WINDOW)) {
      const { messages: compacted, tokensSaved } = compactToolResults(messages);
      messages.splice(0, messages.length, ...compacted);
      const newTokenCount = calculateContextTokens(messages);
      yield {
        kind: 'agent_event',
        event: {
          type: 'agent:context_update',
          tokenCount: newTokenCount,
          contextWindow: CONTEXT_WINDOW,
          compacted: true,
        },
      };
      yield {
        kind: 'agent_event',
        event: {
          type: 'agent:message_delta',
          text: `\n\n_[Context compacted: ${formatTokens(tokensSaved)} tokens saved]_`,
        },
      };
    }
  }

  // If we hit maxIterations, stop gracefully.
  yield { kind: 'agent_event', event: { type: 'agent:message_end' } };
  yield { kind: 'agent_event', event: { type: 'agent:turn_end' } };
}
