// Tool execution-mode policy (Agent Performance Package, change 3 +
// Cline pattern 5.3 — adjacent-parallel tool batching).
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
// Cline's adjacent-parallel pattern goes further — it walks CONTIGUOUS runs
// of parallel-flagged tool calls inside one assistant message and batches
// each run via Promise.all, while sequential tools between two parallel runs
// still execute strictly one-at-a-time. The SDK dispatch is the
// all-or-nothing variant (one sequential anywhere → whole batch sequential);
// `executeToolsParallel` (below) is the contiguous-run helper that any
// runner with its own tool loop can call to get the Cline behavior.
//
// This module is PURE (no imports from the runner) so it is unit-testable.

/// Read-only / non-mutating pen_* tools that may safely run CONCURRENTLY
/// inside one multi-tool-call batch. Conservative by design: anything not on
/// this list that starts with pen_/figma_ is treated as an ordered mutation.
/// (Verified against the tool sources: none of these call ctx.applyPatch or
/// mutate the document tree; the pattern-memory writers are excluded too.)
///
/// Cline pattern 5.3: these are the read-only tools the system prompt should
/// hint the model to emit together in one response for parallel execution.
/// The legacy alias names (pen_list_shapes, pen_list_themes, pen_describe_node,
/// pen_search_shapes) are listed here too so applyExecutionModes treats the
/// alias entries (created by aliasToolEntries) as parallel-safe even before
/// the alias layer delegates to the canonical target tool. pen_describe_node
/// and pen_search_shapes are forward-looking — they are not currently
/// registered as tools, but if/when they are added they default to parallel.
export const PARALLEL_SAFE_TOOL_NAMES: ReadonlySet<string> = new Set([
  // Canvas reads
  'pen_get_metadata',
  'pen_list_shapes',          // legacy alias of pen_get_metadata (G.3)
  'pen_describe_node',        // forward-looking alias / future tool
  'pen_find_nodes',
  'pen_get_computed',
  'pen_get_design_context',
  'pen_get_screenshot',
  'pen_get_variable_defs',
  'pen_list_variables',
  'pen_list_collections',
  'pen_list_themes',          // legacy alias of pen_list_collections (G.3)
  'pen_search_shapes',        // forward-looking alias / future tool
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

// ---- Cline pattern 5.3: adjacent-parallel tool batching --------------------
//
// Cline's `executeToolCalls` walks the prepared tool-call list. For each
// CONTIGUOUS run of tools with `executionMode === 'parallel'`, it does
// `Promise.all(...)`. Sequential tools run one-at-a-time. The system prompt
// instructs the model: "emit independent read_files, search_codebase, and
// run_commands calls together in one response… do not split independent
// reads, searches, checks, or edits across separate turns."
//
// The pi-agent-core SDK dispatch is the all-or-nothing variant: if ANY tool
// in the batch is `executionMode: 'sequential'`, the WHOLE batch runs
// sequentially (agent-loop.js:287-291). This is correct for the production
// path (runner-native.ts feeds the assembled tool list to createAgentSession
// and lets the SDK loop execute it), but it leaves perf on the table when a
// turn interleaves read batches with mutations — e.g.:
//
//     [pen_get_metadata, pen_list_variables, pen_create_subtree,
//      pen_get_metadata, pen_get_metadata]
//
// The Cline pattern would batch the first two reads in parallel, run the
// mutation sequentially, then batch the trailing two reads in parallel —
// 3 "execution rounds" instead of 5. The SDK's all-or-nothing path runs all
// 5 sequentially because of the pen_create_subtree in the middle.
//
// `executeToolsParallel` below is the contiguous-run walker. It exists as:
//   1. The spec/contract for the Cline pattern (this module is pure — runner
//      code with its own tool loop, e.g. runner-legacy.ts, can import it).
//   2. A drop-in for runners that DO own the tool loop. The native runner
//      delegates to the SDK, so the SDK's dispatch is what production uses;
//      this helper is the documented upgrade path.
//
// Per the task constraint (impl-parallel-and-raf): call it instead of the
// sequential loop only when ALL tools in the batch are parallel-flagged
// (the conservative variant — matches the SDK's existing dispatch
// contract). The contiguous-run walk is exposed for the future, when a
// runner chooses to interleave.

/// Minimal shape of a prepared tool call this helper needs.
export interface PreparedToolCall<TTool = ExecutableToolLike, TArgs = unknown, TResult = unknown> {
  /// The tool being invoked (carries `executionMode`).
  tool?: TTool;
  /// The resolved arguments for this call.
  args?: TArgs;
  /// The caller's execute function — receives the prepared call and returns
  /// the tool's result. Implementations are responsible for emit/telemetry.
  execute?: (call: PreparedToolCall<TTool, TArgs, TResult>) => Promise<TResult>;
}

/// Effective execution mode for a prepared call — defaults to 'sequential'.
/// This mirrors the SDK's `executionMode` field and the existing
/// `applyExecutionModes` default (pen_/figma_ tools NOT in the parallel-safe
/// set default to sequential; everything else is parallel).
export function effectiveExecutionMode<T extends ExecutableToolLike>(
  tool: T | undefined,
): 'sequential' | 'parallel' {
  const declared = tool?.executionMode;
  if (declared === 'parallel' || declared === 'sequential') return declared;
  // Undeclared: match applyExecutionModes' default — canvas mutations stay
  // sequential, plugin tools + reads stay parallel.
  if (tool && (tool.name.startsWith('pen_') || tool.name.startsWith('figma_'))) {
    return PARALLEL_SAFE_TOOL_NAMES.has(tool.name) ? 'parallel' : 'sequential';
  }
  return 'parallel';
}

/**
 * Cline pattern 5.3 — walk contiguous runs of parallel-flagged tool calls
 * inside one batch. Sequential calls run one-at-a-time; each maximal run of
 * adjacent parallel calls runs concurrently via `Promise.all`. Results land
 * in emission order (slice positions preserved), so callers that downstream
 * zip results with the input array keep their existing mapping.
 *
 * Usage:
 *   const results = await executeToolsParallel(prepared, (c) =>
 *     this.executeTool(c),
 *   );
 *
 * The `executor` callback is the single-tool runner (handles emit/telemetry/
 * patches/result-shaping). It is invoked once per call — sequentially for
 * sequential calls, concurrently for parallel-run calls.
 *
 * Per the impl-parallel-and-raf constraint, this is the minimal-change
 * surface: the helper is pure, exports no side effects, and is callable from
 * any runner that owns its tool loop. The production native runner still
 * delegates to the SDK's `executeToolCalls`, which is the all-or-nothing
 * variant (safe — never over-parallelizes). Wiring this into the legacy
 * runner is a follow-up; the helper exists today as the contract + test
 * surface for the contiguous-parallel walk.
 */
export async function executeToolsParallel<
  TTool extends ExecutableToolLike = ExecutableToolLike,
  TArgs = unknown,
  TResult = unknown,
>(
  prepared: PreparedToolCall<TTool, TArgs, TResult>[],
  executor: (call: PreparedToolCall<TTool, TArgs, TResult>) => Promise<TResult>,
): Promise<TResult[]> {
  const results: TResult[] = new Array(prepared.length);
  for (let i = 0; i < prepared.length; ) {
    const mode = effectiveExecutionMode(prepared[i]?.tool);
    if (mode === 'sequential') {
      results[i] = await executor(prepared[i]);
      i++;
      continue;
    }
    // Walk the contiguous parallel run.
    const start = i;
    while (
      i < prepared.length &&
      effectiveExecutionMode(prepared[i]?.tool) === 'parallel'
    ) {
      i++;
    }
    const run = prepared.slice(start, i);
    const runResults = await Promise.all(run.map((c) => executor(c)));
    for (let k = 0; k < runResults.length; k++) {
      results[start + k] = runResults[k];
    }
  }
  return results;
}

/**
 * Conservative gate — true iff EVERY tool in the batch is parallel-flagged
 * (or defaults to parallel). Per the impl-parallel-and-raf constraint,
 * callers that want a minimal change use this gate to swap the sequential
 * loop for `executeToolsParallel` ONLY when the batch is uniformly parallel.
 * Mixed batches keep their existing sequential loop (matches the SDK's
 * all-or-nothing dispatch contract).
 */
export function isBatchFullyParallel<T extends ExecutableToolLike>(
  tools: (T | undefined)[],
): boolean {
  if (tools.length === 0) return true;
  return tools.every((t) => effectiveExecutionMode(t) === 'parallel');
}
