// Shared canvas types — now aligned to the .pen (pen.dev) format.
//
// BREAKING CHANGE (Phase C): the source of truth is a .pen object tree
// (`children: PenChild[]` + `variables` + `themes`). The flat `shapes[]`
// and `tokens` fields are DERIVED render caches, recomputed on every
// mutation by `resolvePenTree()`. This mirrors pen.dev's own architecture:
// the tree is the model; rendering computes layout.
//
// The heatmap overlay has been REMOVED for full .pen format purity (pen.dev
// has no analysis-overlay concept). Predictive-heatmap tooling is dropped.
//
// `Shape` is retained as the resolved render-node type the SVG renderer and
// the layers/properties panels consume. It carries absolute positions,
// resolved variable values, expanded ref subtrees, and a depth-first zIndex.

import type { PenChild, PenDocument, PenVariableDef, PenTheme } from '../pen/types';
import { PEN_FORMAT_VERSION } from '../pen/types';

// ---- Resolved render node (what the renderer sees) -----------------------

export type ShapeType =
  | 'rectangle'
  | 'ellipse'
  | 'text'
  | 'line'
  | 'frame'
  | 'group'
  | 'path'
  | 'image';

/// Auto-layout configuration for container shapes (frames/groups).
/// Maps to .pen's flexbox `Layout` (layout/gap/padding/justifyContent/alignItems).
export interface AutoLayout {
  direction: 'horizontal' | 'vertical';
  gap: number;
  padding: number;
  alignX: 'min' | 'center' | 'max';
  alignY: 'min' | 'center' | 'max';
}

/// Per-corner border radii. When set, overrides the uniform `radius` field.
/// Maps to .pen's 4-tuple `cornerRadius`.
export interface CornerRadii {
  topLeft: number;
  topRight: number;
  bottomRight: number;
  bottomLeft: number;
}

/// Linear or radial gradient fill. Resolved from .pen's gradient Fill.
export interface GradientFill {
  type: 'linear' | 'radial';
  angle: number;
  stops: Array<{ offset: number; color: string }>;
}

/// Drop shadow effect. Resolved from .pen's shadow Effect.
export interface ShadowEffect {
  x: number;
  y: number;
  blur: number;
  color: string;
  spread?: number;
  inset?: boolean;
}

/// A resolved render node — the flattened, absolutely-positioned view of a
/// .pen tree node, ready for SVG rendering. Produced by `resolvePenTree()`.
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
  autoLayout?: AutoLayout | null;
  tokenBinding?: { fillToken?: string; textToken?: string; strokeToken?: string } | null;
  componentId?: string | null;
  points?: { x: number; y: number }[] | null;
  closed?: boolean;
  src?: string | null;
  radii?: CornerRadii | null;
  gradient?: GradientFill | null;
  shadow?: ShadowEffect | null;
  blur?: number;
  maskId?: string | null;
  /// .pen theme effective on this node (inherited from ancestors + own).
  /// Enables the properties panel to show/edit the node's theme.
  theme?: PenTheme;
}

export interface Viewport {
  zoom: number;
  panX: number;
  panY: number;
}

// ---- Derived token view (for the tokens panel) ---------------------------
//
// .pen stores variables as `{ [key]: { type, value } }`. The tokens panel
// and some legacy tools consume a flat array of `{ name, key, value }`.
// This derived view is recomputed on every mutation.

export interface ColorToken {
  name: string;
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

// ---- The document: a .pen tree + runtime fields + derived caches ---------

export interface CanvasDocument extends Omit<PenDocument, 'children'> {
  /// Runtime: session document id.
  id: string;
  /// Runtime: display name (also used as the .pen filename).
  name: string;
  /// The .pen object tree — SOURCE OF TRUTH.
  children: PenChild[];
  /// Runtime: pan/zoom (not a .pen concept).
  viewport: Viewport;
  /// Derived: canvas background color (from `variables['canvas.background']`
  /// or '#f8fafc' default). Recomputed on mutation.
  background: string;

  // ---- Derived render caches (recomputed by resolvePenTree + tokensFromVariables) ----
  /// Resolved flat render list (absolute positions, expanded refs, resolved
  /// variables/themes). Recomputed on every mutation.
  shapes: Shape[];
  /// Derived tokens view (from `variables`). Recomputed on every mutation.
  tokens: DesignTokens;
}

/// Factory: create a fresh empty CanvasDocument (a valid .pen tree).
export function createEmptyCanvasDocument(id: string, name = 'Untitled'): CanvasDocument {
  return {
    id,
    name,
    version: PEN_FORMAT_VERSION,
    themes: undefined,
    variables: undefined,
    children: [],
    viewport: { zoom: 1, panX: 120, panY: 80 },
    background: '#f8fafc',
    shapes: [],
    tokens: { colors: [], textStyles: [] },
  };
}

// ---- Patches -------------------------------------------------------------
//
// Patch ops are kept stable (add/update/remove/group/ungroup/etc.) so the
// existing 54 tools keep working during the rename. The applier now operates
// against the .pen TREE: `add` inserts a node under `shape.parentId` (or
// root); `update` merges properties onto a tree node; `remove` prunes a
// subtree; `group` wraps nodes in a frame; `tokens` updates `variables`;
// `zorder` reorders within siblings; etc.
//
// After applying, the applier recomputes `shapes` (via resolvePenTree) and
// `tokens` (via variables).

export interface CanvasPatch {
  op:
    | 'add'
    | 'update'
    | 'remove'
    | 'clear'
    | 'background'
    | 'select'
    | 'bulk_add'
    | 'update_many'
    | 'duplicate'
    | 'group'
    | 'ungroup'
    | 'align'
    | 'tokens'
    | 'zorder'
    | 'reorder'
    | 'viewport'
    | 'undo'
    | 'redo'
    // New .pen-aligned ops:
    | 'set_theme_axis'        // define a theme axis (e.g. mode: [light, dark])
    | 'set_node_theme'        // set a node's theme (e.g. { mode: dark })
    | 'set_variable'          // set a single $variable (alias for tokens w/ one color)
    | 'mark_slot';            // mark a frame as a slot for recommended components
  shapeId?: string;
  /// Full or partial .pen node payload for 'add' / 'update' (also accepts
  /// legacy Shape fields like `radius`, `text`, `autoLayout` — the applier
  /// normalizes them to .pen field names).
  shape?: Partial<Shape> & Record<string, unknown>;
  shapeIds?: string[];
  shapes?: Array<Partial<Shape> & { id: string }>;
  updates?: Array<{ id: string; changes: Partial<Shape> }>;
  background?: string;
  viewport?: Viewport;
  tokens?: Partial<DesignTokens>;
  groupId?: string;
  alignKind?: 'left' | 'center_h' | 'right' | 'top' | 'center_v' | 'bottom' | 'distribute_h' | 'distribute_v';
  zorderKind?: 'front' | 'back' | 'forward' | 'backward';
  zIndex?: number;
  // New .pen-aligned fields:
  themeAxis?: string;                    // for set_theme_axis
  themeValues?: string[];                // for set_theme_axis
  theme?: PenTheme;                      // for set_node_theme
  variableKey?: string;                  // for set_variable
  variableType?: 'color' | 'number' | 'string' | 'boolean';
  variableValue?: string | number | boolean | Array<{ value: string | number | boolean; theme?: PenTheme }>;
  slotComponents?: string[];             // for mark_slot
  summary: string;
}

// ---- Sync events (unchanged shape; heatmap events removed) ---------------

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
  | { type: 'agent:skill_selected'; category: string; confidence: number; method: string; toolCount: number }
  | { type: 'agent:plan'; steps: Array<{ step: number; description: string; skill: string; status: string }> }
  | { type: 'agent:plan_step_update'; step: number; status: string }
  | { type: 'agent:subagent_dispatch'; subAgentType: string; task: string }
  | { type: 'agent:subagent_result'; subAgentType: string; success: boolean; summary: string; toolCalls: number }
  | { type: 'presence'; viewerCount: number };

export type ClientEvent =
  | { type: 'subscribe'; documentId: string }
  | { type: 'canvas:patch'; patch: CanvasPatch }
  | { type: 'canvas:request_full'; documentId: string }
  | { type: 'agent:prompt'; documentId: string; prompt: string };
