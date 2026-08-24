# AGENTS.md — `src/lib/agent/`

## Purpose

The agent layer: defines the 88-tool surface the AI agent can call against the canvas (70 in `tools.ts` + 8 .pen-aligned in `pen-tools.ts` + 10 Figma-canonical in `figma-tools.ts`, plus up to 32 plugin tools), and runs the skill-aware agent loop that turns a natural-language prompt into a stream of canvas patches + chat events.

This is the contract layer between the LLM and the canvas. Tool names, parameter schemas, skill definitions, and the system prompt's tool catalog are the public surface — changing them is a breaking change for prior session replays.

## Architecture (Tier 0 + Tier 1 + Tier 2)

Skill-aware routing with a dual runner:

```
User prompt
    │
    ▼
┌─────────────────────┐
│ Intent Classifier    │  Tier 1: keyword/regex → LLM fallback (confidence < 0.7)
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
    │ Sub-agent?  │  Tier 2: web_research / design-critic dispatch
    │ (subagents/ │  isolated LLM context, returns SubAgentResult summary
    └────┬────────┘
         │
         ▼
┌─────────────────────────────┐
│ Production runner            │  runner-native.ts: createAgentSession from
│ (Pi Agent SDK)               │  @earendil-works/pi-coding-agent + pi-ai Model
│                              │  via pi-ai-model-resolver.ts, plugins wired,
└─────────────────────────────┘  events translated by agent-session-translator.ts
┌─────────────────────────────┐
│ Test runner                  │  runner-legacy.ts: hand-rolled LLM loop driven
│ (runner-legacy.ts)           │  by injected MockLLM; owns the system prompt
└─────────────────────────────┘  template + shared helpers
```

`runner.ts` is the public entry point — a thin delegator routing to `runAgentNative` (production) or `runAgentLegacy` (tests with an injected `MockLLM`), re-exporting shared types/helpers.

## Ownership

- `tools.ts` — 70 `defineTool()` definitions (68 canvas tools + web_search + web_fetch) + `executeTool` dispatcher (response cap `MAX_TOOL_RESULT_CHARS = 25_000` + `repairArrayArgs()` argument repair). Owned by this folder.
- `pen-tools.ts` — 8 additional .pen-aligned tools (pen_set_variable, pen_apply_theme, pen_create_ref, pen_override_descendant, pen_mark_slot, pen_export_pen, pen_set_theme_axis, pen_list_themes). These expose pen.dev concepts (variables, themes, refs, slots) that complement the granular pen_* tool surface.
- `figma-tools.ts` — 10 Figma-canonical tools: figma_create_page, figma_set_active_page, figma_rename_page, figma_delete_page, figma_create_section, figma_create_component, figma_create_component_set, figma_add_variant, figma_set_component_property, figma_set_instance_property. Exports `createFigmaTools(ctx)` + `FIGMA_TOOL_NAMES`. Always loaded (not skill-gated).
- `runner.ts` — public entry point + thin delegator: routes to `runAgentNative` (production) or `runAgentLegacy` (injected MockLLM tests); re-exports shared types/helpers.
- `runner-native.ts` — production agent loop: `createAgentSession` from `@earendil-works/pi-coding-agent` with pi-ai Model resolution, stub resource loader, in-memory session/settings managers, plugin wiring, and `noTools: 'all'`.
- `runner-legacy.ts` — legacy hand-rolled LLM loop (test path + shared helpers): `SYSTEM_PROMPT_TEMPLATE`, `buildSystemPrompt`, `buildSubAgentLLMClient`, `filterToolSpecs`, `normalizeCanvas`, `round()`.
- `runner-types.ts` — shared `AgentStreamEvent` / `LLMClient` / `AgentRunOptions` types, extracted to break the runner↔translator circular import.
- `classifier.ts` — intent classifier (keyword pass + LLM fallback at confidence < 0.7). Routes prompts to skill categories.
- `planner.ts` — plan module. Generates step lists for multi-step tasks (LLM-based; keyword fallback when no client).
- `context-manager.ts` — token estimation + lightweight in-place compaction of old tool results (on top of pi SDK `estimateTokens`/`shouldCompact`).
- `pattern-memory.ts` — filesystem JSONL RAG store (`data/design-patterns.jsonl`) behind the pen_* design-pattern tools.
- `llm-retry.ts` — shared LLM call helper with exponential backoff (5s→40s, 5 attempts) on 429/transient errors.
- `agent-session-translator.ts` — translates SDK `AgentSessionEvent`s into `AgentStreamEvent`s; extracts patches from tool-result `details`. Carries a `TranslatorState` per prompt cycle that suppresses duplicate closing events (`message_end` fires only when a message is open; `turn_end` fires exactly once even when the SDK re-fires `agent_end` or runs retry loops).
- `pi-ai-model-resolver.ts` — resolves provider settings into pi-ai `Model` + `ModelRuntime` (explicit key / z.ai sandbox auto-credentials / clear error).
- `file-skills.ts` — loads Agent-Skills-standard + legacy `.md` skills from `.pi/skills/` and merges them into the system prompt.
- `skills/` — skill system (types, registry, metadata formatters). See `skills/AGENTS.md`.
- `plugins/` — plugin registry + 8 ported plugins (32 tools, gated by `settings.enabledPlugins`). See `plugins/AGENTS.md`.
- `subagents/` — isolated-context sub-agents: web-research (search+fetch synthesis) and design-critic (reflection critique); both return `SubAgentResult`.

## Local Contracts

### Tool surface (88 registered in production — do not rename/remove without parent-level decision)
All canvas tools are prefixed with `pen_` (e.g., `pen_create_shape`, `pen_update_shape`). The web tools (`web_search`, `web_fetch`) have no prefix. Figma tools use `figma_` prefix. Plugin tools (up to 32, from `plugins/`) are added when their plugin is enabled.

Per-skill `allowedTools` views (tools appear in multiple categories — these are the skill groupings from `skills/registry.ts`):
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
- **Agentic Workflows (6 — Phase 3, emerging patterns)**: pen_self_critique (reflection sub-agent), pen_recommend_components (canvas audit), pen_search_design_patterns (RAG retrieval), pen_save_design_pattern (RAG store), pen_clear_pattern_memory, pen_pattern_stats
- **Pen-aligned (8)**: pen_set_variable, pen_apply_theme, pen_create_ref, pen_override_descendant, pen_mark_slot, pen_export_pen, pen_set_theme_axis, pen_list_themes
- **Figma-canonical (10)**: figma_create_page, figma_set_active_page, figma_rename_page, figma_delete_page, figma_create_section, figma_create_component, figma_create_component_set, figma_add_variant, figma_set_component_property, figma_set_instance_property

Registry views: `ALL_TOOL_NAMES` in `skills/registry.ts` = 78 (excludes the 10 always-loaded figma tools). `runner-native.ts` registers all 88 base tools plus enabled plugin tools.

### Skill categories (7 + multi)
wireframe, layout, styling, inspect, export, web_research, vector, multi

### executeTool enhancements (Tier 1)
- **Response token cap**: `MAX_TOOL_RESULT_CHARS = 25_000` — tool results are truncated to prevent context bloat
- **Argument repair (poka-yoke)**: `repairArrayArgs()` detects and fixes array params passed as stringified JSON strings (e.g. `palette="[\"#fff\"]"` → `palette=["#fff"]`). Known-affected params: palette, shapeIds, nodes, updates, stops, points, shapeId, descendants
- **Loose nested-object params**: `pen_update_shape.changes` accepts an object OR a JSON-encoded string (`LooseShapeInputSchema` + `parseLooseShapeInput()`). pi-ai validates args against the TypeBox schema BEFORE `execute()` runs, so a stringified `changes` used to fail with `Validation failed for tool "pen_update_shape"` and trigger an identical retry. Observed with GLM in the agent-eval `login-hifi` scenario.
- **Generator fidelity params**: `pen_generate_wireframe` / `pen_generate_user_flow` accept `fidelity: 'hifi'|'lofi'` (lofi = grayscale downgrade via `applyLofiFidelity`) and `pen_generate_wireframe` additionally accepts `texts: Record<string,string>` — text-layer-name → replacement text, applied via `applyTextOverrides()` (case/whitespace-insensitive name match). The `texts` param is the copy-fidelity poka-yoke: templates ship placeholder values (e.g. web_dashboard stats "$12.4k", "1,284"), and the agent-eval `dashboard-hifi` scenario caught the model generating a dashboard whose KPI text was still the template placeholders instead of the user's numbers. The tool description + TURN FLOW COPY RULE steer the model to pass `texts` in the same generate call; the result content reports how many overrides matched (and warns when a key matched nothing).

### System prompt (Tier 0)
- Template (`SYSTEM_PROMPT_TEMPLATE`) lives in `runner-legacy.ts`; the native path builds its equivalent via the pi SDK session
- Uses `${PLAN_FIRST_SECTION}`, `${SKILL_METADATA}`, `${SKILL_BODY}`, `${PLAN_SECTION}`, `${PALETTES_LIST}` placeholders filled at runtime
- XML-tagged zones: `<available_skills>`, `<active_skill>`, `<plan>`
- Includes "PLAN FIRST" instruction before tool calls (controlled by `settings.planFirst`)
- Includes "ARGUMENT TYPE RULES" with explicit examples of correct vs incorrect formatting
- **BRAND FIDELITY rule** (DESIGN PRINCIPLES): when the user names a product/brand/app, that exact name MUST appear as real text (wordmark or screen title); concrete copy strings the user provides are used verbatim. Added after the agent-eval `login-hifi` scenario caught the agent omitting the brand name.
- Explicitly states skill names are NOT tools
- Includes ".pen FORMAT ALIGNMENT" section documenting pen.dev concepts (variables, themes, components, slots, flexbox, node types, hierarchy, constraints, export)
- Canvas snapshot is rendered as a tree (indented by depth) showing the hierarchy, not a flat list
- `file-skills.ts` appends Agent-Skills-standard + legacy `.md` skills from `.pi/skills/` to the system prompt

### LLM runner policy
- **Production (`runner-native.ts`)**: `createAgentSession` from `@earendil-works/pi-coding-agent` with the pi-ai `Model` resolved by `pi-ai-model-resolver.ts` (explicit API key / z.ai sandbox auto-credentials / clear error). This was the "LLM shim swap point" — it has been executed; do not re-add a second driver.
- **Default LLM**: `custom` / `kimi-k2-5` / `https://irhnglwoxe.a.pinggy.link/v1` (key `123456`; see `src/lib/settings/AGENTS.md`). Whenever `settings.apiBaseUrl` is set on an OpenAI-compatible provider, the resolver builds a SYNTHETIC pi-ai `Model` (`api: 'openai-completions'`, provider id `custom`, neutral compat profile — no z.ai thinking/tool_stream params) and registers a minimal dispatch provider on the per-turn `ModelRuntime`, because pi-ai's static catalog doesn't know user-supplied endpoints. The z.ai sandbox auto-detection (`ZAI.create()` → `https://internal-api.z.ai/v1` + OAuth headers) still runs for provider `zai` with no API key and wins over the custom path; legacy `glm-4.6` settings map to `glm-4.7`. Verify with `bun run scripts/verify-default-llm.ts`.
- **Automatic z.ai sandbox fallback** (`pi-ai-model-resolver.ts` + `runner-native.ts`): when the configured endpoint is unreachable, the runner retries the SAME turn ONCE using the z.ai sandbox client (`ZAI.create()` from `z-ai-web-dev-sdk`) with model `glm-5.3`. The user effectively gets resilient LLM access via z.ai sandbox as the default fallback — agent turns SUCCEED even when the custom pinggy tunnel is dead. Two layers cooperate:
  1. **Preflight** (`pi-ai-model-resolver.ts → preflightEndpoint()`): a 4s GET against `${baseUrl}/models` with `Authorization: Bearer ${apiKey}`, called when `useCustomEndpoint && providerId !== 'zai'`. Cached 60s per `(baseUrl, apiKeyPrefix)` so we don't pay the 4s latency on every turn. Returns `'ok'` on HTTP 2xx, `'down'` on network error / TLS reset / DNS failure / abort timeout / any non-2xx status (5xx, 429, 401, 403). On `'down'`, the resolver returns a z.ai-sandbox-resolved `glm-5.3` Model (`resolveZaiSandboxFallback()`) with `usedFallback=true` INSTEAD of the synthetic custom Model — the runner then creates the AgentSession against the z.ai sandbox model directly, so there's no double `turn_end` / streaming weirdness.
  2. **Reactive fallback** (`runner-native.ts`): if the preflight passed (`usedFallback=false`) but the turn still produced zero `message_delta` AND zero `tool_call_start` events (e.g. the endpoint returned an empty 200 body), the runner re-creates the AgentSession with a freshly-resolved z.ai-sandbox Model and re-runs the turn. Bounded by `!currentModel.usedFallback` — if the preflight already swapped, the runner does NOT retry again (honors the "at most ONE fallback retry per turn" bound).
  - **Bounding & safety**: at most ONE fallback retry per turn (no infinite loops); skipped when the configured provider is already `zai` (no point falling back to the same provider); skipped when `ZAI.create()` throws (not in the z.ai sandbox / no creds) — the fallback is skipped with a `console.warn('[llm-fallback] …')` and the turn surfaces the original error. Does NOT skip on user-error 4xx from OUR malformed request (e.g. 400 bad request) — the preflight treats all non-2xx as `'down'`, but the cost is one extra failed attempt, which is acceptable (the retry would fail the same way and the silent-failure guard surfaces the error).
  - **Server-side log**: `console.warn('[llm-fallback] primary endpoint <reason>; retrying turn with z.ai sandbox / glm-5.3')` when either layer triggers. The preflight uses reason `'unreachable (network error or non-2xx on /models)'`; the reactive layer uses reason `'produced no output (zero message_delta + zero tool_call events)'`.
  - **`agent:fallback` event in the NDJSON stream**: NOT emitted (would require a new `SyncEvent` type + UI plumbing — skipped per the "only if it fits cleanly" guidance). The `console.warn` is the only signal; the user sees the turn succeed (with content) instead of failing.
- **Tests (`runner-legacy.ts`)**: hand-rolled loop driven by an injected `LLMClient` (MockLLM). The `LLMClient` interface is the minimal contract: `chat.completions.create({ messages, tools, tool_choice, temperature })`.
- The provider registry (`src/lib/llm`) supplies `createLLMClient` + `normalizeLLMProvider` for the legacy path and sub-agent clients; legacy `zai-auto`/`zai-key`/`openai-compatible` values are migrated by `normalizeLLMProvider` (see `src/lib/settings/types.ts`).
- **Settings integration**: `AgentRunOptions` accepts `settings?: AgentRunSettings`:
  - `settings.temperature` (default 0.6) and `settings.maxIterations` (default 30) are honored by the legacy/test loop. **Known gap**: in the native production path both are read but not yet passed to `createAgentSession`.
  - `settings.planFirst` (default true) — controls the "PLAN FIRST" system-prompt section.
  - `settings.defaultPalette` (default 'slate') — reorders the suggested palettes list in the system prompt.
  - `settings.skillSelectionMode` (default 'auto') — when 'manual', skips the classifier and uses the 'multi' category (all core tools).
  - `settings.thinkingLevel`, `settings.enabledPlugins`, `settings.mcpServers` — consumed by the native runner / plugin system.

### Intent classifier
- Primary: keyword/regex pass (instant, zero cost). Short keywords (≤3 chars) use word-boundary matching to avoid false positives (e.g. "ui" in "build").
- Fallback: lightweight LLM call seeing only 7 skill descriptions (not the 78-tool list). Only used when keyword confidence < 0.7 AND not a multi-step prompt.
- Multi-step detection: requires a connective word (then/and/after/next) + multiple skill matches. For multi-step, the LAST skill in the prompt (final deliverable) becomes the primary category.
- Eval: `bun run scripts/eval-agent.ts` — 20 prompts; gate is ≥ 80% accuracy (currently passing at 95%).

### Plan module
- Triggered when `classification.recommendPlan` is true
- Makes a lightweight LLM call seeing only skill descriptions + user prompt
- Returns 2-5 ordered steps, each mapping to a skill category
- Plan is injected into the system prompt as an XML-tagged `<plan>` block
- Step status updated as execution proceeds (pending → in_progress → completed)

### Sub-agents (`subagents/`)
- **web-research**: triggered when `web_research` is in secondary categories AND `recommendPlan` is true. Runs in its own LLM context with ONLY web_search + web_fetch tools; does 1-3 searches + 1-3 fetches (capped at 6 iterations); returns a synthesized SUMMARY (not raw page content) — keeps 50K+ tokens of page content out of the main agent's context. If the primary task IS web research, the summary IS the answer.
- **design-critic**: reflection critique sub-agent (`dispatchDesignCriticSubAgent`) behind the `pen_self_critique` tool — reviews the canvas and returns improvement suggestions as a `SubAgentResult`.
- Both emit `agent:subagent_dispatch` / `agent:subagent_result` events and run through `llm-retry.ts`.
- Only 2 sub-agents + barrel — a third sub-agent justifies a child doc.

### Event stream shape
```ts
type AgentStreamEvent =
  | { kind: 'patch'; patch: CanvasPatch; toolCallId?: string }
  | { kind: 'agent_event'; event: SyncEvent };
```
- Defined in `runner-types.ts`. `patch` events carry a `CanvasPatch`; `agent_event` events carry a `SyncEvent` (defined in `src/lib/canvas/types.ts`).
- The native runner tracks whether the translator already emitted `agent:message_end` / `agent:turn_end` and only emits the defensive tail events for the ones actually missing — closing events are never doubled (fixed; previously every turn ended with a duplicated turn_end that fanned out to all viewers).
- **Silent-failure guard**: after a turn drains, if the runner saw NO text deltas, NO thinking deltas, NO tool calls, and NO `agent:error` (and `prompt()` didn't throw), it emits an explicit `agent:error` explaining the model returned an empty response (usually provider rate-limiting — HTTP 429 — or a transient outage). Without this guard the SDK resolves `prompt()` silently and the user sees an empty bubble. Caught by `scripts/agent-eval/` scenario `wireframe-lofi` during a real 429 lockout.

Extended SyncEvent types (in `src/lib/canvas/types.ts`):
- `agent:skill_selected` — intent classifier picked a skill
- `agent:plan` / `agent:plan_step_update` — plan module lifecycle
- `agent:subagent_dispatch` / `agent:subagent_result` — sub-agent lifecycle
- `agent:thinking_delta` — model thinking tokens
- `agent:context_update` — context compaction happened
- `agent:ask_user_question` / `agent:ask_user_answered` — blocking question flow (resolved via `/api/agent/answers`)
- `agent:todo_update` — plugin todo list changed
- `agent:background_task_started` / `agent:background_task_complete` — background tasks
- `agent:mcp_server_status` — MCP server connection state

### Patch sink
- The runner applies each patch to a local copy of the canvas via `applyPatchToCanvas` (from `../canvas/patch.ts`) and emits the patched document state as part of the event.
- The runner does NOT touch the database or the Zustand store — it is a pure producer. The API route is the consumer that forwards events to viewers.

### Number safety
- All numeric shape fields MUST be coerced with `Number()` before any `.toFixed()` / `Math.round()` call. The `round()` helper in `runner-legacy.ts` exists for this.

## Work Guidance

- When adding a tool: define it in `tools.ts`, add the `executeTool` case, add it to the relevant skill's `allowedTools` in `skills/registry.ts`, add it to `ALL_TOOL_NAMES`, update the system prompt if needed.
- When adding a plugin tool: work in `plugins/` (see `plugins/AGENTS.md`) — do not add plugin tools to `tools.ts`.
- When adding a skill: see `skills/AGENTS.md`.
- When changing a tool's schema: every prior session replay that called the old shape will fail. Consider adding a new tool instead.
- When debugging the agent loop: check `dev.log`, reproduce via `/api/agent`, use Agent Browser for end-to-end verification.
- The legacy runner has a `maxIterations` guard (default 30, user-configurable via Settings → Agent). Exceeding it emits `turn_end` — do not raise.
- The .pen-aligned tools (pen_set_variable, pen_apply_theme, pen_create_ref, etc.) are ALWAYS available regardless of skill, because they expose pen.dev concepts that are relevant to every design task.
- When adding a .pen-aligned tool: define it in `pen-tools.ts`, add it to `PEN_TOOL_NAMES`, add it to the runner's `filterToolSpecs` logic if needed.

## Verification

- `bunx tsc --noEmit` — typecheck
- `bun run lint` — ESLint
- `bun run test` — the suite includes runner (MockLLM), tools registration (70), agentic-workflow, component-system, and translator dedup coverage (`tests/unit/agent-eval-fixes.test.ts`)
- `bun scripts/agent-eval/run-eval.ts` — prompt-vs-output scenario suite (8 scenarios; see `scripts/agent-eval/`) — determinism + trajectory + fidelity assertions against the live `/api/agent` route
- `bash scripts/agent-eval/visual-test.sh` — browser-driven visual verification with screenshots to `download/agent-eval/`
- `bun run scripts/eval-agent.ts` — intent classifier eval (20 prompts, ≥ 80% accuracy gate)
- `bun run scripts/measure-tool-cost.ts` — token cost measurement
- Manual: Agent Browser end-to-end test with prompts from each skill category
- Check `dev.log` for runtime errors during a run.

## Child DOX Index

| Path | Scope |
|------|-------|
| `skills/AGENTS.md` | Skill system: types, registry (7 skills), progressive disclosure levels, eval harness. |
| `plugins/AGENTS.md` | Plugin registry + 8 ported plugins (32 tools, gated by `settings.enabledPlugins`): ask-user-question, todo, memory, mega-compact, goal-list, background-tasks, mcp-adapter, subagents. |
