// .pen file format — TypeScript schema.
//
// Transcribed from the authoritative specification at:
//   https://docs.pen.dev/for-developers/the-pen-format
//
// This is the canonical, source-of-truth type surface for the .pen format
// inside AgentCanvas. All .pen import/export, agent tooling, and any future
// tree-model migration MUST reference these types so the app stays aligned
// to pen.dev's terminology and ontology.
//
// The schema is a "live" spec (pen.dev may introduce breaking changes).
// The `version` constant below tracks the pen.dev format version we target.
//
// Naming convention note: we preserve pen.dev's camelCase property names
// (layout, justifyContent, cornerRadius, textGrowth, …) verbatim so that
// objects serialize to/from real .pen files with zero translation.

export const PEN_FORMAT_VERSION = '2.17' as const;

// ---- Theme ----------------------------------------------------------------

/** Theme axis -> axis value. E.g. { mode: 'dark', spacing: 'condensed' }. */
export interface PenTheme {
  [key: string]: string;
}

// ---- Variables ------------------------------------------------------------

/** Dollar-prefixed variable name; binds a property to that variable. */
export type PenVariable = string;

export type PenNumberOrVariable = number | PenVariable;
/** Hex color: #RGB, #RRGGBB, or #RRGGBBAA. */
export type PenColor = string;
export type PenColorOrVariable = PenColor | PenVariable;
export type PenBooleanOrVariable = boolean | PenVariable;
export type PenStringOrVariable = string | PenVariable;

/** A theme-conditional value: a concrete value active when `theme` is satisfied. */
export interface PenThemedValue<T> {
  value: T;
  theme?: PenTheme;
}

/** Definition of a document variable. Type-tagged union. */
export type PenVariableDef =
  | { type: 'boolean'; value: PenBooleanOrVariable | PenThemedValue<PenBooleanOrVariable>[] }
  | { type: 'color'; value: PenColorOrVariable | PenThemedValue<PenColorOrVariable>[] }
  | { type: 'number'; value: PenNumberOrVariable | PenThemedValue<PenNumberOrVariable>[] }
  | { type: 'string'; value: PenStringOrVariable | PenThemedValue<PenStringOrVariable>[] };

// ---- Layout (flexbox) -----------------------------------------------------

export interface PenLayout {
  /** Flex direction. 'none' = absolutely positioned children. */
  layout?: 'none' | 'vertical' | 'horizontal';
  /** Main-axis gap between children. Default 0. */
  gap?: PenNumberOrVariable;
  layoutIncludeStroke?: boolean;
  /** Inside padding: all sides | [vertical, horizontal] | [top, right, bottom, left]. */
  padding?:
    | PenNumberOrVariable
    | [PenNumberOrVariable, PenNumberOrVariable]
    | [PenNumberOrVariable, PenNumberOrVariable, PenNumberOrVariable, PenNumberOrVariable];
  /** Main-axis alignment. Default 'start'. */
  justifyContent?: 'start' | 'center' | 'end' | 'space_between' | 'space_around';
  /** Cross-axis alignment. Default 'start'. */
  alignItems?: 'start' | 'center' | 'end';
}

/**
 * Dynamic layout size.
 *   fit_content      — combined size of children (requires layout on node).
 *   fill_container   — parent size (requires layout on parent).
 * Optional fallback in parens, e.g. 'fit_content(100)'.
 */
export type PenSizingBehavior = string;

// ---- Geometry -------------------------------------------------------------

export interface PenPosition {
  x?: number;
  y?: number;
}

export interface PenSize {
  width?: PenNumberOrVariable | PenSizingBehavior;
  height?: PenNumberOrVariable | PenSizingBehavior;
}

// ---- Graphics -------------------------------------------------------------

export type PenBlendMode =
  | 'normal' | 'darken' | 'multiply' | 'linearBurn' | 'colorBurn'
  | 'light' | 'screen' | 'linearDodge' | 'colorDodge' | 'overlay'
  | 'softLight' | 'hardLight' | 'difference' | 'exclusion'
  | 'hue' | 'saturation' | 'color' | 'luminosity';

export type PenFill =
  | PenColorOrVariable
  | {
      type: 'color';
      enabled?: PenBooleanOrVariable;
      blendMode?: PenBlendMode;
      /** Fill opacity is set only via the hex alpha channel. */
      color: PenColorOrVariable;
    }
  | {
      type: 'gradient';
      enabled?: PenBooleanOrVariable;
      blendMode?: PenBlendMode;
      gradientType?: 'linear' | 'radial' | 'angular';
      opacity?: PenNumberOrVariable;
      /** Normalized to bbox. Default 0.5,0.5. */
      center?: PenPosition;
      /** Normalized to bbox. Default 1,1. */
      size?: { width?: PenNumberOrVariable; height?: PenNumberOrVariable };
      /** Degrees CCW (0° up, 90° left, 180° down). */
      rotation?: PenNumberOrVariable;
      colors?: Array<{ color: PenColorOrVariable; position: PenNumberOrVariable }>;
    }
  | {
      type: 'image';
      enabled?: PenBooleanOrVariable;
      blendMode?: PenBlendMode;
      opacity?: PenNumberOrVariable;
      /** URL relative to the .pen file, e.g. './image.jpg'. */
      url?: string;
      mode?: 'stretch' | 'fill' | 'fit';
    }
  | {
      type: 'shader';
      enabled?: PenBooleanOrVariable;
      blendMode?: PenBlendMode;
      opacity?: PenNumberOrVariable;
      /** WebGL 1.0 fragment shader file URI, relative to the .pen file. */
      url: string;
      /** Uniform overrides keyed by name. */
      uniforms?: { [key: string]: number | boolean | string | number[] };
    }
  | {
      type: 'mesh_gradient';
      enabled?: PenBooleanOrVariable;
      blendMode?: PenBlendMode;
      opacity?: PenNumberOrVariable;
      columns?: number;
      rows?: number;
      colors?: PenColorOrVariable[];
      points?: Array<
        | [number, number]
        | {
            position: [number, number];
            leftHandle?: [number, number];
            rightHandle?: [number, number];
            topHandle?: [number, number];
            bottomHandle?: [number, number];
          }
      >;
    };

export type PenFills = PenFill | PenFill[];

export interface PenCanHaveStroke {
  stroke?: PenFills;
  /** Stroke thickness: uniform or per side. */
  strokeWidth?:
    | PenNumberOrVariable
    | { top?: PenNumberOrVariable; right?: PenNumberOrVariable; bottom?: PenNumberOrVariable; left?: PenNumberOrVariable };
  strokeLinecap?: 'butt' | 'round' | 'square';
  strokeLinejoin?: 'miter' | 'bevel' | 'round';
  strokeAlignment?: 'inner' | 'center' | 'outer';
}

export type PenEffect =
  | { enabled?: PenBooleanOrVariable; type: 'blur'; radius?: PenNumberOrVariable }
  | { enabled?: PenBooleanOrVariable; type: 'background_blur'; radius?: PenNumberOrVariable }
  | {
      type: 'shadow';
      enabled?: PenBooleanOrVariable;
      shadowType?: 'inner' | 'outer';
      offset?: { x: PenNumberOrVariable; y: PenNumberOrVariable };
      spread?: PenNumberOrVariable;
      blur?: PenNumberOrVariable;
      color?: PenColorOrVariable;
      blendMode?: PenBlendMode;
    };

export type PenEffects = PenEffect | PenEffect[];

export interface PenCanHaveEffects {
  effect?: PenEffects;
}

export interface PenCanHaveGraphics extends PenCanHaveEffects, PenCanHaveStroke {
  fill?: PenFills;
}

// ---- Entity (base) --------------------------------------------------------

export interface PenEntity extends PenPosition {
  /** Unique string; MUST NOT contain '/'. Auto-generated if omitted. */
  id: string;
  name?: string;
  context?: string;
  /** When true, can be duplicated via `ref` objects. Default false. */
  reusable?: boolean;
  theme?: PenTheme;
  enabled?: PenBooleanOrVariable;
  opacity?: PenNumberOrVariable;
  flipX?: PenBooleanOrVariable;
  flipY?: PenBooleanOrVariable;
  /** 'absolute' detaches the object from parent's layout. Default 'auto'. */
  layoutPosition?: 'auto' | 'absolute';
  metadata?: { type: string; [key: string]: unknown };
  /** Degrees CCW around top-left corner. */
  rotation?: PenNumberOrVariable;
}

export interface PenRectangleish extends PenEntity, PenSize, PenCanHaveGraphics {
  cornerRadius?:
    | PenNumberOrVariable
    | [PenNumberOrVariable, PenNumberOrVariable, PenNumberOrVariable, PenNumberOrVariable];
}

// ---- Concrete node types --------------------------------------------------

/** Position is the top-left corner. */
export interface PenRectangle extends PenRectangleish {
  type: 'rectangle';
}

/** Defined by its bounding rectangle. */
export interface PenEllipse extends PenEntity, PenSize, PenCanHaveGraphics {
  type: 'ellipse';
  /** Ring inner/outer radius ratio. 0=solid, 1=hollow. Default 0. */
  innerRadius?: PenNumberOrVariable;
  /** Arc start angle, degrees CCW from right. Default 0. */
  startAngle?: PenNumberOrVariable;
  /** Arc length from startAngle. Positive=CCW, negative=CW. Range -360..360. Default 360. */
  sweepAngle?: PenNumberOrVariable;
}

export interface PenPolygon extends PenEntity, PenSize, PenCanHaveGraphics {
  type: 'polygon';
  polygonCount?: PenNumberOrVariable;
  cornerRadius?: PenNumberOrVariable;
}

export interface PenPath extends PenEntity, PenSize, PenCanHaveGraphics {
  type: 'path';
  /** Default 'nonzero'. */
  fillRule?: 'nonzero' | 'evenodd';
  /** SVG path data. */
  geometry?: string;
  /** SVG coord-space [x,y,w,h] mapping onto the node box. Default: tight bbox of geometry. */
  viewBox?: [number, number, number, number];
}

export interface PenTextStyle {
  fontFamily?: PenStringOrVariable;
  fontSize?: PenNumberOrVariable;
  fontWeight?: PenStringOrVariable;
  letterSpacing?: PenNumberOrVariable;
  fontStyle?: PenStringOrVariable;
  underline?: PenBooleanOrVariable;
  /** Multiplier of fontSize. Defaults to font's built-in. */
  lineHeight?: PenNumberOrVariable;
  textAlign?: 'left' | 'center' | 'right' | 'justify';
  textAlignVertical?: 'top' | 'middle' | 'bottom';
  strikethrough?: PenBooleanOrVariable;
  href?: string;
}

export type PenTextContent = PenStringOrVariable;

export interface PenText extends PenEntity, PenSize, PenCanHaveGraphics, PenTextStyle {
  type: 'text';
  content?: PenTextContent;
  /**
   * Required before width/height take effect.
   *   'auto'              — grows to fit; no wrapping.
   *   'fixed-width'       — width fixed, wraps; height grows.
   *   'fixed-width-height'— both fixed; may overflow.
   */
  textGrowth?: 'auto' | 'fixed-width' | 'fixed-width-height';
}

export interface PenCanHaveChildren {
  children?: PenChild[];
}

/**
 * Container to create hierarchy and layout.
 * Defaults: layout=horizontal, width=fit_content, height=fit_content, clip=false.
 */
export interface PenFrame extends PenRectangleish, PenCanHaveChildren, PenLayout {
  type: 'frame';
  /** Clip overflow. Default false. */
  clip?: PenBooleanOrVariable;
  placeholder?: boolean;
  /** Marks frame as a slot for component instances. Entries = recommended reusable child IDs. */
  slot?: false | string[];
}

export interface PenGroup extends PenEntity, PenCanHaveChildren, PenCanHaveEffects {
  type: 'group';
}

export interface PenNote extends PenEntity, PenSize, PenTextStyle {
  type: 'note';
  content?: PenTextContent;
}

export interface PenPrompt extends PenEntity, PenSize, PenTextStyle {
  type: 'prompt';
  content?: PenTextContent;
  model?: PenStringOrVariable;
}

export interface PenContext extends PenEntity, PenSize, PenTextStyle {
  type: 'context';
  content?: PenTextContent;
}

/** Icon from a library. Scaled to fit width and height. */
export interface PenIcon extends PenEntity, PenSize, PenCanHaveEffects {
  type: 'icon';
  /** 'lucide' | 'feather' | 'Material Symbols Outlined' | 'Material Symbols Rounded' | 'Material Symbols Sharp' | 'phosphor'. */
  library?: PenStringOrVariable;
  icon?: PenStringOrVariable;
  /** Variable weight, 100-700; only for libraries that support it. */
  weight?: PenNumberOrVariable;
  fill?: PenFills;
}

/** Generates nested children from JavaScript. */
export interface PenScript extends PenEntity, PenSize {
  type: 'script';
  /** Clip overflow. Default false. */
  clip?: PenBooleanOrVariable;
  /** JS file URI, relative to the .pen file. */
  scriptUri?: string;
  /** Input values by name. */
  inputs?: { [key: string]: string | number | boolean | PenVariable };
}

// ---- v2.0 additions — Figma-aligned ontology -----------------------------
//
// These types extend pen.dev's 2.x format with the missing Figma
// concepts: BooleanOps, Constraints, LayoutGrids, Masks,
// ComponentProperties, ComponentSets, Variants, StrokeDashes,
// CornerSmoothing, GridLayout, Overflow, and more.
//
// See docs/pen-spec-v2.md for the full spec and docs/figma-ontology.md
// for the Figma ↔ .pen mapping.

/** Boolean operation: combines children's geometry using set ops. */
export interface PenBooleanOp
  extends PenEntity, PenCanHaveChildren, PenCanHaveGraphics, PenCanHaveEffects {
  type: 'boolean_op';
  /** Set operation. Non-destructive — children remain in the tree. */
  operation: 'union' | 'intersect' | 'subtract' | 'exclude';
}

/** Layout constraint relative to containing Frame (non-Auto-Layout only). */
export interface PenLayoutConstraint {
  horizontal: 'left' | 'right' | 'center' | 'left_right' | 'scale';
  vertical: 'top' | 'bottom' | 'center' | 'top_bottom' | 'scale';
}

/** Auto-layout child override: alignment + grow + min/max size. */
export interface PenAutoLayoutChild {
  /** Cross-axis alignment override (only for children of auto-layout frames). */
  layoutAlign?: 'inherit' | 'stretch' | 'min' | 'center' | 'max';
  /** 0 = fixed, 1 = stretch along main axis. */
  layoutGrow?: 0 | 1;
  minWidth?: PenNumberOrVariable;
  maxWidth?: PenNumberOrVariable;
  minHeight?: PenNumberOrVariable;
  maxHeight?: PenNumberOrVariable;
}

/** CSS-grid-like Auto Layout config (when `layout: 'grid'`). */
export interface PenGridLayout {
  gridRowCount?: number;
  gridColumnCount?: number;
  gridRowGap?: PenNumberOrVariable;
  gridColumnGap?: PenNumberOrVariable;
  /** CSS `grid-template-columns` string. */
  gridColumnsSizing?: string;
  /** CSS `grid-template-rows` string. */
  gridRowsSizing?: string;
}

/** Per-child grid placement (stored on the child's metadata). */
export interface PenGridChildPlacement {
  gridChildHorizontalAlign?: 'auto' | 'min' | 'center' | 'max';
  gridChildVerticalAlign?: 'auto' | 'min' | 'center' | 'max';
  gridRowSpan?: number;
  gridColumnSpan?: number;
}

/** Layout guide overlaid on a frame (not Auto Layout — visual only). */
export interface PenLayoutGrid {
  pattern: 'columns' | 'rows' | 'grid';
  sectionSize: PenNumberOrVariable;
  visible?: PenBooleanOrVariable;
  color?: PenColorOrVariable;
  alignment?: 'min' | 'max' | 'stretch' | 'center';
  gutterSize?: PenNumberOrVariable;
  offset?: PenNumberOrVariable;
  count?: PenNumberOrVariable;
}

/** Mask configuration for a node. */
export interface PenMask {
  isMask: boolean;
  /** ALPHA = use alpha channel. VECTOR = use fill regions. LUMINANCE = use luminance. */
  maskType?: 'alpha' | 'vector' | 'luminance';
}

/** Component Property type (BOOLEAN/TEXT/INSTANCE_SWAP/VARIANT). */
export type PenComponentPropertyType =
  | 'boolean'
  | 'string'
  | 'variant'
  | 'instance_swap';

/** Definition of a Component Property on a Component. */
export interface PenComponentPropertyDefinition {
  type: PenComponentPropertyType;
  /** Initial value for instances. boolean | string. */
  defaultValue: boolean | string;
  /** Only for type: 'variant'. */
  variantOptions?: string[];
  /** Only for type: 'instance_swap'. */
  preferredValues?: Array<{
    type: 'COMPONENT' | 'COMPONENT_SET';
    key: string;
  }>;
}

/** A bound variable alias (Figma-style { type, id }). */
export interface PenVariableAlias {
  type: 'VARIABLE_ALIAS';
  id: string;
}

/** Per-node export setting. */
export interface PenExportSetting {
  format: 'png' | 'jpg' | 'svg' | 'pdf';
  suffix?: string;
  scale?: number;
  /** Constraint: 'contain' keeps aspect ratio. */
  constraint?: { type: 'scale' | 'width' | 'height'; value: number };
}

/** Author annotation attached to a node. */
export interface PenAnnotation {
  label?: string;
  text?: string;
  property?: string;
}

/** Dev handoff status. */
export interface PenDevStatus {
  type: 'NONE' | 'READY_FOR_DEV' | 'COMPLETED';
  description?: string;
}

// ---- Prototyping (v2.1) — Figma-aligned ----------------------------------
//
// These types model Figma's prototyping model: triggers, actions,
// transitions, and easing. They're stored on a node's metadata
// (metadata.interactions) rather than as top-level fields, since
// prototyping is an optional concern that most design files don't use.
//
// See docs/figma-ontology.md §16 (Easing) and the Trigger/Action
// sections of the Figma REST API spec.

/** Easing curve for a prototyping transition. */
export type PenEasingType =
  | 'ease_in' | 'ease_out' | 'ease_in_out' | 'linear'
  | 'ease_in_back' | 'ease_out_back' | 'ease_in_out_back'
  | 'gentle' | 'quick' | 'bouncy' | 'slow'
  | 'custom_cubic_bezier' | 'custom_spring';

/** A custom cubic-bezier easing curve (when easingType === 'custom_cubic_bezier'). */
export interface PenCubicBezier {
  x1: number; y1: number; x2: number; y2: number;
}

/** A custom spring easing (when easingType === 'custom_spring'). */
export interface PenSpringConfig {
  stiffness?: number;
  damping?: number;
  mass?: number;
}

/** Prototype trigger — what initiates an interaction. */
export type PenTrigger =
  | { type: 'on_click' }
  | { type: 'on_hover' }
  | { type: 'on_press' }
  | { type: 'on_drag' }
  | { type: 'after_timeout'; timeout: number }
  | { type: 'mouse_enter'; delay?: number }
  | { type: 'mouse_leave'; delay?: number }
  | { type: 'mouse_up'; delay?: number }
  | { type: 'mouse_down'; delay?: number }
  | { type: 'on_key_down'; device: 'keyboard' | 'xbox_one' | 'ps4' | 'switch_pro' | 'unknown_controller'; keyCodes: number[] }
  | { type: 'on_media_hit'; mediaHitTime: number }
  | { type: 'on_media_end' };

/** A prototype action — what happens when a trigger fires. */
export type PenAction =
  | { type: 'back' }
  | { type: 'close' }
  | { type: 'url'; url: string }
  | { type: 'navigate'; destinationId: string; transition?: PenTransition }
  | { type: 'overlay'; destinationId: string; transition?: PenTransition }
  | { type: 'swap'; destinationId: string; transition?: PenTransition }
  | { type: 'update_media_runtime'; destinationId: string | null; mediaAction: 'play' | 'pause' | 'toggle_play_pause' | 'mute' | 'unmute' | 'toggle_mute_unmute' }
  | { type: 'set_variable'; variableId: string; value: unknown }
  | { type: 'set_variable_mode'; variableCollectionId: string; modeId: string }
  | { type: 'conditional'; condition: string; trueAction: PenAction; falseAction?: PenAction };

/** A prototyping transition between two frames. */
export interface PenTransition {
  type: 'fade' | 'move_in' | 'move_out' | 'push' | 'slide_in' | 'slide_out' | 'reveal' | 'smart_animate' | 'dissolve' | 'none';
  direction?: 'left' | 'right' | 'up' | 'down';
  durationMs: number;
  easing?: PenEasingType;
  cubicBezier?: PenCubicBezier;
  springConfig?: PenSpringConfig;
}

/** A complete interaction: trigger + one or more actions. */
export interface PenInteraction {
  trigger: PenTrigger;
  actions: PenAction[];
}

/** A comment thread anchored to a node or canvas point. */
export interface PenComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  resolved?: boolean;
  /** Anchor: a node ID, or an {x, y} canvas point. */
  anchor?: { nodeId?: string; x?: number; y?: number };
  reactions?: Array<{ emoji: string; user: string }>;
  replies?: PenComment[];
}

/**
 * Per-node metadata bag. Encodes Figma traits that don't fit cleanly
 * into the discriminated-union model (ComponentSet, Section, Slice,
 * Mask, ComponentProperties, Constraints, LayoutGrids, …).
 */
export interface PenNodeMetadata {
  // Node-kind flags
  isComponentSet?: boolean;
  isSection?: boolean;
  isSlice?: boolean;
  isEmbed?: boolean;
  sectionContentsHidden?: boolean;
  embedUrl?: string;

  // Component / variant properties
  componentProperties?: { [name: string]: PenComponentPropertyDefinition };
  variantProperties?: { [axis: string]: string };

  // Mask
  isMask?: boolean;
  maskType?: 'alpha' | 'vector' | 'luminance';

  // Constraints & auto-layout child overrides
  constraints?: PenLayoutConstraint;
  autoLayoutChild?: PenAutoLayoutChild;
  gridPlacement?: PenGridChildPlacement;

  // Grid Auto Layout config (when parent.layout === 'grid')
  gridLayout?: PenGridLayout;

  // Layout guides (visual only)
  layoutGrids?: PenLayoutGrid[];

  // Overflow (frames only)
  overflow?: 'hidden' | 'scroll-x' | 'scroll-y' | 'scroll-both';

  // Export settings
  exportSettings?: PenExportSetting[];

  // Per-character text overrides (imported, not editable in UI)
  characterStyleOverrides?: number[];
  styleOverrideTable?: { [id: string]: unknown };

  // Annotations & dev status
  annotations?: PenAnnotation[];
  devStatus?: PenDevStatus;

  // Prototyping (v2.1) — interactions on this node.
  interactions?: PenInteraction[];
  /** Outgoing transition when this node is navigated away from. */
  transitionNodeID?: string;
  transitionDuration?: number;
  transitionEasing?: PenEasingType;

  // Variable bindings (Figma-style explicit aliases, optional)
  boundVariables?: { [field: string]: PenVariableAlias };

  // Plugin / scratch data
  pluginData?: { [pluginId: string]: unknown };
  sharedPluginData?: { [namespace: string]: unknown };

  // Free-form extensions
  [key: string]: unknown;
}

/** Reuses another object (a component instance). */
export interface PenRef extends PenEntity {
  type: 'ref';
  /** ID of the referenced (reusable) object. */
  ref: string;
  /**
   * Customize descendant properties.
   * - No `type` key  => property overrides applied to that descendant.
   * - `type` present => descendant is fully replaced with a new node tree.
   * Key = slash-separated ID path (e.g. "ok-button/label").
   */
  descendants?: { [idPath: string]: Partial<PenChild> };
  [key: string]: unknown;
}

export type PenChild =
  | PenFrame
  | PenGroup
  | PenRectangle
  | PenEllipse
  | PenPath
  | PenPolygon
  | PenText
  | PenNote
  | PenPrompt
  | PenContext
  | PenIcon
  | PenScript
  | PenRef;

// ---- Document -------------------------------------------------------------

export type PenIdPath = string;

export interface PenDocument {
  version: typeof PEN_FORMAT_VERSION;
  themes?: { [axis: string]: string[] };
  /** Imported .pen / .lib.pen files: { alias: relativeURI }. */
  imports?: { [alias: string]: string };
  variables?: { [key: string]: PenVariableDef };
  /** Comment threads anchored to nodes or canvas points (v2.1). */
  comments?: PenComment[];
  children: PenChild[];
}

// ---- Helpers --------------------------------------------------------------

/** All valid `type` values for a .pen node. */
export const PEN_NODE_TYPES = [
  'frame',
  'group',
  'rectangle',
  'ellipse',
  'polygon',
  'path',
  'text',
  'note',
  'context',
  'prompt',
  'icon',
  'script',
  'ref',
] as const;

export type PenNodeType = (typeof PEN_NODE_TYPES)[number];

/** Type guard: is this object a .pen node? */
export function isPenNode(value: unknown): value is PenChild {
  if (typeof value !== 'object' || value === null) return false;
  const t = (value as { type?: string }).type;
  return typeof t === 'string' && (PEN_NODE_TYPES as readonly string[]).includes(t);
}

/** Validate the top-level shape of a parsed .pen document (best-effort). */
export function isPenDocument(value: unknown): value is PenDocument {
  if (typeof value !== 'object' || value === null) return false;
  const doc = value as Partial<PenDocument>;
  return (
    typeof doc.version === 'string' &&
    Array.isArray(doc.children) &&
    doc.children.every(isPenNode)
  );
}
