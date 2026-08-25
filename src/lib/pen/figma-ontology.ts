// Figma ontology — canonical enum tables (spec Phase 6, §9.1 / Appendix G).
//
// THE VOCABULARY AUTHORITY for .pen v3: every enum spelling used by the
// Figma-canonical data model is frozen here (single source of truth shared by
// pen/types.ts unions, the alias normalizer [normalize.ts], the document
// migration [migrate.ts], and the contract test
// tests/unit/figma-ontology-contract.test.ts).
//
// Canonical-surface decision (spec §9.1): REST API spellings everywhere —
//   (a) serialized-model enum VALUES are SCREAMING_SNAKE ('SPACE_BETWEEN',
//       'LEFT_RIGHT', 'GRADIENT_LINEAR'),
//   (b) TS field NAMES are REST camelCase ('itemSpacing',
//       'primaryAxisAlignItems', 'rectangleCornerRadii'),
//   (e) extensions are allowed only as supersets — new enum values or node
//       types, never renames of Figma concepts.
//
// During the Phase 6 dual-field window the LEGACY (.pen 2.17) spellings stay
// readable everywhere via the alias tables below; the canonical tables are
// what new code writes and what migrate.ts produces.

/** Derive a string-literal union from one of the canonical tables. */
export type Figma<T extends readonly string[]> = T[number];

// ---- Canonical enum tables (Figma REST spellings) --------------------------

export const FIGMA_LAYOUT_MODE = ['NONE', 'VERTICAL', 'HORIZONTAL', 'GRID'] as const;
export const FIGMA_AXIS_ALIGN = ['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN', 'SPACE_AROUND'] as const;
export const FIGMA_LAYOUT_SIZING = ['FIXED', 'HUG', 'FILL'] as const;
export const FIGMA_LAYOUT_POSITIONING = ['AUTO', 'ABSOLUTE'] as const;
export const FIGMA_PAINT_TYPE = ['SOLID', 'GRADIENT_LINEAR', 'GRADIENT_RADIAL', 'GRADIENT_ANGULAR', 'GRADIENT_DIAMOND', 'IMAGE'] as const;
export const FIGMA_SCALE_MODE = ['FILL', 'FIT', 'TILE', 'STRETCH'] as const;
export const FIGMA_EFFECT_TYPE = ['DROP_SHADOW', 'INNER_SHADOW', 'LAYER_BLUR', 'BACKGROUND_BLUR'] as const;
export const FIGMA_TEXT_AUTO_RESIZE = ['NONE', 'HEIGHT', 'WIDTH_AND_HEIGHT'] as const;
export const FIGMA_CONSTRAINT_H = ['LEFT', 'RIGHT', 'CENTER', 'LEFT_RIGHT', 'SCALE'] as const;
export const FIGMA_CONSTRAINT_V = ['TOP', 'BOTTOM', 'CENTER', 'TOP_BOTTOM', 'SCALE'] as const;
export const FIGMA_VARIABLE_TYPE = ['BOOLEAN', 'FLOAT', 'STRING', 'COLOR'] as const;
export const FIGMA_COMPONENT_PROPERTY_TYPE = ['BOOLEAN', 'TEXT', 'INSTANCE_SWAP', 'VARIANT', 'SLOT'] as const;
export const FIGMA_BLEND_MODE = [
  'PASS_THROUGH', 'NORMAL', 'DARKEN', 'MULTIPLY', 'LINEAR_BURN', 'COLOR_BURN',
  'LIGHTEN', 'SCREEN', 'LINEAR_DODGE', 'COLOR_DODGE', 'OVERLAY', 'SOFT_LIGHT',
  'HARD_LIGHT', 'DIFFERENCE', 'EXCLUSION', 'HUE', 'SATURATION', 'COLOR', 'LUMINOSITY',
] as const;
export const FIGMA_TEXT_ALIGN = ['LEFT', 'CENTER', 'RIGHT', 'JUSTIFIED'] as const;
export const FIGMA_ALIGN_KIND = [
  'LEFT', 'RIGHT', 'HCENTER', 'TOP', 'BOTTOM', 'VCENTER',
  'DISTRIBUTE_H', 'DISTRIBUTE_V', 'TIDY',
] as const;

// ---- Domain registry -------------------------------------------------------
//
// Every table under its canonical domain name. Domain names are stable API
// surface for normalizeEnum / the normalizer functions in normalize.ts.

export const FIGMA_ENUM_DOMAINS = {
  layoutMode: FIGMA_LAYOUT_MODE,
  axisAlign: FIGMA_AXIS_ALIGN,
  layoutSizing: FIGMA_LAYOUT_SIZING,
  layoutPositioning: FIGMA_LAYOUT_POSITIONING,
  paintType: FIGMA_PAINT_TYPE,
  scaleMode: FIGMA_SCALE_MODE,
  effectType: FIGMA_EFFECT_TYPE,
  textAutoResize: FIGMA_TEXT_AUTO_RESIZE,
  constraintsH: FIGMA_CONSTRAINT_H,
  constraintsV: FIGMA_CONSTRAINT_V,
  variableType: FIGMA_VARIABLE_TYPE,
  componentPropertyType: FIGMA_COMPONENT_PROPERTY_TYPE,
  blendMode: FIGMA_BLEND_MODE,
  textAlign: FIGMA_TEXT_ALIGN,
  alignKind: FIGMA_ALIGN_KIND,
} as const;

export type FigmaEnumDomain = keyof typeof FIGMA_ENUM_DOMAINS;

// ---- Alias tables (Appendix G §G.2: legacy value → canonical value) --------
//
// Legacy .pen 2.17 / AgentCanvas spellings accepted at every parse boundary
// (.pen import, patch application, tool params) and canonicalized.
//
// Injectivity: within a domain, no two legacy values map to the same canonical
// value — EXCEPT the documented merges below (frozen by the contract test):
//   - blendMode: 'light' (the .pen 2.17 PenBlendMode member, a truncation of
//     Figma's LIGHTEN) and the CSS spelling 'lighten' both → 'LIGHTEN';
//     'pass_through' and CSS 'pass-through' both → 'PASS_THROUGH'.
//   - paintType↔scaleMode (G.1 row 10): the legacy IMAGE fill's `mode` field
//     ('fill'|'fit'|'stretch') is renamed INTO the paint entry's `scaleMode`
//     — a field migration, not an enum merge, listed here for completeness.

export const FIGMA_ENUM_ALIASES: Record<FigmaEnumDomain, Record<string, string>> = {
  layoutMode: {
    none: 'NONE',
    vertical: 'VERTICAL',
    horizontal: 'HORIZONTAL',
  },
  axisAlign: {
    start: 'MIN',
    center: 'CENTER',
    end: 'MAX',
    space_between: 'SPACE_BETWEEN',
    space_around: 'SPACE_AROUND',
  },
  layoutSizing: {
    fit_content: 'HUG',
    fill_container: 'FILL',
  },
  layoutPositioning: {
    auto: 'AUTO',
    absolute: 'ABSOLUTE',
  },
  paintType: {
    color: 'SOLID',
    linear: 'GRADIENT_LINEAR',
    radial: 'GRADIENT_RADIAL',
    angular: 'GRADIENT_ANGULAR',
    image: 'IMAGE',
  },
  scaleMode: {
    stretch: 'STRETCH',
    fill: 'FILL',
    fit: 'FIT',
  },
  effectType: {
    inner: 'INNER_SHADOW',
    outer: 'DROP_SHADOW',
    blur: 'LAYER_BLUR',
    background_blur: 'BACKGROUND_BLUR',
  },
  textAutoResize: {
    auto: 'WIDTH_AND_HEIGHT',
    'fixed-width': 'NONE',
    'fixed-width-height': 'HEIGHT',
  },
  constraintsH: {
    left: 'LEFT',
    right: 'RIGHT',
    center: 'CENTER',
    scale: 'SCALE',
    left_right: 'LEFT_RIGHT',
  },
  constraintsV: {
    top: 'TOP',
    bottom: 'BOTTOM',
    center: 'CENTER',
    scale: 'SCALE',
    top_bottom: 'TOP_BOTTOM',
  },
  variableType: {
    color: 'COLOR',
    number: 'FLOAT',
    string: 'STRING',
    boolean: 'BOOLEAN',
  },
  componentPropertyType: {
    boolean: 'BOOLEAN',
    text: 'TEXT',
    instance_swap: 'INSTANCE_SWAP',
    variant: 'VARIANT',
    slot: 'SLOT',
  },
  blendMode: {
    normal: 'NORMAL',
    darken: 'DARKEN',
    multiply: 'MULTIPLY',
    linearBurn: 'LINEAR_BURN',
    colorBurn: 'COLOR_BURN',
    light: 'LIGHTEN',
    lighten: 'LIGHTEN',
    screen: 'SCREEN',
    linearDodge: 'LINEAR_DODGE',
    colorDodge: 'COLOR_DODGE',
    overlay: 'OVERLAY',
    softLight: 'SOFT_LIGHT',
    hardLight: 'HARD_LIGHT',
    difference: 'DIFFERENCE',
    exclusion: 'EXCLUSION',
    hue: 'HUE',
    saturation: 'SATURATION',
    color: 'COLOR',
    luminosity: 'LUMINOSITY',
    pass_through: 'PASS_THROUGH',
    'pass-through': 'PASS_THROUGH',
  },
  textAlign: {
    left: 'LEFT',
    center: 'CENTER',
    right: 'RIGHT',
    justify: 'JUSTIFIED',
  },
  alignKind: {
    left: 'LEFT',
    right: 'RIGHT',
    top: 'TOP',
    bottom: 'BOTTOM',
    center_h: 'HCENTER',
    center_v: 'VCENTER',
    distribute_h: 'DISTRIBUTE_H',
    distribute_v: 'DISTRIBUTE_V',
  },
};

/** Documented alias merges (legacy value pairs that land on one canonical). */
export const FIGMA_ALIAS_MERGES: Record<string, string[]> = {
  'blendMode:LIGHTEN': ['light', 'lighten'],
  'blendMode:PASS_THROUGH': ['pass_through', 'pass-through'],
};

// ---- Normalizer ------------------------------------------------------------

/**
 * Resolve a raw enum value inside a domain to its canonical spelling.
 *
 * Total + pure: returns the canonical value when the input is already
 * canonical OR is a registered legacy alias; returns `null` for unknown
 * values (callers decide whether to pass through, flag, or throw).
 */
export function normalizeEnum(domain: FigmaEnumDomain, value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const canonical = FIGMA_ENUM_DOMAINS[domain] as readonly string[];
  if (canonical.includes(value)) return value;
  const alias = FIGMA_ENUM_ALIASES[domain][value];
  return alias ?? null;
}

/** True when the value is a canonical member of the domain (not an alias). */
export function isCanonicalEnum(domain: FigmaEnumDomain, value: unknown): value is string {
  return typeof value === 'string' && (FIGMA_ENUM_DOMAINS[domain] as readonly string[]).includes(value);
}

// ---- Derived unions (re-exported for pen/types.ts + consumers) --------------

export type FigmaLayoutMode = Figma<typeof FIGMA_LAYOUT_MODE>;
export type FigmaAxisAlign = Figma<typeof FIGMA_AXIS_ALIGN>;
export type FigmaLayoutSizing = Figma<typeof FIGMA_LAYOUT_SIZING>;
export type FigmaLayoutPositioning = Figma<typeof FIGMA_LAYOUT_POSITIONING>;
export type FigmaPaintType = Figma<typeof FIGMA_PAINT_TYPE>;
export type FigmaScaleMode = Figma<typeof FIGMA_SCALE_MODE>;
export type FigmaEffectType = Figma<typeof FIGMA_EFFECT_TYPE>;
export type FigmaTextAutoResize = Figma<typeof FIGMA_TEXT_AUTO_RESIZE>;
export type FigmaConstraintH = Figma<typeof FIGMA_CONSTRAINT_H>;
export type FigmaConstraintV = Figma<typeof FIGMA_CONSTRAINT_V>;
export type FigmaVariableType = Figma<typeof FIGMA_VARIABLE_TYPE>;
export type FigmaComponentPropertyType = Figma<typeof FIGMA_COMPONENT_PROPERTY_TYPE>;
export type FigmaBlendMode = Figma<typeof FIGMA_BLEND_MODE>;
export type FigmaTextAlign = Figma<typeof FIGMA_TEXT_ALIGN>;
export type FigmaAlignKind = Figma<typeof FIGMA_ALIGN_KIND>;
