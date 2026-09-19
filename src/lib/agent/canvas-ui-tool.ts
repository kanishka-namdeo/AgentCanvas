// pen_canvas_ui_control — the OpenHands canvas_ui_control tool pattern,
// adapted to AgentCanvas (task impl-canvas-ui-tool).
//
// OpenHands ships a `canvas_ui_control` tool whose description is a
// prompt-engineered paragraph: "The user is interacting with you inside
// Agent Canvas — a web UI with a chat panel on the left and a tabbed
// right-side panel. They will NOT see the files you wrote, the terminal
// output, or the browser unless you call this tool. Call this BEFORE writing
// your chat-message summary of the change, so the artifact is visible while
// the user reads what you did."
//
// The agent calls the tool to drive the right panel itself; the action event
// is intercepted client-side and dispatched locally — the server only acks.
//
// AgentCanvas's 3-pane layout (left sidebar = Sessions, center = canvas +
// chat, right sidebar = Layers / Properties / Design Systems / Assets) maps
// to these commands:
//
//   - focus_shape(shapeId)       — select the shape + open the right Properties
//                                  (Design) tab so the inspector is visible
//   - show_chat                  — expand the chat panel (the agent's message
//                                  streams there)
//   - show_history               — open the Version History dialog (the
//                                  snapshots timeline — AgentCanvas has no
//                                  History tab in the right sidebar)
//   - show_layers                — switch the right sidebar to the Layers tab
//   - zoom_to_selection(shapeId?) — fit the viewport to the selection (or to
//                                  the named shape, when shapeId is given)
//
// The tool's execute body emits an `agent:canvas_ui_action` SyncEvent via
// the plugin event bus (the same channel ask_user_question / todo_update
// use). The runner forwards it on the wire; the client's canvas store
// dispatches it to the canvas-ui-dispatcher module, which performs the
// side-effects (selection + window CustomEvents for the page-level React
// state). The tool itself NEVER touches the canvas store directly — it
// returns an ack to the LLM while the UI side-effect happens asynchronously
// on every connected viewer.

import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { CanvasUIAction } from '../canvas/types';
import { emitEvent } from './plugins/event-bus';

/// The OpenHands-style prompt-engineered paragraph that explains to the LLM
/// WHY it must call this tool. Kept as a module-level constant so the system
/// prompt's tool catalog mirrors it exactly (the SDK surfaces `description`).
const TOOL_DESCRIPTION = [
  'Drive the AgentCanvas workspace UI so the user sees what you just made.',
  '',
  'The user is interacting with you inside AgentCanvas — a 3-pane web workspace',
  'with a Sessions sidebar on the left, a canvas in the center (with the chat',
  'panel docked below it), and a tabbed right sidebar (Layers / Properties /',
  'Design Systems / Assets). The user will NOT see the shape you created, the',
  'canvas state, or the chat panel unless you call this tool to surface them.',
  'Call this BEFORE writing your chat-message summary of the change, so the',
  'artifact is visible while the user reads what you did — otherwise the user',
  'reads your summary, looks up, and sees nothing has changed (they are likely',
  'staring at the Chat tab or a different selection).',
  '',
  'Commands:',
  '  - focus_shape(shapeId)        — select the shape AND switch the right',
  '                                  sidebar to the Properties (Design) tab so',
  '                                  its inspector is visible. Use this right',
  '                                  after you create or update a shape.',
  '  - show_chat                   — expand the chat panel so the user sees',
  '                                  your streaming reply.',
  '  - show_history                — open the Version History dialog (the',
  '                                  snapshots timeline).',
  '  - show_layers                 — switch the right sidebar to the Layers',
  '                                  tab (the layer tree).',
  '  - zoom_to_selection(shapeId?) — fit the viewport to the current',
  '                                  selection, or to the shape named by',
  '                                  shapeId when provided. Use this when you',
  '                                  placed content outside the visible rect.',
  '',
  'Common pattern: create a shape → call focus_shape with its id → optionally',
  'zoom_to_selection if it is off-screen → THEN write your chat summary. The',
  'action is intercepted client-side and dispatched locally; this call only',
  'acks. Multiple viewers all see the same UI nudge (it is fanned out — it is',
  'not private to the prompting client).',
].join('\n');

/// Tool name as exposed to the LLM. `pen_` prefix follows the AgentCanvas
/// canvas-tool naming convention (see ALL_TOOL_NAMES in skills/registry.ts).
export const CANVAS_UI_CONTROL_TOOL_NAME = 'pen_canvas_ui_control' as const;

/// The tool definition. No `ctx` is needed because this tool performs NO
/// canvas mutation — it emits a SyncEvent and returns an ack. The
/// side-effects happen client-side via the dispatcher.
///
/// Defined as a module-level const (rather than inside `createCanvasTools`)
/// because the tool has no closure dependencies. It is appended to the
/// `createCanvasTools` return array in tools.ts.
export const canvasUIControlTool = defineTool({
  name: CANVAS_UI_CONTROL_TOOL_NAME,
  label: 'Canvas UI Control',
  description: TOOL_DESCRIPTION,
  promptSnippet: 'Drive the workspace UI (focus a shape, show chat, switch tabs, zoom).',
  promptGuidelines: [
    'Call this BEFORE writing your chat-message summary — the user reads your summary while looking at the canvas, so the artifact must be visible first.',
    'After creating or updating a shape, call focus_shape with the shape id so the user sees it selected with its Properties inspector open.',
    'If the shape you just created is outside the visible viewport, call zoom_to_selection immediately after focus_shape.',
    'When you have a long chat reply coming, call show_chat so the chat panel expands and the user sees the stream.',
    'One tool call per command — batch multiple commands in separate parallel tool calls if you need both (e.g. focus_shape + zoom_to_selection).',
  ],
  parameters: Type.Object({
    command: Type.Union(
      [
        Type.Literal('focus_shape'),
        Type.Literal('show_chat'),
        Type.Literal('show_history'),
        Type.Literal('show_layers'),
        Type.Literal('zoom_to_selection'),
      ],
      {
        description:
          'UI command to dispatch. focus_shape and zoom_to_selection require a shapeId. ' +
          'show_chat / show_history / show_layers take no extra arguments.',
      },
    ),
    shapeId: Type.Optional(
      Type.String({
        description:
          'Shape id. REQUIRED for focus_shape and zoom_to_selection (focus_shape errors without it; ' +
          'zoom_to_selection falls back to the current selection when omitted). Ignored for the other commands.',
      }),
    ),
  }),
  async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
    const command = params.command as CanvasUIAction['command'];
    const shapeId = typeof params.shapeId === 'string' ? params.shapeId : undefined;

    // ---- Validate per-command shapeId requirements ----------------------
    // focus_shape REQUIRES shapeId; zoom_to_selection makes it optional
    // (falls back to the current selection when omitted). The other commands
    // ignore it. Returning an error here (rather than letting the dispatcher
    // silently no-op) gives the LLM a self-correcting signal — it learns
    // the contract on the same turn instead of repeat-missing.
    if (command === 'focus_shape' && !shapeId) {
      return {
        content: [{
          type: 'text',
          text:
            'Error: focus_shape requires a shapeId. Call pen_get_metadata to see shape ids, ' +
            'then retry with pen_canvas_ui_control({ command: "focus_shape", shapeId: "<id>" }).',
        }],
        details: { error: 'shapeId_required', command },
        isError: true as any,
      };
    }

    // ---- Build the action + emit it through the event bus ----------------
    // The event bus (plugins/event-bus.ts) is per-turn — emitEvent is a
    // no-op when called outside an agent turn (defensive). The runner has
    // already installed the sink before invoking the tool, so the event
    // flows through the same stream as agent:message_delta / agent:tool_call_end.
    let action: CanvasUIAction;
    if (command === 'focus_shape') {
      // shapeId is guaranteed by the validation above.
      action = { command: 'focus_shape', shapeId: shapeId as string };
    } else if (command === 'zoom_to_selection') {
      action = { command: 'zoom_to_selection', ...(shapeId ? { shapeId } : {}) };
    } else {
      // show_chat / show_history / show_layers — no extra fields.
      action = { command } as CanvasUIAction;
    }

    emitEvent({ type: 'agent:canvas_ui_action', action, toolCallId });

    // ---- Success ack the LLM sees ----------------------------------------
    // The ack describes what the dispatcher WILL do on every connected
    // viewer — the side-effect itself is asynchronous (the event flows
    // through the runner → route → socket/SSE → client store → dispatcher).
    // The LLM never blocks on the dispatch landing; it sees the ack and
    // proceeds to write its chat summary.
    const ackText = (() => {
      switch (command) {
        case 'focus_shape':
          return `Focused shape ${shapeId}: selected it on the canvas and switched the right sidebar to the Properties (Design) tab.`;
        case 'show_chat':
          return 'Expanded the chat panel so the user can see your streaming reply.';
        case 'show_history':
          return 'Opened the Version History dialog (the snapshots timeline).';
        case 'show_layers':
          return 'Switched the right sidebar to the Layers tab.';
        case 'zoom_to_selection':
          return shapeId
            ? `Zoomed the canvas to fit shape ${shapeId}.`
            : 'Zoomed the canvas to fit the current selection.';
        default:
          return `Dispatched UI command: ${command}.`;
      }
    })();

    return {
      content: [{ type: 'text', text: ackText }],
      details: { command, shapeId, dispatched: true },
    };
  },
});
