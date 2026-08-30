// tool-errors.ts — standardized, actionable error results for canvas tools.
//
// Audit 2-b T11: the highest-frequency error class (bad shape id) was also
// the least actionable — bare `Error: no shape with id X` with no recovery
// hint. Anthropic's "Writing effective tools for agents" guidance: error text
// is the model's ONLY signal; actionable errors convert retry loops into
// recovery. Every not-found result now includes:
//   1. the id that was tried,
//   2. 2-3 candidate layers (name + id) from the canvas so the model can
//      self-correct a typo without another round trip,
//   3. the exact recovery call (pen_get_metadata lists every id).
//
// `did you mean` for unknown TOOL names lives in tool-aliases.ts (the alias
// map already resolves deprecated spellings at dispatch time).

import type { CanvasToolContext } from './tools';

export interface ToolErrorResult {
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, unknown>;
  isError: boolean;
}

/**
 * Standard "no shape with this id" error with candidate layers + the
 * recovery call. Use for EVERY id-lookup miss in tool execute bodies.
 *
 * @param ctx    the tool context (reads the live shape list)
 * @param id     the id the model passed (or a description when undefined)
 * @param intent one-line description of what was being attempted (e.g.
 *               'Set explicit modes') — helps the model understand what
 *               argument to fix.
 */
export function notFoundResult(
  ctx: CanvasToolContext,
  id: string | undefined | null,
  intent?: string,
): ToolErrorResult {
  const tried = id === undefined || id === null || id === '' ? '(missing/empty id)' : `"${String(id)}"`;
  const shapes = (ctx.getShapes?.() ?? []) as Array<{ id: string; name?: string; type?: string }>;
  const total = shapes.length;
  const candidates = shapes.slice(0, 3).map((s) => `"${s.name ?? s.id}" (${s.id}${s.type ? `, ${s.type}` : ''})`);
  const candidateNote =
    total === 0
      ? ' The canvas is EMPTY — create the layer first (pen_create_node / pen_create_subtree).'
      : ` Layers on canvas (of ${total}): ${candidates.join('; ')}.`;
  return {
    content: [
      {
        type: 'text',
        text:
          `Error: no shape with id ${tried}.${intent ? ` (while trying to: ${intent})` : ''}` +
          candidateNote +
          ` Call pen_get_metadata (no arguments) to list every layer id, then retry with a valid id — do NOT repeat the same id.`,
      },
    ],
    details: { error: 'not_found', shapeId: id ?? null },
    isError: true,
  };
}
