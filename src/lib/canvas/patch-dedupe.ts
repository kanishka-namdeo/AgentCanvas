// Idempotent agent-patch application — toolCallId-keyed dedup.
//
// Why: canvas patches are APPEND-ONLY in this app's model (a patch can never
// be edited out after the fact), so the one reliability property we must
// guarantee is that the same patch is never APPLIED twice. Today both the
// WS bridge (canvas-sync driveAgent) and the client's `_onSync` apply every
// `canvas:patch` event unconditionally — an NDJSON replay, a socket.io
// at-least-once redelivery, or a double `driveAgent` on the same document
// would double-apply (an `add` becomes two nodes; an append-only store can
// never undo that noiselessly).
//
// Dedup key = toolCallId + content hash of the patch:
//   - Patches with NO toolCallId (user-initiated edits via sendPatch) are
//     never deduped — user drags re-fire similar patches legitimately.
//   - One tool call may legitimately emit MULTIPLE patches
//     (details.patches) — keying on toolCallId alone would drop them.
//     A cheap content hash distinguishes them while still catching a
//     verbatim duplicate delivery of the same patch.
//
// Pure + dependency-free so both the Node canvas-sync service and the
// browser bundle can import it.

import type { CanvasPatch } from './types';

/// FNV-1a 32-bit — fast, tiny, plenty for a dedup key (collision risk is
/// theoretical and only causes one skipped duplicate).
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/// Stable serialization: JSON key order of the re-parsed patch follows the
/// first-seen key order, so two deliveries of the SAME patch serialize
/// identically while different patches differ.
function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

/// Dedup key for an agent-emitted patch. Returns null when the patch carries
/// no toolCallId (user edit — never deduped).
export function patchDedupeKey(toolCallId: string | undefined, patch: CanvasPatch): string | null {
  if (!toolCallId) return null;
  return `${toolCallId}#${fnv1a(stableStringify(patch))}`;
}

export interface BoundedDedupSet {
  has(key: string): boolean;
  add(key: string): void;
  /// Number of tracked keys (for tests / telemetry).
  size(): number;
  /// Drop everything (e.g. when a document's in-memory state is re-seeded).
  clear(): void;
}

/// A Set with a hard cap — agent turns can emit hundreds of patches and the
/// set must not grow unboundedly across a long-lived server process or a
/// multi-hour browser session. Oldest keys are evicted FIFO.
export function createBoundedDedupSet(capacity = 4096): BoundedDedupSet {
  const set = new Set<string>();
  const queue: string[] = [];
  return {
    has(key) {
      return set.has(key);
    },
    add(key) {
      if (set.has(key)) return;
      set.add(key);
      queue.push(key);
      if (queue.length > capacity) {
        const evict = queue.shift();
        if (evict !== undefined) set.delete(evict);
      }
    },
    size() {
      return set.size;
    },
    clear() {
      set.clear();
      queue.length = 0;
    },
  };
}
