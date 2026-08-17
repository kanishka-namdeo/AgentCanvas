# Glossary — AgentCanvas / Figma / .pen Terminology

> Plain-language definitions of every term used in the AgentCanvas codebase.
> Terms are grouped by domain. Cross-references are written as
> *→ see also: Term*. When a term has different names in Figma vs. .pen,
> both are listed.

---

## A

### Absolute positioning
A layout mode where a child node's `x` and `y` are set manually relative
to its parent, ignoring the parent's Auto Layout. In Figma this is
`layoutPositioning: "ABSOLUTE"`; in .pen it is `layoutPosition: 'absolute'`.
*→ see also: Auto Layout, Constraints.*

### Affine transform
A 2D transformation that preserves straight lines and parallelism —
translation, rotation, scale, skew. Figma represents it as the top two
rows of a 3×3 matrix (`[[a,b,tx],[c,d,ty]]`); .pen represents it
compositionally as `{ x, y, rotation, flipX, flipY }`.

### Align items
The cross-axis alignment of an Auto Layout frame's children. Figma
enum: `MIN | CENTER | MAX | BASELINE`. .pen: `start | center | end`.
*→ see also: Justify content, Auto Layout.*

### Alpha mask
A mask whose alpha channel determines the visibility of masked pixels.
Figma `maskType: "ALPHA"`. *→ see also: Mask, Vector mask, Luminance mask.*

### Annotations
Author notes attached to a node. Surfaced via the `AnnotationsTrait` in
Figma and via `metadata.annotations` in .pen. Read-only in our agent
runtime today.

### Arc data
Ellipse-specific property that turns a full circle into a partial arc.
Carried by `PenEllipse.startAngle` / `PenEllipse.sweepAngle` (degrees
CCW) and Figma's `ArcData` object.

### Auto Layout
Figma's flexbox-like layout engine for frames. Configurable per-frame:
direction (HORIZONTAL / VERTICAL / GRID), padding, gap, alignment,
sizing mode. .pen's `PenLayout` mirrors this with `layout`, `gap`,
`padding`, `justifyContent`, `alignItems`. *→ see also: Frame, Hug, Fill.*

---

## B

### Background blur
A blur effect applied to everything *behind* a node — used for frosted-glass
UI. Figma `BlurEffect` with `type: "BACKGROUND_BLUR"`; .pen
`PenEffect` with `type: 'background_blur'`.

### Base component
*Synonym for Main Component.* The original definition of a Component
that Instances reference. *→ see also: Component, Instance.*

### Boolean operation
A node that combines its children's geometry using set operations:
`UNION`, `INTERSECT`, `SUBTRACT`, `EXCLUDE`. Figma: `BooleanOperationNode`.
.pen: `PenBooleanOp` (new in v2.0). The result is non-destructive — the
original children remain editable. *→ see also: Vector, Path.*

### Boolean property
A Component Property of type `BOOLEAN` — exposes a toggle (e.g. "Show
icon") that instances can flip. *→ see also: Component Property, Variant.*

### Bound variable
A field on a node whose value is supplied by a Variable alias rather
than a literal. Figma encodes this as `boundVariables: { fieldName: { type: 'VARIABLE_ALIAS', id } }`;
.pen encodes it as a `$variable-name` string in place of the literal
value. *→ see also: Variable, Variable alias.*

---

## C

### Canvas
The infinite 2D workspace that contains all nodes. In Figma a Canvas is
a `CanvasNode` (also called a Page); in .pen the top-level `children[]`
array IS the canvas. *→ see also: Page, Document.*

### Clip content
Whether a Frame clips paint outside its bounds. Figma `clipsContent: boolean`;
.pen `clip: boolean`. Critical for scrollable frames and Component
overflow.

### Code syntax
Platform-specific name for a Variable — e.g. the same color variable
might be `color.brand.primary` on web, `BrandPrimary` on iOS, and
`brand_primary` on Android. Encoded in `VariableCodeSyntax`.

### Collection (Variable Collection)
A group of related Variables that share the same set of Modes — e.g.
"Brand Colors" with `light` / `dark` modes. Figma `LocalVariableCollection`;
.pen `themes` axis with values.

### Component
A reusable node definition. Figma: `ComponentNode`. .pen: any node with
`reusable: true`. Components are the *source*; Instances are *references*
to them. *→ see also: Component Set, Instance, Main Component.*

### Component property
A typed slot exposed on a Component so instances can vary it without
detaching. Types: `BOOLEAN`, `TEXT`, `INSTANCE_SWAP`, `VARIANT`.
*→ see also: Component, Variant, Instance swap.*

### Component Set
A frame-like container that groups variant Components of the same
family — e.g. a Button component set with `State=Default` / `State=Hover`
/ `State=Disabled` variants. Figma: `ComponentSetNode`. .pen: a
`PenFrame` whose children are all `reusable: true` and tagged with
`metadata.variantProperties`.

### Constraint
How a child node resizes/repositions when its parent Frame resizes.
Independent horizontal and vertical enums: `LEFT | RIGHT | CENTER |
LEFT_RIGHT | SCALE` (horizontal) and `TOP | BOTTOM | CENTER |
TOP_BOTTOM | SCALE` (vertical). Only meaningful when the parent has
`layoutMode: "NONE"` (i.e. not Auto Layout). In Auto Layout, the
equivalent is `layoutAlign` / `layoutGrow`.

### Corner radius
Rounding of a node's corners. Figma: uniform `cornerRadius` or
4-tuple `rectangleCornerRadii: [tl, tr, br, bl]`. .pen: uniform
`cornerRadius` or 4-tuple `[tl, tr, br, bl]`. *→ see also: Corner smoothing.*

### Corner smoothing
iOS-style "squircle" corner — a value between 0 (circular) and 1
(0.6 ≈ iOS 7 icon shape). Figma: `cornerSmoothing`. .pen v2.0:
`cornerSmoothing` (new).

---

## D

### Default mode
The Mode active on a Variable Collection when no override is supplied.
Figma: `LocalVariableCollection.defaultModeId`. .pen: first value in
each theme axis.

### Detach instance
Convert an Instance into a regular Frame with the same content —
severs the link to the main Component. Destructive in Figma; in .pen
this is `ref → frame` rewriting.

### Document
The top-level container — Figma file or .pen file. Holds Variables,
Themes, and the root `children[]` tree. *→ see also: Canvas, Page.*

### Drop shadow
An outer-shadow Effect. Figma: `DropShadowEffect`. .pen:
`PenEffect` with `type: 'shadow'`, `shadowType: 'outer'`.

---

## E

### Effect
A non-geometry visual modifier: shadow, layer blur, background blur.
Figma: `Effect` union. .pen: `PenEffect` union. *→ see also: Drop shadow, Inner shadow, Background blur.*

### Ellipse
A circle/ellipse node. Figma: `EllipseNode`. .pen: `PenEllipse`.
Supports arcs via `arcData` / `startAngle+sweepAngle`.

### Export setting
Per-node export configuration (format, scale, suffix). Figma:
`ExportSetting[]`. .pen: `metadata.exportSettings`.

---

## F

### Fill
A paint applied to a node's interior. Figma: array of `Paint`. .pen:
`PenFills` (single or array). A node can have multiple stacked fills.

### Frame
The primary container node in Figma — equivalent to a `<div>` with
optional Auto Layout. Figma: `FrameNode`. .pen: `PenFrame`. Holds
children, can clip, can have Auto Layout, can be a Component, can be
a Component Set.

---

## G

### Gradient
A paint that interpolates between colors along an axis. Figma:
`GradientPaint` with `gradientHandlePositions` (3 normalized vectors)
and `gradientStops[]`. .pen: `PenFill` with `type: 'gradient'`,
`gradientType`, `rotation`, `colors[]`. Subtypes: linear, radial,
angular, diamond.

### Grid (Auto Layout)
Figma's `layoutMode: "GRID"` — CSS-grid-like layout with
`gridRowCount`, `gridColumnCount`, `gridRowGap`, `gridColumnGap`,
`gridColumnsSizing` (CSS `grid-template-columns` string). Newer than
HORIZONTAL / VERTICAL Auto Layout. .pen v2.0: `layout: 'grid'` (new).

### Grid (layout guide)
Visual-only guides overlaid on a Frame — columns, rows, or square grid.
Figma: `LayoutGrid[]`. .pen: `metadata.layoutGrids`.

### Group
A lightweight container that bundles children without Auto Layout.
Figma: `GroupNode`. .pen: `PenGroup`. Children retain their own
positions; the Group's bbox is the union of children.

---

## H

### Hug
Auto Layout sizing mode where the frame's size is determined by its
children's combined size. Figma: `layoutSizingHorizontal: "HUG"`.
.pen: `width: 'fit_content'`. *→ see also: Fill, Fixed.*

---

## I

### Icon
A node that renders an icon from a named library (Lucide, Feather,
Material Symbols, Phosphor). .pen-specific (`PenIcon`); Figma models
icons as ordinary Vector nodes.

### Image paint
A fill that paints a raster image. Figma: `ImagePaint` with `scaleMode:
FILL | FIT | TILE | STRETCH` and `imageRef`. .pen: `PenFill` with
`type: 'image'`, `url`, `mode: 'stretch' | 'fill' | 'fit'`.

### Inner shadow
A shadow effect drawn inside a node's bounds. Figma: `InnerShadowEffect`.
.pen: `PenEffect` with `type: 'shadow'`, `shadowType: 'inner'`.

### Instance
A node that references a Component and inherits its definition.
Figma: `InstanceNode` with `componentId`, `componentProperties`,
`overrides`. .pen: `PenRef` with `ref: componentId` and optional
`descendants` overrides. *→ see also: Component, Detach instance,
Instance swap.*

### Instance swap
A Component Property of type `INSTANCE_SWAP` — lets an instance pick
which sub-component to slot in. `preferredValues[]` constrains the
choices.

---

## J

### Justify content
Main-axis alignment of an Auto Layout frame's children. Figma enum:
`MIN | CENTER | MAX | SPACE_BETWEEN`. .pen: `start | center | end |
space_between | space_around`.

---

## L

### Layer
Generic term for any node in the Layers panel — Frame, Component,
Vector, Text, etc. Not a distinct type; just user-facing vocabulary.

### Layout grid
*→ see Grid (layout guide).*

### Layout positioning
Whether a node participates in its parent's Auto Layout (`AUTO`) or
is absolutely positioned (`ABSOLUTE`). Figma: `layoutPositioning`.
.pen: `layoutPosition`.

### Line
A 1D vector node — defined by two endpoints. Figma: `LineNode`. .pen:
use `PenPath` with a 2-point `geometry` string.

### Linear gradient
A gradient along a straight axis. *→ see Gradient.*

### Local variable
A Variable defined in the current file (as opposed to a remote /
published Variable imported from a library). Figma: `LocalVariable`.
.pen: top-level `variables` map.

### Luminance mask
A mask whose per-pixel luminance determines visibility — useful for
soft, photographic masks. Figma: `maskType: "LUMINANCE"`.

---

## M

### Main component
*Synonym for Component.* The original definition that Instances
reference. *→ see also: Component, Instance, Detach instance.*

### Mask
A node that clips the visibility of its sibling nodes (and itself).
Figma: `isMask: true` plus `maskType: ALPHA | VECTOR | LUMINANCE`.
.pen v2.0: `metadata.mask = { type, nodeId }` (new).

### Mode
A named state within a Variable Collection — e.g. `light` / `dark`
for a "Theme" collection, or `compact` / `comfortable` for a "Density"
collection. Each Variable has a separate value per Mode. Figma:
`{ modeId, name }` in a collection's `modes[]`. .pen: theme axis
values (e.g. `{ mode: ['light', 'dark'] }`).

---

## N

### Note
A sticky-note-like text node. .pen-specific (`PenNote`); Figma uses
`StickyNode`. Renders with a colored background and a slightly tilted
appearance by convention.

---

## O

### Opacity
Per-node alpha. Range 0..1. Figma: `opacity`. .pen: `opacity`. Note
that individual fills and effects ALSO have their own opacity (in
Figma) or alpha channel (in .pen hex colors).

### Override
A property on an Instance that differs from its main Component.
Figma: `Overrides[]` array listing per-child `overriddenFields`. .pen:
`PenRef.descendants[idPath]` map.

---

## P

### Page
*Figma synonym for Canvas.* A Figma file has one or more Pages; each
Page is an infinite canvas. .pen is single-canvas (multi-page support
is on the v2.x roadmap).

### Paint
The union type of all fill/stroke kinds — solid, gradient, image,
pattern. Figma: `Paint`. .pen: `PenFill` (we drop pattern; add
shader / mesh_gradient).

### Path
A vector defined by SVG path data. Figma: `VectorNode` (with
sub-types like `Path` in the Plugin API) or `ShapePathNode`. .pen:
`PenPath` with `geometry` (SVG string) and `viewBox`.

### Pattern paint
A tile-based fill using another node's render as the tile. Figma:
`PatternPaint`. .pen: not yet supported (planned: `type: 'pattern'`).

### Polygon
A regular N-sided shape. Figma: `RegularPolygonNode`. .pen:
`PenPolygon` with `polygonCount`.

### Published variable
A Variable that has been published to a Team Library and can be
subscribed by other files. Figma: `PublishedVariable`. .pen: lives
in a `.lib.pen` file referenced via `imports`.

---

## R

### Radial gradient
A gradient radiating from a center point outward. *→ see Gradient.*

### Rectangle
The most basic shape node. Figma: `RectangleNode`. .pen: `PenRectangle`.
Supports per-corner radii.

### Ref
.pen's term for an Instance — a node that references another
`reusable: true` node by ID. *→ see Component, Instance.*

### Reusable
.pen's flag on a node that marks it as a Component definition (i.e.
instances can `ref` it). Figma: implicit on `ComponentNode`.

---

## S

### Scale mode (image)
How an image fill is fit to the node: `FILL` (cover), `FIT` (contain),
`TILE` (repeat), `STRETCH` (distort). Figma and .pen share the same
enum (modulo casing).

### Section
A grouping node for organizing the canvas — like a labeled Frame
without Auto Layout. Figma: `SectionNode`. .pen: a `PenFrame` with
`metadata.isSection = true`.

### Shadow
*→ see Drop shadow, Inner shadow.*

### Shape
Generic term for any non-container visual node — Rectangle, Ellipse,
Polygon, Line, Vector, Text, Star. In our codebase, `Shape` is the
*resolved render-node* type produced by `resolvePenTree()`.

### Slot
A Frame flagged as a "recommended component slot" — surfaces in the
UI as a hint for which Components fit there. .pen: `PenFrame.slot:
string[]` (recommended reusable IDs).

### Solid paint
A single-color fill. Figma: `SolidPaint` with `color: RGBA`. .pen:
`PenFill` with `type: 'color'` (or a bare hex string).

### Star
A star shape with N points and an inner/outer radius ratio. Figma:
`StarNode`. .pen: not yet supported (planned as `PenStar`).

### Stroke
A paint applied to a node's outline. Figma: array of `Paint` on
`strokes` + `strokeWeight`, `strokeAlign`, `strokeJoin`, `strokeCap`,
`strokeDashes`. .pen: `PenCanHaveStroke` with the same fields (camelCase).

### Style (published)
A named style published to a Team Library — color style, text style,
effect style, grid style. Figma: `PublishedStyle`. .pen: encoded as
a top-level `Variable` whose name follows the `style/*` namespace.

---

## T

### Text
A node that renders text. Figma: `TextNode` with `characters`,
`style: TypeStyle`, `characterStyleOverrides`, `styleOverrideTable`
(per-character formatting). .pen: `PenText` with `content: string`
and flat `PenTextStyle` (no per-character overrides yet).

### Text case
Text transformation: `ORIGINAL | UPPER | LOWER | TITLE | SMALL_CAPS |
SMALL_CAPS_FORCED`. Figma-only; .pen applies CSS `text-transform`.

### Text property
A Component Property of type `TEXT` — exposes a string slot on the
Component that instances can override (e.g. button label).

### Theme
A set of named axis/value pairs active on a node — e.g. `{ mode:
'dark', density: 'compact' }`. .pen first-class; Figma encodes the
equivalent via Mode + Collection bindings on the node's parent.

### Transform
A 2D affine matrix. Figma: `[[a,b,tx],[c,d,ty]]` (2×3). .pen:
decomposed `{ x, y, rotation, flipX, flipY }`.

### Transition
Prototyping behavior when navigating between frames. Figma:
`TransitionSourceTrait` (`transitionNodeID`, `transitionDuration`,
`transitionEasing`). .pen v2.x roadmap.

---

## V

### Variable
A named, typed, theme-conditional value that can be bound to any
compatible field on any node. Types: `BOOLEAN | FLOAT | STRING |
COLOR`. Figma: `LocalVariable`. .pen: top-level `variables[key]`.

### Variable alias
A reference from one variable (or a node field) to another variable.
Figma: `{ type: 'VARIABLE_ALIAS', id }`. .pen: a `$name` string in
place of a literal value.

### Variant
A Component inside a Component Set, distinguished by its variant
property values (e.g. `State=Default, Size=L`). Encoded as a
`VARIANT`-type Component Property on the parent Component Set.

### Vector
A node defined by SVG path geometry. Figma: `VectorNode`. .pen:
`PenPath`. *→ see Path, Boolean operation.*

### Vector mask
A mask whose fill regions determine visibility (vector regions are
fully visible; outside is fully transparent). Figma: `maskType:
"VECTOR"`.

### Viewport
The current pan/zoom state of the canvas. Runtime-only — not
persisted in the .pen file. .pen: stored in `CanvasDocument.viewport`.

### Visible
Whether a node is rendered. Figma: `visible: boolean`. .pen:
`enabled: boolean | $variable` (renamed to align with .pen's
conditional-eval semantics).

---

## W

### Washi tape
A decorative tape-style annotation in FigJam. Not supported in
AgentCanvas.

---

## Z

### Z-index
Stacking order. Figma: implicit by `children[]` order (first = bottom).
.pen: same — `children[]` order. The resolved `Shape.zIndex` field is
a derived depth-first counter for SVG rendering convenience.
