// Pure clipboard helpers — browser-safe, unit-testable.
//
// These functions serialize / deserialize / offset shapes for the clipboard
// system. The `useClipboard` hook (in `src/hooks/use-clipboard.ts`) wraps these
// with `navigator.clipboard` calls + a localStorage fallback.

import type { Shape } from '../canvas/types';

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
  try {
    const parsed = JSON.parse(json);
    if (!parsed || parsed.kind !== 'shape' || !Array.isArray(parsed.shapes)) {
      return [];
    }
    return parsed.shapes as Shape[];
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
