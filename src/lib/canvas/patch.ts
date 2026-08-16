// Pure canvas patching logic — no Node.js-only imports, safe for browser.
// Split out of `runner.ts` so the frontend store can import it without
// pulling in the Pi Agent SDK (which uses `fs`, `os`, `path`).
//
// Implements all extended patch ops:
//   bulk_add, update_many, duplicate, group, ungroup, align,
//   tokens, heatmap — in addition to the original add/update/remove/
//   clear/background/select.

import type { CanvasDocument, CanvasPatch, Shape } from './types';

function randomId(): string {
  // Browser-safe UUID (crypto.randomUUID exists in modern browsers and Node 19+).
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// Coerce a value to a finite number, falling back to `def` if missing or
// invalid. LLM tool callers frequently pass numeric fields as strings
// (e.g. "x": "100") — this normalizes them so downstream code can rely on
// `s.x.toFixed(0)` etc. without crashing.
function num(v: unknown, def: number): number {
  if (v === null || v === undefined) return def;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : def;
}

function str(v: unknown, def: string): string {
  return v === null || v === undefined ? def : String(v);
}

function normalizeShape(input: Partial<Shape>, fallbackZ: number): Shape {
  return {
    id: input.id ?? randomId(),
    type: (input.type as Shape['type']) ?? 'rectangle',
    name: str(input.name, 'Shape'),
    x: num(input.x, 0),
    y: num(input.y, 0),
    width: num(input.width, 100),
    height: num(input.height, 100),
    rotation: num(input.rotation, 0),
    opacity: Math.max(0, Math.min(1, num(input.opacity, 1))),
    fill: str(input.fill, '#e2e8f0'),
    stroke: str(input.stroke, '#0f172a'),
    strokeWidth: num(input.strokeWidth, 0),
    radius: num(input.radius, 0),
    text: input.text === null || input.text === undefined ? undefined : String(input.text),
    fontSize: num(input.fontSize, 16),
    textColor: str(input.textColor, '#0f172a'),
    parentId: input.parentId ?? null,
    zIndex: num(input.zIndex, fallbackZ),
    locked: !!input.locked,
    visible: input.visible !== false,
    autoLayout: input.autoLayout ?? null,
    tokenBinding: input.tokenBinding ?? null,
    componentId: input.componentId ?? null,
  };
}

export function applyPatchToCanvas(canvas: CanvasDocument, patch: CanvasPatch): CanvasDocument {
  // Defensive: if a stale document arrives (e.g. from a server that hasn't
  // been recompiled to include the tokens/heatmap fields), normalize it so
  // we never crash downstream components.
  const safeTokens = canvas.tokens ?? { colors: [], textStyles: [] };
  const safeShapes = canvas.shapes ?? [];
  // Always clone tokens & heatmap so we don't mutate shared state.
  const next: CanvasDocument = {
    ...canvas,
    shapes: [...safeShapes],
    tokens: { colors: [...safeTokens.colors], textStyles: [...safeTokens.textStyles] },
    heatmap: canvas.heatmap ? { ...canvas.heatmap, points: [...canvas.heatmap.points] } : null,
  };

  switch (patch.op) {
    case 'add': {
      if (!patch.shape) break;
      const s = normalizeShape(patch.shape, next.shapes.length);
      next.shapes.push(s);
      break;
    }
    case 'bulk_add': {
      if (!patch.shapes || patch.shapes.length === 0) break;
      let baseZ = next.shapes.length;
      for (const partial of patch.shapes) {
        const s = normalizeShape({ ...partial, id: partial.id ?? randomId() }, baseZ++);
        next.shapes.push(s);
      }
      break;
    }
    case 'update': {
      if (!patch.shapeId || !patch.shape) break;
      next.shapes = next.shapes.map((s) =>
        s.id === patch.shapeId ? normalizeShape({ ...s, ...patch.shape! }, s.zIndex) : s,
      );
      break;
    }
    case 'update_many': {
      if (!patch.updates) break;
      const map = new Map(patch.updates.map((u) => [u.id, u.changes]));
      next.shapes = next.shapes.map((s) =>
        map.has(s.id) ? normalizeShape({ ...s, ...map.get(s.id)! }, s.zIndex) : s,
      );
      break;
    }
    case 'remove': {
      const ids = new Set(patch.shapeIds ?? (patch.shapeId ? [patch.shapeId] : []));
      next.shapes = next.shapes.filter((s) => !ids.has(s.id));
      break;
    }
    case 'duplicate': {
      const ids = new Set(patch.shapeIds ?? []);
      const toDup = next.shapes.filter((s) => ids.has(s.id));
      let baseZ = next.shapes.length;
      for (const s of toDup) {
        const clone: Shape = {
          ...s,
          id: randomId(),
          name: `${s.name} copy`,
          x: s.x + 24,
          y: s.y + 24,
          zIndex: baseZ++,
        };
        next.shapes.push(clone);
      }
      break;
    }
    case 'clear': {
      next.shapes = [];
      break;
    }
    case 'background': {
      if (patch.background) next.background = patch.background;
      break;
    }
    case 'group': {
      const ids = new Set(patch.shapeIds ?? []);
      if (ids.size === 0) break;
      const children = next.shapes.filter((s) => ids.has(s.id));
      if (children.length === 0) break;
      // Compute bounding box of children.
      const minX = Math.min(...children.map((s) => s.x));
      const minY = Math.min(...children.map((s) => s.y));
      const maxX = Math.max(...children.map((s) => s.x + s.width));
      const maxY = Math.max(...children.map((s) => s.y + s.height));
      const groupId = patch.groupId ?? randomId();
      const group: Shape = {
        id: groupId,
        type: 'group',
        name: 'Group',
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
        rotation: 0,
        opacity: 1,
        fill: 'transparent',
        stroke: '#94a3b8',
        strokeWidth: 1,
        radius: 0,
        fontSize: 16,
        textColor: '#0f172a',
        parentId: null,
        zIndex: next.shapes.length,
        locked: false,
        visible: true,
      };
      next.shapes.push(group);
      next.shapes = next.shapes.map((s) =>
        ids.has(s.id) ? { ...s, parentId: groupId } : s,
      );
      break;
    }
    case 'ungroup': {
      const ids = new Set(patch.shapeIds ?? []);
      // Remove any group shapes in the ids set.
      next.shapes = next.shapes
        .filter((s) => !(ids.has(s.id) && s.type === 'group'))
        // Clear parentId on children whose parent was one of the ungrouped groups.
        .map((s) => (s.parentId && ids.has(s.parentId) ? { ...s, parentId: null } : s));
      break;
    }
    case 'align': {
      const ids = patch.shapeIds ?? [];
      if (ids.length < 2) break;
      const targets = next.shapes.filter((s) => ids.includes(s.id));
      if (targets.length < 2) break;
      const kind = patch.alignKind ?? 'left';
      const updates = new Map<string, Partial<Shape>>();
      switch (kind) {
        case 'left': {
          const minX = Math.min(...targets.map((s) => s.x));
          for (const t of targets) updates.set(t.id, { x: minX });
          break;
        }
        case 'right': {
          const maxX = Math.max(...targets.map((s) => s.x + s.width));
          for (const t of targets) updates.set(t.id, { x: maxX - t.width });
          break;
        }
        case 'center_h': {
          // Align centers horizontally (i.e. same center X).
          // Use the average center X.
          const avgCx = targets.reduce((acc, s) => acc + (s.x + s.width / 2), 0) / targets.length;
          for (const t of targets) updates.set(t.id, { x: avgCx - t.width / 2 });
          break;
        }
        case 'top': {
          const minY = Math.min(...targets.map((s) => s.y));
          for (const t of targets) updates.set(t.id, { y: minY });
          break;
        }
        case 'bottom': {
          const maxY = Math.max(...targets.map((s) => s.y + s.height));
          for (const t of targets) updates.set(t.id, { y: maxY - t.height });
          break;
        }
        case 'center_v': {
          const avgCy = targets.reduce((acc, s) => acc + (s.y + s.height / 2), 0) / targets.length;
          for (const t of targets) updates.set(t.id, { y: avgCy - t.height / 2 });
          break;
        }
        case 'distribute_h': {
          // Sort by x, distribute evenly.
          const sorted = [...targets].sort((a, b) => a.x - b.x);
          if (sorted.length < 3) break;
          const first = sorted[0];
          const last = sorted[sorted.length - 1];
          const totalSpan = (last.x + last.width) - first.x;
          const totalWidth = sorted.reduce((acc, s) => acc + s.width, 0);
          const gap = (totalSpan - totalWidth) / (sorted.length - 1);
          let cursor = first.x;
          for (let i = 0; i < sorted.length; i++) {
            updates.set(sorted[i].id, { x: cursor });
            cursor += sorted[i].width + gap;
          }
          break;
        }
        case 'distribute_v': {
          const sorted = [...targets].sort((a, b) => a.y - b.y);
          if (sorted.length < 3) break;
          const first = sorted[0];
          const last = sorted[sorted.length - 1];
          const totalSpan = (last.y + last.height) - first.y;
          const totalHeight = sorted.reduce((acc, s) => acc + s.height, 0);
          const gap = (totalSpan - totalHeight) / (sorted.length - 1);
          let cursor = first.y;
          for (let i = 0; i < sorted.length; i++) {
            updates.set(sorted[i].id, { y: cursor });
            cursor += sorted[i].height + gap;
          }
          break;
        }
      }
      next.shapes = next.shapes.map((s) =>
        updates.has(s.id) ? { ...s, ...updates.get(s.id)! } : s,
      );
      break;
    }
    case 'tokens': {
      if (patch.tokens?.colors) {
        // Merge by key — replace existing, append new.
        for (const incoming of patch.tokens.colors) {
          const idx = next.tokens.colors.findIndex((c) => c.key === incoming.key);
          if (idx >= 0) next.tokens.colors[idx] = incoming;
          else next.tokens.colors.push(incoming);
        }
      }
      if (patch.tokens?.textStyles) {
        for (const incoming of patch.tokens.textStyles) {
          const idx = next.tokens.textStyles.findIndex((c) => c.key === incoming.key);
          if (idx >= 0) next.tokens.textStyles[idx] = incoming;
          else next.tokens.textStyles.push(incoming);
        }
      }
      // Re-apply token bindings: any shape whose `tokenBinding.fillToken`
      // points to a token we just updated gets its `fill` refreshed.
      const colorByKey = new Map(next.tokens.colors.map((c) => [c.key, c.value]));
      next.shapes = next.shapes.map((s) => {
        if (!s.tokenBinding) return s;
        const out = { ...s };
        if (s.tokenBinding.fillToken && colorByKey.has(s.tokenBinding.fillToken)) {
          out.fill = colorByKey.get(s.tokenBinding.fillToken)!;
        }
        if (s.tokenBinding.strokeToken && colorByKey.has(s.tokenBinding.strokeToken)) {
          out.stroke = colorByKey.get(s.tokenBinding.strokeToken)!;
        }
        if (s.tokenBinding.textToken && colorByKey.has(s.tokenBinding.textToken)) {
          out.textColor = colorByKey.get(s.tokenBinding.textToken)!;
        }
        return out;
      });
      break;
    }
    case 'heatmap': {
      next.heatmap = patch.heatmap ?? null;
      break;
    }
    case 'viewport': {
      if (patch.viewport) next.viewport = patch.viewport;
      break;
    }
    case 'select': {
      // No document mutation — UI-only.
      break;
    }
  }
  return next;
}
