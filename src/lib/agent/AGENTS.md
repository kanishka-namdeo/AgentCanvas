# AGENTS.md — `src/lib/agent/`

## Purpose

The agent layer: defines the 56 tools the AI agent can call against the canvas, and runs the skill-aware agent loop that turns a natural-language prompt into a stream of canvas patches + chat events.

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

- `tools.ts` — 56 `defineTool()` definitions + `executeTool` dispatcher (with response caps + argument repair). Owned by this folder.
- `runner.ts` — the agent loop. Owns the system prompt template, LLM driver, event stream shape, skill integration, plan/sub-agent dispatch.
- `classifier.ts` — intent classifier (keyword pass + LLM fallback). Routes prompts to skill categories.
- `planner.ts` — plan module. Generates step lists for multi-step tasks.
- `skills/` — skill system (types, registry, metadata formatters).
- `subagents/` — sub-agent implementations (currently just web-research).

## Local Contracts

### Tool surface (56 tools — do not rename/remove without parent-level decision)
- **Core (9)**: create_shape, update_shape, delete_shape, list_shapes, clear, set_background, select_shape, undo, redo
- **Wireframe (12)**: generate_wireframe, generate_user_flow, generate_diagram, generate_copy, create_shape, update_shape, upload_image, search_icons, generate_image, update_tokens, apply_palette, generate_palette
- **Layout (13)**: align_shapes, group_shapes, ungroup_shapes, duplicate_shape, organize_layers, apply_auto_layout, bring_to_front, send_to_back, move_forward, move_backward, reorder_shape, set_locked, set_visible
- **Styling (13)**: apply_palette, generate_palette, update_tokens, apply_token, bind_shape_to_token, unbind_shape, list_tokens, set_gradient_fill, set_shadow, set_blur, set_corner_radius_per_corner, find_replace_text, bulk_update_by_filter
- **Inspect (4)**: list_shapes, find_shapes, audit_design, list_tokens (predict_heatmap REMOVED for .pen purity)
- **Export (4)**: export_json, export_svg, export_png, copy_as_code
- **Vector (5)**: create_path, boolean_op, mask_with, create_shape, update_shape
- **Web (2)**: web_search, web_fetch
- **Other (6)**: create_component, instantiate_component, find_shapes, bulk_update_by_filter, find_replace_text, generate_copy

### Skill categories (7 + multi)
wireframe, layout, styling, inspect, export, web_research, vector, multi

### executeTool enhancements (Tier 1)
- **Response token cap**: `MAX_TOOL_RESULT_CHARS = 25_000` — tool results are truncated to prevent context bloat
- **Argument repair (poka-yoke)**: `repairArrayArgs()` detects and fixes array params passed as stringified JSON strings (e.g. `palette="[\"#fff\"]"` → `palette=["#fff"]`). Known-affected params: palette, shapeIds, nodes, updates, stops, points, shapeId

### System prompt (Tier 0)
- Defined as `SYSTEM_PROMPT_TEMPLATE` in `runner.ts`
- Uses `${SKILL_METADATA}`, `${SKILL_BODY}`, `${PLAN_SECTION}` placeholders filled at runtime
- XML-tagged zones: `<available_skills>`, `<active_skill>`, `<plan>`
- Includes "PLAN FIRST" instruction before tool calls
- Includes "ARGUMENT TYPE RULES" with explicit examples of correct vs incorrect formatting
- Explicitly states skill names are NOT tools

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
