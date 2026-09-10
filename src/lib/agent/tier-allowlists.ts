// tier-allowlists.ts — Tier-aware tool allowlists for the pi-agent.
//
// Speed-parity spec P0.1-P0.4 (docs/speed-parity-spec/06-agent-tools-simplification.md):
// the LLM-visible tool catalog is the dominant per-iteration token cost
// (~25K of the ~45K-token static prefix). Trivial-tier prompts see only the
// ~6 tools they need; complex-tier prompts see the full surface.
//
// The runner intersects the existing categoryAllowlist with the tier allowlist
// AFTER the one-shot slimming. An escape hatch widens to the category
// allowlist on attempt 2 if attempt 1 errored with a tool-not-found signature.
//
// Tier classification is performed by `classifyTier()` in this file — a
// deterministic keyword + length heuristic that runs alongside (not inside)
// the existing `classifyIntent` skill classifier. The two classifiers are
// independent so a prompt can be routed to the `wireframe` skill (canvas
// mutations) while also being tier-classified as `trivial`.

// ---- Tier type --------------------------------------------------------------

export type DesignTier = 'trivial' | 'simple' | 'multi' | 'complex' | 'enterprise';

// ---- Tier classification ----------------------------------------------------
//
// Heuristic-only (no LLM call): the speed-parity goal is to make trivial
// prompts FAST, not to be perfectly accurate. Misclassification routes to a
// higher tier (the safe direction — the model still has the tools it needs).

const TIER_KEYWORDS: Record<Exclude<DesignTier, 'trivial'>, RegExp> = {
  simple: /\b(login|card|badge|button|icon|color|colour|palette|avatar|heading|text|label|chip|tag|divider|alert|toast|spinner|toggle|checkbox|radio|input|field|form|tooltip|breadcrumb|banner)\b/,
  multi: /\b(dashboard|kanban|landing\s*page|page|pricing|table|chart|grid|navbar|sidebar|hero|section|panel|board|stat\s*card|kpi|metric|widget|calendar|timeline|menu|toolbar|footer|header|carousel|tab|accordion|drawer|modal|dialog|sheet)\b/,
  // Complex: multi-screen / flow keywords. "app" alone matches too broadly
  // ("fintech app", "design app") — require a multi-screen signal alongside it.
  complex: /\b(multi-screen|multi-step|onboarding\s*flow|flow|wizard|checkout\s*flow|signup\s*flow|sign-up\s*flow|sign-in\s*flow|register\s*flow|process|step-by-step|walkthrough|funnel|sequence|3-screen|4-screen|5-screen)\b|\/(multitask|mt|variants)\b/,
  // Enterprise: design-system / tokens / library keywords. "Enterprise" alone
  // matches a pricing-tier label ("Enterprise at $99/mo") — require a
  // design-system signal alongside it.
  enterprise: /\b(design\s*system|design-system|design\s*tokens|design-tokens|component\s*library|pattern\s*library|style\s*guide|styleguide)\b|\/enterprise\b/,
};

/// A prompt's word count, cheap lower bound on complexity. Single-word prompts
/// ("login") are trivial; multi-clause prompts ("design a marketing landing
/// page with a hero, 3 features, and a footer") are multi or higher.
function wordCount(prompt: string): number {
  return prompt.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Classify a prompt into a design-complexity tier.
 *
 * Algorithm:
 *   1. If canvas already has 50+ shapes, return 'enterprise' (the document is
 *      already complex; the agent needs the full toolset).
 *   2. If prompt has enterprise keywords → 'enterprise'.
 *   3. If prompt has complex keywords → 'complex'.
 *   4. If prompt has multi keywords → 'multi'.
 *   5. If prompt has simple keywords AND word count ≤ 18 → 'simple'.
 *   6. If prompt has simple keywords AND word count > 18 → 'multi'.
 *   7. If word count < 18 → 'trivial' (short prompt with no design keyword —
 *      e.g. "draw a red rectangle, 240x120, in the top-left" = 9 words).
 *   8. Default → 'multi' (the safe fallback — load all skills' tools).
 *
 * The classifier never returns `trivial` if the prompt has any non-trivial
 * keyword — a "design a dashboard" 3-word prompt hits 'multi' via the
 * dashboard keyword, not 'trivial' via word count.
 *
 * The threshold of 18 words for trivial is calibrated against the speed-bench
 * scenarios: trivial prompts ("draw a red rounded rectangle, 240x120, in the
 * top-left area of the canvas" = 13 words) should be trivial; multi-section
 * prompts ("design a marketing landing page for an AI design tool called Prism
 * with sticky nav..." = 30+ words) should be multi or higher.
 */
export function classifyTier(prompt: string, canvasShapeCount: number): DesignTier {
  // (1) Canvas is already large → enterprise
  if (canvasShapeCount >= 50) return 'enterprise';

  const normalized = prompt.toLowerCase();
  const words = wordCount(prompt);

  // (2-5) Keyword tiers, highest complexity wins
  if (TIER_KEYWORDS.enterprise.test(normalized)) return 'enterprise';
  if (TIER_KEYWORDS.complex.test(normalized)) return 'complex';
  if (TIER_KEYWORDS.multi.test(normalized)) return 'multi';
  if (TIER_KEYWORDS.simple.test(normalized)) {
    return words > 18 ? 'multi' : 'simple';
  }

  // (7) Short prompt + no design keyword → trivial
  if (words < 18) return 'trivial';

  // (8) Default → multi (safe fallback)
  return 'multi';
}

// ---- Per-tier tool allowlists ------------------------------------------------
//
// Each allowlist is a Set<string> of tool names. The runner intersects its
// existing turnTools filter with `getTierAllowlist(tier)`.
//
// IMPORTANT: every tier allowlist is a SUPERSET of the trivial tier —
// higher tiers add tools, never remove them. This makes the escape hatch
// simple: on attempt 2, drop the tier filter entirely (use the category
// allowlist).

/// The 6 tools every design turn needs: create / batch-create / update / read
/// (pen_get_metadata is kept as a safety net even though pen_create_subtree
/// returns an id-manifest — the model sometimes reads back after edits).
export const TRIVIAL_TIER_TOOLS: ReadonlySet<string> = new Set([
  'pen_create_node',
  'pen_create_subtree',
  'pen_update_node',
  'pen_get_metadata',
  'pen_search_icons',
  'pen_apply_palette',
]);

/// Simple screen: login / card / badge / button / icon / heading.
/// Adds typography, design-system, background, shadow, gradient, palette
/// generator, and duplicate_nodes.
export const SIMPLE_TIER_TOOLS: ReadonlySet<string> = new Set([
  ...TRIVIAL_TIER_TOOLS,
  'pen_apply_typography',
  'pen_apply_design_system',
  'pen_set_background',
  'pen_set_corner_radius_per_corner',
  'pen_set_shadow',
  'pen_set_gradient_fill',
  'pen_set_blur',
  'pen_generate_palette',
  'pen_duplicate_nodes',
  'pen_set_variables',
  'pen_bind_variable',
  'pen_set_locked',
  'pen_set_visible',
  'pen_create_path',
  'pen_upload_image',
  'pen_search_icons',
  'pen_apply_variable',
  'pen_unbind_variable',
  'pen_list_variables',
  'pen_generate_copy',
  'pen_select_nodes',
  'pen_set_constraints',
]);

/// Multi-section page: dashboard / kanban / landing / pricing / table / chart.
/// Adds the composites (chart / table / card-grid / landing-page), alignment,
/// grouping, organization, auto-layout, find-replace, bulk-update, z-order,
/// find-nodes, audit-design.
export const MULTI_TIER_TOOLS: ReadonlySet<string> = new Set([
  ...SIMPLE_TIER_TOOLS,
  'pen_create_chart',
  'pen_create_table',
  'pen_create_card_grid',
  'pen_create_landing_page',
  'pen_align_shapes',
  'pen_organize_layers',
  'pen_apply_auto_layout',
  'pen_group_shapes',
  'pen_ungroup_shapes',
  'pen_reparent_nodes',
  'pen_find_replace_text',
  'pen_bulk_update_by_filter',
  'pen_bring_to_front',
  'pen_send_to_back',
  'pen_move_forward',
  'pen_move_backward',
  'pen_reorder_shape',
  'pen_find_nodes',
  'pen_audit_design',
  'pen_clear',
  'pen_delete_nodes',
  'pen_undo',
  'pen_redo',
  'pen_set_blur',
  'pen_list_variables',
  'pen_apply_variable',
  'pen_unbind_variable',
  'pen_generate_copy',
  'pen_generate_wireframe',
  'pen_generate_design_brief',
]);

/// Complex flow: multi-screen app, onboarding, wizard, multi-step.
/// Adds path/vector ops, components, variants, design-brief, generators,
/// critique tools, client round-trips, image generation.
export const COMPLEX_TIER_TOOLS: ReadonlySet<string> = new Set([
  ...MULTI_TIER_TOOLS,
  'pen_boolean_op',
  'pen_mask_with',
  'pen_generate_user_flow',
  'pen_generate_diagram',
  'pen_generate_variants',
  'pen_self_critique',
  'pen_visual_critique',
  'pen_get_computed',
  'pen_get_screenshot',
  'pen_generate_image',
  'pen_instantiate_component',
  'pen_convert_to_component',
  'pen_place_component_instance',
  'pen_override_instance',
  'pen_reset_instance',
  'pen_detach_instance',
  'pen_combine_as_variants',
  'pen_swap_variant',
  'pen_export_json',
  'pen_export_svg',
  'pen_export_png',
  'pen_copy_as_code',
  'pen_bake_layout',
  'pen_get_variable_defs',
  'pen_get_design_context',
  'pen_save_design_pattern',
  'pen_search_design_patterns',
  'pen_clear_pattern_memory',
  'pen_pattern_stats',
  'pen_recommend_components',
  'pen_insert_html',
]);

/// Enterprise: full toolset + figma-canonical + .pen-file tools.
/// This is the maximum toolset; no slimming. The runner does NOT filter by
/// tier for enterprise — the category allowlist is the only filter.
export const ENTERPRISE_TIER_TOOLS: ReadonlySet<string> | null = null;

/// Lookup helper. Returns `null` for 'enterprise' (meaning: don't filter —
/// use the full category allowlist).
export function getTierAllowlist(tier: DesignTier): ReadonlySet<string> | null {
  switch (tier) {
    case 'trivial': return TRIVIAL_TIER_TOOLS;
    case 'simple': return SIMPLE_TIER_TOOLS;
    case 'multi': return MULTI_TIER_TOOLS;
    case 'complex': return COMPLEX_TIER_TOOLS;
    case 'enterprise': return ENTERPRISE_TIER_TOOLS;
  }
}

// ---- Per-tier iteration budgets ---------------------------------------------
//
// Speed-parity spec P0.7: tier-aware maxIterations + maxCritiqueIterations.
// These are the fallbacks when settings?.maxIterations is unset — explicit
// user overrides win.

export const TIER_MAX_ITERATIONS: Record<DesignTier, number> = {
  trivial: 4,    // trivial prompts can't legally exceed 2 calls; 4 is backstop
  simple: 8,
  multi: 14,
  complex: 24,
  enterprise: 32,
};

export const TIER_MAX_CRITIQUE_ITERATIONS: Record<DesignTier, number> = {
  trivial: 0,    // no critique on trivial — shouldRunCritics gate already exempts
  simple: 1,
  multi: 2,
  complex: 2,
  enterprise: 2,
};
