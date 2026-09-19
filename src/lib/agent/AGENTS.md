# AGENTS.md — `src/lib/agent/`

## Purpose

The agent layer: defines the 104-tool production surface the AI agent can call against the canvas (85 in `tools.ts` — 79 base + 6 composites: 3 audit-2026-08-30 `pen_apply_design_system`/`pen_create_chart`/`pen_apply_typography` + 3 oneshot-2026-09-07 `pen_create_card_grid`/`pen_create_landing_page`/`pen_create_table` — plus 8 .pen-aligned in `pen-tools.ts` + 10 Figma-canonical in `figma-tools.ts` + 1 staged-flow gate tool `submit_layout_approval`, plus up to 32 plugin tools), and runs the skill-aware agent loop that turns a natural-language prompt into a stream of canvas patches + chat events. The per-turn LLM-visible catalog is the skill-filtered subset of `ALL_TOOL_NAMES` — legacy alias entries are dispatchable for stale transcripts but NOT advertised, the .pen-file + Figma tool unions ride along only on structural categories (wireframe/multi — audit 2-b T3), and secondary skill categories widen the visible set (audit 2-c S9). The 2026-08-30 audit batch added the composite tools above, cross-turn conversation history replay, a cache-stable system prompt (plan/file-skills/memory ride the user message), an honest critique fix-message (canonical tool names), a critique-phase event sink (the VLM critic sees the REAL client screenshot), and standardized not-found errors (`tool-errors.ts`). The 2026-09-07 oneshot tuning batch (BETA/qwen3.7-plus) added the three one-shot composites, empty-canvas tool slimming (11 plugin tools dropped on one-shot turns), and the one-shot polish pass (`src/lib/canvas/oneshot-polish.ts` — 4px grid snap + duplicate dedupe, gated on empty-canvas turns); the follow-up delta fix (2026-09-07, `922aa2b`) makes follow-up turns see the FULL canvas snapshot unless the changed-set is non-empty AND the canvas is large (see the canvasDelta contract below). The 2026-09-12 designer-workflow-parity batch added the staged lo-fi → approval → hi-fi flow (Tasks 7–10), variant runner-up parking + promotion (Tasks 3–6), and component-first construction rules (Tasks 1–2).

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

- `tools.ts` — 85 `defineTool()` definitions (79 base, node-era names after the pen-v3 vocabulary unification, includes the Agent Performance Package's `pen_generate_variants` + `pen_duplicate_nodes`; plus the 6 composite tools: audit-2026-08-30 `pen_apply_design_system` / `pen_create_chart` / `pen_apply_typography` and oneshot-2026-09-07 `pen_create_card_grid` / `pen_create_landing_page` / `pen_create_table`) + `executeTool` dispatcher (response cap `MAX_TOOL_RESULT_CHARS = 25_000` + `repairArrayArgs()` argument repair). Owned by this folder. The Phase 3 set (spec §5.2/Appendix D): `pen_insert_html` (sanitized HTML → ONE `bulk_add` patch with nested .pen children — the preferred composite-UI construction primitive), `pen_get_metadata` (page-list default / sparse `id | name | type | x/y/w/h` tree — pure model read), `pen_get_variable_defs` (variables + text styles with `var(--acv-…)` codeSyntax), `pen_get_design_context` (4-part handoff: code + screenshot + instructions + assets), `pen_get_computed` / `pen_get_screenshot` (M2-c client round-trips — live `getComputedStyle`/`getBoundingClientRect` readback + real html-to-image canvas capture; ≤2s pending map in `client-roundtrip.ts`, ALWAYS fall back to resolver data / server resvg with `measured:false`, never hang), `pen_bake_layout` (writes the server-side measured-bounds map into .pen sizes via ONE `update_many`; skips dynamic fit_content/fill_container sizing). `pen_copy_as_code` v2 delegates to `src/lib/canvas/serialize.ts`. ICON SYSTEM (docs/lucide-icons.md): `pen_create_node` accepts `type:"icon"` + `icon:"<lucide-name>"` (validated against the registry in `src/lib/icons` — unknown names fail with suggestions; icons default to 24×24; recolor via `stroke`); `pen_search_icons` is a real semantic SEARCH over the curated catalog (word-level keyword scoring — "password security" → lock) that ALSO places when `icon`/`x`/`y` are given. The system prompt's ICON SYSTEM section + catalog is injected from `lucidePromptCatalog()`.
- `pen-tools.ts` — 8 additional .pen-aligned tools (pen_set_variable, pen_set_explicit_modes, pen_create_ref, pen_override_descendant, pen_mark_slot, pen_export_pen, pen_set_variable_modes, pen_list_collections). These expose pen.dev concepts (variables, modes, refs, slots) that complement the granular pen_* tool surface. Exports `createPenTools(ctx)`.
- `figma-tools.ts` — 10 Figma-canonical tools: figma_create_page, figma_set_active_page, figma_rename_page, figma_delete_page, figma_create_section, figma_create_component, figma_create_component_set, figma_add_variant, figma_set_component_property, figma_set_instance_property. Exports `createFigmaTools(ctx)` + `FIGMA_TOOL_NAMES`. Always loaded (not skill-gated).
- `runner.ts` — public entry point + thin delegator: routes to `runAgentNative` (production) or `runAgentLegacy` (injected MockLLM tests); re-exports shared types/helpers.
- `runner-native.ts` — production agent loop: `createAgentSession` from `@earendil-works/pi-coding-agent` with pi-ai Model resolution, stub resource loader, in-memory session/settings managers, plugin wiring, and `noTools: 'all'`.
- `runner-legacy.ts` — legacy hand-rolled LLM loop (test path + shared helpers): `SYSTEM_PROMPT_TEMPLATE`, `buildSystemPrompt`, `buildSubAgentLLMClient`, `filterToolSpecs`, `normalizeCanvas`, `round()`. `canvasSnapshot` enriches layer lines with ` measured=<w>×<h>` from the `client-roundtrip.ts` measured-bounds map (spec §5.5) when the DOM renderer has pushed bounds for the document. PHASE C (R9a): `canvasSnapshotDelta(canvas, changedIds)` builds the DELTA digest — globals (variables/collections/text-styles/placement) always present, changed nodes keep full `formatShapeLine` detail, unchanged subtrees collapse to one navigation line with a `pen_get_metadata` expansion pointer, warnings scoped to changed ids (an unchanged node's degradation cannot change without a node change or a global op, and globals fall back to the FULL snapshot). The full line formatter lives in `shape-line.ts` (shared verbatim with `pen_get_metadata`'s detail mode — the digest's collapsed lines and the hydration tool must never drift vocabulary; bump `PROMPT_VERSION` when either changes). `AgentRunOptions.canvasDelta` (from the socket service's journal-derived watermark, validated in the `/api/agent` route like `selection`) switches the FIRST USER MESSAGE between digest and full snapshot; `nodeIds:null`/absent = full. DELTA GATING (follow-up fix `922aa2b`, 2026-09-07): delta mode engages ONLY when the changed-set is non-empty AND the canvas exceeds `DELTA_MIN_SHAPES` (60) — `computeChangedNodeIdsSince` (journal-fold) returns `nodeIds: null` when the window changed nothing (previously an EMPTY array was truthy and blinded pure follow-up turns to a zero-expanded digest), and the runner gates on both conditions, so small canvases and no-change windows always get the full snapshot. The legacy runner path always uses the full snapshot (test path only). PROMPT-TUNING (2026-08-31, rev `.4`, strengthened 2026-09-11, staged-flow additions 2026-09-12 — `PROMPT_VERSION` stamped on every first user message): the SYSTEM_PROMPT_TEMPLATE carries the tuned design-quality contract — SCOPE & CONTENT CONTRACT (effort matching: direct-create for one-offs, full TURN FLOW for screens), CONTENT FIDELITY + NO INVENTED CONTENT (enumerated strings verbatim, nothing extra — explicit prohibitions: no trend indicators/percentage badges/micro-labels, no subtitles/taglines/decorative text, no icon badges/status indicators/progress bars, no extra card columns/delta badges/sparklines, no label renaming; violation examples: "Show Revenue, Users, Conversion" must NOT add "+12.5%" or "Performance overview"; "Login form with email and password" must NOT add "Forgot password?" or social login buttons), POSITIONAL FIDELITY (placement words are hard constraints: flow-position insertion, `layoutPosition:"absolute"` for pinning), RESOLVER WARNINGS ARE DEFECTS (a turn is not done while any warning remains — each kind's fix is named inline), PAGE/ROOT frames must be `fit_content` (never the 100px default), TEXT LAYER WIDTH formula (chars × fontSize × 0.62), shadow visibility floor (>= 50% of elevated surfaces must have visible shadow: blur >= 8, y-offset >= 4, alpha >= 0x33 — every card/panel/modal/FAB MUST have a shadow, no exceptions), BATCH CONSTRUCTION + PARALLEL TOOL EMISSION + CALL BUDGET (≤12 calls), COMPONENT-FIRST CONSTRUCTION (2026-09-12: repeated structures like KPI cards / table rows / grid items MUST be authored as ONE component master + N instances via `pen_convert_to_component` + `pen_place_instance`, not as N bespoke subtrees — restyles propagate through the master; the variant-generator's winner is applied as a component when the prompt implies reuse). Tuning history + VLM-critique evidence: `download/prompt-tuning/final-report.md`.
- `client-roundtrip.ts` — server-side pending registry for the client round-trips (M2-c, spec §5.2/§5.4): `awaitClientResponse(toolCallId, emit, timeoutMs)` NEVER rejects (timeout → null → tool fallback — the agent loop cannot hang), `resolveComputedResponse`/`resolveScreenshotResponse` (called by POST `/api/agent/client-responses`), plus the per-document measured-bounds runtime store `setMeasuredBounds`/`getMeasuredBounds` (LRU cap 20 docs, fed by the client's `canvas:measured_bounds` pushes). Timeouts live in the mutable `ROUNDTRIP_DEFAULTS` (2s tools / 3s VLM critic) so tests can shrink them.
- `runner-types.ts` — shared `AgentStreamEvent` / `LLMClient` / `AgentRunOptions` types, extracted to break the runner↔translator circular import.
- `classifier.ts` — intent classifier (keyword pass + LLM fallback at confidence < 0.7). Routes prompts to skill categories.
- `planner.ts` — plan module. Generates step lists for multi-step tasks (LLM-based; keyword fallback when no client).
- `context-manager.ts` — token estimation + lightweight in-place compaction of old tool results. LEGACY-path only (runner-legacy.ts); the native production path uses the pi SDK's auto-compaction (`NATIVE_COMPACTION_SETTINGS` in runner-native.ts — turn-aligned cuts, LLM summary, iterative merge).
- `pattern-memory.ts` — filesystem JSONL RAG store (`data/design-patterns.jsonl`) behind the pen_* design-pattern tools.
- `llm-retry.ts` — shared LLM call helper with exponential backoff (5s→40s, 5 attempts) on 429/transient errors.
- `agent-session-translator.ts` — translates SDK `AgentSessionEvent`s into `AgentStreamEvent`s; extracts patches from tool-result `details`. Carries a `TranslatorState` per prompt cycle that suppresses duplicate closing events (`message_end` fires only when a message is open; `turn_end` fires exactly once even when the SDK re-fires `agent_end` or runs retry loops).
- `pi-ai-model-resolver.ts` — resolves provider settings into pi-ai `Model` + `ModelRuntime` (explicit key / z.ai sandbox auto-credentials / clear error).
- `file-skills.ts` — loads Agent-Skills-standard + legacy `.md` skills from `.pi/skills/` and merges them into the system prompt.
- `skills/` — skill system (types, registry, metadata formatters). See `skills/AGENTS.md`.
- `plugins/` — plugin registry + 8 ported plugins (32 tools, gated by `settings.enabledPlugins`). See `plugins/AGENTS.md`.
- `tool-execution-mode.ts` — PURE execution-mode policy: every canvas-mutating pen_/figma_ tool is marked `executionMode: 'sequential'` so pi-agent-core applies multi-tool batches in emission order (create-then-style ordering survives batching); read-only tools (`PARALLEL_SAFE_TOOL_NAMES`) stay concurrent.
- `tool-aliases.ts` — `TOOL_ALIASES` legacy-name map (shape-era → node-era) + `applyToolAliases()`. Alias entries ride along for SDK dispatch (stale transcripts still resolve) but are filtered OUT of the LLM-visible catalog (~28KB saved per call).
- `subagents/` — 5 isolated-context sub-agents: web-research, design-critic, design-critic-vlm, design-brief, variant-generator (+ `multitask.ts` — the `/multitask` multi-screen decomposition path). See `subagents/AGENTS.md` (child doc).
- `modes.ts` — mode policy: `AgentMode` (build/ask/plan) allowlists + `ASK_MODE_TOOL_NAMES`, `DesignCritiqueMode` + `shouldRunCritics` gate (both runners + tests share one definition).
- `mode-tags.ts` — Cline-style mode-tagged user messages + switch notices (competitor-research round 3, Cline pattern 5.5). PURE helpers + a module-singleton tracker (the cross-call handoff channel between the UI mode picker / slash commands (producer: `record(from, to)`) and the runner (consumer: `consume()` at prompt-send time)). `formatUserInputBlock(input, mode)` wraps the raw user prompt as `<user_input mode="build|ask|plan">…</user_input>`; `formatModeSwitchNotice(from, to)` returns the `<mode_notice>…</mode_notice>` block; `createModeSwitchNoticeTracker()` is the factory (tests use it for isolation), and `modeSwitchTracker` is the exported singleton. Round-trips (build→ask→build before sending) cancel the pending notice via the tracker (it stores only the last `from`/`to` pair; a record matching the pending `to→from` clears it). The runner (`runner-native.ts`) wraps the raw `${prompt}` and prepends any consumed notice to the first user message; the per-turn `[MODE: ASK — …]` section (`modeSectionFor` in `modes.ts`) is COMPLEMENTARY — the wrap is the persistent transcript-visible tag, the section is the full per-turn behavioral contract.
- `sanitize-tool-input.ts` — tldraw pattern 6.5 (sanitizeAction) central pre-execution sanitizer. PURE (no imports from `tools.ts` → no cycles, no side effects). Every typed `pen_*` tool action passes through `sanitizeToolInput(toolName, args, opts)` BEFORE the existing `normalizeToolParams` + `repairArrayArgs` (alias layer) and the brief/approval/verify-budget gate wrappers see the args. Catches four recurring LLM-drift classes: (1) stringified numbers in known numeric fields (`{ width: "200" }` → `{ width: 200 }`) — the `NUMERIC_FIELDS` set covers geometry, typography, stroke/radius, auto-layout, duplicate-layout, z-index; (2) unknown top-level fields for tools listed in `TOOL_FIELD_WHITELIST` (currently 8: `pen_create_node` + 7 mutation tools — extends one tool at a time as new hallucination patterns are observed in production logs, conservative by design); (3) empty-string fields (`{ fill: "" }` → dropped, treated as "absent" so the schema's Optional default applies); (4) shape-id references to non-existent canvas nodes — singular `SHAPE_ONLY_ID_FIELDS` (`nodeId`/`shapeId`/`parentId`/`newParentId`/`maskId`/`instanceId`/`variantComponentId`/`componentId`/`groupId`) and array `SHAPE_IDS_FIELDS` (`nodeIds`/`shapeIds`/`componentIds`/`groupIds`) are validated against the `opts.existingShapeIds` lookup; a referenced id that doesn't exist returns `{ ok: false, error }` so the runner surfaces a structured error pointing the model at the corrective tool (`pen_get_metadata` / `pen_find_nodes`) instead of letting the tool body emit its own ad-hoc "not found" message (the #1 cause of the stuck-loop class the OpenHands stuck-detector was added to break out of — pre-empt the loop instead of detecting it). Returns `{ ok: true, args, warnings } | { ok: false, error }` — the discriminated-union form of the task spec's "returns null + an error message". Wired in `runner-native.ts` `assembleOrderedTools` as the OUTERMOST wrapper layer (the brief/approval/verify-budget gates ride on top of `sanitizerWrapped`, so the human reviewer + budget counters see the SANITIZED args).
- `ai-context.ts` — tldraw pattern 6.4 (three-tier AI canvas context). PURE builders + an async screenshot wrapper. The agent's prompt context now carries THREE parallel representations of the canvas state alongside the existing single-tier CANVAS SNAPSHOT (additive — the legacy snapshot is NOT ripped out): (1) FOCUSED shapes — simplified JSON of shapes inside the viewport, with internal UUIDs stripped to short indices (`s0`/`s1`/…), the coordinate system normalized to the viewport's top-left (the model sees coords near (0, 0) instead of 4-digit negative offsets), and verbose fields dropped (zIndex/locked/visible/componentId/tokenBinding/shadows/radii/gradient/blendMode/flipX/flipY/clip/constraints/v3-mirrors — the model can re-derive these via `pen_get_metadata` if needed); `parentId` is remapped from the internal UUID to the focused short-id when the parent is also focused (dropped otherwise). (2) PERIPHERAL clusters — shapes OUTSIDE the viewport, clustered by spatial overlap via a union-find on the pairwise-overlap graph (O(n²) on the peripheral set, fine for ≤500 shapes), each cluster reduced to `{ clusterBounds, numberOfShapes }` (a bounding box + a count — spatial awareness without the token cost for full geometry). (3) VIEWPORT screenshot — a PNG of the viewport via the existing `renderCanvasToPng` worker (translated by `(-viewport.x, -viewport.y)` so the viewport's top-left lands at (0, 0) in the PNG); returns a `data:image/png;base64,…` URL or `null` on render failure (the runner pushes it onto `promptImages` for vision-capable models — text-only models still see the focused/peripheral text sections). PERFORMANCE GUARD: `buildAIThreeTierContext` sets `fallback: true` when the canvas exceeds 500 shapes (the clusterer's O(n²) cost is prohibitive above that ceiling); on fallback, the section text is empty (the existing single-tier CANVAS SNAPSHOT carries the turn alone) and a `console.warn` is logged. `computeViewportBounds(canvas)` derives the canvas-space viewport rect from the canvas's `viewport: { zoom, panX, panY }` (assumes 1440×900 desktop — the server doesn't know the client's exact screen dims, so the rect is approximate; the model interprets it as "what the user is looking at" alongside the focused JSON, not as pixel-perfect bounds). Falls back to the natural shape bounding box + 80px margin when the canvas has no usable viewport info (the HTTP fallback path that sends a bare-bones CanvasDocument).
- `prompt-intent.ts` — PURE poor-prompt heuristic `looksLikeEditReference(prompt)`: edit-shaped anaphora ("make it blue", "change the color", "make it bigger") with NO concrete creation artifact. Powers the EMPTY-CANVAS EDIT GUARD (poor-prompt hardening 2026-09-07): on a build turn with an empty canvas + edit-reference prompt, the runner injects a hard clarification contract into the first user message, stands down the brief pre-generation (its "build directly from this brief" injection was the hallucination's accomplice), and clears `expectsCanvasOutput` so the text-only-design-turn retry/error guards treat the clarification as the turn's correct terminal output. Live evidence: "make it blue and bigger" on an empty canvas went 193s + 8 hallucinated shapes → 10s + honest clarifying question. Not consulted on non-empty canvases (the snapshot/selection context resolves anaphora there).
- `history-replay.ts` — PURE cross-turn conversation-history replay (extracted from runner-native's `buildConversationHistory`, audit 1 P3; the multi-turn-abuse hardening 2026-09-07 made it a standalone module for unit-testability — the prompt-intent.ts extraction pattern). Owns: `foldHistoryPairs` (user_message → turn_final pairing, orphan-tolerant), `clip` caps (6 turns / 1200 chars per message / 6000 total), diff chips, `stripSystemMarkers`, and two abuse defenses: (1) `neutralizeHistoryMarkers()` — replayed user/assistant text cannot forge history structure (`user:`/`assistant:` labels → `user·`/`assistant·`, `---` turn separators → em-dash, `[SYSTEM …]`/`[canvas: …]`/other context-block headers → parenthesized) so a prompt that pastes a fake transcript degrades to QUOTED TEXT in every later turn's [CONVERSATION HISTORY] block, never to trusted meta-instruction; (2) the REPEAT-PROMPT LOOP breaker — when the trailing turns (including the live prompt, threaded by the runner) repeat the same normalized text ≥3 times, a `[REPEAT PROMPT NOTE]` instructs ONE clarifying question instead of another compounding restyle. runner-native keeps the thin journal-reading wrapper `buildConversationHistory(documentId, currentPrompt?)` (exported, back-compat signature) plus the `buildConversationHistoryEx` variant that also returns the trailing `repeatCount` — the runner uses it for the IMMEDIATE-REPEAT EXCEPTION: at repeatCount ≥ 2 (a verbatim re-send) `expectsCanvasOutput` flips to false so the text-only-design-turn guards accept the model's correct push-back ("I already applied that — what specifically should change?") as terminal output. Found live by the abuse battery: without it, the 2nd/3rd `make it pop` text-only reply burned the full provider-fallback ladder (4 attempts + sandbox swap) and ERRORED the turn — 77s/81s error → 11s/10s complete after the fix.
- `plan-tools.ts` / `plan-gate.ts` — `submit_plan` tool (PLAN mode only) + the pending-plan approval map (PlanApprovalCard ↔ `/api/agent/plans`).
- `validators.ts` — `validateCanvasBeforeComplete` (the FREE pre-complete validation gate: shape-count, typography-hierarchy, card-shadow, autoLayout rules).
- `prior-content-guard.ts` — protects earlier turns' shapes during critique fix-turns (critique re-prompts scope their patches to the CURRENT turn's output).
- `shape-line.ts` — the shared `formatShapeLine` vocabulary (canvasSnapshot + `pen_get_metadata` detail mode + delta digest must never drift; bump `PROMPT_VERSION` when it changes).
- `event-journal.ts` — server-side append-only agent event journal (OpenHands-style; powers run history + replay).
- `boot-recovery.ts` — boot-time interrupted-run recovery (restart-crash pattern).
- `active-sessions.ts` — active agent-session registry (R8c real steer).
- `draft-store.ts` — per-document chat draft persistence.
- `turn-diff.ts` — turn-level diff summary ("what the agent changed" cards).
- `chat-commands.ts` / `chat-mentions.ts` — slash-command registry + @-mention engine for the agent chat input.
- `attachments.ts` — image attachments for the agent chat.
- `variant-parking.ts` — PURE patch builder for `pen_generate_variants`: after dispatch applies the winner, wraps runner-up variants in labeled `section` nodes on the Explorations page via page-target `add_subtree` ops; FIFO prune at 5 per document. `buildParkingPatches()` returns the patch sequence + `ParkedAlternative[]` (the `id` is the section node id, the stable promote key for `agent:alternatives_parked`). No side effects; consumed by `tools.ts` (dynamic import).
- `model-catalog.ts` — server-only model-listing helper: `listModelsForSettings()` mirrors the resolver's dispatch (endpoint `GET /models` vs pi-ai static catalog vs unverified suggestions) so the ModelSwitcher lists models that will actually resolve on the next turn. Caches endpoint fetches (30s per `baseUrl + apiKeyPrefix`) and the z.ai-sandbox probe (60s). Unit-testable pure helpers (`parseModelsResponse`, `toSummary`, `endpointModelsFromIds`) are exported.
- `tier-allowlists.ts` — tier-aware tool allowlists for the speed-parity spec: `classifyTier(prompt, canvasShapeCount)` maps a prompt to `trivial / simple / multi / complex / enterprise`; the runner intersects the category allowlist with the per-tier set (`getTierAllowlist`) AFTER one-shot slimming; `TIER_MAX_ITERATIONS` / `TIER_MAX_CRITIQUE_ITERATIONS` provide tier-aware iteration caps (settings overrides win). Enterprise tier is no-op (`null` allowlist = full category set).
- `prompt-history.ts` — terminal-style prompt recall for the agent chat: `pushPromptHistory` (dedupes consecutive, caps at 50, persists to `localStorage:agentcanvas.prompthistory.v1`), `getPromptHistory`, `navigateHistory(cursor, direction)`. Pure module — no React; consumed by `AgentPanel.tsx`.
- `tool-errors.ts` — standardized not-found / error tool responses.
- `layout-gate.ts` — the staged-flow gate: defines `submit_layout_approval` (`submitLayoutApprovalTool`, registered only when the staged flow is active in `runner-native.ts`), `lofiToolNames()` (the restricted lo-fi toolset — wireframe category minus hi-fi styling composites + `ask_user_question`), and `LOFI_EXCLUDED_TOOL_NAMES`. The approval map (`pendingPlans`) is shared with `plan-gate.ts` — `submit_layout_approval` calls `submitPlanProposal()` / `recordApprovedPlan(kind: 'layout')` from `plan-gate.ts`, which owns the actual pending map; `plan-gate.ts` does NOT define `submit_layout_approval`.

## Local Contracts

### Tool surface (104 tools registered in production — do not rename/remove without parent-level decision)
All canvas tools are prefixed with `pen_` (e.g., `pen_create_node`, `pen_update_node`). The web tools (`web_search`, `web_fetch`) have no prefix. Figma tools use `figma_` prefix. Plugin tools (up to 32, from `plugins/`) are added when their plugin is enabled. The staged-flow gate tool `submit_layout_approval` has no prefix (it is a gate tool like `submit_plan`).

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
- **Staged-flow gate (1)**: submit_layout_approval (lo-fi → approval → hi-fi flow; registered ONLY when the staged flow is active)

Registry views: `ALL_TOOL_NAMES` in `skills/registry.ts` = 95 entries / 94 unique (85 canvas + 8 pen-aligned + 2 web; `pen_get_metadata` is listed twice — Core and Phase 3; excludes the 10 always-loaded figma tools). `runner-native.ts` registers all 104 production tools (97 base + the 6 composites + 1 staged-flow gate tool; canonical + alias entries so stale transcripts still dispatch), then filters the LLM-visible catalog to the skill's allowedTools MINUS `TOOL_ALIASES` keys, plus enabled plugin tools.

### Batch construction (`pen_create_subtree` + the `add_subtree` patch op)
One call = one or MANY whole NESTED component trees (`nodes[]` multi-root batches — Agent Performance Package change 1; the round-trip-tax killer: hi-fi evals previously spent 28-29 calls assembling primitive stacks). Each root emits one `add_subtree` patch — one undo step, one broadcast — and `patch.ts`'s `normalizeSubtree` RECURSIVELY maps legacy spellings, fills defaults, and assigns deterministic ids (`rootId-<index>` for id-less descendants, so patch replay is idempotent). The result embeds the FULL id-manifest + inline resolver warnings — the mandatory `pen_get_metadata` read-back round trip is gone. Schema is deliberately LOOSE (Type.Recursive + object∪JSON-string unions): pi-ai validates TypeBox BEFORE execute, so strict schemas would hard-fail the stringified params models actually send (the LooseShapeInputSchema gotcha, applied recursively). Guards: 150-node budget, atomic icon-name validation (whole call fails before any patch), unknown-parentId hard error, top-level frame placement guard reused from pen_create_node. Registered as a CORE tool (always loaded) + the wireframe skill narrative.

### Batch duplication (`pen_duplicate_nodes`)
`count` / `direction` / `spacing` batch duplication — the 78-call "turn one card into three" case is now ONE call (Agent Performance Package change 2); also fixes the silently-ignored `offsetX`/`offsetY` (offsets apply in the given direction with the given spacing). Registered in the layout skill ("duplicate this" → 24px offsets).

### Resolver-warning delivery (agent-visible degradation reporting)
The pen resolver degrades silently no more: `resolvePenTreeDetailed` returns `warnings: ResolverWarning[]` (placeholder_size, dropped_ref, ref_unexpanded, unknown_node_type, unresolved_variable, path_geometry_dropped, effects_dropped — deduped by nodeId+kind, mirrored into `ResolveOpts.warnings`). Three delivery layers feed the LLM: `pen_get_metadata` appends a `RESOLVE WARNINGS` section on every read (`collectResolverWarnings`/`formatResolverWarnings` in tools.ts, threaded with `getMeasuredBounds` so browser-measured nodes don't produce placeholder false-positives), `canvasSnapshot` (runner-legacy.ts) carries the same section into the per-turn system prompt, and `pen_create_node`/`pen_create_subtree` run a pre-flight variable-reference validation (`collectVariableReferences`/`buildUnresolvedVariableWarning` in tools.ts) that walks the subtree before patch application and appends a `VARIABLE REFERENCES` warning to the tool result when any `$ref` doesn't resolve against `doc.variables` — with close-match suggestions (e.g. `"$color.primary"` → `Did you mean "$primary"?` when `"primary"` is defined). Degradation checks live in the resolver's per-node hot path — keep them O(1) (Set lookups, presence guards) or the 4k-node audit test times out.

### Skill categories (7 + multi)
wireframe, layout, styling, inspect, export, web_research, vector, multi

### executeTool enhancements (Tier 1)
- **Response token cap**: `MAX_TOOL_RESULT_CHARS = 25_000` — tool results are truncated to prevent context bloat
- **Argument repair (poka-yoke)**: `repairArrayArgs()` (in `tool-aliases.ts`) detects and fixes array params passed as stringified JSON strings (e.g. `palette="[\"#fff\"]"` → `palette=["#fff"]`). Known-affected params: palette, shapeIds, nodes, updates, stops, points, shapeId, descendants. Applied in BOTH the native path (via `applyToolAliases` wrapper) and the legacy path (via `executeTool`).
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
- **Default LLM (2026-09-19)**: `agnes` / `agnes-3.0-flash` / `https://apihub.agnes-ai.com/v1` (see `src/lib/settings/AGENTS.md`). The `agnes` provider is registered in `src/lib/llm/registry.ts` (capability preset `CAPS_FULL` — tool calling + streaming + vision); its `apiKeyEnvVars` list `AGNES_API_KEY` so the resolver picks the key up from `.env` without a Settings UI prompt. The legacy `zai` / `glm-5.3` sandbox-credentials path remains selectable in Settings AND is the reactive fallback when agnes returns 5xx / network error / empty body (see the fallback ladder below). Whenever `settings.apiBaseUrl` is set on an OpenAI-compatible provider, the resolver builds a SYNTHETIC pi-ai `Model` (`api: 'openai-completions'`, provider id `custom`, neutral compat profile — no z.ai thinking/tool_stream params) and registers a minimal dispatch provider on the per-turn `ModelRuntime`, because pi-ai's static catalog doesn't know user-supplied endpoints. Legacy `glm-4.6` settings map to `glm-4.7`. Verify with `bun run scripts/verify-default-llm.ts`.
- **Automatic z.ai sandbox fallback** (`pi-ai-model-resolver.ts` + `runner-native.ts`): when a user-configured custom endpoint is unreachable, the runner retries the SAME turn ONCE using the z.ai sandbox client (`ZAI.create()` from `z-ai-web-dev-sdk`) with model `glm-5.3`. The user effectively gets resilient LLM access via z.ai sandbox as the fallback — agent turns SUCCEED even when a custom endpoint is dead. Three layers cooperate:
  1. **Preflight** (`pi-ai-model-resolver.ts → preflightEndpoint()`): a 4s GET against `${baseUrl}/models` with `Authorization: Bearer ${apiKey}`, called when `useCustomEndpoint && providerId !== 'zai'`. Cached 60s per `(baseUrl, apiKeyPrefix)` so we don't pay the 4s latency on every turn. Returns `'ok'` on HTTP 2xx, `'down'` on network error / TLS reset / DNS failure / abort timeout / any non-2xx status (5xx, 429, 401, 403). On `'down'`, the resolver returns a z.ai-sandbox-resolved `glm-5.3` Model (`resolveZaiSandboxFallback()`) with `usedFallback=true` INSTEAD of the synthetic custom Model — the runner then creates the AgentSession against the z.ai sandbox model directly, so there's no double `turn_end` / streaming weirdness.
  2. **Same-provider rate-limit backoff** (`runner-native.ts`, Task 7-c): BEFORE any provider switch — a rate-limit-shaped failure (prompt() threw with `429`/`rate`/`empty response`/`overloaded` in the message, or a zero-output settle) with ZERO user-visible events re-runs the turn on the SAME model after a 20s, then a 45s backoff (max 2 retries per turn; attempt loop bound 4). Logs `console.warn('[llm-retry] attempt N after Xs — provider rate-limited …')` and emits throttled `agent:tool_progress` heartbeats (`toolCallId: 'llm-retry'`) that feed the route's 120s stream watchdog during the sleep; a client abort mid-backoff cancels the retry. This is what absorbs the burst-usage 429s that killed 40-50% of eval turns.
  3. **Reactive fallback** (`runner-native.ts`): if the preflight passed (`usedFallback=false`) but the turn still produced zero `message_delta` AND zero `tool_call_start` events (e.g. the endpoint returned an empty 200 body) — and the backoff tier above is spent or not applicable — the runner re-creates the AgentSession with a freshly-resolved z.ai-sandbox Model and re-runs the turn. Bounded by `!currentModel.usedFallback` — if the preflight already swapped, the runner does NOT swap again (one provider switch per turn; the legacy 8s same-model net remains for non-rate-limit shapes like text-only design turns).
  - **Bounding & safety**: bounded by the 4-attempt loop bound — at most 2 same-provider rate-limit backoff retries (rate-limit signature + zero user-visible output only), ONE provider swap per turn (no infinite loops); the swap is skipped when the configured provider is already `zai` (no point falling back to the same provider) and when `ZAI.create()` throws (not in the z.ai sandbox / no creds) — the fallback is skipped with a `console.warn('[llm-fallback] …')` and the turn surfaces the original error. Does NOT skip on user-error 4xx from OUR malformed request (e.g. 400 bad request) — the preflight treats all non-2xx as `'down'`, but the cost is one extra failed attempt, which is acceptable (the retry would fail the same way and the silent-failure guard surfaces the error).
  - **Server-side log**: `console.warn('[llm-retry] attempt N after Xs — provider rate-limited …')` for the backoff tier, `console.warn('[llm-fallback] primary endpoint <reason>; retrying turn with z.ai sandbox / glm-5.3')` for the swap. The preflight uses reason `'unreachable (network error or non-2xx on /models)'`; the reactive layer uses reason `'produced no output (zero message_delta + zero tool_call events)'`.
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
- Fallback: lightweight LLM call seeing only 7 skill descriptions (not the 94-tool list). Only used when keyword confidence < 0.7 AND not a multi-step prompt.
- Multi-step detection: requires a connective word (then/and/after/next) + multiple skill matches. For multi-step, the LAST skill in the prompt (final deliverable) becomes the primary category.
- Eval: `bun run scripts/eval-agent.ts` — 20 prompts; gate is ≥ 80% accuracy (currently passing at 95%).

### Plan module
- Triggered when `classification.recommendPlan` is true
- Makes a lightweight LLM call seeing only skill descriptions + user prompt
- Returns 2-5 ordered steps, each mapping to a skill category
- Plan is injected into the system prompt as an XML-tagged `<plan>` block
- Step status updated as execution proceeds (pending → in_progress → completed)
- **INERT on the native path**: `generatePlan()` returns null without an LLM
  (planner.ts) and runner-native passes `llm: undefined` — the block survives
  only for `agent:plan` event-shape parity with the legacy runner. Real
  planning is the PLAN-mode `submit_plan` gate (see Modes below).

### Modes (`modes.ts` — Cursor-style Build / Ask / Plan, 2026-08-30)
`AgentMode` rides `AgentRunSettings.mode` (settings store `agentMode`, slash
commands `/ask` `/plan` `/build` `/multitask`, Shift+Tab cycling, and a picker
next to the composer — see `components/canvas/AGENTS.md`). Semantics, all
enforced in the TOOL REGISTRY (prompt-only restrictions decay — Cursor's own
plan-mode violations documented this):
- **build** (default): byte-identical to pre-mode behavior; no filter.
- **ask**: read-only — `categoryAllowedToolNames` is intersected with
  `ASK_MODE_TOOL_NAMES` (parallel-safe reads + `ask_user_question`, todo,
  memory, scratchpad). Mutating tools are PHYSICALLY absent from the LLM's
  tool list. Canvas-anchored questions route via the classifier override
  (classifier.ts — "what is on my canvas" stays inspect, never web_research).
- **plan**: ask set + `submit_plan` (the ExitPlanMode analog — plan artifact
  as a TOOL call, never plain text). `plan-gate.ts` holds the pending map:
  `agent:plan_proposed` → PlanApprovalCard → POST `/api/agent/plans`
  ('build' | 'revise' + feedback) → 10-min timeout. GET `/api/agent/plans`
  lists pending plan ids (reconnect diagnostics — twin of
  `/api/agent/pending`, backed by `getPendingPlanProposals()`). On approval
  the runner disposes the planning session and creates a SECOND session with
  `buildToolsForPlanMode` (full build toolset, mode filter removed) whose
  first user message carries the original request + the approved plan
  verbatim; the critique loop runs on that execution session.
- **Legacy-runner mode guard** (audit follow-up): `runAgentLegacy` is the
  TEST-ONLY path (`injectedLlm`) and has NO mode gating — it now THROWS for
  any non-build `settings.mode` instead of silently running mode-blind (a
  test that passed via the legacy loop while production enforced the mode
  was a false green). Mode behavior is covered by
  `tests/unit/modes-2026-08-30.test.ts` (pure functions + allowlists +
  runner-native source invariants).
- **Post-approval hard stop** (stress-test round 3, live-verified fix): the
  approved `submit_plan` result tells the model to STOP, and
  `planCompletionBlocker` (runner-native) enforces it — after
  `hasApprovedPlanSince(runStartedAt)`, EVERY tool in the planning session
  returns a terminal `planning_complete` error so the model can only end its
  turn. Without this the model kept executing in the read-only session
  (todo spam + "Tool pen_insert_html not found" for minutes).
- **`/multitask`** (forces build): `subagents/multitask.ts` decomposes the
  prompt (one cheap LLM call → 2-5 screen tasks + sharedStyle), generates
  screen specs in parallel with disjoint region lanes, applies them as
  patches with Gate-0 validation, and degrades to the single-agent path on
  <2 tasks or any decomposition failure.
- **Adaptive critique ladder** (`shouldRunCritics`): per-turn critics are NOT
  free-running — they run only when the turn is big enough to plausibly need
  them (≥20 new nodes, fresh-doc ≥12, ≥3 validator issues) or the prompt
  asks for critique (`/critique` forces the full pass); otherwise
  `agent:critique_skipped` tells the UI what was saved. This is the
  Cursor/tldraw lesson: on-demand / phase-boundary critique, never
  unconditional per-turn self-review.

### Staged design flow (2026-09-12 — designer-workflow-parity Tasks 7–10)
The staged design flow mirrors a Figma designer's process: brief → lo-fi layout exploration → direction approval → hi-fi fidelity pass. Detection fires via `shouldOfferStagedFlow()` in `prompt-intent.ts` (pure helper co-located with `looksLikeEditReference`) when ALL of: mode is 'build', no repeat-prompt guard is active, the prompt is creation-shaped (NOT an edit reference), the canvas is empty OR the prompt carries explicit new-screen intent, the prompt does not opt out, and the variant-dispatch condition is NOT met (mutual exclusion with variant exploration).

When detection fires, the runner injects a STAGED FLOW directive into the first user message: the agent's FIRST action must be one `ask_user_question` with two options — "Lo-fi layout first (recommended)" and "Straight to hi-fi". If the user picks hi-fi, the ask times out, or the ask errors, the turn proceeds as today (one-shot).

**Lo-fi phase**: the agent generates the layout skeleton using ONLY the lo-fi toolset (`lofiToolNames()` in `layout-gate.ts` — wireframe generators + structural tools minus hi-fi styling composites like `pen_apply_design_system`, `pen_apply_typography`, styling/variable/token tools). The session ends its generation phase by calling the gate tool:

**`submit_layout_approval`** (in `layout-gate.ts`) — PLAN-mode `submit_plan` analog. Payload: ordered layout summary (sections, their contents, notable placement decisions) rendered by the approval card. The tool is registered ONLY when the staged flow is active. On call it emits `agent:plan_proposed` with `kind: 'layout'` (the shared approved-plan slot; the runner discriminates by `kind`), creates a pending approval in the gate map, and blocks the session (`planCompletionBlocker`-style terminal errors for every subsequent tool in the lo-fi session). On approval ('build' decision via POST `/api/agent/plans`), the runner disposes the lo-fi session and creates a SECOND session with the full build toolset whose first user message carries the original request + the approved layout verbatim; the hi-fi pass runs on that execution session. On 'revise', the user's feedback is returned as the tool result and the agent revises the layout.

**Variant runner-up parking (Tasks 3–6)**: when the variant generator dispatches (ambiguous creation prompts), the winner is applied as before, but the runner-up variants are now PARKED on the Explorations page (a dedicated page created via `add_page` with `pageName: 'Explorations'`) instead of discarded. The parking patches are `add_subtree` ops with `pageId: 'Explorations'` (page-target patch ops — see `src/lib/canvas/AGENTS.md`). After parking, the runner emits `agent:alternatives_parked` with the parked section node ids + thumbnails + judge scores. The frontend renders an AlternativesCard promote card; "Use this" calls the store action `promoteAlternative(sectionId)` which POSTs `/api/documents/[id]/variants/promote` (Task 6 route) to swap the parked design into the active page.

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
- `agent:plan_proposed` / `agent:plan_resolved` — PLAN-mode approval gate (PlanApprovalCard ↔ `/api/agent/plans`)
- `agent:alternatives_parked` — pen_generate_variants parked the judged runner-up designs on the Explorations page (emitted after the parking patches; journaled). The frontend renders the AlternativesCard promote card from it; `alternatives[].id` is the parked section node id (the promote route's key) and `pageId` is advisory-only. Journaled via `JOURNALED_AGENT_EVENT_TYPES`; the JOURNALED copy strips `alternatives[].thumbnail` (`journalPayloadFor` in event-journal.ts — thumbnails would blow the 65K row cap into invalid JSON that replay skips; the live wire event keeps them) so a reconnecting viewer always rebuilds the card.
- `agent:critique_skipped` — adaptive critique gate declined the critic pass (with reason + saved-LLM-calls estimate)
- `agent:subagent_dispatch` / `agent:subagent_result` — sub-agent lifecycle
- `agent:thinking_delta` — model thinking tokens
- `agent:context_update` — context compaction happened (SDK auto-compaction; `compaction_start` also raises an `agent:status_note` "Compacting context…" so the 10-30s summarization call isn't dead air)
- `agent:ask_user_question` / `agent:ask_user_answered` — blocking question flow (resolved via `/api/agent/answers`)
- `agent:todo_update` — plugin todo list changed
- `agent:background_task_started` / `agent:background_task_complete` — background tasks
- `agent:mcp_server_status` — MCP server connection state
- `agent:tool_progress` — long-running tool heartbeat (variant explorer, plan-approval wait) AND — since stress-test round 3 — the throttled translation of the SDK's `toolcall_delta` events while the model COMPOSES a large tool-call argument ("Composing pen_create_subtree arguments… 4.2 KB"). Without this feed, a >120s argument generation produced zero wire events and the route's stream watchdog killed the run mid-generation ("Agent stream stalled", empty canvas).

### Patch sink
- The runner applies each patch to a local copy of the canvas via `applyPatchToCanvas` (from `../canvas/patch.ts`) and emits the patched document state as part of the event.
- The runner does NOT touch the database or the Zustand store — it is a pure producer. The API route is the consumer that forwards events to viewers.

### Number safety
- All numeric shape fields MUST be coerced with `Number()` before any `.toFixed()` / `Math.round()` call. The `round()` helper in `runner-legacy.ts` exists for this.

## Work Guidance

- **Tool-schema byte budget (2026-09-06, z.ai sandbox gateway cap)**: the sandbox gateway rejects requests whose total prompt (tool schemas + messages) crosses ~24k tokens with `400 Prompt exceeds max length` — surfaced as `stopReason: 'error'` with empty usage. The tool payload is re-sent EVERY LLM round, so keep the serialized registry lean (~43k chars after the 2026-09-06 slimming; was 57k). `pen_create_node` owns the FULL canonical `ShapeInputSchema` (the field reference the model reads); update-style tools (`pen_update_node`, `pen_bulk_update_by_filter`) use `CompactChangesSchema` — unknown fields pass TypeBox validation (extra properties allowed) and are normalized at runtime by `coerceShapeInput`, so full-field updates keep working. When adding tools, prefer compact schemas + `see pen_create_node` pointers over re-inlining the full field set.
- **stopReason 'error' surfacing**: a message ending with stopReason `error` resolves prompt() WITHOUT throwing, so the retry tiers skip it. The runner tail emits an honest `agent:error` (turn status `error` → the UI retry banner) instead of exiting "complete" with a half-built canvas. Deliberately NOT auto-retried: the turn already drew, and a full re-prompt against the partial canvas risks rebuild duplication.
- When adding a tool: define it in `tools.ts`, add the `executeTool` case, add it to the relevant skill's `allowedTools` in `skills/registry.ts`, add it to `ALL_TOOL_NAMES`, update the system prompt if needed.
- When adding a plugin tool: work in `plugins/` (see `plugins/AGENTS.md`) — do not add plugin tools to `tools.ts`.
- When adding a skill: see `skills/AGENTS.md`.
- When changing a tool's schema: every prior session replay that called the old shape will fail. Consider adding a new tool instead.
- When debugging the agent loop: check `dev.log`, reproduce via `/api/agent`, use Agent Browser for end-to-end verification.
- The legacy runner has a `maxIterations` guard (default 30, user-configurable via Settings → Agent). Exceeding it emits `turn_end` — do not raise.
- The .pen-aligned tools (pen_set_variable, pen_apply_theme, pen_create_ref, etc.) are ALWAYS available regardless of skill, because they expose pen.dev concepts that are relevant to every design task.
- When adding a .pen-aligned tool: define it in `pen-tools.ts`, add it to `PEN_TOOL_NAMES`, add it to the runner's `filterToolSpecs` logic if needed.
- `pen_canvas_ui_control` (defined in `canvas-ui-tool.ts`, task impl-canvas-ui-tool) is ALWAYS available regardless of skill — it's the OpenHands `canvas_ui_control` pattern (5.4): a cross-cutting UI nudge the agent reaches for after creating/updating a shape so the canvas is visible while the user reads the chat summary. Added to `ALL_TOOL_NAMES`, the runner's always-included set, and `PARALLEL_SAFE_TOOL_NAMES` (no canvas mutation — emits an `agent:canvas_ui_action` SyncEvent + acks; the dispatcher in `src/lib/canvas/canvas-ui-dispatcher.ts` performs the side-effects client-side).

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

### P1.3 / T2 — Self-critique loop with MAX_ITERATIONS=2 (`runner-native.ts` + `runner-legacy.ts` + `AgentRunSettings.maxDesignCritiqueIterations` + `AgentRunSettings.designCritiqueMode`)
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
Default `maxDesignCritiqueIterations = 2` — agent gets 1 chance to self-correct after the critic. The legacy runner mirrors a simplified version (text critic only, no VLM — gated on `!injectedLlm` so tests using MockLLM don't trip the loop). UPDATE (Agent Performance Package change 8): the loop runs the FREE validation gate (`validateCanvasBeforeComplete`) FIRST, SKIPS the VLM critic for small clean edits, and runs the text + VLM critics CONCURRENTLY before merging defects. UPDATE (2026-09-06 — invocation is now MODE-GATED, not mandatory): `AgentRunSettings.designCritiqueMode` ('manual' DEFAULT | 'auto' | 'off', defined in `modes.ts` `DesignCritiqueMode`, user-facing in Settings → Agent → Design critique) decides WHEN the critic subagents dispatch: 'manual' = only on explicit user intent (/critique or a critique/polish prompt — `promptRequestsCritique`), 'auto' = the adaptive complexity ladder (the previous behavior), 'off' = never. The gate is `shouldRunCritics({ ..., critiqueMode })` in `modes.ts`; `agent:critique_skipped` carries the reason ('manual_mode' offers the /critique escape hatch; 'critique_disabled' stays silent). The deterministic validation gate (free) still runs every build turn in every mode.

### P1.4 / T10 — Pre-complete validation gate (`validators.ts` `validateCanvasBeforeComplete`)
`validateCanvasBeforeComplete(shapes)` runs BEFORE the agent's final message is committed. Rules (each produces a specific failure reason):
1. `< 5 shapes` → "Too few shapes — looks like a wireframe"
2. `< 50% of text shapes have non-default fontWeight` → "no typographic hierarchy"
3. `< 50% of card-shaped rectangles have shadow` → "most cards lack shadow (industry standard requires >= 50%)"
4. `zero shapes with autoLayout set` → "no autoLayout detected"
5. `children extending >40px below parent frame` → "child overflow"
6. `text with < 4.5:1 contrast ratio` (WCAG AA) → "insufficient contrast"
7. `root frame with FIXED height clipping children` → "use fit_content"

If validation fails, the runner re-prompts the agent with the failure reasons + "Fix these before declaring done." This catches the exact wireframe-only failure mode the VLM baseline exposed (39 bare scaffolds + 11 pen_set_variable + 7 pen_set_shadow + 1 gradient, ZERO typography fields across 24 text shapes).

### P2.1 / T3 — VLM screenshot critique (`subagents/design-critic-vlm.ts` + `canvas/render-to-png.ts` + `pen_visual_critique` tool)

**Phase 5 §5.4 ground-truth seam — DOM capture is primary.** The VLM critic first asks the connected CLIENT for a real screenshot via the `agent:screenshot_request` round-trip (`client-roundtrip.ts`, 3s budget). On success the critic critiques the actual DOM-rendered picture captured by `html-to-image` against the live `[data-ac-world]` element (log: "VLM critic using real client screenshot"; `screenshotSource: 'client'`). This is the source of truth after Phase 5 — the canvas is DOM-rendered, so the critic must see what the user sees.

**Server-side resvg fallback (D8 discipline).** When the round-trip times out / no-sink / `html-to-image` unavailable, the critic falls back to `renderCanvasToPng(shapes, 1440, 900)` — a server-side SVG→PNG rasterizer that builds an SVG string from the resolved layers (mirroring the DOM renderer's `styleFor.ts` vocabulary but emitting raw SVG markup, with full support for typography fields + gradients + shadows + radii + opacity) and rasterizes via `@resvg/resvg-js` at 2x scale for crisp text. Result carries `screenshotSource: 'server'` telemetry. The same fallback path is used by `pen_get_screenshot`, `pen_get_design_context`, and `pen_export_png` (Phase 5 §5.4 unified contract — all agent-facing surfaces prefer DOM capture; resvg is the no-client fallback).

The VLM critic sub-agent base64-encodes the PNG and calls the vision LLM with the SAME structured-critique prompt used for the Task 7-a baseline (8 dimensions, 1-10 score, top-5 fixes). The "after" score is directly comparable to the 2/10 baseline.

The VLM catches what text-critic cannot see: alignment, whitespace distribution, "generic AI look" (the v0/Midjourney pattern — flat colored divs with no real content density). The critique loop dispatches BOTH critics on each iteration (when the invocation mode allows it — see P1.3 above) and merges their defects before re-prompting the agent.

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
- `bun run test` — tests/unit: 94 files / 2215 tests green (2026-09-07; includes followup-delta-2026-09-07.test.ts pinning the delta-gating fix). Includes runner (MockLLM), tools registration (85), agentic-workflow, component-system, translator dedup (`tests/unit/agent-eval-fixes.test.ts`), and the perf-package + todo-batch/variants suites (`tests/unit/agent-performance-package.test.ts`, `tests/unit/todo-batch-variants.test.ts`)
- `bun scripts/agent-eval/run-eval.ts` — prompt-vs-output scenario suite (8 scenarios; see `scripts/agent-eval/`) — determinism + trajectory + fidelity assertions against the live `/api/agent` route
- `bash scripts/agent-eval/visual-test.sh` — browser-driven visual verification with screenshots to `download/agent-eval/`
- `bun run scripts/eval-agent.ts` — intent classifier eval (20 prompts, ≥ 80% accuracy gate)
- `bun run scripts/measure-tool-cost.ts` — token cost measurement
- Manual: Agent Browser end-to-end test with prompts from each skill category
- Check `dev.log` for runtime errors during a run.

## Mistakes & Lessons

### Failure Modes

- Check `DEFAULT_SETTINGS` is reflected here when the default provider changes — the doc text for "Default LLM" must match `src/lib/settings/types.ts`; drift between this doc, the settings doc, and the llm registry doc confuses the next reader (caught during the 2026-09-19 agnes provider swap).
- Check that a long-running dispatch carries a wall-clock budget with per-phase races — the variant generator's `300s × retry attempts × sequential retry wave × repair round-trips` stalled ONE tool call past 19 minutes before the fix.
- Check that the SYSTEM_PROMPT_TEMPLATE and skill bodies share the same `PROMPT_VERSION` rev — drift between them breaks the design-quality contract without a visible signal.
- Check the canvas delta digest logic uses `nodeIds: null` (not `[]`) when nothing changed — an empty array was truthy and blinded pure follow-up turns to a zero-expanded digest (fixed in `922aa2b`).
- Check that mode switches emit a transcript-visible `<mode_notice>` marker via `mode-tags.ts` — when the user flips build→ask mid-conversation, the runtime narrows the tool surface (the registry intersection), but the model keeps the prior mode's behavioral expectations unless it sees the constraint change in the transcript. The `<user_input mode="…">` wrap on every prompt + the `<mode_notice>` prepend on the first post-switch message are the model-visible signal; round-trips (build→ask→build before sending) cancel via the tracker.

### Lessons Learned
- Parse `AgnesAI_error.code` for friendly error mapping — `model_not_found` / `invalid_request` / `rate_limit_exceeded` / `insufficient_quota` map to actionable UI hints; the `parseLLMErrorMessage` helper in `src/lib/llm/openai-compatible.ts` does this (commit `20c8344`).
- Three-layer schema defense for sub-agent LLM output: prevention (system prompt embeds the schema) → coercion (near-miss mapping) → repair (transcription round-trip at temp 0.1). Never throw on unparseable JSON — salvage what parses.
- Use the same `formatShapeLine` vocabulary across canvasSnapshot + `pen_get_metadata` detail mode + the delta digest; bump `PROMPT_VERSION` whenever the vocabulary changes, otherwise stale transcripts render wrong.
- A default-provider swap (e.g. `zai` → `agnes`) does NOT bump the persist schema — only `DEFAULT_SETTINGS` changes; existing localStorage blobs keep whatever provider the user had, only new users see the new default.
- Wrap user prompts in `<user_input mode="…">` tags so the model sees the active mode in the transcript; on a mode switch prepend a `<mode_notice>` marker. Round-trips (build→ask→build before sending) cancel the notice via the `modeSwitchTracker` singleton (`mode-tags.ts`). The runtime already narrows the tool surface via the registry intersection (`modeToolAllowlist` in `modes.ts`), but the model only adjusts its BEHAVIOR (not its tool attempts) when it sees the constraint change in the prompt — without the notice it keeps answering in build-mode brevity after an ask flip.
- The Action↔Observation in-place replacement (OpenHands pattern 5.3) is already present in `src/lib/canvas/store.ts`: `agent:tool_call_start` appends a `toolCalls[]` entry keyed by `toolCallId` (the `action_id` analog — id-guarded dedupe so a socket.io event in flight at disconnect + a journal-catchup replay can't duplicate the entry), and `agent:tool_call_end` maps the SAME `toolCallId` and REPLACES IN-PLACE (`toolCalls.map(tc => tc.id === event.toolCallId ? { ...tc, success, summary, endedAt } : tc)`) instead of appending a second "result" card. The streaming-placeholder pattern (one assistant turn created at `message_start`, deltas accumulated into the same `text`, `message_end` flips `streaming:false` in place) is the same shape for text — no duplicate "streaming thought" + "finalized message" cards. Adding a second reducer for OpenHands-style `action_id` matching is unnecessary; the existing `toolCallId` reducer is the implementation.
- The agent must explicitly surface what it produced — most agent UIs assume the user will notice. OpenHands's `canvas_ui_control` tool pattern (pattern 5.4) trains the model to drive the UI itself: after writing a shape the agent calls `pen_canvas_ui_control({ command: 'focus_shape', shapeId })` BEFORE writing its chat summary, so the canvas is visible (shape selected + Properties inspector open) while the user reads what the agent did. Failure mode caught during impl-canvas-ui-tool: an agent writes a shape but the user is looking at the Chat tab and never sees the canvas update — the user reads the summary, looks up, sees nothing has changed, and re-asks the same thing. The tool's prompt-engineered description (mirrors OpenHands's paragraph: "The user will NOT see the files you wrote, the terminal output, or the browser unless you call this tool. Call this BEFORE writing your chat-message summary of the change, so the artifact is visible while the user reads what you did.") is the behavioral nudge; the dispatcher in `src/lib/canvas/canvas-ui-dispatcher.ts` is the side-effect boundary.
- Centralized `sanitizeToolInput(toolName, args, opts)` pre-execution pass (tldraw pattern 6.5) is the SECOND line of defense against LLM arg drift, COMPLEMENTARY to the existing `normalizeToolParams` (legacy → canonical param-name map) + `repairArrayArgs` (stringified JSON array → real array) in `tool-aliases.ts`. The alias layer handles RE-NAMED fields; the sanitizer handles MAL-FORMED values: stringified numerics (`width: "200"` → `200`), unknown top-level fields (stripped per `TOOL_FIELD_WHITELIST`), empty-string fields (dropped to fall through to the schema's Optional default), and shape-id references to non-existent canvas nodes (hard-fail with a structured error pointing at `pen_get_metadata` / `pen_find_nodes`). The four classes are non-overlapping with the alias layer's responsibilities, so the two pass cleanly compose (sanitizer runs FIRST, then alias layer). The shape-id existence check is the #1 stuck-loop pre-emption: the OpenHands stuck-detector (already in `runner-native.ts`) catches the SAME failing call signature 3× in a row and stops the loop, but pre-empting at the sanitizer means the model sees ONE error + immediately re-discovers the right id — no wasted iterations, no stuck-detector trip.
- Three-tier AI context (tldraw pattern 6.4) is ADDITIVE — the existing single-tier `canvasSnapshot` (the Figma-style layer-tree text dump) is NOT ripped out. The three-tier context rides the user message as an additional `AI THREE-TIER CONTEXT` section right after `snapshotSection`, plus a viewport screenshot pushed onto `promptImages` for vision-capable models. The existing snapshot's `formatShapeLine` vocabulary + `PROMPT_VERSION` cache-stability contract stay intact (a snapshot rip-out would force a prompt-version bump + invalidate every prior-session replay). The three-tier layer's focused-shape JSON carries short ids (`s0`/`s1`/…) INDEPENDENT of the snapshot's full layer ids — when the model addresses a shape from the focused JSON, it must call `pen_get_metadata` (or use the canonical id returned by `pen_create_node`); the short ids are an IN-PROMPT shorthand for reasoning, not a tool-call addressable id. The 500-shape perf guard preserves the per-turn prompt budget for large canvases — the clusterer's O(n²) cost is prohibitive above that ceiling, and the existing snapshot's `SNAPSHOT_LINE_CAP` collapse path already handles the large-canvas case (collapses long sibling lists to navigation lines with `pen_get_metadata` hydration pointers).
- Next.js dev-mode HMR (Turbopack) does NOT always pick up edits inside an async generator function body used during a streaming request — `runner-native.ts`'s `runAgentNative` (the production agent loop) was edited mid-session and the dev server kept running the OLD compiled chunk until a clean restart (`kill` the next dev PID + `bunx next dev`). Always restart the dev server after edits to `runner-native.ts` before running verification curls — a stale chunk returns HTTP 200 + a working agent_event stream (so the route looks alive) but executes the OLD code (so new wrappers / new prompt sections appear absent). Found during impl-tldraw-context-and-actions: my sanitizer wrapper was in the source file (verified by Grep) but the dev server kept using the cached chunk; the test curls passed because the tool bodies still ran, but the sanitizer's error result never fired. The clean-restart fix is one `kill` + one `bunx next dev` — always do this before declaring verification done on a `runner-native.ts` change.

## Child DOX Index

| Path | Scope |
|------|-------|
| `subagents/AGENTS.md` | 5 isolated-context sub-agents (web-research, design-critic, design-critic-vlm, design-brief, variant-generator) + shared dispatch/timeout/budget contracts. |
| `skills/AGENTS.md` | Skill system: types, registry (7 skills), progressive disclosure levels, eval harness. |
| `plugins/AGENTS.md` | Plugin registry + 8 ported plugins (32 tools, gated by `settings.enabledPlugins`): ask-user-question, todo, memory, mega-compact, goal-list, background-tasks, mcp-adapter, subagents. |
