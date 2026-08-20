# AGENTS.md — `src/lib/agent/`

## Purpose

The agent layer: defines the 64 tools the AI agent can call against the canvas, and runs the skill-aware agent loop that turns a natural-language prompt into a stream of canvas patches + chat events.

This is the contract layer between the LLM and the canvas. Tool names, parameter schemas, skill definitions, and the system prompt's tool catalog are the public surface — changing them is a breaking change for prior session replays.

## Architecture (Tier 0 + Tier 1 + Tier 2)

The agent now uses a **skill-aware routing architecture** (see worklog.md, Task IDs: research-skills, assess-skills, implement-skills):

```
User prompt
    │
    ▼
┌─────────────────────┐
│ Intent Classifier    │  Tier 1: keyword/regex → LLM fallback
│ (classifier.ts)      │  Returns: SkillCategory + confidence + recommendPlan
└────────┬────────────┘
         │
    ┌────┴────┐
    │ Plan?   │  Tier 2: for multi-step prompts, generate step list
    │ (planner│  (Manus-style planning module)
    │ .ts)    │
    └────┬────┘
         │
    ┌────┴────────┐
    │ Sub-agent?  │  Tier 2: for web_research, dispatch isolated LLM context
    │ (subagents/ │  Returns synthesized summary (not raw page content)
    │ web-research)│
    └────┬────────┘
         │
         ▼
┌─────────────────────┐
│ Main Agent Loop      │  Tier 0: XML-tagged system prompt with skill zones
│ (runner.ts)          │  + "plan first" instruction
│                      │  Tier 1: only ~15-20 tools loaded (core + active skill)
│                      │  + response token caps (25K chars)
│                      │  + argument repair (poka-yoke for stringified arrays)
└─────────────────────┘
```

## Ownership

- `tools.ts` — 57 `defineTool()` definitions (55 canvas tools + web_search + web_fetch) + `executeTool` dispatcher (with response caps + argument repair). Owned by this folder.
- `pen-tools.ts` — 8 additional .pen-aligned tools (pen_set_variable, pen_apply_theme, pen_create_ref, pen_override_descendant, pen_mark_slot, pen_export_pen, pen_set_theme_axis, pen_list_themes). These expose pen.dev concepts (variables, themes, refs, slots) that complement the granular pen_* tool surface.
- `figma-tools.ts` — Figma-canonical tools (10 tools): figma_create_page, figma_set_active_page, figma_rename_page, figma_delete_page, figma_create_section, figma_create_component, figma_create_component_set, figma_add_variant, figma_set_component_property, figma_set_instance_property. Exposes Figma's Pages, Sections, Components, Component Sets, Variants, and Component Properties ontology. Exports `createFigmaTools(ctx)` + `FIGMA_TOOL_NAMES` array. Always loaded (not skill-gated) — the agent needs Figma-level reasoning for every design task.
- `runner.ts` — the agent loop. Owns the system prompt template, LLM driver, event stream shape, skill integration, plan/sub-agent dispatch.
- `classifier.ts` — intent classifier (keyword pass + LLM fallback). Routes prompts to skill categories.
- `planner.ts` — plan module. Generates step lists for multi-step tasks.
- `skills/` — skill system (types, registry, metadata formatters).
- `subagents/` — sub-agent implementations (currently just web-research).

## Local Contracts

### Tool surface (76 tools — do not rename/remove without parent-level decision)
All canvas tools are prefixed with `pen_` (e.g., `pen_create_shape`, `pen_update_shape`). The web tools (`web_search`, `web_fetch`) have no prefix. Figma tools use `figma_` prefix.

- **Core (9)**: pen_create_shape, pen_update_shape, pen_delete_shape, pen_list_shapes, pen_clear, pen_set_background, pen_select_shape, pen_undo, pen_redo
- **Wireframe (13)**: pen_generate_wireframe, pen_generate_user_flow, pen_generate_diagram, pen_generate_copy, pen_create_shape, pen_update_shape, pen_upload_image, pen_search_icons, pen_generate_image, pen_update_tokens, pen_apply_palette, pen_generate_palette, pen_reparent_shape
- **Layout (15)**: pen_align_shapes, pen_group_shapes, pen_ungroup_shapes, pen_duplicate_shape, pen_organize_layers, pen_apply_auto_layout, pen_bring_to_front, pen_send_to_back, pen_move_forward, pen_move_backward, pen_reorder_shape, pen_set_locked, pen_set_visible, pen_reparent_shape, pen_set_constraints
- **Styling (13)**: pen_apply_palette, pen_generate_palette, pen_update_tokens, pen_apply_token, pen_bind_shape_to_token, pen_unbind_shape, pen_list_tokens, pen_set_gradient_fill, pen_set_shadow, pen_set_blur, pen_set_corner_radius_per_corner, pen_find_replace_text, pen_bulk_update_by_filter
- **Inspect (4)**: pen_list_shapes, pen_find_shapes, pen_audit_design, pen_list_tokens
- **Export (4)**: pen_export_json, pen_export_svg, pen_export_png, pen_copy_as_code
- **Vector (5)**: pen_create_path, pen_boolean_op, pen_mask_with, pen_create_shape, pen_update_shape
- **Web (2)**: web_search, web_fetch
- **Components (2 legacy)**: pen_create_component, pen_instantiate_component
- **Component System (7 — Phase 2, Figma-aligned)**: pen_convert_to_component, pen_place_component_instance, pen_override_instance, pen_reset_instance, pen_detach_instance, pen_combine_as_variants, pen_swap_variant
- **Pen-aligned (8)**: pen_set_variable, pen_apply_theme, pen_create_ref, pen_override_descendant, pen_mark_slot, pen_export_pen, pen_set_theme_axis, pen_list_themes
- **Figma-canonical (10)**: figma_create_page, figma_set_active_page, figma_rename_page, figma_delete_page, figma_create_section, figma_create_component, figma_create_component_set, figma_add_variant, figma_set_component_property, figma_set_instance_property

### Skill categories (7 + multi)
wireframe, layout, styling, inspect, export, web_research, vector, multi

### executeTool enhancements (Tier 1)
- **Response token cap**: `MAX_TOOL_RESULT_CHARS = 25_000` — tool results are truncated to prevent context bloat
- **Argument repair (poka-yoke)**: `repairArrayArgs()` detects and fixes array params passed as stringified JSON strings (e.g. `palette="[\"#fff\"]"` → `palette=["#fff"]`). Known-affected params: palette, shapeIds, nodes, updates, stops, points, shapeId, descendants

### System prompt (Tier 0)
- Defined as `SYSTEM_PROMPT_TEMPLATE` in `runner.ts`
- Uses `${PLAN_FIRST_SECTION}`, `${SKILL_METADATA}`, `${SKILL_BODY}`, `${PLAN_SECTION}`, `${PALETTES_LIST}` placeholders filled at runtime
- XML-tagged zones: `<available_skills>`, `<active_skill>`, `<plan>`
- Includes "PLAN FIRST" instruction before tool calls (controlled by `settings.planFirst`)
- Includes "ARGUMENT TYPE RULES" with explicit examples of correct vs incorrect formatting
- Explicitly states skill names are NOT tools
- Includes ".pen FORMAT ALIGNMENT" section documenting pen.dev concepts (variables, themes, components, slots, flexbox, node types, hierarchy, constraints, export)
- Canvas snapshot is rendered as a tree (indented by depth) showing the hierarchy, not a flat list

### LLM shim policy (root contract, restated for locality)
- The runner drives the loop with `z-ai-web-dev-sdk` (ZAI) because the sandbox has no Anthropic/OpenAI key.
- The event stream (`AgentStreamEvent` union) mirrors Pi's `AgentSessionEvent` shape.
- Swap point: the LLM client in `runner.ts`. Replace with `createAgentSession` from `@earendil-works/pi-coding-agent` to go native Pi.
- The `LLMClient` interface is the minimal contract: `chat.completions.create({ messages, tools, tool_choice, temperature })`.
- **Settings integration**: `AgentRunOptions` accepts an optional `settings?: AgentRunSettings` field (from `src/lib/settings/types.ts`). When provided, the runner uses:
  - `settings.temperature` (default 0.4) — replaces the previously hard-coded `0.4`.
  - `settings.maxIterations` (default 20) — replaces the previously hard-coded `MAX_ITERATIONS = 20`.
  - `settings.planFirst` (default true) — controls whether the "PLAN FIRST" system-prompt section is included.
  - `settings.defaultPalette` (default 'slate') — reorders the suggested palettes list in the system prompt so the user's default is first.
  - `settings.skillSelectionMode` (default 'auto') — when 'manual', skips the classifier and uses the 'multi' category (all core tools).
- **LLM provider swap**: `settings.llmProvider` controls which LLM client is constructed:
  - `zai-auto` / `zai-key` → `ZAI.create()` (auto-resolves credentials in sandbox; uses env vars outside).
  - `openai-compatible` → `createOpenAICompatibleClient({ apiKey, baseURL, model })` — a minimal fetch-based client that POSTs to the user's custom OpenAI-compatible endpoint (OpenAI, Together, Groq, Ollama, etc.). Only `chat.completions.create` is implemented (non-streaming).

### Intent classifier
- Primary: keyword/regex pass (instant, zero cost). Short keywords (≤3 chars) use word-boundary matching to avoid false positives (e.g. "ui" in "build").
- Fallback: lightweight LLM call seeing only 7 skill descriptions (not 56 tools). Only used when keyword confidence < 0.5 AND not a multi-step prompt.
- Multi-step detection: requires a connective word (then/and/after/next) + multiple skill matches. For multi-step, the LAST skill in the prompt (final deliverable) becomes the primary category.
- Eval: `bun run scripts/eval-agent.ts` — 20 prompts, currently 100% accuracy.

### Plan module
- Triggered when `classification.recommendPlan` is true
- Makes a lightweight LLM call seeing only skill descriptions + user prompt
- Returns 2-5 ordered steps, each mapping to a skill category
- Plan is injected into the system prompt as an XML-tagged `<plan>` block
- Step status updated as execution proceeds (pending → in_progress → completed)

### Web research sub-agent
- Triggered when `web_research` is in secondary categories AND `recommendPlan` is true
- Runs in its own LLM context with ONLY web_search + web_fetch tools
- Does 1-3 searches + 1-3 fetches (capped at 6 iterations)
- Returns a synthesized SUMMARY (not raw page content) — keeps 50K+ tokens of page content out of the main agent's context
- Summary injected into main agent's context as "WEB RESEARCH SUMMARY"
- If the primary task IS web research (not "research then design"), the summary IS the answer

### Event stream shape
```ts
type AgentStreamEvent =
  | { kind: 'patch'; patch: CanvasPatch; toolCallId?: string }
  | { kind: 'agent_event'; event: SyncEvent };
```
- `patch` events carry a `CanvasPatch` that the caller applies to the canvas.
- `agent_event` events carry a `SyncEvent` (defined in `src/lib/canvas/types.ts`) — chat deltas, tool-call start/end, errors, turn end.
- The runner can emit `turn_end` from two code paths (normal exit + MAX_ITERATIONS). There is currently NO guard against double-emission — this is a known gap.

Extended SyncEvent types (in `src/lib/canvas/types.ts`):
- `agent:skill_selected` — intent classifier picked a skill
- `agent:plan` — plan module generated a step list
- `agent:plan_step_update` — a plan step changed status
- `agent:subagent_dispatch` — a sub-agent was spawned
- `agent:subagent_result` — a sub-agent returned its result

### Patch sink
- The runner applies each patch to a local copy of the canvas via `applyPatchToCanvas` (from `../canvas/patch.ts`) and emits the patched document state as part of the event.
- The runner does NOT touch the database or the Zustand store — it is a pure producer. The API route is the consumer that forwards events to viewers.

### Number safety
- All numeric shape fields MUST be coerced with `Number()` before any `.toFixed()` / `Math.round()` call. The `round()` helper in `runner.ts` exists for this.

## Work Guidance

- When adding a tool: define it in `tools.ts`, add the `executeTool` case, add it to the relevant skill's `allowedTools` in `skills/registry.ts`, add it to `ALL_TOOL_NAMES`, update the system prompt if needed.
- When adding a skill: see `skills/AGENTS.md`.
- When changing a tool's schema: every prior session replay that called the old shape will fail. Consider adding a new tool instead.
- When debugging the agent loop: check `dev.log`, reproduce via `/api/agent`, use Agent Browser for end-to-end verification.
- The runner has a `maxIterations` guard (default 20, user-configurable via Settings → Agent → Max tool calls per turn). Exceeding it emits `turn_end` — do not raise.
- The .pen-aligned tools (pen_set_variable, pen_apply_theme, pen_create_ref, etc.) are ALWAYS available regardless of skill, because they expose pen.dev concepts that are relevant to every design task.
- When adding a .pen-aligned tool: define it in `pen-tools.ts`, add it to `PEN_TOOL_NAMES`, add it to the runner's `filterToolSpecs` logic if needed.

## Verification

- `bunx tsc --noEmit` — typecheck
- `bun run lint` — ESLint
- `bun run scripts/eval-agent.ts` — intent classifier eval (20 prompts, 100% accuracy)
- `bun run scripts/measure-tool-cost.ts` — token cost measurement
- Manual: Agent Browser end-to-end test with prompts from each skill category
- Check `dev.log` for runtime errors during a run.

## Child DOX Index

| Path | Scope |
|------|-------|
| `skills/AGENTS.md` | Skill system: types, registry (7 skills), progressive disclosure levels, eval harness. |
