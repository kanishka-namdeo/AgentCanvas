// .pen document tree helpers.
//
// Pure functions for walking / finding / mutating a .pen object tree.
// These are the low-level primitives the patch applier and the resolve
// engine build on. No React, no Node-only APIs — browser-safe.

import type {
  PenChild,
  PenDocument,
  PenRef,
  PenComponent,
  PenComponentSet,
  PenComponentPropertyDefinitions,
  PenComponentPropertyValues,
} from './types';

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

/** Random per-bump version tiebreaker (R6 reconcile). Fits in a JS integer
 * and needs no crypto — collisions merely fall through to "identical". */
function freshVersionNonce(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

/** Insert a node as a child of the given parent (or at root if parentId is null).
 * Stamps the node's sync version (1) + nonce (R6) unless it already carries
 * them (a re-inserted / moved node keeps its lineage — move is structural,
 * not a content mutation). */
export function insertNode(
  children: PenChild[],
  node: PenChild,
  parentId: string | null | undefined,
  index?: number,
): PenChild[] {
  const stamped: PenChild =
    (node as { version?: number }).version === undefined
      ? { ...node, version: 1, versionNonce: freshVersionNonce() }
      : node;
  if (!parentId) {
    const next = [...children];
    if (index === undefined || index < 0 || index > next.length) next.push(stamped);
    else next.splice(index, 0, stamped);
    return next;
  }
  return children.map((c) => {
    if (c.id === parentId && isContainer(c)) {
      const kids = [...((c as { children?: PenChild[] }).children ?? [])];
      if (index === undefined || index < 0 || index > kids.length) kids.push(stamped);
      else kids.splice(index, 0, stamped);
      return { ...c, children: kids };
    }
    if (isContainer(c) && 'children' in c && Array.isArray(c.children)) {
      return { ...c, children: insertNode(c.children, stamped, parentId, index) };
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

/** Update a node's properties by id (immutable).
 * Bumps the node's sync version + re-rolls its nonce (R6) — every
 * property change advances the element's reconcile lineage. Nodes from
 * pre-R6 documents (no version) gain one on their first update, which also
 * makes them start winning reconciles against stale versionless copies. */
export function updateNode(
  children: PenChild[],
  id: string,
  changes: Partial<PenChild>,
): PenChild[] {
  const bump = Object.keys(changes).length > 0;
  return children.map((c) => {
    if (c.id === id) {
      if (!bump) return c;
      const prevVersion = typeof c.version === 'number' ? c.version : 0;
      return {
        ...c,
        ...changes,
        id: c.id,
        version: prevVersion + 1,
        versionNonce: freshVersionNonce(),
      } as PenChild;
    }
    // Descend into ALL container types (section, component, component_set,
    // boolean_operation — matching walkTree/findNode/insertNode/removeNode).
    // Previously only frame/group descended, so update patches (fills,
    // constraints, theme, reparent coord remaps) silently no-opped on nodes
    // inside sections/components — caught by tests/unit/patch-edge-bugs.test.ts.
    if (isContainer(c) && 'children' in c && Array.isArray(c.children)) {
      const next = updateNode(c.children, id, changes);
      if (next !== c.children) return { ...c, children: next };
    }
    return c;
  });
}

// ---- Ref expansion --------------------------------------------------------

/**
 * Max nesting depth for recursive ref expansion (cycle protection).
 *
 * A component whose subtree transitively references itself (A → B → A) would
 * expand forever. Beyond this depth nested refs are left unexpanded — the
 * resolver maps leftover `ref` nodes to a plain rectangle, mirroring Figma's
 * cycle protection.
 */
const MAX_REF_DEPTH = 16;

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
 *
 * D3: nested refs are expanded RECURSIVELY. If the component's own subtree
 * contains a `ref` node (an instance of another component), that ref is
 * expanded too — cloned, its `descendants` overrides applied, fresh ids —
 * instead of surviving as a raw `ref` that the resolver would map to a
 * placeholder rectangle. Expansion is capped at MAX_REF_DEPTH and cut short
 * when a component transitively references itself (the ref is left as-is).
 */
export function expandRef(
  ref: PenRef,
  components: Map<string, PenChild>,
): PenChild | null {
  return expandRefAtDepth(ref, components, 0, new Set<string>());
}

/** Shared expansion core used by both the top-level ref and nested refs. */
function expandRefAtDepth(
  ref: PenRef,
  components: Map<string, PenChild>,
  depth: number,
  chain: Set<string>,
): PenChild | null {
  const component = components.get(ref.ref);
  if (!component) return null;

  // D2 VARIANT: a ref pointing at a COMPONENT_SET renders the child variant
  // selected by the instance's componentProperties (all provided axes must
  // match the child's variantPropertyValues). The ref target is rewritten to
  // the picked variant BEFORE cloning, keeping descendants overrides intact.
  let target: PenChild = component;
  if (component.type === 'component_set') {
    const picked = pickVariantChild(component, ref.componentProperties);
    if (picked) target = picked;
  }

  // Deep-clone the component tree, tagging each node with its source id.
  const clone = deepCloneNode(target, true);

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

  // D2: interpret the instance's componentProperties (BOOLEAN → descendant
  // `enabled`, TEXT → descendant `content`, INSTANCE_SWAP / SLOT → nested
  // ref target rewrite OR slot-location children replacement). Applied
  // AFTER descendants overrides so EXPLICIT per-instance overrides win
  // over property-driven writes (see `descendantOverrideSetsField`).
  // VARIANT was resolved by the retarget above.
  applyComponentProperties(clone, ref, target);

  // D3: recursively expand nested refs inside the cloned subtree. The nested
  // ref's own root overrides (id, x/y, any properties an outer instance
  // override landed on it) were merged above, so the expansion keeps the
  // clone's fresh id and stays addressable by `_sourceId`. INSTANCE_SWAP
  // rewrites (D2) also land here — the swapped nested ref expands against
  // its new target.
  if (isContainer(clone) && 'children' in clone && Array.isArray((clone as { children?: unknown }).children)) {
    const childChain = new Set(chain).add(ref.ref);
    (clone as { children: PenChild[] }).children =
      (clone as { children: PenChild[] }).children.map((c) => expandNestedRefs(c, components, depth + 1, childChain));
  }

  return clone;
}

/**
 * Walk a cloned subtree, expanding any nested `ref` nodes (D3).
 * Returns a new node when a replacement happened; the input node otherwise.
 */
function expandNestedRefs(
  node: PenChild,
  components: Map<string, PenChild>,
  depth: number,
  chain: Set<string>,
): PenChild {
  if (node.type === 'ref') {
    const nested = node as PenRef;
    // Cycle / depth guard: a component already on this expansion chain
    // (A → B → A) or a nesting depth beyond MAX_REF_DEPTH is left as a raw
    // `ref` — the resolver renders it as a plain rectangle (Figma-style
    // cycle protection).
    if (depth > MAX_REF_DEPTH || chain.has(nested.ref)) return node;
    const expanded = expandRefAtDepth(nested, components, depth, chain);
    // Unknown component id — leave the raw ref in place.
    if (!expanded) return node;
    return expanded;
  }
  if (isContainer(node) && 'children' in node && Array.isArray((node as { children?: unknown }).children)) {
    const children = (node as { children: PenChild[] }).children;
    if (children.length === 0) return node;
    return { ...node, children: children.map((c) => expandNestedRefs(c, components, depth, chain)) };
  }
  return node;
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

// ---- Component properties (D2 — spec Phase 2) -----------------------------
//
// Figma's component property model, mapped onto the .pen shapes that exist:
//   - DEFINITIONS live on the master COMPONENT (`componentPropertyDefinitions`,
//     keyed by property name — `set_component_property` writes them).
//   - VALUES live on the INSTANCE (`PenRef.componentProperties`, keyed by the
//     same names — `set_instance_property` writes them).
//   - The BINDING from a property name to a descendant node is IMPLICIT: the
//     first descendant (depth-first, excluding the root) whose source id or
//     name matches the property name (exact, then case/punctuation-insensitive)
//     is the target. e.g. boolean property "show-icon" toggles the descendant
//     named "show-icon".
//
// Property interpretation (applied during expandRef, AFTER descendants
// overrides — explicit per-instance overrides win, see
// `descendantOverrideSetsField`):
//   BOOLEAN       toggles the bound descendant's `enabled` (false → hidden)
//   TEXT          overrides the bound descendant's text `content`
//   INSTANCE_SWAP rewrites a bound descendant ref's `ref` target component id
//   VARIANT       (component_set refs only) swaps which child variant the ref
//                 renders — resolved BEFORE cloning in expandRefAtDepth
//   SLOT          marks an instance-swap LOCATION: rewrites a bound descendant
//                 ref's target OR replaces a bound container's children with
//                 a single new ref instance (preferredValues gates the swap)

/** Normalize a property name / node name for fuzzy binding: lowercase,
 *  alphanumerics only ("Show Icon" ≡ "show-icon" ≡ "showicon"). */
function normalizePropName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Find the descendant a component property is bound to: depth-first over
 *  the cloned subtree (root excluded), matching `_sourceId` or `name` against
 *  the property name (exact first, then normalized). */
function findBoundDescendant(root: PenChild, propertyName: string): PenChild | null {
  const walk = (nodes: PenChild[]): PenChild | null => {
    for (const n of nodes) {
      if ((n as { _sourceId?: string })._sourceId === propertyName || (n as { name?: string }).name === propertyName) {
        return n;
      }
      if (isContainer(n) && 'children' in n && Array.isArray((n as { children?: PenChild[] }).children)) {
        const found = walk((n as { children: PenChild[] }).children);
        if (found) return found;
      }
    }
    return null;
  };
  const kids = isContainer(root) && Array.isArray((root as { children?: PenChild[] }).children)
    ? (root as { children: PenChild[] }).children
    : [];
  const exact = walk(kids);
  if (exact) return exact;
  // Fuzzy pass: normalized name comparison.
  const norm = normalizePropName(propertyName);
  if (!norm) return null;
  const walkNorm = (nodes: PenChild[]): PenChild | null => {
    for (const n of nodes) {
      const name = (n as { name?: string }).name;
      if (typeof name === 'string' && normalizePropName(name) === norm) return n;
      if (isContainer(n) && 'children' in n && Array.isArray((n as { children?: PenChild[] }).children)) {
        const found = walkNorm((n as { children: PenChild[] }).children);
        if (found) return found;
      }
    }
    return null;
  };
  return walkNorm(kids);
}

/** Slash-joined source-id path from the cloned root down to `target`
 *  (the key format `ref.descendants` uses — e.g. "ok-button/label").
 *  Null when the target isn't in the subtree. */
function sourcePathOf(root: PenChild, target: PenChild): string | null {
  if (root === target) {
    return (root as { _sourceId?: string })._sourceId ?? root.id;
  }
  if (isContainer(root) && 'children' in root && Array.isArray((root as { children?: PenChild[] }).children)) {
    for (const child of (root as { children: PenChild[] }).children) {
      const found = sourcePathOf(child, target);
      if (found !== null) {
        const head = (root as { _sourceId?: string })._sourceId ?? root.id;
        return `${head}/${found}`;
      }
    }
  }
  return null;
}

/** Does an explicit `descendants` override on this target already set the
 *  given field? (Precedence: per-instance overrides win over
 *  property-driven writes — D2 applies AFTER overrides but skips fields the
 *  overrides explicitly set.) */
function descendantOverrideSetsField(ref: PenRef, root: PenChild, target: PenChild, field: string): boolean {
  const descendants = ref.descendants;
  if (!descendants) return false;
  const path = sourcePathOf(root, target);
  if (!path) return false;
  const override = descendants[path] as Record<string, unknown> | undefined;
  return !!override && field in override && override[field] !== undefined;
}

/** Text-bearing node types — TEXT properties only write `content` on these
 *  (or nodes that already carry a content field). */
function isTextBearingNode(node: PenChild): boolean {
  return (
    node.type === 'text' ||
    node.type === 'note' ||
    node.type === 'context' ||
    node.type === 'prompt' ||
    'content' in node
  );
}

/** Interpret a PenRef's componentProperties against the (already cloned +
 *  overridden) subtree. Mutates the clone in place. See the section header
 *  for the per-type semantics + precedence. */
function applyComponentProperties(clone: PenChild, ref: PenRef, component: PenChild): void {
  const values: PenComponentPropertyValues | undefined = ref.componentProperties;
  if (!values || Object.keys(values).length === 0) return;
  const defs = (component as PenComponent).componentPropertyDefinitions as PenComponentPropertyDefinitions | undefined;
  if (!defs) return; // no definitions on the master → nothing to interpret safely

  for (const [name, value] of Object.entries(values)) {
    const def = defs[name];
    if (!def) continue;
    switch (def.type) {
      case 'boolean': {
        const bound = findBoundDescendant(clone, name);
        if (!bound) break;
        if (descendantOverrideSetsField(ref, clone, bound, 'enabled')) break;
        (bound as { enabled?: boolean }).enabled = value === true || value === 'true';
        break;
      }
      case 'text': {
        const bound = findBoundDescendant(clone, name);
        if (!bound || typeof value !== 'string') break;
        if (!isTextBearingNode(bound)) break;
        if (descendantOverrideSetsField(ref, clone, bound, 'content')) break;
        (bound as { content?: string }).content = value;
        break;
      }
      case 'instance_swap': {
        const bound = findBoundDescendant(clone, name);
        if (!bound || bound.type !== 'ref') break;
        if (typeof value !== 'string' || value === '') break;
        if (descendantOverrideSetsField(ref, clone, bound, 'ref')) break;
        (bound as PenRef).ref = value;
        break;
      }
      case 'variant':
        // Handled at retarget time (expandRefAtDepth) for component_set refs.
        // A variant-typed property on a plain component has no set to pick
        // from — nothing to do here.
        break;
      case 'slot': {
        // SLOT marks an instance-swap LOCATION — a placeholder descendant
        // inside the component that gets replaced with an instance of the
        // swapped component when the SLOT property value is set on an
        // instance (Figma's SLOT property type, added 2024). See
        // docs/html-dom-renderer.md §5.6 + Appendix G.
        const bound = findBoundDescendant(clone, name);
        if (!bound) break;
        // Value must be a non-empty string — empty string means "slot is
        // empty", placeholder stays in place.
        if (typeof value !== 'string' || value === '') break;
        // preferredValues whitelist (when present) gates which component ids
        // may be dropped into the slot.
        if (def.preferredValues && !def.preferredValues.includes(value)) break;

        if (bound.type === 'ref') {
          // Bound descendant is already a ref — just rewrite its target
          // (same as instance_swap, simplest case). Precedence: an explicit
          // per-instance descendants override on `ref` wins.
          if (descendantOverrideSetsField(ref, clone, bound, 'ref')) break;
          (bound as PenRef).ref = value;
          break;
        }

        if (
          bound.type === 'frame' ||
          bound.type === 'group' ||
          bound.type === 'component' ||
          bound.type === 'section'
        ) {
          // Bound descendant is a container — the slot location. Replace
          // its `children` with a single new `PenRef` instance that fills
          // the container. The downstream `expandNestedRefs` walk expands
          // the new ref into a full subtree clone. Precedence: an explicit
          // per-instance descendants override on `children` wins.
          if (descendantOverrideSetsField(ref, clone, bound, 'children')) break;
          const container = bound as { children?: PenChild[]; width?: number; height?: number };
          const newRef: PenRef = {
            id: newId(),
            type: 'ref',
            ref: value,
            x: 0,
            y: 0,
          };
          // Fill the container's box; groups have no inherent size, so the
          // ref inherits natural sizing from the swapped component.
          if (typeof container.width === 'number') {
            (newRef as { width?: number }).width = container.width;
          }
          if (typeof container.height === 'number') {
            (newRef as { height?: number }).height = container.height;
          }
          container.children = [newRef];
          break;
        }

        // Text / shape / other node types — not a valid slot location.
        break;
      }
    }
  }
}

/** Pick the child variant of a component_set that matches the instance's
 *  componentProperties. When the set carries `componentPropertyDefinitions`,
 *  only 'variant'-typed properties drive the selection; otherwise every
 *  string-valued property is matched against each child's
 *  `variantPropertyValues` (ALL provided axes must match). Returns null when
 *  nothing matches (the ref then renders the set itself, as today). */
function pickVariantChild(
  set: PenComponentSet,
  props: PenComponentPropertyValues | undefined,
): PenComponent | null {
  if (!props) return null;
  const stringEntries = Object.entries(props).filter(([, v]) => typeof v === 'string') as Array<[string, string]>;
  if (stringEntries.length === 0) return null;
  const defs = (set as PenComponentSet & {
    componentPropertyDefinitions?: PenComponentPropertyDefinitions;
  }).componentPropertyDefinitions;
  const axes = defs
    ? stringEntries.filter(([name]) => defs[name]?.type === 'variant')
    : stringEntries;
  if (axes.length === 0) return null;
  const children = (set.children ?? []).filter(
    (c): c is PenComponent => c.type === 'component',
  ) as Array<PenComponent & { variantPropertyValues?: Record<string, string> }>;
  for (const child of children) {
    const vpv = child.variantPropertyValues;
    if (!vpv) continue;
    if (axes.every(([axis, value]) => vpv[axis] === value)) return child;
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
