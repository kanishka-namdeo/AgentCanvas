// Tool registry + alias-registry tests (spec Phase 6 part 2 / §10.2 #4).
//
// Guards the Figma-canonical tool vocabulary (Appendix G §G.3):
//   1. Every alias target EXISTS in the tool registries (snapshot the
//      canonical names + alias map — freeze guard).
//   2. Legacy-name execution resolves to the canonical definition, still
//      emits its patch, and appends the deprecation notice.
//   3. normalizeToolParams matrix: shapeId→nodeId, shapeIds→nodeIds,
//      autoLayout v3→legacy, tokenKey→variableId, themeAxis→collectionId;
//      unknown params untouched.
//   4. Unknown tool names error (never silently resolve).
//   5. toolsToOpenAISpec exposes BOTH vocabularies (canonical + deprecated
//      aliases with the '[deprecated' prefix).
//   6. Grep-guard: pen_list_shapes is no longer a REGISTERED name but still
//      resolves via the alias registry.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createCanvasTools,
  executeTool,
  toolsToOpenAISpec,
  type CanvasToolContext,
} from '@/lib/agent/tools';
import { createPenTools } from '@/lib/agent/pen-tools';
import { createFigmaTools } from '@/lib/agent/figma-tools';
import {
  TOOL_ALIASES,
  ALIASES_BY_TARGET,
  resolveToolName,
  deprecationNotice,
  normalizeToolParams,
  normalizeAutoLayoutV3,
} from '@/lib/agent/tool-aliases';
import { applyPatchToCanvas } from '@/lib/canvas/patch';
import type { CanvasDocument, CanvasPatch, Shape } from '@/lib/canvas/types';

// ---- In-memory harness (mirrors tools.test.ts) -------------------------------

function makeCtx(): { ctx: CanvasToolContext; patches: CanvasPatch[]; canvas: CanvasDocument } {
  const canvas: CanvasDocument = {
    id: 'doc-1',
    name: 'Registry Test',
    background: '#ffffff',
    version: '2.17',
    children: [],
    viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes: [],
    tokens: { colors: [], textStyles: [] },
  };
  const patches: CanvasPatch[] = [];
  const ctx: CanvasToolContext = {
    getShapes: () => canvas.shapes,
    getTokens: () => canvas.tokens,
    getDocument: () => canvas,
    applyPatch(patch: CanvasPatch): CanvasPatch {
      patches.push(patch);
      // Mutate in place so the ctx closures (and the test) see the update.
      const next = applyPatchToCanvas(canvas, patch);
      canvas.shapes = next.shapes;
      canvas.tokens = next.tokens;
      canvas.children = next.children;
      canvas.variables = next.variables;
      canvas.themes = next.themes;
      return patch;
    },
  };
  return { ctx, patches, canvas };
}

let h: ReturnType<typeof makeCtx>;
beforeEach(() => {
  h = makeCtx();
});

function allTools() {
  return [
    ...createCanvasTools(h.ctx),
    ...createPenTools(h.ctx),
    ...createFigmaTools(h.ctx),
  ];
}

// ---- 1. Registry snapshot (freeze guard) --------------------------------------

describe('tool-registry: alias targets exist + snapshot', () => {
  it('every alias target is a REGISTERED tool name (26 aliases, all G.3 rows)', () => {
    const names = new Set(allTools().map((t) => (t as any).name));
    for (const [legacy, alias] of Object.entries(TOOL_ALIASES)) {
      expect(names.has(alias.target), `alias ${legacy} → ${alias.target} must be registered`).toBe(true);
    }
    expect(Object.keys(TOOL_ALIASES)).toHaveLength(26);
  });

  it('no alias LEGACY name is registered as a canonical tool (renames actually happened)', () => {
    const names = new Set(allTools().map((t) => (t as any).name));
    for (const legacy of Object.keys(TOOL_ALIASES)) {
      expect(names.has(legacy), `${legacy} must NOT be registered (it is an alias)`).toBe(false);
    }
  });

  it('snapshots the sorted canonical names (freeze guard — 95 registered tools)', () => {
    const names = allTools().map((t) => (t as any).name).sort();
    expect(names).toEqual([
      'pen_add_variant', 'pen_align_shapes', 'pen_apply_auto_layout', 'pen_apply_palette',
      'pen_apply_variable', 'pen_audit_design', 'pen_bake_layout', 'pen_bind_variable',
      'pen_boolean_op', 'pen_bring_to_front', 'pen_bulk_update_by_filter', 'pen_clear',
      'pen_clear_pattern_memory', 'pen_combine_as_variants', 'pen_convert_to_component',
      'pen_copy_as_code', 'pen_create_component', 'pen_create_component_set', 'pen_create_node',
      'pen_create_page', 'pen_create_path', 'pen_create_ref', 'pen_create_section',
      'pen_delete_nodes', 'pen_delete_page', 'pen_detach_instance', 'pen_duplicate_nodes',
      'pen_export_json', 'pen_export_pen', 'pen_export_png', 'pen_export_svg', 'pen_find_nodes',
      'pen_find_replace_text', 'pen_generate_copy', 'pen_generate_design_brief',
      'pen_generate_diagram', 'pen_generate_image', 'pen_generate_palette',
      'pen_generate_user_flow', 'pen_generate_wireframe', 'pen_get_computed',
      'pen_get_design_context', 'pen_get_metadata', 'pen_get_screenshot',
      'pen_get_variable_defs', 'pen_group_shapes', 'pen_insert_html',
      'pen_instantiate_component', 'pen_list_collections', 'pen_list_variables', 'pen_mark_slot',
      'pen_mask_with', 'pen_move_backward', 'pen_move_forward', 'pen_organize_layers',
      'pen_override_descendant', 'pen_override_instance', 'pen_pattern_stats',
      'pen_place_component_instance', 'pen_recommend_components', 'pen_redo', 'pen_rename_page',
      'pen_reorder_shape', 'pen_reparent_nodes', 'pen_reset_instance', 'pen_save_design_pattern',
      'pen_search_design_patterns', 'pen_search_icons', 'pen_select_nodes', 'pen_self_critique',
      'pen_send_to_back', 'pen_set_active_page', 'pen_set_background', 'pen_set_blur',
      'pen_set_component_property', 'pen_set_constraints', 'pen_set_corner_radius_per_corner',
      'pen_set_explicit_modes', 'pen_set_gradient_fill', 'pen_set_instance_property',
      'pen_set_locked', 'pen_set_shadow', 'pen_set_variable', 'pen_set_variable_modes',
      'pen_set_variables', 'pen_set_visible', 'pen_swap_variant', 'pen_unbind_variable',
      'pen_undo', 'pen_ungroup_shapes', 'pen_update_node', 'pen_upload_image',
      'pen_visual_critique', 'web_fetch', 'web_search',
    ]);
  });

  it('ALIASES_BY_TARGET reverse index covers every alias row', () => {
    const totalAliases = Object.values(ALIASES_BY_TARGET).reduce((n, list) => n + list.length, 0);
    expect(totalAliases).toBe(Object.keys(TOOL_ALIASES).length);
    expect(ALIASES_BY_TARGET['pen_create_node']).toContain('pen_create_shape');
    expect(ALIASES_BY_TARGET['pen_get_metadata']).toEqual(['pen_list_shapes']);
  });
});

// ---- 2. Legacy-name execution ---------------------------------------------------

describe('tool-registry: legacy-name execution via aliases', () => {
  it('pen_create_shape resolves to pen_create_node, emits the add patch, and appends the notice', async () => {
    const tools = allTools();
    const r = await executeTool(tools as any, 'pen_create_shape', {
      type: 'rectangle', name: 'Card', x: 0, y: 0, width: 100, height: 60,
    });
    expect(r.isError).toBeFalsy();
    // The patch still flowed (op 'add').
    expect(h.patches.length).toBeGreaterThan(0);
    expect(h.patches[0].op).toBe('add');
    // The deprecation notice teaches the new name.
    expect(r.content).toContain('pen_create_shape is now pen_create_node');
    expect(r.content).toContain('[note]');
  });

  it('the canonical name produces the same patch WITHOUT a notice', async () => {
    const tools = allTools();
    const r = await executeTool(tools as any, 'pen_create_node', {
      type: 'rectangle', name: 'Card', x: 0, y: 0, width: 100, height: 60,
    });
    expect(r.isError).toBeFalsy();
    expect(h.patches[0].op).toBe('add');
    expect(r.content).not.toContain('[note]');
  });

  it('figma_create_page (permanent alias) still creates a page under the pen_ name', async () => {
    const tools = allTools();
    const r = await executeTool(tools as any, 'figma_create_page', { name: 'Home' });
    expect(r.isError).toBeFalsy();
    expect(h.patches[0].op).toBe('add_page');
    expect(r.content).toContain('figma_create_page is now pen_create_page');
  });

  it('pen_list_shapes aliases to pen_get_metadata (supersede row, with note)', async () => {
    const tools = allTools();
    const r = await executeTool(tools as any, 'pen_list_shapes', {});
    expect(r.isError).toBeFalsy();
    // pen_get_metadata's default output: the page list.
    expect(r.content).toContain('page 0:');
    expect(r.content).toContain('pen_list_shapes is now pen_get_metadata');
    expect(r.content).toContain('sparse tree');
  });

  it('legacy PARAM spellings ride the alias path (shapeId → nodeId)', async () => {
    const seed = {
      id: 's1', type: 'rectangle', name: 'R', x: 0, y: 0, width: 10, height: 10,
      fill: '#ff0000', stroke: '#000', strokeWidth: 0, radius: 0, fontSize: 16,
      textColor: '#000', parentId: null, zIndex: 0, rotation: 0, opacity: 1,
      locked: false, visible: true, autoLayout: null, tokenBinding: null,
      componentId: null, points: null, closed: false, src: null, radii: null,
      gradient: null, shadow: null, blur: 0, maskId: null,
    } as Shape;
    // Mirror into the .pen children tree (the resolver recomputes shapes from it).
    h.canvas.shapes.push(seed);
    h.canvas.children.push(seed as any);
    const tools = allTools();
    const r = await executeTool(tools as any, 'pen_update_shape', {
      shapeId: 's1',
      changes: { fill: '#00ff00' },
    });
    expect(r.isError).toBeFalsy();
    expect(h.canvas.shapes.find((s) => s.id === 's1')?.fill).toBe('#00ff00');
    expect(r.content).toContain('pen_update_shape is now pen_update_node');
  });
});

// ---- 3. normalizeToolParams matrix ----------------------------------------------

describe('tool-registry: normalizeToolParams matrix', () => {
  it('shapeId → nodeId (and shapeIds → nodeIds), only when the canonical name is absent', () => {
    expect(normalizeToolParams('pen_update_node', { shapeId: 'a' })).toEqual({ nodeId: 'a' });
    expect(normalizeToolParams('pen_delete_nodes', { shapeIds: ['a', 'b'] })).toEqual({ nodeIds: ['a', 'b'] });
    // Canonical wins over legacy.
    expect(normalizeToolParams('pen_update_node', { shapeId: 'a', nodeId: 'b' })).toEqual({ shapeId: 'a', nodeId: 'b' });
  });

  it('tokenKey → variableId, themeAxis → collectionId, themeValues → modes', () => {
    expect(normalizeToolParams('pen_bind_variable', { shapeId: 's', tokenKey: 'bg.primary', property: 'fill' }))
      .toEqual({ nodeId: 's', variableId: 'bg.primary', property: 'fill' });
    expect(normalizeToolParams('pen_set_variable_modes', { themeAxis: 'mode', themeValues: ['light', 'dark'] }))
      .toEqual({ collectionId: 'mode', modes: ['light', 'dark'] });
    // Legacy axis/values spellings fold too.
    expect(normalizeToolParams('pen_set_variable_modes', { axis: 'mode', values: ['light', 'dark'] }))
      .toEqual({ collectionId: 'mode', modes: ['light', 'dark'] });
  });

  it('autoLayout v3 → legacy (G.3 row 1)', () => {
    expect(normalizeAutoLayoutV3({
      layoutMode: 'VERTICAL',
      itemSpacing: 12,
      paddingTop: 24, paddingRight: 24, paddingBottom: 24, paddingLeft: 24,
      primaryAxisAlignItems: 'MIN',
      counterAxisAlignItems: 'CENTER',
    })).toEqual({
      direction: 'vertical',
      gap: 12,
      padding: 24,
      alignX: 'center', // counter axis for a vertical layout
      alignY: 'min',    // primary axis for a vertical layout
    });

    // Horizontal layout flips the axis mapping.
    expect(normalizeAutoLayoutV3({ layoutMode: 'HORIZONTAL', primaryAxisAlignItems: 'MAX' }))
      .toEqual({ direction: 'horizontal', alignX: 'max' });

    // Legacy payloads pass through untouched (same reference).
    const legacy = { direction: 'vertical', gap: 8, padding: 16, alignX: 'center', alignY: 'center' };
    expect(normalizeAutoLayoutV3(legacy)).toBe(legacy);

    // pen_create_node params: top-level autoLayout; pen_update_node: nested changes.
    expect(normalizeToolParams('pen_create_node', { autoLayout: { layoutMode: 'HORIZONTAL', itemSpacing: 10 } }).autoLayout)
      .toEqual({ direction: 'horizontal', gap: 10 });
    expect(normalizeToolParams('pen_update_node', { nodeId: 'x', changes: { autoLayout: { layoutMode: 'HORIZONTAL', itemSpacing: 10 } } }).changes.autoLayout)
      .toEqual({ direction: 'horizontal', gap: 10 });
  });

  it('modes entries [{modeId,name}] → plain strings', () => {
    expect(normalizeToolParams('pen_set_variable_modes', {
      collectionId: 'mode',
      modes: [{ modeId: '1', name: 'light' }, { modeId: '2', name: 'dark' }],
    })).toEqual({ collectionId: 'mode', modes: ['light', 'dark'] });
  });

  it('unknown tools + unknown params are untouched (total, never throws)', () => {
    const params = { mystery: 'x', keep: 1 };
    expect(normalizeToolParams('pen_get_metadata', params)).toBe(params);
    expect(normalizeToolParams('totally_unknown_tool', params)).toBe(params);
    expect(normalizeToolParams('pen_update_node', null)).toBe(null);
  });
});

// ---- 4. Unknown tool names error -------------------------------------------------

describe('tool-registry: unknown names never silently resolve', () => {
  it('returns the exact Unknown-tool error', async () => {
    const tools = allTools();
    const r = await executeTool(tools as any, 'pen_nuke_canvas', {});
    expect(r.isError).toBe(true);
    expect(r.content).toBe('Unknown tool: pen_nuke_canvas');
    expect(h.patches).toHaveLength(0);
  });

  it('a NEAR-MISS of an alias name does not resolve (no fuzzy matching)', async () => {
    const tools = allTools();
    const r = await executeTool(tools as any, 'pen_create_shap', {});
    expect(r.isError).toBe(true);
    expect(r.content).toBe('Unknown tool: pen_create_shap');
  });
});

// ---- 5. OpenAI spec exposure: both vocabularies -----------------------------------

describe('tool-registry: toolsToOpenAISpec dual vocabulary', () => {
  it('exposes canonical names AND legacy aliases with the [deprecated prefix', () => {
    const specs = toolsToOpenAISpec(allTools() as any);
    const byName = new Map(specs.map((s) => [s.function.name, s]));

    // Canonical present.
    expect(byName.has('pen_create_node')).toBe(true);
    expect(byName.has('pen_get_metadata')).toBe(true);
    expect(byName.has('pen_set_variables')).toBe(true);
    expect(byName.has('pen_create_page')).toBe(true);

    // Legacy alias present with the deprecated prefix + same parameters.
    const legacy = byName.get('pen_create_shape');
    expect(legacy).toBeDefined();
    expect(legacy!.function.description.startsWith('[deprecated: use pen_create_node]')).toBe(true);
    expect(byName.get('figma_create_page')!.function.description.startsWith('[deprecated: use pen_create_page]')).toBe(true);

    // No duplicate names.
    const names = specs.map((s) => s.function.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('alias specs share the target parameters schema', () => {
    const specs = toolsToOpenAISpec(allTools() as any);
    const byName = new Map(specs.map((s) => [s.function.name, s]));
    expect(JSON.stringify(byName.get('pen_create_shape')!.function.parameters))
      .toBe(JSON.stringify(byName.get('pen_create_node')!.function.parameters));
  });
});

// ---- 6. Grep-guard: pen_list_shapes unregistered but resolvable -------------------

describe('tool-registry: grep-guard for renamed names', () => {
  it('pen_list_shapes is NOT registered but resolves via the alias registry', () => {
    const names = allTools().map((t) => (t as any).name);
    // String-scan the registry (grep-guard semantics).
    expect(names.join('\n').includes('pen_list_shapes')).toBe(false);
    expect(names).toContain('pen_get_metadata');

    const { name, aliasOf } = resolveToolName('pen_list_shapes');
    expect(name).toBe('pen_get_metadata');
    expect(aliasOf?.note).toContain('sparse tree');
  });

  it('deprecationNotice is a one-liner carrying old + new names', () => {
    const notice = deprecationNotice('pen_update_tokens', TOOL_ALIASES['pen_update_tokens']);
    expect(notice).toBe('[note] pen_update_tokens is now pen_set_variables — prefer the new name.');
    expect(notice.split('\n')).toHaveLength(1);
  });
});
