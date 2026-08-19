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

// ---- Component Properties (Figma-aligned) --------------------------------
//
// Figma's 4 component property types: Boolean, Text, Instance swap, Variant.
// Property names use Figma's kebab-case convention (REST API).
// Variant property names use lowercase-with-dashes (e.g. "size", "state").
// Variant values use lowercase-with-spaces (e.g. "large", "hover").

export type PenComponentPropertyType =
  | 'boolean'   // On/Off toggle — usually controls layer visibility
  | 'text'      // String content override
  | 'instance_swap'  // Swap to another component (preferredValues = whitelist)
  | 'variant';  // Picks a variant from a component_set (variantOptions)

export interface PenComponentPropertyDefinition {
  type: PenComponentPropertyType;
  /// Human-readable name shown in the Properties panel.
  name?: string;
  /// Default value for new instances.
  defaultValue: boolean | string;
  /// For instance_swap: a curated list of preferred component IDs.
  preferredValues?: string[];
  /// For variant: the list of valid variant option values.
  variantOptions?: string[];
}

/// Per-instance component property values, keyed by property name.
/// On a PenRef (component instance), these override the component's defaults.
export type PenComponentPropertyValues = {
  [propertyName: string]: boolean | string;
};

/// Component property definitions, stored on the COMPONENT node itself.
export type PenComponentPropertyDefinitions = {
  [propertyName: string]: PenComponentPropertyDefinition;
};

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

/**
 * SECTION — Figma's large grouping container (introduced 2023).
 * Visually distinct from Frame: has a header label, no fill by default.
 */
export interface PenSection extends PenRectangleish, PenCanHaveChildren, PenLayout {
  type: 'section';
  /** Section header label (shown at top of the section in the canvas). */
  label?: PenStringOrVariable;
  /** When true, the section is rendered collapsed (children hidden). */
  collapsed?: PenBooleanOrVariable;
}

/**
 * COMPONENT — a reusable design element. Figma's first-class Component node.
 * Component property definitions live here; instances override values via
 * `componentProperties` on the PenRef.
 */
export interface PenComponent extends PenRectangleish, PenCanHaveChildren, PenLayout {
  type: 'component';
  /** Clip overflow. Default false. */
  clip?: PenBooleanOrVariable;
  /** Component property definitions (Boolean / Text / Instance swap / Variant). */
  componentPropertyDefinitions?: PenComponentPropertyDefinitions;
  /** Marks a slot for preferred child components. */
  slot?: false | string[];
}

/**
 * COMPONENT_SET — a container for Variants. Each child is a COMPONENT
 * with `variantPropertyValues` describing which variant it represents.
 * Naming convention (Figma-aligned): child components are named
 * `Property1=Value, Property2=Value`.
 */
export interface PenComponentSet extends PenRectangleish, PenCanHaveChildren, PenLayout {
  type: 'component_set';
  /** Axes that vary across children (e.g. ['size', 'state']). */
  variantPropertyAxes?: string[];
  /** Direction the variants are arranged in the grid: 'horizontal' | 'vertical' | 'grid'. */
  variantLayout?: 'horizontal' | 'vertical' | 'grid';
}

/// Per-variant property values, stored on a COMPONENT inside a COMPONENT_SET.
export type PenVariantPropertyValues = { [propertyName: string]: string };

/**
 * BOOLEAN_OPERATION — non-destructive union/subtract/intersect/exclude of
 * child vectors. Figma's boolean ops retain their inputs so they can be
 * edited later.
 */
export interface PenBooleanOperation extends PenEntity, PenSize, PenCanHaveChildren, PenCanHaveGraphics {
  type: 'boolean_operation';
  /** Boolean op type. */
  booleanOperationType?: 'union' | 'subtract' | 'intersect' | 'exclude';
  /** Resolved SVG path data (computed when the boolean is flattened). */
  geometry?: string;
}

/**
 * SLICE — an export region. Not rendered as a visible shape; only marks an
 * area for PNG/SVG/PDF export. Mirrors Figma's Slice tool (S).
 */
export interface PenSlice extends PenEntity, PenSize {
  type: 'slice';
  /** Export settings: format + scale. */
  exportSettings?: Array<{ format: 'png' | 'svg' | 'pdf' | 'jpg'; suffix?: string; scale?: number }>;
}

/**
 * STAR — a regular star polygon. Defined by point count + inner/outer radius ratio.
 * Mirrors Figma's STAR node type.
 */
export interface PenStar extends PenEntity, PenSize, PenCanHaveGraphics {
  type: 'star';
  /** Number of outer points (5 = pentagram, 6 = hexagram, etc.). */
  pointCount?: PenNumberOrVariable;
  /** Ratio of inner radius to outer radius. 0.5 = regular 5-point star. */
  innerRadius?: PenNumberOrVariable;
}

/**
 * LINE — a 1D line between two points. Distinct from a rectangle with 0 height
 * because it has its own Figma node type and stroke semantics.
 */
export interface PenLine extends PenEntity, PenCanHaveGraphics {
  type: 'line';
  /** End point relative to the node's origin. */
  x2?: PenNumberOrVariable;
  y2?: PenNumberOrVariable;
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
  /**
   * Per-instance component property overrides. Keyed by property name
   * (kebab-case). Values must match the type defined in the component's
   * `componentPropertyDefinitions`.
   */
  componentProperties?: PenComponentPropertyValues;
  [key: string]: unknown;
}

export type PenChild =
  | PenFrame
  | PenSection
  | PenComponent
  | PenComponentSet
  | PenBooleanOperation
  | PenSlice
  | PenGroup
  | PenRectangle
  | PenEllipse
  | PenStar
  | PenPath
  | PenPolygon
  | PenLine
  | PenText
  | PenNote
  | PenPrompt
  | PenContext
  | PenIcon
  | PenScript
  | PenRef;

// ---- Document -------------------------------------------------------------
//
// AgentCanvas extends the pen.dev .pen Document with a Pages abstraction
// (mirrors Figma's multi-page Files).

export type PenIdPath = string;

/**
 * PAGE — a single page within a File/Document. Mirrors Figma's Page concept.
 */
export interface PenPage {
  /** Unique within the document. */
  id: string;
  /** Display name (e.g. "Home", "Dashboard", "Mobile flows"). */
  name: string;
  /** The page's layer tree (PenChild[]). */
  children: PenChild[];
  /** Page-level viewport (zoom + pan) — only used by the canvas runtime. */
  viewport?: { zoom: number; panX: number; panY: number };
  /** Page background color (overrides document default). */
  background?: PenColor;
}

export interface PenDocument {
  version: typeof PEN_FORMAT_VERSION;
  themes?: { [axis: string]: string[] };
  /** Imported .pen / .lib.pen files: { alias: relativeURI }. */
  imports?: { [alias: string]: string };
  variables?: { [key: string]: PenVariableDef };
  /**
   * Top-level children — used for backward compat with single-page .pen files.
   * When `pages` is set, this field is ignored (kept empty).
   */
  children: PenChild[];
  /**
   * Pages — the modern multi-page structure. When present, the canvas uses
   * pages[activePageIndex].children as the layer tree root.
   */
  pages?: PenPage[];
  /** Index into `pages[]` for the currently active page. -1 = use `children`. */
  activePageIndex?: number;
}

// ---- Helpers --------------------------------------------------------------

/** All valid `type` values for a .pen node. */
export const PEN_NODE_TYPES = [
  'frame',
  'section',
  'component',
  'component_set',
  'boolean_operation',
  'slice',
  'group',
  'rectangle',
  'ellipse',
  'star',
  'polygon',
  'path',
  'line',
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
