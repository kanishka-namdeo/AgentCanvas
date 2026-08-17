# .pen File Format — Version 2.0 Specification

> **Status**: Authoritative. The TypeScript types in
> `src/lib/pen/types.ts` are the executable form of this spec; this
> document is the human-readable form.
>
> **Relationship to pen.dev**: We preserve pen.dev's `2.x` format
> verbatim where it already covers a concept, and EXTEND it with
> Figma-aligned ontology (Components, Variants, Instances, BooleanOps,
> Constraints, LayoutGrids, Masks, ComponentProperties). All v2.0
> additions are flagged **`(new v2.0)`** below.
>
> **Versioning**: `PEN_FORMAT_VERSION = '2.17'`. The minor version
> bumps when additive fields are added. The major version (2) is
> frozen until a breaking change is required.

---

## 1. Top-level structure

```jsonc
{
  "version": "2.17",                  // string, required, matches PEN_FORMAT_VERSION
  "themes": {                          // optional — declares theme axes (modes)
    "mode": ["light", "dark"],
    "density": ["comfortable", "compact"]
  },
  "imports": {                         // optional — aliases to external .lib.pen files
    "core": "./core.lib.pen"
  },
  "variables": {                       // optional — design tokens
    "brand.primary": { "type": "color", "value": "#3b82f6" },
    "brand.primary.hover": { "type": "color", "value": [
      { "value": "#3b82f6", "theme": { "mode": "light" } },
      { "value": "#60a5fa", "theme": { "mode": "dark" } }
    ]}
  },
  "children": [                        // required — the node tree
    { "type": "frame", "id": "root", "children": [ /* … */ ] }
  ]
}
```

### 1.1 `themes` — theme axes

A theme axis is a named dimension along which a Variable can have
multiple values. The axis `mode` with values `['light','dark']` is the
canonical "dark mode" example. An axis named `density` with values
`['comfortable','compact']` is a common design-system example.

Each `PenThemedValue` carries an optional `theme` object that picks
which value is active per axis:

```jsonc
{ "value": "#3b82f6", "theme": { "mode": "light" } }
```

A node can also carry its own `theme` to override the document-level
theme on its subtree.

### 1.2 `variables` — design tokens

A flat map of `name → PenVariableDef`. Names use dot-namespace
convention (`brand.primary`, `text.heading.size`). There is no formal
grouping in the schema — grouping is purely a UI/render concern.

### 1.3 `imports` — external libraries

Maps an alias to a relative URI of another `.pen` or `.lib.pen` file.
References into the library use the alias as a prefix:
`{ "type": "ref", "ref": "core:button-primary" }` references the
`button-primary` node in `./core.lib.pen`.

### 1.4 `children` — the node tree

Array of `PenChild` (discriminated union on `type`). Order = z-order
(first = bottom, last = top).

---

## 2. Node types — full enumeration

| `type`          | TS interface                | Section |
| --------------- | --------------------------- | ------- |
| `frame`         | `PenFrame`                  | §3.1    |
| `group`         | `PenGroup`                  | §3.2    |
| `rectangle`     | `PenRectangle`              | §4.1    |
| `ellipse`       | `PenEllipse`                | §4.2    |
| `polygon`       | `PenPolygon`                | §4.3    |
| `star`          | `PenStar` *(v2.1)*          | §4.4    |
| `path`          | `PenPath`                   | §4.5    |
| `text`          | `PenText`                   | §5      |
| `note`          | `PenNote`                   | §6.1    |
| `prompt`        | `PenPrompt`                 | §6.2    |
| `context`       | `PenContext`                | §6.3    |
| `icon`          | `PenIcon`                   | §6.4    |
| `script`        | `PenScript`                 | §6.5    |
| `ref`           | `PenRef`                    | §7      |
| `boolean_op`    | `PenBooleanOp` *(new v2.0)* | §8      |
| `embed`         | `PenEmbed` *(v2.1)*         | §6.6    |

---

## 3. Container nodes

### 3.1 `frame` — the primary container

```ts
interface PenFrame extends PenRectangleish, PenCanHaveChildren, PenLayout {
  type: 'frame';
  clip?: PenBooleanOrVariable;                  // clip overflow. default false
  placeholder?: boolean;                         // marks the frame as a placeholder
  slot?: false | string[];                       // recommended reusable child IDs (slot hint)
  overflow?: 'hidden' | 'scroll-x' | 'scroll-y' | 'scroll-both';  // (new v2.0)
  // ---- inherited from PenRectangleish ----
  // id, name, x, y, width, height, rotation, fill, stroke, …, cornerRadius
  // ---- inherited from PenLayout ----
  // layout, gap, padding, justifyContent, alignItems, layoutIncludeStroke
  // ---- inherited from PenEntity (via PenRectangleish) ----
  // theme, enabled, opacity, flipX, flipY, layoutPosition, metadata
}
```

A `frame` is the universal container — equivalent to Figma's
`FrameNode`, CSS's `<div>`, and React's `<div>`. It can:

- Hold children (`children: PenChild[]`)
- Auto-layout children (`layout: 'horizontal' | 'vertical' | 'grid'`)
- Clip overflow (`clip: true`)
- Be a Component definition (`reusable: true` — see §7)
- Be a Component Set (`metadata.isComponentSet: true` — see §7)
- Be a Section (`metadata.isSection: true` — see §11)
- Be a Slice (`metadata.isSlice: true` — see §11)

#### Default values when omitted

| Field                | Default                  |
| -------------------- | ------------------------ |
| `layout`             | `'horizontal'`           |
| `width` / `height`   | `'fit_content'`          |
| `clip`               | `false`                  |
| `padding`            | `0`                      |
| `gap`                | `0`                      |
| `justifyContent`     | `'start'`                |
| `alignItems`         | `'start'`                |

### 3.2 `group` — lightweight container

```ts
interface PenGroup extends PenEntity, PenCanHaveChildren, PenCanHaveEffects {
  type: 'group';
}
```

A `group` is a *non-layout* container. Children retain their own
absolute positions; the group's bounding box is the union of its
children. Equivalent to Figma's `GroupNode`. Use a `frame` instead if
you need Auto Layout.

---

## 4. Shape nodes

### 4.1 `rectangle`

```ts
interface PenRectangle extends PenRectangleish {
  type: 'rectangle';
}
```

The most basic shape. Supports per-corner radii via `cornerRadius:
[tl, tr, br, bl]`.

### 4.2 `ellipse`

```ts
interface PenEllipse extends PenEntity, PenSize, PenCanHaveGraphics {
  type: 'ellipse';
  innerRadius?: PenNumberOrVariable;   // 0=solid, 1=hollow ring. default 0
  startAngle?: PenNumberOrVariable;    // degrees CCW from right. default 0
  sweepAngle?: PenNumberOrVariable;    // positive=CCW, negative=CW. range -360..360. default 360
}
```

A circle/ellipse with optional arc/ring support.

### 4.3 `polygon`

```ts
interface PenPolygon extends PenEntity, PenSize, PenCanHaveGraphics {
  type: 'polygon';
  polygonCount?: PenNumberOrVariable;   // number of sides. default 6
  cornerRadius?: PenNumberOrVariable;   // default 0
}
```

A regular N-sided polygon (triangle, pentagon, hexagon, …).

### 4.4 `star` *(planned v2.1)*

```ts
interface PenStar extends PenEntity, PenSize, PenCanHaveGraphics {
  type: 'star';
  pointCount?: PenNumberOrVariable;       // number of points. default 5
  innerRadius?: PenNumberOrVariable;      // 0..1, ratio of inner/outer. default 0.5
}
```

### 4.5 `path`

```ts
interface PenPath extends PenEntity, PenSize, PenCanHaveGraphics {
  type: 'path';
  fillRule?: 'nonzero' | 'evenodd';       // default 'nonzero'
  geometry: string;                       // SVG path data
  viewBox?: [number, number, number, number];  // SVG coord space mapping
}
```

A freeform vector shape defined by SVG path data. Used for all
freeform geometry (lines, curves, custom shapes).

---

## 5. Text

```ts
interface PenText extends PenEntity, PenSize, PenCanHaveGraphics, PenTextStyle {
  type: 'text';
  content?: PenTextContent;               // the text to render
  textGrowth?: 'auto' | 'fixed-width' | 'fixed-width-height';
}
```

### `PenTextStyle`

```ts
interface PenTextStyle {
  fontFamily?: PenStringOrVariable;
  fontSize?: PenNumberOrVariable;
  fontWeight?: PenStringOrVariable;       // "Bold" | "Regular" | number
  letterSpacing?: PenNumberOrVariable;
  fontStyle?: PenStringOrVariable;        // "italic" | "normal"
  underline?: PenBooleanOrVariable;
  lineHeight?: PenNumberOrVariable;       // numeric = px, or multiplier
  textAlign?: 'left' | 'center' | 'right' | 'justify';
  textAlignVertical?: 'top' | 'middle' | 'bottom';
  strikethrough?: PenBooleanOrVariable;
  href?: string;                          // hyperlink
}
```

### `textGrowth`

| Value                  | Behavior |
| ---------------------- | -------- |
| `'auto'`               | Node grows to fit text. No wrapping. (default) |
| `'fixed-width'`        | Width is fixed; text wraps; height grows. |
| `'fixed-width-height'` | Both dimensions fixed. Text may overflow or truncate. |

---

## 6. Special-purpose nodes

### 6.1 `note` — sticky note

```ts
interface PenNote extends PenEntity, PenSize, PenTextStyle {
  type: 'note';
  content?: PenTextContent;
}
```

A sticky-note-like text block with a colored background. Convention:
render with a 2° rotation and a soft drop shadow.

### 6.2 `prompt` — AI prompt card

```ts
interface PenPrompt extends PenEntity, PenSize, PenTextStyle {
  type: 'prompt';
  content?: PenTextContent;
  model?: PenStringOrVariable;            // model identifier
}
```

A card representing an AI prompt — used in .pen-based prompt-engineering
flows.

### 6.3 `context` — AI context card

```ts
interface PenContext extends PenEntity, PenSize, PenTextStyle {
  type: 'context';
  content?: PenTextContent;
}
```

A card representing context to feed to a model.

### 6.4 `icon` — icon from a library

```ts
interface PenIcon extends PenEntity, PenSize, PenCanHaveEffects {
  type: 'icon';
  library?: PenStringOrVariable;          // 'lucide' | 'feather' | 'Material Symbols Outlined' | 'Material Symbols Rounded' | 'Material Symbols Sharp' | 'phosphor'
  icon?: PenStringOrVariable;             // icon name
  weight?: PenNumberOrVariable;           // 100..700 (libraries that support it)
  fill?: PenFills;                        // tint
}
```

### 6.5 `script` — generative content

```ts
interface PenScript extends PenEntity, PenSize {
  type: 'script';
  clip?: PenBooleanOrVariable;
  scriptUri?: string;                     // JS file URI, relative to .pen
  inputs?: { [key: string]: string | number | boolean | PenVariable };
}
```

Generates children at runtime by executing a JavaScript file. Used
for data-driven layouts (e.g. "render 100 cards from CSV").

### 6.6 `embed` *(planned v2.1)*

```ts
interface PenEmbed extends PenEntity, PenSize {
  type: 'embed';
  url: string;
}
```

An embedded external resource (iframe-like).

---

## 7. Components & Instances

### 7.1 Component definition

Any node with `reusable: true` is a Component definition:

```jsonc
{
  "type": "frame",
  "id": "button-primary",
  "reusable": true,
  "metadata": {
    "componentProperties": {                          // (new v2.0)
      "label": { "type": "string", "defaultValue": "Submit" },
      "showIcon": { "type": "boolean", "defaultValue": true },
      "size": { "type": "variant", "variantOptions": ["sm", "md", "lg"] }
    }
  },
  "children": [ /* … */ ]
}
```

### 7.2 Component Set

A frame that groups variant Components of the same family:

```jsonc
{
  "type": "frame",
  "id": "button-set",
  "metadata": { "isComponentSet": true },              // (new v2.0)
  "children": [
    { "type": "frame", "id": "button-default", "reusable": true,
      "metadata": { "variantProperties": { "state": "default" } } },
    { "type": "frame", "id": "button-hover", "reusable": true,
      "metadata": { "variantProperties": { "state": "hover" } } }
  ]
}
```

### 7.3 Instance (`ref`)

```ts
interface PenRef extends PenEntity {
  type: 'ref';
  ref: string;                            // ID of the referenced (reusable) node
  descendants?: { [idPath: string]: Partial<PenChild> };
}
```

A `ref` is an **instance** of a Component. The `ref` field is the
Component ID. `descendants` overrides specific descendant properties:

```jsonc
{
  "type": "ref",
  "ref": "button-primary",
  "descendants": {
    "label": { "content": "Cancel" },                 // override a property
    "icon": { "fill": "#dc2626" },                    // override another
    "container": { "type": "frame", "children": [ /* … */ ] }  // replace entirely
  }
}
```

- **No `type` key** in the override → property override applied to that descendant.
- **`type` key present** → descendant is fully replaced with the new node tree.

Key format: slash-separated descendant IDs (e.g. `"ok-button/label"`).

---

## 8. Boolean operations *(new v2.0)*

```ts
interface PenBooleanOp extends PenEntity, PenCanHaveChildren, PenCanHaveGraphics, PenCanHaveEffects {
  type: 'boolean_op';
  operation: 'union' | 'intersect' | 'subtract' | 'exclude';
}
```

Combines its `children`'s geometry using a set operation. The result
is non-destructive — children remain in the tree and the boolean is
resolved at render time.

| Operation   | Figma name    | Effect |
| ----------- | ------------- | ------ |
| `union`     | `UNION`       | A ∪ B — sum of all child shapes |
| `intersect` | `INTERSECT`   | A ∩ B — only overlapping regions |
| `subtract`  | `SUBTRACT`    | A − B − C … — first child minus the rest |
| `exclude`   | `EXCLUDE`     | A ⊕ B — non-overlapping regions only |

---

## 9. Auto Layout

Defined on `PenFrame` via the `PenLayout` mixin:

```ts
interface PenLayout {
  layout?: 'none' | 'vertical' | 'horizontal' | 'grid';     // (grid is new v2.0)
  gap?: PenNumberOrVariable;
  layoutIncludeStroke?: boolean;
  padding?:
    | PenNumberOrVariable
    | [PenNumberOrVariable, PenNumberOrVariable]
    | [PenNumberOrVariable, PenNumberOrVariable, PenNumberOrVariable, PenNumberOrVariable];
  justifyContent?: 'start' | 'center' | 'end' | 'space_between' | 'space_around';
  alignItems?: 'start' | 'center' | 'end';
}
```

### 9.1 Sizing

Width and height accept either a number (px), a `$variable` reference,
or one of these sizing behaviors:

| Value              | Figma equivalent                 | When applicable |
| ------------------ | -------------------------------- | --------------- |
| `'fit_content'`    | `layoutSizing*: HUG`             | Auto-layout frames + text nodes |
| `'fill_container'` | `layoutSizing*: FILL`            | Auto-layout frame children |
| number             | `layoutSizing*: FIXED`           | Any node |

Shorthand with fallback: `'fit_content(100)'` — fit-content with a
100px max.

### 9.2 Grid layout *(new v2.0)*

When `layout: 'grid'`, additional fields apply (stored in
`metadata.gridLayout` to avoid bloating the main interface):

```ts
interface PenGridLayout {
  gridRowCount?: number;
  gridColumnCount?: number;
  gridRowGap?: number;
  gridColumnGap?: number;
  gridColumnsSizing?: string;   // CSS grid-template-columns
  gridRowsSizing?: string;      // CSS grid-template-rows
}
```

Per-child grid placement is stored on the child's `metadata`:

```ts
interface PenGridChildPlacement {
  gridChildHorizontalAlign?: 'auto' | 'min' | 'center' | 'max';
  gridChildVerticalAlign?: 'auto' | 'min' | 'center' | 'max';
  gridRowSpan?: number;          // default 1
  gridColumnSpan?: number;       // default 1
}
```

### 9.3 Constraints *(new v2.0)*

When a child of a non-Auto-Layout frame, the child's `metadata.constraints`
field carries its resize behavior:

```ts
interface PenLayoutConstraint {
  horizontal: 'left' | 'right' | 'center' | 'left_right' | 'scale';
  vertical: 'top' | 'bottom' | 'center' | 'top_bottom' | 'scale';
}
```

### 9.4 Layout positioning

```ts
type PenLayoutPosition = 'auto' | 'absolute';
```

- `'auto'` (default) — participates in parent's Auto Layout.
- `'absolute'` — positioned manually via `x`/`y`, ignoring parent's layout.

### 9.5 Auto-layout child overrides

A child of an Auto Layout frame can override its layout behavior via
`metadata`:

```ts
interface PenAutoLayoutChild {
  layoutAlign?: 'inherit' | 'stretch' | 'min' | 'center' | 'max';
  layoutGrow?: 0 | 1;                              // 0=fixed, 1=stretch
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
}
```

---

## 10. Variables & Themes

### 10.1 Variable definition

```ts
type PenVariableDef =
  | { type: 'boolean'; value: PenBooleanOrVariable | PenThemedValue<PenBooleanOrVariable>[] }
  | { type: 'color';    value: PenColorOrVariable    | PenThemedValue<PenColorOrVariable>[]    }
  | { type: 'number';   value: PenNumberOrVariable   | PenThemedValue<PenNumberOrVariable>[]   }
  | { type: 'string';   value: PenStringOrVariable   | PenThemedValue<PenStringOrVariable>[]   };
```

### 10.2 Theme-conditional value

```ts
interface PenThemedValue<T> {
  value: T;
  theme?: PenTheme;       // partial axis→value map; active when ALL axes match
}
```

### 10.3 Binding a field to a variable

Replace any literal value with a `$variable-name` string:

```jsonc
{ "fill": "$brand.primary" }            // bound
{ "fill": "#3b82f6" }                   // literal
{ "width": "$spacing.md" }              // bound number
{ "fontSize": "$text.body.size" }       // bound number
```

The variable's value (or its theme-conditional value, if a theme is
active) is resolved at render time.

### 10.4 Document theme

Set `metadata.theme` on any node to override the active theme for that
node's subtree:

```jsonc
{
  "type": "frame",
  "theme": { "mode": "dark" },          // subtree renders in dark mode
  "children": [ /* … */ ]
}
```

---

## 11. Metadata-flagged node kinds *(new v2.0)*

Several node "kinds" are encoded as a `frame` with a metadata flag
rather than as distinct `type` values. This keeps the discriminated
union small while still expressing the Figma ontology.

| Metadata flag                | Figma equivalent    | Meaning |
| ---------------------------- | ------------------- | ------- |
| `metadata.isComponentSet`    | `ComponentSetNode`  | Groups variant Components |
| `metadata.isSection`         | `SectionNode`       | A canvas section / region |
| `metadata.isSlice`           | `SliceNode`         | An export-only slice region |
| `metadata.isEmbed`           | `EmbedNode`         | An embedded external resource |
| `metadata.componentProperties` | `ComponentPropertyDefinition[]` | Component Property definitions |
| `metadata.variantProperties` | `{ [name]: string }` | This Component's variant values |
| `metadata.isMask`            | `HasMaskTrait`      | This node is a mask |
| `metadata.maskType`          | `HasMaskTrait`      | `'alpha' \| 'vector' \| 'luminance'` |
| `metadata.layoutGrids`       | `HasFramePropertiesTrait.layoutGrids` | Layout guides |
| `metadata.exportSettings`    | `HasExportSettingsTrait` | Per-node export config |
| `metadata.constraints`       | `LayoutConstraint`  | Resize constraints |
| `metadata.characterStyleOverrides` | `TypePropertiesTrait` | Per-character text styles (imported, not editable) |
| `metadata.annotations`       | `AnnotationsTrait`  | Author annotations |
| `metadata.devStatus`         | `DevStatusTrait`    | Dev handoff status |

---

## 12. Graphics

### 12.1 Fill

```ts
type PenFill =
  | PenColorOrVariable                                          // bare hex / $var
  | { type: 'color';      color; enabled?; blendMode? }
  | { type: 'gradient';   gradientType?; colors?; center?; size?; rotation?; opacity?; blendMode?; enabled? }
  | { type: 'image';      url; mode?: 'stretch'|'fill'|'fit'; opacity?; blendMode?; enabled? }
  | { type: 'shader';     url; uniforms?; opacity?; blendMode?; enabled? }
  | { type: 'mesh_gradient'; columns?; rows?; colors?; points?; opacity?; blendMode?; enabled? };

type PenFills = PenFill | PenFill[];     // single or stacked
```

### 12.2 Stroke

```ts
interface PenCanHaveStroke {
  stroke?: PenFills;
  strokeWidth?:
    | PenNumberOrVariable
    | { top?; right?; bottom?; left? };
  strokeLinecap?: 'butt' | 'round' | 'square';
  strokeLinejoin?: 'miter' | 'bevel' | 'round';
  strokeAlignment?: 'inner' | 'center' | 'outer';
  strokeDashes?: number[];                  // (new v2.0)
  strokeMiterLimit?: number;                // (new v2.0) default 28.96°
}
```

### 12.3 Effects

```ts
type PenEffect =
  | { enabled?; type: 'blur';            radius? }
  | { enabled?; type: 'background_blur'; radius? }
  | { enabled?; type: 'shadow';
      shadowType?: 'inner' | 'outer';
      offset?: { x; y };
      spread?;
      blur?;
      color?;
      blendMode? };

type PenEffects = PenEffect | PenEffect[];
```

### 12.4 Blend modes

```ts
type PenBlendMode =
  | 'normal' | 'darken' | 'multiply' | 'linearBurn' | 'colorBurn'
  | 'lighten' | 'screen' | 'linearDodge' | 'colorDodge' | 'overlay'
  | 'softLight' | 'hardLight' | 'difference' | 'exclusion'
  | 'hue' | 'saturation' | 'color' | 'luminosity';
```

---

## 13. Color format

Colors are hex strings:

| Format        | Example        | Meaning |
| ------------- | -------------- | ------- |
| `#RGB`        | `#f00`         | 4-bit per channel |
| `#RRGGBB`     | `#ff0000`      | 8-bit per channel, opaque |
| `#RRGGBBAA`   | `#ff000080`    | 8-bit per channel + 8-bit alpha |

A `$variable-name` string is also a valid color wherever a color is
expected (it resolves to a `type: 'color'` variable).

---

## 14. Transforms

.pen decomposes the 2D affine transform into ergonomic fields on
`PenEntity`:

| Field       | Type              | Default | Notes |
| ----------- | ----------------- | ------- | ----- |
| `x`         | number \| `$var`  | 0       | translation X |
| `y`         | number \| `$var`  | 0       | translation Y |
| `rotation`  | number \| `$var`  | 0       | degrees CCW around top-left corner |
| `flipX`     | boolean \| `$var` | false   | mirror horizontally |
| `flipY`     | boolean \| `$var` | false   | mirror vertically |
| `opacity`   | number \| `$var`  | 1       | 0..1 |

Figma's 2×3 matrix transform (`relativeTransform`) can be losslessly
decomposed into these fields for affine transforms without skew.
.pen does not support skew; if a Figma transform has skew, it is
baked into a `PenPath` on import.

---

## 15. Validation rules

A `.pen` file is valid if and only if:

1. The top-level object has `version: "2.17"` (or compatible).
2. `children` is an array of valid `PenChild` objects.
3. Every `id` is unique within the document.
4. No `id` contains the `/` character (reserved for `ref` descendant paths).
5. Every `ref`'s `ref` field points to an existing `reusable: true` node.
6. Every `descendants` key is a slash-separated path that resolves
   to a descendant of the referenced node.
7. Every `$variable-name` reference resolves to a defined variable.
8. `themes` axis names match the `theme` keys used in `PenThemedValue`s.
9. No circular variable aliases (A → B → A).
10. `boolean_op` nodes have at least one child.

The function `isPenDocument(value): value is PenDocument` in
`src/lib/pen/types.ts` performs a best-effort structural validation.
Full referential-integrity validation is done by
`src/lib/pen/resolve.ts` during `resolvePenTree()`.

---

## 16. Migration from v1.x → v2.0

A v1.x `.pen` file is a valid v2.0 file with these caveats:

- v1 `tokens` field → migrate to `variables` (different shape; the
  migrator in `src/lib/pen/migrate.ts` handles this).
- v1 `shapes[]` flat array → migrate to a tree (one root `frame`
  holding all shapes as children).
- v1 `Shape.type === 'image'` → migrate to `frame` with `fill: { type: 'image' }`.

The migration is **one-way and lossless** for all v1 features that
have v2 equivalents.

---

## 17. File extension & MIME type

- Extension: `.pen`
- MIME type: `application/vnd.pen.v2+json`
- Library files: `.lib.pen` (same format, convention only)

---

## 18. JSON Schema

A machine-readable JSON Schema is generated from
`src/lib/pen/types.ts` by the build script
`scripts/generate-pen-schema.ts` (planned). Until then, the TS types
ARE the schema.

---

## 19. Prototyping *(new v2.1)*

.pen v2.1 adds optional prototyping types that mirror Figma's
prototyping model: triggers, actions, transitions, and easing. These
are stored on a node's `metadata.interactions` array rather than as
top-level fields, since prototyping is an optional concern.

### 19.1 Triggers

| Trigger          | Figma equivalent       | When it fires |
| ----------------- | ---------------------- | ------------- |
| `on_click`        | `ON_CLICK`             | User clicks the node |
| `on_hover`        | `ON_HOVER`             | Cursor enters the node (reverts on leave) |
| `on_press`        | `ON_PRESS`             | Mouse down on the node (reverts on release) |
| `on_drag`         | `ON_DRAG`              | User drags the node |
| `after_timeout`   | `AFTER_TIMEOUT`        | After `timeout` ms elapse |
| `mouse_enter`     | `MOUSE_ENTER`          | Cursor enters (permanent, optional `delay` ms) |
| `mouse_leave`     | `MOUSE_LEAVE`          | Cursor leaves (permanent, optional `delay` ms) |
| `mouse_up`        | `MOUSE_UP`             | Mouse button released |
| `mouse_down`      | `MOUSE_DOWN`           | Mouse button pressed |
| `on_key_down`     | `ON_KEY_DOWN`          | Key pressed (with `device` + `keyCodes`) |
| `on_media_hit`    | `ON_MEDIA_HIT`         | Video reaches `mediaHitTime` seconds |
| `on_media_end`    | `ON_MEDIA_END`         | Video ends |

### 19.2 Actions

| Action                  | Figma equivalent       | Effect |
| ----------------------- | ---------------------- | ------ |
| `back`                  | `BACK`                 | Navigate back in prototype history |
| `close`                 | `CLOSE`                | Close the overlay |
| `url`                   | `URL`                  | Open `url` in a new tab |
| `navigate`              | `NODE`                 | Navigate to `destinationId` with optional `transition` |
| `overlay`               | `NODE` (overlay)       | Open `destinationId` as an overlay |
| `swap`                  | `NODE` (swap)          | Swap `destinationId` in place |
| `update_media_runtime`  | `UPDATE_MEDIA_RUNTIME` | Play / pause / mute / etc. a media node |
| `set_variable`          | `SET_VARIABLE`         | Set a variable's runtime value |
| `set_variable_mode`     | `SET_VARIABLE_MODE`    | Switch the active mode of a variable collection |
| `conditional`           | `CONDITIONAL`          | Evaluate `condition`; run `trueAction` or `falseAction` |

### 19.3 Transitions

| Transition type  | Figma equivalent  | Notes |
| ---------------- | ----------------- | ----- |
| `fade`           | `DISSOLVE`        | Cross-fade |
| `move_in`        | `MOVE_IN`         | New frame slides in |
| `move_out`       | `MOVE_OUT`        | Old frame slides out |
| `push`           | `PUSH`            | Old frame pushed out by new |
| `slide_in`       | `SLIDE_IN`        | Slide in over existing |
| `slide_out`      | `SLIDE_OUT`       | Slide out revealing existing |
| `reveal`         | `REVEAL`          | Existing content slides away to reveal |
| `smart_animate`  | `SMART_ANIMATE`   | Diff-based animation (Figma-specific) |
| `dissolve`       | `DISSOLVE`        | Alias of `fade` |
| `none`           | `NONE`            | Instant cut |

### 19.4 Easing

13 easing types mirrored from Figma:

| Easing                | Figma equivalent         |
| --------------------- | ------------------------ |
| `ease_in`             | `EASE_IN`                |
| `ease_out`            | `EASE_OUT`               |
| `ease_in_out`         | `EASE_IN_AND_OUT`        |
| `linear`              | `LINEAR`                 |
| `ease_in_back`        | `EASE_IN_BACK`           |
| `ease_out_back`       | `EASE_OUT_BACK`          |
| `ease_in_out_back`    | `EASE_IN_AND_OUT_BACK`   |
| `gentle`              | `GENTLE` (spring)        |
| `quick`               | `QUICK` (spring)         |
| `bouncy`              | `BOUNCY` (spring)        |
| `slow`                | `SLOW` (spring)          |
| `custom_cubic_bezier` | `CUSTOM_CUBIC_BEZIER`    |
| `custom_spring`       | `CUSTOM_SPRING`          |

When `easing === 'custom_cubic_bezier'`, supply `cubicBezier: { x1, y1, x2, y2 }`.
When `easing === 'custom_spring'`, supply `springConfig: { stiffness, damping, mass }`.

### 19.5 Example

```jsonc
{
  "type": "frame",
  "id": "login-button",
  "metadata": {
    "interactions": [
      {
        "trigger": { "type": "on_click" },
        "actions": [
          {
            "type": "navigate",
            "destinationId": "dashboard-frame",
            "transition": {
              "type": "push",
              "direction": "left",
              "durationMs": 300,
              "easing": "ease_in_out"
            }
          }
        ]
      },
      {
        "trigger": { "type": "on_hover" },
        "actions": [
          { "type": "set_variable", "variableId": "button-state", "value": "hover" }
        ]
      }
    ]
  }
}
```

---

## 20. Comments *(new v2.1)*

.pen v2.1 adds a top-level `comments` array to `PenDocument`. Each
comment is anchored to a node or a canvas point, and can have reactions
and threaded replies.

```jsonc
{
  "comments": [
    {
      "id": "c1",
      "author": "ada",
      "body": "This button should be larger",
      "createdAt": "2026-01-01T00:00:00Z",
      "resolved": false,
      "anchor": { "nodeId": "login-button", "x": 10, "y": 20 },
      "reactions": [
        { "emoji": "👍", "user": "bob" }
      ],
      "replies": [
        { "id": "c1-r1", "author": "bob", "body": "Done", "createdAt": "2026-01-01T01:00:00Z" }
      ]
    }
  ]
}
```

Comments are exported to Figma's REST API comment shape by
`penToFigmaJSON()`.

---

## 21. References

- pen.dev format (inspiration): <https://docs.pen.dev/for-developers/the-pen-format>
- Figma REST API spec: `research/figma-ontology/openapi-figma.yaml`
- Our type source: `src/lib/pen/types.ts`
- Our resolver: `src/lib/pen/resolve.ts`
- Our converter (pen ↔ SVG ↔ Figma JSON): `src/lib/pen/converters.ts`
