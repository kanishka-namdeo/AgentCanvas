// Tool execution-mode policy (Agent Performance Package, change 3).
//
// pi-agent-core executes ALL tool calls emitted in one assistant message as a
// batch — in PARALLEL by default (agent-loop.js `executeToolCallsParallel`),
// falling back to sequential when ANY tool in the batch declares
// `executionMode: 'sequential'` (agent-loop.js:289).
//
// Canvas MUTATIONS are order-sensitive (create-then-style, insert-then-move,
// duplicate-then-retext all break under concurrent execution — the "silent
// lost-write" class of parallel-tool-call failures). So every canvas-mutating
// pen_/figma tool is marked sequential: when the model emits
// [pen_create_subtree, pen_update_node, pen_set_variable] in ONE assistant
// message, they run in emission order — the exact ordering they had when
// each call was its own round-trip — while the LLM saves the round-trips.
//
// Read-only tools (metadata, search, export, critique sub-agents) stay
// parallel: a batch of pure reads is race-free and genuinely concurrent.
//
// This module is PURE (no imports from the runner) so it is unit-testable.

/// Read-only / non-mutating pen_* tools that may safely run CONCURRENTLY
/// inside one multi-tool-call batch. Conservative by design: anything not on
/// this list that starts with pen_/figma_ is treated as an ordered mutation.
/// (Verified against the tool sources: none of these call ctx.applyPatch or
/// mutate the document tree; the pattern-memory writers are excluded too.)
export const PARALLEL_SAFE_TOOL_NAMES: ReadonlySet<string> = new Set([
  // Canvas reads
  'pen_get_metadata',
  'pen_find_nodes',
  'pen_get_computed',
  'pen_get_design_context',
  'pen_get_screenshot',
  'pen_get_variable_defs',
  'pen_list_variables',
  'pen_list_collections',
  // Catalog / search reads
  'pen_search_icons',
  'pen_search_design_patterns',
  'pen_recommend_components',
  // Exports (read + serialize; no document mutation)
  'pen_export_json',
  'pen_export_svg',
  'pen_export_png',
  'pen_export_pen',
  'pen_copy_as_code',
  // Read-only audit + critique sub-agents (LLM calls, no canvas writes)
  'pen_audit_design',
  'pen_generate_design_brief',
  'pen_self_critique',
  'pen_visual_critique',
]);

/// Minimal shape of a pi ToolDefinition this helper needs (the real
/// ToolDefinition in pi-agent-core declares executionMode natively).
export interface ExecutableToolLike {
  name: string;
  executionMode?: 'sequential' | 'parallel';
}

/**
 * Mark canvas-mutating tools as `executionMode: 'sequential'`.
 *
 * - pen_/figma tools NOT in PARALLEL_SAFE_TOOL_NAMES get
 *   `executionMode: 'sequential'` (ordered execution inside a batch).
 * - Read-only tools and non-canvas tools (plugins: todo, memory, subagents,
 *   ask_user_question) are returned untouched (pi default = parallel).
 * - Idempotent: a tool already carrying an explicit executionMode keeps it.
 */
export function applyExecutionModes<T extends ExecutableToolLike>(tools: T[]): T[] {
  return tools.map((t) => {
    if (t.executionMode) return t; // explicit wins — never override
    const isCanvasTool = t.name.startsWith('pen_') || t.name.startsWith('figma_');
    if (!isCanvasTool) return t; // plugin tools manage their own concurrency
    if (PARALLEL_SAFE_TOOL_NAMES.has(t.name)) return t; // pure read → parallel
    return { ...t, executionMode: 'sequential' as const };
  });
}
