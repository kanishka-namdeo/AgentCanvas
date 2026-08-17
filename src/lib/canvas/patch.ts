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

import type { CanvasDocument, CanvasPatch, Shape, DesignTokens, ColorToken, TextStyleToken } from './types';
import type { PenChild, PenVariableDef, PenTheme } from '../pen/types';
import { resolvePenTree } from '../pen/resolve';
import { findNode, findNodeArray, insertNode, removeNode, updateNode, moveNode, deepCloneNode, newId, collectComponents, walkTree } from '../pen/document';

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
  for (const k of ['id', 'name', 'type', 'x', 'y', 'width', 'height', 'rotation', 'opacity', 'fill', 'stroke', 'strokeWidth', 'strokeLinecap', 'strokeLinejoin', 'strokeAlignment', 'effect', 'reusable', 'theme', 'enabled', 'flipX', 'flipY', 'layoutPosition', 'metadata', 'layout', 'gap', 'padding', 'justifyContent', 'alignItems', 'layoutIncludeStroke', 'clip', 'placeholder', 'slot', 'content', 'fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'fontStyle', 'underline', 'lineHeight', 'textAlign', 'textAlignVertical', 'strikethrough', 'href', 'textGrowth', 'children', 'geometry', 'viewBox', 'fillRule', 'polygonCount', 'cornerRadius', 'innerRadius', 'startAngle', 'sweepAngle', 'library', 'icon', 'weight', 'scriptUri', 'inputs', 'ref', 'descendants', 'context']) {
    if (input[k] !== undefined) out[k] = input[k];
  }

  // Legacy → .pen field mappings.
  if (input.radius !== undefined && input.cornerRadius === undefined) {
    out.cornerRadius = num(input.radius, 0);
  }
  if (input.radii !== undefined) {
    const r = input.radii as any;
    out.cornerRadius = [num(r.topLeft, 0), num(r.topRight, 0), num(r.bottomRight, 0), num(r.bottomLeft, 0)];
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
  // Legacy gradient/shadow/blur → .pen fill/effect arrays (only if not already set).
  if (input.gradient && out.fill === undefined) {
    out.fill = { type: 'gradient', gradientType: input.gradient.type, rotation: input.gradient.angle, colors: input.gradient.stops.map((s: any) => ({ color: s.color, position: s.offset })) };
  }
  if (input.shadow && out.effect === undefined) {
    const s = input.shadow as any;
    out.effect = { type: 'shadow', shadowType: s.inset ? 'inner' : 'outer', offset: { x: s.x, y: s.y }, blur: s.blur, spread: s.spread ?? 0, color: s.color };
  }
  if (input.blur !== undefined && num(input.blur, 0) > 0 && out.effect === undefined) {
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
      // Move each target under the group.
      for (const id of ids) {
        next.children = moveNode(next.children, id, groupId);
      }
      next.children = insertNode(next.children, groupNode, null);
      break;
    }
    case 'ungroup': {
      const ids = new Set(patch.shapeIds ?? []);
      for (const id of ids) {
        const group = findNode(next.children, id);
        if (group && (group.type === 'frame' || group.type === 'group') && group.children) {
          // Move children up to the group's parent (root for now).
          for (const child of group.children) {
            next.children = insertNode(next.children, child, null);
          }
          next.children = removeNode(next.children, id);
        }
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
        const siblings = found.array;
        const moverIdxs = siblings.map((s, i) => (ids.has(s.id) ? i : -1)).filter((i) => i >= 0);
        const movers = moverIdxs.map((i) => siblings[i]);
        const rest = siblings.filter((_, i) => !moverIdxs.includes(i));
        let newOrder: PenChild[];
        if (kind === 'front') newOrder = [...rest, ...movers];
        else if (kind === 'back') newOrder = [...movers, ...rest];
        else if (kind === 'forward') {
          newOrder = [...rest];
          // Insert each mover after the next non-mover... simplified: move to end of rest+1.
          newOrder = [...rest];
          for (const m of movers) {
            const idx = newOrder.findIndex((s) => s.id === m.id);
            if (idx >= 0 && idx < newOrder.length - 1) {
              newOrder.splice(idx, 1);
              newOrder.splice(Math.min(idx + 1, newOrder.length), 0, m);
            } else {
              newOrder.push(m);
            }
          }
        } else {
          // backward
          newOrder = [...rest];
          for (const m of movers) {
            const idx = newOrder.findIndex((s) => s.id === m.id);
            if (idx > 0) {
              newOrder.splice(idx, 1);
              newOrder.splice(Math.max(idx - 1, 0), 0, m);
            } else {
              newOrder.unshift(m);
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
  }

  return recomputeDerived(next);
}

// ---- Helpers for tree sibling replacement --------------------------------

/** Replace one specific children array (found by reference) with a new one. */
function replaceSiblings(children: PenChild[], oldArr: PenChild[], newArr: PenChild[]): PenChild[] {
  if (children === oldArr) return newArr;
  return children.map((c) => {
    if ((c.type === 'frame' || c.type === 'group') && c.children) {
      if (c.children === oldArr) return { ...c, children: newArr };
      const next = replaceSiblings(c.children, oldArr, newArr);
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
    id, // ensure id wins
    type, // ensure type wins
  };
  // Ensure containers have a children array.
  if (type === 'frame' || type === 'group') {
    if (!Array.isArray(base.children)) base.children = [];
  }
  return base as PenChild;
}
