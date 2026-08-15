// Shared canvas types — used by the frontend, the WebSocket service,
// the Pi Agent SDK tool definitions, and the persistence layer.

export type ShapeType =
  | 'rectangle'
  | 'ellipse'
  | 'text'
  | 'line'
  | 'frame'
  | 'group';

export interface Shape {
  id: string;
  type: ShapeType;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
  radius: number;
  text?: string;
  fontSize: number;
  textColor: string;
  parentId?: string | null;
  zIndex: number;
  locked: boolean;
  visible: boolean;
}

export interface Viewport {
  zoom: number;
  panX: number;
  panY: number;
}

export interface CanvasDocument {
  id: string;
  name: string;
  background: string;
  viewport: Viewport;
  shapes: Shape[];
}

/// A canonical patch emitted by every canvas tool. The agent emits one of
/// these per tool call; the frontend applies it to local state and the
/// WebSocket service broadcasts it to every other viewer. Mirrors the
/// `details.patch` pattern documented by the Pi Agent SDK.
export interface CanvasPatch {
  /// 'add' = create a new shape; 'update' = mutate existing; 'remove' = delete;
  /// 'clear' = wipe all; 'background' = change document bg; 'viewport' = pan/zoom.
  op: 'add' | 'update' | 'remove' | 'clear' | 'background' | 'select';
  shapeId?: string;
  /// Full or partial shape payload for 'add' / 'update'.
  shape?: Partial<Shape>;
  /// For 'clear' / 'select' ops.
  shapeIds?: string[];
  /// For 'background' op.
  background?: string;
  /// For 'viewport' op.
  viewport?: Viewport;
  /// Human-readable summary the UI can show next to the tool call.
  summary: string;
}

/// Events the WebSocket server can push to connected clients.
/// These intentionally mirror the shape of Pi's `AgentSessionEvent`
/// union so the same UI reducer can handle both a real Pi session
/// and our z-ai-web-dev-sdk backed driver.
export type SyncEvent =
  | { type: 'canvas:patch'; patch: CanvasPatch; toolCallId?: string }
  | { type: 'canvas:full'; document: CanvasDocument }
  | { type: 'agent:message_start'; role: 'assistant' }
  | { type: 'agent:message_delta'; text: string }
  | { type: 'agent:message_end' }
  | { type: 'agent:thinking_delta'; text: string }
  | { type: 'agent:tool_call_start'; toolCallId: string; toolName: string; argsPreview: string }
  | { type: 'agent:tool_call_end'; toolCallId: string; success: boolean; summary: string }
  | { type: 'agent:turn_end' }
  | { type: 'agent:error'; message: string }
  | { type: 'presence'; viewerCount: number };

/// Events the WebSocket client can send to the server.
export type ClientEvent =
  | { type: 'subscribe'; documentId: string }
  | { type: 'canvas:patch'; patch: CanvasPatch }
  | { type: 'canvas:request_full'; documentId: string }
  | { type: 'agent:prompt'; documentId: string; prompt: string };
