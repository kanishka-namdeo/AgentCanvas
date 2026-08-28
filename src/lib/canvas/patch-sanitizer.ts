// Agent-patch sanitizer — the tldraw "validate → sanitize → apply" layer.
//
// Because the canvas store is APPEND-ONLY (patches are applied and never
// rewritten), a malformed patch does damage that can't be quietly patched
// later. This module inspects every AGENT-emitted patch BEFORE it is applied
// server-side / streamed to clients and:
//
//   1. Drops patches with an unknown `op` (they would silently no-op in the
//      applier but still create phantom undo entries + turn-diff records).
//   2. Drops target ops (`update` / `update_many` / `remove` / `duplicate`)
//      that reference shape IDs which don't exist on the canvas — same
//      reasoning: the applier no-ops, but the patch still fans out to every
//      viewer and pollutes the diff summary.
//   3. Drops `add` / `bulk_add` roots whose EXPLICIT id already exists on
//      the canvas (the #1 double-apply failure: two nodes with the same id,
//      previously masked only by the renderer's render-time id dedupe).
//   4. Clamps obviously-broken geometry (NaN / ±Infinity / absurdly large
//      coordinates and sizes) into a sane range instead of letting the
//      renderer compute transform: NaN.
//
// Sanitization is deliberately CONSERVATIVE: anything the rules don't cover
// passes through unchanged with no warning — the goal is to catch the
// catastrophic cases, not to second-guess valid model output.

import type { CanvasDocument, CanvasPatch } from './types';

export interface SanitizePatchResult {
  /// The (possibly cleaned) patch, or null when the patch should be dropped.
  patch: CanvasPatch | null;
  /// Human-readable notes for logs / the event journal.
  warnings: string[];
}

/// The frozen patch-op vocabulary (spec §5.1 — op names are frozen; mirrors
/// the CanvasPatch['op'] union in types.ts). Anything else is a malformed
/// patch (typo'd/hallucinated op) that would silently no-op in the applier
/// while still fanning out to every viewer and polluting the diff summary.
/// Keep in sync with the union when a new op ships.
const KNOWN_OPS: ReadonlySet<string> = new Set([
  'add', 'update', 'remove', 'clear', 'background', 'select',
  'bulk_add', 'add_subtree', 'update_many', 'duplicate',
  'group', 'ungroup', 'align', 'tokens', 'zorder', 'reorder',
  'viewport', 'undo', 'redo',
  'set_theme_axis', 'set_node_theme', 'set_variable', 'mark_slot',
  'reparent', 'set_constraints',
  'add_page', 'delete_page', 'rename_page', 'set_active_page', 'add_section',
  'create_component', 'create_component_set', 'add_variant',
  'set_component_property', 'set_instance_property', 'flatten_boolean',
  'convert_to_component', 'place_instance', 'set_instance_override',
  'reset_instance', 'detach_instance', 'combine_as_variants', 'swap_variant',
]);

/// Sane canvas-space bounds (Figma's editable space is ±32,768px; we are
/// far more generous because multi-screen canvases grow rightward).
const MAX_COORD = 100_000;
const MAX_SIZE = 100_000;
const MAX_FONT_SIZE = 512;
const MAX_RADIUS = 10_000;

function clampNumber(value: unknown, min: number, max: number): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

/// Clamp geometry-ish fields on a plain shape partial IN PLACE (the partial
/// was produced by JSON.parse of the NDJSON line — never shared state).
function clampShapePartial(shape: Record<string, unknown> | undefined, warnings: string[]): void {
  if (!shape || typeof shape !== 'object') return;
  const geoFields: Array<[string, number, number]> = [
    ['x', -MAX_COORD, MAX_COORD],
    ['y', -MAX_COORD, MAX_COORD],
    ['width', 0, MAX_SIZE],
    ['height', 0, MAX_SIZE],
    ['fontSize', 1, MAX_FONT_SIZE],
    ['radius', 0, MAX_RADIUS],
    ['strokeWidth', 0, MAX_RADIUS],
  ];
  for (const [field, min, max] of geoFields) {
    if (field in shape) {
      const clamped = clampNumber(shape[field], min, max);
      if (clamped === null) {
        // NaN / Infinity — drop the field so the applier fills its default.
        delete shape[field];
        warnings.push(`dropped non-finite ${field}`);
      } else if (clamped !== Number(shape[field])) {
        shape[field] = clamped;
        warnings.push(`clamped ${field}=${String(shape[field])} → ${clamped}`);
      }
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/// Sanitize one agent-emitted patch against the CURRENT canvas state.
/// Pure: never mutates `canvas`; may mutate + reuse the passed `patch`'s
/// nested payloads (callers hand us a freshly JSON-parsed object).
export function sanitizeAgentPatch(patch: CanvasPatch, canvas: CanvasDocument): SanitizePatchResult {
  const warnings: string[] = [];

  if (!patch || typeof patch !== 'object' || typeof patch.op !== 'string') {
    return { patch: null, warnings: ['patch is not an object'] };
  }

  if (!KNOWN_OPS.has(patch.op)) {
    return { patch: null, warnings: [`unknown op "${patch.op}"`] };
  }

  const existingIds = new Set((canvas.shapes ?? []).map((s) => s.id));

  switch (patch.op) {
    case 'add': {
      const shape = asRecord(patch.shape);
      if (!shape) return { patch: null, warnings: ['add without shape payload'] };
      const explicitId = typeof shape.id === 'string' ? shape.id : undefined;
      if (explicitId && existingIds.has(explicitId)) {
        return { patch: null, warnings: [`add: id "${explicitId}" already exists on canvas`] };
      }
      clampShapePartial(shape, warnings);
      return { patch, warnings };
    }

    case 'bulk_add': {
      const shapes = Array.isArray(patch.shapes) ? patch.shapes : null;
      if (!shapes || shapes.length === 0) {
        return { patch: null, warnings: ['bulk_add with no shapes'] };
      }
      // Dedupe ids WITHIN the payload + drop roots that already exist.
      const seen = new Set<string>();
      const kept = shapes.filter((partial) => {
        const rec = asRecord(partial);
        if (!rec) {
          warnings.push('bulk_add: dropped non-object shape entry');
          return false;
        }
        const id = typeof rec.id === 'string' ? rec.id : undefined;
        if (id) {
          if (seen.has(id)) {
            warnings.push(`bulk_add: dropped duplicate id "${id}" within payload`);
            return false;
          }
          seen.add(id);
          if (existingIds.has(id)) {
            warnings.push(`bulk_add: dropped id "${id}" already on canvas`);
            return false;
          }
        }
        clampShapePartial(rec, warnings);
        return true;
      });
      if (kept.length === 0) {
        return { patch: null, warnings: [...warnings, 'bulk_add: every entry dropped'] };
      }
      return {
        patch: kept.length === shapes.length ? patch : { ...patch, shapes: kept },
        warnings,
      };
    }

    case 'add_subtree': {
      const shape = asRecord(patch.shape);
      if (!shape) return { patch: null, warnings: ['add_subtree without shape payload'] };
      const rootId =
        typeof patch.shapeId === 'string'
          ? patch.shapeId
          : typeof shape.id === 'string'
            ? shape.id
            : undefined;
      if (rootId && existingIds.has(rootId)) {
        return { patch: null, warnings: [`add_subtree: root id "${rootId}" already exists on canvas`] };
      }
      clampShapePartial(shape, warnings);
      return { patch, warnings };
    }

    case 'update': {
      if (!patch.shapeId) return { patch: null, warnings: ['update without shapeId'] };
      if (!existingIds.has(patch.shapeId)) {
        return { patch: null, warnings: [`update: target "${patch.shapeId}" not on canvas`] };
      }
      clampShapePartial(asRecord(patch.shape), warnings);
      return { patch, warnings };
    }

    case 'update_many': {
      const updates = Array.isArray(patch.updates) ? patch.updates : null;
      if (!updates || updates.length === 0) {
        return { patch: null, warnings: ['update_many with no updates'] };
      }
      const kept = updates.filter((u) => {
        const rec = asRecord(u);
        const id = rec && typeof rec.id === 'string' ? rec.id : undefined;
        if (!id || !existingIds.has(id)) {
          warnings.push(`update_many: dropped missing target "${String(id)}"`);
          return false;
        }
        clampShapePartial(asRecord(rec?.changes), warnings);
        return true;
      });
      if (kept.length === 0) {
        return { patch: null, warnings: [...warnings, 'update_many: every target missing'] };
      }
      return {
        patch: kept.length === updates.length ? patch : { ...patch, updates: kept },
        warnings,
      };
    }

    case 'remove': {
      const ids = patch.shapeIds ?? (patch.shapeId ? [patch.shapeId] : []);
      const missing = ids.filter((id) => !existingIds.has(id));
      if (ids.length > 0 && missing.length === ids.length) {
        // Every target is already gone — a pure no-op; drop the patch.
        return { patch: null, warnings: [`remove: no target exists (${ids.slice(0, 3).join(', ')}…)`] };
      }
      if (missing.length > 0) {
        warnings.push(`remove: ${missing.length} target(s) already gone (kept the rest)`);
      }
      return { patch, warnings };
    }

    case 'duplicate': {
      const ids = patch.shapeIds ?? [];
      const anyExists = ids.some((id) => existingIds.has(id));
      if (ids.length > 0 && !anyExists) {
        return { patch: null, warnings: ['duplicate: no source shape exists'] };
      }
      return { patch, warnings };
    }

    // Ops with no target IDs and no geometry (background, clear, select,
    // undo/redo, viewport, variables, tokens…) — pass through untouched.
    default:
      return { patch, warnings };
  }
}
