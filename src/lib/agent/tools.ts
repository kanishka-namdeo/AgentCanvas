// Pi Agent SDK custom tools for canvas manipulation.
//
// This file is the canonical "agent-usable" surface of the Figma-like app.
// Each tool is defined with `defineTool` from `@earendil-works/pi-coding-agent`
// (the real Pi Agent SDK), using TypeBox (`@sinclair/typebox`) for parameter
// schemas — exactly the pattern documented at
// https://pi.dev/docs/latest/sdk.
//
// === TOOL INVENTORY (research-driven) =====================================
//
// Core canvas ops (existing):
//   canvas_create_shape, canvas_update_shape, canvas_delete_shape,
//   canvas_list_shapes, canvas_clear, canvas_set_background, canvas_select_shape
//
// Extended scenarios (added based on /research/*.json findings):
//
//   1. Auto Layout (Figma Auto Layout — see figma_features.json)
//      - canvas_apply_auto_layout
//
//   2. Components & Variants (Figma component system)
//      - canvas_create_component
//      - canvas_instantiate_component
//
//   3. Layer organization (Figma layers panel + AI plugins)
//      - canvas_duplicate_shape
//      - canvas_group_shapes
//      - canvas_ungroup_shapes
//      - canvas_align_shapes
//      - canvas_organize_layers
//
//   4. Design tokens / variables (Figma Variables + AI design systems)
//      - canvas_update_tokens
//      - canvas_apply_palette
//      - canvas_generate_palette
//
//   5. Wireframe generation (Uizard / Galileo AI / Figma Make)
//      - canvas_generate_wireframe
//
//   6. Multi-screen user flows (UX Pilot, Galileo AI)
//      - canvas_generate_user_flow
//
//   7. Diagram / flowchart generation (Figma AI diagrams)
//      - canvas_generate_diagram
//
//   8. Attention heatmap prediction (Uizard predictive heat map)
//      - canvas_predict_heatmap
//
//   9. Copy / text generation (Figma AI placeholder content)
//      - canvas_generate_copy
//
//  10. Design auditing (AI design-system audit — ai_design_scenarios.json)
//      - canvas_audit_design
//
// The agent backend (see `src/lib/agent/runner.ts`) registers these tools
// with the LLM and invokes their `execute` when the LLM calls them.

import { Type, type Static } from '@sinclair/typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { CanvasPatch, HeatmapOverlay, Shape, ShapeType, AutoLayout, DesignTokens, ColorToken, TextStyleToken } from '../canvas/types.ts';

// ---- Tool execution context -------------------------------------------------
//
// `defineTool`'s `execute` signature is:
//   (toolCallId, params, signal, onUpdate, ctx) => Promise<AgentToolResult>
//
// The tools here need access to:
//   1. The current canvas state (to read shapes / find by id).
//   2. A patch sink — every mutation is recorded as a `CanvasPatch` so it
//      can be persisted, broadcast to viewers, and replayed.
//
// We don't want to rewire the SDK's call signature, so we attach these via
// a closure when the tools are constructed for a given session. The factory
// `createCanvasTools()` below returns an array of `ToolDefinition`s bound
// to a specific session context.

export interface CanvasToolContext {
  /// Read-only snapshot of the current canvas state. The runner refreshes
  /// this before each tool call so the agent always sees fresh data.
  getShapes: () => Shape[];
  /// Read-only snapshot of the current design tokens.
  getTokens: () => DesignTokens;
  /// Apply a patch (the tool's effect) and return the patched document.
  applyPatch: (patch: CanvasPatch) => CanvasPatch;
  /// Read-only snapshot of the full document (background, viewport, etc.).
  /// Used by export tools. Optional — the runner always provides it.
  getDocument?: () => import('../canvas/types.ts').CanvasDocument;
}

// ---- Parameter schemas ------------------------------------------------------

const ShapeTypeSchema = Type.Union(
  [
    Type.Literal('rectangle'),
    Type.Literal('ellipse'),
    Type.Literal('text'),
    Type.Literal('line'),
    Type.Literal('frame'),
    Type.Literal('group'),
    Type.Literal('path'),
    Type.Literal('image'),
  ],
  { description: 'Shape kind' },
);

const ShapeInputSchema = Type.Object({
  type: Type.Optional(ShapeTypeSchema),
  name: Type.Optional(Type.String({ description: 'Layer name shown in the layers panel' })),
  x: Type.Optional(Type.Number({ description: 'Canvas-space X (top-left origin)' })),
  y: Type.Optional(Type.Number({ description: 'Canvas-space Y' })),
  width: Type.Optional(Type.Number({ description: 'Width in px' })),
  height: Type.Optional(Type.Number({ description: 'Height in px' })),
  rotation: Type.Optional(Type.Number({ description: 'Rotation in degrees' })),
  opacity: Type.Optional(Type.Number({ description: 'Opacity 0..1' })),
  fill: Type.Optional(Type.String({ description: 'Fill color hex, e.g. #ff0000' })),
  stroke: Type.Optional(Type.String({ description: 'Stroke color hex' })),
  strokeWidth: Type.Optional(Type.Number({ description: 'Stroke width in px' })),
  radius: Type.Optional(Type.Number({ description: 'Border radius in px (rectangle/frame)' })),
  text: Type.Optional(Type.String({ description: 'Text content (type=text only)' })),
  fontSize: Type.Optional(Type.Number({ description: 'Font size for text shapes' })),
  textColor: Type.Optional(Type.String({ description: 'Text color hex' })),
  // Phase 5 extended fields:
  src: Type.Optional(Type.String({ description: 'Image source URL (data URL or remote) — type=image only' })),
  closed: Type.Optional(Type.Boolean({ description: 'For path shapes: close the path (fill it). Default false.' })),
  blur: Type.Optional(Type.Number({ description: 'Gaussian blur radius in px' })),
});

// ---- Helpers ----------------------------------------------------------------

/// Coerce LLM-provided arguments into the types the schema expects.
/// LLMs sometimes pass numbers as strings (e.g. `x: "400"` instead of `400`).
/// This helper normalizes those before they reach the patch layer.
function coerceShapeInput(params: Static<typeof ShapeInputSchema>): Partial<Shape> {
  const out: Partial<Shape> = {};
  if (params.type !== undefined) out.type = params.type as Shape['type'];
  if (params.name !== undefined) out.name = String(params.name);
  if (params.x !== undefined) out.x = Number(params.x) || 0;
  if (params.y !== undefined) out.y = Number(params.y) || 0;
  if (params.width !== undefined) out.width = Number(params.width) || 0;
  if (params.height !== undefined) out.height = Number(params.height) || 0;
  if (params.rotation !== undefined) out.rotation = Number(params.rotation) || 0;
  if (params.opacity !== undefined) out.opacity = Math.max(0, Math.min(1, Number(params.opacity) || 1));
  if (params.fill !== undefined) out.fill = String(params.fill);
  if (params.stroke !== undefined) out.stroke = String(params.stroke);
  if (params.strokeWidth !== undefined) out.strokeWidth = Number(params.strokeWidth) || 0;
  if (params.radius !== undefined) out.radius = Number(params.radius) || 0;
  if (params.text !== undefined) out.text = String(params.text);
  if (params.fontSize !== undefined) out.fontSize = Number(params.fontSize) || 16;
  if (params.textColor !== undefined) out.textColor = String(params.textColor);
  // Phase 5 extended fields:
  if ((params as any).src !== undefined) out.src = String((params as any).src);
  if ((params as any).closed !== undefined) out.closed = !!(params as any).closed;
  if ((params as any).blur !== undefined) out.blur = Number((params as any).blur) || 0;
  if (Array.isArray((params as any).points)) {
    out.points = (params as any).points.map((p: any) => ({ x: Number(p.x) || 0, y: Number(p.y) || 0 }));
  }
  if ((params as any).radii) {
    const r = (params as any).radii;
    out.radii = {
      topLeft: Number(r.topLeft) || 0,
      topRight: Number(r.topRight) || 0,
      bottomRight: Number(r.bottomRight) || 0,
      bottomLeft: Number(r.bottomLeft) || 0,
    };
  }
  if ((params as any).gradient) {
    const g = (params as any).gradient;
    out.gradient = {
      type: g.type === 'radial' ? 'radial' : 'linear',
      angle: Number(g.angle) || 0,
      stops: Array.isArray(g.stops) ? g.stops.map((s: any) => ({ offset: Number(s.offset) || 0, color: String(s.color) })) : [],
    };
  }
  if ((params as any).shadow) {
    const sh = (params as any).shadow;
    out.shadow = {
      x: Number(sh.x) || 0,
      y: Number(sh.y) || 0,
      blur: Number(sh.blur) || 0,
      color: String(sh.color ?? '#000000'),
      spread: sh.spread !== undefined ? Number(sh.spread) : 0,
      inset: !!sh.inset,
    };
  }
  if ((params as any).maskId !== undefined) out.maskId = (params as any).maskId ? String((params as any).maskId) : null;
  if ((params as any).locked !== undefined) out.locked = !!(params as any).locked;
  if ((params as any).visible !== undefined) out.visible = (params as any).visible !== false;
  return out;
}

/// Convert HSL → hex. Used by the palette generator.
function hslToHex(h: number, s: number, l: number): string {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const v = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(v * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/// Parse a hex color → {h, s, l}.
function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const m = hex.replace('#', '');
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  const d = max - min;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h *= 60;
  }
  return { h, s: s * 100, l: l * 100 };
}

/// Escape a string for safe inclusion in XML/SVG text content.
function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/// Escape a string for safe inclusion in HTML text content.
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/// Escape a string for use in a RegExp.
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/// A curated subset of Lucide icon path data (24×24 viewBox).
/// Each icon is an array of {x, y} polyline points. These are simplified
/// approximations of the real Lucide icons — enough for placeholder use.
const LUCIDE_ICONS: Record<string, Array<{ x: number; y: number }>> = {
  check: [{ x: 20, y: 6 }, { x: 9, y: 17 }, { x: 4, y: 12 }],
  x: [{ x: 18, y: 6 }, { x: 6, y: 18 }, { x: 6, y: 6 }, { x: 18, y: 18 }],
  plus: [{ x: 12, y: 5 }, { x: 12, y: 19 }, { x: 5, y: 12 }, { x: 19, y: 12 }],
  minus: [{ x: 5, y: 12 }, { x: 19, y: 12 }],
  'arrow-right': [{ x: 5, y: 12 }, { x: 19, y: 12 }, { x: 12, y: 5 }, { x: 12, y: 19 }],
  'arrow-left': [{ x: 19, y: 12 }, { x: 5, y: 12 }, { x: 12, y: 19 }, { x: 12, y: 5 }],
  'arrow-up': [{ x: 12, y: 19 }, { x: 12, y: 5 }, { x: 5, y: 12 }, { x: 19, y: 12 }],
  'arrow-down': [{ x: 12, y: 5 }, { x: 12, y: 19 }, { x: 5, y: 12 }, { x: 19, y: 12 }],
  'chevron-down': [{ x: 6, y: 9 }, { x: 12, y: 15 }, { x: 18, y: 9 }],
  'chevron-up': [{ x: 18, y: 15 }, { x: 12, y: 9 }, { x: 6, y: 15 }],
  'chevron-left': [{ x: 15, y: 18 }, { x: 9, y: 12 }, { x: 15, y: 6 }],
  'chevron-right': [{ x: 9, y: 18 }, { x: 15, y: 12 }, { x: 9, y: 6 }],
  search: [{ x: 11, y: 11 }, { x: 21, y: 21 }, { x: 11, y: 11 }, { x: 11, y: 8 }, { x: 8, y: 8 }, { x: 8, y: 11 }, { x: 11, y: 11 }],
  settings: [{ x: 12, y: 12 }, { x: 12, y: 12 }, { x: 19, y: 12 }, { x: 19, y: 12 }, { x: 12, y: 5 }, { x: 12, y: 5 }, { x: 5, y: 12 }, { x: 5, y: 12 }],
  user: [{ x: 20, y: 21 }, { x: 20, y: 21 }, { x: 16, y: 16 }, { x: 12, y: 12 }, { x: 8, y: 16 }, { x: 4, y: 21 }, { x: 4, y: 21 }],
  heart: [{ x: 20, y: 8 }, { x: 20, y: 8 }, { x: 12, y: 8 }, { x: 4, y: 8 }, { x: 4, y: 8 }, { x: 12, y: 21 }, { x: 20, y: 8 }],
  star: [{ x: 12, y: 2 }, { x: 15, y: 8 }, { x: 22, y: 8 }, { x: 17, y: 13 }, { x: 19, y: 20 }, { x: 12, y: 16 }, { x: 5, y: 20 }, { x: 7, y: 13 }, { x: 2, y: 8 }, { x: 9, y: 8 }, { x: 12, y: 2 }],
  bell: [{ x: 18, y: 8 }, { x: 18, y: 8 }, { x: 6, y: 8 }, { x: 6, y: 8 }, { x: 6, y: 8 }, { x: 18, y: 8 }, { x: 16, y: 16 }, { x: 8, y: 16 }, { x: 18, y: 8 }, { x: 12, y: 2 }, { x: 6, y: 8 }],
  mail: [{ x: 4, y: 4 }, { x: 20, y: 4 }, { x: 20, y: 20 }, { x: 4, y: 20 }, { x: 4, y: 4 }, { x: 4, y: 4 }, { x: 12, y: 13 }, { x: 20, y: 4 }],
  phone: [{ x: 22, y: 16 }, { x: 22, y: 16 }, { x: 16, y: 16 }, { x: 13, y: 13 }, { x: 13, y: 13 }, { x: 11, y: 11 }, { x: 11, y: 11 }, { x: 8, y: 8 }, { x: 2, y: 8 }, { x: 2, y: 8 }],
  calendar: [{ x: 3, y: 4 }, { x: 21, y: 4 }, { x: 21, y: 20 }, { x: 3, y: 20 }, { x: 3, y: 4 }, { x: 3, y: 4 }, { x: 8, y: 2 }, { x: 8, y: 6 }, { x: 16, y: 2 }, { x: 16, y: 6 }],
  clock: [{ x: 12, y: 12 }, { x: 12, y: 12 }, { x: 12, y: 6 }, { x: 12, y: 6 }, { x: 12, y: 12 }, { x: 16, y: 12 }, { x: 12, y: 12 }],
  home: [{ x: 3, y: 12 }, { x: 12, y: 3 }, { x: 21, y: 12 }, { x: 5, y: 12 }, { x: 5, y: 21 }, { x: 19, y: 21 }, { x: 19, y: 12 }],
  menu: [{ x: 3, y: 6 }, { x: 21, y: 6 }, { x: 3, y: 12 }, { x: 21, y: 12 }, { x: 3, y: 18 }, { x: 21, y: 18 }],
  share: [{ x: 4, y: 12 }, { x: 4, y: 12 }, { x: 12, y: 20 }, { x: 12, y: 20 }, { x: 12, y: 20 }, { x: 20, y: 12 }, { x: 20, y: 12 }, { x: 12, y: 4 }, { x: 12, y: 4 }, { x: 12, y: 4 }, { x: 4, y: 12 }],
  download: [{ x: 12, y: 3 }, { x: 12, y: 15 }, { x: 7, y: 10 }, { x: 12, y: 15 }, { x: 17, y: 10 }, { x: 4, y: 21 }, { x: 20, y: 21 }],
  upload: [{ x: 12, y: 21 }, { x: 12, y: 9 }, { x: 7, y: 14 }, { x: 12, y: 9 }, { x: 17, y: 14 }, { x: 4, y: 3 }, { x: 20, y: 3 }],
  edit: [{ x: 12, y: 20 }, { x: 9, y: 20 }, { x: 9, y: 20 }, { x: 5, y: 16 }, { x: 5, y: 16 }, { x: 16, y: 5 }, { x: 16, y: 5 }, { x: 19, y: 8 }, { x: 19, y: 8 }, { x: 8, y: 19 }],
  trash: [{ x: 3, y: 6 }, { x: 21, y: 6 }, { x: 8, y: 6 }, { x: 8, y: 6 }, { x: 8, y: 6 }, { x: 16, y: 6 }, { x: 16, y: 6 }, { x: 19, y: 6 }, { x: 19, y: 6 }, { x: 18, y: 20 }, { x: 6, y: 20 }, { x: 6, y: 6 }],
  copy: [{ x: 9, y: 9 }, { x: 9, y: 9 }, { x: 9, y: 21 }, { x: 9, y: 21 }, { x: 9, y: 21 }, { x: 21, y: 21 }, { x: 21, y: 21 }, { x: 21, y: 9 }, { x: 21, y: 9 }, { x: 9, y: 9 }, { x: 9, y: 9 }, { x: 4, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 16 }],
  lock: [{ x: 5, y: 11 }, { x: 5, y: 11 }, { x: 19, y: 11 }, { x: 19, y: 11 }, { x: 19, y: 11 }, { x: 5, y: 11 }, { x: 5, y: 11 }, { x: 8, y: 11 }, { x: 8, y: 11 }, { x: 8, y: 7 }, { x: 8, y: 7 }, { x: 8, y: 7 }, { x: 16, y: 7 }, { x: 16, y: 7 }, { x: 16, y: 11 }],
  unlock: [{ x: 5, y: 11 }, { x: 5, y: 11 }, { x: 19, y: 11 }, { x: 19, y: 11 }, { x: 19, y: 11 }, { x: 5, y: 11 }, { x: 5, y: 11 }, { x: 8, y: 11 }, { x: 8, y: 11 }, { x: 8, y: 7 }, { x: 8, y: 7 }, { x: 8, y: 7 }, { x: 16, y: 7 }, { x: 16, y: 7 }, { x: 16, y: 4 }],
  eye: [{ x: 2, y: 12 }, { x: 12, y: 12 }, { x: 22, y: 12 }, { x: 12, y: 12 }, { x: 2, y: 12 }, { x: 12, y: 5 }, { x: 12, y: 5 }, { x: 19, y: 12 }, { x: 19, y: 12 }, { x: 12, y: 19 }, { x: 12, y: 19 }, { x: 5, y: 12 }],
  'eye-off': [{ x: 2, y: 2 }, { x: 2, y: 2 }, { x: 22, y: 22 }, { x: 9, y: 9 }, { x: 9, y: 9 }, { x: 15, y: 15 }, { x: 15, y: 15 }, { x: 2, y: 12 }, { x: 12, y: 12 }, { x: 22, y: 12 }],
};

// ---- Tool factory -----------------------------------------------------------

export function createCanvasTools(ctx: CanvasToolContext) {
  // =====================================================================
  // CORE CANVAS OPS (existing)
  // =====================================================================

  const createShape = defineTool({
    name: 'canvas_create_shape',
    label: 'Create Shape',
    description:
      'Create a new shape on the canvas. Use this to add rectangles, ellipses, text, lines, frames (artboards), or groups. ' +
      'Returns the new shape id. The shape appears immediately on every viewer\'s screen.',
    promptSnippet: 'Create canvas shapes (rectangle, ellipse, text, line, frame).',
    promptGuidelines: [
      'When the user asks to "add" / "draw" / "create" / "put" a shape, use canvas_create_shape.',
      'Always specify `type`, `x`, `y`, `width`, `height`. For text shapes include `text`, `fontSize`, `textColor`.',
      'Coordinates are canvas-space pixels; the visible area at zoom 1 is roughly 0..1200 x 0..800.',
    ],
    parameters: ShapeInputSchema,
    async execute(toolCallId, params) {
      const id = crypto.randomUUID();
      const coerced = coerceShapeInput(params);
      // Default type to 'rectangle' if the LLM omitted it.
      if (!coerced.type) coerced.type = 'rectangle';
      const patch: CanvasPatch = {
        op: 'add',
        shapeId: id,
        shape: { id, ...coerced, zIndex: ctx.getShapes().length },
        summary: `Created ${coerced.type}${params.name ? ` "${params.name}"` : ''} at (${coerced.x ?? 0}, ${coerced.y ?? 0})`,
      };
      ctx.applyPatch(patch);
      return {
        content: [
          {
            type: 'text',
            text: `Created ${coerced.type} with id ${id}. Coordinates: (${coerced.x ?? 0}, ${coerced.y ?? 0}), size ${coerced.width ?? 100}×${coerced.height ?? 100}.`,
          },
        ],
        details: { shapeId: id, patch },
      };
    },
  });

  const updateShape = defineTool({
    name: 'canvas_update_shape',
    label: 'Update Shape',
    description:
      'Update one or more properties of an existing shape. Only the fields you provide are changed; others stay the same. ' +
      'Use this to move, resize, recolor, or edit text. Returns the patched shape.',
    promptSnippet: 'Update properties of an existing shape (position, size, fill, text, …).',
    promptGuidelines: [
      'Call canvas_list_shapes first if you don\'t know the id.',
      'You may pass any subset of shape properties — only the ones you include are changed.',
      'To change text content, set `text`. To change color, set `fill` (hex like #ff0000).',
    ],
    parameters: Type.Object({
      shapeId: Type.Optional(Type.String({ description: 'ID of the shape to update (alias: id)' })),
      id: Type.Optional(Type.String({ description: 'Alias for shapeId' })),
      changes: ShapeInputSchema,
    }),
    async execute(toolCallId, params) {
      // Tolerate LLMs that pass `id` instead of `shapeId`.
      const shapeId = params.shapeId ?? (params as any).id;
      const existing = ctx.getShapes().find((s) => s.id === shapeId);
      if (!existing) {
        return {
          content: [{ type: 'text', text: `Error: no shape with id ${shapeId}` }],
          details: { error: 'not_found', shapeId },
          isError: true as any,
        };
      }
      // Tolerate LLMs that pass changes as top-level fields instead of
      // nesting them under `changes`. If `changes` is missing/empty but
      // the LLM passed x/y/fill/etc at the top level, treat those as the
      // changes.
      let rawChanges = params.changes;
      if (!rawChanges || Object.keys(rawChanges).length === 0) {
        // Strip metadata fields, keep shape fields.
        const { shapeId: _s, id: _i, changes: _c, ...rest } = params as any;
        rawChanges = rest;
      }
      const coerced = coerceShapeInput(rawChanges);
      // If the LLM passed no actual changes, bail out gracefully.
      if (Object.keys(coerced).length === 0) {
        return {
          content: [{ type: 'text', text: `No changes provided for ${existing.name}.` }],
          details: { shapeId },
        };
      }
      const patch: CanvasPatch = {
        op: 'update',
        shapeId,
        shape: coerced,
        summary: `Updated ${existing.name}: ${Object.keys(coerced).join(', ')}`,
      };
      ctx.applyPatch(patch);
      return {
        content: [
          { type: 'text', text: `Updated ${existing.name} (${shapeId}). Changed: ${Object.keys(coerced).join(', ')}.` },
        ],
        details: { shapeId, patch },
      };
    },
  });

  const deleteShape = defineTool({
    name: 'canvas_delete_shape',
    label: 'Delete Shape',
    description: 'Delete one or more shapes from the canvas by id. This is permanent for the current session.',
    promptSnippet: 'Delete shapes by id.',
    promptGuidelines: [
      'Use canvas_list_shapes to find ids before deleting.',
      'You can delete multiple shapes in one call by passing multiple ids.',
    ],
    parameters: Type.Object({
      shapeIds: Type.Array(Type.String(), { description: 'Ids of shapes to delete' }),
    }),
    async execute(toolCallId, params) {
      const existing = ctx.getShapes().filter((s) => params.shapeIds.includes(s.id));
      if (existing.length === 0) {
        return {
          content: [{ type: 'text', text: `No shapes found with ids: ${params.shapeIds.join(', ')}` }],
          details: { error: 'not_found' },
          isError: true as any,
        };
      }
      const patch: CanvasPatch = {
        op: 'remove',
        shapeIds: params.shapeIds,
        summary: `Deleted ${existing.length} shape${existing.length === 1 ? '' : 's'}: ${existing.map((s) => s.name).join(', ')}`,
      };
      ctx.applyPatch(patch);
      return {
        content: [{ type: 'text', text: `Deleted ${existing.length} shape(s): ${existing.map((s) => `${s.name} (${s.id})`).join(', ')}.` }],
        details: { patch, deletedCount: existing.length },
      };
    },
  });

  const listShapes = defineTool({
    name: 'canvas_list_shapes',
    label: 'List Shapes',
    description:
      'List every shape currently on the canvas. Returns each shape\'s id, name, type, position, size, and key style. ' +
      'Always call this before mutating existing shapes if you don\'t already know the ids.',
    promptSnippet: 'List all shapes on the canvas with their ids and properties.',
    promptGuidelines: [
      'Call this before update/delete operations to find the right shape id.',
    ],
    parameters: Type.Object({}),
    async execute(toolCallId, params) {
      const shapes = ctx.getShapes();
      const r = (v: unknown) => { const n = typeof v === 'number' ? v : Number(v); return Number.isFinite(n) ? Math.round(n) : 0; };
      const summary = shapes
        .map(
          (s) =>
            `• ${s.id} | ${s.type} "${s.name}" | pos=(${r(s.x)},${r(s.y)}) size=${r(s.width)}×${r(s.height)} fill=${s.fill}${s.text ? ` text="${s.text}"` : ''}`,
        )
        .join('\n');
      // (s.text ? ... : '') guards against undefined — only shows text= when there's actual text.
      return {
        content: [
          {
            type: 'text',
            text: shapes.length === 0
              ? 'Canvas is empty. No shapes yet.'
              : `${shapes.length} shape(s) on canvas:\n${summary}`,
          },
        ],
        details: { count: shapes.length, shapes },
      };
    },
  });

  const clearCanvas = defineTool({
    name: 'canvas_clear',
    label: 'Clear Canvas',
    description: 'Remove every shape from the canvas. Use sparingly — this is destructive and cannot be undone in this demo.',
    promptSnippet: 'Wipe the canvas clean.',
    promptGuidelines: [
      'Only use when the user explicitly asks to "clear" or "start over".',
    ],
    parameters: Type.Object({}),
    async execute(toolCallId, params) {
      const patch: CanvasPatch = { op: 'clear', summary: 'Cleared canvas' };
      ctx.applyPatch(patch);
      return {
        content: [{ type: 'text', text: 'Canvas cleared.' }],
        details: { patch },
      };
    },
  });

  const setBackground = defineTool({
    name: 'canvas_set_background',
    label: 'Set Background',
    description: 'Set the canvas background color.',
    promptSnippet: 'Set canvas background color.',
    parameters: Type.Object({
      color: Type.String({ description: 'Background color hex, e.g. #ffffff' }),
    }),
    async execute(toolCallId, params) {
      const patch: CanvasPatch = {
        op: 'background',
        background: params.color,
        summary: `Set background to ${params.color}`,
      };
      ctx.applyPatch(patch);
      return {
        content: [{ type: 'text', text: `Canvas background set to ${params.color}.` }],
        details: { patch },
      };
    },
  });

  const selectShape = defineTool({
    name: 'canvas_select_shape',
    label: 'Select Shape',
    description:
      'Visually highlight one or more shapes on the canvas (a brief flash). Use this to point at a shape you just created or are describing.',
    promptSnippet: 'Visually highlight shapes on the canvas.',
    parameters: Type.Object({
      shapeIds: Type.Array(Type.String(), { description: 'Ids to select' }),
    }),
    async execute(toolCallId, params) {
      const patch: CanvasPatch = {
        op: 'select',
        shapeIds: params.shapeIds,
        summary: `Selected ${params.shapeIds.length} shape(s)`,
      };
      ctx.applyPatch(patch);
      return {
        content: [{ type: 'text', text: `Highlighted ${params.shapeIds.length} shape(s).` }],
        details: { patch },
      };
    },
  });

  // =====================================================================
  // LAYER ORGANIZATION (research: Figma layers panel + AI plugins)
  // =====================================================================

  const duplicateShape = defineTool({
    name: 'canvas_duplicate_shape',
    label: 'Duplicate Shapes',
    description:
      'Duplicate one or more shapes. Each copy is offset 24px down-right from its original. ' +
      'Returns the new shape ids. Useful for repeating elements (lists, grids).',
    promptSnippet: 'Duplicate shapes (with new ids).',
    promptGuidelines: [
      'Use this when the user asks to "copy" / "duplicate" / "repeat" a shape.',
      'The duplicate is offset 24px — use canvas_align_shapes or canvas_update_shape to reposition.',
    ],
    parameters: Type.Object({
      shapeIds: Type.Array(Type.String(), { description: 'Ids of shapes to duplicate' }),
      offsetX: Type.Optional(Type.Number({ description: 'Horizontal offset in px (default 24)' })),
      offsetY: Type.Optional(Type.Number({ description: 'Vertical offset in px (default 24)' })),
    }),
    async execute(toolCallId, params) {
      const ox = params.offsetX ?? 24;
      const oy = params.offsetY ?? 24;
      const patch: CanvasPatch = {
        op: 'duplicate',
        shapeIds: params.shapeIds,
        summary: `Duplicated ${params.shapeIds.length} shape(s)`,
      };
      // The patch ops carry the offset implicitly (see patch.ts duplicate case).
      // We can't pass per-call offsets through CanvasPatch without extending
      // the type — so we ignore custom offsets here and apply the default.
      // (If the user really needs custom offsets, they can update_shape after.)
      void ox; void oy;
      ctx.applyPatch(patch);
      return {
        content: [{ type: 'text', text: `Duplicated ${params.shapeIds.length} shape(s) (offset 24px).` }],
        details: { patch },
      };
    },
  });

  const groupShapes = defineTool({
    name: 'canvas_group_shapes',
    label: 'Group Shapes',
    description:
      'Wrap one or more shapes in a group. The group becomes a new container shape with its own bounding box; ' +
      'children keep their position but gain a parentId pointing at the group. Use this to organize related shapes.',
    promptSnippet: 'Wrap shapes in a group.',
    parameters: Type.Object({
      shapeIds: Type.Array(Type.String(), { description: 'Ids to group' }),
      name: Type.Optional(Type.String({ description: 'Optional group name' })),
    }),
    async execute(toolCallId, params) {
      const patch: CanvasPatch = {
        op: 'group',
        shapeIds: params.shapeIds,
        summary: `Grouped ${params.shapeIds.length} shape(s)${params.name ? ` as "${params.name}"` : ''}`,
      };
      ctx.applyPatch(patch);
      return {
        content: [{ type: 'text', text: `Grouped ${params.shapeIds.length} shape(s).` }],
        details: { patch },
      };
    },
  });

  const ungroupShapes = defineTool({
    name: 'canvas_ungroup_shapes',
    label: 'Ungroup Shapes',
    description: 'Dissolve one or more groups. Children keep their position; their parentId is cleared.',
    promptSnippet: 'Dissolve groups.',
    parameters: Type.Object({
      groupIds: Type.Array(Type.String(), { description: 'Ids of group shapes to dissolve' }),
    }),
    async execute(toolCallId, params) {
      const patch: CanvasPatch = {
        op: 'ungroup',
        shapeIds: params.groupIds,
        summary: `Ungrouped ${params.groupIds.length} group(s)`,
      };
      ctx.applyPatch(patch);
      return {
        content: [{ type: 'text', text: `Ungrouped ${params.groupIds.length} group(s).` }],
        details: { patch },
      };
    },
  });

  const alignShapes = defineTool({
    name: 'canvas_align_shapes',
    label: 'Align / Distribute Shapes',
    description:
      'Align or distribute multiple shapes. Alignment snaps to min/max/average; distribution spaces them evenly. ' +
      'Requires at least 2 shapes for alignment, 3+ for distribution.',
    promptSnippet: 'Align or distribute shapes (left/right/center/top/bottom/distribute).',
    parameters: Type.Object({
      shapeIds: Type.Array(Type.String(), { description: 'Ids of shapes to align (min 2)' }),
      kind: Type.Union(
        [
          Type.Literal('left'),
          Type.Literal('right'),
          Type.Literal('center_h'),
          Type.Literal('top'),
          Type.Literal('bottom'),
          Type.Literal('center_v'),
          Type.Literal('distribute_h'),
          Type.Literal('distribute_v'),
        ],
        { description: 'Alignment kind' },
      ),
    }),
    async execute(toolCallId, params) {
      const patch: CanvasPatch = {
        op: 'align',
        shapeIds: params.shapeIds,
        alignKind: params.kind,
        summary: `Aligned ${params.shapeIds.length} shape(s) ${params.kind}`,
      };
      ctx.applyPatch(patch);
      return {
        content: [{ type: 'text', text: `Aligned ${params.shapeIds.length} shape(s) (${params.kind}).` }],
        details: { patch },
      };
    },
  });

  const organizeLayers = defineTool({
    name: 'canvas_organize_layers',
    label: 'Organize Layers',
    description:
      'Automatically rename and re-zIndex all shapes based on type and reading order. ' +
      'Rectangles become "Card N", ellipses "Ellipse N", text shapes take their text content (truncated), ' +
      'frames become "Frame N". Useful for cleaning up messy canvases.',
    promptSnippet: 'Auto-rename and re-order layers by type and position.',
    parameters: Type.Object({}),
    async execute(toolCallId, params) {
      const shapes = ctx.getShapes();
      const counters: Record<string, number> = {};
      const updates: Array<{ id: string; changes: Partial<Shape> }> = [];
      // Sort by reading order: top-to-bottom, left-to-right.
      const sorted = [...shapes].sort((a, b) => (a.y - b.y) || (a.x - b.x));
      sorted.forEach((s, idx) => {
        counters[s.type] = (counters[s.type] ?? 0) + 1;
        let name = `${capitalize(s.type)} ${counters[s.type]}`;
        if (s.type === 'text' && s.text) {
          name = s.text.slice(0, 24) + (s.text.length > 24 ? '…' : '');
        }
        updates.push({ id: s.id, changes: { name, zIndex: idx } });
      });
      const patch: CanvasPatch = {
        op: 'update_many',
        updates,
        summary: `Organized ${updates.length} layer(s)`,
      };
      ctx.applyPatch(patch);
      return {
        content: [{ type: 'text', text: `Reorganized ${updates.length} layer(s).` }],
        details: { patch, count: updates.length },
      };
    },
  });

  // =====================================================================
  // AUTO LAYOUT (research: Figma Auto Layout)
  // =====================================================================

  const applyAutoLayout = defineTool({
    name: 'canvas_apply_auto_layout',
    label: 'Apply Auto Layout',
    description:
      'Apply an Auto Layout configuration to a frame or group. The container\'s children will be arranged ' +
      'automatically based on direction, gap, padding, and alignment (mirrors Figma Auto Layout). ' +
      'Only meaningful for `frame` or `group` shapes.',
    promptSnippet: 'Configure Auto Layout on a frame/group (direction, gap, padding, alignment).',
    promptGuidelines: [
      'The frame must already exist — create it with canvas_create_shape first.',
      'Children (shapes whose parentId points at this frame) will be repositioned.',
    ],
    parameters: Type.Object({
      frameId: Type.String({ description: 'ID of the frame/group to apply Auto Layout to' }),
      direction: Type.Union([Type.Literal('horizontal'), Type.Literal('vertical')], { description: 'Layout direction' }),
      gap: Type.Optional(Type.Number({ description: 'Gap between children in px (default 8)' })),
      padding: Type.Optional(Type.Number({ description: 'Inner padding in px (default 16)' })),
      alignX: Type.Optional(Type.Union([Type.Literal('min'), Type.Literal('center'), Type.Literal('max')], { description: 'Horizontal alignment (default center)' })),
      alignY: Type.Optional(Type.Union([Type.Literal('min'), Type.Literal('center'), Type.Literal('max')], { description: 'Vertical alignment (default center)' })),
    }),
    async execute(toolCallId, params) {
      const frame = ctx.getShapes().find((s) => s.id === params.frameId);
      if (!frame) {
        return {
          content: [{ type: 'text', text: `Error: no frame with id ${params.frameId}` }],
          details: { error: 'not_found' },
          isError: true as any,
        };
      }
      const autoLayout: AutoLayout = {
        direction: params.direction,
        gap: params.gap ?? 8,
        padding: params.padding ?? 16,
        alignX: params.alignX ?? 'center',
        alignY: params.alignY ?? 'center',
      };
      // Find children, reposition them per the auto-layout rules.
      const children = ctx.getShapes().filter((s) => s.parentId === params.frameId);
      const updates: Array<{ id: string; changes: Partial<Shape> }> = [];
      const pad = autoLayout.padding;
      if (autoLayout.direction === 'horizontal') {
        let cursor = frame.x + pad;
        for (const child of children) {
          const cy =
            autoLayout.alignY === 'min' ? frame.y + pad :
            autoLayout.alignY === 'max' ? frame.y + frame.height - pad - child.height :
            frame.y + (frame.height - child.height) / 2;
          updates.push({ id: child.id, changes: { x: cursor, y: cy } });
          cursor += child.width + autoLayout.gap;
        }
      } else {
        let cursor = frame.y + pad;
        for (const child of children) {
          const cx =
            autoLayout.alignX === 'min' ? frame.x + pad :
            autoLayout.alignX === 'max' ? frame.x + frame.width - pad - child.width :
            frame.x + (frame.width - child.width) / 2;
          updates.push({ id: child.id, changes: { x: cx, y: cursor } });
          cursor += child.height + autoLayout.gap;
        }
      }
      // First update the frame itself (set autoLayout), then update children.
      const framePatch: CanvasPatch = {
        op: 'update',
        shapeId: params.frameId,
        shape: { autoLayout },
        summary: `Applied ${autoLayout.direction} Auto Layout to "${frame.name}"`,
      };
      ctx.applyPatch(framePatch);
      if (updates.length > 0) {
        const childrenPatch: CanvasPatch = {
          op: 'update_many',
          updates,
          summary: `Repositioned ${updates.length} child(ren) per Auto Layout`,
        };
        ctx.applyPatch(childrenPatch);
      }
      return {
        content: [
          {
            type: 'text',
            text: `Applied ${autoLayout.direction} Auto Layout to frame "${frame.name}" (gap=${autoLayout.gap}, pad=${autoLayout.padding}). ${updates.length} children repositioned.`,
          },
        ],
        details: { patch: framePatch, childrenCount: updates.length },
      };
    },
  });

  // =====================================================================
  // COMPONENTS & VARIANTS (research: Figma components + AI plugins)
  // =====================================================================

  const createComponent = defineTool({
    name: 'canvas_create_component',
    label: 'Create Component',
    description:
      'Mark an existing shape as a reusable component (sets componentId = its own id, so it can be instantiated). ' +
      'The shape becomes the "main instance" — future calls to canvas_instantiate_component create linked copies.',
    promptSnippet: 'Turn a shape into a reusable component.',
    parameters: Type.Object({
      shapeId: Type.String({ description: 'ID of the shape to mark as a component' }),
    }),
    async execute(toolCallId, params) {
      const shape = ctx.getShapes().find((s) => s.id === params.shapeId);
      if (!shape) {
        return {
          content: [{ type: 'text', text: `Error: no shape with id ${params.shapeId}` }],
          details: { error: 'not_found' },
          isError: true as any,
        };
      }
      const patch: CanvasPatch = {
        op: 'update',
        shapeId: params.shapeId,
        shape: { componentId: params.shapeId, name: `Component: ${shape.name}` },
        summary: `Marked "${shape.name}" as a component`,
      };
      ctx.applyPatch(patch);
      return {
        content: [{ type: 'text', text: `Shape ${params.shapeId} is now a component.` }],
        details: { patch, componentId: params.shapeId },
      };
    },
  });

  const instantiateComponent = defineTool({
    name: 'canvas_instantiate_component',
    label: 'Instantiate Component',
    description:
      'Create a linked instance of an existing component. The instance copies the component\'s shape but ' +
      'gets a new id and componentId pointing at the original. Useful for placing the same UI element multiple times.',
    promptSnippet: 'Place a linked instance of a component.',
    parameters: Type.Object({
      componentId: Type.String({ description: 'ID of the source component' }),
      x: Type.Number({ description: 'X position for the new instance' }),
      y: Type.Number({ description: 'Y position for the new instance' }),
    }),
    async execute(toolCallId, params) {
      const src = ctx.getShapes().find((s) => s.id === params.componentId);
      if (!src) {
        return {
          content: [{ type: 'text', text: `Error: no component with id ${params.componentId}` }],
          details: { error: 'not_found' },
          isError: true as any,
        };
      }
      const id = crypto.randomUUID();
      const patch: CanvasPatch = {
        op: 'add',
        shapeId: id,
        shape: {
          id,
          type: src.type,
          name: `${src.name} instance`,
          x: params.x,
          y: params.y,
          width: src.width,
          height: src.height,
          fill: src.fill,
          stroke: src.stroke,
          strokeWidth: src.strokeWidth,
          radius: src.radius,
          text: src.text,
          fontSize: src.fontSize,
          textColor: src.textColor,
          componentId: params.componentId,
          zIndex: ctx.getShapes().length,
        },
        summary: `Instantiated component "${src.name}" at (${params.x}, ${params.y})`,
      };
      ctx.applyPatch(patch);
      return {
        content: [{ type: 'text', text: `Created instance ${id} of component ${params.componentId}.` }],
        details: { patch, instanceId: id },
      };
    },
  });

  // =====================================================================
  // DESIGN TOKENS / VARIABLES (research: Figma Variables + AI design systems)
  // =====================================================================

  const updateTokens = defineTool({
    name: 'canvas_update_tokens',
    label: 'Update Design Tokens',
    description:
      'Update the document\'s design tokens — named colors and text styles that shapes can bind to. ' +
      'When a token changes, every shape bound to it (via tokenBinding) is recolored automatically. ' +
      'Pass only the tokens you want to add or change; existing ones are merged by key.',
    promptSnippet: 'Update design tokens (color palette, text styles).',
    promptGuidelines: [
      'Token keys use dotted paths: `bg.primary`, `accent`, `text.heading`, etc.',
      'After updating tokens, use canvas_apply_palette to bind shapes to them.',
    ],
    parameters: Type.Object({
      colors: Type.Optional(Type.Array(
        Type.Object({
          name: Type.String({ description: 'Human label, e.g. "Primary blue"' }),
          key: Type.String({ description: 'Token key, e.g. "accent" or "bg.primary"' }),
          value: Type.String({ description: 'Hex color, e.g. #0ea5e9' }),
        }),
        { description: 'Color tokens to add/update' },
      )),
      textStyles: Type.Optional(Type.Array(
        Type.Object({
          name: Type.String({ description: 'Style label, e.g. "Heading L"' }),
          key: Type.String({ description: 'Token key, e.g. "text.heading.l"' }),
          fontSize: Type.Number({ description: 'Font size in px' }),
          fontWeight: Type.Optional(Type.Number({ description: 'Font weight 100..900 (default 400)' })),
          lineHeight: Type.Optional(Type.Number({ description: 'Line height ratio (default 1.4)' })),
          color: Type.String({ description: 'Text color hex' }),
        }),
        { description: 'Text style tokens to add/update' },
      )),
    }),
    async execute(toolCallId, params) {
      const colors: ColorToken[] = (params.colors ?? []).map((c) => ({
        name: c.name,
        key: c.key,
        value: c.value,
      }));
      const textStyles: TextStyleToken[] = (params.textStyles ?? []).map((t) => ({
        name: t.name,
        key: t.key,
        fontSize: t.fontSize,
        fontWeight: t.fontWeight ?? 400,
        lineHeight: t.lineHeight ?? 1.4,
        color: t.color,
      }));
      const patch: CanvasPatch = {
        op: 'tokens',
        tokens: { colors, textStyles },
        summary: `Updated ${colors.length} color(s), ${textStyles.length} text style(s)`,
      };
      ctx.applyPatch(patch);
      return {
        content: [{ type: 'text', text: `Tokens updated: ${colors.length} colors, ${textStyles.length} text styles.` }],
        details: { patch, colorCount: colors.length, textStyleCount: textStyles.length },
      };
    },
  });

  const applyPalette = defineTool({
    name: 'canvas_apply_palette',
    label: 'Apply Palette to Shapes',
    description:
      'Recolor a set of shapes using a new palette. Each shape\'s fill is mapped to the closest color in the palette ' +
      'by perceptual distance (HSL). Useful for "re-skinning" an existing layout without rebuilding it. ' +
      'Optionally binds the shapes to design tokens (so future palette changes propagate automatically).',
    promptSnippet: 'Recolor shapes by mapping to a new palette (nearest match).',
    parameters: Type.Object({
      shapeIds: Type.Array(Type.String(), { description: 'Ids of shapes to recolor' }),
      palette: Type.Array(Type.String(), { description: 'Array of hex colors to map to (e.g. ["#0f172a","#0ea5e9","#f8fafc"])' }),
      bindToTokens: Type.Optional(Type.Boolean({ description: 'If true, create/update design tokens and bind shapes to them (default false)' })),
    }),
    async execute(toolCallId, params) {
      const shapes = ctx.getShapes().filter((s) => params.shapeIds.includes(s.id));
      if (shapes.length === 0) {
        return {
          content: [{ type: 'text', text: 'No matching shapes found.' }],
          details: { error: 'not_found' },
          isError: true as any,
        };
      }
      const paletteHsl = params.palette.map((hex) => ({ hex, hsl: hexToHsl(hex) }));
      const updates: Array<{ id: string; changes: Partial<Shape> }> = [];
      for (const s of shapes) {
        const sHsl = hexToHsl(s.fill);
        // Nearest by Euclidean distance in HSL space.
        let best = paletteHsl[0];
        let bestD = Infinity;
        for (const p of paletteHsl) {
          const dh = Math.min(Math.abs(sHsl.h - p.hsl.h), 360 - Math.abs(sHsl.h - p.hsl.h));
          const ds = sHsl.s - p.hsl.s;
          const dl = sHsl.l - p.hsl.l;
          const d = Math.sqrt(dh * dh + ds * ds + dl * dl);
          if (d < bestD) { bestD = d; best = p; }
        }
        const changes: Partial<Shape> = { fill: best.hex };
        if (s.type === 'text') {
          // For text, prefer a darker palette color.
          const darkest = [...paletteHsl].sort((a, b) => a.hsl.l - b.hsl.l)[0];
          changes.textColor = darkest.hex;
          changes.fill = s.fill; // keep text shape's "fill" semantics
        }
        updates.push({ id: s.id, changes });
      }
      const patch: CanvasPatch = {
        op: 'update_many',
        updates,
        summary: `Applied palette (${params.palette.length} colors) to ${updates.length} shape(s)`,
      };
      ctx.applyPatch(patch);
      // Optional: create tokens and bind.
      if (params.bindToTokens) {
        const colors: ColorToken[] = params.palette.map((hex, i) => ({
          name: `Palette ${i + 1}`,
          key: `palette.${i + 1}`,
          value: hex,
        }));
        const tokenPatch: CanvasPatch = {
          op: 'tokens',
          tokens: { colors, textStyles: [] },
          summary: `Saved palette as ${colors.length} color tokens`,
        };
        ctx.applyPatch(tokenPatch);
      }
      return {
        content: [{ type: 'text', text: `Applied palette to ${updates.length} shape(s).${params.bindToTokens ? ' Palette also saved as tokens.' : ''}` }],
        details: { patch, count: updates.length },
      };
    },
  });

  const generatePalette = defineTool({
    name: 'canvas_generate_palette',
    label: 'Generate Harmonious Palette',
    description:
      'Generate a harmonious 5-color palette from a base color using color-theory rules. ' +
      'Returns the palette as a list of hex colors AND saves them as design tokens. ' +
      'Rules: analogous (adjacent hues), complementary (opposite), triadic (3 evenly spaced), ' +
      'monochromatic (variations of one hue), or split-complementary.',
    promptSnippet: 'Generate a 5-color palette from a base color (analogous, complementary, triadic, etc.).',
    parameters: Type.Object({
      baseColor: Type.String({ description: 'Base hex color, e.g. #0ea5e9' }),
      rule: Type.Union(
        [
          Type.Literal('analogous'),
          Type.Literal('complementary'),
          Type.Literal('triadic'),
          Type.Literal('monochromatic'),
          Type.Literal('split_complementary'),
        ],
        { description: 'Color harmony rule' },
      ),
    }),
    async execute(toolCallId, params) {
      const base = hexToHsl(params.baseColor);
      let hues: number[] = [];
      switch (params.rule) {
        case 'analogous':
          hues = [base.h - 30, base.h - 15, base.h, base.h + 15, base.h + 30];
          break;
        case 'complementary':
          hues = [base.h, base.h, base.h, (base.h + 180) % 360, (base.h + 180) % 360];
          break;
        case 'triadic':
          hues = [base.h, (base.h + 120) % 360, (base.h + 240) % 360, base.h, (base.h + 120) % 360];
          break;
        case 'monochromatic':
          hues = [base.h, base.h, base.h, base.h, base.h];
          break;
        case 'split_complementary':
          hues = [base.h, base.h, (base.h + 150) % 360, (base.h + 210) % 360, base.h];
          break;
      }
      // Vary lightness across the palette.
      const lightnesses = params.rule === 'monochromatic'
        ? [25, 45, 60, 75, 90]
        : [35, 55, 70, 80, 90];
      const palette = hues.map((h, i) => {
        const hh = ((h % 360) + 360) % 360;
        return hslToHex(hh, base.s, lightnesses[i]);
      });
      // Save as tokens.
      const colors: ColorToken[] = palette.map((hex, i) => ({
        name: `${capitalize(params.rule)} ${i + 1}`,
        key: `palette.${i + 1}`,
        value: hex,
      }));
      const patch: CanvasPatch = {
        op: 'tokens',
        tokens: { colors, textStyles: [] },
        summary: `Generated ${params.rule} palette from ${params.baseColor}`,
      };
      ctx.applyPatch(patch);
      return {
        content: [
          {
            type: 'text',
            text: `Generated ${params.rule} palette: ${palette.join(', ')}.\nSaved as palette.1..palette.5 tokens. Use canvas_apply_palette to apply to shapes.`,
          },
        ],
        details: { patch, palette, rule: params.rule },
      };
    },
  });

  // =====================================================================
  // WIREFRAME GENERATION (research: Uizard / Galileo AI / Figma Make)
  // =====================================================================

  const generateWireframe = defineTool({
    name: 'canvas_generate_wireframe',
    label: 'Generate Wireframe',
    description:
      'Generate a wireframe layout from a template. Places a frame plus placeholder shapes (low-fidelity, grayscale). ' +
      'Templates: mobile_login, mobile_signup, mobile_dashboard, web_landing, web_dashboard, web_blog, web_pricing. ' +
      'The frame is placed at (x, y) with the template\'s default size.',
    promptSnippet: 'Generate a wireframe screen from a template (mobile/web).',
    promptGuidelines: [
      'Use this for "make a login screen", "design a dashboard", "wireframe a landing page", etc.',
      'After generating, you can recolor with canvas_apply_palette and refine with canvas_update_shape.',
    ],
    parameters: Type.Object({
      template: Type.Union(
        [
          Type.Literal('mobile_login'),
          Type.Literal('mobile_signup'),
          Type.Literal('mobile_dashboard'),
          Type.Literal('web_landing'),
          Type.Literal('web_dashboard'),
          Type.Literal('web_blog'),
          Type.Literal('web_pricing'),
        ],
        { description: 'Wireframe template' },
      ),
      x: Type.Optional(Type.Number({ description: 'Frame X position (default 100)' })),
      y: Type.Optional(Type.Number({ description: 'Frame Y position (default 100)' })),
    }),
    async execute(toolCallId, params) {
      const x = params.x ?? 100;
      const y = params.y ?? 100;
      const wf = buildWireframe(params.template, x, y);
      const patch: CanvasPatch = {
        op: 'bulk_add',
        shapes: wf.shapes,
        summary: `Generated ${params.template} wireframe (${wf.shapes.length} shapes)`,
      };
      ctx.applyPatch(patch);
      return {
        content: [
          {
            type: 'text',
            text: `Generated ${params.template} wireframe at (${x}, ${y}). ${wf.shapes.length} shapes added. Frame id: ${wf.frameId}.`,
          },
        ],
        details: { patch, frameId: wf.frameId, count: wf.shapes.length },
      };
    },
  });

  // =====================================================================
  // MULTI-SCREEN USER FLOWS (research: UX Pilot, Galileo AI)
  // =====================================================================

  const generateUserFlow = defineTool({
    name: 'canvas_generate_user_flow',
    label: 'Generate Multi-Screen User Flow',
    description:
      'Generate a connected series of screens representing a user flow. Places 3-5 frames side by side with arrows between them. ' +
      'Flows: onboarding (3 steps: welcome → permissions → done), ecommerce (browse → product → cart → checkout), ' +
      'auth (login → mfa → home), signup_funnel (landing → signup → verify → dashboard). ' +
      'Each screen is a wireframe; arrows connect them left-to-right.',
    promptSnippet: 'Generate a multi-screen user flow (onboarding, ecommerce, auth, signup).',
    parameters: Type.Object({
      flow: Type.Union(
        [
          Type.Literal('onboarding'),
          Type.Literal('ecommerce'),
          Type.Literal('auth'),
          Type.Literal('signup_funnel'),
        ],
        { description: 'User flow template' },
      ),
      x: Type.Optional(Type.Number({ description: 'Start X (default 80)' })),
      y: Type.Optional(Type.Number({ description: 'Start Y (default 80)' })),
    }),
    async execute(toolCallId, params) {
      const x = params.x ?? 80;
      const y = params.y ?? 80;
      const flow = buildUserFlow(params.flow, x, y);
      const patch: CanvasPatch = {
        op: 'bulk_add',
        shapes: flow.shapes,
        summary: `Generated ${params.flow} user flow (${flow.shapes.length} shapes, ${flow.frameIds.length} screens)`,
      };
      ctx.applyPatch(patch);
      return {
        content: [
          {
            type: 'text',
            text: `Generated ${params.flow} user flow at (${x}, ${y}). ${flow.frameIds.length} screens, ${flow.shapes.length} shapes total.`,
          },
        ],
        details: { patch, frameIds: flow.frameIds, count: flow.shapes.length },
      };
    },
  });

  // =====================================================================
  // DIAGRAM GENERATION (research: Figma AI diagrams)
  // =====================================================================

  const generateDiagram = defineTool({
    name: 'canvas_generate_diagram',
    label: 'Generate Diagram',
    description:
      'Generate a flowchart or mind-map diagram from a list of nodes. Nodes can be linked with arrows. ' +
      'Templates: flowchart (top-down boxes with arrows), mindmap (central node with radial children). ' +
      'Pass a list of node labels; the tool computes positions and connectors.',
    promptSnippet: 'Generate a flowchart or mind-map from a list of node labels.',
    parameters: Type.Object({
      template: Type.Union(
        [Type.Literal('flowchart'), Type.Literal('mindmap')],
        { description: 'Diagram template' },
      ),
      nodes: Type.Array(Type.String(), { description: 'Node labels (2-12 nodes)' }),
      x: Type.Optional(Type.Number({ description: 'Diagram X origin (default 200)' })),
      y: Type.Optional(Type.Number({ description: 'Diagram Y origin (default 100)' })),
    }),
    async execute(toolCallId, params) {
      const x = params.x ?? 200;
      const y = params.y ?? 100;
      const diagram = buildDiagram(params.template, params.nodes, x, y);
      const patch: CanvasPatch = {
        op: 'bulk_add',
        shapes: diagram.shapes,
        summary: `Generated ${params.template} diagram (${params.nodes.length} nodes, ${diagram.shapes.length} shapes)`,
      };
      ctx.applyPatch(patch);
      return {
        content: [
          {
            type: 'text',
            text: `Generated ${params.template} diagram at (${x}, ${y}). ${params.nodes.length} nodes, ${diagram.shapes.length} total shapes.`,
          },
        ],
        details: { patch, count: diagram.shapes.length },
      };
    },
  });

  // =====================================================================
  // ATTENTION HEATMAP PREDICTION (research: Uizard predictive heat map)
  // =====================================================================

  const predictHeatmap = defineTool({
    name: 'canvas_predict_heatmap',
    label: 'Predict Attention Heatmap',
    description:
      'Generate a predicted attention heatmap overlay for a frame. Uses a heuristic model: high intensity near ' +
      'text shapes (especially large headings), top-left of the frame, and contrasting colors. ' +
      'The heatmap renders as a semi-transparent overlay on the canvas. Pass `clear: true` to remove an existing overlay.',
    promptSnippet: 'Show a predicted attention heatmap over a frame.',
    parameters: Type.Object({
      frameId: Type.String({ description: 'ID of the frame to analyze' }),
      clear: Type.Optional(Type.Boolean({ description: 'If true, remove the existing heatmap overlay' })),
    }),
    async execute(toolCallId, params) {
      if (params.clear) {
        const patch: CanvasPatch = {
          op: 'heatmap',
          heatmap: null,
          summary: 'Cleared heatmap overlay',
        };
        ctx.applyPatch(patch);
        return {
          content: [{ type: 'text', text: 'Heatmap overlay cleared.' }],
          details: { patch },
        };
      }
      const frame = ctx.getShapes().find((s) => s.id === params.frameId);
      if (!frame) {
        return {
          content: [{ type: 'text', text: `Error: no frame with id ${params.frameId}` }],
          details: { error: 'not_found' },
          isError: true as any,
        };
      }
      // Find shapes inside this frame.
      const children = ctx.getShapes().filter((s) =>
        s.id !== frame.id &&
        s.x >= frame.x && s.x + s.width <= frame.x + frame.width &&
        s.y >= frame.y && s.y + s.height <= frame.y + frame.height,
      );
      // Build heatmap points: one per child, intensity heuristic.
      const points = children.map((c) => {
        let intensity = 0.3;
        if (c.type === 'text') {
          intensity = Math.min(1, 0.5 + c.fontSize / 80);
        } else if (c.type === 'ellipse') {
          intensity = 0.6; // avatars / CTAs draw the eye
        } else if (c.fill && isHighContrast(c.fill, frame.fill)) {
          intensity = 0.7;
        }
        // Top-left bias.
        const relX = (c.x - frame.x) / frame.width;
        const relY = (c.y - frame.y) / frame.height;
        const bias = Math.max(0, 1 - (relX + relY) * 0.8);
        intensity = Math.min(1, intensity + bias * 0.2);
        return {
          x: c.x + c.width / 2,
          y: c.y + c.height / 2,
          intensity,
        };
      });
      const overlay: HeatmapOverlay = {
        frameId: params.frameId,
        x: frame.x,
        y: frame.y,
        width: frame.width,
        height: frame.height,
        points,
        createdAt: Date.now(),
      };
      const patch: CanvasPatch = {
        op: 'heatmap',
        heatmap: overlay,
        summary: `Predicted heatmap for "${frame.name}" (${points.length} fixation points)`,
      };
      ctx.applyPatch(patch);
      return {
        content: [
          {
            type: 'text',
            text: `Generated attention heatmap for frame "${frame.name}". ${points.length} fixation points predicted. Higher-intensity areas are where users are most likely to look first.`,
          },
        ],
        details: { patch, pointCount: points.length },
      };
    },
  });

  // =====================================================================
  // COPY / TEXT GENERATION (research: Figma AI placeholder content)
  // =====================================================================

  const generateCopy = defineTool({
    name: 'canvas_generate_copy',
    label: 'Generate Placeholder Copy',
    description:
      'Generate realistic placeholder copy for a text shape. Variants: heading (short punchy title), ' +
      'subheading (one-sentence subtitle), body (lorem-style paragraph), button (CTA label), caption, microcopy. ' +
      'Updates the text content of an existing text shape in place.',
    promptSnippet: 'Fill a text shape with realistic placeholder copy.',
    parameters: Type.Object({
      shapeId: Type.String({ description: 'ID of the text shape to fill' }),
      variant: Type.Union(
        [
          Type.Literal('heading'),
          Type.Literal('subheading'),
          Type.Literal('body'),
          Type.Literal('button'),
          Type.Literal('caption'),
          Type.Literal('microcopy'),
        ],
        { description: 'Copy variant' },
      ),
      topic: Type.Optional(Type.String({ description: 'Optional topic to anchor the copy (e.g. "project management")' })),
    }),
    async execute(toolCallId, params) {
      const shape = ctx.getShapes().find((s) => s.id === params.shapeId);
      if (!shape) {
        return {
          content: [{ type: 'text', text: `Error: no shape with id ${params.shapeId}` }],
          details: { error: 'not_found' },
          isError: true as any,
        };
      }
      const topic = params.topic?.trim() || 'your product';
      const copy = COPY_VARIANTS[params.variant](topic);
      const patch: CanvasPatch = {
        op: 'update',
        shapeId: params.shapeId,
        shape: { text: copy },
        summary: `Filled "${shape.name}" with ${params.variant} copy`,
      };
      ctx.applyPatch(patch);
      return {
        content: [{ type: 'text', text: `Updated text shape ${params.shapeId} with ${params.variant} copy: "${copy.slice(0, 60)}…"` }],
        details: { patch, copy },
      };
    },
  });

  // =====================================================================
  // DESIGN AUDITING (research: AI design-system audit)
  // =====================================================================

  const auditDesign = defineTool({
    name: 'canvas_audit_design',
    label: 'Audit Design Consistency',
    description:
      'Audit the current canvas for design-consistency issues. Returns a textual report covering: ' +
      'color palette drift (too many distinct colors), spacing inconsistencies, ' +
      'font-size proliferation, low-contrast text, and unaligned shapes. ' +
      'Does NOT mutate the canvas — pure analysis. The agent can then act on the findings.',
    promptSnippet: 'Audit the canvas for design-consistency issues (read-only).',
    parameters: Type.Object({}),
    async execute(toolCallId, params) {
      const shapes = ctx.getShapes();
      const tokens = ctx.getTokens();
      const findings: string[] = [];

      // 1. Color drift
      const colors = new Set<string>();
      for (const s of shapes) {
        colors.add(s.fill.toLowerCase());
        if (s.type === 'text') colors.add(s.textColor.toLowerCase());
      }
      colors.delete('transparent');
      if (colors.size > 8) {
        findings.push(`• Color drift: ${colors.size} distinct colors. Consider consolidating to ≤ 6 + binding to tokens.`);
      } else {
        findings.push(`• Color usage: ${colors.size} distinct colors (good).`);
      }

      // 2. Font sizes
      const fontSizes = new Set<number>();
      for (const s of shapes) {
        if (s.type === 'text') fontSizes.add(s.fontSize);
      }
      if (fontSizes.size > 5) {
        findings.push(`• Type scale: ${fontSizes.size} distinct font sizes (consider a 4-5 step scale).`);
      } else {
        findings.push(`• Type scale: ${fontSizes.size} distinct font sizes (good).`);
      }

      // 3. Low-contrast text
      let lowContrast = 0;
      for (const s of shapes) {
        if (s.type === 'text') {
          const ratio = contrastRatio(s.textColor, s.fill);
          if (ratio < 4.5) {
            lowContrast++;
            findings.push(`• Low-contrast text "${(s.text ?? '').slice(0, 30)}…" on fill ${s.fill}: ratio ${Number.isFinite(ratio) ? ratio.toFixed(1) : '?'} (< 4.5 WCAG AA).`);
          }
        }
      }
      if (lowContrast === 0) findings.push('• Text contrast: all text passes WCAG AA (good).');

      // 4. Tokens usage
      const boundCount = shapes.filter((s) => s.tokenBinding && (s.tokenBinding.fillToken || s.tokenBinding.textToken)).length;
      if (tokens.colors.length === 0) {
        findings.push(`• No design tokens defined — consider using canvas_generate_palette + canvas_apply_palette (bindToTokens=true).`);
      } else {
        findings.push(`• Design tokens: ${tokens.colors.length} color tokens defined; ${boundCount}/${shapes.length} shapes bound.`);
      }

      // 5. Alignment: detect near-misses (shapes that almost align but not quite)
      const xLines = new Map<number, number>();
      for (const s of shapes) {
        const key = Math.round(s.x / 4) * 4;
        xLines.set(key, (xLines.get(key) ?? 0) + 1);
      }
      const misaligned = shapes.filter((s) => {
        const k = Math.round(s.x / 4) * 4;
        return (xLines.get(k) ?? 0) < 2 && (xLines.get(Math.round((s.x + 4) / 4) * 4) ?? 0) >= 2;
      });
      if (misaligned.length > 0) {
        findings.push(`• Possible alignment near-miss: ${misaligned.length} shape(s) within 4px of an alignment grid line.`);
      }

      const report = `Design audit (${shapes.length} shapes, ${tokens.colors.length} tokens):\n${findings.join('\n')}`;
      return {
        content: [{ type: 'text', text: report }],
        details: { findings, colorCount: colors.size, fontSizeCount: fontSizes.size, lowContrastCount: lowContrast },
      };
    },
  });

  // =====================================================================
  // PHASE 1a: TOKEN BINDING (4 tools)
  // Closes the half-wired tokenBinding loop — apply_palette's bindToTokens
  // flag created tokens without binding them; these tools let the agent
  // explicitly bind/unbind shapes to tokens.
  // =====================================================================

  const bindShapeToToken = defineTool({
    name: 'canvas_bind_shape_to_token',
    label: 'Bind Shape to Token',
    description:
      'Bind a shape property (fill, stroke, or textColor) to a named design token. ' +
      'When the token value changes, the bound property auto-updates. ' +
      'Use this after canvas_update_tokens or canvas_apply_palette to create a live link.',
    promptSnippet: 'Bind a shape property to a design token (live link).',
    promptGuidelines: [
      'The tokenKey must match a key in the document\'s color tokens. Call canvas_list_tokens to see available keys.',
      'Binding fill: the shape\'s fill is set to the token value immediately and re-computed on token changes.',
    ],
    parameters: Type.Object({
      shapeId: Type.String({ description: 'ID of the shape to bind' }),
      tokenKey: Type.String({ description: 'Token key (e.g. "bg.primary", "accent")' }),
      property: Type.Union(
        [Type.Literal('fill'), Type.Literal('stroke'), Type.Literal('textColor')],
        { description: 'Which property to bind' },
      ),
    }),
    async execute(toolCallId, params) {
      const shape = ctx.getShapes().find((s) => s.id === params.shapeId);
      if (!shape) {
        return { content: [{ type: 'text', text: `Error: no shape with id ${params.shapeId}` }], details: { error: 'not_found', shapeId: params.shapeId }, isError: true as any };
      }
      const token = ctx.getTokens().colors.find((c) => c.key === params.tokenKey);
      if (!token) {
        return { content: [{ type: 'text', text: `Error: no color token with key "${params.tokenKey}"` }], details: { error: 'token_not_found', tokenKey: params.tokenKey }, isError: true as any };
      }
      const binding = { ...(shape.tokenBinding ?? {}) };
      if (params.property === 'fill') { binding.fillToken = params.tokenKey; }
      else if (params.property === 'stroke') { binding.strokeToken = params.tokenKey; }
      else { binding.textToken = params.tokenKey; }
      const changes: Partial<Shape> = { tokenBinding: binding };
      if (params.property === 'fill') changes.fill = token.value;
      else if (params.property === 'stroke') changes.stroke = token.value;
      else changes.textColor = token.value;
      const patch: CanvasPatch = { op: 'update', shapeId: params.shapeId, shape: changes, summary: `Bound ${params.property} to token "${params.tokenKey}"` };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: `Bound ${shape.name}.${params.property} to token "${params.tokenKey}" (${token.value}).` }], details: { shapeId: params.shapeId, tokenKey: params.tokenKey, property: params.property, patch } };
    },
  });

  const unbindShape = defineTool({
    name: 'canvas_unbind_shape',
    label: 'Unbind Shape from Token',
    description: 'Remove a token binding from a shape property. The shape keeps its current color value but will no longer auto-update when the token changes.',
    promptSnippet: 'Remove a token binding from a shape.',
    parameters: Type.Object({
      shapeId: Type.String({ description: 'ID of the shape to unbind' }),
      property: Type.Union(
        [Type.Literal('fill'), Type.Literal('stroke'), Type.Literal('textColor')],
        { description: 'Which property to unbind' },
      ),
    }),
    async execute(toolCallId, params) {
      const shape = ctx.getShapes().find((s) => s.id === params.shapeId);
      if (!shape) {
        return { content: [{ type: 'text', text: `Error: no shape with id ${params.shapeId}` }], details: { error: 'not_found' }, isError: true as any };
      }
      const binding = { ...(shape.tokenBinding ?? {}) };
      if (params.property === 'fill') delete binding.fillToken;
      else if (params.property === 'stroke') delete binding.strokeToken;
      else delete binding.textToken;
      const patch: CanvasPatch = { op: 'update', shapeId: params.shapeId, shape: { tokenBinding: Object.keys(binding).length === 0 ? null : binding }, summary: `Unbound ${params.property} from token` };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: `Unbound ${shape.name}.${params.property}.` }], details: { shapeId: params.shapeId, property: params.property, patch } };
    },
  });

  const listTokens = defineTool({
    name: 'canvas_list_tokens',
    label: 'List Design Tokens',
    description: 'List all design tokens (colors + text styles) currently defined on the canvas. Read-only — does not modify the canvas. Use this before canvas_bind_shape_to_token to see available token keys.',
    promptSnippet: 'List all design tokens (colors + text styles).',
    parameters: Type.Object({}),
    async execute(toolCallId) {
      const tokens = ctx.getTokens();
      const colorLines = tokens.colors.map((c) => `  ${c.key.padEnd(20)} ${c.value}  (${c.name})`);
      const textLines = tokens.textStyles.map((t) => `  ${t.key.padEnd(20)} ${t.fontSize}px/${t.fontWeight}  ${t.color}  (${t.name})`);
      const report = `=== Color Tokens (${tokens.colors.length}) ===\n${colorLines.join('\n') || '  (none)'}\n\n=== Text Style Tokens (${tokens.textStyles.length}) ===\n${textLines.join('\n') || '  (none)'}`;
      return { content: [{ type: 'text', text: report }], details: { colorCount: tokens.colors.length, textStyleCount: tokens.textStyles.length } };
    },
  });

  const applyToken = defineTool({
    name: 'canvas_apply_token',
    label: 'Apply Token to Shapes',
    description: 'Apply a design token\'s value to one or more shapes. Optionally also bind the shapes to the token (live link). ' +
      'This is the batch version of canvas_bind_shape_to_token.',
    promptSnippet: 'Apply a token value to multiple shapes at once.',
    parameters: Type.Object({
      shapeIds: Type.Array(Type.String(), { description: 'Shape IDs to apply the token to' }),
      tokenKey: Type.String({ description: 'Token key to apply' }),
      property: Type.Union(
        [Type.Literal('fill'), Type.Literal('stroke'), Type.Literal('textColor')],
        { description: 'Which property to set' },
      ),
      bind: Type.Optional(Type.Boolean({ description: 'If true, also create a live binding (default false)' })),
    }),
    async execute(toolCallId, params) {
      const token = ctx.getTokens().colors.find((c) => c.key === params.tokenKey);
      if (!token) {
        return { content: [{ type: 'text', text: `Error: no color token with key "${params.tokenKey}"` }], details: { error: 'token_not_found' }, isError: true as any };
      }
      const shapes = ctx.getShapes();
      const updates = params.shapeIds
        .map((id) => shapes.find((s) => s.id === id))
        .filter((s): s is Shape => !!s)
        .map((s) => {
          const changes: Partial<Shape> = {};
          if (params.property === 'fill') changes.fill = token.value;
          else if (params.property === 'stroke') changes.stroke = token.value;
          else changes.textColor = token.value;
          if (params.bind) {
            const binding = { ...(s.tokenBinding ?? {}) };
            if (params.property === 'fill') binding.fillToken = params.tokenKey;
            else if (params.property === 'stroke') binding.strokeToken = params.tokenKey;
            else binding.textToken = params.tokenKey;
            changes.tokenBinding = binding;
          }
          return { id: s.id, changes };
        });
      if (updates.length === 0) {
        return { content: [{ type: 'text', text: 'No matching shapes found.' }], details: { error: 'not_found' }, isError: true as any };
      }
      const patch: CanvasPatch = { op: 'update_many', updates, summary: `Applied token "${params.tokenKey}" to ${updates.length} shape(s)${params.bind ? ' (bound)' : ''}` };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: `Applied token "${params.tokenKey}" (${token.value}) to ${updates.length} shape(s).` }], details: { count: updates.length, tokenKey: params.tokenKey, patch } };
    },
  });

  // =====================================================================
  // PHASE 1b: LOCK & VISIBILITY (2 tools)
  // The `locked` and `visible` fields exist on Shape but no tool touched
  // them. These tools make them agent-accessible.
  // =====================================================================

  const setLocked = defineTool({
    name: 'canvas_set_locked',
    label: 'Lock / Unlock Shapes',
    description: 'Lock or unlock one or more shapes. Locked shapes cannot be moved or resized by direct manipulation (but can still be updated via tools).',
    promptSnippet: 'Lock or unlock shapes.',
    parameters: Type.Object({
      shapeIds: Type.Array(Type.String(), { description: 'Shape IDs to lock/unlock' }),
      locked: Type.Boolean({ description: 'true to lock, false to unlock' }),
    }),
    async execute(toolCallId, params) {
      const updates = params.shapeIds.map((id) => ({ id, changes: { locked: params.locked } as Partial<Shape> }));
      const patch: CanvasPatch = { op: 'update_many', updates, summary: `${params.locked ? 'Locked' : 'Unlocked'} ${params.shapeIds.length} shape(s)` };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: `${params.locked ? 'Locked' : 'Unlocked'} ${params.shapeIds.length} shape(s).` }], details: { count: params.shapeIds.length, locked: params.locked, patch } };
    },
  });

  const setVisible = defineTool({
    name: 'canvas_set_visible',
    label: 'Show / Hide Shapes',
    description: 'Show or hide one or more shapes. Hidden shapes are not rendered but remain in the document. Useful for creating alternative states or simplifying a complex canvas.',
    promptSnippet: 'Show or hide shapes.',
    parameters: Type.Object({
      shapeIds: Type.Array(Type.String(), { description: 'Shape IDs to show/hide' }),
      visible: Type.Boolean({ description: 'true to show, false to hide' }),
    }),
    async execute(toolCallId, params) {
      const updates = params.shapeIds.map((id) => ({ id, changes: { visible: params.visible } as Partial<Shape> }));
      const patch: CanvasPatch = { op: 'update_many', updates, summary: `${params.visible ? 'Showed' : 'Hid'} ${params.shapeIds.length} shape(s)` };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: `${params.visible ? 'Showed' : 'Hid'} ${params.shapeIds.length} shape(s).` }], details: { count: params.shapeIds.length, visible: params.visible, patch } };
    },
  });

  // =====================================================================
  // PHASE 1c: Z-ORDER (4 tools)
  // Currently zIndex is only set at creation or via organize_layers.
  // These tools let the agent reorder individual shapes.
  // =====================================================================

  const bringToFront = defineTool({
    name: 'canvas_bring_to_front',
    label: 'Bring to Front',
    description: 'Move one or more shapes to the top of the z-order (above all other shapes).',
    promptSnippet: 'Bring shapes to the front of the z-order.',
    parameters: Type.Object({
      shapeIds: Type.Array(Type.String(), { description: 'Shape IDs to bring to front' }),
    }),
    async execute(toolCallId, params) {
      const patch: CanvasPatch = { op: 'zorder', shapeIds: params.shapeIds, zorderKind: 'front', summary: `Brought ${params.shapeIds.length} shape(s) to front` };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: `Brought ${params.shapeIds.length} shape(s) to front.` }], details: { count: params.shapeIds.length, patch } };
    },
  });

  const sendToBack = defineTool({
    name: 'canvas_send_to_back',
    label: 'Send to Back',
    description: 'Move one or more shapes to the bottom of the z-order (below all other shapes).',
    promptSnippet: 'Send shapes to the back of the z-order.',
    parameters: Type.Object({
      shapeIds: Type.Array(Type.String(), { description: 'Shape IDs to send to back' }),
    }),
    async execute(toolCallId, params) {
      const patch: CanvasPatch = { op: 'zorder', shapeIds: params.shapeIds, zorderKind: 'back', summary: `Sent ${params.shapeIds.length} shape(s) to back` };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: `Sent ${params.shapeIds.length} shape(s) to back.` }], details: { count: params.shapeIds.length, patch } };
    },
  });

  const moveForward = defineTool({
    name: 'canvas_move_forward',
    label: 'Move Forward',
    description: 'Move a shape one level forward (above its current neighbor).',
    promptSnippet: 'Move a shape one level up in the z-order.',
    parameters: Type.Object({
      shapeId: Type.String({ description: 'Shape ID to move forward' }),
    }),
    async execute(toolCallId, params) {
      const patch: CanvasPatch = { op: 'zorder', shapeIds: [params.shapeId], zorderKind: 'forward', summary: 'Moved shape forward' };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: 'Moved shape forward.' }], details: { shapeId: params.shapeId, patch } };
    },
  });

  const moveBackward = defineTool({
    name: 'canvas_move_backward',
    label: 'Move Backward',
    description: 'Move a shape one level backward (below its current neighbor).',
    promptSnippet: 'Move a shape one level down in the z-order.',
    parameters: Type.Object({
      shapeId: Type.String({ description: 'Shape ID to move backward' }),
    }),
    async execute(toolCallId, params) {
      const patch: CanvasPatch = { op: 'zorder', shapeIds: [params.shapeId], zorderKind: 'backward', summary: 'Moved shape backward' };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: 'Moved shape backward.' }], details: { shapeId: params.shapeId, patch } };
    },
  });

  const reorderShape = defineTool({
    name: 'canvas_reorder_shape',
    label: 'Reorder Shape',
    description: 'Move a shape to a specific z-index position. Other shapes shift to make room.',
    promptSnippet: 'Move a shape to a specific z-index.',
    parameters: Type.Object({
      shapeId: Type.String({ description: 'Shape ID to reorder' }),
      zIndex: Type.Number({ description: 'Target z-index (0 = bottom)' }),
    }),
    async execute(toolCallId, params) {
      const patch: CanvasPatch = { op: 'reorder', shapeId: params.shapeId, zIndex: params.zIndex, summary: `Moved shape to z-index ${params.zIndex}` };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: `Moved shape to z-index ${params.zIndex}.` }], details: { shapeId: params.shapeId, zIndex: params.zIndex, patch } };
    },
  });

  // =====================================================================
  // PHASE 2a: UNDO / REDO (2 tools)
  // Emits special 'undo' / 'redo' patches. The canvas store intercepts
  // these (it maintains the undo/redo stacks client-side). The server-side
  // patch applier is a no-op for these ops.
  // =====================================================================

  const undoCanvas = defineTool({
    name: 'canvas_undo',
    label: 'Undo',
    description: 'Undo the last canvas change. Can be called multiple times to undo further back. ' +
      'NOTE: this only affects the local (client) canvas state — it does not reverse agent tool calls in the chat history.',
    promptSnippet: 'Undo the last canvas change.',
    parameters: Type.Object({}),
    async execute(toolCallId) {
      const patch: CanvasPatch = { op: 'undo' as any, summary: 'Undo' };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: 'Undid the last canvas change.' }], details: { patch } };
    },
  });

  const redoCanvas = defineTool({
    name: 'canvas_redo',
    label: 'Redo',
    description: 'Redo a previously undone canvas change. Can be called multiple times.',
    promptSnippet: 'Redo a previously undone change.',
    parameters: Type.Object({}),
    async execute(toolCallId) {
      const patch: CanvasPatch = { op: 'redo' as any, summary: 'Redo' };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: 'Redid the last undone change.' }], details: { patch } };
    },
  });

  // =====================================================================
  // PHASE 2b: EXPORT (4 tools)
  // Serialize the canvas to JSON, SVG, or code. The agent returns the
  // exported content as text in the tool result — the user can copy it
  // from the chat.
  // =====================================================================

  const exportJson = defineTool({
    name: 'canvas_export_json',
    label: 'Export as JSON',
    description: 'Export the full canvas document as a JSON string. Includes all shapes, tokens, background, and viewport. Useful for backup or migration.',
    promptSnippet: 'Export the canvas as JSON.',
    parameters: Type.Object({}),
    async execute(toolCallId) {
      const doc = ctx.getDocument?.() ?? { shapes: ctx.getShapes(), tokens: ctx.getTokens() };
      const json = JSON.stringify(doc, null, 2);
      return { content: [{ type: 'text', text: `Canvas JSON (${json.length} chars):\n\`\`\`json\n${json.slice(0, 4000)}${json.length > 4000 ? '\n... (truncated, see full output in details)' : ''}\n\`\`\`` }], details: { json, charCount: json.length } };
    },
  });

  const exportSvg = defineTool({
    name: 'canvas_export_svg',
    label: 'Export as SVG',
    description: 'Export the canvas as an SVG string. Each shape is rendered as its SVG element. Useful for embedding in documents or converting to PNG.',
    promptSnippet: 'Export the canvas as SVG.',
    parameters: Type.Object({
      frameId: Type.Optional(Type.String({ description: 'If provided, export only shapes inside this frame' })),
    }),
    async execute(toolCallId, params) {
      const allShapes = ctx.getShapes();
      let shapes = allShapes;
      if (params.frameId) {
        const frame = allShapes.find((s) => s.id === params.frameId);
        if (frame) {
          // Export shapes whose bounding box is inside the frame.
          shapes = allShapes.filter((s) =>
            s.id !== params.frameId &&
            s.x >= frame.x && s.y >= frame.y &&
            s.x + s.width <= frame.x + frame.width &&
            s.y + s.height <= frame.y + frame.height,
          );
        }
      }
      // Compute bounding box.
      if (shapes.length === 0) {
        return { content: [{ type: 'text', text: 'No shapes to export.' }], details: { error: 'empty' } };
      }
      const minX = Math.min(...shapes.map((s) => s.x));
      const minY = Math.min(...shapes.map((s) => s.y));
      const maxX = Math.max(...shapes.map((s) => s.x + s.width));
      const maxY = Math.max(...shapes.map((s) => s.y + s.height));
      const w = maxX - minX;
      const h = maxY - minY;
      // Build SVG elements.
      const els = shapes.map((s) => {
        const rx = s.x - minX;
        const ry = s.y - minY;
        const stroke = s.strokeWidth > 0 ? ` stroke="${s.stroke}" stroke-width="${s.strokeWidth}"` : '';
        switch (s.type) {
          case 'rectangle':
          case 'frame':
            return `  <rect x="${rx}" y="${ry}" width="${s.width}" height="${s.height}" rx="${s.radius}" fill="${s.fill}"${stroke}/>`;
          case 'ellipse':
            return `  <ellipse cx="${rx + s.width / 2}" cy="${ry + s.height / 2}" rx="${s.width / 2}" ry="${s.height / 2}" fill="${s.fill}"${stroke}/>`;
          case 'line':
            return `  <line x1="${rx}" y1="${ry}" x2="${rx + s.width}" y2="${ry + s.height}" stroke="${s.fill}" stroke-width="${Math.max(2, s.strokeWidth)}" stroke-linecap="round"/>`;
          case 'text':
            return `  <text x="${rx}" y="${ry + s.fontSize}" font-size="${s.fontSize}" fill="${s.textColor}" font-family="Inter, sans-serif">${escapeXml(s.text ?? '')}</text>`;
          case 'path':
            if (!s.points || s.points.length === 0) return '';
            const pts = s.points.map((p) => `${p.x - minX},${p.y - minY}`).join(' ');
            return s.closed
              ? `  <polygon points="${pts}" fill="${s.fill}"${stroke}/>`
              : `  <polyline points="${pts}" fill="none" stroke="${s.stroke}" stroke-width="${Math.max(2, s.strokeWidth)}" stroke-linecap="round" stroke-linejoin="round"/>`;
          case 'image':
            return `  <image x="${rx}" y="${ry}" width="${s.width}" height="${s.height}" href="${s.src ?? ''}"/>`;
          default:
            return '';
        }
      }).filter(Boolean).join('\n');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">\n${els}\n</svg>`;
      return { content: [{ type: 'text', text: `SVG exported (${w}×${h}, ${shapes.length} shapes). Length: ${svg.length} chars.\n\`\`\`svg\n${svg.slice(0, 4000)}${svg.length > 4000 ? '\n... (truncated)' : ''}\n\`\`\`` }], details: { svg, width: w, height: h, shapeCount: shapes.length } };
    },
  });

  const exportPng = defineTool({
    name: 'canvas_export_png',
    label: 'Export as PNG (data URL)',
    description: 'Export the canvas as an SVG data URL that can be used in <img> tags or downloaded. ' +
      'True PNG rasterization requires a browser; this tool returns an SVG data URL which any browser can render and convert to PNG.',
    promptSnippet: 'Export the canvas as an image data URL.',
    parameters: Type.Object({
      frameId: Type.Optional(Type.String({ description: 'If provided, export only shapes inside this frame' })),
    }),
    async execute(toolCallId, params) {
      const allShapes = ctx.getShapes();
      let shapes = allShapes;
      if (params.frameId) {
        const frame = allShapes.find((s) => s.id === params.frameId);
        if (frame) {
          shapes = allShapes.filter((s) =>
            s.id !== params.frameId &&
            s.x >= frame.x && s.y >= frame.y &&
            s.x + s.width <= frame.x + frame.width &&
            s.y + s.height <= frame.y + frame.height,
          );
        }
      }
      if (shapes.length === 0) {
        return { content: [{ type: 'text', text: 'No shapes to export.' }], details: { error: 'empty' } };
      }
      const minX = Math.min(...shapes.map((s) => s.x));
      const minY = Math.min(...shapes.map((s) => s.y));
      const maxX = Math.max(...shapes.map((s) => s.x + s.width));
      const maxY = Math.max(...shapes.map((s) => s.y + s.height));
      const w = maxX - minX;
      const h = maxY - minY;
      const els = shapes.map((s) => {
        const rx = s.x - minX;
        const ry = s.y - minY;
        const stroke = s.strokeWidth > 0 ? ` stroke="${s.stroke}" stroke-width="${s.strokeWidth}"` : '';
        switch (s.type) {
          case 'rectangle': case 'frame':
            return `<rect x="${rx}" y="${ry}" width="${s.width}" height="${s.height}" rx="${s.radius}" fill="${s.fill}"${stroke}/>`;
          case 'ellipse':
            return `<ellipse cx="${rx + s.width / 2}" cy="${ry + s.height / 2}" rx="${s.width / 2}" ry="${s.height / 2}" fill="${s.fill}"${stroke}/>`;
          case 'line':
            return `<line x1="${rx}" y1="${ry}" x2="${rx + s.width}" y2="${ry + s.height}" stroke="${s.fill}" stroke-width="${Math.max(2, s.strokeWidth)}" stroke-linecap="round"/>`;
          case 'text':
            return `<text x="${rx}" y="${ry + s.fontSize}" font-size="${s.fontSize}" fill="${s.textColor}" font-family="Inter, sans-serif">${escapeXml(s.text ?? '')}</text>`;
          default: return '';
        }
      }).join('');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${els}</svg>`;
      const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
      return { content: [{ type: 'text', text: `Exported as SVG data URL (${w}×${h}, ${shapes.length} shapes). Length: ${dataUrl.length} chars. Use in an <img src="..."> tag.` }], details: { dataUrl, width: w, height: h, shapeCount: shapes.length } };
    },
  });

  const copyAsCode = defineTool({
    name: 'canvas_copy_as_code',
    label: 'Copy as Code',
    description: 'Generate HTML + Tailwind CSS code from the canvas shapes. Useful for handoff to developers. ' +
      'Each shape becomes a positioned div; text shapes become <span> elements. ' +
      'Supports: html (standalone HTML), react (JSX component), tailwind (Tailwind classes).',
    promptSnippet: 'Generate HTML/React/Tailwind code from the canvas.',
    parameters: Type.Object({
      frameId: Type.Optional(Type.String({ description: 'If provided, export only shapes inside this frame' })),
      framework: Type.Union(
        [Type.Literal('html'), Type.Literal('react'), Type.Literal('tailwind')],
        { description: 'Output format' },
      ),
    }),
    async execute(toolCallId, params) {
      const allShapes = ctx.getShapes();
      let shapes = allShapes;
      if (params.frameId) {
        const frame = allShapes.find((s) => s.id === params.frameId);
        if (frame) {
          shapes = allShapes.filter((s) => s.id !== params.frameId && s.x >= frame.x && s.y >= frame.y && s.x + s.width <= frame.x + frame.width && s.y + s.height <= frame.y + frame.height);
        }
      }
      if (shapes.length === 0) {
        return { content: [{ type: 'text', text: 'No shapes to export.' }], details: { error: 'empty' } };
      }
      const minX = Math.min(...shapes.map((s) => s.x));
      const minY = Math.min(...shapes.map((s) => s.y));
      const els = shapes.map((s) => {
        const x = Math.round(s.x - minX);
        const y = Math.round(s.y - minY);
        const w = Math.round(s.width);
        const h = Math.round(s.height);
        if (s.type === 'text') {
          const fs = Math.round(s.fontSize);
          return `    <span style="position:absolute;left:${x}px;top:${y}px;font-size:${fs}px;color:${s.textColor};font-family:Inter,sans-serif">${escapeHtml(s.text ?? '')}</span>`;
        }
        const r = Math.round(s.radius);
        const radius = r > 0 ? `;border-radius:${r}px` : '';
        const stroke = s.strokeWidth > 0 ? `;border:${s.strokeWidth}px solid ${s.stroke}` : '';
        return `    <div style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;background:${s.fill}${radius}${stroke}"></div>`;
      }).join('\n');
      const totalW = Math.max(...shapes.map((s) => s.x + s.width)) - minX;
      const totalH = Math.max(...shapes.map((s) => s.y + s.height)) - minY;
      let code: string;
      if (params.framework === 'react') {
        code = `export function CanvasExport() {\n  return (\n    <div style={{ position: 'relative', width: ${Math.round(totalW)}, height: ${Math.round(totalH)} }}>\n${els}\n    </div>\n  );\n}`;
      } else {
        code = `<div style="position:relative;width:${Math.round(totalW)}px;height:${Math.round(totalH)}px">\n${els}\n</div>`;
      }
      return { content: [{ type: 'text', text: `Generated ${params.framework} code (${shapes.length} shapes, ${Math.round(totalW)}×${Math.round(totalH)}):\n\`\`\`${params.framework === 'react' ? 'tsx' : 'html'}\n${code}\n\`\`\`` }], details: { code, framework: params.framework, shapeCount: shapes.length } };
    },
  });

  // =====================================================================
  // PHASE 2c: FIND & FILTER (3 tools)
  // Lets the agent query and bulk-transform shapes without first calling
  // canvas_list_shapes and filtering client-side.
  // =====================================================================

  const findShapes = defineTool({
    name: 'canvas_find_shapes',
    label: 'Find Shapes',
    description: 'Find shapes matching a filter. Returns shape IDs and a summary. Read-only. ' +
      'Use this to bulk-select shapes by type, color, name, or parent. ' +
      'Example: find all ellipses, find all shapes with fill #ff0000, find all children of a frame.',
    promptSnippet: 'Find shapes by type/color/name/parent.',
    parameters: Type.Object({
      type: Type.Optional(ShapeTypeSchema),
      fill: Type.Optional(Type.String({ description: 'Filter by exact fill color' })),
      nameContains: Type.Optional(Type.String({ description: 'Filter by name (substring match)' })),
      parentId: Type.Optional(Type.String({ description: 'Filter by parent shape ID' })),
    }),
    async execute(toolCallId, params) {
      let results = ctx.getShapes();
      if (params.type) results = results.filter((s) => s.type === params.type);
      if (params.fill) results = results.filter((s) => s.fill === params.fill);
      if (params.nameContains) results = results.filter((s) => s.name.toLowerCase().includes(params.nameContains!.toLowerCase()));
      if (params.parentId) results = results.filter((s) => s.parentId === params.parentId);
      const lines = results.map((s) => `  ${s.id}  ${s.type.padEnd(10)} "${s.name}"  (${Math.round(s.x)},${Math.round(s.y)}) ${Math.round(s.width)}×${Math.round(s.height)} fill=${s.fill}`);
      const report = `Found ${results.length} shape(s):\n${lines.join('\n') || '  (none)'}`;
      return { content: [{ type: 'text', text: report }], details: { count: results.length, shapeIds: results.map((s) => s.id) } };
    },
  });

  const bulkUpdateByFilter = defineTool({
    name: 'canvas_bulk_update_by_filter',
    label: 'Bulk Update by Filter',
    description: 'Update all shapes matching a filter. Combines canvas_find_shapes + canvas_update_shape into one call. ' +
      'Example: "make all ellipses red" → filter type=ellipse, changes fill=#ff0000.',
    promptSnippet: 'Update all shapes matching a filter in one call.',
    parameters: Type.Object({
      type: Type.Optional(ShapeTypeSchema),
      fill: Type.Optional(Type.String({ description: 'Filter by current fill color' })),
      nameContains: Type.Optional(Type.String({ description: 'Filter by name (substring)' })),
      parentId: Type.Optional(Type.String({ description: 'Filter by parent ID' })),
      changes: ShapeInputSchema,
    }),
    async execute(toolCallId, params) {
      let matches = ctx.getShapes();
      if (params.type) matches = matches.filter((s) => s.type === params.type);
      if (params.fill) matches = matches.filter((s) => s.fill === params.fill);
      if (params.nameContains) matches = matches.filter((s) => s.name.toLowerCase().includes(params.nameContains!.toLowerCase()));
      if (params.parentId) matches = matches.filter((s) => s.parentId === params.parentId);
      if (matches.length === 0) {
        return { content: [{ type: 'text', text: 'No shapes matched the filter.' }], details: { error: 'no_matches', count: 0 } };
      }
      const coerced = coerceShapeInput(params.changes);
      const updates = matches.map((s) => ({ id: s.id, changes: coerced }));
      const patch: CanvasPatch = { op: 'update_many', updates, summary: `Bulk-updated ${matches.length} shape(s): ${Object.keys(coerced).join(', ')}` };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: `Updated ${matches.length} shape(s) with ${Object.keys(coerced).join(', ')}.` }], details: { count: matches.length, patch } };
    },
  });

  const findReplaceText = defineTool({
    name: 'canvas_find_replace_text',
    label: 'Find & Replace Text',
    description: 'Find and replace text across all text shapes on the canvas. Supports plain string matching. ' +
      'Example: find "Lorem" replace "Welcome" — updates every text shape containing "Lorem".',
    promptSnippet: 'Find and replace text in all text shapes.',
    parameters: Type.Object({
      find: Type.String({ description: 'Text to find (exact substring match)' }),
      replace: Type.String({ description: 'Replacement text' }),
    }),
    async execute(toolCallId, params) {
      const textShapes = ctx.getShapes().filter((s) => s.type === 'text' && s.text && s.text.includes(params.find));
      if (textShapes.length === 0) {
        return { content: [{ type: 'text', text: `No text shapes containing "${params.find}" found.` }], details: { count: 0 } };
      }
      const updates = textShapes.map((s) => ({ id: s.id, changes: { text: s.text!.replace(new RegExp(escapeRegex(params.find), 'g'), params.replace) } as Partial<Shape> }));
      const patch: CanvasPatch = { op: 'update_many', updates, summary: `Replaced "${params.find}" → "${params.replace}" in ${updates.length} text shape(s)` };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: `Replaced "${params.find}" with "${params.replace}" in ${updates.length} text shape(s).` }], details: { count: updates.length, patch } };
    },
  });

  // =====================================================================
  // PHASE 5a: VECTOR EDITING (3 tools)
  // create_path: arbitrary polygon / polyline
  // boolean_op: simplified — creates a group + sets maskId
  // mask_with: sets maskId on a shape
  // =====================================================================

  const createPath = defineTool({
    name: 'canvas_create_path',
    label: 'Create Path / Polygon',
    description: 'Create a freeform path shape from a list of points. ' +
      'If closed=true, the path is filled (polygon); if closed=false, it\'s a stroked polyline. ' +
      'Points are canvas-space {x, y} coordinates. Minimum 2 points.',
    promptSnippet: 'Create a path/polyline from points.',
    parameters: Type.Object({
      points: Type.Array(Type.Object({ x: Type.Number(), y: Type.Number() }), { description: 'List of {x, y} points (min 2)' }),
      closed: Type.Optional(Type.Boolean({ description: 'Close the path and fill it (polygon). Default false.' })),
      name: Type.Optional(Type.String({ description: 'Layer name' })),
      fill: Type.Optional(Type.String({ description: 'Fill color (closed paths only)' })),
      stroke: Type.Optional(Type.String({ description: 'Stroke color' })),
      strokeWidth: Type.Optional(Type.Number({ description: 'Stroke width in px' })),
    }),
    async execute(toolCallId, params) {
      if (!Array.isArray(params.points) || params.points.length < 2) {
        return { content: [{ type: 'text', text: 'Error: need at least 2 points' }], details: { error: 'invalid_points' }, isError: true as any };
      }
      const id = crypto.randomUUID();
      const pts = params.points.map((p) => ({ x: Number(p.x) || 0, y: Number(p.y) || 0 }));
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      const maxX = Math.max(...xs);
      const maxY = Math.max(...ys);
      const shape: Partial<Shape> = {
        id,
        type: 'path',
        name: params.name ?? 'Path',
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
        fill: params.fill ?? '#e2e8f0',
        stroke: params.stroke ?? '#0f172a',
        strokeWidth: params.strokeWidth ?? (params.closed ? 0 : 2),
        radius: 0,
        fontSize: 16,
        textColor: '#0f172a',
        points: pts,
        closed: params.closed ?? false,
        zIndex: ctx.getShapes().length,
      };
      const patch: CanvasPatch = { op: 'add', shapeId: id, shape, summary: `Created ${params.closed ? 'polygon' : 'polyline'} with ${pts.length} points` };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: `Created path with id ${id}, ${pts.length} points. Bounding box: (${Math.round(minX)},${Math.round(minY)}) ${Math.round(maxX - minX)}×${Math.round(maxY - minY)}.` }], details: { shapeId: id, pointCount: pts.length, patch } };
    },
  });

  const booleanOp = defineTool({
    name: 'canvas_boolean_op',
    label: 'Boolean Operation',
    description: 'Combine two shapes using a boolean operation. ' +
      'NOTE: this is a simplified implementation — true vector boolean math requires a polygon-clipping library. ' +
      'union: groups both shapes under a single group with unified fill. ' +
      'subtract: sets the second shape as a mask (clips the first). ' +
      'intersect: same as subtract (mask intersection). ' +
      'exclude: hides the second shape (visual approximation).',
    promptSnippet: 'Boolean-combine two shapes (union/subtract/intersect/exclude).',
    parameters: Type.Object({
      shapeId: Type.String({ description: 'Primary shape' }),
      otherShapeId: Type.String({ description: 'Second shape' }),
      operation: Type.Union(
        [Type.Literal('union'), Type.Literal('subtract'), Type.Literal('intersect'), Type.Literal('exclude')],
        { description: 'Boolean operation' },
      ),
    }),
    async execute(toolCallId, params) {
      const shape = ctx.getShapes().find((s) => s.id === params.shapeId);
      const other = ctx.getShapes().find((s) => s.id === params.otherShapeId);
      if (!shape || !other) {
        return { content: [{ type: 'text', text: `Error: one or both shapes not found` }], details: { error: 'not_found' }, isError: true as any };
      }
      if (params.operation === 'union') {
        // Group both shapes and unify their fill.
        const patch: CanvasPatch = { op: 'group', shapeIds: [params.shapeId, params.otherShapeId], groupId: crypto.randomUUID(), summary: `Union: grouped ${shape.name} + ${other.name}` };
        ctx.applyPatch(patch);
        return { content: [{ type: 'text', text: `Union: grouped "${shape.name}" and "${other.name}" into a single group.` }], details: { operation: 'union', patch } };
      }
      if (params.operation === 'subtract' || params.operation === 'intersect') {
        // Set maskId on the first shape to the second shape's id.
        const patch: CanvasPatch = { op: 'update', shapeId: params.shapeId, shape: { maskId: params.otherShapeId }, summary: `${params.operation}: masked ${shape.name} with ${other.name}` };
        ctx.applyPatch(patch);
        return { content: [{ type: 'text', text: `${params.operation}: set "${other.name}" as a mask on "${shape.name}".` }], details: { operation: params.operation, patch } };
      }
      // exclude — hide the second shape (approximation).
      const patch: CanvasPatch = { op: 'update', shapeId: params.otherShapeId, shape: { visible: false }, summary: `Exclude: hid ${other.name}` };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: `Exclude: hid "${other.name}" (approximation).` }], details: { operation: 'exclude', patch } };
    },
  });

  const maskWith = defineTool({
    name: 'canvas_mask_with',
    label: 'Mask with Shape',
    description: 'Clip a shape using another shape as a mask. The mask shape\'s geometry defines the visible region of the target. ' +
      'To remove a mask, call this with maskId=null (or use canvas_update_shape to clear maskId).',
    promptSnippet: 'Mask one shape with another.',
    parameters: Type.Object({
      shapeId: Type.String({ description: 'Shape to be masked (clipped)' }),
      maskShapeId: Type.Optional(Type.String({ description: 'Shape to use as mask. Omit or set to null to remove the mask.' })),
    }),
    async execute(toolCallId, params) {
      const shape = ctx.getShapes().find((s) => s.id === params.shapeId);
      if (!shape) {
        return { content: [{ type: 'text', text: `Error: no shape with id ${params.shapeId}` }], details: { error: 'not_found' }, isError: true as any };
      }
      const maskId = params.maskShapeId ?? null;
      if (maskId) {
        const mask = ctx.getShapes().find((s) => s.id === maskId);
        if (!mask) {
          return { content: [{ type: 'text', text: `Error: no mask shape with id ${maskId}` }], details: { error: 'mask_not_found' }, isError: true as any };
        }
      }
      const patch: CanvasPatch = { op: 'update', shapeId: params.shapeId, shape: { maskId }, summary: maskId ? `Masked ${shape.name}` : `Removed mask from ${shape.name}` };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: maskId ? `Masked "${shape.name}" with shape ${maskId}.` : `Removed mask from "${shape.name}".` }], details: { shapeId: params.shapeId, maskId, patch } };
    },
  });

  // =====================================================================
  // PHASE 5b: EFFECTS & STYLING (4 tools)
  // gradient fill, drop shadow, blur, per-corner radii
  // =====================================================================

  const setGradientFill = defineTool({
    name: 'canvas_set_gradient_fill',
    label: 'Set Gradient Fill',
    description: 'Set a linear or radial gradient fill on a shape. Overrides the solid `fill` color. ' +
      'Provide 2+ stops (offset 0..1, color hex). For linear, specify angle 0..360 (0=→, 90=↓, 180=←, 270=↑).',
    promptSnippet: 'Apply a gradient fill to a shape.',
    parameters: Type.Object({
      shapeId: Type.String({ description: 'Shape ID' }),
      type: Type.Union([Type.Literal('linear'), Type.Literal('radial')], { description: 'Gradient type' }),
      angle: Type.Optional(Type.Number({ description: 'Angle in degrees (linear only). Default 90.' })),
      stops: Type.Array(Type.Object({
        offset: Type.Number({ description: '0..1' }),
        color: Type.String({ description: 'Hex color' }),
      }), { description: 'Color stops (min 2)' }),
    }),
    async execute(toolCallId, params) {
      const shape = ctx.getShapes().find((s) => s.id === params.shapeId);
      if (!shape) {
        return { content: [{ type: 'text', text: `Error: no shape with id ${params.shapeId}` }], details: { error: 'not_found' }, isError: true as any };
      }
      if (!Array.isArray(params.stops) || params.stops.length < 2) {
        return { content: [{ type: 'text', text: 'Error: need at least 2 gradient stops' }], details: { error: 'invalid_stops' }, isError: true as any };
      }
      const gradient = {
        type: params.type === 'radial' ? 'radial' as const : 'linear' as const,
        angle: params.angle ?? 90,
        stops: params.stops.map((s) => ({ offset: Number(s.offset) || 0, color: String(s.color) })),
      };
      const patch: CanvasPatch = { op: 'update', shapeId: params.shapeId, shape: { gradient, fill: gradient.stops[0].color }, summary: `Set ${gradient.type} gradient on ${shape.name}` };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: `Set ${gradient.type} gradient (${gradient.stops.length} stops) on "${shape.name}".` }], details: { shapeId: params.shapeId, gradient, patch } };
    },
  });

  const setShadow = defineTool({
    name: 'canvas_set_shadow',
    label: 'Set Drop Shadow',
    description: 'Apply a drop shadow to a shape. Set blur=0 and color=transparent to remove. ' +
      'The shadow is rendered via an SVG filter on the client.',
    promptSnippet: 'Apply a drop shadow to a shape.',
    parameters: Type.Object({
      shapeId: Type.String({ description: 'Shape ID' }),
      x: Type.Number({ description: 'X offset in px' }),
      y: Type.Number({ description: 'Y offset in px' }),
      blur: Type.Number({ description: 'Blur radius in px' }),
      color: Type.String({ description: 'Shadow color (hex, e.g. #00000033 for semi-transparent black)' }),
      spread: Type.Optional(Type.Number({ description: 'Spread in px (default 0)' })),
      inset: Type.Optional(Type.Boolean({ description: 'Inset shadow (default false)' })),
    }),
    async execute(toolCallId, params) {
      const shape = ctx.getShapes().find((s) => s.id === params.shapeId);
      if (!shape) {
        return { content: [{ type: 'text', text: `Error: no shape with id ${params.shapeId}` }], details: { error: 'not_found' }, isError: true as any };
      }
      const shadow = {
        x: Number(params.x) || 0,
        y: Number(params.y) || 0,
        blur: Number(params.blur) || 0,
        color: String(params.color),
        spread: params.spread !== undefined ? Number(params.spread) : 0,
        inset: !!params.inset,
      };
      const patch: CanvasPatch = { op: 'update', shapeId: params.shapeId, shape: { shadow }, summary: `Set shadow on ${shape.name}` };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: `Set shadow (${shadow.x},${shadow.y}, blur ${shadow.blur}px) on "${shape.name}".` }], details: { shapeId: params.shapeId, shadow, patch } };
    },
  });

  const setBlur = defineTool({
    name: 'canvas_set_blur',
    label: 'Set Blur',
    description: 'Apply a Gaussian blur to a shape. Set radius to 0 to remove. Rendered via an SVG filter.',
    promptSnippet: 'Apply a Gaussian blur to a shape.',
    parameters: Type.Object({
      shapeId: Type.String({ description: 'Shape ID' }),
      radius: Type.Number({ description: 'Blur radius in px (0 to remove)' }),
    }),
    async execute(toolCallId, params) {
      const shape = ctx.getShapes().find((s) => s.id === params.shapeId);
      if (!shape) {
        return { content: [{ type: 'text', text: `Error: no shape with id ${params.shapeId}` }], details: { error: 'not_found' }, isError: true as any };
      }
      const blur = Math.max(0, Number(params.radius) || 0);
      const patch: CanvasPatch = { op: 'update', shapeId: params.shapeId, shape: { blur }, summary: `Set blur ${blur}px on ${shape.name}` };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: `Set blur ${blur}px on "${shape.name}".` }], details: { shapeId: params.shapeId, blur, patch } };
    },
  });

  const setCornerRadiusPerCorner = defineTool({
    name: 'canvas_set_corner_radius_per_corner',
    label: 'Set Per-Corner Radii',
    description: 'Set independent border radii for each corner of a rectangle or frame. ' +
      'Overrides the uniform `radius` property.',
    promptSnippet: 'Set per-corner border radii on a shape.',
    parameters: Type.Object({
      shapeId: Type.String({ description: 'Shape ID (rectangle or frame)' }),
      topLeft: Type.Number({ description: 'Top-left radius in px' }),
      topRight: Type.Number({ description: 'Top-right radius in px' }),
      bottomRight: Type.Number({ description: 'Bottom-right radius in px' }),
      bottomLeft: Type.Number({ description: 'Bottom-left radius in px' }),
    }),
    async execute(toolCallId, params) {
      const shape = ctx.getShapes().find((s) => s.id === params.shapeId);
      if (!shape) {
        return { content: [{ type: 'text', text: `Error: no shape with id ${params.shapeId}` }], details: { error: 'not_found' }, isError: true as any };
      }
      if (shape.type !== 'rectangle' && shape.type !== 'frame') {
        return { content: [{ type: 'text', text: `Error: per-corner radii only apply to rectangle/frame shapes (got ${shape.type})` }], details: { error: 'wrong_type', shapeType: shape.type }, isError: true as any };
      }
      const radii = {
        topLeft: Math.max(0, Number(params.topLeft) || 0),
        topRight: Math.max(0, Number(params.topRight) || 0),
        bottomRight: Math.max(0, Number(params.bottomRight) || 0),
        bottomLeft: Math.max(0, Number(params.bottomLeft) || 0),
      };
      const patch: CanvasPatch = { op: 'update', shapeId: params.shapeId, shape: { radii }, summary: `Set per-corner radii on ${shape.name}` };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: `Set per-corner radii (${radii.topLeft}/${radii.topRight}/${radii.bottomRight}/${radii.bottomLeft}) on "${shape.name}".` }], details: { shapeId: params.shapeId, radii, patch } };
    },
  });

  // =====================================================================
  // PHASE 5c: IMAGE SUPPORT (3 tools)
  // upload_image, search_icons (Lucide path data), generate_image (placeholder)
  // =====================================================================

  const uploadImage = defineTool({
    name: 'canvas_upload_image',
    label: 'Place Image',
    description: 'Place an image on the canvas from a data URL or remote URL. ' +
      'Use this for logos, photos, or any raster image. The image is rendered via an SVG <image> element. ' +
      'Data URLs (base64) are preferred for persistence; remote URLs may break if the host goes down.',
    promptSnippet: 'Place an image on the canvas.',
    parameters: Type.Object({
      src: Type.String({ description: 'Image source — data URL (data:image/...) or remote URL (https://...)' }),
      x: Type.Number({ description: 'Canvas-space X' }),
      y: Type.Number({ description: 'Canvas-space Y' }),
      width: Type.Optional(Type.Number({ description: 'Display width in px (default: natural width, max 400)' })),
      height: Type.Optional(Type.Number({ description: 'Display height in px (default: natural height, max 400)' })),
      name: Type.Optional(Type.String({ description: 'Layer name' })),
    }),
    async execute(toolCallId, params) {
      const id = crypto.randomUUID();
      const w = Number(params.width) || 200;
      const h = Number(params.height) || 200;
      const shape: Partial<Shape> = {
        id,
        type: 'image',
        name: params.name ?? 'Image',
        x: Number(params.x) || 0,
        y: Number(params.y) || 0,
        width: w,
        height: h,
        fill: 'transparent',
        stroke: '#94a3b8',
        strokeWidth: 0,
        radius: 0,
        fontSize: 16,
        textColor: '#0f172a',
        src: String(params.src),
        zIndex: ctx.getShapes().length,
      };
      const patch: CanvasPatch = { op: 'add', shapeId: id, shape, summary: `Placed image "${params.name ?? 'Image'}" at (${params.x}, ${params.y})` };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: `Placed image with id ${id} at (${params.x}, ${params.y}), size ${w}×${h}.` }], details: { shapeId: id, patch } };
    },
  });

  const searchIcons = defineTool({
    name: 'canvas_search_icons',
    label: 'Place Icon',
    description: 'Place a Lucide icon on the canvas as a path shape. ' +
      'Renders the icon as a stroked polyline path. ' +
      'Available icons: check, x, plus, minus, arrow-right, arrow-left, arrow-up, arrow-down, ' +
      'chevron-down, chevron-up, chevron-left, chevron-right, search, settings, user, heart, ' +
      'star, bell, mail, phone, calendar, clock, home, menu, share, download, upload, ' +
      'edit, trash, copy, lock, unlock, eye, eye-off.',
    promptSnippet: 'Place a Lucide icon on the canvas.',
    parameters: Type.Object({
      icon: Type.String({ description: 'Icon name (see description for list)' }),
      x: Type.Number({ description: 'Canvas-space X' }),
      y: Type.Number({ description: 'Canvas-space Y' }),
      size: Type.Optional(Type.Number({ description: 'Icon size in px (default 24)' })),
      stroke: Type.Optional(Type.String({ description: 'Stroke color (default #0f172a)' })),
      strokeWidth: Type.Optional(Type.Number({ description: 'Stroke width (default 2)' })),
    }),
    async execute(toolCallId, params) {
      const iconData = LUCIDE_ICONS[params.icon.toLowerCase()];
      if (!iconData) {
        const available = Object.keys(LUCIDE_ICONS).join(', ');
        return { content: [{ type: 'text', text: `Icon "${params.icon}" not found. Available: ${available}` }], details: { error: 'icon_not_found', requested: params.icon, available: Object.keys(LUCIDE_ICONS) }, isError: true as any };
      }
      const id = crypto.randomUUID();
      const sz = Number(params.size) || 24;
      const sw = params.strokeWidth ?? 2;
      const sc = params.stroke ?? '#0f172a';
      // Lucide icons are 24×24 viewBox. Scale to requested size.
      const scale = sz / 24;
      const points = iconData.map((p: { x: number; y: number }) => ({ x: (params.x || 0) + p.x * scale, y: (params.y || 0) + p.y * scale }));
      const shape: Partial<Shape> = {
        id,
        type: 'path',
        name: `Icon: ${params.icon}`,
        x: params.x || 0,
        y: params.y || 0,
        width: sz,
        height: sz,
        fill: 'transparent',
        stroke: sc,
        strokeWidth: sw,
        radius: 0,
        fontSize: 16,
        textColor: '#0f172a',
        points,
        closed: false,
        zIndex: ctx.getShapes().length,
      };
      const patch: CanvasPatch = { op: 'add', shapeId: id, shape, summary: `Placed icon "${params.icon}" at (${params.x}, ${params.y})` };
      ctx.applyPatch(patch);
      return { content: [{ type: 'text', text: `Placed icon "${params.icon}" with id ${id} at (${params.x}, ${params.y}), size ${sz}px.` }], details: { shapeId: id, icon: params.icon, patch } };
    },
  });

  const generateImage = defineTool({
    name: 'canvas_generate_image',
    label: 'Generate Image (placeholder)',
    description: 'Generate an image from a text prompt and place it on the canvas. ' +
      'NOTE: in this sandbox, this tool places a placeholder rectangle with the prompt text — ' +
      'actual AI image generation requires the image-generation API. ' +
      'The placeholder uses a dashed border so the user knows to replace it.',
    promptSnippet: 'Generate an image from a prompt and place it.',
    parameters: Type.Object({
      prompt: Type.String({ description: 'Image generation prompt' }),
      x: Type.Number({ description: 'Canvas-space X' }),
      y: Type.Number({ description: 'Canvas-space Y' }),
      width: Type.Optional(Type.Number({ description: 'Width in px (default 320)' }),
      ),
      height: Type.Optional(Type.Number({ description: 'Height in px (default 200)' }),
      ),
    }),
    async execute(toolCallId, params) {
      const id = crypto.randomUUID();
      const w = Number(params.width) || 320;
      const h = Number(params.height) || 200;
      // Create a placeholder rectangle with a label.
      const shape: Partial<Shape> = {
        id,
        type: 'rectangle',
        name: `Generated: ${params.prompt.slice(0, 30)}`,
        x: Number(params.x) || 0,
        y: Number(params.y) || 0,
        width: w,
        height: h,
        fill: '#f1f5f9',
        stroke: '#94a3b8',
        strokeWidth: 2,
        radius: 8,
        fontSize: 13,
        textColor: '#64748b',
        zIndex: ctx.getShapes().length,
      };
      const patch: CanvasPatch = { op: 'add', shapeId: id, shape, summary: `Placed image placeholder for "${params.prompt.slice(0, 40)}"` };
      ctx.applyPatch(patch);
      // Also add a text label.
      const textId = crypto.randomUUID();
      const textShape: Partial<Shape> = {
        id: textId,
        type: 'text',
        name: 'Image prompt label',
        x: (params.x || 0) + 12,
        y: (params.y || 0) + h / 2,
        width: w - 24,
        height: 32,
        fill: 'transparent',
        stroke: 'transparent',
        strokeWidth: 0,
        radius: 0,
        fontSize: 13,
        textColor: '#64748b',
        text: `AI image: ${params.prompt.slice(0, 50)}`,
        zIndex: (shape.zIndex ?? 0) + 1,
      };
      const textPatch: CanvasPatch = { op: 'add', shapeId: textId, shape: textShape, summary: 'Image prompt label' };
      ctx.applyPatch(textPatch);
      return { content: [{ type: 'text', text: `Placed an image placeholder at (${params.x}, ${params.y}), size ${w}×${h}. Prompt: "${params.prompt}". Replace it with canvas_upload_image once you have the generated image.` }], details: { shapeId: id, prompt: params.prompt, patch } };
    },
  });

  return [
    // Core
    createShape,
    updateShape,
    deleteShape,
    listShapes,
    clearCanvas,
    setBackground,
    selectShape,
    // Layer org
    duplicateShape,
    groupShapes,
    ungroupShapes,
    alignShapes,
    organizeLayers,
    // Auto layout
    applyAutoLayout,
    // Components
    createComponent,
    instantiateComponent,
    // Tokens / palette
    updateTokens,
    applyPalette,
    generatePalette,
    // Generators
    generateWireframe,
    generateUserFlow,
    generateDiagram,
    // Analysis
    predictHeatmap,
    generateCopy,
    auditDesign,
    // Phase 1a: Token binding
    bindShapeToToken,
    unbindShape,
    listTokens,
    applyToken,
    // Phase 1b: Lock & visibility
    setLocked,
    setVisible,
    // Phase 1c: Z-order
    bringToFront,
    sendToBack,
    moveForward,
    moveBackward,
    reorderShape,
    // Phase 2a: Undo / redo
    undoCanvas,
    redoCanvas,
    // Phase 2b: Export
    exportJson,
    exportSvg,
    exportPng,
    copyAsCode,
    // Phase 2c: Find & filter
    findShapes,
    bulkUpdateByFilter,
    findReplaceText,
    // Phase 5a: Vector editing
    createPath,
    booleanOp,
    maskWith,
    // Phase 5b: Effects & styling
    setGradientFill,
    setShadow,
    setBlur,
    setCornerRadiusPerCorner,
    // Phase 5c: Image support
    uploadImage,
    searchIcons,
    generateImage,
  ];
}

// ---- Convert Pi tools → OpenAI tool spec -----------------------------------
//
// The Pi Agent SDK normally drives tools through `pi-ai` provider adapters.
// In this sandbox we don't have Anthropic/OpenAI keys, so we run the agent
// via `z-ai-web-dev-sdk` (which speaks the OpenAI tool-calling format).
// This helper converts our TypeBox-defined Pi tools into the JSON-schema
// tool spec that the LLM expects.

import { Value } from '@sinclair/typebox/value';

export interface OpenAIToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

export function toolsToOpenAISpec(tools: ReturnType<typeof createCanvasTools>): OpenAIToolSpec[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      // TypeBox schemas ARE JSON-schema, so we can pass them through after
      // cleaning up any TypeBox-specific symbols.
      parameters: Value.Clean(t.parameters, {}) as object,
    },
  }));
}

// ---- Execute a tool by name -------------------------------------------------

export async function executeTool(
  tools: ReturnType<typeof createCanvasTools>,
  toolName: string,
  args: any,
): Promise<{ content: string; patch?: CanvasPatch; patches?: CanvasPatch[]; isError?: boolean }> {
  const tool = tools.find((t) => t.name === toolName);
  if (!tool) {
    return { content: `Unknown tool: ${toolName}`, isError: true };
  }
  try {
    const result = await tool.execute(
      `call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      args,
      undefined,
      undefined,
      undefined as any,
    );
    const text = result.content.map((c: any) => c.text ?? '').join('\n');
    const patch = (result.details as any)?.patch as CanvasPatch | undefined;
    const isError = (result as any).isError === true;
    return { content: text, patch, isError };
  } catch (err: any) {
    return { content: `Tool execution failed: ${err.message}`, isError: true };
  }
}

// ---- Wireframe / user-flow / diagram builders ------------------------------
//
// Pure functions that emit arrays of partial shapes. Used by the
// generate_wireframe / generate_user_flow / generate_diagram tools.
// Kept deterministic so the LLM can predict their output.

interface WireframeResult {
  frameId: string;
  shapes: Array<Partial<Shape> & { id: string }>;
}

function buildWireframe(template: string, ox: number, oy: number): WireframeResult {
  const frameId = crypto.randomUUID();
  const shapes: Array<Partial<Shape> & { id: string }> = [];
  const GRAY = '#e2e8f0';
  const DARK = '#475569';
  const LIGHT = '#f1f5f9';
  const add = (s: Partial<Shape> & { id: string }) => shapes.push(s);

  // Helper for a basic frame.
  const addFrame = (w: number, h: number, name: string) => {
    add({
      id: frameId,
      type: 'frame',
      name,
      x: ox, y: oy, width: w, height: h,
      fill: '#ffffff', stroke: DARK, strokeWidth: 1, radius: 0,
      fontSize: 16, textColor: DARK,
    });
  };

  switch (template) {
    case 'mobile_login': {
      addFrame(375, 667, 'Mobile / Login');
      add({ id: crypto.randomUUID(), type: 'text', name: 'Logo', x: ox + 137, y: oy + 80, width: 100, height: 32, fill: 'transparent', text: 'Logo', fontSize: 24, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Heading', x: ox + 32, y: oy + 160, width: 200, height: 28, fill: 'transparent', text: 'Welcome back', fontSize: 22, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Subheading', x: ox + 32, y: oy + 196, width: 250, height: 20, fill: 'transparent', text: 'Sign in to continue', fontSize: 14, textColor: '#64748b', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Email field', x: ox + 32, y: oy + 256, width: 311, height: 48, fill: LIGHT, stroke: GRAY, strokeWidth: 1, radius: 8, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Email label', x: ox + 48, y: oy + 270, width: 100, height: 16, fill: 'transparent', text: 'Email', fontSize: 13, textColor: '#94a3b8', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Password field', x: ox + 32, y: oy + 320, width: 311, height: 48, fill: LIGHT, stroke: GRAY, strokeWidth: 1, radius: 8, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Password label', x: ox + 48, y: oy + 334, width: 100, height: 16, fill: 'transparent', text: 'Password', fontSize: 13, textColor: '#94a3b8', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Sign in button', x: ox + 32, y: oy + 392, width: 311, height: 48, fill: DARK, stroke: 'transparent', strokeWidth: 0, radius: 8, fontSize: 14, textColor: '#ffffff' });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Sign in label', x: ox + 150, y: oy + 410, width: 80, height: 16, fill: 'transparent', text: 'Sign in', fontSize: 14, textColor: '#ffffff', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Forgot password', x: ox + 110, y: oy + 460, width: 160, height: 16, fill: 'transparent', text: 'Forgot password?', fontSize: 13, textColor: '#0ea5e9', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      break;
    }
    case 'mobile_signup': {
      addFrame(375, 667, 'Mobile / Signup');
      add({ id: crypto.randomUUID(), type: 'text', name: 'Heading', x: ox + 32, y: oy + 80, width: 250, height: 28, fill: 'transparent', text: 'Create account', fontSize: 22, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Subheading', x: ox + 32, y: oy + 116, width: 280, height: 20, fill: 'transparent', text: 'Join us in 30 seconds', fontSize: 14, textColor: '#64748b', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Name field', x: ox + 32, y: oy + 176, width: 311, height: 48, fill: LIGHT, stroke: GRAY, strokeWidth: 1, radius: 8, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Email field', x: ox + 32, y: oy + 240, width: 311, height: 48, fill: LIGHT, stroke: GRAY, strokeWidth: 1, radius: 8, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Password field', x: ox + 32, y: oy + 304, width: 311, height: 48, fill: LIGHT, stroke: GRAY, strokeWidth: 1, radius: 8, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'CTA button', x: ox + 32, y: oy + 376, width: 311, height: 48, fill: DARK, stroke: 'transparent', strokeWidth: 0, radius: 8, fontSize: 14, textColor: '#ffffff' });
      add({ id: crypto.randomUUID(), type: 'text', name: 'CTA label', x: ox + 130, y: oy + 394, width: 120, height: 16, fill: 'transparent', text: 'Create account', fontSize: 14, textColor: '#ffffff', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Sign in link', x: ox + 90, y: oy + 450, width: 200, height: 16, fill: 'transparent', text: 'Already have an account? Sign in', fontSize: 13, textColor: '#0ea5e9', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      break;
    }
    case 'mobile_dashboard': {
      addFrame(375, 667, 'Mobile / Dashboard');
      // Header
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Header', x: ox, y: oy, width: 375, height: 64, fill: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0, fontSize: 16, textColor: '#ffffff' });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Header title', x: ox + 16, y: oy + 22, width: 200, height: 20, fill: 'transparent', text: 'Dashboard', fontSize: 18, textColor: '#ffffff', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      // Stats cards
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Stat 1', x: ox + 16, y: oy + 88, width: 165, height: 80, fill: LIGHT, stroke: GRAY, strokeWidth: 1, radius: 8, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Stat 1 value', x: ox + 28, y: oy + 108, width: 100, height: 24, fill: 'transparent', text: '$12,430', fontSize: 20, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Stat 1 label', x: ox + 28, y: oy + 138, width: 100, height: 16, fill: 'transparent', text: 'Revenue', fontSize: 12, textColor: '#64748b', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Stat 2', x: ox + 193, y: oy + 88, width: 165, height: 80, fill: LIGHT, stroke: GRAY, strokeWidth: 1, radius: 8, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Stat 2 value', x: ox + 205, y: oy + 108, width: 100, height: 24, fill: 'transparent', text: '1,284', fontSize: 20, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Stat 2 label', x: ox + 205, y: oy + 138, width: 100, height: 16, fill: 'transparent', text: 'Users', fontSize: 12, textColor: '#64748b', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      // Chart placeholder
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Chart', x: ox + 16, y: oy + 184, width: 343, height: 180, fill: LIGHT, stroke: GRAY, strokeWidth: 1, radius: 8, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Chart label', x: ox + 32, y: oy + 200, width: 200, height: 16, fill: 'transparent', text: 'Revenue (last 30 days)', fontSize: 13, textColor: '#64748b', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      // List
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'List item 1', x: ox + 16, y: oy + 380, width: 343, height: 56, fill: '#ffffff', stroke: GRAY, strokeWidth: 1, radius: 8, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'ellipse', name: 'Avatar 1', x: ox + 28, y: oy + 392, width: 32, height: 32, fill: GRAY, stroke: 'transparent', strokeWidth: 0, radius: 0, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Item 1 title', x: ox + 72, y: oy + 396, width: 200, height: 16, fill: 'transparent', text: 'Sarah Chen', fontSize: 14, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Item 1 sub', x: ox + 72, y: oy + 414, width: 200, height: 14, fill: 'transparent', text: 'Pro · 2 min ago', fontSize: 12, textColor: '#94a3b8', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      // Tab bar
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Tab bar', x: ox, y: oy + 615, width: 375, height: 52, fill: '#ffffff', stroke: GRAY, strokeWidth: 1, radius: 0, fontSize: 14, textColor: DARK });
      break;
    }
    case 'web_landing': {
      addFrame(1280, 800, 'Web / Landing');
      // Nav
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Nav', x: ox, y: oy, width: 1280, height: 64, fill: '#ffffff', stroke: GRAY, strokeWidth: 1, radius: 0, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Logo', x: ox + 48, y: oy + 22, width: 100, height: 20, fill: 'transparent', text: 'Brand', fontSize: 18, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Nav CTA', x: ox + 1130, y: oy + 14, width: 100, height: 36, fill: DARK, stroke: 'transparent', strokeWidth: 0, radius: 6, fontSize: 14, textColor: '#ffffff' });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Nav CTA label', x: ox + 1152, y: oy + 24, width: 60, height: 16, fill: 'transparent', text: 'Sign up', fontSize: 13, textColor: '#ffffff', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      // Hero
      add({ id: crypto.randomUUID(), type: 'text', name: 'Hero heading', x: ox + 48, y: oy + 200, width: 600, height: 64, fill: 'transparent', text: 'Build better, ship faster', fontSize: 48, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Hero subheading', x: ox + 48, y: oy + 280, width: 560, height: 48, fill: 'transparent', text: 'The platform that turns ideas into products. Trusted by 10,000+ teams.', fontSize: 18, textColor: '#64748b', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Primary CTA', x: ox + 48, y: oy + 360, width: 160, height: 48, fill: DARK, stroke: 'transparent', strokeWidth: 0, radius: 8, fontSize: 14, textColor: '#ffffff' });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Primary CTA label', x: ox + 80, y: oy + 376, width: 100, height: 16, fill: 'transparent', text: 'Get started', fontSize: 14, textColor: '#ffffff', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Secondary CTA', x: ox + 224, y: oy + 360, width: 140, height: 48, fill: 'transparent', stroke: GRAY, strokeWidth: 1, radius: 8, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Secondary CTA label', x: ox + 250, y: oy + 376, width: 90, height: 16, fill: 'transparent', text: 'Watch demo', fontSize: 14, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      // Hero image placeholder
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Hero image', x: ox + 720, y: oy + 160, width: 480, height: 320, fill: LIGHT, stroke: GRAY, strokeWidth: 1, radius: 12, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'ellipse', name: 'Image icon', x: ox + 936, y: oy + 296, width: 48, height: 48, fill: GRAY, stroke: 'transparent', strokeWidth: 0, radius: 0, fontSize: 14, textColor: DARK });
      // Logos strip
      add({ id: crypto.randomUUID(), type: 'text', name: 'Logos label', x: ox + 48, y: oy + 560, width: 200, height: 16, fill: 'transparent', text: 'Trusted by', fontSize: 13, textColor: '#94a3b8', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      for (let i = 0; i < 5; i++) {
        add({ id: crypto.randomUUID(), type: 'rectangle', name: `Logo ${i + 1}`, x: ox + 48 + i * 200, y: oy + 600, width: 160, height: 32, fill: LIGHT, stroke: GRAY, strokeWidth: 1, radius: 4, fontSize: 14, textColor: DARK });
      }
      break;
    }
    case 'web_dashboard': {
      addFrame(1280, 800, 'Web / Dashboard');
      // Sidebar
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Sidebar', x: ox, y: oy, width: 240, height: 800, fill: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0, fontSize: 14, textColor: '#ffffff' });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Sidebar logo', x: ox + 24, y: oy + 24, width: 120, height: 20, fill: 'transparent', text: 'Dashboard', fontSize: 18, textColor: '#ffffff', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      for (let i = 0; i < 5; i++) {
        add({ id: crypto.randomUUID(), type: 'rectangle', name: `Nav item ${i + 1}`, x: ox + 16, y: oy + 80 + i * 48, width: 208, height: 36, fill: i === 0 ? '#334155' : 'transparent', stroke: 'transparent', strokeWidth: 0, radius: 6, fontSize: 14, textColor: '#ffffff' });
      }
      // Topbar
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Topbar', x: ox + 240, y: oy, width: 1040, height: 64, fill: '#ffffff', stroke: GRAY, strokeWidth: 1, radius: 0, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Page title', x: ox + 264, y: oy + 22, width: 200, height: 20, fill: 'transparent', text: 'Overview', fontSize: 18, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'ellipse', name: 'User avatar', x: ox + 1192, y: oy + 16, width: 32, height: 32, fill: GRAY, stroke: 'transparent', strokeWidth: 0, radius: 0, fontSize: 14, textColor: DARK });
      // Stats cards
      for (let i = 0; i < 4; i++) {
        add({ id: crypto.randomUUID(), type: 'rectangle', name: `Stat card ${i + 1}`, x: ox + 264 + i * 248, y: oy + 96, width: 232, height: 96, fill: '#ffffff', stroke: GRAY, strokeWidth: 1, radius: 8, fontSize: 14, textColor: DARK });
        add({ id: crypto.randomUUID(), type: 'text', name: `Stat ${i + 1} label`, x: ox + 280 + i * 248, y: oy + 112, width: 100, height: 14, fill: 'transparent', text: ['Revenue', 'Users', 'Orders', 'Churn'][i], fontSize: 12, textColor: '#64748b', stroke: 'transparent', strokeWidth: 0, radius: 0 });
        add({ id: crypto.randomUUID(), type: 'text', name: `Stat ${i + 1} value`, x: ox + 280 + i * 248, y: oy + 132, width: 150, height: 28, fill: 'transparent', text: ['$12.4k', '1,284', '342', '2.1%'][i], fontSize: 22, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      }
      // Chart
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Main chart', x: ox + 264, y: oy + 224, width: 720, height: 320, fill: '#ffffff', stroke: GRAY, strokeWidth: 1, radius: 8, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Chart title', x: ox + 280, y: oy + 240, width: 200, height: 16, fill: 'transparent', text: 'Revenue over time', fontSize: 14, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      // Right panel
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Right panel', x: ox + 1000, y: oy + 224, width: 256, height: 320, fill: '#ffffff', stroke: GRAY, strokeWidth: 1, radius: 8, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Panel title', x: ox + 1016, y: oy + 240, width: 200, height: 16, fill: 'transparent', text: 'Recent activity', fontSize: 14, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      for (let i = 0; i < 4; i++) {
        add({ id: crypto.randomUUID(), type: 'ellipse', name: `Activity avatar ${i + 1}`, x: ox + 1016, y: oy + 280 + i * 56, width: 24, height: 24, fill: GRAY, stroke: 'transparent', strokeWidth: 0, radius: 0, fontSize: 14, textColor: DARK });
        add({ id: crypto.randomUUID(), type: 'rectangle', name: `Activity line ${i + 1}a`, x: ox + 1056, y: oy + 282 + i * 56, width: 160, height: 8, fill: LIGHT, stroke: 'transparent', strokeWidth: 0, radius: 4, fontSize: 14, textColor: DARK });
        add({ id: crypto.randomUUID(), type: 'rectangle', name: `Activity line ${i + 1}b`, x: ox + 1056, y: oy + 296 + i * 56, width: 100, height: 8, fill: LIGHT, stroke: 'transparent', strokeWidth: 0, radius: 4, fontSize: 14, textColor: DARK });
      }
      break;
    }
    case 'web_blog': {
      addFrame(1280, 800, 'Web / Blog');
      // Header
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Header', x: ox, y: oy, width: 1280, height: 80, fill: '#ffffff', stroke: GRAY, strokeWidth: 1, radius: 0, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Brand', x: ox + 80, y: oy + 28, width: 120, height: 24, fill: 'transparent', text: 'Blog', fontSize: 22, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      // Hero post
      add({ id: crypto.randomUUID(), type: 'rectangle', name: 'Hero image', x: ox + 80, y: oy + 120, width: 640, height: 360, fill: LIGHT, stroke: GRAY, strokeWidth: 1, radius: 12, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Hero title', x: ox + 760, y: oy + 140, width: 440, height: 56, fill: 'transparent', text: 'Designing for the AI era', fontSize: 32, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Hero excerpt', x: ox + 760, y: oy + 220, width: 440, height: 120, fill: 'transparent', text: 'How AI is reshaping the design workflow, from research to delivery, and what it means for product teams in 2026.', fontSize: 15, textColor: '#64748b', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'ellipse', name: 'Author avatar', x: ox + 760, y: oy + 360, width: 40, height: 40, fill: GRAY, stroke: 'transparent', strokeWidth: 0, radius: 0, fontSize: 14, textColor: DARK });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Author name', x: ox + 812, y: oy + 364, width: 200, height: 16, fill: 'transparent', text: 'Sarah Chen · 6 min read', fontSize: 13, textColor: '#64748b', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      // Post grid
      for (let i = 0; i < 3; i++) {
        const px = ox + 80 + i * 386;
        add({ id: crypto.randomUUID(), type: 'rectangle', name: `Post ${i + 1} image`, x: px, y: oy + 540, width: 360, height: 180, fill: LIGHT, stroke: GRAY, strokeWidth: 1, radius: 8, fontSize: 14, textColor: DARK });
        add({ id: crypto.randomUUID(), type: 'text', name: `Post ${i + 1} title`, x: px, y: oy + 740, width: 360, height: 24, fill: 'transparent', text: ['AI design tools', 'Design systems', 'Prototyping'][i], fontSize: 16, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      }
      break;
    }
    case 'web_pricing': {
      addFrame(1280, 800, 'Web / Pricing');
      add({ id: crypto.randomUUID(), type: 'text', name: 'Page heading', x: ox + 440, y: oy + 80, width: 400, height: 48, fill: 'transparent', text: 'Simple, transparent pricing', fontSize: 36, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
      add({ id: crypto.randomUUID(), type: 'text', name: 'Page subheading', x: ox + 380, y: oy + 140, width: 520, height: 24, fill: 'transparent', text: 'Start free. Upgrade when you grow.', fontSize: 16, textColor: '#64748b', stroke: 'transparent', strokeWidth: 0, radius: 0 });
      for (let i = 0; i < 3; i++) {
        const px = ox + 240 + i * 320;
        const featured = i === 1;
        add({ id: crypto.randomUUID(), type: 'rectangle', name: `Tier ${i + 1} card`, x: px, y: oy + 220, width: 280, height: 440, fill: '#ffffff', stroke: featured ? DARK : GRAY, strokeWidth: featured ? 2 : 1, radius: 12, fontSize: 14, textColor: DARK });
        add({ id: crypto.randomUUID(), type: 'text', name: `Tier ${i + 1} name`, x: px + 24, y: oy + 248, width: 200, height: 20, fill: 'transparent', text: ['Starter', 'Pro', 'Enterprise'][i], fontSize: 18, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
        add({ id: crypto.randomUUID(), type: 'text', name: `Tier ${i + 1} price`, x: px + 24, y: oy + 288, width: 200, height: 40, fill: 'transparent', text: ['$0', '$24', 'Custom'][i], fontSize: 36, textColor: DARK, stroke: 'transparent', strokeWidth: 0, radius: 0 });
        add({ id: crypto.randomUUID(), type: 'rectangle', name: `Tier ${i + 1} CTA`, x: px + 24, y: oy + 360, width: 232, height: 40, fill: featured ? DARK : LIGHT, stroke: 'transparent', strokeWidth: 0, radius: 8, fontSize: 14, textColor: featured ? '#ffffff' : DARK });
        for (let j = 0; j < 4; j++) {
          add({ id: crypto.randomUUID(), type: 'rectangle', name: `Tier ${i + 1} feature ${j + 1}`, x: px + 24, y: oy + 420 + j * 28, width: 200, height: 8, fill: LIGHT, stroke: 'transparent', strokeWidth: 0, radius: 4, fontSize: 14, textColor: DARK });
        }
      }
      break;
    }
    default: {
      // Fallback: empty frame.
      addFrame(400, 300, 'Wireframe');
      break;
    }
  }
  return { frameId, shapes };
}

interface UserFlowResult {
  frameIds: string[];
  shapes: Array<Partial<Shape> & { id: string }>;
}

function buildUserFlow(flow: string, ox: number, oy: number): UserFlowResult {
  // Each step is a mobile screen (375 wide) with a 64px gap.
  const SCREEN_W = 375;
  const GAP = 80;
  const ARROW_COLOR = '#94a3b8';

  const flows: Record<string, string[]> = {
    onboarding: ['mobile_login', 'mobile_signup', 'mobile_dashboard'],
    ecommerce: ['web_landing', 'mobile_dashboard', 'mobile_dashboard', 'mobile_login'],
    auth: ['mobile_login', 'mobile_dashboard', 'mobile_dashboard'],
    signup_funnel: ['web_landing', 'mobile_signup', 'mobile_login', 'mobile_dashboard'],
  };
  const screens = flows[flow] ?? flows.onboarding;

  const frameIds: string[] = [];
  const shapes: Array<Partial<Shape> & { id: string }> = [];

  screens.forEach((tmpl, i) => {
    const sx = ox + i * (SCREEN_W + GAP);
    const wf = buildWireframe(tmpl, sx, oy);
    // Rename the frame to include the step number.
    wf.shapes[0] = { ...wf.shapes[0], name: `Step ${i + 1}` };
    shapes.push(...wf.shapes);
    frameIds.push(wf.frameId);

    // Add an arrow connector to the next screen.
    if (i < screens.length - 1) {
      const arrowStartX = sx + SCREEN_W;
      const arrowEndX = sx + SCREEN_W + GAP;
      const arrowY = oy + 300;
      shapes.push({
        id: crypto.randomUUID(),
        type: 'line',
        name: `Arrow ${i + 1}→${i + 2}`,
        x: arrowStartX,
        y: arrowY,
        width: arrowEndX - arrowStartX,
        height: 0,
        fill: ARROW_COLOR,
        stroke: ARROW_COLOR,
        strokeWidth: 2,
        radius: 0,
        fontSize: 14,
        textColor: ARROW_COLOR,
      });
    }
  });
  return { frameIds, shapes };
}

interface DiagramResult {
  shapes: Array<Partial<Shape> & { id: string }>;
}

function buildDiagram(template: string, labels: string[], ox: number, oy: number): DiagramResult {
  const shapes: Array<Partial<Shape> & { id: string }> = [];
  const NODE_W = 160;
  const NODE_H = 56;
  const NODE_FILL = '#ffffff';
  const NODE_STROKE = '#475569';
  const ARROW = '#94a3b8';

  const addNode = (label: string, x: number, y: number) => {
    shapes.push({
      id: crypto.randomUUID(),
      type: 'rectangle',
      name: label,
      x, y, width: NODE_W, height: NODE_H,
      fill: NODE_FILL, stroke: NODE_STROKE, strokeWidth: 1, radius: 8,
      fontSize: 13, textColor: '#0f172a',
    });
    shapes.push({
      id: crypto.randomUUID(),
      type: 'text',
      name: `${label} label`,
      x: x + 12, y: y + 18, width: NODE_W - 24, height: 20,
      fill: 'transparent', text: label, fontSize: 13, textColor: '#0f172a',
      stroke: 'transparent', strokeWidth: 0, radius: 0,
    });
  };
  const addArrow = (x1: number, y1: number, x2: number, y2: number) => {
    shapes.push({
      id: crypto.randomUUID(),
      type: 'line',
      name: 'connector',
      x: x1, y: y1, width: x2 - x1, height: y2 - y1,
      fill: ARROW, stroke: ARROW, strokeWidth: 2, radius: 0,
      fontSize: 14, textColor: ARROW,
    });
  };

  if (template === 'flowchart') {
    // Top-down: each node centered, vertical arrow between.
    const cx = ox + 200;
    let cy = oy;
    const STEP = NODE_H + 60;
    labels.forEach((label, i) => {
      addNode(label, cx, cy);
      if (i < labels.length - 1) {
        addArrow(cx + NODE_W / 2, cy + NODE_H, cx + NODE_W / 2, cy + STEP);
      }
      cy += STEP;
    });
  } else {
    // Mindmap: central node + radial children.
    const cx = ox + 360;
    const cy = oy + 280;
    const centerLabel = labels[0];
    addNode(centerLabel, cx - NODE_W / 2, cy - NODE_H / 2);
    const radius = 220;
    const childCount = labels.length - 1;
    for (let i = 1; i < labels.length; i++) {
      const angle = (i - 1) / Math.max(1, childCount) * Math.PI * 2;
      const px = cx + Math.cos(angle) * radius - NODE_W / 2;
      const py = cy + Math.sin(angle) * radius - NODE_H / 2;
      addArrow(cx, cy, px + NODE_W / 2, py + NODE_H / 2);
      addNode(labels[i], px, py);
    }
  }
  return { shapes };
}

// ---- Copy generation variants ----------------------------------------------

const COPY_VARIANTS: Record<string, (topic: string) => string> = {
  heading: (t) => `The fastest way to ship ${t}`,
  subheading: (t) => `Everything you need to build, launch, and grow ${t} — without the busywork.`,
  body: (t) =>
    `${capitalize(t)} is changing fast. Teams that ship quickly win, and teams that don't fall behind. ` +
    `Our platform brings design, code, and feedback into one shared space, so you can move from idea to production ` +
    `in days, not months. Built for modern product teams who care about both speed and craft.`,
  button: (_t) => `Get started free`,
  caption: (t) => `A closer look at how ${t} works in practice.`,
  microcopy: (_t) => `We'll never share your email. Unsubscribe anytime.`,
};

// ---- Color utilities -------------------------------------------------------

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function luminance(hex: string): number {
  const m = hex.replace('#', '');
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(fg: string, bg: string): number {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function isHighContrast(a: string, b: string): boolean {
  return contrastRatio(a, b) > 4.5;
}
