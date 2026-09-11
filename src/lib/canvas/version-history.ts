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

import type { CanvasDocument, DesignTokens, Shape } from './types';
import { recomputeDerived } from './patch';

/// One named snapshot of the canvas. Newest-first in the store's
/// `checkpoints` array (index 0 = most recent).
export interface Checkpoint {
  id: string;
  label: string;
  /// Epoch ms.
  createdAt: number;
  /// true = captured automatically at an agent turn end; false = manual.
  auto: boolean;
  /// Document snapshot at capture time with the DERIVED caches stripped
  /// (see stripDerivedForSnapshot — 2026-09-08 perf, 12-d #14). The store's
  /// document is treated immutably, so the shared children/variables
  /// structure stays frozen; rehydrateSnapshot recomputes the caches on
  /// restore.
  document: CanvasDocument;
  /// Layer count at capture time (the dialog's "N layers" line — the
  /// stripped snapshot's shapes array is empty by design). Optional for
  /// legacy/test fixtures that construct Checkpoints literally.
  shapeCount?: number;
}

/// Max checkpoints kept. Oldest are dropped; index 0 (newest) always kept.
export const MAX_CHECKPOINTS = 50;

// ---- Snapshot pool memory (2026-09-08 perf, 12-d #14) -----------------------
//
// The store retains up to 150 full-document references at once (50
// checkpoints + 50 undoStack + 50 redoStack). Each retained document used to
// carry its DERIVED caches (`shapes` — an O(nodes) flat array produced by
// resolvePenTree — plus `tokens`); on a 20k-node canvas with many distinct
// turn-end states that duplicated cache graph alone was hundreds of MB,
// while the SOURCE tree (children/variables) is structurally shared across
// snapshots almost for free. The two helpers below strip the re-derivable
// caches at pool entry and recompute them at pool exit:
//
//   capture:  stripDerivedForSnapshot(liveDoc)     → checkpoint/undo/redo slot
//   promote:  rehydrateSnapshot(slot, bounds)      → live document
//
// Recompute cost on promote is one resolvePenTree — the same O(n) resolve a
// patch apply performs — paid once per explicit undo/redo/restore action,
// instead of retaining 150 × O(n) cache arrays permanently.

/// Shared empty derived caches for stripped snapshots — frozen so an
/// accidental in-place mutation fails loudly (documents are immutable by
/// discipline everywhere; nothing writes these fields, and recomputeDerived
/// REPLACES them rather than mutating).
const STRIPPED_SHAPES: Shape[] = Object.freeze([]) as unknown as Shape[];
const STRIPPED_TOKENS: DesignTokens = Object.freeze({ colors: [], textStyles: [] }) as unknown as DesignTokens;
const STRIPPED_BACKGROUND = '#f8fafc'; // default canvas background

/// Strip the derived caches from a document entering a snapshot pool
/// (checkpoints / undoStack / redoStack). The returned clone SHARES the
/// immutable children/variables/pages structure with the live document —
/// structural sharing is what makes retained snapshots cheap — and drops
/// only the re-derivable `shapes`/`tokens`/`background` caches.
/// 2026-09-11: Also strips `background` (derived from variables) to save
/// memory — it's recomputed by recomputeDerived on restore.
export function stripDerivedForSnapshot(doc: CanvasDocument): CanvasDocument {
  return { ...doc, shapes: STRIPPED_SHAPES, tokens: STRIPPED_TOKENS, background: STRIPPED_BACKGROUND };
}

/// Recompute the derived caches on a snapshot being promoted back to the
/// live document (undo / redo / restoreCheckpoint). Threads the store's
/// measuredBounds the same way applyPatchToCanvas does (spec §3.8 hints —
/// fit_content nodes pick up CURRENT measurements instead of stale ones). A
/// document that still carries populated caches (legacy fixtures, live
/// documents routed through by mistake) is returned unchanged.
export function rehydrateSnapshot(
  doc: CanvasDocument,
  measuredBounds?: Record<string, { width: number; height: number }>,
): CanvasDocument {
  if (doc.shapes && doc.shapes.length > 0) return doc;
  return recomputeDerived(doc, measuredBounds);
}

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
///
/// 2026-09-11: Enhanced to cover deep tree changes (depth ≤ 2) to detect
/// reparenting, deep restyles, and structural changes beyond the first 40 roots.
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

  // Deep tree hash (depth ≤ 2): catches reparenting, deep restyles, and
  // structural changes beyond the first 40 roots.
  let deepStamp = 0;
  const walkDeep = (nodes: any[], depth: number) => {
    if (depth > 2) return;
    for (const node of nodes) {
      if (!node) continue;
      const frag = `${node.id ?? ''}|${node.type ?? ''}|${node.fill ?? ''}|${node.name ?? ''}|${(node.children ?? []).length}`;
      for (let j = 0; j < frag.length; j++) {
        deepStamp = (deepStamp * 31 + frag.charCodeAt(j)) | 0;
      }
      if (Array.isArray(node.children) && node.children.length > 0) {
        walkDeep(node.children, depth + 1);
      }
    }
  };
  walkDeep(doc.children ?? [], 0);

  return `${doc.children?.length ?? 0}:${doc.shapes?.length ?? 0}:${JSON.stringify(doc.variables ?? {}).length}:${stamp}:${deepStamp}`;
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
