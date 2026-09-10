# 06 — Agent Tools Simplification

> **Scope:** Changes to the tool surface that the LLM sees. This is the highest-leverage doc in the spec — tool schemas dominate the per-iteration token cost (~25K of the ~45K-token static prefix). Every tool removed from the LLM-visible catalog saves ~250-500 tokens per iteration.

---

## The tool surface today

Per the `src/lib/agent/AGENTS.md` and the pipeline map (Task ID 2 in `worklog.md`):

| Source | File | Tools | Names |
|---|---|---|---|
| Canvas tools | `src/lib/agent/tools.ts` | **84-85** | `pen_*`, `web_*` |
| .pen-file tools | `src/lib/agent/pen-tools.ts` | **8** | `pen_set_variable`, `pen_set_explicit_modes`, `pen_create_ref`, `pen_override_descendant`, `pen_mark_slot`, `pen_export_pen`, `pen_set_variable_modes`, `pen_list_collections` |
| Figma-canonical | `src/lib/agent/figma-tools.ts` | **10** | `pen_create_page`, `pen_set_active_page`, `pen_rename_page`, `pen_delete_page`, `pen_create_section`, `pen_create_component`, `pen_create_component_set`, `pen_add_variant`, `pen_set_component_property`, `pen_set_instance_property` |
| Plugin tools | `src/lib/agent/plugins/index.ts` | **32 max** (8 plugins × 3-5 each); **11 default-enabled** | ask-user-question, todo, memory |
| **TOTAL production** | | **103** (85 + 8 + 10) | matches root AGENTS.md canonicalization |
| With all plugins on | | **135** | production rarely enables all |

The Agent Performance Package already dropped 26 legacy alias tool entries (~28KB/call) from the LLM-visible catalog; stale transcripts still dispatch through `tool-aliases.ts`. So the LLM sees ~103 tools today.

---

## Why this matters

Per the Claude Code benchmark (Task ID 5 research, `claude-code-local/docs/BENCHMARKS.md`):

> "Combined with Claude Code's verbose tool descriptions, the effective prompt was ~5,600 tokens per turn — causing ~60s of prefill before the first output token."

AgentCanvas's static prefix is ~45K tokens — **~8× Claude Code's**. The probe-trivial.log shows the consequence: **7,675ms of dead time between request send and the first `agent:model_info` event** on trivial-shape. That's pure prefill on the static prefix.

The tool schemas are roughly half of the static prefix (~25K of the ~45K tokens). Slimming the tool surface is the highest-leverage change in the entire spec.

---

## Tier-aware tool catalogs (P0)

**What:** For each complexity tier, define an explicit allowlist of tools the LLM sees. The runner already has the infrastructure (`ONE_SHOT_DROP_TOOLS` at `runner-native.ts:519-527`; `categoryAllowedToolNames` at L475-480; `modeToolAllowlist(mode)` for Ask/Plan modes).

Extend with tier-aware allowlists:

### Trivial tier (~6 tools)

For trivial prompts (classifier keyword confidence ≥ 0.7 + prompt < 12 words + no `dashboard|landing|app|ui|website|page|screen` design keyword):

| Tool | Why it's needed |
|---|---|
| `pen_create_node` | Create a single shape |
| `pen_create_subtree` | Create a small batch (e.g. icon + label) |
| `pen_update_node` | Modify a single shape |
| `pen_get_metadata` | Read back ids (kept for safety even though subtree returns manifest) |
| `pen_search_icons` | Find an icon |
| `pen_apply_palette` | Apply a known palette |

**Token savings:** ~80% of the tool schema → ~5K tokens saved per iteration → ~1.5-2s prefill saved.

**Escape hatch:** If the first attempt errors with "tool not found", widen to the full category allowlist on attempt 2.

### Simple tier (~15 tools)

For simple prompts (single-screen design, e.g. login / pricing / settings):

| Tool | Why |
|---|---|
| (Trivial tier's 6 tools) | inherited |
| `pen_create_subtree` multi-root | Batch creation of multi-section layout |
| `pen_apply_typography` | Apply a known typography pairing |
| `pen_apply_design_system` | Apply a full design system pack |
| `pen_set_background` | Set a background fill |
| `pen_set_corner_radius_per_corner` | Per-corner radius (e.g. for cards) |
| `pen_set_shadow` | Drop shadow / inner shadow |
| `pen_set_gradient_fill` | Gradient fills |
| `pen_generate_palette` | Generate a custom palette |
| `pen_duplicate_nodes` | Duplicate a shape N times |

**Token savings:** ~60% of the tool schema → ~15K tokens saved per iteration.

### Multi tier (full canvas toolset, no plugins, no figma-canonical)

For multi-section pages (dashboard, landing, kanban):

| Tool | Why |
|---|---|
| (Simple tier's 15 tools) | inherited |
| `pen_create_chart` | Composite chart |
| `pen_create_table` | Composite table |
| `pen_create_card_grid` | Composite card grid |
| `pen_create_landing_page` | Composite landing page |
| `pen_align_shapes` | Multi-node alignment |
| `pen_organize_layers` | Auto-organize layer tree |
| `pen_apply_auto_layout` | Auto-layout a frame |
| `pen_group_shapes` / `pen_ungroup_shapes` | Group / ungroup |
| `pen_set_variables` | Define multiple tokens at once |
| `pen_bind_variable` / `pen_unbind_variable` | Token binding |
| `pen_find_replace_text` | Bulk text edit |
| `pen_bulk_update_by_filter` | Filter+update many shapes at once |
| `pen_bring_to_front` / `pen_send_to_back` / `pen_move_forward` / `pen_move_backward` | Z-order |
| `pen_find_nodes` | Find nodes by name / type / style |

**Token savings:** ~30% of the tool schema → ~7K tokens saved per iteration.

### Complex tier (full toolset + plugins, no figma-canonical)

For complex flows (multi-screen apps, design systems):

| Tool | Why |
|---|---|
| (Multi tier's tools) | inherited |
| `pen_create_path` | Custom paths (e.g. curved arrows) |
| `pen_boolean_op` | Boolean operations (union / subtract / intersect) |
| `pen_mask_with` | Mask with shape |
| `pen_generate_wireframe` | Wireframe generator |
| `pen_generate_user_flow` | User-flow generator |
| `pen_generate_diagram` | Diagram generator |
| `pen_generate_design_brief` | Generate a brief (only when not pre-generated) |
| `pen_generate_variants` | K=3 parallel variant generation |
| `pen_audit_design` | Deterministic pre-complete validator |
| `pen_self_critique` | Text critic (manual mode only) |
| `pen_visual_critique` | VLM critic (manual mode only) |
| `pen_get_computed` | Client-side computed style |
| `pen_get_screenshot` | Client-side screenshot |
| `pen_upload_image` | Image upload |
| `pen_generate_image` | AI image generation |
| `pen_instantiate_component` / `pen_convert_to_component` / `pen_place_component_instance` / `pen_override_instance` / `pen_reset_instance` / `pen_detach_instance` / `pen_combine_as_variants` / `pen_swap_variant` | Component lifecycle |
| Plugin tools (ask_user_question, todo, memory) | Plugins |

**Token savings:** ~0% — this is the full toolset. Complex tier needs every tool.

### Enterprise tier (full toolset + figma-canonical + all plugins)

For enterprise design systems:

| Tool | Why |
|---|---|
| (Complex tier's tools) | inherited |
| `pen_create_page` / `pen_set_active_page` / `pen_rename_page` / `pen_delete_page` | Multi-page documents |
| `pen_create_section` | Document sections |
| `pen_create_component` / `pen_create_component_set` / `pen_add_variant` / `pen_set_component_property` / `pen_set_instance_property` | Component authoring |
| `pen_export_pen` / `pen_set_variable_modes` / `pen_list_collections` | .pen file ops |
| All plugin tools (mega-compact, goal-list, mcp-adapter, background-tasks, subagents) | Optional opt-in |

**Token savings:** None — enterprise tier gets everything.

---

## How tier classification works

**File:** `src/lib/agent/classifier.ts:45-94` (`classifyIntent`).

The existing classifier has two passes:

1. **Keyword pass** (instant, sub-millisecond): matches prompt keywords to skill categories. Returns `{ category, confidence }`.
2. **LLM fallback** (only when keyword confidence < 0.7): a 200-token prompt to the sub-agent LLM asking it to classify the prompt into one of the 7 skill categories.

The classifier returns a single category. We extend it to also return a **tier**:

```ts
interface ClassifierResult {
  category: SkillCategory;
  confidence: number;
  tier: 'trivial' | 'simple' | 'multi' | 'complex' | 'enterprise';
  tierSource: 'keyword' | 'llm' | 'heuristic';
}
```

Tier heuristics:

| Tier | Heuristic |
|---|---|
| trivial | prompt < 12 words AND no design-system keyword AND no multi-section keyword AND no multi-screen keyword |
| simple | (prompt 12-30 words OR has screen keyword) AND no multi-section keyword |
| multi | has multi-section keyword (dashboard, landing, kanban, grid, table, chart) AND no multi-screen keyword |
| complex | has multi-screen keyword (flow, onboarding, app, multi-step) OR explicit `/variants` or `/multitask` |
| enterprise | explicit `/enterprise` or `/design-system` OR canvas already has 50+ shapes with components |

The keyword sets:

```ts
const TIER_KEYWORDS = {
  trivial: [],
  simple: ['login', 'card', 'badge', 'button', 'icon', 'color', 'palette', 'avatar', 'heading', 'text'],
  multi: ['dashboard', 'kanban', 'landing', 'page', 'pricing', 'table', 'chart', 'grid', 'navbar', 'sidebar', 'hero', 'section', 'panel', 'board'],
  complex: ['flow', 'onboarding', 'app', 'multi-screen', 'multi-step', 'wizard', 'checkout', 'signup', 'variants', 'multitask', '/mt'],
  enterprise: ['enterprise', 'design system', 'design-system', 'token', 'component library', '/enterprise'],
};
```

---

## Implementation plan

### Step 1: Define tier allowlists (P0, week 1)

Add a new file `src/lib/agent/tier-allowlists.ts` exporting the 5-tier tool allowlists. Each allowlist is just a `Set<string>` of tool names.

```ts
export const TRIVIAL_TIER_TOOLS = new Set([
  'pen_create_node', 'pen_create_subtree', 'pen_update_node',
  'pen_get_metadata', 'pen_search_icons', 'pen_apply_palette',
]);

export const SIMPLE_TIER_TOOLS = new Set([
  ...TRIVIAL_TIER_TOOLS,
  'pen_apply_typography', 'pen_apply_design_system', 'pen_set_background',
  'pen_set_corner_radius_per_corner', 'pen_set_shadow', 'pen_set_gradient_fill',
  'pen_generate_palette', 'pen_duplicate_nodes',
]);

// ... etc
```

### Step 2: Extend the classifier (P0, week 1)

Modify `src/lib/agent/classifier.ts` to return the tier alongside the category.

### Step 3: Wire tier allowlists into the runner (P0, week 1)

In `runner-native.ts` after the existing `categoryAllowedToolNames` filter, intersect with the tier allowlist:

```ts
// existing: turnTools already filtered by category + mode + one-shot slimming
const tierAllowlist = getTierAllowlist(classifierResult.tier);
const tierFilteredTools = turnTools.filter(t => tierAllowlist.has(t.name));
```

Place this AFTER the existing `ONE_SHOT_DROP_TOOLS` filter at L519-527 so the trivial tier's reduction compounds with the existing one-shot slimming.

### Step 4: Escape hatch (P0, week 1)

If the first attempt errors with "tool not found" (detected via the `agent:error` event), widen to the full category allowlist on attempt 2:

```ts
// In the attempt loop, track whether tool-not-found errors occurred
if (sawToolNotFoundError && attemptIndex === 1) {
  // Widen to the category allowlist (skip the tier filter)
  turnTools = turnTools.filter(t => categoryAllowlist.has(t.name));
  // Rebuild the session with the wider toolset
  // ... existing session recreation logic ...
}
```

### Step 5: System-prompt recipe update (P0, week 1)

Update `SYSTEM_PROMPT_TEMPLATE` at `runner-legacy.ts:117` to:

1. Move the `pen_create_subtree` batch recipe ABOVE the `pen_create_node` single-shape recipe (so the model sees the batched pattern first and prefers it).
2. Add an explicit note: "For trivial prompts (single shape, single text, single color), use `pen_create_node` directly without calling `pen_get_metadata` after — the result already includes the new id."
3. Add a per-tier hint at the top of the per-turn section: `[TIER: trivial — your toolset is restricted to the 6 trivial-tier tools. Do NOT call pen_get_metadata after pen_create_subtree; the result already includes the id-manifest.]`

### Step 6: Test coverage (P0, week 1)

Add `tests/unit/tier-allowlists.test.ts`:

- Assert each tier's allowlist contains the expected tools.
- Assert the tier allowlists are subsets of the production tool surface (no orphan names).
- Assert the classifier returns the right tier for representative prompts.

Add `tests/unit/tier-tool-filtering.test.ts`:

- Assert the runner's `turnTools` filter respects the tier allowlist.
- Assert the escape hatch widens to the category allowlist on tool-not-found errors.

---

## What we explicitly are NOT removing

### Tools that look unused but are critical

- `pen_undo` / `pen_redo` — the agent uses these to recover from mistakes. Removing them would force the agent to emit reverse-patches, which is more error-prone.
- `pen_clear` — the agent uses this to reset the canvas when starting a new design direction.
- `pen_export_json` / `pen_export_svg` / `pen_export_png` — the agent uses these for VLM critic dispatch (server-side render fallback).

### Tools that are user-facing only

- `web_search` / `web_fetch` — the agent uses these to look up design inspiration, but they're also surfaced in the UI as explicit user-invocable tools.

### Plugin tools that are opt-in

The plugin tools (mega-compact, goal-list, mcp-adapter, background-tasks, subagents) are already gated by `settings.enabledPlugins` — they're not in the default-enabled set. No change needed.

---

## Token cost measurement (P0, week 1)

Run `scripts/measure-tool-cost.ts` to empirically ground the per-tool token budget. The script:

1. Builds the full tool registry.
2. Converts via `toolsToOpenAISpec`.
3. JSON-stringifies, reports `length/4` as token estimate.
4. Per-tool breakdown sorted by token cost (biggest first).
5. Groups by `name.split('_')[1] + '_tools'` for category analysis.

After the tier-allowlist changes, re-run the script with each tier's allowlist to measure the actual token savings per tier. Checkin the JSON output to `download/speed-bench/tool-cost-by-tier.json` for future reference.

---

## Summary of changes (priority-ordered)

| # | Change | File | Complexity | P-level | Expected Δ |
|---|---|---|---|---|---|
| 1 | Define 5-tier tool allowlists | new `tier-allowlists.ts` | S | P0 | enables tier-aware tool slimming |
| 2 | Extend classifier to return tier | `classifier.ts:45` | S | P0 | enables tier classification |
| 3 | Wire tier allowlists into runner | `runner-native.ts:507-527` | M | P0 | trivial-tier prefill 7.6s → ~2-2.5s |
| 4 | Escape hatch on tool-not-found | `runner-native.ts` attempt loop | M | P0 | prevents trivial-tier dead-ends |
| 5 | System-prompt recipe reorder + tier hint | `runner-legacy.ts:117+` | S | P0 | nudges model to prefer batched primitives |
| 6 | Test coverage | new `tier-allowlists.test.ts`, `tier-tool-filtering.test.ts` | S | P0 | protects against regressions |
| 7 | Run + checkin `measure-tool-cost.ts` output | `scripts/measure-tool-cost.ts` | S | P0 | data-driven decisions for future slimming |
