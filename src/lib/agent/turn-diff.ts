// turn-diff.ts — turn-level diff summary ("what the agent changed").
//
// UX pattern (researched from how established agent apps do it):
//
//   - Cursor: each assistant message gets an "Edited N files" chip that
//     expands into per-file diff hunks (+/− line counts, color-coded).
//   - Cline: every file write shows a diff review block with +added /
//     −removed coloring before/after applying.
//   - v0 / Lovable: each message is a "version" — a compact summary of the
//     changes that build, restorable from a history list.
//   - GitHub: the canonical "+ additions / − deletions" color language
//     (green/red) that every developer already reads at a glance.
//
// The canvas analog: every assistant turn emits a stream of CanvasPatch ops
// (add / update / remove / clear / tokens / restructure). We classify each
// into one of four diff categories and roll up the counts:
//
//   created       → add, bulk_add, duplicate, group (creates a frame), …
//   updated       → update, update_many, align, zorder, set_variable, …
//   deleted       → remove, clear
//   restructured  → group, ungroup, reparent, reorder, swap_variant, …
//
// The summary is computed from a COMPACT op record (op name + count +
// summary line) — never the full patch payload — so it can ride on the
// ChatTurn, the session-store Message (localStorage), and the server-side
// SessionMessage.diffSummary column without bloating persistence.
//
// Pure module: no React, no stores, no SDK imports — unit-testable as-is.

import type { CanvasPatch } from '../canvas/types';

/// Compact record of one canvas mutation, as tracked per turn.
export interface PatchOpRecord {
  /// The CanvasPatch op name ('add' | 'update' | 'remove' | …).
  op: string;
  /// How many shapes the op touched (best-effort count from the patch).
  count: number;
  /// Human summary line from the patch (agent-authored or tool-authored).
  summary: string;
}

/// The four diff categories, in display order.
export type DiffCategory = 'created' | 'updated' | 'deleted' | 'restructured';

/// Roll-up of one assistant turn's canvas mutations.
export interface TurnDiffSummary {
  created: number;
  updated: number;
  deleted: number;
  restructured: number;
  /// Whether the canvas was fully cleared this turn (clear destroys the
  /// per-shape counts, so it's surfaced as its own flag).
  cleared: boolean;
  /// All op records, in application order (for the expanded detail list).
  entries: PatchOpRecord[];
}

/// Ops that create shapes.
const CREATE_OPS = new Set(['add', 'bulk_add', 'duplicate']);
/// Ops that modify existing shapes in place.
const UPDATE_OPS = new Set([
  'update', 'update_many', 'align', 'zorder', 'background', 'viewport',
  'set_theme_axis', 'set_node_theme', 'set_variable', 'set_constraints',
  'set_component_property', 'set_instance_property', 'set_instance_override',
  'add_variant', 'rename_page', 'set_active_page',
]);
/// Ops that destroy shapes.
const DELETE_OPS = new Set(['remove', 'clear', 'delete_page']);
/// Ops that restructure the tree without creating/destroying content.
const RESTRUCTURE_OPS = new Set([
  'group', 'ungroup', 'reparent', 'reorder', 'mark_slot', 'flatten_boolean',
  'convert_to_component', 'place_instance', 'reset_instance', 'detach_instance',
  'combine_as_variants', 'swap_variant', 'create_component',
  'create_component_set', 'add_page', 'add_section',
]);
/// 'select' and 'undo'/'redo' are not mutations of record — they carry no
/// diff information (select is transient; undo/redo are compensations the
/// user initiated or the agent reversed).
const IGNORED_OPS = new Set(['select', 'undo', 'redo']);

/// Count how many shapes a patch touches, best-effort from its fields.
export function patchShapeCount(patch: CanvasPatch): number {
  if (patch.op === 'clear') {
    // Clear destroys everything — count is unknown from the patch alone.
    return 0;
  }
  if (Array.isArray(patch.shapes) && patch.shapes.length > 0) return patch.shapes.length; // bulk_add
  if (Array.isArray(patch.updates) && patch.updates.length > 0) return patch.updates.length; // update_many
  if (Array.isArray(patch.shapeIds) && patch.shapeIds.length > 0) return patch.shapeIds.length; // remove / select / group
  if (Array.isArray(patch.componentIds) && patch.componentIds.length > 0) return patch.componentIds.length;
  if (patch.shapeId) return 1;
  if (patch.groupId) return 1;
  return 1; // default: a single-shape op (update, set_variable, …)
}

/// Classify one patch into a diff category — null when the patch is not a
/// mutation of record (select / undo / redo).
export function patchCategory(patch: CanvasPatch): DiffCategory | null {
  if (IGNORED_OPS.has(patch.op)) return null;
  if (CREATE_OPS.has(patch.op)) return 'created';
  if (DELETE_OPS.has(patch.op)) return 'deleted';
  if (RESTRUCTURE_OPS.has(patch.op)) return 'restructured';
  if (UPDATE_OPS.has(patch.op)) return 'updated';
  // Unknown future ops default to "updated" — always counted, never lost.
  return 'updated';
}

/// Convert a CanvasPatch into the compact PatchOpRecord — null when the
/// patch should not be tracked (select / undo / redo).
export function patchToOpRecord(patch: CanvasPatch): PatchOpRecord | null {
  if (patchCategory(patch) === null) return null;
  return {
    op: patch.op,
    count: patchShapeCount(patch),
    summary: patch.summary || patch.op,
  };
}

const EMPTY_SUMMARY: TurnDiffSummary = {
  created: 0, updated: 0, deleted: 0, restructured: 0, cleared: false, entries: [],
};

/// Roll up op records into a TurnDiffSummary.
export function summarizeTurnDiff(records: PatchOpRecord[]): TurnDiffSummary {
  const out: TurnDiffSummary = { ...EMPTY_SUMMARY, entries: [] };
  for (const rec of records) {
    out.entries.push(rec);
    if (rec.op === 'clear') {
      out.cleared = true;
      continue;
    }
    switch (patchCategory({ op: rec.op } as CanvasPatch)) {
      case 'created': out.created += rec.count; break;
      case 'updated': out.updated += rec.count; break;
      case 'deleted': out.deleted += rec.count; break;
      case 'restructured': out.restructured += rec.count; break;
      default: break;
    }
  }
  return out;
}

/// Convenience: patches → summary in one step.
export function diffSummaryFromPatches(patches: CanvasPatch[]): TurnDiffSummary {
  return summarizeTurnDiff(
    patches.map((p) => patchToOpRecord(p)).filter((r): r is PatchOpRecord => r !== null),
  );
}

/// True when the summary carries nothing worth rendering.
export function isDiffEmpty(d: TurnDiffSummary): boolean {
  return (
    d.created === 0 && d.updated === 0 && d.deleted === 0 &&
    d.restructured === 0 && !d.cleared
  );
}

/// Compact one-line rendering: "12 created · 5 updated · 2 deleted".
/// Order matches the card; zero-counts are omitted. Empty → "no changes".
export function formatDiffSummary(d: TurnDiffSummary): string {
  if (isDiffEmpty(d)) return 'no canvas changes';
  const parts: string[] = [];
  if (d.cleared) parts.push('canvas cleared');
  if (d.created > 0) parts.push(`${d.created} created`);
  if (d.updated > 0) parts.push(`${d.updated} updated`);
  if (d.deleted > 0) parts.push(`${d.deleted} deleted`);
  if (d.restructured > 0) parts.push(`${d.restructured} restructured`);
  return parts.join(' · ');
}

/// Serialize for persistence (session Message + server column).
/// Kept as JSON of the entries — the roll-up is recomputed on read so the
/// format stays flat and future categories derive automatically.
export function serializeDiffEntries(records: PatchOpRecord[]): string {
  return JSON.stringify(records);
}

/// Parse a persisted diffSummary JSON string back into records.
/// Tolerates null / malformed JSON (returns []).
export function parseDiffEntries(raw: string | null | undefined): PatchOpRecord[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is PatchOpRecord =>
        r !== null && typeof r === 'object' &&
        typeof r.op === 'string' && typeof r.count === 'number' &&
        typeof r.summary === 'string',
    );
  } catch {
    return [];
  }
}
