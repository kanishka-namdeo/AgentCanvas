// Agent runner — the core agent loop.
//
// This module ties together:
//   - The Pi Agent SDK's `defineTool` tool surface (from `./tools.ts`).
//   - An LLM driver. In production this would be `createAgentSession` from
//     `@earendil-works/pi-coding-agent` backed by Anthropic/OpenAI via
//     `pi-ai`. In this sandbox we don't have those API keys, so we drive
//     the loop with `z-ai-web-dev-sdk` (which speaks the OpenAI tool-calling
//     protocol).
//   - A patch sink + event stream that the caller (the API route) forwards
//     to the WebSocket service for live broadcast to viewers.
//
// The event shape mirrors Pi's `AgentSessionEvent` union so that swapping
// in a real Pi session later only changes the producer, not the consumer.

import ZAI from 'z-ai-web-dev-sdk';
import { createCanvasTools, executeTool, toolsToOpenAISpec, type CanvasToolContext } from './tools.ts';
import type { CanvasDocument, CanvasPatch, Shape, SyncEvent } from '../canvas/types.ts';
import { applyPatchToCanvas } from '../canvas/patch.ts';

export interface AgentRunOptions {
  documentId: string;
  prompt: string;
  /// Snapshot of the canvas at the start of the turn.
  canvas: CanvasDocument;
}

export interface AgentRunHandle {
  /// Streamed events. The caller reads these and forwards them to viewers.
  stream: AsyncIterable<AgentStreamEvent>;
}

export type AgentStreamEvent =
  | { kind: 'patch'; patch: CanvasPatch; toolCallId?: string }
  | { kind: 'agent_event'; event: SyncEvent };

const SYSTEM_PROMPT = `You are an AI design agent operating a Figma-like canvas powered by the Pi Agent SDK.

You can see the current canvas state and manipulate it through tools. Your job is to take the user's natural-language request and produce a visually pleasing, production-ready design on the canvas.

=== TOOL CATEGORIES (24 tools) =============================================

CORE CANVAS OPS:
  canvas_create_shape, canvas_update_shape, canvas_delete_shape,
  canvas_list_shapes, canvas_clear, canvas_set_background, canvas_select_shape

LAYER ORGANIZATION:
  canvas_duplicate_shape   — copy shapes (offset 24px)
  canvas_group_shapes      — wrap shapes in a group
  canvas_ungroup_shapes    — dissolve groups
  canvas_align_shapes      — align/distribute (left/right/center_h/top/bottom/center_v/distribute_h/distribute_v)
  canvas_organize_layers   — auto-rename + re-zIndex all shapes by type and reading order

AUTO LAYOUT (Figma-style):
  canvas_apply_auto_layout — set direction/gap/padding/alignment on a frame; children auto-arrange

COMPONENTS & VARIANTS:
  canvas_create_component     — mark a shape as a reusable component
  canvas_instantiate_component — place a linked instance of a component

DESIGN TOKENS / VARIABLES:
  canvas_update_tokens     — define named colors + text styles (shapes can bind to them)
  canvas_apply_palette     — recolor shapes by mapping to a new palette (nearest match)
  canvas_generate_palette  — generate a 5-color harmonious palette (analogous/complementary/triadic/monochromatic/split_complementary)

GENERATORS (one-shot, template-driven):
  canvas_generate_wireframe — mobile_login, mobile_signup, mobile_dashboard, web_landing,
                              web_dashboard, web_blog, web_pricing
  canvas_generate_user_flow — onboarding (3 steps), ecommerce (4), auth (3), signup_funnel (4)
  canvas_generate_diagram   — flowchart (top-down) or mindmap (radial)

ANALYSIS (read-only):
  canvas_predict_heatmap   — overlay a predicted attention heatmap on a frame
  canvas_generate_copy     — fill a text shape with realistic placeholder copy
                             (heading/subheading/body/button/caption/microcopy)
  canvas_audit_design      — audit the canvas for consistency issues (color drift, type scale,
                             low-contrast text, token usage, alignment near-misses)

=== DESIGN PRINCIPLES ======================================================

- Be deliberate about layout: use a grid, align shapes, leave breathing room.
- Pick harmonious colors. Default to a modern, minimal palette unless told otherwise.
  Suggested palettes:
  • Slate: bg #f8fafc, fills #e2e8f0 / #cbd5e1 / #94a3b8, accent #0ea5e9, text #0f172a
  • Warm: bg #fff7ed, fills #fed7aa / #fdba74 / #fb923c, accent #ea580c, text #431407
  • Forest: bg #f0fdf4, fills #dcfce7 / #bbf7d0 / #86efac, accent #16a34a, text #052e16
  • Mono: bg #fafaf9, fills #e7e5e4 / #d6d3d1 / #a8a29e, accent #18181b, text #18181b
- When creating multiple shapes, give each a sensible name (e.g. "Header", "Card", "Avatar").
- Coordinates are canvas-space pixels. The viewport at zoom 1 shows roughly 0..1200 x 0..800.
  Center of visible area is around (600, 400). Place groups of shapes around a focal point.
- Always call canvas_list_shapes before updating/deleting existing shapes so you know the ids.
- After creating shapes, briefly summarize what you did in 1-2 sentences. Do not narrate every step.
- If the user asks for something you cannot do with the available tools, say so clearly.

=== SCENARIO PLAYBOOK (match the user's intent to a tool sequence) =========

• "design a login screen" / "make a signup form"
    → canvas_generate_wireframe (mobile_login / mobile_signup / web_landing)
    → optionally canvas_apply_palette to recolor
    → optionally canvas_generate_copy on the text shapes

• "build a dashboard"
    → canvas_generate_wireframe (mobile_dashboard or web_dashboard)
    → optionally canvas_predict_heatmap on the resulting frame

• "create a user flow" / "design onboarding" / "ecommerce flow"
    → canvas_generate_user_flow (onboarding / ecommerce / auth / signup_funnel)

• "draw a flowchart" / "make a mindmap"
    → canvas_generate_diagram (flowchart / mindmap) with a list of node labels

• "generate a color palette from <color>" / "give me an analogous palette"
    → canvas_generate_palette (baseColor, rule)
    → optionally canvas_apply_palette to existing shapes (bindToTokens=true)

• "audit my design" / "check consistency"
    → canvas_audit_design (returns findings as text; then optionally fix issues)

• "show where users will look" / "predict attention"
    → canvas_predict_heatmap on a frame

• "fill placeholder text" / "write copy"
    → canvas_generate_copy (variant + topic) on each text shape

• "restyle / recolor / re-theme everything"
    → canvas_apply_palette with a new palette (and bindToTokens=true)

• "organize my layers"
    → canvas_organize_layers (auto-rename + re-zIndex)

• "align these shapes" / "distribute evenly"
    → canvas_align_shapes (kind=left/right/center_h/top/bottom/center_v/distribute_h/distribute_v)

• "make this a reusable component"
    → canvas_create_component, then canvas_instantiate_component to place copies

• "use auto layout on this frame"
    → canvas_apply_auto_layout (direction, gap, padding, alignX, alignY)

=== IMPORTANT — ARGUMENT TYPES =============================================

- All numeric arguments (x, y, width, height, fontSize, opacity, radius, strokeWidth, rotation)
  MUST be passed as JSON numbers, not strings. Write "x": 400, NOT "x": "400".
- Colors are hex strings like "#ff0000".
- shapeIds / nodes / palette MUST be arrays, even for a single item.

=== TURN FLOW ==============================================================

Build the full design in this turn — create every shape the user asked for, then stop.
You may call multiple tools in one turn if it helps. Stop calling tools when the design is done.
Prefer the high-level generator tools (generate_wireframe, generate_user_flow, generate_diagram)
over hand-placing many shapes — they produce well-structured output and conserve tool-call budget.`;

/// Build a textual snapshot of the canvas for the system message.
function canvasSnapshot(canvas: CanvasDocument): string {
  const shapeLines = canvas.shapes.length === 0
    ? '  (empty)'
    : canvas.shapes.map((s) =>
        `  • ${s.id} | ${s.type} "${s.name}" | pos=(${s.x.toFixed(0)},${s.y.toFixed(0)}) size=${s.width.toFixed(0)}×${s.height.toFixed(0)} fill=${s.fill}${s.text ? ` text="${s.text}"` : ''}${s.parentId ? ` parent=${s.parentId}` : ''}${s.componentId ? ` component=${s.componentId}` : ''}${s.autoLayout ? ` autoLayout=${s.autoLayout.direction}` : ''}`,
      ).join('\n');
  const tokenLines = canvas.tokens.colors.length === 0
    ? '  (no tokens)'
    : canvas.tokens.colors.map((c) => `  • ${c.key} = ${c.value}  (${c.name})`).join('\n');
  return `Current canvas state:
- Background: ${canvas.background}
- Tokens (${canvas.tokens.colors.length} colors, ${canvas.tokens.textStyles.length} text styles):
${tokenLines}
- Heatmap: ${canvas.heatmap ? `on (${canvas.heatmap.points.length} points, frame ${canvas.heatmap.frameId})` : 'off'}
- Shapes (${canvas.shapes.length}):
${shapeLines}`;
}

/// Run the agent loop. Yields events as they happen — patches for canvas
/// mutations, agent_events for the chat stream (message deltas, tool call
/// start/end, turn end).
export async function* runAgent(opts: AgentRunOptions): AsyncGenerator<AgentStreamEvent> {
  const { documentId, prompt, canvas: initialCanvas } = opts;

  // Per-session mutable state. The tools close over this via `ctx`.
  let canvas: CanvasDocument = JSON.parse(JSON.stringify(initialCanvas));

  const ctx: CanvasToolContext = {
    getShapes: () => canvas.shapes,
    getTokens: () => canvas.tokens,
    applyPatch(patch: CanvasPatch): CanvasPatch {
      // Apply locally so the next tool call sees the updated state.
      canvas = applyPatchToCanvas(canvas, patch);
      return patch;
    },
  };

  const tools = createCanvasTools(ctx);
  const toolSpecs = toolsToOpenAISpec(tools);

  // Build the initial message history.
  const messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: any[]; tool_call_id?: string }> = [
    { role: 'system', content: `${SYSTEM_PROMPT}\n\n${canvasSnapshot(canvas)}` },
    { role: 'user', content: prompt },
  ];

  // Initialize the z-ai-web-dev-sdk client. The sandbox provides credentials
  // automatically when this runs inside the Next.js API route.
  const zai = await ZAI.create();

  yield { kind: 'agent_event', event: { type: 'agent:message_start', role: 'assistant' } };

  const MAX_ITERATIONS = 20;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let completion: any;
    try {
      completion = await zai.chat.completions.create({
        messages: messages as any,
        tools: toolSpecs,
        tool_choice: 'auto',
        temperature: 0.4,
      });
    } catch (err: any) {
      yield { kind: 'agent_event', event: { type: 'agent:error', message: `LLM request failed: ${err.message}` } };
      return;
    }

    const choice = completion?.choices?.[0];
    const msg = choice?.message;
    if (!msg) {
      yield { kind: 'agent_event', event: { type: 'agent:error', message: 'LLM returned no message' } };
      return;
    }

    // 1. If the model produced text, stream it out.
    if (msg.content) {
      yield { kind: 'agent_event', event: { type: 'agent:message_delta', text: msg.content } };
    }

    // 2. If the model called tools, execute them.
    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) {
      // No tool calls → final answer. End the turn.
      yield { kind: 'agent_event', event: { type: 'agent:message_end' } };
      yield { kind: 'agent_event', event: { type: 'agent:turn_end' } };
      return;
    }

    // Append the assistant message (with tool_calls) to history.
    messages.push({
      role: 'assistant',
      content: msg.content ?? '',
      tool_calls: toolCalls.map((tc: any) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
    });

    // Execute each tool call sequentially. (Pi's default mode is sequential
    // for tools that mutate shared state — same principle here.)
    for (const tc of toolCalls) {
      const toolName: string = tc.function.name;
      let args: any;
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch {
        args = {};
      }
      const argsPreview = JSON.stringify(args).slice(0, 120);

      yield {
        kind: 'agent_event',
        event: {
          type: 'agent:tool_call_start',
          toolCallId: tc.id,
          toolName,
          argsPreview,
        },
      };

      const result = await executeTool(tools, toolName, args);

      if (result.patch) {
        yield { kind: 'patch', patch: result.patch, toolCallId: tc.id };
      }

      yield {
        kind: 'agent_event',
        event: {
          type: 'agent:tool_call_end',
          toolCallId: tc.id,
          success: !result.isError,
          summary: result.patch?.summary ?? result.content.slice(0, 160),
        },
      };

      // Append tool result to message history so the next LLM iteration sees it.
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: result.content,
      });
    }

    // Refresh the system snapshot for the next iteration so the LLM sees the
    // updated canvas. (We replace the first system message in-place.)
    messages[0] = {
      role: 'system',
      content: `${SYSTEM_PROMPT}\n\n${canvasSnapshot(canvas)}`,
    };
  }

  // If we hit MAX_ITERATIONS, stop gracefully.
  yield { kind: 'agent_event', event: { type: 'agent:message_end' } };
  yield { kind: 'agent_event', event: { type: 'agent:turn_end' } };
}
