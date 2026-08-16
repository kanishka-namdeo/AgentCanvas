// Shared canvas types — used by the frontend, the WebSocket service,
// the Pi Agent SDK tool definitions, and the persistence layer.
//
// Extended with: design tokens, attention heatmap, auto-layout, components,
// bulk ops, group/ungroup, duplicate, align — mirroring the feature set
// surfaced by modern AI-driven design tools (Figma UI3, Figma Make,
// Galileo AI, Uizard, UX Pilot — see /research/*.json).

export type ShapeType =
  | 'rectangle'
  | 'ellipse'
  | 'text'
  | 'line'
  | 'frame'
  | 'group'
  // Extended shape types (Phase 5):
  | 'path'   // arbitrary polygon / polyline defined by `points`
  | 'image'; // raster image referenced by `src` (data URL or remote URL)

/// Auto-layout configuration for container shapes (frames / groups).
/// Mirrors Figma's Auto Layout: children of a frame with `autoLayout` set
/// are arranged automatically based on direction, gap, padding, alignment.
export interface AutoLayout {
  /// Layout direction.
  direction: 'horizontal' | 'vertical';
  /// Gap between children, in px.
  gap: number;
  /// Padding inside the frame, in px (uniform).
  padding: number;
  /// Horizontal alignment of children.
  alignX: 'min' | 'center' | 'max';
  /// Vertical alignment of children.
  alignY: 'min' | 'center' | 'max';
}

/// Optional per-shape design-token binding. Instead of hardcoding `fill`,
/// a shape may reference a named token (`bg.primary`, `text.heading`, …)
/// so that changing the token recolors every bound shape.
export interface TokenBinding {
  fillToken?: string;
  textToken?: string;
  strokeToken?: string;
}

/// A 2D point in canvas-space. Used by `path` shapes.
export interface PathPoint {
  x: number;
  y: number;
}

/// Per-corner border radii. When set, overrides the uniform `radius` field.
export interface CornerRadii {
  topLeft: number;
  topRight: number;
  bottomRight: number;
  bottomLeft: number;
}

/// Linear or radial gradient fill. When set on a shape, `fill` is ignored
/// at render time (but kept in sync as the first stop's color for audit).
export interface GradientFill {
  type: 'linear' | 'radial';
  /// 0..360 — angle for linear gradients (ignored for radial).
  angle: number;
  /// Stops sorted by offset ascending. 2..many.
  stops: Array<{ offset: number; color: string }>;
}

/// Drop shadow effect. Rendered via an SVG filter.
export interface ShadowEffect {
  x: number;
  y: number;
  blur: number;
  /// Hex color. Alpha is taken from the color's alpha channel.
  color: string;
  spread?: number;
  /// If true, the shadow renders inside the shape (inset). Default false.
  inset?: boolean;
}

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
  /// Auto-layout (only meaningful for `frame` / `group` shapes).
  autoLayout?: AutoLayout | null;
  /// Token bindings (optional). When set, `fill` / `textColor` / `stroke`
  /// are recomputed from the document's tokens.
  tokenBinding?: TokenBinding | null;
  /// Marks this shape as an instance of a component definition.
  /// `componentId` points at the original component shape (same canvas).
  componentId?: string | null;
  // ---- Extended properties (Phase 5) -------------------------------------
  /// For `path` shapes: the list of points (canvas-space). When `closed`
  /// is true the path is filled; otherwise it's a stroked polyline.
  points?: PathPoint[] | null;
  closed?: boolean;
  /// For `image` shapes: the source URL (data URL or remote URL).
  src?: string | null;
  /// Per-corner radii (overrides `radius` for rectangle/frame shapes).
  radii?: CornerRadii | null;
  /// Gradient fill (overrides `fill` at render time).
  gradient?: GradientFill | null;
  /// Drop shadow effect (rendered via SVG filter).
  shadow?: ShadowEffect | null;
  /// Gaussian blur radius in px (rendered via SVG filter).
  blur?: number;
  /// If set, this shape is clipped by the shape with id `maskId`. The
  /// mask shape's geometry defines the visible region.
  maskId?: string | null;
}

export interface Viewport {
  zoom: number;
  panX: number;
  panY: number;
}

// ---- Design tokens ---------------------------------------------------------
//
// A lightweight design-system layer: named colors and text styles that
// can be referenced by shapes (`tokenBinding`) and edited centrally.
// Inspired by Figma Variables + the AI design-system workflows surfaced
// in /research/ai_design_scenarios.json ("Design Systems And AI: Why MCP
// Servers Are The Unlock", "AI design systems combine traditional design
// system principles with AI-powered workflows").

export interface ColorToken {
  name: string;
  /// Dotted path, e.g. `bg.primary`, `accent`, `text.muted`.
  key: string;
  value: string;
}

export interface TextStyleToken {
  name: string;
  key: string;
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
  color: string;
}

export interface DesignTokens {
  colors: ColorToken[];
  textStyles: TextStyleToken[];
}

// ---- Attention heatmap -----------------------------------------------------
//
// A simulated "where will the user look?" overlay. Each point is a
// predicted fixation. Inspired by Uizard's "predictive heat map of where
// users will focus" (see /research/ai_design_tools.json).
export interface HeatmapPoint {
  x: number;
  y: number;
  /// 0..1 intensity.
  intensity: number;
}

export interface HeatmapOverlay {
  /// Bounding box of the heatmap (canvas-space). Usually matches a frame.
  frameId?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  points: HeatmapPoint[];
  createdAt: number;
}

export interface CanvasDocument {
  id: string;
  name: string;
  background: string;
  viewport: Viewport;
  shapes: Shape[];
  /// Design tokens (color palette + text styles). Edited by the agent
  /// via `canvas_update_tokens`; shapes may bind to them via `tokenBinding`.
  tokens: DesignTokens;
  /// Transient attention heatmap overlay (or null).
  heatmap: HeatmapOverlay | null;
}

/// A canonical patch emitted by every canvas tool. The agent emits one of
/// these per tool call; the frontend applies it to local state and the
/// WebSocket service broadcasts it to every other viewer. Mirrors the
/// `details.patch` pattern documented by the Pi Agent SDK.
export interface CanvasPatch {
  op:
    | 'add'
    | 'update'
    | 'remove'
    | 'clear'
    | 'background'
    | 'select'
    // Extended ops (research-driven scenarios):
    | 'bulk_add'        // wireframe / user-flow / diagram generators
    | 'update_many'     // apply_palette / restyle / batch update
    | 'duplicate'       // duplicate shapes (with new ids)
    | 'group'           // wrap shapes in a group (sets parentId)
    | 'ungroup'         // dissolve a group (clears parentId on children)
    | 'align'           // align/distribute selected shapes
    | 'tokens'          // update design tokens
    | 'heatmap'         // set / clear attention heatmap overlay
    // Phase 1+2+5 ops:
    | 'zorder'          // bring_to_front / send_to_back / forward / backward
    | 'reorder'         // move a shape to a specific zIndex
    | 'viewport'        // set viewport (pan/zoom)
    | 'undo'            // client-side: pop undo stack
    | 'redo';           // client-side: pop redo stack
  shapeId?: string;
  /// Full or partial shape payload for 'add' / 'update'.
  shape?: Partial<Shape>;
  /// For 'clear' / 'select' ops.
  shapeIds?: string[];
  /// For 'bulk_add' — multiple shapes to add in one patch.
  shapes?: Array<Partial<Shape> & { id: string }>;
  /// For 'update_many' — list of { id, changes }.
  updates?: Array<{ id: string; changes: Partial<Shape> }>;
  /// For 'duplicate' — ids to duplicate (returns new ids in summary).
  /// For 'group' — ids to wrap.
  /// For 'align' — ids to align.
  /// For 'background' op.
  background?: string;
  /// For 'viewport' op (reserved; currently unused).
  viewport?: Viewport;
  /// For 'tokens' op — partial tokens update (merges by key).
  tokens?: Partial<DesignTokens>;
  /// For 'heatmap' op — null to clear, otherwise set the overlay.
  heatmap?: HeatmapOverlay | null;
  /// For 'group' / 'ungroup' — the resulting group shape id.
  groupId?: string;
  /// Alignment kind for 'align' op.
  alignKind?: 'left' | 'center_h' | 'right' | 'top' | 'center_v' | 'bottom'
    | 'distribute_h' | 'distribute_v';
  /// For 'zorder' op — which direction to move the shape(s) in the stack.
  zorderKind?: 'front' | 'back' | 'forward' | 'backward';
  /// For 'reorder' op — the target zIndex.
  zIndex?: number;
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
