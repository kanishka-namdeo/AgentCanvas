# AGENTS.md — `src/lib/agent/`

## Purpose

The agent layer: defines the 97-tool base surface the AI agent can call against the canvas (79 in `tools.ts` + 8 .pen-aligned in `pen-tools.ts` + 10 Figma-canonical in `figma-tools.ts`, plus up to 32 plugin tools), and runs the skill-aware agent loop that turns a natural-language prompt into a stream of canvas patches + chat events. The per-turn LLM-visible catalog is the skill-filtered subset of `ALL_TOOL_NAMES` (88 entries / 87 unique) — legacy alias entries are dispatchable for stale transcripts but NOT advertised.

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
    │ Sub-agent?  │  Tier 2: web-research / design-critic / design-brief /
    │ (subagents/ │  variant-generator dispatch (5 — see subagents/AGENTS.md)
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

- `tools.ts` — 79 `defineTool()` definitions (node-era names after the pen-v3 vocabulary unification; includes the Agent Performance Package's `pen_generate_variants` + `pen_duplicate_nodes`) + `executeTool` dispatcher (response cap `MAX_TOOL_RESULT_CHARS = 25_000` + `repairArrayArgs()` argument repair). Owned by this folder. The Phase 3 set (spec §5.2/Appendix D): `pen_insert_html` (sanitized HTML → ONE `bulk_add` patch with nested .pen children — the preferred composite-UI construction primitive), `pen_get_metadata` (page-list default / sparse `id | name | type | x/y/w/h` tree — pure model read), `pen_get_variable_defs` (variables + text styles with `var(--acv-…)` codeSyntax), `pen_get_design_context` (4-part handoff: code + screenshot + instructions + assets), `pen_get_computed` / `pen_get_screenshot` (M2-c client round-trips — live `getComputedStyle`/`getBoundingClientRect` readback + real html-to-image canvas capture; ≤2s pending map in `client-roundtrip.ts`, ALWAYS fall back to resolver data / server resvg with `measured:false`, never hang), `pen_bake_layout` (writes the server-side measured-bounds map into .pen sizes via ONE `update_many`; skips dynamic fit_content/fill_container sizing). `pen_copy_as_code` v2 delegates to `src/lib/canvas/serialize.ts`. ICON SYSTEM (docs/lucide-icons.md): `pen_create_node` accepts `type:"icon"` + `icon:"<lucide-name>"` (validated against the registry in `src/lib/icons` — unknown names fail with suggestions; icons default to 24×24; recolor via `stroke`); `pen_search_icons` is a real semantic SEARCH over the curated catalog (word-level keyword scoring — "password security" → lock) that ALSO places when `icon`/`x`/`y` are given. The system prompt's ICON SYSTEM section + catalog is injected from `lucidePromptCatalog()`.
- `pen-tools.ts` — 8 additional .pen-aligned tools (pen_set_variable, pen_apply_theme, pen_create_ref, pen_override_descendant, pen_mark_slot, pen_export_pen, pen_set_theme_axis, pen_list_themes). These expose pen.dev concepts (variables, themes, refs, slots) that complement the granular pen_* tool surface.
- `figma-tools.ts` — 10 Figma-canonical tools: figma_create_page, figma_set_active_page, figma_rename_page, figma_delete_page, figma_create_section, figma_create_component, figma_create_component_set, figma_add_variant, figma_set_component_property, figma_set_instance_property. Exports `createFigmaTools(ctx)` + `FIGMA_TOOL_NAMES`. Always loaded (not skill-gated).
- `runner.ts` — public entry point + thin delegator: routes to `runAgentNative` (production) or `runAgentLegacy` (injected MockLLM tests); re-exports shared types/helpers.
- `runner-native.ts` — production agent loop: `createAgentSession` from `@earendil-works/pi-coding-agent` with pi-ai Model resolution, stub resource loader, in-memory session/settings managers, plugin wiring, and `noTools: 'all'`.
- `runner-legacy.ts` — legacy hand-rolled LLM loop (test path + shared helpers): `SYSTEM_PROMPT_TEMPLATE`, `buildSystemPrompt`, `buildSubAgentLLMClient`, `filterToolSpecs`, `normalizeCanvas`, `round()`. `canvasSnapshot` enriches layer lines with ` measured=<w>×<h>` from the `client-roundtrip.ts` measured-bounds map (spec §5.5) when the DOM renderer has pushed bounds for the document.
- `client-roundtrip.ts` — server-side pending registry for the client round-trips (M2-c, spec §5.2/§5.4): `awaitClientResponse(toolCallId, emit, timeoutMs)` NEVER rejects (timeout → null → tool fallback — the agent loop cannot hang), `resolveComputedResponse`/`resolveScreenshotResponse` (called by POST `/api/agent/client-responses`), plus the per-document measured-bounds runtime store `setMeasuredBounds`/`getMeasuredBounds` (LRU cap 20 docs, fed by the client's `canvas:measured_bounds` pushes). Timeouts live in the mutable `ROUNDTRIP_DEFAULTS` (2s tools / 3s VLM critic) so tests can shrink them.
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
- `tool-execution-mode.ts` — PURE execution-mode policy: every canvas-mutating pen_/figma_ tool is marked `executionMode: 'sequential'` so pi-agent-core applies multi-tool batches in emission order (create-then-style ordering survives batching); read-only tools (`PARALLEL_SAFE_TOOL_NAMES`) stay concurrent.
- `tool-aliases.ts` — `TOOL_ALIASES` legacy-name map (shape-era → node-era) + `applyToolAliases()`. Alias entries ride along for SDK dispatch (stale transcripts still resolve) but are filtered OUT of the LLM-visible catalog (~28KB saved per call).
- `subagents/` — 5 isolated-context sub-agents: web-research, design-critic, design-critic-vlm, design-brief, variant-generator. See `subagents/AGENTS.md` (child doc).

## Local Contracts

### Tool surface (97 base tools registered in production — do not rename/remove without parent-level decision)
All canvas tools are prefixed with `pen_` (e.g., `pen_create_node`, `pen_update_node`). The web tools (`web_search`, `web_fetch`) have no prefix. Figma tools use `figma_` prefix. Plugin tools (up to 32, from `plugins/`) are added when their plugin is enabled.

Per-skill `allowedTools` views (tools appear in multiple categories — counts verified against `skills/registry.ts` 2026-08-28):
- **Core (10, loaded for EVERY skill)**: pen_create_node, pen_create_subtree, pen_update_node, pen_delete_nodes, pen_get_metadata, pen_clear, pen_set_background, pen_select_nodes, pen_undo, pen_redo
- **Wireframe (46)** — the big generation skill: generators (pen_generate_wireframe / user_flow / diagram / copy), pen_create_subtree, pen_generate_variants, pen_insert_html, icon/image tools, styling + variable/token tools, layout tools, component-system tools, pen_self_critique
- **Layout (18)**: align / group / ungroup / pen_duplicate_nodes (count/direction/spacing batches) / organize_layers / auto_layout / reparent / constraints / z-order / lock / visible / insert_html / get_metadata
- **Styling (14)**: palettes, variables (set/bind/unbind/list/apply), gradient / shadow / blur / per-corner radii, find&replace, bulk_update_by_filter
- **Inspect (10)**: find_nodes, audit_design, get_metadata, get_design_context, get_variable_defs, get_computed, get_screenshot, …
- **Export (6)**: pen_export_json, pen_export_svg, pen_export_png, pen_copy_as_code, pen_bake_layout
- **Vector (6)**: pen_create_path, pen_boolean_op, pen_mask_with, pen_create_node, pen_update_node
- **Web (3)**: web_search, web_fetch (+ web-research sub-agent dispatch)
- **Component System (Figma-aligned)**: pen_convert_to_component, pen_place_component_instance, pen_override_instance, pen_reset_instance, pen_detach_instance, pen_combine_as_variants, pen_swap_variant (+ legacy pen_create_component / pen_instantiate_component)
- **Agentic Workflows (Phase 3 + follow-ons)**: pen_self_critique, pen_recommend_components, pen_search_design_patterns, pen_save_design_pattern, pen_clear_pattern_memory, pen_pattern_stats (+ runner-dispatched pen_generate_design_brief, pen_generate_variants)
- **Pen-aligned (8)**: pen_set_variable, pen_set_explicit_modes, pen_create_ref, pen_override_descendant, pen_mark_slot, pen_export_pen, pen_set_variable_modes, pen_list_collections
- **Figma-canonical (10)**: figma_create_page, figma_set_active_page, figma_rename_page, figma_delete_page, figma_create_section, figma_create_component, figma_create_component_set, figma_add_variant, figma_set_component_property, figma_set_instance_property

Registry views: `ALL_TOOL_NAMES` in `skills/registry.ts` = 88 entries / 87 unique (excludes the 10 always-loaded figma tools). `runner-native.ts` registers all 97 base tools (canonical + alias entries so stale transcripts still dispatch), then filters the LLM-visible catalog to the skill's allowedTools MINUS `TOOL_ALIASES` keys, plus enabled plugin tools.

### Batch construction (`pen_create_subtree` + the `add_subtree` patch op)
One call = one or MANY whole NESTED component trees (`nodes[]` multi-root batches — Agent Performance Package change 1; the round-trip-tax killer: hi-fi evals previously spent 28-29 calls assembling primitive stacks). Each root emits one `add_subtree` patch — one undo step, one broadcast — and `patch.ts`'s `normalizeSubtree` RECURSIVELY maps legacy spellings, fills defaults, and assigns deterministic ids (`rootId-<index>` for id-less descendants, so patch replay is idempotent). The result embeds the FULL id-manifest + inline resolver warnings — the mandatory `pen_get_metadata` read-back round trip is gone. Schema is deliberately LOOSE (Type.Recursive + object∪JSON-string unions): pi-ai validates TypeBox BEFORE execute, so strict schemas would hard-fail the stringified params models actually send (the LooseShapeInputSchema gotcha, applied recursively). Guards: 150-node budget, atomic icon-name validation (whole call fails before any patch), unknown-parentId hard error, top-level frame placement guard reused from pen_create_node. Registered as a CORE tool (always loaded) + the wireframe skill narrative.

### Batch duplication (`pen_duplicate_nodes`)
`count` / `direction` / `spacing` batch duplication — the 78-call "turn one card into three" case is now ONE call (Agent Performance Package change 2); also fixes the silently-ignored `offsetX`/`offsetY` (offsets apply in the given direction with the given spacing). Registered in the layout skill ("duplicate this" → 24px offsets).

### Resolver-warning delivery (agent-visible degradation reporting)
The pen resolver degrades silently no more: `resolvePenTreeDetailed` returns `warnings: ResolverWarning[]` (placeholder_size, dropped_ref, ref_unexpanded, unknown_node_type, unresolved_variable, path_geometry_dropped, effects_dropped — deduped by nodeId+kind, mirrored into `ResolveOpts.warnings`). Two delivery layers feed the LLM: `pen_get_metadata` appends a `RESOLVE WARNINGS` section on every read (`collectResolverWarnings`/`formatResolverWarnings` in tools.ts, threaded with `getMeasuredBounds` so browser-measured nodes don't produce placeholder false-positives), and `canvasSnapshot` (runner-legacy.ts) carries the same section into the per-turn system prompt. Degradation checks live in the resolver's per-node hot path — keep them O(1) (Set lookups, presence guards) or the 4k-node audit test times out.

### Skill categories (7 + multi)
wireframe, layout, styling, inspect, export, web_research, vector, multi

### executeTool enhancements (Tier 1)
- **Response token cap**: `MAX_TOOL_RESULT_CHARS = 25_000` — tool results are truncated to prevent context bloat
- **Argument repair (poka-yoke)**: `repairArrayArgs()` detects and fixes array params passed as stringified JSON strings (e.g. `palette="[\"#fff\"]"` → `palette=["#fff"]`). Known-affected params: palette, shapeIds, nodes, updates, stops, points, shapeId, descendants
- **Loose nested-object params**: `pen_update_node.changes` (legacy spelling `pen_update_shape`, still dispatched via the alias map) accepts an object OR a JSON-encoded string (`LooseShapeInputSchema` + `parseLooseShapeInput()`). pi-ai validates args against the TypeBox schema BEFORE `execute()` runs, so a stringified `changes` used to fail with `Validation failed for tool "pen_update_shape"` and trigger an identical retry. Observed with GLM in the agent-eval `login-hifi` scenario.
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
- Canvas snapshot is rendered as a tree (indented by depth) showing the hierarchy, not a flat list. It rides in the FIRST USER MESSAGE (moved off the system-prompt tail — Agent Performance Package change 5) so the system prompt stays byte-stable and prefix-cacheable. The prompt also carries the PARALLEL TOOL EMISSION RULE (independent calls emitted together; canvas mutations apply in emission order via `tool-execution-mode.ts`) and the CALL BUDGET RULE (≤12 calls/turn).
- `file-skills.ts` appends Agent-Skills-standard + legacy `.md` skills from `.pi/skills/` to the system prompt

### LLM runner policy
- **Production (`runner-native.ts`)**: `createAgentSession` from `@earendil-works/pi-coding-agent` with the pi-ai `Model` resolved by `pi-ai-model-resolver.ts` (explicit API key / z.ai sandbox auto-credentials / clear error). This was the "LLM shim swap point" — it has been executed; do not re-add a second driver. Prompt caching is enabled for custom OpenAI-compatible endpoints (`supportsLongCacheRetention` + `PI_CACHE_RETENTION=long`) — the system prompt is byte-stable across turns (canvas snapshot rides in the first user message instead), so the ~45K-token static prefix hits the provider cache ~90-99%.
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
  - `settings.temperature` (default 0.6) and `settings.maxIterations` (default 30) are honored by the legacy/test loop; the native path enforces `maxIterations` via `session.agent.shouldStopAfterTurn` (Agent Performance Package change 7 — wired + probe-verified; previously read but never used).
  - `settings.planFirst` (default true) — controls the "PLAN FIRST" system-prompt section.
  - `settings.defaultPalette` (default 'slate') — reorders the suggested palettes list in the system prompt.
  - `settings.skillSelectionMode` (default 'auto') — when 'manual', skips the classifier and uses the 'multi' category (all core tools).
  - `settings.thinkingLevel`, `settings.enabledPlugins`, `settings.mcpServers` — consumed by the native runner / plugin system.

### Intent classifier
- Primary: keyword/regex pass (instant, zero cost). Short keywords (≤3 chars) use word-boundary matching to avoid false positives (e.g. "ui" in "build").
- Fallback: lightweight LLM call seeing only 7 skill descriptions (not the 87-tool list). Only used when keyword confidence < 0.7 AND not a multi-step prompt.
- Multi-step detection: requires a connective word (then/and/after/next) + multiple skill matches. For multi-step, the LAST skill in the prompt (final deliverable) becomes the primary category.
- Eval: `bun run scripts/eval-agent.ts` — 20 prompts; gate is ≥ 80% accuracy (currently passing at 95%).

### Plan module
- Triggered when `classification.recommendPlan` is true
- Makes a lightweight LLM call seeing only skill descriptions + user prompt
- Returns 2-5 ordered steps, each mapping to a skill category
- Plan is injected into the system prompt as an XML-tagged `<plan>` block
- Step status updated as execution proceeds (pending → in_progress → completed)

### Sub-agents (`subagents/` — see `subagents/AGENTS.md`)
Five isolated-context sub-agents: **web-research** (search+fetch synthesis — triggered when `web_research` is a secondary category AND `recommendPlan`; runs with ONLY web_search + web_fetch, 1-3 searches + 1-3 fetches capped at 6 iterations, returns a synthesized SUMMARY so 50K+ tokens of page content stay out of the main context), **design-critic** (text reflection behind `pen_self_critique`), **design-critic-vlm** (screenshot critique — client capture primary, resvg fallback), **design-brief** (strict-JSON palette/typography/IA brief — PRE-GENERATED by the runner and injected into the first user message; the tool gate remains as fallback; skipped on ambiguous-creation turns), and **variant-generator** (K=3 parallel whole-design exploration behind `pen_generate_variants` — staggered seeded generations, throwaway off-canvas renders, one VLM-judge call on the composite image, only the winner applied; 300s wall-clock budget with per-phase races; degrades to heuristic judging then to the `pen_create_subtree` fallback ladder). All emit `agent:subagent_dispatch` / `agent:subagent_result` events, run through `llm-retry.ts` with a 300s client timeout, and launch staggered for constrained single-connection transports. Full contracts live in the child doc.

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

## UI QUALITY ENFORCEMENT (Task 7-c — 3-phase architectural enforcement)

The Task 7-a VLM baseline scored AgentCanvas 2/10. The Task 7-b research report (T1/T2/T3/T4/T10) identified that production tools (v0/Lovable/bolt) couple their prompts with architectural enforcement — AgentCanvas's prompt-only Task 6-a enhancement was bypassed by the agent delegating to `pen_generate_wireframe`. Task 7-c implements the architectural layer:

### P1.1 — Wireframe-generator typography-rich output (`tools.ts` `applyHighFidelityStyling`)
The `applyHighFidelityStyling` post-processor runs after every `buildWireframe` template. It now applies typography fields (fontWeight / letterSpacing / lineHeight / textAlign / fontFamily) to every text shape based on the shape's NAME — using the same per-role table the system prompt's LETTER SPACING RULES section documents:
- Page title / Hero heading / Headline / Wordmark → H1 (700 / -0.6 / left)
- Section heading / Subhead / Panel title / Chart title → H2 (600 / -0.4 / left)
- Stat / Metric value (large number) → 700 / -0.5 / left (tabular scanning)
- Stat / Metric label / Overline → 500 / +0.6 / left
- Body / Excerpt / Paragraph / Description → 400 / 0 / 1.5
- Table / Column header → 600 / +0.5 / left (UPPERCASE intent)
- Button / CTA label → 600 / +0.3 / center
- Input / Field label / Placeholder → 400 / 0 / left
- Nav / Sidebar item / Tab label → 500 / 0 / left
- Caption / Footer / Fine print → 400 / +0.2
- Link / Forgot password / Sign in link → 500 / 0 / left

It also adds `autoLayout` to layout containers (cards = vertical, sidebars = vertical, topbars = horizontal, tab bars = horizontal). The DOM renderer's `styleFor.ts` honors all these fields, so the wireframe generator's output is now typographically-rich end-to-end — closing the "0% typography usage" root cause the VLM baseline exposed.

### P1.2 / T1 — Pre-generation design brief (`pen_generate_design_brief` tool + `subagents/design-brief.ts`)
The new `pen_generate_design_brief` tool dispatches the design-brief sub-agent, which calls the LLM in an isolated context with the user prompt + a strict JSON-output system prompt. The sub-agent returns a `DesignBrief`:
```ts
{ primaryColor, accentColor, neutralPalette: string[], typography: {fontFamily, headingScale, bodySize},
  componentCount, layoutGrid: {cols, rows}, informationArchitecture: string[] }
```
The brief is bound to 50-900 brand ramps (Sky/Violet/Emerald/Amber/Rose/Indigo) so it matches the system prompt's PRIMARY COLOR 50-900 RAMPS section. The system prompt's new "DESIGN BRIEF (MANDATORY FIRST STEP)" section tells the agent to call `pen_generate_design_brief` BEFORE any `pen_create_node` / `pen_generate_wireframe` / `pen_apply_palette` call and use the brief's palette/typography/IA list for ALL subsequent shape creation. This is the v0 `GenerateDesignInspiration` pattern — think-before-draw. UPDATE (Agent Performance Package change 9): the runner PRE-GENERATES the brief in a small sub-agent before the main loop and injects it into the first user message (40s timeout race) — the guaranteed brief round trip is deleted; the tool-layer gate remains as fallback. On ambiguous-creation turns the brief is SKIPPED: it would pre-decide the palette the variant exploration exists to settle.

### P1.3 / T2 — Mandatory self-critique loop with MAX_ITERATIONS=2 (`runner-native.ts` + `runner-legacy.ts` + `AgentRunSettings.maxDesignCritiqueIterations`)
After the agent emits its final message, the runner wraps a bounded outer loop:
```ts
for (let critiqueIteration = 0; critiqueIteration < maxCritiqueIterations; critiqueIteration++) {
  // 1. Dispatch text critic (existing dispatchDesignCriticSubAgent).
  // 2. Dispatch VLM critic (T3) — renderCanvasToPng + vision LLM.
  // 3. Run validateCanvasBeforeComplete (T10).
  // 4. If validation passes AND both severities are "low", break.
  // 5. Otherwise emit agent:critique event + re-prompt the agent
  //    with the defect list via a new pi SDK session.
}
```
Default `maxDesignCritiqueIterations = 2` — agent gets 1 chance to self-correct after the critic. The legacy runner mirrors a simplified version (text critic only, no VLM — gated on `!injectedLlm` so tests using MockLLM don't trip the loop). The existing `pen_self_critique` tool remains OPT-IN but the architectural enforcement makes the loop MANDATORY regardless. UPDATE (Agent Performance Package change 8): the loop runs the FREE validation gate (`validateCanvasBeforeComplete`) FIRST, SKIPS the VLM critic for small clean edits, and runs the text + VLM critics CONCURRENTLY before merging defects.

### P1.4 / T10 — Pre-complete validation gate (`validators.ts` `validateCanvasBeforeComplete`)
`validateCanvasBeforeComplete(shapes)` runs BEFORE the agent's final message is committed. Rules (each produces a specific failure reason):
1. `< 5 shapes` → "Too few shapes — looks like a wireframe"
2. `< 50% of text shapes have non-default fontWeight` → "no typographic hierarchy"
3. `< 30% of card-shaped rectangles have shadow` → "most cards lack shadow"
4. `zero shapes with autoLayout set` → "no autoLayout detected"

If validation fails, the runner re-prompts the agent with the failure reasons + "Fix these before declaring done." This catches the exact wireframe-only failure mode the VLM baseline exposed (39 bare scaffolds + 11 pen_set_variable + 7 pen_set_shadow + 1 gradient, ZERO typography fields across 24 text shapes).

### P2.1 / T3 — VLM screenshot critique (`subagents/design-critic-vlm.ts` + `canvas/render-to-png.ts` + `pen_visual_critique` tool)

**Phase 5 §5.4 ground-truth seam — DOM capture is primary.** The VLM critic first asks the connected CLIENT for a real screenshot via the `agent:screenshot_request` round-trip (`client-roundtrip.ts`, 3s budget). On success the critic critiques the actual DOM-rendered picture captured by `html-to-image` against the live `[data-ac-world]` element (log: "VLM critic using real client screenshot"; `screenshotSource: 'client'`). This is the source of truth after Phase 5 — the canvas is DOM-rendered, so the critic must see what the user sees.

**Server-side resvg fallback (D8 discipline).** When the round-trip times out / no-sink / `html-to-image` unavailable, the critic falls back to `renderCanvasToPng(shapes, 1440, 900)` — a server-side SVG→PNG rasterizer that builds an SVG string from the resolved layers (mirroring the DOM renderer's `styleFor.ts` vocabulary but emitting raw SVG markup, with full support for typography fields + gradients + shadows + radii + opacity) and rasterizes via `@resvg/resvg-js` at 2x scale for crisp text. Result carries `screenshotSource: 'server'` telemetry. The same fallback path is used by `pen_get_screenshot`, `pen_get_design_context`, and `pen_export_png` (Phase 5 §5.4 unified contract — all agent-facing surfaces prefer DOM capture; resvg is the no-client fallback).

The VLM critic sub-agent base64-encodes the PNG and calls the vision LLM with the SAME structured-critique prompt used for the Task 7-a baseline (8 dimensions, 1-10 score, top-5 fixes). The "after" score is directly comparable to the 2/10 baseline.

The VLM catches what text-critic cannot see: alignment, whitespace distribution, "generic AI look" (the v0/Midjourney pattern — flat colored divs with no real content density). The mandatory critique loop dispatches BOTH critics on each iteration and merges their defects before re-prompting the agent.

### P3.1 / T4 — Design-token enforcement (`coerceShapeInput` + system-prompt COMPONENT RECIPES rewrite)
The 9 COMPONENT RECIPES in `SYSTEM_PROMPT_TEMPLATE` now use `$color.*` token syntax exclusively (e.g. `fill:"$color.primary"` instead of `fill:"#0ea5e9"`). The `coerceShapeInput` helper in `tools.ts` accepts raw hex (doesn't break tests) but emits a throttled console hint when the AI passes a known hex (e.g. `#0ea5e9`) suggesting the matching `$color.*` token. The hint map covers the entire Sky/Indigo/Emerald/Rose/Amber ramps + the neutral Slate ramp. This closes the "5 different blues" failure mode the recipes (raw hex) used to encourage.

### P3.2 — Documentation (this section)
This `AGENTS.md` "UI QUALITY ENFORCEMENT" section is the spec for the architectural enforcement layer. Verify it stays in sync with the actual code paths above.

### New dependencies
- `@resvg/resvg-js@2.6.2` — pure-JS SVG → PNG rasterizer, used by `renderCanvasToPng`. No native deps; works in the Next.js runtime.
- `html-to-image@1.11.13` — client-only canvas capture (DOM world element → PNG data URL) for `agent:screenshot_request` round-trips. Dynamically imported in `store.ts` (never in the server bundle).

### Verification
- `bunx tsc --noEmit` — must pass (added the new SyncEvent variant `agent:critique` + the `AgentRunSettings.maxDesignCritiqueIterations` field + the new sub-agent / validator modules).
- `bun run test` — the existing tests use MockLLM via `runner-legacy` (the critique loop is gated on `!injectedLlm`, so tests get the OLD behavior). Tests should remain green.
- Task 7-a's VLM critique loop (`scripts/vlm-critique-prompt.txt` + `z-ai vision -i .../vaultly-baseline.png`) is the ready-made test harness for measuring VLM score delta from the 2/10 baseline. The verify+ship subagent re-runs the Vaultly prompt + VLM critique to measure the delta.

## Verification

- `bunx tsc --noEmit` — typecheck
- `bun run lint` — ESLint
- `bun run test` — 72 files / 1775 passed + 2 skipped (2026-08-28). Includes runner (MockLLM), tools registration (79), agentic-workflow, component-system, translator dedup (`tests/unit/agent-eval-fixes.test.ts`), and the perf-package + todo-batch/variants suites (`tests/unit/agent-performance-package.test.ts`, `tests/unit/todo-batch-variants.test.ts`)
- `bun scripts/agent-eval/run-eval.ts` — prompt-vs-output scenario suite (8 scenarios; see `scripts/agent-eval/`) — determinism + trajectory + fidelity assertions against the live `/api/agent` route
- `bash scripts/agent-eval/visual-test.sh` — browser-driven visual verification with screenshots to `download/agent-eval/`
- `bun run scripts/eval-agent.ts` — intent classifier eval (20 prompts, ≥ 80% accuracy gate)
- `bun run scripts/measure-tool-cost.ts` — token cost measurement
- Manual: Agent Browser end-to-end test with prompts from each skill category
- Check `dev.log` for runtime errors during a run.

## Child DOX Index

| Path | Scope |
|------|-------|
| `subagents/AGENTS.md` | 5 isolated-context sub-agents (web-research, design-critic, design-critic-vlm, design-brief, variant-generator) + shared dispatch/timeout/budget contracts. |
| `skills/AGENTS.md` | Skill system: types, registry (7 skills), progressive disclosure levels, eval harness. |
| `plugins/AGENTS.md` | Plugin registry + 8 ported plugins (32 tools, gated by `settings.enabledPlugins`): ask-user-question, todo, memory, mega-compact, goal-list, background-tasks, mcp-adapter, subagents. |
