// Prior-content guard — protects earlier turns' work during critique fix-turns.
//
// The multi-screen stress test failure: on turn 2 ("now create the dashboard
// screen"), the design-critic loop flagged the turn-1 login screen as a
// "defect", and the fix-turn resolved it by DELETING the user's prior
// deliverable ("Fixed all defects: removed the login card").
//
// Prompt-level scoping (critic prompt + fix-message guardrails) reduces the
// likelihood, but prompts decay. This module is the deterministic backstop:
// destructive tools (pen_delete_nodes, pen_clear) are wrapped so that, while
// a critique-fix re-prompt is running, they CANNOT remove shapes that existed
// at the start of the turn. Direct user requests ("delete the login screen")
// run in the MAIN turn where the guard is inactive — deletion stays possible
// when the user actually asks for it.
//
// The wrapper must be applied BEFORE applyToolAliases so legacy alias entries
// (pen_delete_shape → pen_delete_nodes) inherit the guard — aliases capture
// the wrapped execute at build time.

/// Extract node ids from a delete-tool params object, tolerating the LLM's
/// argument-shape mistakes (nodeIds array, nodeId singular, legacy shapeIds /
/// shapeId spellings). Mirrors the coercion inside pen_delete_nodes.execute.
export function extractNodeIdsFromParams(params: unknown): string[] {
  const p = params as any;
  if (Array.isArray(p?.nodeIds)) {
    return p.nodeIds.filter((id: unknown): id is string => typeof id === 'string');
  }
  if (typeof p?.nodeId === 'string') return [p.nodeId];
  if (Array.isArray(p?.shapeIds)) {
    return p.shapeIds.filter((id: unknown): id is string => typeof id === 'string');
  }
  if (typeof p?.shapeId === 'string') return [p.shapeId];
  return [];
}

export interface PriorContentGuardOptions {
  /// Ids of the shapes that existed when the current agent turn started
  /// (the user's prior deliverables). Read lazily so tests can mutate.
  getProtectedShapeIds: () => Set<string>;
  /// id → display name for protected shapes (error messages).
  getProtectedShapeNames: () => Map<string, string>;
  /// True while a critique-fix re-prompt is running — the only phase where
  /// the guard is active. Main-turn deletes are never blocked.
  isGuardActive: () => boolean;
  /// LIVE canvas shapes (id at minimum). Used by the restyle guards to scope
  /// blanket operations (pen_apply_palette with no shapeIds) down to
  /// this-turn content. Optional for backward compatibility with tests.
  getShapes?: () => Array<{ id: string }>;
}

const GUARDED_TOOL_NAMES = new Set(['pen_delete_nodes', 'pen_clear']);

/// Restyle tools guarded since 2026-09-05 (multi-shot fix): a critique
/// fix-turn restyling pass ("apply the palette fix", "make all text darker")
/// could repaint the user's earlier screens — the exact prior-content
/// violation the guard exists for, previously only enforced for deletes.
/// - pen_update_node:       hard ERROR when the target is prior content.
/// - pen_apply_palette:     auto-scoped to non-prior shapes (+ result note).
/// - pen_bulk_update_by_filter: prior ids injected as `excludeIds`
///                           (the tool reports the exclusion count).
const RESTYLE_TOOL_NAMES = new Set([
  'pen_update_node',
  'pen_apply_palette',
  'pen_bulk_update_by_filter',
]);

export interface GuardedToolLike {
  name: string;
  execute?: unknown;
}

/// Prior-content violation error result (shared shape with the delete guard).
function priorContentError(hitNames: string, verb: string, hint: string) {
  return {
    content: [{
      type: 'text' as const,
      text:
        `ERROR (prior-content scope guard): ${hitNames} — ` +
        `these are the user's prior deliverables and are protected during critique-fix turns. ` +
        `Do NOT ${verb} prior screens. ${hint}`,
    }],
    details: { error: 'prior_content_protected' },
    isError: true as any,
  };
}

/// Append a scope-guard NOTE part to a successful tool result (never fails —
/// appending to a malformed result shape is silently skipped).
function appendResultNote(result: unknown, note: string): void {
  try {
    const r = result as { content?: Array<{ type: string; text: string }> };
    if (r && Array.isArray(r.content) && r.content.length > 0 && r.content[0]?.type === 'text') {
      r.content.push({ type: 'text', text: note });
    }
  } catch {
    // Non-fatal — the note is advisory.
  }
}

/// Wrap destructive tools with the prior-content guard. Non-destructive
/// tools pass through unchanged. Pure — exported for unit tests.
export function wrapToolsWithPriorContentGuard<T extends GuardedToolLike>(
  tools: T[],
  opts: PriorContentGuardOptions,
): T[] {
  return tools.map((tool) => {
    const isGuarded = GUARDED_TOOL_NAMES.has(tool.name) || RESTYLE_TOOL_NAMES.has(tool.name);
    if (!isGuarded) return tool;
    const origExecute = tool.execute as
      | ((toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => Promise<unknown>)
      | undefined;
    if (typeof origExecute !== 'function') return tool;

    const guardedExecute = async (
      toolCallId: string,
      params: any,
      signal: any,
      onUpdate: any,
      ctx: any,
    ) => {
      if (!opts.isGuardActive()) {
        return origExecute(toolCallId, params, signal, onUpdate, ctx);
      }

      if (tool.name === 'pen_clear') {
        return {
          content: [{
            type: 'text' as const,
            text:
              'ERROR (prior-content scope guard): pen_clear is blocked during critique-fix turns — ' +
              'the canvas contains the user\'s earlier deliverables. Clearing would destroy prior work. ' +
              'Fix defects ONLY on the shapes you created in this turn.',
          }],
          details: { error: 'prior_content_protected' },
          isError: true as any,
        };
      }

      // ---- Restyle guards (2026-09-05) ------------------------------------
      if (tool.name === 'pen_update_node') {
        const ids = extractNodeIdsFromParams(params);
        const protectedIds = opts.getProtectedShapeIds();
        const hits = ids.filter((id) => protectedIds.has(id));
        if (hits.length > 0) {
          const names = opts.getProtectedShapeNames();
          const hitNames = hits.map((id) => `"${names.get(id) ?? id}"`).join(', ');
          return priorContentError(
            `node(s) ${hitNames} were created in an earlier turn`,
            'restyle or restructure',
            'Fix defects ONLY on the shapes you created in this turn; if a prior screen genuinely needs a change, mention it in your final summary instead.',
          );
        }
        return origExecute(toolCallId, params, signal, onUpdate, ctx);
      }

      if (tool.name === 'pen_apply_palette') {
        // Blanket palette passes (shapeIds omitted = ALL shapes) would repaint
        // prior screens. Auto-scope to this-turn shapes; explicit shapeIds that
        // are ALL prior content error out (the model must re-target).
        const shapes = opts.getShapes?.() ?? [];
        const protectedIds = opts.getProtectedShapeIds();
        if (protectedIds.size === 0) {
          return origExecute(toolCallId, params, signal, onUpdate, ctx);
        }
        const p = (params ?? {}) as { shapeIds?: unknown };
        const requestedIds = Array.isArray(p.shapeIds)
          ? (p.shapeIds as unknown[]).filter((id): id is string => typeof id === 'string')
          : null;
        const scopeIds = requestedIds ?? shapes.map((s) => s.id);
        const allowedIds = scopeIds.filter((id) => !protectedIds.has(id));
        const excludedCount = scopeIds.length - allowedIds.length;
        if (allowedIds.length === 0 && scopeIds.length > 0) {
          const names = opts.getProtectedShapeNames();
          const sample = scopeIds.slice(0, 3).map((id) => `"${names.get(id) ?? id}"`).join(', ');
          return priorContentError(
            `the palette pass targets only prior-turn node(s) ${sample}`,
            'restyle',
            'Pass explicit shapeIds for the shapes you created in THIS turn.',
          );
        }
        const scopedParams = { ...(params as any), shapeIds: allowedIds };
        const result = await origExecute(toolCallId, scopedParams, signal, onUpdate, ctx);
        if (excludedCount > 0) {
          appendResultNote(
            result,
            `NOTE (prior-content scope guard): excluded ${excludedCount} prior-turn node(s) from this palette pass — they are the user's earlier deliverables.`,
          );
        }
        return result;
      }

      if (tool.name === 'pen_bulk_update_by_filter') {
        // Filter-based bulk updates can match prior screens (e.g. type=text
        // matches EVERY text node on the canvas). Inject the prior ids as
        // excludeIds — the tool applies them and reports the exclusion count.
        const protectedIds = [...opts.getProtectedShapeIds()];
        if (protectedIds.length === 0) {
          return origExecute(toolCallId, params, signal, onUpdate, ctx);
        }
        const scopedParams = { ...(params as any), excludeIds: protectedIds };
        return origExecute(toolCallId, scopedParams, signal, onUpdate, ctx);
      }

      const ids = extractNodeIdsFromParams(params);
      const protectedIds = opts.getProtectedShapeIds();
      const hits = ids.filter((id) => protectedIds.has(id));
      if (hits.length === 0) {
        return origExecute(toolCallId, params, signal, onUpdate, ctx);
      }
      const names = opts.getProtectedShapeNames();
      const hitNames = hits.map((id) => `"${names.get(id) ?? id}"`).join(', ');
      return {
        content: [{
          type: 'text' as const,
          text:
            `ERROR (prior-content scope guard): node(s) ${hitNames} were created in an earlier turn — ` +
            `they are the user's prior work and are protected during critique-fix turns. ` +
            `Do NOT delete or restructure prior screens. Fix defects ONLY on the shapes you created in ` +
            `this turn. If a defect genuinely requires touching prior content, leave it and mention it ` +
            `in your final summary instead.`,
        }],
        details: { error: 'prior_content_protected', protectedIds: hits },
        isError: true as any,
      };
    };

    return { ...tool, execute: guardedExecute } as unknown as T;
  });
}
