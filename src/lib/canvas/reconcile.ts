// Per-element document reconcile (R6) — the Excalidraw `reconcileElements`
// pattern ported to AgentCanvas's .pen tree.
//
// WHY: a `canvas:full` arrives on every subscribe/reconnect (and on
// `canvas:request_full`). The old handler REPLACED the local document
// wholesale (except the empty-incoming guard), so any local edit the server
// had not seen — offline edits, edits during a server restart, edits racing
// the reconnect — was silently clobbered. Research round 2 (Figma's
// "fresh copy + reapply", Excalidraw reconcile) converged on merging instead.
//
// HOW: every node carries `version` + `versionNonce` (bumped by
// `updateNode`/`insertNode` in pen/document.ts). Reconcile walks BOTH trees
// per level and resolves each element:
//
//   remote-only element      → take it (server has it, we don't)
//   local-only element       → keep it (unsynced local add — survives)
//   both                     → higher version wins; equal versions → lower
//                              nonce wins (deterministic tiebreak); equal
//                              version+nonce → identical lineage, keep local
//   local unversioned        → remote wins (pre-R6 docs: legacy replace
//                              semantics preserved per element)
//   remote unversioned,      → local wins (remote is a stale snapshot from
//   local versioned            before versioning existed / server rollback)
//
// Structure (parent/child placement, order): the INCOMING tree is the base —
// the server relay saw every applied patch and its ordering is the shared
// truth. A winning LOCAL element's VALUES are spliced into the incoming
// position; local-only elements append at the end of their level. Children of
// surviving elements reconcile recursively, so a locally-edited container
// never swallows elements another user added inside it.
//
// Known Phase-A limitation (documented in the research roadmap): without
// tombstones, an element deleted on the server but untouched locally is
// indistinguishable from a local-only add and is kept — deletions converge
// via the patch stream, not via reconcile. Tombstones + server-owned fold
// are Phase C (R2).
//
// The module is PURE (no store, no socket) so it tests like
// `dedupeLocalUpdates` — the repo's export-pure-logic-for-testability pattern.

import type { CanvasDocument } from './types';
import type { PenChild } from '../pen/types';
import { recomputeDerived } from './patch';

/// Does the LOCAL element win the per-element conflict resolution against
/// the incoming (server) copy? Exported for unit tests.
export function elementWins(
  local: { version?: unknown; versionNonce?: unknown },
  remote: { version?: unknown; versionNonce?: unknown },
): boolean {
  const lv = local.version;
  const rv = remote.version;
  if (typeof lv !== 'number') return false; // local has no lineage → remote wins (legacy semantics)
  if (typeof rv !== 'number') return true; // local versioned vs stale remote → local wins
  if (lv > rv) return true;
  if (lv < rv) return false;
  // Equal versions: deterministic nonce tiebreak (lower wins), missing nonce
  // = +Infinity so any concrete nonce beats it.
  const ln = typeof local.versionNonce === 'number' ? local.versionNonce : Number.POSITIVE_INFINITY;
  const rn = typeof remote.versionNonce === 'number' ? remote.versionNonce : Number.POSITIVE_INFINITY;
  if (ln === rn) return true; // identical lineage — keep local for reference stability
  return ln < rn;
}

function childrenOf(node: PenChild): PenChild[] | undefined {
  const kids = (node as { children?: unknown }).children;
  return Array.isArray(kids) ? (kids as PenChild[]) : undefined;
}

/// Merge one level of the tree. `incoming` provides the base order/placement;
/// local winners replace values in place; local-only elements are appended.
function reconcileLevel(incoming: PenChild[], local: PenChild[]): PenChild[] {
  if (incoming.length === 0) return local; // server has nothing here → keep local subtree (restart rollback guard)
  if (local.length === 0) return incoming; // nothing to merge → adopt server order
  const localById = new Map<string, PenChild>();
  for (const lk of local) localById.set(lk.id, lk);
  const result: PenChild[] = [];
  const consumed = new Set<string>();
  for (const ik of incoming) {
    const lk = localById.get(ik.id);
    if (!lk) {
      result.push(ik);
      continue;
    }
    consumed.add(ik.id);
    const winner = elementWins(lk, ik) ? lk : ik;
    // Recurse so a locally-edited container doesn't drop elements another
    // user added inside it (values may come from local, membership is the
    // union — additive by design until tombstones land in Phase C).
    const ikids = childrenOf(ik);
    const lkids = childrenOf(lk);
    if (ikids && lkids) {
      result.push({ ...winner, children: reconcileLevel(ikids, lkids) });
    } else {
      result.push(winner);
    }
  }
  for (const lk of local) {
    if (!consumed.has(lk.id)) result.push(lk); // local-only → keep (unsynced add)
  }
  return result;
}

/// Merge a full server document into the local one. Returns a NEW document
/// (inputs untouched). Doc-level fields (name/background/variables/themes/
/// viewport/pages) come from `incoming` — the same authority the old
/// wholesale-replace gave them; only the ELEMENT tree merges.
export function reconcileDocuments(
  local: CanvasDocument,
  incoming: CanvasDocument,
  measuredBounds?: Record<string, { width: number; height: number }>,
): CanvasDocument {
  const localChildren = local.children ?? [];
  const incomingChildren = incoming.children ?? [];
  const children = reconcileLevel(incomingChildren, localChildren);

  let merged: CanvasDocument = {
    ...incoming,
    id: local.id || incoming.id,
    children,
  };

  // D1 page write-back (same contract as applyPatchToCanvas): `doc.children`
  // mirrors `pages[activePageIndex].children` so page switches reload the
  // merged tree, not the stale incoming one.
  const activeIndex = merged.activePageIndex;
  if (merged.pages && activeIndex !== undefined && activeIndex >= 0 && activeIndex < merged.pages.length) {
    merged = {
      ...merged,
      pages: merged.pages.map((p, i) => (i === activeIndex ? { ...p, children } : p)),
    };
  }

  return recomputeDerived(merged, measuredBounds);
}
