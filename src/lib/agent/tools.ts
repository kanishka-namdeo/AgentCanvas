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
