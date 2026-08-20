// Pure canvas patching logic — now tree-aware (.pen aligned).
//
// The source of truth is `doc.children` (a .pen object tree). Patches mutate
// the tree (insert / update / remove / move / group / ungroup / reorder),
// then the derived `shapes` (resolved flat render list) and `tokens` (derived
// from `variables`) caches are recomputed via `resolvePenTree()`.
//
// Patch op names are kept stable so the existing tool surface keeps working
// during the canvas_* → pen_* rename. The `shape` payload accepts BOTH .pen
// node fields (cornerRadius, content, layout, gap, padding, …) AND legacy
// Shape fields (radius, text, autoLayout, …) — a normalizer maps legacy
// fields to their .pen equivalents before inserting into the tree.

import type { CanvasDocument, CanvasPatch, Shape, DesignTokens, ColorToken, TextStyleToken, Constraints } from './types';
import type { PenChild, PenVariableDef, PenTheme, PenRef, PenComponent, PenComponentSet, PenFrame } from '../pen/types';
import { resolvePenTree } from '../pen/resolve';
import { findNode, findNodeArray, insertNode, removeNode, updateNode, moveNode, deepCloneNode, newId, collectComponents, walkTree, getAncestorOffset, getAbsolutePosition, isDescendant, expandRef } from '../pen/document';

// ---- Helpers --------------------------------------------------------------

function num(v: unknown, def: number): number {
  if (v === null || v === undefined) return def;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : def;
}

function str(v: unknown, def: string): string {
  return v === null || v === undefined ? def : String(v);
}

/**
 * Normalize a (possibly legacy) shape partial into a .pen node partial.
 * Maps: radius → cornerRadius, text → content, autoLayout → layout/gap/...
 * keeps .pen-native fields (cornerRadius, content, layout, fill, stroke, …).
 */
function toPenNodePartial(input: Partial<Shape> & Record<string, unknown>): Partial<PenChild> & Record<string, unknown> {
  const out: Partial<PenChild> & Record<string, unknown> = {};

  // Direct .pen fields (pass through if present).
  // Also includes legacy Shape fields that .pen doesn't model natively
  // (locked, tokenBinding, maskId, points, closed, componentId) — these are
  // carried as opaque node properties so they survive the tree round-trip
  // and are surfaced on resolved Shapes by resolvePenTree.
  for (const k of ['id', 'name', 'type', 'x', 'y', 'width', 'height', 'rotation', 'opacity', 'fill', 'stroke', 'strokeWidth', 'strokeLinecap', 'strokeLinejoin', 'strokeAlignment', 'effect', 'reusable', 'theme', 'enabled', 'flipX', 'flipY', 'layoutPosition', 'metadata', 'layout', 'gap', 'padding', 'justifyContent', 'alignItems', 'layoutIncludeStroke', 'clip', 'placeholder', 'slot', 'content', 'fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'fontStyle', 'underline', 'lineHeight', 'textAlign', 'textAlignVertical', 'strikethrough', 'href', 'textGrowth', 'children', 'geometry', 'viewBox', 'fillRule', 'polygonCount', 'cornerRadius', 'innerRadius', 'startAngle', 'sweepAngle', 'library', 'icon', 'weight', 'scriptUri', 'inputs', 'ref', 'descendants', 'context', 'locked', 'tokenBinding', 'maskId', 'points', 'closed', 'componentId', 'src', 'constraints', 'label', 'collapsed', 'pointCount', 'booleanOperationType', 'exportSettings', 'componentPropertyDefinitions', 'componentProperties', 'variantPropertyAxes', 'variantPropertyValues', 'variantLayout']) {
    if (input[k] !== undefined) out[k] = input[k];
  }

  // Legacy → .pen field mappings.
  // visible → enabled (legacy Shape.visible maps to .pen Entity.enabled)
  if (input.visible !== undefined && input.enabled === undefined) {
    out.enabled = input.visible;
  }
  if (input.radius !== undefined && input.cornerRadius === undefined) {
    out.cornerRadius = num(input.radius, 0);
  }
  if (input.radii !== undefined && input.radii !== null) {
    const r = input.radii as any;
    out.cornerRadius = [num(r?.topLeft, 0), num(r?.topRight, 0), num(r?.bottomRight, 0), num(r?.bottomLeft, 0)];
  }
  if (input.text !== undefined && input.content === undefined) {
    out.content = String(input.text);
  }
  if (input.textColor !== undefined) {
    // textColor maps to fill on text nodes. We only set it if fill isn't already set.
    if (out.fill === undefined) out.fill = str(input.textColor, '#0f172a');
  }
  if (input.autoLayout !== undefined && input.layout === undefined) {
    const al = input.autoLayout as any;
    if (al) {
      out.layout = al.direction;
      out.gap = num(al.gap, 0);
      out.padding = num(al.padding, 0);
      out.justifyContent = al.alignX === 'max' ? 'end' : al.alignX === 'center' ? 'center' : 'start';
      out.alignItems = al.alignY === 'max' ? 'end' : al.alignY === 'center' ? 'center' : 'start';
    } else {
      out.layout = 'none';
    }
  }
  // Legacy gradient/shadow/blur → .pen fill/effect arrays. These take
  // precedence over a solid fill/effect (they're more specific) so the
  // gradient/shadow the tool set survives the tree round-trip.
  if (input.gradient) {
    out.fill = { type: 'gradient', gradientType: input.gradient.type, rotation: input.gradient.angle, colors: input.gradient.stops.map((s: any) => ({ color: s.color, position: s.offset })) };
  }
  if (input.shadow) {
    const s = input.shadow as any;
    out.effect = { type: 'shadow', shadowType: s.inset ? 'inner' : 'outer', offset: { x: s.x, y: s.y }, blur: s.blur, spread: s.spread ?? 0, color: s.color };
  }
  if (input.blur !== undefined && num(input.blur, 0) > 0) {
    out.effect = { type: 'blur', radius: num(input.blur, 0) };
  }
  // Points → path geometry (best-effort).
  if (input.points && out.geometry === undefined) {
    const pts = input.points as any[];
    out.geometry = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${num(p.x, 0)} ${num(p.y, 0)}`).join(' ') + (input.closed ? ' Z' : '');
  }
  if (input.src && out.fill === undefined) {
    out.fill = { type: 'image', url: String(input.src), mode: 'fill' };
  }
  // componentId is kept as a passthrough for the renderer's instance badge.
  if (input.componentId !== undefined) out.componentId = input.componentId;

  return out;
}

/** Derive the tokens view (colors + textStyles) from .pen variables. */
export function variablesToTokens(variables: { [key: string]: PenVariableDef } | undefined): DesignTokens {
  const colors: ColorToken[] = [];
  const textStyles: TextStyleToken[] = [];
  if (!variables) return { colors, textStyles };
  for (const [key, def] of Object.entries(variables)) {
    const rawValue = Array.isArray(def.value) ? (def.value[0] as any)?.value : def.value;
    if (rawValue === undefined) continue;
    if (def.type === 'color' && typeof rawValue === 'string') {
      colors.push({ name: key, key, value: rawValue });
    } else if (def.type === 'number' && typeof rawValue === 'number' && key.startsWith('text.')) {
      const styleKey = key.split('.').slice(1, -1).join('.') || key;
      textStyles.push({ name: styleKey, key: styleKey, fontSize: rawValue, fontWeight: 400, lineHeight: 1.5, color: '#0f172a' });
    }
  }
  return { colors, textStyles };
}

/** Derive the canvas background from the `canvas.background` variable. */
function backgroundFromVariables(variables: { [key: string]: PenVariableDef } | undefined): string {
  const v = variables?.['canvas.background'];
  if (!v) return '#f8fafc';
  const raw = Array.isArray(v.value) ? (v.value[0] as any)?.value : v.value;
  return typeof raw === 'string' ? raw : '#f8fafc';
}

/** Recompute the derived caches (shapes + tokens + background) after a tree mutation. */
function recomputeDerived(doc: CanvasDocument): CanvasDocument {
  return {
    ...doc,
    shapes: resolvePenTree(doc),
    tokens: variablesToTokens(doc.variables),
    background: backgroundFromVariables(doc.variables),
  };
}

// ---- The patch applier ----------------------------------------------------

export function applyPatchToCanvas(canvas: CanvasDocument, patch: CanvasPatch): CanvasDocument {
  // Clone the tree + variables immutably; derived caches recomputed at the end.
  // Defensive: legacy docs / test fixtures may omit `children` — treat as empty tree.
  const next: CanvasDocument = {
    ...canvas,
    children: (canvas.children ?? []).map((c) => ({ ...c })),
    variables: canvas.variables ? { ...canvas.variables } : undefined,
    themes: canvas.themes ? { ...canvas.themes } : undefined,
    viewport: { ...canvas.viewport },
  };

  switch (patch.op) {
    case 'add': {
      if (!patch.shape) break;
      const partial = toPenNodePartial(patch.shape);
      const node = normalizeToNode(partial, patch.shapeId ?? partial.id ?? newId());
      next.children = insertNode(next.children, node, (patch.shape as any).parentId ?? null);
      break;
    }
    case 'bulk_add': {
      if (!patch.shapes || patch.shapes.length === 0) break;
      for (const partial of patch.shapes) {
        const penPartial = toPenNodePartial(partial);
        const node = normalizeToNode(penPartial, partial.id ?? newId());
        next.children = insertNode(next.children, node, (partial as any).parentId ?? null);
      }
      break;
    }
    case 'update': {
      if (!patch.shapeId) break;
      const penPartial = toPenNodePartial(patch.shape ?? {});
      next.children = updateNode(next.children, patch.shapeId, penPartial);
      break;
    }
    case 'update_many': {
      if (!patch.updates) break;
      for (const u of patch.updates) {
        const penPartial = toPenNodePartial(u.changes);
        next.children = updateNode(next.children, u.id, penPartial);
      }
      break;
    }
    case 'remove': {
      const ids = new Set(patch.shapeIds ?? (patch.shapeId ? [patch.shapeId] : []));
      for (const id of ids) {
        next.children = removeNode(next.children, id);
      }
      break;
    }
    case 'duplicate': {
      const ids = new Set(patch.shapeIds ?? []);
      for (const id of ids) {
        const node = findNode(next.children, id);
        if (node) {
          const clone = deepCloneNode(node, true);
          // Offset the clone so it doesn't overlap.
          (clone as any).x = num((clone as any).x, 0) + 24;
          (clone as any).y = num((clone as any).y, 0) + 24;
          (clone as any).name = `${(clone as any).name ?? 'Shape'} copy`;
          next.children = insertNode(next.children, clone, (node as any).parentId ?? null);
        }
      }
      break;
    }
    case 'clear': {
      next.children = [];
      break;
    }
    case 'background': {
      if (patch.background) {
        if (!next.variables) next.variables = {};
        next.variables['canvas.background'] = { type: 'color', value: patch.background };
      }
      break;
    }
    case 'group': {
      const ids = new Set(patch.shapeIds ?? []);
      if (ids.size === 0) break;
      // Compute bounding box of the targets (in absolute coords).
      const targets = (resolvePenTree(next)).filter((s) => ids.has(s.id));
      if (targets.length === 0) break;
      const minX = Math.min(...targets.map((s) => s.x));
      const minY = Math.min(...targets.map((s) => s.y));
      const maxX = Math.max(...targets.map((s) => s.x + s.width));
      const maxY = Math.max(...targets.map((s) => s.y + s.height));
      const groupId = patch.groupId ?? newId();
      const groupNode: PenChild = {
        id: groupId,
        type: 'group',
        name: 'Group',
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
        children: [],
      } as PenChild;
      // Insert the group at root FIRST, then move each target under it.
      // (moveNode needs the group to exist in the tree to find it as a parent.)
      next.children = insertNode(next.children, groupNode, null);
      for (const id of ids) {
        next.children = moveNode(next.children, id, groupId);
      }
      break;
    }
    case 'ungroup': {
      // Dissolve one or more frames/groups. Children are promoted to the
      // group's parent (grandparent of children) — NOT to root — preserving
      // the sibling order the group occupied.
      //
      // COORDINATE REMAP (Figma-style): each child's stored x/y is relative
      // to the group's content origin. When promoted to the grandparent, the
      // child's new stored x/y must become relative to the grandparent = the
      // group's own stored x/y + the child's stored x/y. Without this remap,
      // children would visually jump to a different spot after ungroup.
      const ids = new Set(patch.shapeIds ?? []);
      for (const id of ids) {
        const groupFound = findNodeArray(next.children, id);
        if (!groupFound) continue;
        const group = groupFound.array[groupFound.index];
        if (!group || (group.type !== 'frame' && group.type !== 'group') || !group.children) continue;
        const groupParent = groupFound.parent;
        const groupX = num((group as any).x, 0);
        const groupY = num((group as any).y, 0);
        // Build remapped children copies (so we don't mutate the original nodes).
        const remapped = group.children.map((c) => ({
          ...c,
          x: num((c as any).x, 0) + groupX,
          y: num((c as any).y, 0) + groupY,
        })) as PenChild[];
        // Insert each remapped child at the group's slot in the grandparent's
        // children array (or at root if the group was top-level).
        for (let i = 0; i < remapped.length; i++) {
          next.children = insertNode(
            next.children,
            remapped[i],
            groupParent ? groupParent.id : null,
            groupFound.index + i,
          );
        }
        // Finally remove the group itself.
        next.children = removeNode(next.children, id);
      }
      break;
    }
    case 'align': {
      // Manual alignment: operates on absolute positions. We translate the
      // resolved positions back into relative x/y on each node.
      const ids = patch.shapeIds ?? [];
      if (ids.length < 2) break;
      const resolved = resolvePenTree(next);
      const targets = resolved.filter((s) => ids.includes(s.id));
      if (targets.length < 2) break;
      const kind = patch.alignKind ?? 'left';
      const updates: Array<{ id: string; newX?: number; newY?: number }> = [];
      switch (kind) {
        case 'left': { const m = Math.min(...targets.map((s) => s.x)); for (const t of targets) updates.push({ id: t.id, newX: m }); break; }
        case 'right': { const m = Math.max(...targets.map((s) => s.x + s.width)); for (const t of targets) updates.push({ id: t.id, newX: m - t.width }); break; }
        case 'center_h': { const m = targets.reduce((a, s) => a + s.x + s.width / 2, 0) / targets.length; for (const t of targets) updates.push({ id: t.id, newX: m - t.width / 2 }); break; }
        case 'top': { const m = Math.min(...targets.map((s) => s.y)); for (const t of targets) updates.push({ id: t.id, newY: m }); break; }
        case 'bottom': { const m = Math.max(...targets.map((s) => s.y + s.height)); for (const t of targets) updates.push({ id: t.id, newY: m - t.height }); break; }
        case 'center_v': { const m = targets.reduce((a, s) => a + s.y + s.height / 2, 0) / targets.length; for (const t of targets) updates.push({ id: t.id, newY: m - t.height / 2 }); break; }
        case 'distribute_h': {
          const sorted = [...targets].sort((a, b) => a.x - b.x);
          if (sorted.length < 3) break;
          const first = sorted[0], last = sorted[sorted.length - 1];
          const span = (last.x + last.width) - first.x;
          const totalW = sorted.reduce((a, s) => a + s.width, 0);
          const gap = (span - totalW) / (sorted.length - 1);
          let cur = first.x;
          for (const s of sorted) { updates.push({ id: s.id, newX: cur }); cur += s.width + gap; }
          break;
        }
        case 'distribute_v': {
          const sorted = [...targets].sort((a, b) => a.y - b.y);
          if (sorted.length < 3) break;
          const first = sorted[0], last = sorted[sorted.length - 1];
          const span = (last.y + last.height) - first.y;
          const totalH = sorted.reduce((a, s) => a + s.height, 0);
          const gap = (span - totalH) / (sorted.length - 1);
          let cur = first.y;
          for (const s of sorted) { updates.push({ id: s.id, newY: cur }); cur += s.height + gap; }
          break;
        }
      }
      for (const u of updates) {
        const node = findNode(next.children, u.id);
        if (node) {
          if (u.newX !== undefined) (node as any).x = u.newX;
          if (u.newY !== undefined) (node as any).y = u.newY;
        }
      }
      break;
    }
    case 'tokens':
    case 'set_variable': {
      if (patch.op === 'tokens' && patch.tokens?.colors) {
        if (!next.variables) next.variables = {};
        for (const c of patch.tokens.colors) {
          next.variables[c.key] = { type: 'color', value: c.value };
        }
      }
      if (patch.op === 'tokens' && patch.tokens?.textStyles) {
        if (!next.variables) next.variables = {};
        for (const t of patch.tokens.textStyles) {
          next.variables[`text.${t.key}.fontSize`] = { type: 'number', value: t.fontSize };
          next.variables[`text.${t.key}.color`] = { type: 'color', value: t.color };
        }
      }
      if (patch.op === 'set_variable' && patch.variableKey) {
        if (!next.variables) next.variables = {};
        const val = patch.variableValue;
        if (Array.isArray(val)) {
          next.variables[patch.variableKey] = {
            type: patch.variableType ?? 'color',
            value: val.map((v) => ({ value: v.value, theme: v.theme })) as any,
          } as PenVariableDef;
        } else {
          next.variables[patch.variableKey] = {
            type: patch.variableType ?? (typeof val === 'number' ? 'number' : 'color'),
            value: val as any,
          } as PenVariableDef;
        }
      }
      break;
    }
    case 'set_theme_axis': {
      if (!patch.themeAxis || !patch.themeValues) break;
      if (!next.themes) next.themes = {};
      next.themes[patch.themeAxis] = patch.themeValues;
      break;
    }
    case 'set_node_theme': {
      if (!patch.shapeId || !patch.theme) break;
      const node = findNode(next.children, patch.shapeId);
      if (node) {
        next.children = updateNode(next.children, patch.shapeId, { theme: patch.theme } as Partial<PenChild>);
      }
      break;
    }
    case 'mark_slot': {
      if (!patch.shapeId) break;
      const node = findNode(next.children, patch.shapeId);
      if (node && node.type === 'frame') {
        next.children = updateNode(next.children, patch.shapeId, { slot: patch.slotComponents ?? [] } as Partial<PenChild>);
      }
      break;
    }
    case 'reparent': {
      // Move a node to a new parent. Figma-hierarchy semantics:
      //   - newParentId null/empty → root (top-level).
      //   - Default (keepAbsolutePosition=true): remap the node's stored
      //     relative x/y so its ABSOLUTE position on the canvas is unchanged.
      //   - Cannot move a node into itself or one of its own descendants.
      if (!patch.shapeId) break;
      const newParentId =
        patch.newParentId === undefined || patch.newParentId === '' || patch.newParentId === null
          ? null
          : patch.newParentId;
      const node = findNode(next.children, patch.shapeId);
      if (!node) break;
      // Reject moving into self or a descendant (would create a cycle).
      if (newParentId && (newParentId === patch.shapeId || isDescendant(next.children, newParentId, patch.shapeId))) {
        break;
      }
      // If the new parent is a leaf (rectangle/ellipse/text/etc.), bail.
      if (newParentId) {
        const newParent = findNode(next.children, newParentId);
        if (!newParent || (newParent.type !== 'frame' && newParent.type !== 'group')) break;
      }
      // Coordinate remap to preserve absolute position.
      //
      // The node's stored x/y is RELATIVE to its parent's content origin. To
      // preserve the node's ABSOLUTE position across the reparent, we need:
      //   new_node.x = old_absolute - new_parent_absolute
      //
      // where old_absolute = getAbsolutePosition(node) = (old ancestor offset) + node.x
      // and   new_parent_absolute = getAbsolutePosition(new_parent) = (new ancestor offset) + parent.x
      //       (or {0,0} if reparenting to root).
      //
      // Without this remap, the node would visually jump because its stored
      // relative coords would be reinterpreted against a different parent's
      // coordinate system.
      if (patch.keepAbsolutePosition !== false) {
        const oldAbsolute = getAbsolutePosition(next.children, patch.shapeId);
        const newParentAbsolute = newParentId ? getAbsolutePosition(next.children, newParentId) : { x: 0, y: 0 };
        const newX = oldAbsolute.x - newParentAbsolute.x;
        const newY = oldAbsolute.y - newParentAbsolute.y;
        next.children = updateNode(next.children, patch.shapeId, { x: newX, y: newY } as Partial<PenChild>);
      }
      next.children = moveNode(next.children, patch.shapeId, newParentId, patch.index);
      break;
    }
    case 'set_constraints': {
      // Set Figma-style layout constraints on a child node. Stored as an opaque
      // property on the .pen node; survives the tree round-trip and is surfaced
      // on resolved Shapes by resolvePenTree so the Properties panel can edit it
      // and the agent can reason about responsive behavior.
      if (!patch.shapeId) break;
      const constraints: Constraints | null = patch.constraints ?? null;
      next.children = updateNode(next.children, patch.shapeId, { constraints } as Partial<PenChild>);
      break;
    }
    case 'select': {
      // UI-only — no document mutation.
      break;
    }
    case 'zorder': {
      const ids = new Set(patch.shapeIds ?? (patch.shapeId ? [patch.shapeId] : []));
      if (ids.size === 0) break;
      const kind = patch.zorderKind ?? 'front';
      // Operate per-parent: for each unique parent of the targets, reorder
      // within that parent's children array.
      const resolved = resolvePenTree(next);
      const targets = resolved.filter((s) => ids.has(s.id));
      const parents = new Set(targets.map((t) => t.parentId ?? null));
      for (const parentId of parents) {
        const found = findNodeArray(next.children, targets.find((t) => (t.parentId ?? null) === parentId)!.id);
        if (!found) continue;
        const siblings = [...found.array];
        let newOrder: PenChild[];
        if (kind === 'front') {
          const movers = siblings.filter((s) => ids.has(s.id));
          const rest = siblings.filter((s) => !ids.has(s.id));
          newOrder = [...rest, ...movers];
        } else if (kind === 'back') {
          const movers = siblings.filter((s) => ids.has(s.id));
          const rest = siblings.filter((s) => !ids.has(s.id));
          newOrder = [...movers, ...rest];
        } else if (kind === 'forward') {
          // Move each mover one position toward the end (swap with next non-mover).
          newOrder = [...siblings];
          for (let i = newOrder.length - 2; i >= 0; i--) {
            if (ids.has(newOrder[i].id) && !ids.has(newOrder[i + 1].id)) {
              [newOrder[i], newOrder[i + 1]] = [newOrder[i + 1], newOrder[i]];
            }
          }
        } else {
          // backward: move each mover one position toward the start.
          newOrder = [...siblings];
          for (let i = 1; i < newOrder.length; i++) {
            if (ids.has(newOrder[i].id) && !ids.has(newOrder[i - 1].id)) {
              [newOrder[i], newOrder[i - 1]] = [newOrder[i - 1], newOrder[i]];
            }
          }
        }
        // Replace the siblings array in the tree.
        next.children = replaceSiblings(next.children, found.array, newOrder);
      }
      break;
    }
    case 'reorder': {
      if (!patch.shapeId || patch.zIndex === undefined) break;
      const found = findNodeArray(next.children, patch.shapeId);
      if (!found) break;
      const siblings = [...found.array];
      const idx = siblings.findIndex((s) => s.id === patch.shapeId);
      if (idx < 0) break;
      const [node] = siblings.splice(idx, 1);
      const target = Math.max(0, Math.min(patch.zIndex, siblings.length));
      siblings.splice(target, 0, node);
      next.children = replaceSiblings(next.children, found.array, siblings);
      break;
    }
    case 'viewport': {
      if (patch.viewport) next.viewport = patch.viewport;
      break;
    }
    case 'undo':
    case 'redo': {
      // Handled by the store (needs undo/redo stacks). No-op here.
      break;
    }
    // ---- Figma ontology ops (Phase 1) ----
    case 'add_page': {
      const pageName = patch.pageName ?? `Page ${(next.pages?.length ?? 1) + 1}`;
      const pageId = crypto.randomUUID();
      const newPage = {
        id: pageId,
        name: pageName,
        children: [] as PenChild[],
        viewport: { zoom: 1, panX: 120, panY: 80 },
      };
      next.pages = [...(next.pages ?? []), newPage];
      next.activePageIndex = next.pages.length - 1;
      next.children = [];
      break;
    }
    case 'delete_page': {
      if (!next.pages || next.pages.length <= 1) break;
      const idx = findPageIndex(next.pages, patch);
      if (idx < 0) break;
      next.pages = next.pages.filter((_, i) => i !== idx);
      if ((next.activePageIndex ?? 0) >= next.pages.length) {
        next.activePageIndex = next.pages.length - 1;
      }
      const active = next.pages[next.activePageIndex ?? 0];
      next.children = active?.children ?? [];
      break;
    }
    case 'rename_page': {
      if (!next.pages) break;
      const idx = findPageIndex(next.pages, patch);
      if (idx < 0) break;
      next.pages = next.pages.map((p, i) =>
        i === idx ? { ...p, name: patch.pageName ?? p.name } : p,
      );
      break;
    }
    case 'set_active_page': {
      if (!next.pages) break;
      const idx = findPageIndex(next.pages, patch);
      if (idx < 0) break;
      next.activePageIndex = idx;
      const active = next.pages[idx];
      next.children = active.children;
      if (active.viewport) next.viewport = active.viewport;
      break;
    }
    case 'add_section': {
      if (patch.shape && patch.shape.label && !patch.shape.name) {
        patch.shape.name = patch.shape.label;
      }
      next.children = insertNodeFromPatch(next.children, patch);
      break;
    }
    case 'create_component': {
      next.children = insertNodeFromPatch(next.children, patch);
      break;
    }
    case 'create_component_set': {
      if (!patch.shape) break;
      (patch.shape as Record<string, unknown>).variantPropertyAxes = patch.variantPropertyAxes;
      next.children = insertNodeFromPatch(next.children, patch);
      break;
    }
    case 'add_variant': {
      if (!patch.shape) break;
      (patch.shape as Record<string, unknown>).variantPropertyValues = patch.variantPropertyValues;
      next.children = insertNodeFromPatch(next.children, patch);
      break;
    }
    case 'set_component_property': {
      if (!patch.shapeId || !patch.componentProperty) break;
      const node = findNode(next.children, patch.shapeId);
      if (!node || node.type !== 'component') break;
      const existingDefs = (node as { componentPropertyDefinitions?: Record<string, unknown> }).componentPropertyDefinitions ?? {};
      const updatedDefs = {
        ...existingDefs,
        [patch.componentProperty.name]: {
          type: patch.componentProperty.type,
          defaultValue: patch.componentProperty.defaultValue,
          preferredValues: patch.componentProperty.preferredValues,
          variantOptions: patch.componentProperty.variantOptions,
        },
      };
      next.children = updateNode(next.children, patch.shapeId, {
        componentPropertyDefinitions: updatedDefs,
      } as Partial<PenChild>);
      break;
    }
    case 'set_instance_property': {
      if (!patch.shapeId || !patch.instancePropertyName) break;
      const node = findNode(next.children, patch.shapeId);
      if (!node || node.type !== 'ref') break;
      const ref = node as unknown as {
        componentProperties?: Record<string, boolean | string>;
      };
      const updated = {
        ...(ref.componentProperties ?? {}),
        [patch.instancePropertyName]: patch.instancePropertyValue ?? '',
      };
      next.children = updateNode(next.children, patch.shapeId, {
        componentProperties: updated,
      } as Partial<PenChild>);
      break;
    }

    // ===== Figma component-system ops (Phase 2 — Components & Design Systems) =====

    case 'convert_to_component': {
      // Promote an existing frame/group/shape into a reusable Component node.
      // Figma behavior: select a frame → "Create Component" (⌘⇧O / Ctrl+Shift+O).
      // The frame's type changes from 'frame' to 'component', and `reusable=true`
      // is set so it can be referenced by PenRef instances.
      if (!patch.shapeId) break;
      const node = findNode(next.children, patch.shapeId);
      if (!node) break;
      // Only frames, groups, and shape nodes can be promoted (not refs/instances).
      const promotableTypes = ['frame', 'group', 'rectangle', 'ellipse', 'text', 'line', 'path'];
      if (!promotableTypes.includes(node.type)) break;
      const newComp: Partial<PenComponent> = {
        type: 'component',
        reusable: true,
        // Preserve the existing name (or default to "Component").
        name: (node as { name?: string }).name ?? 'Component',
      };
      // Carry over any component property definitions if provided.
      if (patch.componentProperty) {
        const existingDefs = (node as { componentPropertyDefinitions?: Record<string, unknown> }).componentPropertyDefinitions ?? {};
        newComp.componentPropertyDefinitions = {
          ...existingDefs,
          [patch.componentProperty.name]: {
            type: patch.componentProperty.type,
            defaultValue: patch.componentProperty.defaultValue,
            preferredValues: patch.componentProperty.preferredValues,
            variantOptions: patch.componentProperty.variantOptions,
          },
        } as PenComponent['componentPropertyDefinitions'];
      }
      next.children = updateNode(next.children, patch.shapeId, newComp as Partial<PenChild>);
      break;
    }

    case 'place_instance': {
      // Create a proper PenRef (linked instance) pointing at a reusable component.
      // This replaces the legacy pen_instantiate_component tool which only copied.
      // Figma behavior: drag a component from the Assets panel → drops an instance.
      if (!patch.componentId) break;
      const components = collectComponents(next.children);
      const src = components.get(patch.componentId);
      if (!src) break;
      const id = patch.shapeId ?? newId();
      const x = num(patch.shape?.x, 0);
      const y = num(patch.shape?.y, 0);
      const refNode: PenRef = {
        id,
        type: 'ref',
        ref: patch.componentId,
        name: (patch.shape?.name as string) ?? `${(src as { name?: string }).name ?? 'Component'} instance`,
        x,
        y,
        // Initial component property values come from the patch's instancePropertyValue
        // (rarely used here — usually set via a subsequent set_instance_property call).
        ...(patch.shape as Record<string, unknown>),
      };
      // Strip fields that shouldn't be on a ref.
      delete (refNode as Record<string, unknown>).width;
      delete (refNode as Record<string, unknown>).height;
      delete (refNode as Record<string, unknown>).fill;
      delete (refNode as Record<string, unknown>).stroke;
      // If parentId specified, insert under that parent; else at root.
      const parentId = (patch.shape as { parentId?: string | null })?.parentId;
      if (parentId) {
        next.children = insertUnderParent(next.children, refNode as PenChild, parentId);
      } else {
        next.children = [...next.children, refNode as PenChild];
      }
      break;
    }

    case 'set_instance_override': {
      // Override a descendant property on a PenRef.
      // Figma behavior: select an instance → edit text/fill/stroke in the right panel.
      // Stored on ref.descendants[path] = { ...partialNode }.
      if (!patch.shapeId || !patch.descendantPath || !patch.override) break;
      const node = findNode(next.children, patch.shapeId);
      if (!node || node.type !== 'ref') break;
      const ref = node as unknown as PenRef;
      const descendants = { ...(ref.descendants ?? {}) };
      const path = patch.descendantPath;
      // Normalize the override: map legacy Shape fields to .pen field names
      // (e.g. `text` → `content`, `textColor` → `fill` for text nodes).
      // This lets agent tools + the UI use Figma-style field names while the
      // .pen tree stays spec-compliant.
      const normalizedOverride = normalizeOverride(patch.override);
      // Merge with any existing override at the same path.
      const existing = descendants[path];
      descendants[path] = { ...(existing ?? {}), ...normalizedOverride } as Partial<PenChild>;
      next.children = updateNode(next.children, patch.shapeId, {
        descendants,
      } as Partial<PenChild>);
      break;
    }

    case 'reset_instance': {
      // Clear ALL overrides on a PenRef — re-sync from the main component.
      // Figma behavior: right-click instance → "Reset Instance" or "Reset Overrides".
      if (!patch.shapeId) break;
      const node = findNode(next.children, patch.shapeId);
      if (!node || node.type !== 'ref') break;
      next.children = updateNode(next.children, patch.shapeId, {
        descendants: undefined,
        componentProperties: undefined,
      } as Partial<PenChild>);
      break;
    }

    case 'detach_instance': {
      // Convert a PenRef into a standalone frame (break the link to the main component).
      // Figma behavior: right-click instance → "Detach Instance".
      // The resolved tree (with overrides applied) becomes a regular frame subtree.
      if (!patch.shapeId) break;
      const node = findNode(next.children, patch.shapeId);
      if (!node || node.type !== 'ref') break;
      const ref = node as unknown as PenRef;
      const components = collectComponents(next.children);
      const expanded = expandRef(ref, components);
      if (!expanded) break;
      // The expanded clone has a fresh id; preserve the original instance id so
      // the layers panel / selections keep their selection.
      (expanded as { id: string }).id = patch.shapeId;
      // Replace the ref with the expanded subtree in its parent array.
      next.children = replaceNodeInTree(next.children, patch.shapeId, expanded);
      break;
    }

    case 'combine_as_variants': {
      // Wrap multiple Component nodes into a ComponentSet (variants).
      // Figma behavior: select multiple components → "Combine as Variants".
      // The variant axes are auto-derived from the component names
      // (Figma naming: "Property1=Value, Property2=Value") if not specified.
      if (!patch.componentIds?.length) break;
      const ids = patch.componentIds;
      // Collect the components and remove them from their current location.
      const collected: PenChild[] = [];
      let workingChildren = next.children;
      for (const id of ids) {
        const node = findNode(workingChildren, id);
        if (!node || node.type !== 'component') break;
        collected.push(node);
        // Remove from tree.
        workingChildren = removeFromTree(workingChildren, id);
      }
      if (collected.length !== ids.length) break;
      // Derive variant axes from the patch or the first component's name.
      const axes = patch.axes ?? deriveVariantAxes(collected[0] as { name?: string });
      const setId = patch.shapeId ?? newId();
      const componentSet: PenComponentSet = {
        id: setId,
        type: 'component_set',
        name: (patch.shape?.name as string) ?? 'Component Set',
        x: num(patch.shape?.x, 100),
        y: num(patch.shape?.y, 100),
        width: num(patch.shape?.width, 400),
        height: num(patch.shape?.height, 200),
        variantPropertyAxes: axes,
        variantLayout: 'grid',
        children: collected,
      };
      next.children = [...workingChildren, componentSet as PenChild];
      break;
    }

    case 'swap_variant': {
      // Switch which variant of a ComponentSet the instance points to.
      // Figma behavior: select instance → in Properties panel, pick a different
      // variant from the variant property dropdown.
      // Implementation: change ref.ref to point at a different component inside the set.
      if (!patch.shapeId || !patch.componentId) break;
      const node = findNode(next.children, patch.shapeId);
      if (!node || node.type !== 'ref') break;
      next.children = updateNode(next.children, patch.shapeId, {
        ref: patch.componentId,
      } as Partial<PenChild>);
      break;
    }
    case 'flatten_boolean': {
      if (!patch.shapeId) break;
      const node = findNode(next.children, patch.shapeId);
      if (!node || node.type !== 'boolean_operation') break;
      next.children = updateNode(next.children, patch.shapeId, {
        geometry: '<flattened>',
      } as Partial<PenChild>);
      break;
    }
  }

  return recomputeDerived(next);
}

/// Find a page's index by id or name (case-insensitive partial match).
function findPageIndex(
  pages: NonNullable<CanvasDocument['pages']>,
  patch: CanvasPatch,
): number {
  if (patch.pageId) {
    const idx = pages.findIndex((p) => p.id === patch.pageId);
    if (idx >= 0) return idx;
  }
  if (patch.pageName) {
    const lower = patch.pageName.toLowerCase();
    const idx = pages.findIndex((p) => p.name.toLowerCase().includes(lower));
    if (idx >= 0) return idx;
  }
  return -1;
}

/// Insert a node from a patch into the tree. Used by the new Figma ontology
/// ops (add_section, create_component, create_component_set, add_variant).
function insertNodeFromPatch(children: PenChild[], patch: CanvasPatch): PenChild[] {
  if (!patch.shape) return children;
  const id = patch.shapeId ?? (patch.shape.id as string) ?? crypto.randomUUID();
  const node = normalizeToNode(patch.shape as Partial<PenChild>, id);
  const parentId = (patch.shape as { parentId?: string | null }).parentId;
  if (parentId) {
    return insertUnderParent(children, node, parentId);
  }
  return [...children, node];
}

/// Recursively walk the tree, inserting `node` under the parent with `parentId`.
function insertUnderParent(children: PenChild[], node: PenChild, parentId: string): PenChild[] {
  return children.map((c) => {
    if (c.id === parentId) {
      if ('children' in c && Array.isArray(c.children)) {
        return { ...c, children: [...c.children, node] };
      }
      return c;
    }
    const isContainer =
      c.type === 'frame' || c.type === 'group' ||
      c.type === 'component' || c.type === 'component_set' ||
      c.type === 'section' || c.type === 'boolean_operation';
    if (isContainer && 'children' in c && Array.isArray(c.children)) {
      const next = insertUnderParent(c.children as PenChild[], node, parentId);
      if (next !== c.children) return { ...c, children: next };
    }
    return c;
  });
}

// ---- Helpers for tree sibling replacement --------------------------------

/** Replace one specific children array (found by reference) with a new one. */
function replaceSiblings(children: PenChild[], oldArr: PenChild[], newArr: PenChild[]): PenChild[] {
  if (children === oldArr) return newArr;
  return children.map((c) => {
    const isContainer =
      c.type === 'frame' || c.type === 'group' ||
      c.type === 'component' || c.type === 'component_set' ||
      c.type === 'section' || c.type === 'boolean_operation';
    if (isContainer && 'children' in c && c.children) {
      if (c.children === oldArr) return { ...c, children: newArr };
      const next = replaceSiblings(c.children as PenChild[], oldArr, newArr);
      if (next !== c.children) return { ...c, children: next };
    }
    return c;
  });
}

/** Turn a partial .pen node into a complete, valid node with defaults. */
function normalizeToNode(partial: Partial<PenChild> & Record<string, unknown>, id: string): PenChild {
  const type = (partial.type as string) ?? 'rectangle';
  const base: any = {
    id,
    name: partial.name ?? 'Shape',
    x: num(partial.x, 0),
    y: num(partial.y, 0),
    width: partial.width ?? 100,
    height: partial.height ?? 100,
    rotation: num(partial.rotation, 0),
    opacity: num(partial.opacity, 1),
    enabled: partial.enabled ?? true,
    ...partial,
  };
  // Ensure id + type win over any spread values.
  base.id = id;
  base.type = type as PenChild['type'];
  // Ensure containers have a children array. Include the new Figma-canonical
  // container types: section, component, component_set, boolean_operation.
  if (type === 'frame' || type === 'group' || type === 'component' ||
      type === 'component_set' || type === 'section' || type === 'boolean_operation') {
    if (!Array.isArray(base.children)) base.children = [];
  }
  return base as PenChild;
}

// ---- Phase 2 component-system helpers -------------------------------------

/**
 * Replace a node by id anywhere in the tree with a new node.
 * Used by `detach_instance` to swap a PenRef for its expanded frame subtree.
 * Returns a new tree (immutable).
 */
function replaceNodeInTree(children: PenChild[], id: string, newNode: PenChild): PenChild[] {
  let replaced = false;
  const mapped = children.map((c) => {
    if (c.id === id) {
      replaced = true;
      return newNode;
    }
    const isContainer =
      c.type === 'frame' || c.type === 'group' ||
      c.type === 'component' || c.type === 'component_set' ||
      c.type === 'section' || c.type === 'boolean_operation';
    if (isContainer && 'children' in c && Array.isArray(c.children)) {
      const next = replaceNodeInTree(c.children as PenChild[], id, newNode);
      if (next !== c.children) return { ...c, children: next };
    }
    return c;
  });
  return replaced ? mapped : children;
}

/**
 * Remove a node by id from anywhere in the tree.
 * Used by `combine_as_variants` to lift components out before re-wrapping them.
 * Returns a new tree (immutable).
 */
function removeFromTree(children: PenChild[], id: string): PenChild[] {
  const filtered = children.filter((c) => c.id !== id);
  if (filtered.length !== children.length) return filtered;
  // Not found at this level — recurse into containers.
  return children.map((c) => {
    const isContainer =
      c.type === 'frame' || c.type === 'group' ||
      c.type === 'component' || c.type === 'component_set' ||
      c.type === 'section' || c.type === 'boolean_operation';
    if (isContainer && 'children' in c && Array.isArray(c.children)) {
      const next = removeFromTree(c.children as PenChild[], id);
      if (next !== c.children) return { ...c, children: next };
    }
    return c;
  });
}

/**
 * Parse Figma's variant naming convention "Property1=Value1, Property2=Value2"
 * and return the property names (axes). Used by `combine_as_variants` when the
 * caller doesn't explicitly specify axes.
 *
 * Example: "Size=Large, State=Default" → ['Size', 'State']
 * Falls back to ['Variant'] if the name doesn't match the convention.
 */
function deriveVariantAxes(node: { name?: string }): string[] {
  const name = node?.name ?? '';
  // Match "Prop=Value" pairs separated by commas.
  const pairs = name.split(',').map((s) => s.trim());
  const axes: string[] = [];
  for (const p of pairs) {
    const eq = p.indexOf('=');
    if (eq > 0) {
      const k = p.slice(0, eq).trim();
      if (k) axes.push(k);
    }
  }
  return axes.length > 0 ? axes : ['Variant'];
}

/**
 * Normalize an instance-override payload: map legacy `Shape` field names to
 * their .pen equivalents so the override actually takes effect when applied
 * to the cloned subtree.
 *
 * The .pen spec uses different field names than the legacy AgentCanvas `Shape`
 * type for backwards-compat reasons. The agent tools + UI expose Figma-style
 * names (`text`, `textColor`, `strokeWidth`, `radius`) which we map here:
 *
 *   - `text`       → `content`   (pen text node field)
 *   - `textColor`  → `fill`      (pen text nodes use `fill` for text color)
 *   - `strokeWidth`→ `strokeWeight` (pen stroke weight field name)
 *   - `radius`     → `cornerRadius` (pen corner radius field name)
 *
 * Other fields (fill, stroke, opacity, visible, fontSize) pass through unchanged.
 */
function normalizeOverride(override: Partial<Shape> & Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...override };
  // Map legacy Shape field names → .pen field names.
  if ('text' in out && out.text !== undefined) {
    out.content = out.text;
    delete out.text;
  }
  if ('textColor' in out && out.textColor !== undefined) {
    // Text color on a pen text node is `fill` (same field as shape fill — the
    // node type disambiguates). Caller can still pass `fill` for shape nodes.
    // If both are present, `fill` wins (more specific).
    if (!('fill' in out) || out.fill === undefined) {
      out.fill = out.textColor;
    }
    delete out.textColor;
  }
  if ('strokeWidth' in out && out.strokeWidth !== undefined) {
    out.strokeWeight = out.strokeWidth;
    delete out.strokeWidth;
  }
  if ('radius' in out && out.radius !== undefined) {
    out.cornerRadius = out.radius;
    delete out.radius;
  }
  return out;
}
