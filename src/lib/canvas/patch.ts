// Pure canvas patching logic — no Node.js-only imports, safe for browser.
// Split out of `runner.ts` so the frontend store can import it without
// pulling in the Pi Agent SDK (which uses `fs`, `os`, `path`).

import type { CanvasDocument, CanvasPatch, Shape } from './types';

export function applyPatchToCanvas(canvas: CanvasDocument, patch: CanvasPatch): CanvasDocument {
  const next: CanvasDocument = { ...canvas, shapes: [...canvas.shapes] };
  switch (patch.op) {
    case 'add': {
      if (!patch.shape) break;
      const s: Shape = {
        id: patch.shape.id ?? randomId(),
        type: (patch.shape.type as Shape['type']) ?? 'rectangle',
        name: patch.shape.name ?? 'Shape',
        x: patch.shape.x ?? 0,
        y: patch.shape.y ?? 0,
        width: patch.shape.width ?? 100,
        height: patch.shape.height ?? 100,
        rotation: patch.shape.rotation ?? 0,
        opacity: patch.shape.opacity ?? 1,
        fill: patch.shape.fill ?? '#e2e8f0',
        stroke: patch.shape.stroke ?? '#0f172a',
        strokeWidth: patch.shape.strokeWidth ?? 0,
        radius: patch.shape.radius ?? 0,
        text: patch.shape.text,
        fontSize: patch.shape.fontSize ?? 16,
        textColor: patch.shape.textColor ?? '#0f172a',
        parentId: patch.shape.parentId ?? null,
        zIndex: patch.shape.zIndex ?? next.shapes.length,
        locked: patch.shape.locked ?? false,
        visible: patch.shape.visible ?? true,
      };
      next.shapes.push(s);
      break;
    }
    case 'update': {
      if (!patch.shapeId || !patch.shape) break;
      next.shapes = next.shapes.map((s) =>
        s.id === patch.shapeId ? { ...s, ...patch.shape! } : s,
      );
      break;
    }
    case 'remove': {
      const ids = new Set(patch.shapeIds ?? (patch.shapeId ? [patch.shapeId] : []));
      next.shapes = next.shapes.filter((s) => !ids.has(s.id));
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
    case 'viewport': {
      if (patch.viewport) next.viewport = patch.viewport;
      break;
    }
    case 'select': {
      break;
    }
  }
  return next;
}

function randomId(): string {
  // Browser-safe UUID (crypto.randomUUID exists in modern browsers and Node 19+).
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
