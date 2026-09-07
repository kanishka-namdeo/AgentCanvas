// Pure clipboard helpers — browser-safe, unit-testable.
//
// These functions serialize / deserialize / offset shapes for the clipboard
// system. The `useClipboard` hook (in `src/hooks/use-clipboard.ts`) wraps these
// with `navigator.clipboard` calls + a localStorage fallback.

import type { Shape } from '../canvas/types';

// (2026-09-07 UI hardening, 12-d#1 — mega-paste): a hostile or accidental
// select-all clipboard payload (50k shapes / 100MB of JSON) used to reach
// JSON.parse + bulk_add's O(N²) insertNode with ZERO client-side validation,
// freezing the tab before the server's 20k-shape cap was ever consulted.
// The three guards below fail the paste fast at the clipboard boundary.

/** Max raw clipboard string accepted by `deserializeShapes` (2,000,000 chars). Checked BEFORE JSON.parse so an oversized payload never reaches the parser. */
export const MAX_PASTE_RAW_CHARS = 2_000_000;

/** Max shapes accepted in one paste. bulk_add runs insertNode per shape, which copies the children array per root-level insert → O(N²) — 2k keeps the paste snappy while staying far under the server's 20k canvasState cap. */
export const MAX_PASTE_SHAPES = 2_000;

/** Type guard: a plausible shape entry — an object carrying a string shape kind (`type`) and a string `id`. Malformed entries are dropped by `deserializeShapes`. */
function isPlausibleShapeEntry(v: unknown): v is Shape {
  if (typeof v !== 'object' || v === null) return false;
  const rec = v as Record<string, unknown>;
  return (
    typeof rec.id === 'string' &&
    rec.id.length > 0 &&
    typeof rec.type === 'string' &&
    rec.type.length > 0
  );
}

/** Serialize an array of shapes to a JSON string (for navigator.clipboard.writeText). */
export function serializeShapes(shapes: Shape[]): string {
  return JSON.stringify({
    kind: 'shape' as const,
    version: 1,
    shapes: shapes.map((s) => ({ ...s })),
  });
}

/** Deserialize a JSON string back into an array of shapes. Returns [] on error or kind mismatch. */
export function deserializeShapes(json: string): Shape[] {
  // (2026-09-07 UI hardening, 12-d#1) raw size cap — reject before JSON.parse.
  if (json.length > MAX_PASTE_RAW_CHARS) {
    console.warn(
      `[clipboard] paste payload rejected: ${json.length} chars exceeds the ${MAX_PASTE_RAW_CHARS}-char cap (checked before JSON.parse).`,
    );
    return [];
  }
  try {
    const parsed = JSON.parse(json);
    if (!parsed || parsed.kind !== 'shape' || !Array.isArray(parsed.shapes)) {
      return [];
    }
    // (2026-09-07 UI hardening, 12-d#1) shape count cap — a 50k-entry array
    // would O(N²) bulk_add long before the server's 20k cap is consulted.
    if (parsed.shapes.length > MAX_PASTE_SHAPES) {
      console.warn(
        `[clipboard] paste payload rejected: ${parsed.shapes.length} shapes exceeds the ${MAX_PASTE_SHAPES}-shape cap.`,
      );
      return [];
    }
    // (2026-09-07 UI hardening, 12-d#1) per-shape validation — every entry
    // must be an object with a string shape kind and string id; malformed
    // entries are dropped. If ALL are dropped the paste fails ([] return).
    const shapes = (parsed.shapes as unknown[]).filter(isPlausibleShapeEntry);
    if (shapes.length < parsed.shapes.length) {
      console.warn(
        `[clipboard] dropped ${parsed.shapes.length - shapes.length} malformed shape entries from the paste payload.`,
      );
    }
    return shapes as Shape[];
  } catch {
    return [];
  }
}

/**
 * Offset every shape's x/y by (dx, dy). Returns a new array (does not mutate input).
 * Used by "Paste" (offset +24) vs "Paste in place" (offset 0).
 *
 * Also assigns fresh IDs to every shape so the pasted shapes don't collide with
 * the originals.
 */
export function offsetShapes(shapes: Shape[], dx: number, dy: number, newIds = true): Shape[] {
  const idMap = new Map<string, string>();
  // First pass: assign fresh IDs.
  if (newIds) {
    for (const s of shapes) {
      idMap.set(s.id, makeId());
    }
  }
  // Second pass: offset x/y + rewrite parentId references.
  return shapes.map((s) => {
    const newId = newIds ? (idMap.get(s.id) ?? s.id) : s.id;
    const newParentId = s.parentId
      ? (newIds ? (idMap.get(s.parentId) ?? s.parentId) : s.parentId)
      : null;
    return {
      ...s,
      id: newId,
      parentId: newParentId,
      x: s.x + dx,
      y: s.y + dy,
    };
  });
}

/** Generate a fresh shape id. Mirrors the format used by the .pen tree helpers. */
function makeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Typed clipboard payload envelope. Lets us distinguish shape vs color vs value
 * vs constraints payloads when reading from the clipboard.
 */
export type ClipboardPayload =
  | { kind: 'shape'; version: 1; shapes: Shape[] }
  | { kind: 'color'; value: string }
  | { kind: 'value'; value: number }
  | { kind: 'constraints'; horizontal: string; vertical: string };

/** Detect the payload kind from a raw clipboard string. Returns 'shape'|'color'|'value'|'constraints'|null. */
export function detectPayloadKind(json: string): ClipboardPayload['kind'] | null {
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed.kind !== 'string') return null;
    return parsed.kind as ClipboardPayload['kind'];
  } catch {
    return null;
  }
}
