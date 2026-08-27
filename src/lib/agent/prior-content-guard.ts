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
}

const GUARDED_TOOL_NAMES = new Set(['pen_delete_nodes', 'pen_clear']);

export interface GuardedToolLike {
  name: string;
  execute?: unknown;
}

/// Wrap destructive tools with the prior-content guard. Non-destructive
/// tools pass through unchanged. Pure — exported for unit tests.
export function wrapToolsWithPriorContentGuard<T extends GuardedToolLike>(
  tools: T[],
  opts: PriorContentGuardOptions,
): T[] {
  return tools.map((tool) => {
    if (!GUARDED_TOOL_NAMES.has(tool.name)) return tool;
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
