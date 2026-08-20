// .pen document tree helpers.
//
// Pure functions for walking / finding / mutating a .pen object tree.
// These are the low-level primitives the patch applier and the resolve
// engine build on. No React, no Node-only APIs — browser-safe.

import type { PenChild, PenDocument, PenRef } from './types';

// ---- Walk / find ----------------------------------------------------------

/**
 * Type guard for any node that can contain children. Includes the Figma
 * ontology container types added in Phase 1 (section, component,
 * component_set, boolean_operation) — earlier versions of walkTree / findNode
 * only descended into frames and groups, which caused components nested inside
 * component_sets to be invisible to the agent (e.g. swap_variant couldn't
 * locate a variant inside its set).
 */
function isContainer(node: PenChild): boolean {
  return (
    node.type === 'frame' ||
    node.type === 'group' ||
    node.type === 'section' ||
    node.type === 'component' ||
    node.type === 'component_set' ||
    node.type === 'boolean_operation'
  );
}

/** Depth-first walk; callback receives (node, parent, depth). */
export function walkTree(
  children: PenChild[],
  cb: (node: PenChild, parent: PenChild | null, depth: number) => void,
  parent: PenChild | null = null,
  depth = 0,
): void {
  for (const child of children) {
    cb(child, parent, depth);
    if (isContainer(child) && 'children' in child && Array.isArray(child.children)) {
      walkTree(child.children, cb, child, depth + 1);
    }
  }
}

/** Find a node by id anywhere in the tree. Returns undefined if not found. */
export function findNode(children: PenChild[], id: string): PenChild | undefined {
  for (const child of children) {
    if (child.id === id) return child;
    if (isContainer(child) && 'children' in child && Array.isArray(child.children)) {
      const found = findNode(child.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

/** Find the parent array containing a node with the given id. */
export function findNodeArray(
  children: PenChild[],
  id: string,
): { array: PenChild[]; index: number; parent: PenChild | null } | null {
  for (let i = 0; i < children.length; i++) {
    if (children[i].id === id) {
      return { array: children, index: i, parent: null };
    }
  }
  for (const child of children) {
    if (isContainer(child) && 'children' in child && Array.isArray(child.children)) {
      const found = findNodeArray(child.children, id);
      if (found) {
        return { ...found, parent: child };
      }
    }
  }
  return null;
}

/** Collect all reusable components (reusable: true) in the tree. */
export function collectComponents(children: PenChild[]): Map<string, PenChild> {
  const map = new Map<string, PenChild>();
  walkTree(children, (node) => {
    if (node.reusable === true) map.set(node.id, node);
  });
  return map;
}

// ---- Clone / mutate -------------------------------------------------------

/** Deep-clone a node (and its children). Assigns a fresh id by default. */
export function deepCloneNode(node: PenChild, newIds = true): PenChild {
  const clone: any = { ...node };
  if (newIds) clone.id = randomId();
  // Recurse into ANY container type's children (component, component_set,
  // section, boolean_operation — not just frame/group). Earlier versions
  // only descended into frame/group, which dropped children when cloning
  // a Component (so descendant overrides on instance had no target).
  if (isContainer(node) && 'children' in node && Array.isArray((node as { children?: unknown[] }).children)) {
    clone.children = ((node as { children: PenChild[] }).children).map((c) => deepCloneNode(c, newIds));
  }
  // Preserve original id mapping for descendant overrides: we tag each
  // cloned node with its source id so overrides (which reference source ids)
  // can still find the right descendant after cloning.
  (clone as { _sourceId?: string })._sourceId = node.id;
  return clone as PenChild;
}

/** Insert a node as a child of the given parent (or at root if parentId is null). */
export function insertNode(
  children: PenChild[],
  node: PenChild,
  parentId: string | null | undefined,
  index?: number,
): PenChild[] {
  if (!parentId) {
    const next = [...children];
    if (index === undefined || index < 0 || index > next.length) next.push(node);
    else next.splice(index, 0, node);
    return next;
  }
  return children.map((c) => {
    if (c.id === parentId && isContainer(c)) {
      const kids = [...((c as { children?: PenChild[] }).children ?? [])];
      if (index === undefined || index < 0 || index > kids.length) kids.push(node);
      else kids.splice(index, 0, node);
      return { ...c, children: kids };
    }
    if (isContainer(c) && 'children' in c && Array.isArray(c.children)) {
      return { ...c, children: insertNode(c.children, node, parentId, index) };
    }
    return c;
  });
}

/** Remove a node (and its subtree) by id. */
export function removeNode(children: PenChild[], id: string): PenChild[] {
  const filtered = children.filter((c) => c.id !== id);
  if (filtered.length !== children.length) return filtered;
  return children.map((c) => {
    if (isContainer(c) && 'children' in c && Array.isArray(c.children)) {
      const next = removeNode(c.children, id);
      if (next !== c.children) return { ...c, children: next };
    }
    return c;
  });
}

/** Move a node to a new parent / index. Returns new tree. */
export function moveNode(
  children: PenChild[],
  id: string,
  newParentId: string | null,
  newIndex?: number,
): PenChild[] {
  const found = findNodeArray(children, id);
  if (!found) return children;
  const node = found.array[found.index];
  // Don't allow moving a node into itself or its own descendant.
  if (newParentId && isDescendant(children, newParentId, id)) return children;
  const without = removeNode(children, id);
  return insertNode(without, node, newParentId, newIndex);
}

/** Is `descendantId` a descendant of `ancestorId`? */
export function isDescendant(children: PenChild[], descendantId: string, ancestorId: string): boolean {
  const ancestor = findNode(children, ancestorId);
  if (!ancestor || !isContainer(ancestor)) return false;
  return findNode((ancestor as { children?: PenChild[] }).children ?? [], descendantId) !== undefined;
}

/**
 * Compute the cumulative x/y offset from root to the node's PARENT — i.e. the
 * sum of every ancestor's stored relative x/y (NOT including the node itself).
 *
 * For a top-level node (parentId === null), this returns {x: 0, y: 0}.
 * For a nested node, it walks up the tree summing each ancestor's `x` and `y`.
 *
 * Used by the `reparent` and `ungroup` patch cases to remap a child's stored
 * relative coordinates when its parent changes — preserving the child's
 * absolute position on the canvas (Figma-hierarchy behavior).
 *
 * NOTE: this is a SIMPLIFIED offset — it ignores auto-layout (which would
 * reposition children based on the parent's flexbox settings) and rotation.
 * For documents that rely on auto-layout, the absolute-position preservation
 * is best-effort and may need a follow-up `pen_apply_auto_layout` call.
 */
export function getAncestorOffset(
  children: PenChild[],
  id: string,
): { x: number; y: number } {
  const found = findNodeArray(children, id);
  if (!found || !found.parent) return { x: 0, y: 0 };
  let offset = { x: 0, y: 0 };
  let current: PenChild | null = found.parent;
  // Walk up the parent chain, accumulating stored relative x/y of each ancestor.
  // Guard against cycles with a visited set (defensive — trees shouldn't cycle).
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    const cx = (current as { x?: unknown }).x;
    const cy = (current as { y?: unknown }).y;
    offset.x += typeof cx === 'number' ? cx : Number(cx) || 0;
    offset.y += typeof cy === 'number' ? cy : Number(cy) || 0;
    const parentFound = findNodeArray(children, current.id);
    current = parentFound?.parent ?? null;
  }
  return offset;
}

/**
 * Compute the absolute x/y of a node = sum of ancestor offsets + node's own
 * stored relative x/y. Convenience wrapper around `getAncestorOffset`.
 */
export function getAbsolutePosition(
  children: PenChild[],
  id: string,
): { x: number; y: number } {
  const node = findNode(children, id);
  if (!node) return { x: 0, y: 0 };
  const ancestorOffset = getAncestorOffset(children, id);
  const nx = (node as { x?: unknown }).x;
  const ny = (node as { y?: unknown }).y;
  return {
    x: ancestorOffset.x + (typeof nx === 'number' ? nx : Number(nx) || 0),
    y: ancestorOffset.y + (typeof ny === 'number' ? ny : Number(ny) || 0),
  };
}

/** Update a node's properties by id (immutable). */
export function updateNode(
  children: PenChild[],
  id: string,
  changes: Partial<PenChild>,
): PenChild[] {
  return children.map((c) => {
    if (c.id === id) return { ...c, ...changes, id: c.id } as PenChild;
    if ((c.type === 'frame' || c.type === 'group') && c.children) {
      const next = updateNode(c.children, id, changes);
      if (next !== c.children) return { ...c, children: next };
    }
    return c;
  });
}

// ---- Ref expansion --------------------------------------------------------

/**
 * Expand a `ref` node into a resolved subtree by deep-cloning the component
 * and applying `descendants` overrides.
 *
 * Overrides are keyed by slash-separated ID path (e.g. "ok-button/label").
 * Each override is either:
 *   - a property merge (no `type` key): the listed properties are applied.
 *   - a replacement (`type` key present): the descendant is fully replaced.
 *
 * The `descendants` map references the SOURCE ids (the component's ids), so
 * we tag each cloned node with `_sourceId` during clone to locate them.
 */
export function expandRef(
  ref: PenRef,
  components: Map<string, PenChild>,
): PenChild | null {
  const component = components.get(ref.ref);
  if (!component) return null;

  // Deep-clone the component tree, tagging each node with its source id.
  const clone = deepCloneNode(component, true);

  // Apply descendant overrides.
  if (ref.descendants) {
    applyDescendants(clone, ref.descendants);
  }

  // Apply direct root overrides from the ref node itself (x, y, fill, etc.).
  const rootOverride: any = { ...ref };
  delete rootOverride.type;
  delete rootOverride.ref;
  delete rootOverride.descendants;
  // IMPORTANT: preserve the ref's id on the clone root so the resolved tree's
  // root matches what the user placed. This is needed for selection, layers
  // panel highlighting, and instance-override patch ops (which target the
  // ref's id). The DESCENDANTS of the clone keep their fresh ids (which are
  // tagged with `_sourceId` so overrides can still locate them).
  // delete rootOverride.id;  ← removed; we want to keep the ref's id on the root.
  // Merge non-undefined root overrides onto the clone root.
  for (const [k, v] of Object.entries(rootOverride)) {
    if (v !== undefined) (clone as any)[k] = v;
  }

  // Tag the clone root with the source component id so the renderer /
  // layers / properties panels can show a "component instance (ref)" badge.
  (clone as any).componentId = ref.ref;

  return clone;
}

/** Apply a descendants map to a cloned subtree (in place). */
function applyDescendants(
  root: PenChild,
  descendants: { [idPath: string]: Partial<PenChild> },
): void {
  for (const [path, override] of Object.entries(descendants)) {
    // The path references source ids. Walk the cloned tree matching _sourceId.
    const segments = path.split('/');
    const target = findBySourcePath(root, segments);
    if (!target) continue;
    if ('type' in override && override.type) {
      // Full replacement: copy override fields onto the target node.
      Object.assign(target as any, override);
    } else {
      // Property merge.
      Object.assign(target as any, override);
    }
  }
}

/**
 * Find a node in a cloned subtree by following source-id segments.
 *
 * Used by `applyDescendants` to locate the descendant that an override
 * targets. The path is slash-separated source-ids (e.g. "ok-button/label"),
 * where each segment matches a cloned node's `_sourceId` (the original id
 * before deepCloneNode assigned a fresh one).
 *
 * This is a private helper for `expandRef` — not exported.
 */
function findBySourcePath(root: PenChild, segments: string[]): PenChild | null {
  if (segments.length === 0) return root;
  const [head, ...rest] = segments;
  // Match: current node's source id matches the head segment.
  if ((root as { _sourceId?: string })._sourceId === head) {
    if (rest.length === 0) return root;
    // Descend into children looking for the next segment.
    // Note: must descend into ALL container types (component, component_set,
    // section, boolean_operation) — not just frame/group. Earlier versions
    // only checked frame/group, which broke overrides on components.
    if (isContainer(root) && 'children' in root && Array.isArray(root.children)) {
      for (const child of root.children) {
        const found = findBySourcePath(child, rest);
        if (found) return found;
      }
    }
    return null;
  }
  // No match at this level — recurse into children to find the head.
  if (isContainer(root) && 'children' in root && Array.isArray(root.children)) {
    for (const child of root.children) {
      const found = findBySourcePath(child, segments);
      if (found) return found;
    }
  }
  return null;
}

// ---- Misc -----------------------------------------------------------------

function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Generate a fresh id (exposed for the patch layer). */
export function newId(): string {
  return randomId();
}
