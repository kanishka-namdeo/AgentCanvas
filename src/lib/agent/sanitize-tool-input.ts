// Centralized LLM-output sanitizer for typed tool actions (tldraw pattern
// 6.5 — `sanitizeAction(action, helpers)`).
//
// AgentCanvas already has 60+ typed `pen_*` tools whose schemas ARE the
// typed-action contract (the model emits `{ tool: "pen_create_node", args:
// {...} }`, the schema validates it, and `applyAction` is the tool body's
// `execute`). What was missing is a CENTRALIZED pre-execution pass that
// catches the recurring LLM drift classes before the tool body sees them:
//
//   1. Numeric fields arrive as strings — `{ width: "200" }` instead of
//      `{ width: 200 }`. Downstream canvas-patch arithmetic does
//      `width + 100` and either concatenates ("200100") or NaNs.
//   2. Unknown top-level fields slip in — the model hallucinates a
//      deprecated or invented name (`{ background: "#fff" }` on a tool
//      that takes `fill`). The tool body ignores them, but they bloat
//      the roundtrip JSON and confuse downstream telemetry.
//   3. shapeId references point at ids that no longer exist on the canvas
//      (the model cached a stale snapshot mid-turn, or guessed an id).
//      This was the #1 cause of the "no shape with id X" stuck loop the
//      OpenHands stuck-detector was added to break out of.
//
// This module is PURE (no imports from tools.ts → no cycles, no side
// effects, no I/O). The runner wires it into every tool-call's execute
// wrapper chain (right before normalizeToolParams + repairArrayArgs) so
// the rest of the pipeline sees cleaned args.
//
// Returns:
//   { ok: true,  args, warnings }  — proceed with `args`
//   { ok: false, error }          — surface `error` to the model; skip execute
//
// Failure is reserved for the one case the tool body cannot recover from
// on its own: a referenced shape id that doesn't exist. Coercion + field
// strip + empty-string drop are non-fatal — the cleaned payload always
// proceeds.

// ---- Public API ------------------------------------------------------------

export interface SanitizeSuccess {
  ok: true;
  args: Record<string, unknown>;
  /// Non-fatal observations (stripped fields, coerced numerics). The
  /// runner may surface these as a one-line `[sanitize]` note appended
  /// to the tool result so the model learns the corrected spelling.
  warnings: string[];
}

export interface SanitizeFailure {
  ok: false;
  /// One-sentence human-readable explanation the runner returns as a
  /// tool result. Always tells the model which corrective tool to call.
  error: string;
}

export type SanitizeResult = SanitizeSuccess | SanitizeFailure;

export interface SanitizeOptions {
  /// Live set of shape IDs that currently exist on the canvas. When
  /// provided, ID-typed fields that reference a non-existent shape cause
  /// `{ ok: false }`. Pass a function for lazy evaluation (the lookup
  /// runs only when an id-bearing tool call arrives — most tool calls
  /// don't reference a shape id).
  existingShapeIds?: Set<string> | (() => Set<string> | undefined);
  /// When true (default), unknown top-level fields for tools listed in
  /// TOOL_FIELD_WHITELIST are dropped. When false, unknown fields are
  /// kept verbatim (legacy mode — use only when the tool's schema is
  /// not yet whitelisted here and the caller needs the raw payload).
  stripUnknownFields?: boolean;
}

// ---- Field taxonomy --------------------------------------------------------
//
// The lists below are intentionally conservative: only fields explicitly
// known to occur as numeric / shape-id / array-of-shape-id across the
// typed tool schemas are touched. Everything else passes through.

/// Numeric top-level fields the LLM commonly stringifies. TypeBox accepts
/// both shapes, but downstream canvas-patch arithmetic (`x + 100`) and the
/// collision/cluster geometry helpers assume real numbers — a stringified
/// numeric was the root cause of multiple `NaN` bounding-box cascades.
const NUMERIC_FIELDS: ReadonlySet<string> = new Set([
  // Geometry
  'x', 'y', 'width', 'height',
  'rotation', 'opacity',
  // Typography
  'fontSize', 'fontWeight', 'letterSpacing', 'lineHeight',
  // Stroke / radius
  'strokeWidth', 'radius', 'blur',
  // Auto-layout (legacy + v3)
  'gap', 'padding',
  'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom',
  'itemSpacing',
  // Duplicate layout
  'count', 'offsetX', 'offsetY', 'spacing',
  // Z-order
  'zIndex',
]);

/// Singular ID fields — every value is a shape id that must exist on the
/// canvas (or, for variableId / collectionId / pageId / sectionId, an id of
/// the corresponding kind). When `existingShapeIds` is provided, an id-typed
/// field referencing a non-existent id is a hard sanitize failure.
///
/// NOTE: variableId / collectionId / pageId / sectionId point at non-shape
/// entities. They're listed here so the field-name detection fires, but the
/// existence check skips them (the live canvas id set only contains shape
/// ids — false negatives on these would block legitimate calls). See the
/// SHAPE_ONLY_ID_FIELDS set below.
const SHAPE_ID_FIELDS: ReadonlySet<string> = new Set([
  'nodeId', 'shapeId', 'parentId', 'newParentId', 'maskId',
  'instanceId', 'variantComponentId', 'componentId', 'groupId',
  'variableId', 'collectionId', 'pageId', 'sectionId',
]);

/// Subset of SHAPE_ID_FIELDS that point at SHAPE entities (the only kind
/// `existingShapeIds` is authoritative for). Non-shape id fields
/// (variableId / collectionId / pageId / sectionId) are NOT validated
/// against the canvas shape set — those reference other registries.
const SHAPE_ONLY_ID_FIELDS: ReadonlySet<string> = new Set([
  'nodeId', 'shapeId', 'parentId', 'newParentId', 'maskId',
  'instanceId', 'variantComponentId', 'componentId', 'groupId',
]);

/// Array-of-shape-id fields. Same existence-check semantics as
/// SHAPE_ONLY_ID_FIELDS — any missing id fails the whole call (we don't
/// silently drop entries — the model needs to know its id list is stale).
const SHAPE_IDS_FIELDS: ReadonlySet<string> = new Set([
  'nodeIds', 'shapeIds', 'componentIds', 'groupIds',
]);

/// Top-level field whitelists for the most-mutated tools. Tools not listed
/// here skip the unknown-field-strip step entirely (too risky to make
/// assumptions about every tool's evolving schema — a false-positive strip
/// would silently drop a legitimate field the tool just learned to accept).
/// Conservative by design: extend the map one tool at a time, only when a
/// real hallucination has been observed in production logs.
const TOOL_FIELD_WHITELIST: Record<string, readonly string[]> = {
  pen_create_node: [
    'type', 'name', 'x', 'y', 'width', 'height', 'rotation', 'opacity',
    'fill', 'stroke', 'strokeWidth', 'radius', 'text', 'fontSize',
    'fontWeight', 'fontFamily', 'letterSpacing', 'lineHeight', 'textAlign',
    'textTransform', 'underline', 'strikethrough', 'textColor', 'src',
    'closed', 'blur', 'icon', 'iconName', 'iconLibrary', 'library',
    'gradient', 'shadow', 'shadows', 'autoLayout', 'parentId', 'radii',
    'backgroundBlur', 'blendMode', 'flipX', 'flipY', 'constraints', 'clip',
    'points', 'shapeId',
  ],
  pen_update_node: ['nodeId', 'changes', 'shapeId'],
  pen_delete_nodes: ['nodeIds', 'shapeIds', 'shapeId'],
  pen_duplicate_nodes: [
    'nodeIds', 'shapeIds', 'shapeId',
    'count', 'direction', 'spacing', 'offsetX', 'offsetY',
  ],
  pen_reparent_nodes: [
    'nodeIds', 'shapeIds', 'shapeId',
    'parentId', 'newParentId', 'index', 'keepAbsolutePosition',
  ],
  pen_group_shapes: ['shapeIds', 'nodeIds', 'groupId', 'name'],
  pen_align_shapes: ['shapeIds', 'nodeIds', 'alignKind'],
  pen_select_nodes: ['nodeIds', 'shapeIds', 'shapeId'],
};

// ---- Internal helpers ------------------------------------------------------

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    // Empty string is not a number; the field-stripping step handles it.
    const trimmed = v.trim();
    if (trimmed === '') return undefined;
    const n = Number(trimmed);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---- Public function -------------------------------------------------------

/**
 * Sanitize the args the LLM emitted for a typed tool call.
 *
 * Pure + total. Unknown tool names pass through (no whitelist lookup, no
 * field strip) — the tool body's own validation handles them.
 *
 * @param toolName  the canonical tool name (post-alias resolution)
 * @param args      the raw args object the LLM emitted
 * @param opts      sanitize options (existingShapeIds for id validation,
 *                  stripUnknownFields toggles the unknown-field drop)
 */
export function sanitizeToolInput(
  toolName: string,
  args: any,
  opts?: SanitizeOptions,
): SanitizeResult {
  // Non-object args (null, array, primitive) pass through unchanged —
  // the tool body's own validation surfaces the schema mismatch. The
  // common case is a plain object, so the rest of this function is the
  // plain-object path.
  if (!isPlainObject(args)) {
    return { ok: true, args: (args ?? {}) as Record<string, unknown>, warnings: [] };
  }

  const stripUnknown = opts?.stripUnknownFields ?? true;
  const whitelist = stripUnknown ? TOOL_FIELD_WHITELIST[toolName] : undefined;
  const warnings: string[] = [];

  // ---- Step 1+2+3: walk top-level keys, coerce numerics, drop unknown
  // fields, drop empty strings. -------------------------------------------
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (whitelist && !whitelist.includes(key)) {
      warnings.push(`stripped unknown field "${key}" from ${toolName} args`);
      continue;
    }
    if (value === '') {
      // The LLM emits `{ fill: "" }` instead of omitting the field. The
      // tool body's "absent vs. empty" branches sometimes diverge (an
      // empty stroke color renders as black, not "no stroke"). Drop the
      // field — the schema's Optional treats absence as "use the
      // default / leave the previous value", which is what the model
      // meant by the empty string.
      warnings.push(`dropped empty-string field "${key}" from ${toolName} args`);
      continue;
    }
    if (NUMERIC_FIELDS.has(key)) {
      const n = asNumber(value);
      if (n !== undefined) {
        out[key] = n;
        continue;
      }
      // Non-coercible numeric — keep as-is. Two cases:
      //   (a) a string sentinel the schema explicitly accepts
      //       (width: "fit_content" / "fill_container" — ShapeInputSchema
      //       width/height are Type.Union([Number, String]));
      //   (b) a malformed value the tool body's own validation rejects
      //       with a real schema error (better than silently dropping).
      out[key] = value;
      continue;
    }
    out[key] = value;
  }

  // ---- Step 4: validate shape-id references against the live canvas. ---
  //
  // Only fires when the caller passed `existingShapeIds`. A referenced id
  // that doesn't exist on the canvas is a hard failure — the tool body
  // would return its own ad-hoc "not found" message anyway, but unifying
  // the failure here means the runner returns ONE consistent error shape
  // (and tells the model which corrective tool to call: pen_get_metadata
  // or pen_find_nodes). This is the pattern the OpenHands stuck-detector
  // was added to break out of — pre-empt the loop instead of detecting it.
  if (opts?.existingShapeIds) {
    const lookupFn = typeof opts.existingShapeIds === 'function'
      ? opts.existingShapeIds
      : () => opts.existingShapeIds as Set<string>;
    let live: Set<string> | undefined;
    try { live = lookupFn(); } catch { live = undefined; }
    if (live && live.size > 0) {
      // Singular shape-id fields.
      for (const idField of SHAPE_ONLY_ID_FIELDS) {
        const v = out[idField];
        if (typeof v === 'string' && v.length > 0 && !live.has(v)) {
          return {
            ok: false,
            error:
              `sanitize: ${toolName}.${idField}="${v}" does not exist on the canvas. ` +
              `Call pen_get_metadata (no args) to list top-level node ids, or ` +
              `pen_find_nodes to search by name/type. Then retry.`,
          };
        }
      }
      // Array-of-shape-id fields.
      for (const idsField of SHAPE_IDS_FIELDS) {
        const v = out[idsField];
        if (Array.isArray(v) && v.length > 0) {
          const missing = v.filter(
            (id) => typeof id === 'string' && id.length > 0 && !live!.has(id),
          );
          if (missing.length > 0) {
            const preview = missing.slice(0, 3).map((s) => `"${s}"`).join(', ');
            const more = missing.length > 3 ? ` (+${missing.length - 3} more)` : '';
            return {
              ok: false,
              error:
                `sanitize: ${toolName}.${idsField} references ${missing.length} missing shape id(s): ` +
                `${preview}${more}. Call pen_get_metadata to discover valid node ids, then retry.`,
            };
          }
        }
      }
    }
  }

  return { ok: true, args: out, warnings };
}

// ---- Test surface (pure helpers exported for unit tests) ------------------

/// The numeric-field set. Exported for tests + so the runner can extend
/// it at runtime if a future tool introduces a new numeric field before
/// the next module release.
export const __SANITIZE_NUMERIC_FIELDS = NUMERIC_FIELDS;

/// The shape-id field set (singular).
export const __SANITIZE_SHAPE_ID_FIELDS = SHAPE_ONLY_ID_FIELDS;

/// The shape-id array field set.
export const __SANITIZE_SHAPE_IDS_FIELDS = SHAPE_IDS_FIELDS;

/// The tool → whitelist map. Exported so tests can assert that the most-
/// mutated tools are present.
export const __SANITIZE_TOOL_FIELD_WHITELIST = TOOL_FIELD_WHITELIST;
