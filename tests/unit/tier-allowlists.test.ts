// Speed-parity spec P0 — tier-aware tool allowlists + tier classification.
//
// Covers:
//   - classifyTier() routes prompts to the correct tier.
//   - tier allowlists are non-empty subsets of the production tool surface.
//   - each tier is a superset of the previous (escape hatch correctness).
//   - TIER_MAX_ITERATIONS / TIER_MAX_CRITIQUE_ITERATIONS reflect the spec.
//
// Spec: docs/speed-parity-spec/06-agent-tools-simplification.md

import { describe, it, expect } from 'vitest';
import {
  classifyTier,
  getTierAllowlist,
  TRIVIAL_TIER_TOOLS,
  SIMPLE_TIER_TOOLS,
  MULTI_TIER_TOOLS,
  COMPLEX_TIER_TOOLS,
  TIER_MAX_ITERATIONS,
  TIER_MAX_CRITIQUE_ITERATIONS,
  type DesignTier,
} from '@/lib/agent/tier-allowlists';

// The production tool surface — every name that exists in tools.ts + pen-tools.ts
// + figma-tools.ts. Used to assert the tier allowlists contain only real names.
// This list is generated from `grep "name: 'pen_" src/lib/agent/{tools,pen-tools,figma-tools}.ts`.
const PRODUCTION_TOOL_NAMES = new Set<string>([
  'pen_add_variant', 'pen_align_shapes', 'pen_apply_auto_layout', 'pen_apply_design_system',
  'pen_apply_palette', 'pen_apply_typography', 'pen_apply_variable', 'pen_audit_design',
  'pen_bake_layout', 'pen_bind_variable', 'pen_boolean_op', 'pen_bring_to_front',
  'pen_bulk_update_by_filter', 'pen_clear', 'pen_clear_pattern_memory', 'pen_combine_as_variants',
  'pen_convert_to_component', 'pen_copy_as_code', 'pen_create_card_grid', 'pen_create_chart',
  'pen_create_component', 'pen_create_component_set', 'pen_create_landing_page', 'pen_create_node',
  'pen_create_page', 'pen_create_path', 'pen_create_ref', 'pen_create_section', 'pen_create_subtree',
  'pen_create_table', 'pen_delete_nodes', 'pen_delete_page', 'pen_detach_instance',
  'pen_duplicate_nodes', 'pen_export_json', 'pen_export_pen', 'pen_export_png', 'pen_export_svg',
  'pen_find_nodes', 'pen_find_replace_text', 'pen_generate_copy', 'pen_generate_design_brief',
  'pen_generate_diagram', 'pen_generate_image', 'pen_generate_palette', 'pen_generate_user_flow',
  'pen_generate_variants', 'pen_generate_wireframe', 'pen_get_computed', 'pen_get_design_context',
  'pen_get_metadata', 'pen_get_screenshot', 'pen_get_variable_defs', 'pen_group_shapes',
  'pen_insert_html', 'pen_instantiate_component', 'pen_list_collections', 'pen_list_variables',
  'pen_mark_slot', 'pen_mask_with', 'pen_move_backward', 'pen_move_forward', 'pen_organize_layers',
  'pen_override_descendant', 'pen_override_instance', 'pen_pattern_stats', 'pen_place_component_instance',
  'pen_recommend_components', 'pen_redo', 'pen_rename_page', 'pen_reorder_shape', 'pen_reparent_nodes',
  'pen_reset_instance', 'pen_save_design_pattern', 'pen_search_design_patterns', 'pen_search_icons',
  'pen_select_nodes', 'pen_self_critique', 'pen_send_to_back', 'pen_set_active_page',
  'pen_set_background', 'pen_set_blur', 'pen_set_component_property', 'pen_set_constraints',
  'pen_set_corner_radius_per_corner', 'pen_set_explicit_modes', 'pen_set_gradient_fill',
  'pen_set_instance_property', 'pen_set_locked', 'pen_set_shadow', 'pen_set_variable',
  'pen_set_variable_modes', 'pen_set_variables', 'pen_set_visible', 'pen_swap_variant',
  'pen_unbind_variable', 'pen_undo', 'pen_ungroup_shapes', 'pen_update_node', 'pen_upload_image',
  'pen_visual_critique', 'web_search', 'web_fetch',
]);

// ---- classifyTier ----------------------------------------------------------

describe('classifyTier', () => {
  it('returns "trivial" for short prompts with no design keyword', () => {
    expect(classifyTier('draw a red rectangle', 0)).toBe('trivial');
    expect(classifyTier('hi', 0)).toBe('trivial');
    expect(classifyTier('what is this', 0)).toBe('trivial');
    expect(classifyTier('the quick brown fox', 0)).toBe('trivial');
    // Speed-parity tuning: 13-word trivial prompts (e.g. "draw a red rounded
    // rectangle, 240x120, in the top-left area of the canvas") are also trivial.
    expect(classifyTier('draw a red rounded rectangle 240x120 in the top-left area of the canvas', 0)).toBe('trivial');
  });

  it('returns "simple" for short prompts WITH a simple design keyword', () => {
    // "add a heading" matches the 'heading' simple keyword → simple, not trivial.
    // This is correct: a heading IS a design element that benefits from typography tools.
    expect(classifyTier('add a heading', 0)).toBe('simple');
    expect(classifyTier('create a button', 0)).toBe('simple');
    expect(classifyTier('design a login card', 0)).toBe('simple');
    expect(classifyTier('draw an avatar icon', 0)).toBe('simple');
  });

  it('returns "multi" for prompts with multi-section keywords', () => {
    expect(classifyTier('design a dashboard with 4 KPI cards', 0)).toBe('multi');
    expect(classifyTier('create a kanban board', 0)).toBe('multi');
    expect(classifyTier('design a marketing landing page', 0)).toBe('multi');
    expect(classifyTier('build a pricing table', 0)).toBe('multi');
  });

  it('returns "complex" for prompts with multi-screen / flow keywords', () => {
    expect(classifyTier('design a 3-screen onboarding flow', 0)).toBe('complex');
    expect(classifyTier('build a multi-step wizard', 0)).toBe('complex');
    expect(classifyTier('design a checkout flow', 0)).toBe('complex');
    expect(classifyTier('create a multi-screen flow', 0)).toBe('complex');
  });

  it('returns "enterprise" for design-system prompts', () => {
    expect(classifyTier('design an enterprise design system', 0)).toBe('enterprise');
    expect(classifyTier('create a component library', 0)).toBe('enterprise');
    expect(classifyTier('build a design-tokens theme', 0)).toBe('enterprise');
  });

  it('returns "enterprise" when canvas already has 50+ shapes', () => {
    // Even a "draw a red rectangle" prompt on a 50-shape canvas → enterprise.
    expect(classifyTier('draw a red rectangle', 50)).toBe('enterprise');
    expect(classifyTier('draw a red rectangle', 100)).toBe('enterprise');
  });

  it('returns "multi" (safe fallback) for medium prompts with no keyword', () => {
    // 22 words, no design keyword — should be 'multi' (safe fallback).
    // (Speed-parity tuning: trivial threshold is now 18 words; this prompt
    // is 22 words to land above the threshold and exercise the fallback.)
    expect(classifyTier('the quick brown fox jumps over the lazy dog twice today and then runs back to the forest for a nap', 0)).toBe('multi');
  });

  it('routes a short prompt with a complex keyword to complex (not trivial)', () => {
    // 4 words but contains 'flow' — should be complex, not trivial.
    // (Speed-parity tuning: "app" alone matches too broadly — "fintech app"
    // is not a multi-screen flow. The complex regex now requires a flow /
    // multi-screen signal.)
    expect(classifyTier('design a flow', 0)).toBe('complex');
    expect(classifyTier('build a wizard', 0)).toBe('complex');
    expect(classifyTier('create a 3-screen onboarding', 0)).toBe('complex');
  });
});

// ---- Tier allowlists -------------------------------------------------------

describe('tier allowlists', () => {
  it('TRIVIAL has exactly 6 tools (the spec target)', () => {
    expect(TRIVIAL_TIER_TOOLS.size).toBe(6);
    expect([...TRIVIAL_TIER_TOOLS].sort()).toEqual([
      'pen_apply_palette',
      'pen_create_node',
      'pen_create_subtree',
      'pen_get_metadata',
      'pen_search_icons',
      'pen_update_node',
    ]);
  });

  it('every tier allowlist contains only production tool names', () => {
    const tiers: Array<[string, ReadonlySet<string>]> = [
      ['TRIVIAL', TRIVIAL_TIER_TOOLS],
      ['SIMPLE', SIMPLE_TIER_TOOLS],
      ['MULTI', MULTI_TIER_TOOLS],
      ['COMPLEX', COMPLEX_TIER_TOOLS],
    ];
    for (const [name, allowlist] of tiers) {
      for (const toolName of allowlist) {
        expect(PRODUCTION_TOOL_NAMES.has(toolName), `${name} contains unknown tool: ${toolName}`).toBe(true);
      }
    }
  });

  it('each tier is a superset of the previous (escape hatch correctness)', () => {
    // TRIVIAL ⊂ SIMPLE ⊂ MULTI ⊂ COMPLEX
    for (const t of TRIVIAL_TIER_TOOLS) {
      expect(SIMPLE_TIER_TOOLS.has(t), `SIMPLE missing TRIVIAL tool ${t}`).toBe(true);
    }
    for (const t of SIMPLE_TIER_TOOLS) {
      expect(MULTI_TIER_TOOLS.has(t), `MULTI missing SIMPLE tool ${t}`).toBe(true);
    }
    for (const t of MULTI_TIER_TOOLS) {
      expect(COMPLEX_TIER_TOOLS.has(t), `COMPLEX missing MULTI tool ${t}`).toBe(true);
    }
  });

  it('getTierAllowlist returns the right set per tier', () => {
    expect(getTierAllowlist('trivial')).toBe(TRIVIAL_TIER_TOOLS);
    expect(getTierAllowlist('simple')).toBe(SIMPLE_TIER_TOOLS);
    expect(getTierAllowlist('multi')).toBe(MULTI_TIER_TOOLS);
    expect(getTierAllowlist('complex')).toBe(COMPLEX_TIER_TOOLS);
  });

  it('getTierAllowlist returns null for enterprise (no filtering — full toolset)', () => {
    expect(getTierAllowlist('enterprise')).toBeNull();
  });

  it('allowlist sizes are monotonically increasing', () => {
    // Sanity: trivial < simple < multi < complex
    expect(TRIVIAL_TIER_TOOLS.size).toBeLessThan(SIMPLE_TIER_TOOLS.size);
    expect(SIMPLE_TIER_TOOLS.size).toBeLessThan(MULTI_TIER_TOOLS.size);
    expect(MULTI_TIER_TOOLS.size).toBeLessThan(COMPLEX_TIER_TOOLS.size);
  });
});

// ---- Tier iteration budgets ------------------------------------------------

describe('TIER_MAX_ITERATIONS + TIER_MAX_CRITIQUE_ITERATIONS', () => {
  it('TIER_MAX_ITERATIONS matches spec P0.7', () => {
    expect(TIER_MAX_ITERATIONS.trivial).toBe(4);
    expect(TIER_MAX_ITERATIONS.simple).toBe(8);
    expect(TIER_MAX_ITERATIONS.multi).toBe(14);
    expect(TIER_MAX_ITERATIONS.complex).toBe(24);
    expect(TIER_MAX_ITERATIONS.enterprise).toBe(32);
  });

  it('TIER_MAX_CRITIQUE_ITERATIONS matches spec P0.7', () => {
    expect(TIER_MAX_CRITIQUE_ITERATIONS.trivial).toBe(0);
    expect(TIER_MAX_CRITIQUE_ITERATIONS.simple).toBe(1);
    expect(TIER_MAX_CRITIQUE_ITERATIONS.multi).toBe(2);
    expect(TIER_MAX_CRITIQUE_ITERATIONS.complex).toBe(2);
    expect(TIER_MAX_CRITIQUE_ITERATIONS.enterprise).toBe(2);
  });

  it('every tier key is present in both maps', () => {
    const tiers: DesignTier[] = ['trivial', 'simple', 'multi', 'complex', 'enterprise'];
    for (const t of tiers) {
      expect(TIER_MAX_ITERATIONS[t]).toBeDefined();
      expect(TIER_MAX_CRITIQUE_ITERATIONS[t]).toBeDefined();
    }
  });
});
