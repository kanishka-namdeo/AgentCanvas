// Pi Agent SDK custom tools for canvas manipulation.
//
// This file is the canonical "agent-usable" surface of the Figma-like app.
// Each tool is defined with `defineTool` from `@earendil-works/pi-coding-agent`
// (the real Pi Agent SDK), using TypeBox (`@sinclair/typebox`) for parameter
// schemas — exactly the pattern documented at
// https://pi.dev/docs/latest/sdk.
//
// How this maps to the Pi Agent SDK:
//   - `defineTool({ name, description, parameters, execute })` is the SDK's
//     primary extension point. The agent LLM sees `name` + `description` +
//     `parameters` and decides when to call the tool.
//   - `execute()` returns `AgentToolResult<T>` — `{ content, details }`. We
//     put a `CanvasPatch` inside `details.patch` so any Pi-compatible UI
//     (or our z-ai-web-dev-sdk driver) can render / replay the mutation.
//
// The agent backend (see `src/lib/agent/runner.ts`) registers these tools
// with the LLM and invokes their `execute` when the LLM calls them.

import { Type, type Static } from '@sinclair/typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { CanvasPatch, Shape, ShapeType } from '../canvas/types.ts';

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
  /// Apply a patch (the tool's effect) and return the patched document.
  applyPatch: (patch: CanvasPatch) => CanvasPatch;
  /// Emit a progress update (visible in the agent UI while the tool runs).
  // (handled by `onUpdate` in the runner — not used directly here)
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
  type: ShapeTypeSchema,
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

// ---- Tool factory -----------------------------------------------------------

/// Coerce LLM-provided arguments into the types the schema expects.
/// LLMs sometimes pass numbers as strings (e.g. `x: "400"` instead of `400`).
/// This helper normalizes those before they reach the patch layer.
function coerceShapeInput(params: Static<typeof ShapeInputSchema>): Partial<Shape> {
  const out: Partial<Shape> = { type: params.type as Shape['type'] };
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

export function createCanvasTools(ctx: CanvasToolContext) {
  // canvas_create_shape ------------------------------------------------------
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
      const patch: CanvasPatch = {
        op: 'add',
        shapeId: id,
        shape: { id, ...coerced, zIndex: ctx.getShapes().length },
        summary: `Created ${params.type}${params.name ? ` "${params.name}"` : ''} at (${coerced.x ?? 0}, ${coerced.y ?? 0})`,
      };
      ctx.applyPatch(patch);
      return {
        content: [
          {
            type: 'text',
            text: `Created ${params.type} with id ${id}. Coordinates: (${coerced.x ?? 0}, ${coerced.y ?? 0}), size ${coerced.width ?? 100}×${coerced.height ?? 100}.`,
          },
        ],
        details: { shapeId: id, patch },
      };
    },
  });

  // canvas_update_shape -------------------------------------------------------
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
      shapeId: Type.String({ description: 'ID of the shape to update' }),
      changes: ShapeInputSchema,
    }),
    async execute(toolCallId, params) {
      const existing = ctx.getShapes().find((s) => s.id === params.shapeId);
      if (!existing) {
        return {
          content: [{ type: 'text', text: `Error: no shape with id ${params.shapeId}` }],
          details: { error: 'not_found', shapeId: params.shapeId },
          isError: true as any,
        };
      }
      const coerced = coerceShapeInput(params.changes);
      const patch: CanvasPatch = {
        op: 'update',
        shapeId: params.shapeId,
        shape: coerced,
        summary: `Updated ${existing.name}: ${Object.keys(coerced).join(', ')}`,
      };
      ctx.applyPatch(patch);
      return {
        content: [
          { type: 'text', text: `Updated ${existing.name} (${params.shapeId}). Changed: ${Object.keys(coerced).join(', ')}.` },
        ],
        details: { shapeId: params.shapeId, patch },
      };
    },
  });

  // canvas_delete_shape -------------------------------------------------------
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

  // canvas_list_shapes --------------------------------------------------------
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
      const summary = shapes
        .map(
          (s) =>
            `• ${s.id} | ${s.type} "${s.name}" | pos=(${s.x.toFixed(0)},${s.y.toFixed(0)}) size=${s.width.toFixed(0)}×${s.height.toFixed(0)} fill=${s.fill}${s.text ? ` text="${s.text}"` : ''}`,
        )
        .join('\n');
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

  // canvas_clear --------------------------------------------------------------
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

  // canvas_set_background -----------------------------------------------------
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

  // canvas_select_shape -------------------------------------------------------
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

  return [
    createShape,
    updateShape,
    deleteShape,
    listShapes,
    clearCanvas,
    setBackground,
    selectShape,
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
): Promise<{ content: string; patch?: CanvasPatch; isError?: boolean }> {
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
