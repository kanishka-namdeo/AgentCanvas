// Version-history checkpoints (spec Phase 7 group C — defect D14).
//
// Figma Make's recoverable-writes model: every agent turn (and any manual
// ⌘⌥S save) captures a NAMED checkpoint of the whole canvas document, so
// the user can jump back to a labeled point in history without replaying
// the linear undo stack. Restoring is NEVER destructive — it first captures
// a "Before restore" checkpoint of the current state, then pushes the
// current document onto the undo stack (the same push sendPatch makes), so
// ⌘Z walks back out of a restore.
//
// Checkpoints live in the canvas store as EPHEMERAL state (the
// measuredBounds pattern): not persisted, not part of undo snapshots, and
// writing them never recomputes `document`.

import type { CanvasDocument } from './types';

/// One named snapshot of the canvas. Newest-first in the store's
/// `checkpoints` array (index 0 = most recent).
export interface Checkpoint {
  id: string;
  label: string;
  /// Epoch ms.
  createdAt: number;
  /// true = captured automatically at an agent turn end; false = manual.
  auto: boolean;
  /// Full document snapshot at capture time (stored by reference — the
  /// store's document is treated immutably, so the snapshot stays frozen).
  document: CanvasDocument;
}

/// Max checkpoints kept. Oldest are dropped; index 0 (newest) always kept.
export const MAX_CHECKPOINTS = 50;

/// Cheap change detector for "has the document changed since the last
/// checkpoint?" — a monotone-ish signature over the tree size, the derived
/// flat-shape cache and the variables map. Deliberately NOT a deep hash:
/// addCheckpoint uses it only to skip redundant captures of an unchanged
/// document; anything that changes node COUNT or the variables map (the
/// shapes of writes agents make between turns) invalidates it.
///
/// Audit 4 C16: the signature used to count nodes + variables LENGTH only —
/// a pure restyle turn (recolor 40 shapes, same counts) produced an identical
/// signature, so the auto-checkpoint at turn end was SKIPPED despite real
/// changes. A light content stamp (fills + text of the first 40 root nodes,
/// hashed into a number) catches property-only turns while staying O(roots).
export function checkpointSignature(doc: CanvasDocument): string {
  let stamp = 0;
  const roots = (doc.children ?? []).slice(0, 40);
  for (let i = 0; i < roots.length; i++) {
    const n = roots[i] as any;
    // Mix the properties turns actually restyle: fill, text, name, effects.
    const frag = `${n?.fill ?? ''}|${typeof n?.content === 'string' ? n.content.slice(0, 40) : ''}|${n?.name ?? ''}|${n?.effect ? 'e' : ''}`;
    for (let j = 0; j < frag.length; j++) {
      stamp = (stamp * 31 + frag.charCodeAt(j)) | 0;
    }
  }
  return `${doc.children?.length ?? 0}:${doc.shapes?.length ?? 0}:${JSON.stringify(doc.variables ?? {}).length}:${stamp}`;
}

/// New checkpoint id. crypto.randomUUID when available, fallback elsewhere
/// (older jsdom builds).
export function newCheckpointId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `cp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/// Tiny relative-time formatter for the Version History list ("just now",
/// "5m ago", "3h ago", "2d ago").
export function timeAgo(timestamp: number, now: number = Date.now()): string {
  const sec = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (sec < 10) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
