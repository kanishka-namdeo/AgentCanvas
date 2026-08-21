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
import type { AgentRunSettings } from '../settings/types';

// ---- Resolved render layer (what the renderer sees) -----------------------
//
// TERMINOLOGY NOTE: this used to be called `Shape`. We renamed it to `Layer`
// to match Figma's canonical vocabulary ("layers" are the nodes in the layer
// tree; "shapes" was an AgentCanvas-isms that obscured the Figma alignment).
//
// `Shape` is kept as a deprecated type alias for `Layer` so existing code
// (Canvas.tsx, PropertiesPanel.tsx, tests) continues to compile. New code
// should use `Layer` directly.

export type LayerType =
  | 'rectangle'
  | 'ellipse'
  | 'text'
  | 'line'
  | 'frame'
  | 'group'
  | 'path'
  | 'image'
  // Figma-canonical node types (added in the ontology alignment):
  | 'section'
  | 'component'
  | 'component_set'
  | 'instance'
  | 'boolean_operation'
  | 'slice'
  | 'star'
  | 'polygon';

/// DEPRECATED alias — use `LayerType` in new code.
export type ShapeType = LayerType;

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

/// Figma-style layout constraints — pin a child's edges to its parent so it
/// resizes correctly when the parent is resized. Mirrors Figma's constraints
/// panel (LEFT / RIGHT / LEFT_RIGHT (scale) / CENTER / SCALE horizontal, plus
/// the equivalent vertical set). Stored on the .pen node as an opaque
/// property; the renderer does not yet enforce these, but the agent and the
/// Properties panel can read and edit them.
export interface Constraints {
  horizontal: 'left' | 'right' | 'center' | 'scale' | 'left_right';
  vertical: 'top' | 'bottom' | 'center' | 'scale' | 'top_bottom';
}

/// A resolved render layer — the flattened, absolutely-positioned view of a
/// .pen tree node, ready for SVG rendering. Produced by `resolvePenTree()`.
///
/// Renamed from `Shape` to `Layer` to match Figma's canonical vocabulary.
/// `Shape` is kept as a deprecated alias.
export interface Layer {
  id: string;
  type: LayerType;
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
  theme?: PenTheme;
  /// Figma-style layout constraints (left/right/center/scale per axis). Stored
  /// on the .pen node; surfaced here so the Properties panel can edit them.
  constraints?: Constraints | null;
  /// Whether this node's children should be clipped to its bounds.
  /// Surfaces the .pen `clip` property for frames/components.
  clip?: boolean;
  // ---- Figma ontology extension fields (Phase 1) ----
  componentPropertyDefinitions?: import('../pen/types').PenComponentPropertyDefinitions | null;
  componentProperties?: import('../pen/types').PenComponentPropertyValues | null;
  variantPropertyAxes?: string[] | null;
  variantPropertyValues?: import('../pen/types').PenVariantPropertyValues | null;
  booleanOperationType?: 'union' | 'subtract' | 'intersect' | 'exclude' | null;
  label?: string | null;
  pointCount?: number | null;
  innerRadiusRatio?: number | null;
  polygonCount?: number | null;
  exportSettings?: Array<{ format: 'png' | 'svg' | 'pdf' | 'jpg'; suffix?: string; scale?: number }> | null;
}

/// DEPRECATED alias — use `Layer` in new code. The resolved render node type.
export type Shape = Layer;

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
//
// Figma alignment: a File contains multiple Pages; each Page has its own
// layer tree + viewport. For backward compat, when `pages` is absent the
// document falls back to a single page using `children` directly.

export interface CanvasDocument extends Omit<PenDocument, 'children'> {
  /// Runtime: session document id.
  id: string;
  /// Runtime: display name (also used as the .pen filename).
  name: string;
  /// The .pen object tree for the ACTIVE page — SOURCE OF TRUTH for the
  /// currently displayed canvas. When `pages` is set, this mirrors
  /// `pages[activePageIndex].children`.
  children: PenChild[];
  /// Runtime: pan/zoom for the active page (not a .pen concept).
  viewport: Viewport;
  /// Derived: canvas background color.
  background: string;

  // ---- Pages (Figma-aligned multi-page support) ----
  pages?: import('../pen/types').PenPage[];
  activePageIndex?: number;

  // ---- Derived render caches ----
  shapes: Shape[];
  tokens: DesignTokens;
}

/// Factory: create a fresh empty CanvasDocument with a single default page.
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

/// Factory: create a fresh empty CanvasDocument with multi-page support.
export function createMultiPageCanvasDocument(id: string, name = 'Untitled'): CanvasDocument {
  const pageId = `${id}-page-1`;
  return {
    id,
    name,
    version: PEN_FORMAT_VERSION,
    themes: undefined,
    variables: undefined,
    children: [],
    pages: [{ id: pageId, name: 'Page 1', children: [] }],
    activePageIndex: 0,
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
    | 'set_theme_axis'
    | 'set_node_theme'
    | 'set_variable'
    | 'mark_slot'
    // Figma-hierarchy ops:
    | 'reparent'
    | 'set_constraints'
    // Figma ontology ops (Phase 1 — Pages, Components, Variants):
    | 'add_page'
    | 'delete_page'
    | 'rename_page'
    | 'set_active_page'
    | 'add_section'
    | 'create_component'
    | 'create_component_set'
    | 'add_variant'
    | 'set_component_property'
    | 'set_instance_property'
    | 'flatten_boolean'
    // Figma component-system ops (Phase 2 — Components & Design Systems):
    | 'convert_to_component'   // Promote an existing frame/group to a reusable Component node.
    | 'place_instance'         // Create a PenRef (proper linked instance) pointing at a component.
    | 'set_instance_override'  // Override a descendant property on a PenRef (text/fill/stroke/visibility).
    | 'reset_instance'         // Clear all overrides on a PenRef, re-sync from main component.
    | 'detach_instance'        // Convert a PenRef into a standalone frame (break the link).
    | 'combine_as_variants'    // Wrap multiple Components into a ComponentSet (variants).
    | 'swap_variant';           // Switch which variant of a ComponentSet the instance points to.
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
  // Figma-hierarchy fields:
  /// New parent for `reparent` op. Use null/empty string for root.
  newParentId?: string | null;
  /// Insertion index inside the new parent's children array. Undefined = append.
  index?: number;
  /// When true (default), preserve the node's ABSOLUTE position across a
  /// reparent by remapping its stored relative x/y to the new parent's frame.
  /// Set to false when you want the stored relative x/y to be reinterpreted
  /// verbatim against the new parent.
  keepAbsolutePosition?: boolean;
  /// Constraints to set on the node (for `set_constraints` op).
  constraints?: Constraints | null;
  // ---- Figma ontology patch fields (Phase 1) ----
  pageId?: string;
  pageName?: string;
  variantPropertyAxes?: string[];
  variantPropertyValues?: Record<string, string>;
  componentProperty?: {
    name: string;
    type: 'boolean' | 'text' | 'instance_swap' | 'variant' | 'slot';
    defaultValue: boolean | string;
    preferredValues?: string[];
    variantOptions?: string[];
  };
  instancePropertyName?: string;
  instancePropertyValue?: boolean | string;
  // ---- Figma component-system patch fields (Phase 2) ----
  /// For `place_instance`: id of the source component (must be reusable=true).
  /// For `swap_variant`: id of the variant (component inside a component_set) to switch to.
  componentId?: string;
  /// For `set_instance_override`: slash-separated descendant id path (e.g. "ok-button/label").
  descendantPath?: string;
  /// For `set_instance_override`: partial node payload to merge onto the descendant.
  /// Can include text, fill, stroke, opacity, visible, etc.
  override?: Partial<Shape> & Record<string, unknown>;
  /// For `combine_as_variants`: ids of the components to combine into a component_set.
  /// For `convert_to_component` / `place_instance` etc. — sometimes used as
  /// the list of shapeIds to wrap.
  componentIds?: string[];
  /// For `combine_as_variants`: axes that vary (e.g. ['size', 'state']).
  /// Auto-derived from the first component's name if omitted.
  axes?: string[];
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
  | { type: 'agent:context_update'; tokenCount: number; contextWindow: number; compacted?: boolean }
  | { type: 'presence'; viewerCount: number };

export type ClientEvent =
  | { type: 'subscribe'; documentId: string }
  | { type: 'canvas:patch'; patch: CanvasPatch }
  | { type: 'canvas:request_full'; documentId: string }
  | { type: 'agent:prompt'; documentId: string; prompt: string; settings?: AgentRunSettings }
  | { type: 'agent:steer'; documentId: string; text: string };
