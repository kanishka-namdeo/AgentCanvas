# Audit 2-b — The Tool Surface (what tools exist, their schemas, descriptions, execution)

Repo: /home/z/my-project @ 1bd21bb (AgentCanvas). Scope: `src/lib/agent/tools.ts`, `pen-tools.ts`, `figma-tools.ts`, `plugins/` (8), `tool-aliases.ts`, `tool-execution-mode.ts`, `validators.ts`, `turn-diff.ts`, `skills/registry.ts`, `prior-content-guard.ts`, `src/app/api/agent/*`. RESEARCH-ONLY — no source modified.

## 0. Precise counts (measured, not estimated)

| Metric | Count | Evidence |
|---|---|---|
| Tools in `tools.ts` | **79** (77 `pen_*` + `web_search` + `web_fetch`) | `defineTool` calls, tools.ts:837–5476; return list 5501–5606 |
| Tools in `pen-tools.ts` | **8** | pen-tools.ts:40–603 |
| Tools in `figma-tools.ts` | **10** | figma-tools.ts:25–432 |
| **Base surface registered** | **97** | runner-native.ts:233–238 |
| Plugin tools (8 plugins) | **32** | plugins/index.ts:66–131 |
| **GRAND TOTAL registered** | **129** | 97 + 32 |
| Plugins ON by default | 4 → **14 tools** (ask_user_question 1, todo 5, memory 5, subagents 3) | plugins/index.ts `defaultEnabled` |
| Plugins OFF by default | 4 → 18 tools (mega-compact 3, goal-list 5, mcp-adapter 5, background-tasks 5) | plugins/index.ts |
| LLM-visible, `multi` skill, default plugins | **110** | computed: ALL_TOOL_NAMES(87 unique) ∪ PEN(8) ∪ FIGMA(10) ∪ plugins(14) |
| LLM-visible, `multi`, ALL plugins enabled | **128** | matches prior audit's "~128 tool definitions" |
| LLM-visible per skill (default plugins) | wireframe **82**, layout 59, styling 56, inspect 50, export 48, vector 46, web_research 45 | computed from registry.ts allowlists ∪ CORE ∪ PEN ∪ FIGMA ∪ plugins |
| Legacy alias entries | 26 (dispatch-only on native; advertised on legacy) | tool-aliases.ts:28–64; runner-native.ts:305–314 |
| Registered but NEVER visible | **1: `pen_visual_critique`** | see Finding T1 |

The skill filter is largely illusory: `PEN_TOOL_NAMES` (8) + `FIGMA_TOOL_NAMES` (10) + all enabled plugin tools are unconditionally unioned into every skill's allowlist (runner-native.ts:297–304), so even the narrowest skill shows 45+ tools and the common `multi` fallback shows **110** — versus the registry's own claim of "56 → ~15-20, well within the safe zone (<25 tools)" (skills/registry.ts:25–26).

## 1. Tool inventory

### 1a. Core canvas ops — `tools.ts` (8)

| Tool | File:line | Category | Purpose | Notes |
|---|---|---|---|---|
| pen_create_node | tools.ts:838 | core-create | Create one node (rect/ellipse/text/line/frame/group/path/image/icon) | "Workhorse"; icon validation + collision guard + overflow warnings — excellent |
| pen_create_subtree | tools.ts:955 | core-create | Batch-create nested tree(s), single root `node` or multi-root `nodes` | Round-trip-tax killer; id manifest in result; loose recursive schema |
| pen_generate_variants | tools.ts:1217 | core-create | 2–3 parallel design variants, vision judge applies winner | Best-in-class desc (when to use / when NOT); good failure fallback text |
| pen_update_node | tools.ts:1451 | core-edit | Patch subset of properties on one node | Accepts loose `changes` (object or JSON string); parent→reparent rerouting |
| pen_delete_nodes | tools.ts:1583 | core-edit | Delete nodes by id array | Destructive (approval-gated + prior-content-guarded) |
| pen_clear | tools.ts:1635 | core-edit | Wipe canvas | Destructive; desc says "cannot be undone in this demo" (stale wording) |
| pen_set_background | tools.ts:1654 | core-edit | Canvas background color | Shortest description (34ch); no hex/px format stated |
| pen_select_nodes | tools.ts:1676 | core-view | Flash-highlight nodes | Transient UI affordance |

### 1b. Layer organization & layout — `tools.ts` (10)

| Tool | File:line | Category | Purpose | Notes |
|---|---|---|---|---|
| pen_duplicate_nodes | tools.ts:1707 | layer | Duplicate N copies row/column in one call | Good batch semantics |
| pen_group_shapes | tools.ts:1759 | layer | Wrap shapes in group | Name still shape-era |
| pen_ungroup_shapes | tools.ts:1784 | layer | Dissolve groups, preserve abs position | |
| pen_reparent_nodes | tools.ts:1812 | layer | Move node(s) to new parent, abs pos preserved | Cycle rejection; batch nodeIds |
| pen_set_constraints | tools.ts:1918 | layout | Figma-style constraints | Desc admits "renderer does not yet enforce these" — write-only metadata |
| pen_align_shapes | tools.ts:1978 | layout | Align / distribute (8 kinds incl. distribute_h/v) | Covers smart-distribute basics |
| pen_organize_layers | tools.ts:2016 | layer | Auto-rename + re-zIndex everything | Whole-canvas only; no scoping param |
| pen_apply_auto_layout | tools.ts:2056 | layout | Auto Layout on frame/group (direction/gap/padding/align) | Legacy spelling only (v3 via normalizeToolParams) |
| pen_set_locked | tools.ts:3311 | layer | Lock/unlock shapes | Redundant with update changes:{locked} |
| pen_set_visible | tools.ts:3328 | layer | Show/hide shapes | Redundant with update changes:{visible} |

### 1c. Z-order — `tools.ts` (5)

| Tool | File:line | Category | Purpose | Notes |
|---|---|---|---|---|
| pen_bring_to_front | tools.ts:3351 | zorder | Top of z-order | 77ch desc |
| pen_send_to_back | tools.ts:3366 | zorder | Bottom of z-order | 80ch desc |
| pen_move_forward | tools.ts:3381 | zorder | One level up | 62ch desc, singular `_shape` naming |
| pen_move_backward | tools.ts:3396 | zorder | One level down | |
| pen_reorder_shape | tools.ts:3411 | zorder | Move to specific z-index | Singular name vs plural siblings |

### 1d. Component system (tools.ts flavor) — 8

| Tool | File:line | Category | Purpose | Notes |
|---|---|---|---|---|
| pen_instantiate_component | tools.ts:2156 | component | Shallow-copy instance of component | Comment admits LEGACY (2222–2225) but desc has no deprecated marker — T4 |
| pen_convert_to_component | tools.ts:2229 | component | Promote existing node to reusable Component | |
| pen_place_component_instance | tools.ts:2268 | component | Place PenRef linked instance | Overlaps pen_create_ref + pen_instantiate_component — T4 |
| pen_override_instance | tools.ts:2310 | component | Override descendant prop on instance | 1 of 3 override tools |
| pen_reset_instance | tools.ts:2370 | component | Clear all overrides | |
| pen_detach_instance | tools.ts:2394 | component | Break link, bake tree | |
| pen_combine_as_variants | tools.ts:2420 | component | Wrap components into ComponentSet | Overlaps pen_create_component_set + pen_add_variant — T4 |
| pen_swap_variant | tools.ts:2465 | component | Switch instance's variant | Overlaps pen_set_instance_property(variant) |

### 1e. Tokens / variables / palette — `tools.ts` (7)

| Tool | File:line | Category | Purpose | Notes |
|---|---|---|---|---|
| pen_set_variables | tools.ts:2496 | tokens | Merge-update doc variables (colors, text styles) | token-era sibling of pen_set_variable (pen-tools) — confusing pair |
| pen_apply_palette | tools.ts:2556 | tokens | Recolor by nearest-color mapping, optional bindToTokens | |
| pen_generate_palette | tools.ts:2643 | tokens | 5-color palette from base color | |
| pen_bind_variable | tools.ts:3158 | tokens | Bind node prop to variable | |
| pen_unbind_variable | tools.ts:3204 | tokens | Remove binding | |
| pen_list_variables | tools.ts:3238 | tokens | List variables | 1 of 3 variable readers (vs get_variable_defs, list_collections) |
| pen_apply_variable | tools.ts:3253 | tokens | Apply (optionally bind) variable to nodes | |

### 1f. Generators & analysis — `tools.ts` (7)

| Tool | File:line | Category | Purpose | Notes |
|---|---|---|---|---|
| pen_generate_wireframe | tools.ts:2721 | generate | Template screen (14 templates) + hifi styling + texts overrides | Longest desc (1208ch); teaches follow-up tools |
| pen_generate_user_flow | tools.ts:2843 | generate | 3–4 connected screens w/ arrows (4 flows) | |
| pen_generate_diagram | tools.ts:2895 | generate | Flowchart / mindmap from labels | |
| pen_generate_copy | tools.ts:2945 | generate | CANNED placeholder copy variants into one text shape | Not LLM copy — lorem-class only |
| pen_audit_design | tools.ts:2997 | analysis | Read-only consistency audit (colors, type scale, contrast, alignment, budgets) | Good report format |
| pen_self_critique | tools.ts:5116 | analysis | Design-critic sub-agent, [BLOCKER]/[MAJOR]/[MINOR] + 1–10 | Duplicated by subagent_reviewer plugin — T8 |
| pen_recommend_components | tools.ts:5283 | analysis | Find repeated patterns → componentize suggestions | |

### 1g. Pattern memory (RAG) — `tools.ts` (4)

| Tool | File:line | Category | Purpose | Notes |
|---|---|---|---|---|
| pen_search_design_patterns | tools.ts:5374 | memory | Retrieve similar past designs | Prior audit: unreachable outside 'multi' |
| pen_save_design_pattern | tools.ts:5420 | memory | Store current design as pattern | |
| pen_clear_pattern_memory | tools.ts:5458 | memory | Wipe patterns | Destructive (approval-gated) |
| pen_pattern_stats | tools.ts:5477 | memory | Memory stats | Marginal value tool |

### 1h. Undo/export — `tools.ts` (7)

| Tool | File:line | Category | Purpose | Notes |
|---|---|---|---|---|
| pen_undo | tools.ts:3434 | undo | Undo last canvas change | Semantics vs turn-restore undocumented — T17 |
| pen_redo | tools.ts:3448 | undo | Redo | |
| pen_export_json | tools.ts:3468 | export | Full doc JSON | 3 overlapping whole-doc dumps (json/pen/metadata) |
| pen_export_svg | tools.ts:3481 | export | SVG string | |
| pen_export_png | tools.ts:3505 | export | PNG data URL (3-tier capture) | Overlaps pen_get_screenshot (desc cross-references it) |
| pen_copy_as_code | tools.ts:3675 | export | HTML/React/Tailwind from canvas | |
| pen_export_pen | pen-tools.ts:462 | export | .pen JSON | |

### 1i. Phase 3 Figma-MCP-aligned reads — `tools.ts` (7)

| Tool | File:line | Category | Purpose | Notes |
|---|---|---|---|---|
| pen_insert_html | tools.ts:3798 | construct | HTML fragment → .pen subtree (v1/v2 modes) | Preferred composite primitive per AGENTS.md |
| pen_get_metadata | tools.ts:3946 | read | Page list / sparse tree / detail line | Well-designed tri-mode read |
| pen_get_variable_defs | tools.ts:4064 | read | Variable defs + codeSyntax | Overlaps pen_list_variables / pen_list_collections |
| pen_get_design_context | tools.ts:4109 | read | 4-part handoff (code+screenshot+instructions+assets) | Composite of copy_as_code + get_screenshot |
| pen_bake_layout | tools.ts:4204 | layout | Write measured bounds into model | |
| pen_get_computed | tools.ts:4286 | read | Live getComputedStyle/getBoundingClientRect | DOM-renderer dividend; measured:false fallback |
| pen_get_screenshot | tools.ts:4360 | read | Real canvas PNG capture | Never hangs; good degraded-result text |

### 1j. Find/filter — `tools.ts` (3)

| Tool | File:line | Category | Purpose | Notes |
|---|---|---|---|---|
| pen_find_nodes | tools.ts:4420 | read | Filter by type/fill/name/parent | |
| pen_bulk_update_by_filter | tools.ts:4445 | edit | Find+update in one call | Good compression tool |
| pen_find_replace_text | tools.ts:4475 | edit | Find/replace across text shapes | |

### 1k. Vector/effects/images — `tools.ts` (12)

| Tool | File:line | Category | Purpose | Notes |
|---|---|---|---|---|
| pen_create_path | tools.ts:4504 | vector | Path from points | |
| pen_boolean_op | tools.ts:4555 | vector | Union/subtract/intersect/exclude | Desc admits "simplified implementation… exclude: hides the second shape" — stub-ish |
| pen_mask_with | tools.ts:4598 | vector | Mask target with shape | |
| pen_set_gradient_fill | tools.ts:4631 | style | Gradient fill | Redundant with update changes:{gradient} |
| pen_set_shadow | tools.ts:4665 | style | Drop shadow | Redundant with update changes:{shadow}; prompt/validator push it anyway |
| pen_set_blur | tools.ts:4699 | style | Gaussian blur | Redundant with update changes:{blur} |
| pen_set_corner_radius_per_corner | tools.ts:4720 | style | Per-corner radii | Redundant with update changes:{radii} |
| pen_upload_image | tools.ts:4758 | image | Place image from URL/data URL | |
| pen_search_icons | tools.ts:4800 | image | Semantic Lucide search + place | Two-in-one tool; good errors w/ suggestions |
| pen_generate_image | tools.ts:4920 | image | **Placeholder rectangle** w/ prompt text | Stub — T9 |
| web_search | tools.ts:4998 | web | Zero-config web search | Breaks pen_ prefix convention (documented) |
| web_fetch | tools.ts:5049 | web | URL → markdown | |

### 1l. Agentic workflow tools — `tools.ts` (3)

| Tool | File:line | Category | Purpose | Notes |
|---|---|---|---|---|
| pen_generate_design_brief | tools.ts:5174 | workflow | Brief sub-agent (v0 GenerateDesignInspiration) | First-call-gated + pre-generated by runner |
| pen_visual_critique | tools.ts:5235 | workflow | VLM 8-dimension critique | **DEAD — never visible to LLM** (T1) |
| pen_self_critique | tools.ts:5116 | workflow | (see 1f) | |

### 1m. .pen-aligned — `pen-tools.ts` (8)

| Tool | File:line | Category | Purpose | Notes |
|---|---|---|---|---|
| pen_set_variable | pen-tools.ts:41 | pen-tokens | Create/update $variable, optional themedValues | **Schema bug: `value` REQUIRED while desc says "value OR themedValues"** — T7 |
| pen_set_explicit_modes | pen-tools.ts:139 | pen-tokens | Set explicitVariableModes on node | **NO-OP: patch `shape:{}`, intent only in summary string** — T5 |
| pen_create_ref | pen-tools.ts:196 | pen-component | Instance `ref` + descendant overrides | 3rd instance tool — T4; nothing required in schema |
| pen_override_descendant | pen-tools.ts:326 | pen-component | Override nested node in instance | Applies overrides to instance ROOT; descendantPath ignored except in text — T5 |
| pen_mark_slot | pen-tools.ts:400 | pen-component | Mark frame as slot | **NO-OP: patch `shape:{}`** — T5 |
| pen_export_pen | pen-tools.ts:462 | export | (see 1h) | |
| pen_set_variable_modes | pen-tools.ts:504 | pen-tokens | Define variable collection + modes | |
| pen_list_collections | pen-tools.ts:564 | read | List collections + variables | Overlaps pen_list_variables / pen_get_variable_defs |

### 1n. Figma-canonical — `figma-tools.ts` (10)

| Tool | File:line | Category | Purpose | Notes |
|---|---|---|---|---|
| pen_create_page | figma-tools.ts:26 | pages | Add page | Good when-to-NOT guidance |
| pen_set_active_page | figma-tools.ts:67 | pages | Switch page | pageName AND pageId both optional — no-arg call "succeeds" |
| pen_rename_page | figma-tools.ts:99 | pages | Rename page | |
| pen_delete_page | figma-tools.ts:126 | pages | Delete page | Destructive (approval-gated) |
| pen_create_section | figma-tools.ts:154 | structure | SECTION node | |
| pen_create_component | figma-tools.ts:193 | component | Create new component | Overlaps pen_convert_to_component (promote) — defensible pair but undocumented |
| pen_create_component_set | figma-tools.ts:235 | component | ComponentSet container | Overlaps pen_combine_as_variants |
| pen_add_variant | figma-tools.ts:288 | component | Add variant to set | |
| pen_set_component_property | figma-tools.ts:336 | component | Define component property | |
| pen_set_instance_property | figma-tools.ts:395 | component | Override instance property | 3rd override tool |

### 1o. Plugins (32)

| Tool | File:line | Category | Purpose | Default | Notes |
|---|---|---|---|---|---|
| ask_user_question | ask-user-question.ts:97 | interaction | Typed clarifying questions (blocks on user) | ON | Well-built; 5-min timeout |
| todo_create | todo.ts:86 | interaction | New todo list | ON | Desc self-limits ("only 5+ steps") |
| todo_update | todo.ts:128 | interaction | Batch status transitions, auto-advance | ON | |
| todo_add | todo.ts:233 | interaction | Append todo | ON | Marginal |
| todo_remove | todo.ts:263 | interaction | Remove todo | ON | Marginal |
| todo_list | todo.ts:293 | interaction | List todos | ON | Desc: "you rarely need this tool" |
| memory_write | memory.ts:134 | memory | Write MEMORY.md / daily log | ON | |
| memory_read | memory.ts:168 | memory | Read memory files | ON | |
| memory_search | memory.ts:224 | memory | Jaccard keyword search | ON | |
| scratchpad | memory.ts:255 | memory | Scratchpad checklist ops | ON | |
| memory_forget | memory.ts:327 | memory | Delete + recovery record | ON | |
| subagent_reviewer | subagents.ts:188 | orchestration | Isolated reviewer critique | ON | **Duplicates pen_self_critique** — T8 |
| subagent_oracle | subagents.ts:238 | orchestration | Second opinion on risky decision | ON | |
| subagent_worker | subagents.ts:281 | orchestration | **Passthrough placeholder** | ON | **Trap tool** — T8 |
| compact_now | mega-compact.ts:63 | context | Manual compaction | off | Native disables SDK compaction (prior audit) |
| compact_search | mega-compact.ts:97 | context | Search compaction summaries | off | |
| compact_stats | mega-compact.ts:139 | context | Compaction stats | off | |
| goal_interview | goal-list-loop-audit.ts:73 | orchestration | Interview user for goals | off | |
| goal_add_task | goal-list-loop-audit.ts:155 | orchestration | Add goal task | off | |
| goal_complete_task | goal-list-loop-audit.ts:190 | orchestration | Complete task w/ evidence | off | |
| goal_audit | goal-list-loop-audit.ts:223 | orchestration | Re-verify w/ LLM auditor | off | |
| goal_list | goal-list-loop-audit.ts:263 | orchestration | List goals | off | |
| mcp_connect | mcp-adapter.ts:77 | external | Connect MCP server | off | |
| mcp_disconnect | mcp-adapter.ts:118 | external | Disconnect | off | |
| mcp_list_servers | mcp-adapter.ts:137 | external | List servers | off | |
| mcp_call_tool | mcp-adapter.ts:164 | external | Call MCP tool | off | |
| mcp_read_resource | mcp-adapter.ts:201 | external | Read MCP resource | off | |
| background_enqueue | background-tasks.ts:100 | orchestration | Enqueue bg task | off | |
| background_status | background-tasks.ts:140 | orchestration | Poll status | off | |
| background_result | background-tasks.ts:164 | orchestration | Fetch result | off | |
| background_cancel | background-tasks.ts:194 | orchestration | Cancel task | off | |
| background_list | background-tasks.ts:220 | orchestration | List tasks | off | |

**Alias registry** (tool-aliases.ts:28–64, 26 entries, dispatch-only on native): pen_create_shape→pen_create_node, pen_update_shape→pen_update_node, pen_delete_shape→pen_delete_nodes, pen_find_shapes→pen_find_nodes, pen_duplicate_shape→pen_duplicate_nodes, pen_reparent_shape→pen_reparent_nodes, pen_select_shape→pen_select_nodes, pen_list_shapes→pen_get_metadata, pen_update_tokens→pen_set_variables, pen_list_tokens→pen_list_variables, pen_bind_shape_to_token→pen_bind_variable, pen_unbind_shape→pen_unbind_variable, pen_apply_token→pen_apply_variable, pen_set_theme_axis→pen_set_variable_modes, pen_apply_theme→pen_set_explicit_modes, pen_list_themes→pen_list_collections, + 10 `figma_*`→`pen_*` permanent aliases.

## 2. Findings

### T1 — Dead tool: `pen_visual_critique` is registered but unreachable
- **Category:** REMOVE (or wire up) · **Severity:** High
- **Evidence:** tools.ts:5235 (definition); tool-execution-mode.ts:50 (marked parallel-safe); NOT in `ALL_TOOL_NAMES` (skills/registry.ts:737–790), NOT in any skill `allowedTools`, NOT in `PEN_TOOL_NAMES`/`FIGMA_TOOL_NAMES` (runner-native.ts:297–304 is the only visibility path); grep of registry.ts has zero hits.
- **Finding:** The flagship VLM critique tool (Task 7-c T3) can never be called by the LLM. The runner invokes the VLM critic directly in its critique loop (runner-native.ts:1553–1608), so the capability works — but the tool object, its schema, and its description bytes are shipped to `applyToolAliases` and then filtered out on every turn. `tests/unit/tool-registry.test.ts` checks alias targets but has no "every registered tool is reachable in ≥1 category" invariant, which is why this regression survived (AGENTS.md's "counts verified 2026-08-28" missed it too).
- **Recommendation:** Either add `pen_visual_critique` to `ALL_TOOL_NAMES` + wireframe/inspect allowlists (letting the model re-critique after fixes) or delete the tool. Add a unit test: `for t of allTools(): expect(isReachable(t.name)).toBe(true)`.

### T2 — Validator/critique messages instruct the model to call tools that don't exist (native)
- **Category:** UPDATE · **Severity:** Critical (recurring every fix-turn)
- **Evidence:** validators.ts:88 ("call pen_update_shape on each text layer"), :113 ("Call pen_update_shape with autoLayout=…"), :144 ("pen_update_shape to move/resize"); runner-native.ts:1695–1706 (fix-message mandates `pen_update_shape, pen_create_shape, …`); runner-native.ts:312–314 excludes every `TOOL_ALIASES` key from `filteredTools`, so `pen_update_shape`/`pen_create_shape` are NOT registered on the native path. SDK unknown-tool error is bare: `Tool ${name} not found` (pi-agent-core agent-loop.js:398).
- **Finding:** Confirms and extends prior-audit finding P1 from the tool-surface side: every critique fix-turn and every validator re-prompt steers the model into a guaranteed unknown-tool error, and the error gives no suggestion (`pen_update_node` is one rename away). Rule 5 even mixes both vocabularies in one sentence ("pen_update_shape to move/resize… or resize the frame with pen_update_node FIRST", validators.ts:144–145).
- **Recommendation:** Replace all `pen_update_shape`/`pen_create_shape` literals in validators.ts and runner-native.ts with canonical names; add a lint/test that greps runtime-authored strings for `TOOL_ALIASES` keys.

### T3 — Tool-count overload: the skill filter is defeated by always-on unions
- **Category:** RETHINK · **Severity:** High
- **Evidence:** skills/registry.ts:25–26 ("reduces per-turn tool count from 56 → ~15-20 … safe zone (<25 tools)"); runner-native.ts:297–304 (`allowedToolNames = getToolNamesForCategory(cat) ∪ PEN_TOOL_NAMES ∪ FIGMA_TOOL_NAMES ∪ pluginToolNames`); measured visible counts: wireframe 82, layout 59, styling 56, multi 110 (default), 128 (all plugins). Registry comment's own cited research (MCP tool-overload, audit 2-e) says tool defs can eat >20% of context and selection accuracy degrades.
- **Finding:** 110 visible tools for the common `multi` fallback is 4–5× the documented safe zone. MCP-research recommendation "consolidate" applies directly. The per-turn cost is real: ~110 tool schemas ≈ tens of KB on every call of every turn (the 26 alias entries were already cut for "~28KB" — runner-native.ts:305–311 — but 110 remain).
- **Recommendation:** (a) Move the 10 figma page/component tools and 8 pen tools behind the skill filter (only wireframe/styling/inspect need them); (b) default `subagents` plugin OFF or trim to reviewer only; (c) collapse the 6 style-setter duplicates (T4b) — a realistic target is ≤40 visible in `multi`, ≤25 in narrow skills.

### T4 — Redundancy clusters: 3 ways to place an instance, 3 override tools, 6 style-setters duplicating `pen_update_node`
- **Category:** REMOVE/RETHINK · **Severity:** High
- **Evidence:**
  - Instance placement ×3: `pen_instantiate_component` (tools.ts:2156 — comment at 2222–2225 admits "legacy… shallow-copies… New agent code should prefer the Phase 2 tools" but the description carries NO deprecation marker), `pen_place_component_instance` (tools.ts:2268, PenRef), `pen_create_ref` (pen-tools.ts:196, .pen ref + descendants).
  - Overrides ×3: `pen_override_instance` (tools.ts:2310), `pen_override_descendant` (pen-tools.ts:326), `pen_set_instance_property` (figma-tools.ts:395).
  - Component creation ×2: `pen_convert_to_component` vs `pen_create_component`; variant sets ×2: `pen_combine_as_variants` vs `pen_create_component_set`+`pen_add_variant`.
  - Style setters ×6 redundant with `pen_update_node changes:{...}`: `ShapeInputSchema` already declares `blur` (tools.ts:233), `gradient` (238), `shadow` (246), `radii` (254), and `coerceShapeInput` handles `locked`/`visible` (682–683) — so `pen_set_shadow`, `pen_set_gradient_fill`, `pen_set_blur`, `pen_set_corner_radius_per_corner`, `pen_set_locked`, `pen_set_visible` are semantic duplicates of one update call.
  - Whole-doc dumps ×3: `pen_export_json` / `pen_export_pen` / `pen_get_metadata`; variable readers ×3: `pen_list_variables` / `pen_get_variable_defs` / `pen_list_collections`; screenshot-ish ×2: `pen_export_png` / `pen_get_screenshot` (desc even says "same capture path, different framing").
- **Finding:** Three parallel component ontologies (tools.ts Phase-2 system, figma-tools Figma-canonical, pen-tools .pen refs) coexist with zero "prefer X" signals in the visible descriptions except one comment in source. For an LLM choosing under 100+ tools, near-duplicate clusters actively cause mis-selection (e.g. calling legacy `pen_instantiate_component`, which produces a shallow copy that won't track main-component edits). The 6 style-setters exist presumably for ergonomics, but the system prompt + validator messages already push `pen_set_shadow` specifically (validators.ts:99), locking in the duplication.
- **Recommendation:** Pick ONE component vocabulary (the .pen `ref`/`descendants` pair matches the document format — keep `pen_create_ref`+`pen_override_descendant`, alias the rest, delete after a cycle). Mark `pen_instantiate_component` `[deprecated: use pen_place_component_instance]` in its description TODAY (one-line change). Merge style-setters into `pen_update_node` (keep `pen_set_shadow` only if flattened params measurably reduce failures). Fold `pen_list_variables`+`pen_list_collections` into `pen_get_variable_defs`.

### T5 — No-op / misleading tools: modes, slots, descendant overrides don't persist
- **Category:** REWRITE · **Severity:** High
- **Evidence:** pen-tools.ts:171–177 (`pen_set_explicit_modes` emits patch `{op:'update', shape:{}}` — modes recorded ONLY in `summary` string; result text admits "full mode-variable resolution lands in Phase C"); pen-tools.ts:438–444 (`pen_mark_slot` same pattern, `shape:{}`); pen-tools.ts:365–381 (`pen_override_descendant` applies "direct overrides" to the INSTANCE ROOT — the `descendantPath` param is ignored except in the summary text).
- **Finding:** Three tools accept detailed parameters, return success text describing the requested effect, but persist nothing (or the wrong thing). A model that follows their guidelines ("All descendants inherit the modes") builds on fiction — then a later `pen_get_metadata` contradicts the tool result, wasting turns. `pen_override_descendant` on a nested node silently restyles the root instead.
- **Recommendation:** Either implement (persist modes/slot/overrides into shape metadata that `canvasToPen` already promises to reconstruct — the code comments claim it does, but the patch carries `shape:{}` so nothing is stored) or return an explicit `isError` "not yet implemented" result instead of success theater.

### T6 — `promptSnippet`/`promptGuidelines` are written for an LLM that never sees them
- **Category:** RETHINK · **Severity:** High (wasted effort + drift risk)
- **Evidence:** Every one of the 129 tools defines `promptSnippet` + `promptGuidelines` (e.g. tools.ts:843–850, 962–969; plugins/*.ts). Grep shows these fields are consumed NOWHERE: the native runner injects a hand-built system prompt via a custom `ResourceLoader.getSystemPrompt` (runner-native.ts:125–144, 675) and `createAgentSession` is called without `systemPromptOptions`/`toolSnippets`/`promptGuidelines` (runner-native.ts:963–982). The SDK's `buildSystemPrompt` supports both (pi-coding-agent dist/core/system-prompt.d.ts:11–13) but is bypassed.
- **Finding:** Hundreds of lines of carefully-written tool guidance ("Call this AFTER generating a design, not before"; "NEVER call todo_update twice in a row") are dead weight — the model only ever sees `description` + `parameters`. The guidelines also drift from descriptions (e.g. todo guidelines teach batching that the description also teaches, but neither reaches the prompt except for the one TODO BOOKKEEPING RULE hardcoded at SYSTEM_PROMPT lines 122–128).
- **Recommendation:** Choose one: (a) harvest the best guidelines into the tool descriptions (the only channel that reaches the model), or (b) pass `toolSnippets`/`promptGuidelines` through to the SDK prompt builder. Then delete the unused field or gate it behind the SDK path.

### T7 — Schema contradiction: `pen_set_variable` requires `value` while documenting themedValues-only use
- **Category:** UPDATE · **Severity:** Medium
- **Evidence:** pen-tools.ts:65 (`value: Type.Union([...])` — NOT `Type.Optional`) vs description "Single value for the variable (use this OR themedValues, not both)" and guidelines "For a theme-aware variable, pass `themedValues`" (pen-tools.ts:49–53, 66).
- **Finding:** The documented dark/light-variable pattern (`themedValues` without `value`) fails SDK schema validation BEFORE execute — the model gets a validation error contradicting the tool's own description, then typically retries identically (the documented GLM failure loop). `pen_set_variable` is also brief-gated (`GATED_TOOL_NAMES`, runner-native.ts:412–418), so it's on the critical path of every design turn.
- **Recommendation:** `value: Type.Optional(...)` and validate the XOR in execute with a friendly error. Audit every tool for description-vs-schema contradictions of this class (see T10).

### T8 — Plugin noise: placeholder `subagent_worker`, duplicate `subagent_reviewer`, marginal todo/memory surface
- **Category:** REMOVE · **Severity:** Medium
- **Evidence:** subagents.ts:281–310 — `subagent_worker` is a passthrough that returns `(Worker sub-agent is a placeholder in this release. Task was: …)` with `success: true`; default ON. subagents.ts:188–231 — `subagent_reviewer` dispatches the same design-critic pattern as `pen_self_critique` (tools.ts:5116: same [BLOCKER]/[MAJOR]/[MINOR] + 1–10 score, same `originalPrompt` param). todo plugin = 5 tools while `todo_list`'s own description says "you rarely need this tool" and every other todo result already embeds full list state. memory = 5 tools; system prompt documents only todo (SYSTEM_PROMPT lines 122–128; zero mention of memory/subagents/ask_user_question — verified by grep).
- **Finding:** The default-on plugin set contributes 14 tools, of which at least 5 are dilutive (worker trap, reviewer duplicate, todo_list, todo_add, todo_remove) — pure selection noise in a 110-tool catalog. `subagent_worker` is worse than noise: it reports success for unexecuted work.
- **Recommendation:** Remove `subagent_worker` until it actually spawns a sub-session (or return `isError: true`). Default `subagents` plugin OFF and keep `pen_self_critique` as the single critique entry point. Collapse todo to `todo_create`+`todo_update` (already return full state).

### T9 — Stub tools presented as capabilities: `pen_generate_image`, `pen_boolean_op`, partially `pen_set_constraints`
- **Category:** UPDATE · **Severity:** Medium
- **Evidence:** tools.ts:4920–4924 (`pen_generate_image`: "in this sandbox, this tool places a placeholder rectangle with the prompt text"); tools.ts:4555–4562 (`pen_boolean_op`: "simplified implementation… intersect: same as subtract… exclude: hides the second shape"); tools.ts:1918–1924 (`pen_set_constraints`: "The renderer does not yet enforce these" — write-only metadata, still advertised without a warning).
- **Finding:** The image tool is always-loaded and reads as a real capability; a model fulfilling "add a hero photo" via `pen_generate_image` produces a dashed placeholder the user must replace — an acceptable degradation IF the model then tells the user, which nothing guarantees. Boolean exclude/intersect produce wrong-looking output while reporting success.
- **Recommendation:** Mark sandbox stubs in the description's first sentence ("PLACEHOLDER: returns a dashed placeholder rect — tell the user to supply an image"), and make boolean intersect/exclude either honest errors or properly implemented; consider gating `pen_generate_image` behind image-API availability.

### T10 — Required/optional discipline is inconsistent; runtime tolerance papers over schemas
- **Category:** UPDATE · **Severity:** Medium
- **Evidence:** `pen_update_node` — nothing required (nodeId AND changes both optional, tools.ts:1462–1467); `pen_create_ref` — nothing required (ref/componentId/x/y all optional, pen-tools.ts:211–226); `pen_set_active_page` — pageName and pageId both optional → a no-arg call emits a garbage patch (figma-tools.ts:72–79); `pen_rename_page` — newName required but both identifiers optional; `pen_delete_page` — both identifiers optional. Meanwhile THREE layers of arg-repair exist: `PARAM_ALIASES` (tool-aliases.ts:98–114), `repairArrayArgs` (tools.ts:5736–5779), and per-tool inline coercion (`pen_update_node` id/shapeId/nodeId, tools.ts:1469–1472; `pen_delete_nodes` 4-spelling coercion, tools.ts:1602–1608; `pen_set_variable` key/name, pen-tools.ts:84).
- **Finding:** Schemas under-constrain (validation passes calls that can only fail at runtime, producing "Error: no shape with id undefined") while the repair layers prove models constantly send shapes the schemas didn't predict. The triple-layer tolerance is bespoke per tool — new tools won't inherit it, and it's untestable as a system.
- **Recommendation:** Make identifiers required at the schema level wherever the tool is meaningless without them (`nodeId` for update, `ref` for create_ref, exactly-one identifier for page tools — use `anyOf`); centralize the coercion into ONE schema-preprocessing function with a test matrix (extend scripts/smoke-tool-schemas.ts).

### T11 — Error messages: the good ones are excellent, the common ones are bare
- **Category:** UPDATE · **Severity:** Medium
- **Evidence:** Good: icon miss with suggestions (tools.ts:876, 4837), subtree budget errors with split instructions (tools.ts:1004–1049), reparent hints (tools.ts:1514, 1521), variant-generation failure with fallback directive (tools.ts:1357–1368), screenshot degraded-mode explanations (tools.ts:4398–4401). Bad: ~15 instances of bare `Error: no shape with id ${id}` with no recovery hint (tools.ts:1476, 2249, 2971, 3183, 3220, 3275, 4610, 4648, 4682, 4710, 4735; pen-tools.ts:165, 242, 351, 425); SDK unknown-tool is bare `Tool ${name} not found` (agent-loop.js:398); `executeTool` catch is generic `Tool execution failed: ${err.message}` (tools.ts:5720); `figma-tools` page ops never validate that the page exists (no read model available — they emit patches blind and report success).
- **Finding:** The highest-frequency error class (bad id) is the least actionable — no "call pen_get_metadata {nodeId} to list ids", no nearest-name suggestion (names ARE available in `ctx.getShapes()`). Anthropic tool guidance (audit 2-e): error text is the model's only signal; actionable errors convert retries into recovery.
- **Recommendation:** Standardize the not-found error to include: the id tried, 2–3 same-type shape names+ids from the canvas, and the recovery tool call. Wrap unknown-tool dispatch (native path can pre-resolve names against the alias map and append "did you mean pen_update_node?" — the alias layer already exists).

### T12 — Description quality is bimodal; 20 tools lack any when-to-use guidance
- **Category:** UPDATE · **Severity:** Medium
- **Evidence:** Measured across 97 base tools: description length min 34ch (`pen_set_background`) / median 265 / avg 302 / max 1208 (`pen_generate_wireframe`); 20 tools < 150ch (z-order family 62–80ch, page tools 62–131ch, `pen_set_blur` 95ch, `pen_delete_nodes` 92ch). Units are generally good (83 `px` mentions, 78 `hex`, 74 `e.g.`) but the short descriptions state neither px nor hex nor when-not-to-use. Color format IS specified on the important fields (fill "hex, e.g. #ff0000").
- **Finding:** The generators/reads got heavy description investment; the z-order/page/lock family got one-liners. For an LLM, `pen_move_forward` (62ch) vs `pen_bring_to_front` (77ch) vs `pen_reorder_shape` (79ch) are three under-specified near-neighbors — exactly the cluster where mis-selection happens. Conversely `pen_generate_wireframe` at 1208ch embeds the full template list + follow-up plan (good, but should live partially in guidelines — see T6).
- **Recommendation:** Floor of ~120ch + one when-to-use and one when-NOT line per tool; for the z-order trio add a one-line decision rule ("use bring_to_front for 'on top', move_forward for 'one step up'").

### T13 — Naming: node-era rename left shape-era stragglers and three singular/plural splits
- **Category:** UPDATE · **Severity:** Low/Medium
- **Evidence:** The pen-v3 rename (Appendix G §G.3) moved to node-era (`pen_create_node`, `pen_delete_nodes`, `pen_find_nodes`, `pen_duplicate_nodes`, `pen_reparent_nodes`) but kept shape-era names for: `pen_group_shapes`, `pen_ungroup_shapes`, `pen_align_shapes`, `pen_organize_layers`, `pen_reorder_shape` (singular!), `pen_mask_with`. Mixed verb vocabulary: apply/set/bake/mark/combine. Component tools are split across 3 files with 3 vocabularies (T4). `web_search`/`web_fetch` lack the `pen_` prefix (documented in AGENTS.md:74, still an inconsistency for the model).
- **Finding:** Mostly cosmetic, but naming predictability is the cheapest tool-selection win (Anthropic: semantic names beat UUIDs; verb_noun consistency improves pick rates). The alias registry already contains the machinery to rename safely.
- **Recommendation:** In the next rename wave: `pen_group_nodes`, `pen_align_nodes`, `pen_reorder_node` (+ aliases for old names); one file for the component vocabulary.

### T14 — Alias strategy diverges between native and legacy paths
- **Category:** UPDATE · **Severity:** Medium
- **Evidence:** Native: `filteredTools = allTools.filter(t => allowed && !aliasNames)` (runner-native.ts:312–314) — 26 alias entries are constructed by `applyToolAliases` (233–238) then discarded; deprecated spellings are NOT advertised. Legacy: `toolsToOpenAISpec` APPENDS all 26 alias specs with `[deprecated: use X]` descriptions (tools.ts:5639–5650) and `filterToolSpecs` keeps aliases whose target is allowed (runner-legacy.ts:1200–1206). Also `GATED_TOOL_NAMES_LEGACY` lists `pen_create_node` twice (runner-legacy.ts:1346–1348) and omits `pen_create_shape` (native gates it, runner-native.ts:414) — the two gates differ.
- **Finding:** Production (native) and test (legacy) expose different vocabularies and different brief-gates, so tests validate a tool surface that production doesn't serve (prior audit P18 said this about prompts; here it's the tool list itself). The discarded-then-constructed aliases on native are wasted work per turn.
- **Recommendation:** Filter aliases BEFORE construction (pass the exclusion into `applyToolAliases`); make legacy consume the same visible-set function; unify the two GATED sets into one exported constant.

### T15 — Stale tool-count comments mislead maintainers
- **Category:** UPDATE · **Severity:** Low
- **Evidence:** runner-native.ts:213/925 "all 88 tools / our 88 canvas tools"; skills/registry.ts:6 "which of the 56 canvas tools", :25 "from 56 → ~15-20"; tools.ts:15 "existing — renamed…" inventory header says 54; pen-tools.ts:15 "the existing 54 pen_* tools keep working". Actual: 97 base + 14 default plugins = 111 registered on native.
- **Recommendation:** Replace hard-coded counts with `tools.length`-derived values or drop the numbers; AGENTS.md is already correct (97/32) — the code comments lag it.

### T16 — Plugin tools ship with zero prompt integration (except todo)
- **Category:** UPDATE · **Severity:** Low/Medium
- **Evidence:** SYSTEM_PROMPT_TEMPLATE contains exactly one plugin section: TODO BOOKKEEPING RULE (runner-legacy.ts:122–128). No mention of `ask_user_question`, `memory_*`, `subagent_*` anywhere in the assembled prompt (grep verified); memory plugin content is injected as context (runner-native.ts:661–668) but its five tools are undocumented; mega-compact's purpose ("replaces in-place truncation") conflicts with the native path disabling SDK compaction entirely (prior audit P7).
- **Finding:** Default-on tools whose usage policy lives only in descriptions get called ad hoc (e.g. `ask_user_question` mid-build blocks 5 minutes waiting for a user who may be away — the 5-min timeout is a stalled turn; nothing in the prompt says when asking is preferred over proceeding with defaults).
- **Recommendation:** One short PLUGINS section in the system prompt naming each default-on plugin tool + one policy line each ("ask_user_question only when the request is truly blocking; otherwise proceed with defaults and note them").

### T17 — Two undo systems, one of them misleading
- **Category:** RETHINK · **Severity:** Low
- **Evidence:** `pen_undo`/`pen_redo` (tools.ts:3434–3448) described as affecting "the local (client) canvas state — it does not reverse agent tool calls" while operating server-side on the runner-local canvas; the approval-gate 'review' mode separately offers "Restore from before this turn" (runner-native.ts:483–490; turn-diff.ts powers the diff card). `turn-diff.ts` itself is clean (pure classification, 4 categories + ignored ops).
- **Finding:** The model has no tool-level view of turn restore and an op-level undo whose description disclaims the very thing it's used for. During critique fix-turns the prior-content guard blocks deletes, but nothing stops an agent from undo-ing through prior turns' work via repeated `pen_undo`.
- **Recommendation:** Reword `pen_undo`'s description to the server-side truth; consider bounding it to the current turn (count patches emitted this turn) — that matches user expectation and the diff card's mental model.

### T18 — Missing tools that would materially improve design output
- **Category:** RETHINK (add) · **Severity:** High (opportunity)
- **Evidence & gaps:**
  1. **Design-system pack application** — three packs ship (download/design-systems/{vercel-geist,mantine-default,shadcn-default}/tokens.css) and are injected as system-prompt TEXT when `settings.pack` is set (runner-legacy.ts:1045–1048), but there is no `pen_apply_design_system` tool — the model must transcribe CSS custom properties into `pen_set_variable` calls by hand (the dashboard eval's `pen_set_variable ×11` pattern).
  2. **Chart primitive** — dashboards are the flagship eval; charts are hand-assembled rectangles (template names "Chart area", "Chart trend line", "Chart bars"; applyHighFidelityStyling special-cases chart-bar radii, tools.ts:5991–5994). A `pen_create_chart(type, data, bounds)` composite would collapse ~15 calls into 1.
  3. **Realistic copy pass** — `pen_generate_copy` emits canned lorem variants per single text shape (tools.ts:2944–2990); research (audit 2-e) calls for a real-content pass. An LLM-backed `pen_write_copy(scope, tone)` batch tool is the gap.
  4. **Typography role application** — `applyTypographyByName` exists INSIDE the wireframe post-processor (tools.ts:5865) but is not exposed; a `pen_apply_typography(role)` that maps existing text layers to the LETTER SPACING RULES table would compress the most common critique-fix (validators rule 2 failures) from N updates to 1 call.
  5. **Table/form composites** — same subtree-based argument; partially covered by `pen_create_subtree`/`pen_insert_html`, so lower priority.
  6. **Selection-aware tools** — selection reaches the runner (route validates it) but no tool can query "what is selected"; every edit requires id round-trips (partially mitigated by id manifests).
  7. Already good: brief-first (exists), variants (exists), align/distribute (exists), measured-bounds baking (exists), icons (excellent).
- **Recommendation:** Priority order: design-system apply > chart primitive > typography-role tool > real-copy tool. All four are composite tools that remove double-digit call counts per design turn.

### T19 — Execution-mode & approval layers are solid (positive finding)
- **Category:** (none — confirmation) · **Severity:** —
- **Evidence:** tool-execution-mode.ts marks every canvas mutation `executionMode:'sequential'` with a verified parallel-safe read list (26 entries, incl. the dead `pen_visual_critique`); approval-gate wraps the 4 destructive tools with human Allow/Deny + always-allow persistence; prior-content-guard wraps delete/clear during critique fix-turns; `MAX_TOOL_RESULT_CHARS = 25_000` truncation with an actionable truncation notice (tools.ts:5705–5709).
- **Finding:** The execution SAFETY architecture is the strongest part of the tool surface — order-preserving batches, gated destruction, capped results, and self-educating alias notices. The weaknesses are informational (T2, T6, T11), not mechanical.

## 3. Top 10 prioritized changes

1. **Fix the dead-reference bug class (T2):** replace `pen_update_shape`/`pen_create_shape` literals in validators.ts:88,113,144 and runner-native.ts:1695–1706 with canonical names — every critique fix-turn currently mandates a tool that isn't registered.
2. **Decide `pen_visual_critique`'s fate (T1):** add it to `ALL_TOOL_NAMES` + wireframe/inspect allowlists (preferred — lets the model re-verify fixes) or delete it; add a reachability unit test for all 129 tools.
3. **Cut the visible catalog below ~40 (T3):** skill-gate the figma/page/component + pen-tools sets instead of unioning them always-on; flip `subagents` plugin default OFF. Update the false "56 → 15-20" comments.
4. **Collapse the component redundancy (T4):** mark `pen_instantiate_component` deprecated in its description immediately; consolidate to one instance tool (`pen_create_ref` or `pen_place_component_instance`), one override tool, one variant-set path.
5. **Make no-op tools honest (T5):** persist modes/slots/descendant-overrides into shape metadata or return `isError` "not implemented" — success theater on `pen_set_explicit_modes`/`pen_mark_slot`/`pen_override_descendant` corrupts the model's world model.
6. **Fix `pen_set_variable`'s schema (T7):** make `value` optional; enforce the value-XOR-themedValues rule in execute with a friendly error. Sweep all 129 tools for description-vs-schema contradictions.
7. **Deliver or delete `promptGuidelines` (T6):** fold the best guidance into descriptions (the only channel the model sees) — ~500 lines of dead prompt engineering currently rot.
8. **Remove the `subagent_worker` trap + dedupe reviewers (T8):** a default-on tool that fakes success is a correctness hazard; `subagent_reviewer` vs `pen_self_critique` is a coin-flip pair.
9. **Standardize not-found errors (T11):** bare `Error: no shape with id X` → include 2–3 candidate names/ids + the recovery call (`pen_get_metadata {nodeId}`); pre-resolve unknown tool names through the existing alias map with "did you mean".
10. **Add the two highest-leverage composite tools (T18):** `pen_apply_design_system(pack)` (tokens+typography from the shipped packs in one call) and `pen_create_chart(type, data)` — both target documented multi-call hotspots (pen_set_variable ×11; hand-built chart bars).

## Appendix — Method notes

- Counts computed mechanically from `defineTool` occurrences and cross-checked against the runtime unions (`ALL_TOOL_NAMES` ∪ `PEN_TOOL_NAMES` ∪ `FIGMA_TOOL_NAMES` ∪ plugin names), not from comments.
- Visible-per-skill numbers assume default plugin set; `enabledPlugins` in settings changes them.
- Description statistics measured over the 97 base tools only (plugins have descriptions but are secondary).
- The 26 alias entries and 3 wrapper layers (prior-content guard → brief gate → approval gate → execution modes → alphabetical sort) were traced end-to-end in runner-native.ts:216–537.
