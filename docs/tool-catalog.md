# Agent Tool Catalog — Complete Reference

> Every tool the AgentCanvas agent can call, with its name, argument
> schema, semantics, and at least one worked example. This document is
> the **authoritative source** for the agent's tool surface — the
> system prompt in `src/lib/agent/runner.ts` is generated from this
> catalog.
>
> **Status**: 62 tools total (12 new in v2.0). All tool names use the
> `pen_*` prefix and `snake_case` to match the .pen / pen.dev
> convention.

---

## Catalogue

### Shape creation (12 tools)

| Tool                          | Purpose                                                | Section |
| ----------------------------- | ------------------------------------------------------ | ------- |
| `pen_create_shape`            | Create any primitive shape (rect/ellipse/polygon/path/text/line) | §1.1 |
| `pen_create_text`             | Create a text node with content + style                | §1.2    |
| `pen_create_frame`            | Create a frame (optionally with Auto Layout)           | §1.3    |
| `pen_create_group`            | Wrap existing nodes in a group                         | §1.4    |
| `pen_create_path`             | Create a freeform vector path from SVG path data       | §1.5    |
| `pen_create_polygon`          | Create a regular N-sided polygon                       | §1.6    |
| `pen_create_star` *(v2.1)*    | Create a star shape                                    | §1.7    |
| `pen_create_line`             | Create a 1D line between two points                    | §1.8    |
| `pen_create_image`            | Create a frame with an image fill                      | §1.9    |
| `pen_create_note`             | Create a sticky-note text card                         | §1.10   |
| `pen_create_icon`             | Create an icon node from a named library               | §1.11   |
| `pen_create_boolean_op` *(new v2.0)* | Combine children with union/intersect/subtract/exclude | §1.12 |

### Component & Instance (5 tools)

| Tool                                | Purpose                              | Section |
| ----------------------------------- | ------------------------------------ | ------- |
| `pen_create_component` *(new v2.0)* | Promote a node to a reusable Component | §2.1 |
| `pen_create_component_set` *(new v2.0)* | Group variants into a Component Set | §2.2 |
| `pen_create_instance` *(new v2.0)*  | Create an instance (`ref`) of a Component | §2.3 |
| `pen_set_component_property` *(new v2.0)* | Define a Component Property on a Component | §2.4 |
| `pen_detach_instance` *(new v2.0)*  | Detach an instance into a flat frame | §2.5    |

### Layout (8 tools)

| Tool                          | Purpose                                                | Section |
| ----------------------------- | ------------------------------------------------------ | ------- |
| `pen_set_autolayout`          | Apply Auto Layout (direction/padding/gap/alignment) to a frame | §3.1 |
| `pen_clear_autolayout`        | Remove Auto Layout from a frame (children retain positions) | §3.2 |
| `pen_set_sizing`              | Set width/height to fixed / fit_content / fill_container | §3.3 |
| `pen_set_constraints` *(new v2.0)* | Set horizontal/vertical constraints on a child | §3.4 |
| `pen_set_layout_position` *(new v2.0)* | Toggle `layoutPosition: 'auto' | 'absolute'` | §3.5 |
| `pen_set_grid_layout` *(new v2.0)* | Apply grid Auto Layout with rows/cols/gaps | §3.6 |
| `pen_set_overflow` *(new v2.0)* | Set `clip` / `overflow: scroll-x/scroll-y/scroll-both` | §3.7 |
| `pen_distribute`              | Distribute selection along an axis with even spacing  | §3.8    |

### Variables & Tokens (6 tools)

| Tool                          | Purpose                                                | Section |
| ----------------------------- | ------------------------------------------------------ | ------- |
| `pen_set_variable`            | Define or update a `$variable` (with optional theme-conditional values) | §4.1 |
| `pen_get_variable`            | Read a variable's resolved value for the active theme  | §4.2    |
| `pen_apply_palette`           | Bulk-apply a named palette as color variables          | §4.3    |
| `pen_bind_field_to_variable`  | Bind a node field (fill/stroke/width/…) to a `$variable` | §4.4    |
| `pen_unbind_field`            | Remove a variable binding (replaces with current resolved literal) | §4.5 |
| `pen_set_theme_axis` *(new v2.0)* | Declare a theme axis (e.g. `mode: [light, dark]`) | §4.6    |

### Styling (10 tools)

| Tool                          | Purpose                                                | Section |
| ----------------------------- | ------------------------------------------------------ | ------- |
| `pen_set_fill`                | Set the fill (solid/gradient/image) on a node          | §5.1    |
| `pen_clear_fill`              | Remove all fills from a node                           | §5.2    |
| `pen_set_stroke`              | Set stroke color/weight/alignment on a node            | §5.3    |
| `pen_clear_stroke`            | Remove stroke from a node                              | §5.4    |
| `pen_set_corner_radius`       | Set uniform or per-corner radius                       | §5.5    |
| `pen_set_corner_smoothing` *(new v2.0)* | Set iOS-squircle corner smoothing (0..1) | §5.6 |
| `pen_set_effect`              | Add an effect (shadow/blur/background_blur)            | §5.7    |
| `pen_clear_effects`           | Remove all effects from a node                         | §5.8    |
| `pen_set_blend_mode`          | Set blend mode on a node                               | §5.9    |
| `pen_set_opacity`             | Set node opacity (0..1)                                | §5.10   |

### Text (5 tools)

| Tool                          | Purpose                                                | Section |
| ----------------------------- | ------------------------------------------------------ | ------- |
| `pen_set_text_style`          | Set font family/size/weight/lineHeight/align on a text node | §6.1 |
| `pen_set_text_content`        | Replace the text content of a text node                | §6.2    |
| `pen_set_text_growth`         | Set textGrowth: auto / fixed-width / fixed-width-height | §6.3    |
| `pen_set_text_align`          | Set horizontal + vertical text alignment               | §6.4    |
| `pen_set_text_decoration`     | Set underline / strikethrough                          | §6.5    |

### Tree manipulation (8 tools)

| Tool                          | Purpose                                                | Section |
| ----------------------------- | ------------------------------------------------------ | ------- |
| `pen_update_node`             | Patch arbitrary properties on a node                   | §7.1    |
| `pen_update_many`             | Patch the same properties on many nodes                | §7.2    |
| `pen_delete_node`             | Remove a node (and its subtree) from the tree          | §7.3    |
| `pen_duplicate_node`          | Deep-clone a node with new IDs                         | §7.4    |
| `pen_move_node`               | Move a node to a new parent / position                 | §7.5    |
| `pen_set_zorder`              | Front / back / forward / backward within siblings      | §7.6    |
| `pen_group_nodes`             | Wrap multiple nodes in a new frame or group            | §7.7    |
| `pen_ungroup_node`            | Dissolve a frame/group; lift children to parent        | §7.8    |

### Selection & viewport (3 tools)

| Tool                          | Purpose                                                | Section |
| ----------------------------- | ------------------------------------------------------ | ------- |
| `pen_select`                  | Set the active selection                                | §8.1    |
| `pan_viewport`                | Pan the canvas viewport (runtime-only; not in .pen)    | §8.2    |
| `zoom_viewport`               | Zoom the canvas viewport (runtime-only; not in .pen)   | §8.3    |

### Generation (5 tools)

| Tool                          | Purpose                                                | Section |
| ----------------------------- | ------------------------------------------------------ | ------- |
| `pen_generate_wireframe`      | Generate a mobile or web wireframe from a description  | §9.1    |
| `pen_generate_user_flow`      | Generate a multi-screen user flow                      | §9.2    |
| `pen_generate_flowchart`      | Generate a flowchart from a process description        | §9.3    |
| `pen_generate_mindmap`        | Generate a mindmap from a topic                        | §9.4    |
| `pen_generate_palette`        | Generate a color palette from a description            | §9.5    |

### Mask & clip *(new v2.0)* (2 tools)

| Tool                          | Purpose                                                | Section |
| ----------------------------- | ------------------------------------------------------ | ------- |
| `pen_set_mask`                | Mark a node as a mask (alpha/vector/luminance)         | §10.1   |
| `pen_clear_mask`              | Remove mask from a node                                | §10.2   |

### Export (3 tools)

| Tool                          | Purpose                                                | Section |
| ----------------------------- | ------------------------------------------------------ | ------- |
| `pen_export_svg`              | Export the selection (or whole doc) as SVG             | §11.1   |
| `pen_export_png`              | Export as PNG                                           | §11.2   |
| `pen_export_json`             | Export the .pen file (round-trippable)                 | §11.3   |

### Code generation (3 tools)

| Tool                          | Purpose                                                | Section |
| ----------------------------- | ------------------------------------------------------ | ------- |
| `pen_copy_as_html`            | Generate HTML+CSS from the selection                   | §12.1   |
| `pen_copy_as_react`           | Generate React (TSX) from the selection                | §12.2   |
| `pen_copy_as_tailwind`        | Generate Tailwind-styled HTML from the selection       | §12.3   |

### Analysis (3 tools)

| Tool                          | Purpose                                                | Section |
| ----------------------------- | ------------------------------------------------------ | ------- |
| `pen_audit_design`            | Audit the canvas (color contrast, alignment, type scale) | §13.1 |
| `pen_generate_copy`           | Generate placeholder or marketing copy for text nodes  | §13.2   |
| `pen_inspect_canvas`          | Return a textual snapshot of the canvas for the LLM    | §13.3   |

---

## §1 Shape creation

### 1.1 `pen_create_shape`

Create a primitive shape.

**Args**

```ts
{
  type: 'rectangle' | 'ellipse' | 'polygon';
  parent?: string;            // parent node ID; default = root
  name?: string;              // display name
  x: number;
  y: number;
  width: number;
  height: number;
  fill?: string;              // hex color or $var
  stroke?: string;
  strokeWidth?: number;
  cornerRadius?: number | [number, number, number, number];
  rotation?: number;
  opacity?: number;
}
```

**Example**

```json
{
  "type": "rectangle",
  "parent": "root",
  "name": "Card",
  "x": 100, "y": 100, "width": 320, "height": 200,
  "fill": "$surface.card",
  "cornerRadius": [12, 12, 12, 12],
  "stroke": "$border.subtle",
  "strokeWidth": 1
}
```

### 1.2 `pen_create_text`

**Args**

```ts
{
  parent?: string;
  name?: string;
  x: number; y: number;
  width?: number; height?: number;     // required if textGrowth != 'auto'
  content: string;
  textGrowth?: 'auto' | 'fixed-width' | 'fixed-width-height';
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string | number;
  fontStyle?: string;
  lineHeight?: number;
  letterSpacing?: number;
  textAlign?: 'left' | 'center' | 'right' | 'justify';
  fill?: string;                       // text color
}
```

**Example**

```json
{
  "parent": "card",
  "x": 16, "y": 16,
  "content": "Welcome back, Ada",
  "fontSize": 24,
  "fontWeight": 600,
  "fill": "$text.heading"
}
```

### 1.3 `pen_create_frame`

**Args**

```ts
{
  parent?: string;
  name?: string;
  x?: number; y?: number;
  width?: number | 'fit_content' | 'fill_container';
  height?: number | 'fit_content' | 'fill_container';
  layout?: 'none' | 'horizontal' | 'vertical' | 'grid';
  padding?: number | [number, number] | [number, number, number, number];
  gap?: number;
  justifyContent?: 'start' | 'center' | 'end' | 'space_between' | 'space_around';
  alignItems?: 'start' | 'center' | 'end';
  fill?: string;
  cornerRadius?: number | [number, number, number, number];
  clip?: boolean;
  children?: Array<Partial<PenChild>>;   // initial children
}
```

### 1.4 `pen_create_group`

Wrap existing nodes in a `group` (non-layout container).

**Args**: `{ nodeIds: string[]; name?: string; parent?: string }`

### 1.5 `pen_create_path`

**Args**: `{ parent?; name?; x; y; width; height; geometry: string; viewBox?: [n,n,n,n]; fill?; stroke?; strokeWidth?; fillRule?: 'nonzero'|'evenodd' }`

`geometry` is SVG path data (`"M 0 0 L 100 0 L 100 100 Z"`).

### 1.6 `pen_create_polygon`

**Args**: `{ parent?; name?; x; y; width; height; polygonCount?: number; cornerRadius?: number; fill?; stroke?; strokeWidth? }`

### 1.7 `pen_create_star` *(v2.1)*

**Args**: `{ parent?; name?; x; y; width; height; pointCount?: number; innerRadius?: number; fill?; stroke?; strokeWidth? }`

### 1.8 `pen_create_line`

**Args**: `{ parent?; name?; x1; y1; x2; y2; stroke?; strokeWidth?; strokeLinecap?: 'butt'|'round'|'square' }`

Internally creates a 2-point `PenPath`.

### 1.9 `pen_create_image`

**Args**: `{ parent?; name?; x; y; width; height; url: string; mode?: 'stretch'|'fill'|'fit'; opacity?: number }`

Creates a `PenFrame` with `{ fill: { type: 'image', url, mode } }`.

### 1.10 `pen_create_note`

**Args**: `{ parent?; name?; x; y; width?: number; height?: number; content: string; fill?: string; fontSize?: number }`

### 1.11 `pen_create_icon`

**Args**: `{ parent?; name?; x; y; width; height; library?: 'lucide'|'feather'|'Material Symbols Outlined'|'Material Symbols Rounded'|'Material Symbols Sharp'|'phosphor'; icon: string; weight?: number; fill?: string }`

### 1.12 `pen_create_boolean_op` *(new v2.0)*

Combine existing nodes (or new children) using a set operation.

**Args**

```ts
{
  parent?: string;
  name?: string;
  operation: 'union' | 'intersect' | 'subtract' | 'exclude';
  childIds: string[];         // existing nodes to combine (will be re-parented)
  // OR
  children?: Array<Partial<PenChild>>;  // new children
}
```

**Example**

```json
{
  "operation": "subtract",
  "childIds": ["rect-bg", "circle-hole"],
  "name": "Donut"
}
```

---

## §2 Components & Instances

### 2.1 `pen_create_component` *(new v2.0)*

Promote an existing node (typically a frame) to a Component.

**Args**: `{ nodeId: string }`

Sets `reusable: true` on the node.

### 2.2 `pen_create_component_set` *(new v2.0)*

Wrap multiple Components into a Component Set.

**Args**

```ts
{
  componentIds: string[];
  name?: string;
  parent?: string;
  variantAxes?: { [axisName: string]: string[] };   // e.g. { state: ['default', 'hover', 'disabled'] }
}
```

Each component's `metadata.variantProperties` is set to its current
variant values; you can update these via `pen_update_node`.

### 2.3 `pen_create_instance` *(new v2.0)*

Create an instance of a Component.

**Args**

```ts
{
  componentId: string;
  parent?: string;
  name?: string;
  x?: number; y?: number;
  width?: number; height?: number;
  overrides?: { [descendantIdPath: string]: Partial<PenChild> };
  variantValues?: { [axisName: string]: string };
}
```

**Example**

```json
{
  "componentId": "button-primary",
  "x": 100, "y": 100,
  "variantValues": { "size": "md", "state": "default" },
  "overrides": {
    "label": { "content": "Save" }
  }
}
```

### 2.4 `pen_set_component_property` *(new v2.0)*

Define or update a Component Property on a Component.

**Args**

```ts
{
  componentId: string;
  name: string;                // property name (e.g. "showIcon")
  type: 'boolean' | 'string' | 'variant' | 'instance_swap';
  defaultValue: boolean | string;
  variantOptions?: string[];   // only for type: 'variant'
  preferredValues?: Array<{ type: 'COMPONENT' | 'COMPONENT_SET'; key: string }>;  // only for 'instance_swap'
}
```

### 2.5 `pen_detach_instance` *(new v2.0)*

Convert an instance (`PenRef`) into a flat `PenFrame` with the same
content. Severes the link to the Component.

**Args**: `{ instanceId: string }`

The detached frame inherits all current overrides + the Component's
definition. Future Component updates will NOT propagate.

---

## §3 Layout

### 3.1 `pen_set_autolayout`

**Args**

```ts
{
  nodeId: string;
  direction: 'horizontal' | 'vertical';
  gap?: number;
  padding?: number | [number, number] | [number, number, number, number];
  justifyContent?: 'start' | 'center' | 'end' | 'space_between' | 'space_around';
  alignItems?: 'start' | 'center' | 'end';
  layoutIncludeStroke?: boolean;
}
```

### 3.2 `pen_clear_autolayout`

**Args**: `{ nodeId: string }`

Sets `layout: 'none'`. Children retain their positions.

### 3.3 `pen_set_sizing`

**Args**

```ts
{
  nodeId: string;
  width?: number | 'fit_content' | 'fill_container';
  height?: number | 'fit_content' | 'fill_container';
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
}
```

### 3.4 `pen_set_constraints` *(new v2.0)*

**Args**

```ts
{
  nodeId: string;
  horizontal: 'left' | 'right' | 'center' | 'left_right' | 'scale';
  vertical: 'top' | 'bottom' | 'center' | 'top_bottom' | 'scale';
}
```

### 3.5 `pen_set_layout_position` *(new v2.0)*

**Args**: `{ nodeId: string; position: 'auto' | 'absolute' }`

### 3.6 `pen_set_grid_layout` *(new v2.0)*

**Args**

```ts
{
  nodeId: string;
  rows?: number;
  columns?: number;
  rowGap?: number;
  columnGap?: number;
  columnsSizing?: string;   // CSS grid-template-columns
  rowsSizing?: string;      // CSS grid-template-rows
}
```

Sets `layout: 'grid'` on the frame and stores grid config in `metadata.gridLayout`.

### 3.7 `pen_set_overflow` *(new v2.0)*

**Args**: `{ nodeId: string; overflow: 'hidden' | 'scroll-x' | 'scroll-y' | 'scroll-both' }`

Sets `clip: true` when overflow != 'hidden', and stores the overflow
mode in `metadata.overflow`.

### 3.8 `pen_distribute`

**Args**: `{ nodeIds: string[]; axis: 'horizontal' | 'vertical'; spacing?: number }`

---

## §4 Variables & Tokens

### 4.1 `pen_set_variable`

**Args**

```ts
{
  key: string;                          // e.g. "brand.primary"
  type: 'color' | 'number' | 'string' | 'boolean';
  value: string | number | boolean
       | Array<{ value: string | number | boolean; theme?: PenTheme }>;
}
```

### 4.2 `pen_get_variable`

**Args**: `{ key: string; theme?: PenTheme }`

Returns the resolved value for the given theme (or the document's
active theme if omitted).

### 4.3 `pen_apply_palette`

Bulk-define a palette of color variables.

**Args**

```ts
{
  prefix?: string;                      // e.g. "brand" → keys become "brand.primary", etc.
  colors: Array<{ name: string; value: string }>;
}
```

### 4.4 `pen_bind_field_to_variable`

**Args**: `{ nodeId: string; field: 'fill' | 'stroke' | 'width' | 'height' | 'cornerRadius' | 'fontSize' | 'opacity' | 'strokeWidth'; variableKey: string }`

### 4.5 `pen_unbind_field`

**Args**: `{ nodeId: string; field: string }`

Replaces the variable reference with the current resolved literal value.

### 4.6 `pen_set_theme_axis` *(new v2.0)*

Declare or extend a theme axis.

**Args**: `{ axis: string; values: string[] }`

Example: `{ "axis": "mode", "values": ["light", "dark"] }`.

---

## §5 Styling

### 5.1 `pen_set_fill`

**Args**

```ts
{
  nodeId: string;
  fill: string | PenFill | PenFill[];   // hex, $var, or structured fill
}
```

### 5.2 `pen_clear_fill`

**Args**: `{ nodeId: string }`

### 5.3 `pen_set_stroke`

**Args**

```ts
{
  nodeId: string;
  stroke: string | PenFill;
  strokeWidth?: number | { top?; right?; bottom?; left? };
  strokeAlignment?: 'inner' | 'center' | 'outer';
  strokeLinejoin?: 'miter' | 'bevel' | 'round';
  strokeLinecap?: 'butt' | 'round' | 'square';
  strokeDashes?: number[];
  strokeMiterLimit?: number;
}
```

### 5.4 `pen_clear_stroke`

**Args**: `{ nodeId: string }`

### 5.5 `pen_set_corner_radius`

**Args**: `{ nodeId: string; radius: number | [number, number, number, number] }`

### 5.6 `pen_set_corner_smoothing` *(new v2.0)*

**Args**: `{ nodeId: string; smoothing: number }` (0..1, 0.6 ≈ iOS squircle)

### 5.7 `pen_set_effect`

**Args**: `{ nodeId: string; effect: PenEffect }`

Example:
```json
{ "nodeId": "card", "effect": { "type": "shadow", "shadowType": "outer", "offset": {"x":0,"y":4}, "blur": 12, "spread": 0, "color": "#0000001a" } }
```

### 5.8 `pen_clear_effects`

**Args**: `{ nodeId: string }`

### 5.9 `pen_set_blend_mode`

**Args**: `{ nodeId: string; blendMode: PenBlendMode }`

### 5.10 `pen_set_opacity`

**Args**: `{ nodeId: string; opacity: number }` (0..1)

---

## §6 Text

### 6.1 `pen_set_text_style`

**Args**

```ts
{
  nodeId: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string | number;
  fontStyle?: string;
  lineHeight?: number;
  letterSpacing?: number;
  textAlign?: 'left' | 'center' | 'right' | 'justify';
  textAlignVertical?: 'top' | 'middle' | 'bottom';
}
```

### 6.2 `pen_set_text_content`

**Args**: `{ nodeId: string; content: string }`

### 6.3 `pen_set_text_growth`

**Args**: `{ nodeId: string; growth: 'auto' | 'fixed-width' | 'fixed-width-height' }`

### 6.4 `pen_set_text_align`

**Args**: `{ nodeId: string; horizontal?: 'left'|'center'|'right'|'justify'; vertical?: 'top'|'middle'|'bottom' }`

### 6.5 `pen_set_text_decoration`

**Args**: `{ nodeId: string; underline?: boolean; strikethrough?: boolean }`

---

## §7 Tree manipulation

### 7.1 `pen_update_node`

**Args**: `{ nodeId: string; changes: Partial<PenChild> }`

### 7.2 `pen_update_many`

**Args**: `{ updates: Array<{ id: string; changes: Partial<PenChild> }> }`

### 7.3 `pen_delete_node`

**Args**: `{ nodeId: string }`

### 7.4 `pen_duplicate_node`

**Args**: `{ nodeId: string; newName?: string; offset?: { x: number; y: number } }`

### 7.5 `pen_move_node`

**Args**: `{ nodeId: string; newParentId: string; index?: number }`

### 7.6 `pen_set_zorder`

**Args**: `{ nodeId: string; kind: 'front' | 'back' | 'forward' | 'backward' }`

### 7.7 `pen_group_nodes`

**Args**: `{ nodeIds: string[]; name?: string; containerType?: 'frame' | 'group' }`

### 7.8 `pen_ungroup_node`

**Args**: `{ nodeId: string }`

---

## §8 Selection & viewport

### 8.1 `pen_select`

**Args**: `{ nodeIds: string[] }`

### 8.2 `pan_viewport`

**Args**: `{ panX: number; panY: number }`

### 8.3 `zoom_viewport`

**Args**: `{ zoom: number; focusX?: number; focusY?: number }`

---

## §9 Generation

### 9.1 `pen_generate_wireframe`

**Args**: `{ description: string; target: 'mobile' | 'web' | 'desktop'; parent?: string }`

### 9.2 `pen_generate_user_flow`

**Args**: `{ description: string; screens: string[]; parent?: string }`

### 9.3 `pen_generate_flowchart`

**Args**: `{ description: string; parent?: string }`

### 9.4 `pen_generate_mindmap`

**Args**: `{ topic: string; parent?: string }`

### 9.5 `pen_generate_palette`

**Args**: `{ description: string; prefix?: string; count?: number }`

---

## §10 Mask & clip

### 10.1 `pen_set_mask` *(new v2.0)*

**Args**: `{ nodeId: string; maskType: 'alpha' | 'vector' | 'luminance' }`

### 10.2 `pen_clear_mask` *(new v2.0)*

**Args**: `{ nodeId: string }`

---

## §11 Export

### 11.1 `pen_export_svg`

**Args**: `{ nodeId?: string; width?: number; height?: number }` (nodeId omitted → whole doc)

### 11.2 `pen_export_png`

**Args**: `{ nodeId?: string; width?: number; height?: number; scale?: number }`

### 11.3 `pen_export_json`

**Args**: `{ nodeId?: string; pretty?: boolean }`

---

## §12 Code generation

### 12.1 `pen_copy_as_html`

**Args**: `{ nodeId: string; responsive?: boolean }`

### 12.2 `pen_copy_as_react`

**Args**: `{ nodeId: string; componentName?: string; styledWith?: 'css' | 'tailwind' | 'styled-components' }`

### 12.3 `pen_copy_as_tailwind`

**Args**: `{ nodeId: string; responsive?: boolean }`

---

## §13 Analysis

### 13.1 `pen_audit_design`

**Args**: `{ nodeId?: string; checks?: Array<'contrast' | 'alignment' | 'type-scale' | 'color-balance'> }`

### 13.2 `pen_generate_copy`

**Args**: `{ nodeId: string; tone?: 'professional' | 'casual' | 'marketing' | 'technical' }`

### 13.3 `pen_inspect_canvas`

**Args**: `{ nodeId?: string; depth?: number }` — returns a textual snapshot for the LLM.

---

## Tool calling conventions

### Argument validation

Every tool's args are validated at runtime by `executeTool()` in
`src/lib/agent/tools.ts` against the tool's Zod schema. Invalid args
return a structured error to the LLM (not an exception), so the agent
can self-correct on the next turn.

### Return shape

```ts
type ToolResult = {
  ok: true;
  summary: string;          // human/LLM-readable summary
  data?: unknown;           // optional structured payload
  patches?: CanvasPatch[];  // optional patches to apply to the canvas
} | {
  ok: false;
  error: string;            // human/LLM-readable error
  retryable: boolean;       // true if the agent can retry with different args
};
```

### Patch emission

Most tools emit `CanvasPatch[]` rather than mutating the canvas
directly. This keeps the mutation path single-threaded (via the patch
applier) and makes every tool call replayable for undo/redo.

### Naming conventions

- All tools start with `pen_` (except viewport tools `pan_viewport` /
  `zoom_viewport` which are runtime-only).
- Tool names use `snake_case`.
- Argument names use `camelCase` to match .pen's TypeScript naming.
- New v2.0 tools are flagged in this doc; the runtime treats all
  tools the same.

### Tool count

- v1.x: 50 tools
- v2.0: +12 new tools = 62 total

### Adding a new tool

1. Add the Zod schema + executor to `src/lib/agent/tools.ts`.
2. Add an entry to this document.
3. Add a unit test to `tests/unit/tools.test.ts`.
4. If the tool emits a new patch op, add it to `CanvasPatch` in
   `src/lib/canvas/types.ts` and to the patch applier in
   `src/lib/canvas/patch.ts`.
5. Update the system prompt in `src/lib/agent/runner.ts` to mention
   the new tool (auto-generated from this catalog in v2.x).
