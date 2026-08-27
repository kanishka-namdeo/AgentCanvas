// Tool alias registry (spec Phase 6 part 2 — Appendix G §G.3, §9.3 #4).
//
// The shape/token-era tool names were renamed to Figma-canonical
// node/variable/collection-era names. Old names keep working through a
// deprecation window: `executeTool` (and the native runner's alias entries)
// resolve the legacy name to its successor, execute THAT, and append a
// one-line migration notice to the result text — teaching the model the new
// spelling mid-session (LLMs migrate faster than codebases).
//
// This module is PURE: no imports from tools.ts (no cycles), no side effects.
// It also carries `normalizeToolParams` — the tool-parameter coercion layer
// (spec §9.3 #1's third parse boundary: tool-parameter execution) mapping
// legacy param spellings (shapeId/shapeIds/tokenKey/themeAxis/…) onto the
// canonical ones (nodeId/nodeIds/variableId/collectionId/…), plus the v3
// autoLayout → legacy down-map for pen_create_node (the patch applier still
// consumes the legacy spelling during the dual-field window).

export interface ToolAlias {
  /** Canonical successor tool name. */
  target: string;
  /** Version marker for the rename wave ('pen-v3' = spec Phase 6). */
  deprecatedSince: string;
  /** Extra guidance appended to the deprecation notice. */
  note?: string;
}

/** Every legacy → canonical rename from Appendix G §G.3 (26 rows). */
export const TOOL_ALIASES: Record<string, ToolAlias> = {
  // pen_* shape-era → node-era
  pen_create_shape: { target: 'pen_create_node', deprecatedSince: 'pen-v3' },
  pen_update_shape: { target: 'pen_update_node', deprecatedSince: 'pen-v3' },
  pen_delete_shape: { target: 'pen_delete_nodes', deprecatedSince: 'pen-v3' },
  pen_find_shapes: { target: 'pen_find_nodes', deprecatedSince: 'pen-v3' },
  pen_duplicate_shape: { target: 'pen_duplicate_nodes', deprecatedSince: 'pen-v3' },
  pen_reparent_shape: { target: 'pen_reparent_nodes', deprecatedSince: 'pen-v3' },
  pen_select_shape: { target: 'pen_select_nodes', deprecatedSince: 'pen-v3' },
  // superseded read: legacy list folds into the Figma-MCP metadata read
  pen_list_shapes: {
    target: 'pen_get_metadata',
    deprecatedSince: 'pen-v3',
    note: 'returns the sparse tree by default; pass no nodeId for the page list',
  },
  // token-era → variable-era
  pen_update_tokens: { target: 'pen_set_variables', deprecatedSince: 'pen-v3' },
  pen_list_tokens: { target: 'pen_list_variables', deprecatedSince: 'pen-v3' },
  pen_bind_shape_to_token: { target: 'pen_bind_variable', deprecatedSince: 'pen-v3' },
  pen_unbind_shape: { target: 'pen_unbind_variable', deprecatedSince: 'pen-v3' },
  pen_apply_token: { target: 'pen_apply_variable', deprecatedSince: 'pen-v3' },
  // theme-era → collection/mode-era
  pen_set_theme_axis: { target: 'pen_set_variable_modes', deprecatedSince: 'pen-v3' },
  pen_apply_theme: { target: 'pen_set_explicit_modes', deprecatedSince: 'pen-v3' },
  pen_list_themes: { target: 'pen_list_collections', deprecatedSince: 'pen-v3' },
  // figma_* surface folded into pen_* (D10) — figma_ names stay as permanent aliases
  figma_create_page: { target: 'pen_create_page', deprecatedSince: 'pen-v3' },
  figma_set_active_page: { target: 'pen_set_active_page', deprecatedSince: 'pen-v3' },
  figma_rename_page: { target: 'pen_rename_page', deprecatedSince: 'pen-v3' },
  figma_delete_page: { target: 'pen_delete_page', deprecatedSince: 'pen-v3' },
  figma_create_section: { target: 'pen_create_section', deprecatedSince: 'pen-v3' },
  figma_create_component: { target: 'pen_create_component', deprecatedSince: 'pen-v3' },
  figma_create_component_set: { target: 'pen_create_component_set', deprecatedSince: 'pen-v3' },
  figma_add_variant: { target: 'pen_add_variant', deprecatedSince: 'pen-v3' },
  figma_set_component_property: { target: 'pen_set_component_property', deprecatedSince: 'pen-v3' },
  figma_set_instance_property: { target: 'pen_set_instance_property', deprecatedSince: 'pen-v3' },
};

/** Reverse index: canonical name → its legacy alias names (exposure order). */
export const ALIASES_BY_TARGET: Record<string, string[]> = (() => {
  const byTarget: Record<string, string[]> = {};
  for (const [legacy, alias] of Object.entries(TOOL_ALIASES)) {
    (byTarget[alias.target] ??= []).push(legacy);
  }
  return byTarget;
})();

/**
 * Resolve a (possibly legacy) tool name to its canonical name.
 * Unknown names pass through unchanged — callers keep their exact
 * "Unknown tool" error behavior (never silently resolve, §10.2 #4).
 */
export function resolveToolName(name: string): { name: string; aliasOf?: ToolAlias } {
  const alias = TOOL_ALIASES[name];
  if (alias) return { name: alias.target, aliasOf: alias };
  return { name };
}

/** The one-line migration notice appended to an aliased tool result. */
export function deprecationNotice(alias: string, a: ToolAlias): string {
  return `[note] ${alias} is now ${a.target} — prefer the new name.${a.note ? ` (${a.note})` : ''}`;
}

// ---- Tool-parameter coercion (G.3 param columns) ----------------------------

/**
 * Legacy → canonical PARAM spellings per canonical tool name. Applied BEFORE
 * execute receives the params. Only fills the canonical name when it is
 * absent — a canonical value always wins over a legacy one.
 */
const PARAM_ALIASES: Record<string, Record<string, string>> = {
  pen_update_node: { shapeId: 'nodeId' },
  pen_delete_nodes: { shapeIds: 'nodeIds', shapeId: 'nodeId' },
  pen_select_nodes: { shapeIds: 'nodeIds', shapeId: 'nodeId' },
  pen_duplicate_nodes: { shapeIds: 'nodeIds', shapeId: 'nodeId' },
  pen_reparent_nodes: { shapeIds: 'nodeIds', shapeId: 'nodeId', newParentId: 'parentId' },
  pen_bind_variable: { shapeId: 'nodeId', tokenKey: 'variableId' },
  pen_unbind_variable: { shapeId: 'nodeId', tokenKey: 'variableId' },
  pen_apply_variable: { shapeIds: 'nodeIds', shapeId: 'nodeId', tokenKey: 'variableId' },
  pen_set_explicit_modes: { shapeId: 'nodeId', theme: 'explicitVariableModes' },
  pen_set_variable_modes: {
    axis: 'collectionId',
    themeAxis: 'collectionId',
    values: 'modes',
    themeValues: 'modes',
  },
};

/** Canonical tool names that accept a v3 autoLayout payload (G.3 row 1). */
const AUTO_LAYOUT_TOOLS = new Set(['pen_create_node', 'pen_update_node']);

/**
 * v3 autoLayout `{layoutMode, itemSpacing, paddingLeft…, primaryAxisAlignItems,
 * counterAxisAlignItems}` → legacy `{direction, gap, padding, alignX, alignY}`
 * (the patch applier consumes the legacy spelling during the window).
 * Legacy-shaped inputs pass through untouched; unknown values coerce safely.
 */
export function normalizeAutoLayoutV3(al: any): any {
  if (!al || typeof al !== 'object' || Array.isArray(al)) return al;
  const hasV3 =
    al.layoutMode !== undefined ||
    al.itemSpacing !== undefined ||
    al.paddingLeft !== undefined || al.paddingRight !== undefined ||
    al.paddingTop !== undefined || al.paddingBottom !== undefined ||
    al.primaryAxisAlignItems !== undefined || al.counterAxisAlignItems !== undefined;
  if (!hasV3) return al;

  const out: Record<string, any> = { ...al };

  // layoutMode → direction (NONE means "not an auto-layout frame" — drop through)
  if (out.layoutMode !== undefined) {
    const lm = String(out.layoutMode).toUpperCase();
    if (lm === 'HORIZONTAL') out.direction = 'horizontal';
    else if (lm === 'VERTICAL' || lm === 'NONE' || lm === 'GRID') out.direction = 'vertical';
    delete out.layoutMode;
  }

  // itemSpacing → gap
  if (out.itemSpacing !== undefined) {
    const n = Number(out.itemSpacing);
    if (Number.isFinite(n)) out.gap = n;
    delete out.itemSpacing;
  }

  // per-side padding → uniform legacy `padding` (dominant case is uniform;
  // non-uniform collapses to the first defined side during the window)
  const sides = [out.paddingLeft, out.paddingTop, out.paddingRight, out.paddingBottom].filter(
    (v) => v !== undefined,
  );
  if (sides.length > 0) {
    const nums = sides.map((v) => (Number.isFinite(Number(v)) ? Number(v) : 0));
    const uniform = nums.every((n) => n === nums[0]);
    out.padding = uniform ? nums[0] : nums[0];
    delete out.paddingLeft; delete out.paddingRight;
    delete out.paddingTop; delete out.paddingBottom;
  }

  // primary/counter axis alignment → alignX/alignY (mapping depends on direction)
  const axisVal = (v: unknown): string | undefined => {
    const s = String(v ?? '').toLowerCase();
    return s === 'min' || s === 'center' || s === 'max' ? s : s ? 'center' : undefined;
  };
  const primary = axisVal(out.primaryAxisAlignItems);
  const counter = axisVal(out.counterAxisAlignItems);
  delete out.primaryAxisAlignItems; delete out.counterAxisAlignItems;
  if (primary !== undefined || counter !== undefined) {
    const horizontal = out.direction === 'horizontal';
    const alignX = horizontal ? primary : counter;
    const alignY = horizontal ? counter : primary;
    if (alignX !== undefined) out.alignX = alignX;
    if (alignY !== undefined) out.alignY = alignY;
  }

  return out;
}

/** v3 modes payload entries `[{modeId, name}]` → plain mode-name strings. */
function normalizeModesEntries(modes: any): any {
  if (!Array.isArray(modes)) return modes;
  return modes.map((m) => {
    if (m && typeof m === 'object' && !Array.isArray(m)) {
      const name = (m as any).name ?? (m as any).modeId;
      return name !== undefined ? String(name) : m;
    }
    return m;
  });
}

/**
 * Coerce legacy tool params to canonical spellings for one tool call.
 * PURE + TOTAL: unknown tool names and unknown params pass through
 * untouched (same reference when nothing changes).
 */
export function normalizeToolParams(toolName: string, params: any): any {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return params;
  const canonical = resolveToolName(toolName).name;

  let out = params;
  const map = PARAM_ALIASES[canonical];
  if (map) {
    for (const [legacy, canonicalParam] of Object.entries(map)) {
      if (out[legacy] !== undefined && out[canonicalParam] === undefined) {
        if (out === params) out = { ...params };
        out[canonicalParam] = out[legacy];
        delete out[legacy];
      }
    }
  }

  if (AUTO_LAYOUT_TOOLS.has(canonical)) {
    // Top-level autoLayout (pen_create_node) + nested changes.autoLayout
    // (pen_update_node). A JSON-string changes payload is parsed by the tool
    // itself — leave strings alone.
    if (out.autoLayout && typeof out.autoLayout === 'object') {
      const mapped = normalizeAutoLayoutV3(out.autoLayout);
      if (mapped !== out.autoLayout) {
        if (out === params) out = { ...params };
        out.autoLayout = mapped;
      }
    }
    if (out.changes && typeof out.changes === 'object' && out.changes.autoLayout &&
        typeof out.changes.autoLayout === 'object') {
      const mapped = normalizeAutoLayoutV3(out.changes.autoLayout);
      if (mapped !== out.changes.autoLayout) {
        if (out === params) out = { ...params };
        out.changes = { ...out.changes, autoLayout: mapped };
      }
    }
  }

  if (canonical === 'pen_set_variable_modes' && Array.isArray(out.modes)) {
    const mapped = normalizeModesEntries(out.modes);
    if (mapped !== out.modes) {
      if (out === params) out = { ...params };
      out.modes = mapped;
    }
  }

  return out;
}

// ---- Alias exposure helpers --------------------------------------------------

/** Minimal structural type of a `defineTool` result we need to wrap/clone. */
export type AliasToolLike = {
  name: string;
  description: string;
  execute?: (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => Promise<any>;
};

function appendNoticeToResult(result: any, notice: string): any {
  if (!result || typeof result !== 'object' || !Array.isArray(result.content)) return result;
  const content = result.content.map((c: any) => ({ ...c }));
  const firstText = content.find((c: any) => c && typeof c.text === 'string');
  if (firstText) firstText.text = `${firstText.text}\n${notice}`;
  else content.push({ type: 'text', text: notice });
  return { ...result, content };
}

/**
 * Legacy-name tool entries for a list of canonical tools — used by the native
 * runner (the SDK dispatches by name, so the legacy spelling must EXIST as a
 * tool) and by `toolsToOpenAISpec` (the LLM sees both vocabularies during the
 * window). Each alias entry executes the TARGET and appends the deprecation
 * notice to the result text.
 */
export function aliasToolEntries<T extends AliasToolLike>(tools: T[]): T[] {
  const entries: T[] = [];
  for (const tool of tools) {
    const legacyNames = ALIASES_BY_TARGET[tool.name];
    if (!legacyNames || typeof tool.execute !== 'function') continue;
    for (const legacyName of legacyNames) {
      const alias = TOOL_ALIASES[legacyName];
      const origExecute = tool.execute;
      entries.push({
        ...tool,
        name: legacyName,
        description: `[deprecated: use ${tool.name}] ${tool.description}`,
        execute: async (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => {
          const result = await origExecute(toolCallId, normalizeToolParams(tool.name, params), signal, onUpdate, ctx);
          return appendNoticeToResult(result, deprecationNotice(legacyName, alias));
        },
      } as unknown as T);
    }
  }
  return entries;
}

/**
 * Full alias layer for a tool list (native runner):
 *   1. wrap every canonical tool's execute with `normalizeToolParams`
 *      (legacy param spellings never reach execute bodies);
 *   2. append the legacy alias entries (canonical + deprecated both visible).
 */
export function applyToolAliases<T extends AliasToolLike>(tools: T[]): T[] {
  const wrapped = tools.map((tool) => {
    if (typeof tool.execute !== 'function') return tool;
    const origExecute = tool.execute;
    return {
      ...tool,
      execute: async (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) =>
        origExecute(toolCallId, normalizeToolParams(tool.name, params), signal, onUpdate, ctx),
    } as unknown as T;
  });
  return [...wrapped, ...aliasToolEntries(wrapped)];
}

/** Is `name` a legacy alias whose TARGET is in `allowed`? (skill-filter helper) */
export function aliasTargetAllowed(name: string, allowed: Set<string>): boolean {
  const alias = TOOL_ALIASES[name];
  return alias ? allowed.has(alias.target) : false;
}
