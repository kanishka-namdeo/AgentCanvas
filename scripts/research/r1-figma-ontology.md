# Figma File/Node Ontology & Data Model — Engineering Reference (R1)

> Research subagent: R1 (web research only). Compiled from Figma's official developer docs
> (developers.figma.com REST API + Plugin API, incl. the official `figma/rest-api-spec`
> OpenAPI/TypeScript types and `figma/plugin-typings`), Figma's Help Center articles, and the
> REST API changelog. All property names below use Figma's exact camelCase / SCREAMING_SNAKE
> spelling. Date of research: this session.

## Table of contents

1. [File / document hierarchy](#1-file--document-hierarchy)
2. [Node type taxonomy](#2-node-type-taxonomy)
3. [Global (every-node) properties](#3-global-every-node-properties)
4. [Geometry & transforms](#4-geometry--transforms)
5. [Visual properties (paint, strokes, effects, blend, corners, clipping)](#5-visual-properties)
6. [Auto Layout (Figma's flexbox)](#6-auto-layout)
7. [Constraints](#7-constraints)
8. [Text](#8-text)
9. [Components, instances, variants](#9-components-instances-variants)
10. [Variables](#10-variables)
11. [Pages & Sections](#11-pages--sections)
12. [Boolean operations & vector editing](#12-boolean-operations--vector-editing)
13. [Node IDs](#13-node-ids)
14. [REST ↔ Plugin API ↔ UI naming discrepancies](#14-naming-discrepancies)
15. [Sources](#15-sources)

---

## 1. File / document hierarchy

Every Figma file is a **tree of nodes**. Root of every file is a `DOCUMENT` node; its children
are `CANVAS` nodes (one per **page**). Each canvas node's children are top-level layers.

```
DOCUMENT
└── CANVAS (Page 1)
    ├── FRAME / GROUP / SECTION / INSTANCE / COMPONENT / ... (top-level layers)
    │   └── ... nested nodes ...
    └── ...
```

Source: https://developers.figma.com/docs/rest-api/files/ ("Every file in Figma consists of a
tree of nodes. At the root of every file is a DOCUMENT node, and from that node stems any
CANVAS nodes. Every canvas node represents a PAGE in a Figma file.")

### `GET /v1/files/:key` (whole file) — response shape

```jsonc
{
  "name": String,            // file name shown in editor
  "role": String,            // requester's role on the file
  "lastModified": String,    // UTC ISO 8601
  "editorType": "figma" | "figjam",
  "thumbnailUrl": String,
  "version": String,         // file version id; changes on modification
  "document": Node,          // the DOCUMENT node (root)
  "components": Map<String, Component>,      // node ID -> component metadata
  "componentSets": Map<String, ComponentSet>, // node ID -> component-set metadata
  "schemaVersion": 0,        // version of the file schema this file uses
  "styles": Map<String, Style>,              // style ID -> style metadata
  "linkAccess": String,      // inherit | view | edit | org_view | org_edit
  "mainFileKey": String,     // present if this file is a library
  "branches": [ { "key", "name", "thumbnail_url", "last_modified", "link_access" } ]
}
```

Query params: `version` (specific version id), `ids` (comma-separated node ids — returns those
subtrees **plus ancestor chains**; historically top-level canvases are always returned),
`depth` (1 = only pages, 2 = pages + top-level objects), `geometry=paths` (adds vector path
data, `relativeTransform`, `size`, `fillGeometry`, `strokeGeometry`), `plugin_data`, `branch_data`.

Notes:
- `schemaVersion` is "the version of the file schema that this file uses" (official TS types).
- `components` / `componentSets` maps exist to resolve where an INSTANCE came from
  (`INSTANCE.componentId` refers to these maps).
- Each node may also carry `pluginData` / `sharedPluginData` if requested.

### `GET /v1/files/:key/nodes?ids=1:2,1:3` (subset of nodes)

Response wraps **each requested node id** in its own mini-"result":

```jsonc
{
  "name": String, "role": String, "lastModified": String,
  "editorType": String, "thumbnailUrl": String, "err": String,
  "nodes": {
    "1:2": {
      "document": Node,          // the node (and its subtree)
      "components": Map<String, Component>,
      "componentSets": Map<String, ComponentSet>,
      "schemaVersion": 0,
      "styles": Map<String, Style>
    }
  }
}
```

Caveats (documented): the `nodes` map may contain `null` values (id not found); `depth`
behaves relative to the requested nodes; geometry only returned with `geometry=paths`.
Also `GET /v1/files/:key/images` returns the mapping `imageRef -> image URL` for IMAGE paints
(image fills are how Figma represents user-supplied images; images expire after ≤ 14 days;
rendered node images via `GET /v1/images/:key?ids=...` expire after 30 days).

Published-library metadata endpoints (separate from file content):
- `GET /v1/files/:file_key/components`, `GET /v1/teams/:team_id/components`,
  `GET /v1/components/:key`, and the matching `component_sets` endpoints (component set key,
  node_id, containing_frame, etc.).

Plugin API equivalents: `figma.root` (DocumentNode) → `root.children` (PageNode[]); pages
have `children` (SceneNode[]).

---

## 2. Node type taxonomy

REST API node `type` strings (from https://developers.figma.com/docs/rest-api/file-node-types
and official `dist/api_types.ts` in github.com/figma/rest-api-spec). The Plugin API uses the
same strings **except** the discrepancies called out in §14 (CANVAS vs PAGE, REGULAR_POLYGON
vs POLYGON).

| REST `type` | Plugin API class | Purpose (one line) | Domain |
|---|---|---|---|
| `DOCUMENT` | DocumentNode | Root of the file; children are canvases (pages). | All |
| `CANVAS` | PageNode (`type: 'PAGE'`) | A page in the file; top-level layer container. | All |
| `FRAME` | FrameNode | Design frame: bounds container, clips contents, may host auto layout / grid / constraints / prototype device. | Design |
| `GROUP` | GroupNode | Pure visual grouping; bounds derived from children (inherits FRAME-ish props; has no own fills/background). | Design |
| `TRANSFORM_GROUP` | TransformGroupNode | Beta group representing a node transform (e.g. repeat/radial repeats); FRAME props + `transformModifiers`. | Design (beta) |
| `SECTION` | SectionNode | Top-level labeled region on canvas for organization, ready-for-dev status, prototype flows. | Design + FigJam |
| `VECTOR` | VectorNode | Generic vector path geometry. | Design |
| `BOOLEAN_OPERATION` | BooleanOperationNode | Non-destructive union/intersect/subtract/exclude of child shapes. | Design |
| `STAR` | StarNode | Star shape (VECTOR properties). | Design |
| `LINE` | LineNode | Single open line (VECTOR properties). | Design |
| `ELLIPSE` | EllipseNode | Ellipse/circle; adds `arcData` (start/end angle, inner radius). | Design |
| `REGULAR_POLYGON` | PolygonNode (`type: 'POLYGON'`) | n-sided polygon (VECTOR properties). | Design |
| `RECTANGLE` | RectangleNode | Rectangle; adds `cornerRadius`/`rectangleCornerRadii`/`cornerSmoothing`. | Design |
| `TABLE` | TableNode | FigJam table; children are TABLE_CELL (sorted row-then-column). | FigJam |
| `TABLE_CELL` | TableCellNode | FigJam table cell (has `characters` text sublayer). | FigJam |
| `TEXT` | TextNode | Text layer: `characters` + `style` (TypeStyle) + per-character overrides. | Design + FigJam |
| `TEXT_PATH` | TextPathNode | Beta: text on a vector path. | Design (beta) |
| `SLICE` | SliceNode | Export/asset slice region (exportSettings only). | Design |
| `COMPONENT` | ComponentNode | Main component definition (FRAME props + `componentPropertyDefinitions`). | Design |
| `COMPONENT_SET` | ComponentSetNode | Container of variants (FRAME props + `componentPropertyDefinitions`). | Design |
| `INSTANCE` | InstanceNode | A copy of a component; `componentId` + `componentProperties` + `overrides`. | Design |
| `STICKY` | StickyNode | FigJam sticky note (text + fills). | FigJam |
| `SHAPE_WITH_TEXT` | ShapeWithTextNode | FigJam flowchart shapes with embedded text (`shapeType` enum). | FigJam |
| `CONNECTOR` | ConnectorNode | FigJam connector line between nodes (`connectorStart`/`connectorEnd`, magnets, caps). | FigJam |
| `WASHI_TAPE` | WashiTapeNode | FigJam washi-tape decoration (VECTOR properties). | FigJam |
| `WIDGET` | WidgetNode | Third-party widget instance (`widgetId`, `widgetSyncedState`); FRAME-like traits in REST (`IsLayerTrait & HasExportSettingsTrait & HasChildrenTrait`). | Design + FigJam |
| `EMBED` | EmbedNode | Embedded external media (iframe-style). Present in official REST TS types (`type: 'EMBED'`). | Design + FigJam |
| `LINK_UNFURL` | LinkUnfurlNode | Auto-generated preview card for a pasted link (`type: 'LINK_UNFURL'` in REST TS types). | Design + FigJam |
| `MEDIA` | MediaNode | User-placed image/video media node (Plugin API; `mediaData`). **Not** in the current REST TS `Node` union. | Design + FigJam |
| `STAMP` | StampNode | Stamp placed via the Stamp Wheel; the `name` property distinguishes the stamp. **Not** in REST TS union. | Design + FigJam |
| `HIGHLIGHT` | HighlightNode | FigJam highlight marker. **Not** in REST TS union. | FigJam |
| `CODE_BLOCK` | CodeBlockNode | Code block node. Plugin API only (not in REST TS union). | Figma Make |
| `SLIDE` / `SLIDE_GRID` / `SLIDE_ROW` / `INTERACTIVE_SLIDE_ELEMENT` / `SLOT` | SlideNode / SlideGridNode / SlideRowNode / InteractiveSlideElementNode / SlotNode | Figma Slides deck/grid/row/interactive nodes and component "slot" placeholder. Plugin API only. | Slides / Design |

Plugin API `NodeType` union (exact, from developers.figma.com/docs/plugins/api/nodes):
`"BOOLEAN_OPERATION" | "CODE_BLOCK" | "COMPONENT" | "COMPONENT_SET" | "CONNECTOR" | "DOCUMENT" | "ELLIPSE" | "EMBED" | "FRAME" | "GROUP" | "HIGHLIGHT" | "INSTANCE" | "INTERACTIVE_SLIDE_ELEMENT" | "LINE" | "LINK_UNFURL" | "MEDIA" | "PAGE" | "POLYGON" | "RECTANGLE" | "SECTION" | "SHAPE_WITH_TEXT" | "SLICE" | "SLIDE" | "SLIDE_GRID" | "SLIDE_ROW" | "SLOT" | "STAMP" | "STAR" | "STICKY" | "TABLE" | "TABLE_CELL" | "TEXT" | "TEXT_PATH" | "TRANSFORM_GROUP" | "VECTOR" | "WASHI_TAPE" | "WIDGET"`.

REST `Node` union (official TS types): `BooleanOperationNode | ComponentNode | ComponentSetNode | ConnectorNode | EllipseNode | EmbedNode | FrameNode | GroupNode | InstanceNode | LineNode | LinkUnfurlNode | RectangleNode | RegularPolygonNode | SectionNode | ShapeWithTextNode | SliceNode | StarNode | StickyNode | TableNode | TableCellNode | TextNode | TextPathNode | TransformGroupNode | VectorNode | WashiTapeNode | WidgetNode | DocumentNode | CanvasNode`.

Note: sticky notes are **`STICKY`** (not `STICKY_NOTE`) in both current APIs.

---

## 3. Global (every-node) properties

From https://developers.figma.com/docs/rest-api/files/ (global properties on every node):

| Property | Type | Notes |
|---|---|---|
| `id` | String | Uniquely identifies the node within the document (see §13). |
| `name` | String | User-visible layer name. |
| `visible` | Boolean (default `true`) | Whether the node is rendered. |
| `type` | String | Node type enum (§2). |
| `rotation` | Number | "The rotation of the node, if not 0" (degrees; REST emits only when non-zero). |
| `pluginData` | Any | Data written by plugins (requires `plugin_data` param). |
| `sharedPluginData` | Any | Cross-plugin data (requires `plugin_data=shared`). |
| `componentPropertyReferences` | Map<String, String> | Layer property → component property name (on component/instance sublayers). |
| `boundVariables` | Map<String, VariableAlias \| VariableAlias[] \| Map<String, VariableAlias>> | Field → bound variable(s); §10. |
| `explicitVariableModes` | Map<String, String> | Variable collection ID → mode ID explicitly set on this node. |
| `locked` | Boolean (default `false`) | (also per-type) Layer is locked and cannot be edited. |
| `scrollBehavior` | `'SCROLLS' \| 'FIXED' \| 'STICKY_SCROLLS'` | How layer behaves when parent scrolls (official TS types). |
| `isFixed` | Boolean (deprecated) | Legacy of scroll behavior. |

Additional trait-shared REST fields: `absoluteBoundingBox` (Rectangle), `absoluteRenderBounds`
(Rectangle|null), `constraints` (LayoutConstraint), `preserveRatio` (deprecated), `exportSettings`
(ExportSetting[]), `blendMode`, `opacity`, `effects`, `relativeTransform` (only with
`geometry=paths`), `size` (only with `geometry=paths`), `styles` (style-type → style-id map),
`annotations` (max 1), `devStatus`, `interactions`, `isMask`/`maskType`, `layoutAlign`,
`layoutGrow`, `layoutPositioning`, `layoutSizingHorizontal` / `layoutSizingVertical`.

---

## 4. Geometry & transforms

- **`x`, `y`** (Plugin API, on all scene nodes): position relative to parent.
  `x === relativeTransform[0][2]`, `y === relativeTransform[1][2]`.
  The REST API does **not** return plain `x`/`y` on nodes — positions come from
  `absoluteBoundingBox` (always) or `relativeTransform` (with `geometry=paths`).
- **`width`, `height`** (Plugin API): node size. REST equivalent: `absoluteBoundingBox.width/height`
  (post-transform bounding box) or `size` (with `geometry=paths`).
- **`absoluteBoundingBox`** (Rectangle: `{x, y, width, height}`): bounding box in absolute
  page coordinates. Includes rotation effects (it's the axis-aligned box around the rotated node).
- **`absoluteRenderBounds`** (Rectangle|null): actual rendered bounds including drop shadows,
  thick strokes, etc.; `null` when node is invisible.
- **`relativeTransform`**: `Transform` = 2×3 affine matrix `[[m00, m01, tx], [m10, m11, ty]]`;
  bottom row implicitly `[0, 0, 1]`. Identity = `[[1,0,0],[0,1,0]]`.
  - Translation: `[[1,0,tx],[0,1,ty]]`. Rotation: `[[cos(angle), sin(angle), 0], [-sin(angle), cos(angle), 0]]`.
  - **Not used for scaling**: axes are unit vectors (`sqrt(m00²+m10²) == sqrt(m01²+m11²) == 1`);
    resize via `resize()`/`resizeWithoutConstraints()` instead. Skew is possible but not
    surfaced in the UI.
  - **Container-parent rule**: relativeTransform is relative to the nearest *container parent*
    (canvas/page, frame, component, instance) — **not** to an immediate GROUP or
    BOOLEAN_OPERATION parent, because groups/booleans derive their bounds from children.
    To get absolute position: multiply transforms up the chain, skipping groups/boolean
    operations, or use `absoluteTransform`.
  - For **children of auto-layout frames**, the translation components (`m02`, `m12`) are
    computed by the layout engine: setting `relativeTransform` on them ignores translation but
    keeps rotation.
  - REST: `relativeTransform` only present when `geometry=paths` is passed.
- **`rotation`** (degrees): Plugin API property on all rotatable nodes; range **−180…180**;
  `rotation === Math.atan2(-m10, m00)` of `relativeTransform`; setting it writes
  `m00, m01, m10, m11`. Rotation is **clockwise** in Figma's y-down coordinate system (the
  documented rotation matrix has `sin(angle)` at `m01` and `-sin(angle)` at `m10`). Rotation is
  about the node's **top-left corner**, independent of position; rotate about center via matrix
  composition. REST returns `rotation` in global node properties "if not 0".
- **`preserveRatio`** (deprecated) → replaced by `targetAspectRatio` (REST, frame) /
  `lockAspectRatio`/`unlockAspectRatio` (plugin).

---

## 5. Visual properties

### Fills & strokes (Paint objects)

`fills: Paint[]`, `strokes: Paint[]` (arrays; empty = none). Paint `type` enum:
`SOLID`, `GRADIENT_LINEAR`, `GRADIENT_RADIAL`, `GRADIENT_ANGULAR`, `GRADIENT_DIAMOND`,
`IMAGE`, `EMOJI`, `VIDEO`, `PATTERN` (PATTERN beta; EMOJI/VIDEO mostly FigJam/internal).

Common paint fields: `visible` (default true), `opacity` (0–1, default 1), `blendMode`.

- Solid: `color: {r,g,b,a}` (each channel 0–1), `boundVariables`.
- Gradients: `gradientHandlePositions: Vector[3]` (normalized object space: top-left (0,0),
  bottom-right (1,1); first = gradient start/0, second = end/1, third = width handle),
  `gradientStops: ColorStop[]` (`{position: 0..1, color, boundVariables}`).
- Image: `scaleMode: 'FILL' | 'FIT' | 'TILE' | 'STRETCH'`; `imageTransform` (only when
  `STRETCH`); `scalingFactor` (only when `TILE`); `rotation` (degrees); `imageRef` (string —
  resolve via `GET /v1/files/:key/images`); `gifRef`; `filters` (`exposure`, `contrast`,
  `saturation`, `temperature`, `tint`, `highlights`, `shadows`, each −1…1).
- Frames: fills replaced deprecated `background`/`backgroundColor` fields.

### Strokes

- `strokeWeight: Number`; `individualStrokeWeights: {top, right, bottom, left}` (only when
  individual weights are used).
- `strokeAlign: 'INSIDE' | 'OUTSIDE' | 'CENTER'`.
- `strokeDashes: Number[]` (e.g. `[1, 2]` = dash 1, gap 2, repeating).
- `strokeCap` (vector): `NONE | ROUND | SQUARE | LINE_ARROW | TRIANGLE_ARROW | DIAMOND_FILLED |
  CIRCLE_FILLED | TRIANGLE_FILLED | WASHI_TAPE_1..6`.
- `strokeJoin: 'MITER' | 'BEVEL' | 'ROUND'`; `strokeMiterAngle` (default 28.96°, MITER only).
- `complexStrokeProperties` (brush/dynamic strokes, 2026) + `variableWidthPoints`.

### Effects

`effects: Effect[]`; `type` enum: `INNER_SHADOW`, `DROP_SHADOW`, `LAYER_BLUR`,
`BACKGROUND_BLUR`, plus beta `TEXTURE` and `NOISE`. Fields: `visible`, `radius`,
`blendMode`, `boundVariables`; shadows add `color`, `offset {x,y}`, `spread` (default 0),
`showShadowBehindNode`; blur adds beta `blurType: NORMAL | PROGRESSIVE` (+ `startRadius`,
`startOffset`, `endOffset` for progressive).

### Visibility, opacity, blend

- `visible` (bool, default true) — per node; invisible nodes have `absoluteRenderBounds: null`.
- `opacity` (0–1, default 1) — multiplies with paint-level opacities.
- `blendMode` enum (REST & Plugin, identical): `PASS_THROUGH` (**only for objects with
  children** — i.e. frames/groups; it is the default for groups), `NORMAL`, `DARKEN`,
  `MULTIPLY`, `LINEAR_BURN` ("Plus darker"), `COLOR_BURN`, `LIGHTEN`, `SCREEN`,
  `LINEAR_DODGE` ("Plus lighter"), `COLOR_DODGE`, `OVERLAY`, `SOFT_LIGHT`, `HARD_LIGHT`,
  `DIFFERENCE`, `EXCLUSION`, `HUE`, `SATURATION`, `COLOR`, `LUMINOSITY`.

### Corners, clipping, masks

- `cornerRadius: Number` — single radius for all corners.
- `rectangleCornerRadii: Number[4]` — per-corner radii **starting top-left, clockwise**
  (TL, TR, BR, BL).
- `cornerSmoothing: 0..1` (0 = circular; 0.6 ≈ iOS-7 squircle).
- `clipsContent: Boolean` (frames) — whether children render outside frame bounds.
- `isMask: Boolean` + `maskType: 'ALPHA' | 'VECTOR' | 'LUMINANCE'` (masks apply to siblings
  in front of the mask node).

---

## 6. Auto Layout

### Frame properties (both REST and Plugin API)

| Property | Enum / type | Meaning |
|---|---|---|
| `layoutMode` | `NONE \| HORIZONTAL \| VERTICAL \| GRID` | Whether frame auto-layouts children (default `NONE`). |
| `itemSpacing` | Number | Gap between children along the flow axis (can be negative). |
| `counterAxisSpacing` | Number \| null | Gap between wrapped tracks (only when `layoutWrap: 'WRAP'`; must be positive). |
| `paddingLeft` / `paddingRight` / `paddingTop` / `paddingBottom` | Number | Frame padding per side. (`horizontalPadding`/`verticalPadding` deprecated.) |
| `primaryAxisAlignItems` | `MIN \| CENTER \| MAX \| SPACE_BETWEEN` | Child alignment along the primary axis. |
| `counterAxisAlignItems` | `MIN \| CENTER \| MAX \| BASELINE` | Child alignment along the counter axis (`BASELINE` = text baseline). |
| `counterAxisAlignContent` | `AUTO \| SPACE_BETWEEN` | Alignment of wrapped tracks (only `layoutWrap: 'WRAP'`). |
| `layoutWrap` | `NO_WRAP \| WRAP` | Wrap children to next line (UI: only offered for horizontal flows). |
| `primaryAxisSizingMode` *(legacy)* | `FIXED \| AUTO` | Primary axis: fixed length vs automatic ("hug") length. |
| `counterAxisSizingMode` *(legacy)* | `FIXED \| AUTO` | Counter axis: fixed vs automatic length. |
| `layoutSizingHorizontal` | `FIXED \| HUG \| FILL` | Newer model; see mapping below. |
| `layoutSizingVertical` | `FIXED \| HUG \| FILL` | Newer model; see mapping below. |
| `minWidth` / `maxWidth` / `minHeight` / `maxHeight` | Number \| null | Dimension clamps on frames and children. |
| `strokesIncludedInLayout` | Boolean | `true` = strokes count inside layout (CSS `box-sizing: border-box`). |
| `itemReverseZIndex` | Boolean | `true` = first layer drawn on top (reverse stacking). |
| `layoutGrids` | LayoutGrid[] | Layout grids (COLUMNS/ROWS/GRID + `sectionSize`, `gutterSize`, `offset`, `count`, `alignment` MIN/CENTER/STRETCH, `visible`, `color`, `boundVariables`). Not on GROUP. |
| `overflowDirection` | REST: `NONE \| HORIZONTAL_SCROLLING \| VERTICAL_SCROLLING \| HORIZONTAL_AND_VERTICAL_SCROLLING`; Plugin: `NONE \| HORIZONTAL \| VERTICAL \| BOTH` | Prototype scroll behavior. |
| `layoutPositioning` | `AUTO \| ABSOLUTE` | On **children** of auto-layout frames: `ABSOLUTE` ("Ignore auto layout", formerly "absolute position") removes the child from flow; it then supports constraints. |
| GRID-mode props | `gridRowCount`, `gridColumnCount`, `gridRowGap`, `gridColumnGap`, `gridColumnsSizing` (CSS grid-template-columns string), `gridRowsSizing`, `gridAutoTracks` (`NONE \| ROWS`), `gridItemsPositioning` (`MANUAL \| ROW_AUTO_FLOW`), and per-child `gridRowSpan`/`gridColumnSpan`/`gridColumnAnchorIndex`/`gridRowAnchorIndex`/`gridChildHorizontalAlign`/`gridChildVerticalAlign` (`AUTO \| MIN \| CENTER \| MAX`) | CSS-grid-like layout mode. |

### Child properties (children of auto-layout frames)

| Property | Meaning |
|---|---|
| `layoutGrow: 0 \| 1` | Stretch along parent's **primary** axis (0 = fixed, 1 = stretch). |
| `layoutAlign: 'MIN' \| 'CENTER' \| 'MAX' \| 'STRETCH' \| 'INHERIT'` | Alignment/stretch along parent's **counter** axis (`INHERIT` default; MIN/MAX map to top/bottom or left/right depending on flow direction). REST docs describe two eras: modern `INHERIT | STRETCH`, legacy `MIN | CENTER | MAX | STRETCH`. |
| `layoutSizingHorizontal` / `layoutSizingVertical` | Same enums as frames, but `FILL` is only valid on **children**, `HUG` only on auto-layout frames & text. |
| `layoutPositioning` | `AUTO` (in flow) vs `ABSOLUTE` (ignored by layout, constraints apply). |

### Legacy ↔ modern sizing model

`layoutSizingHorizontal/Vertical` is the modern shorthand that "maps directly to the
Horizontal/Vertical sizing dropdown in the Figma UI" and is defined as a shorthand for
`layoutGrow`, `layoutAlign`, `primaryAxisSizingMode`, `counterAxisSizingMode`
(Plugin API docs). Rough mapping:

| UI label | Modern property | Legacy equivalent (HORIZONTAL frame) |
|---|---|---|
| Fixed | `layoutSizingHorizontal: 'FIXED'` | `primaryAxisSizingMode: 'FIXED'` (axis = flow axis) / `counterAxisSizingMode: 'FIXED'` |
| Hug contents | `layoutSizing…: 'HUG'` | `primaryAxisSizingMode: 'AUTO'` on the frame (hug along flow axis); counter-axis hug = `counterAxisSizingMode: 'AUTO'` |
| Fill container | `layoutSizing…: 'FILL'` (children only) | `layoutGrow: 1` (fill along primary axis) or `layoutAlign: 'STRETCH'` (fill along counter axis) |

REST API changelog: `layoutSizingHorizontal/Vertical` read support added **Aug 9, 2023**.

### Semantics (from Figma help "Guide to auto layout")

- **Hug contents** — frame takes the smallest size around its children, respecting padding &
  spacing. Only valid on auto-layout frames (and text nodes). If any child is set to
  `Fill container`, the parent stops hugging on that axis and becomes `Fixed`.
- **Fill container** — child stretches to all available space on that axis in the parent
  frame, respecting spacing. Only valid on auto-layout **children**, never top-level frames.
  Manually resizing a child to the parent's full extent sets it to Fill.
- **Fixed** — dimension stays as set regardless of siblings/children. Manually typing a
  width/height on a hugging layer flips that axis to Fixed.
- **Wrap** (`layoutWrap: 'WRAP'`) — overflowing children flow to the next line; track spacing
  via `counterAxisSpacing`; tracks aligned via `counterAxisAlignContent`.
- **Min/max dimensions** — independent clamps usable with any sizing mode (`minWidth`,
  `maxWidth`, `minHeight`, `maxHeight`; REST returns `null` if unset).
- **Ignore auto layout** (`layoutPositioning: 'ABSOLUTE'`) — child excluded from flow, treated
  like a child of a regular frame; constraints apply; sizing/layoutAlign not applicable.
- **Auto-layout children's `absoluteBoundingBox`** — REST returns computed bounds for children
  of auto-layout frames (layout engine output); the translation components of a child's
  `relativeTransform` are ignored when set (rotation kept).

---

## 7. Constraints

Apply to **non-auto-layout children of frames** (not to layers outside frames, not to children
of auto-layout frames — except children set to `layoutPositioning: 'ABSOLUTE'`; not to groups
as a whole — Figma applies them to the individual layers inside the group).

### REST API (`LayoutConstraint`)

```ts
{
  horizontal: 'LEFT' | 'RIGHT' | 'CENTER' | 'LEFT_RIGHT' | 'SCALE',
  vertical:   'TOP' | 'BOTTOM' | 'CENTER' | 'TOP_BOTTOM' | 'SCALE'
}
```

### Plugin API (`Constraints` / `ConstraintType`)

```ts
{
  horizontal: 'MIN' | 'CENTER' | 'MAX' | 'STRETCH' | 'SCALE',
  vertical:   'MIN' | 'CENTER' | 'MAX' | 'STRETCH' | 'SCALE'
}
// UI names: MIN = Left/Top, MAX = Right/Bottom, CENTER = Center,
//          STRETCH = Left & Right / Top & Bottom, SCALE = Scale
```

### Behavior (help article "Apply constraints to define how layers resize")

- **Left / Top**: keeps position relative to left/top of frame.
- **Right / Bottom**: keeps position relative to right/bottom.
- **Left and Right / Top and Bottom** (`LEFT_RIGHT`/`TOP_BOTTOM` REST, `STRETCH` plugin):
  maintains distance to both sides ⇒ layer stretches with the frame.
- **Center**: keeps position relative to the frame's center on that axis.
- **Scale** (`SCALE`): layer's size *and* position are treated as a percentage of the frame's
  dimensions and keep those proportions when the frame resizes (e.g. 70%-wide child of a 100px
  frame becomes 140px wide when the frame becomes 200px).
- Default constraints for new layers: **Top + Left**.
- Constraints fire when the **frame is resized** (`resize()` in the Plugin API applies child
  constraints; `resizeWithoutConstraints()` bypasses them).
- **Scale tool** (`rescale()` / scale tool K) proportionally resizes layers and **ignores
  constraints** of nested layers (per help article "Scale layers while maintaining
  proportions").
- You can temporarily ignore constraints in the UI while resizing with a modifier key.

---

## 8. Text

### REST API (TEXT node)

- `characters: String` — the text content.
- `style: TypeStyle` — default style object. TypeStyle fields:
  `fontFamily`, `fontPostScriptName`, `fontStyle` (e.g. Bold/Italic, added 2025), `fontWeight`
  (numeric), `fontSize`, `textAlignHorizontal` (`LEFT|RIGHT|CENTER|JUSTIFIED`),
  `textAlignVertical` (`TOP|CENTER|BOTTOM`), `letterSpacing` (px), `lineHeightPx`,
  `lineHeightPercent` (deprecated), `lineHeightPercentFontSize`,
  `lineHeightUnit` (`PIXELS | FONT_SIZE_% | INTRINSIC_%`), `textCase` (`ORIGINAL | UPPER |
  LOWER | TITLE | SMALL_CAPS | SMALL_CAPS_FORCED`), `textDecoration` (`NONE | UNDERLINE |
  STRIKETHROUGH`), `fills` (Paint[] — text color), `hyperlink` (`{type: URL|NODE, url, nodeID}`),
  `paragraphSpacing`, `paragraphIndent`, `listSpacing`, `italic` (bool), `openTypeFlags`
  (map feature→0/1), `textAutoResize` (`NONE | HEIGHT | WIDTH_AND_HEIGHT | TRUNCATE`
  — TRUNCATE deprecated → read `textTruncation`), `textTruncation` (`DISABLED | ENDING`) +
  `maxLines`, `isOverrideOverTextStyle`, `semanticWeight` (`BOLD|NORMAL`),
  `semanticItalic` (`ITALIC|NORMAL`), `boundVariables`.
- **Mixed styles (REST)**: `characterStyleOverrides: Number[]` (one entry per character,
  trailing zeros trimmed; 0 = default style) + `styleOverrideTable: Map<Number, TypeStyle>`
  (id → per-range style). Also `lineTypes: ('NONE'|'ORDERED'|'UNORDERED')[]` and
  `lineIndentations: Number[]` (one entry per line).
- **hasBackgroundColor**: not present in the current REST or Plugin API surface. (Text
  background color today: FigJam connector labels use `textBackground`
  (`ConnectorTextBackground`), pages use `backgrounds`, frames use `fills`.)
- `TEXT_PATH` (beta) adds `textPathStartData` and uses `TextPathTypeStyle` (TypeStyle minus
  paragraph/autoresize/lineheight fields).

### Plugin API (TextNode)

- `characters`, `textAlignHorizontal`, `textAlignVertical`, `textAutoResize: 'NONE' |
  'WIDTH_AND_HEIGHT' | 'HEIGHT' | 'TRUNCATE'`, `fontName` (`{family, style}`),
  `fontSize`, `fontWeight`, `textCase`, `textDecoration`, `letterSpacing`
  (`{unit: 'PIXELS'|'PERCENT', value}`), `lineHeight` (`{value, unit: 'PIXELS'|'PERCENT'} |
  {unit: 'AUTO'}`), `fills`, `textStyleId`, `paragraphSpacing`, `paragraphIndent`,
  `listSpacing`, `textWrapStyle` (`AUTO|BALANCE|PRETTY`), `openTypeFeatures`,
  `hyperlink`, `autoRename`. Mixed values are surfaced as the sentinel `figma.mixed`.
- **`getStyledTextSegments(fields, start?, end?)`** — returns `StyledTextSegment[]`
  (`{characters, start, end, ...requestedFields}`) for any of: `fontSize`, `fontName`,
  `fontWeight`, `fontStyle`, `textDecoration` (+ style/offset/thickness/color/skipInk),
  `textCase`, `lineHeight`, `letterSpacing`, `fills`, `textStyleId`, `fillStyleId`,
  `listOptions`, `listSpacing`, `indentation`, `paragraphIndent`, `paragraphSpacing`,
  `hyperlink`, `boundVariables`, `textStyleOverrides`, `openTypeFeatures`.
  Indices are UTF-16 code units (surrogate pairs get trimmed/split when ranges split them).

---

## 9. Components, instances, variants

### Concepts & REST fields

- **Main component** (`COMPONENT` node): definition. Creating one converts a frame-like node
  into a reusable definition; instances update when it changes. `componentPropertyDefinitions:
  Map<String, ComponentPropertyDefinition>` on COMPONENT / COMPONENT_SET.
- **Component set** (`COMPONENT_SET`): container whose children are the **variants** of a
  component (children must be COMPONENTs; cannot contain other node types). Top-level `componentSets`
  map in the file response: `{key, name, description, documentationLinks, remote, componentSetId?}`.
- **Instance** (`INSTANCE`): a live copy. REST fields: `componentId` (ID of source component —
  look it up in top-level `components` map), `componentProperties:
  Map<String, ComponentProperty>`, `overrides: Overrides[]` (`{id, overriddenFields[]}` —
  direct overrides only, not inherited), `isExposedInstance`, `exposedInstances`.
  Plugin API adds: `mainComponent` (get/set; setting swaps the instance, clearing overrides on
  nested instances), `swapComponent()` (swap preserving overrides via editor heuristics),
  `detachInstance(): FrameNode` (detaches; nested instances' ancestors are also detached),
  `removeOverrides()`, `scaleFactor`.
- **Component metadata** (top-level `components` map): `{key, name, description,
  componentSetId?, documentationLinks, remote}`. Published-library variants via
  `GET /v1/files/:key/components` etc. add `file_key`, `node_id`, `thumbnail_url`,
  `created_at`, `updated_at`, `user`, `containing_frame`.

### Component properties

`ComponentPropertyType`:
- REST: `BOOLEAN | INSTANCE_SWAP | TEXT | VARIANT`
- Plugin API: `BOOLEAN | TEXT | INSTANCE_SWAP | VARIANT | SLOT` (SLOT not yet in REST enum)

`ComponentPropertyDefinition` (on component/set): `{type, defaultValue, variantOptions?
(only VARIANT), preferredValues? (only INSTANCE_SWAP)}`.
`ComponentProperty` (on instance): `{type, value, preferredValues?, boundVariables}`.

Notes (Plugin API docs): BOOLEAN/TEXT/INSTANCE_SWAP property names get a unique `#id` suffix
(e.g. `State#12:3`); VARIANT names do not. `setProperties()` on an instance sets property
values; name collisions resolve in favor of VARIANT.

Semantics (help "Explore component properties"):
- **Boolean** — true/false toggle; applied to layer visibility (false = hidden).
- **Text** — string content of a nested text layer.
- **Instance swap** — choose which nested instance can be swapped; `preferredValues` curates
  the swap list (`InstanceSwapPreferredValue: {type: 'COMPONENT'|'COMPONENT_SET', key}`).
- **Variant** — property only valid inside component sets; each variant is a unique
  combination of property values; default variant = top-left one in the set.
- **Slot** — placeholder region in a component (Plugin/Slides-era addition).

### Variant naming conventions

- Slash naming organizes the Assets panel: `componentName/property1value/property2value...`;
  when combining components into a set, text before the first `/` becomes the set name, each
  additional `/` segment becomes a value (Figma creates one property per slash position;
  every component needs the same number of slashes).
- In-editor, variants inside a set are named with `Property=Value` pairs separated by commas
  (Figma rewrites names when properties are reordered; "corrupted variant" errors occur when
  the syntax is broken).
- Nested instances: instances inside other instances; exposing a nested instance
  (`isExposedInstance` / `exposedInstances`) surfaces its properties at the top-level
  instance.

---

## 10. Variables

### Model (REST endpoints / help center)

- **Variable** — a named design token: `{id, name, key, variableCollectionId, resolvedType,
  valuesByMode, remote, description, hiddenFromPublishing, scopes, codeSyntax,
  deletedButReferenced}`.
- **VariableCollection** — a set of variables sharing the same modes: `{id, name, key, modes
  (modeId → name), defaultModeId, remote, hiddenFromPublishing, variableIds, isExtension,
  parentVariableCollectionId, rootVariableCollectionId, inheritedVariableIds,
  localVariableIds, variableOverrides}` (extension fields only for extended collections).
- **Mode** — a column of values, one per variable (`valuesByMode: Map<modeId, value>`). Up to
  40 modes per collection, up to 5,000 variables per collection.
- **resolvedType** (REST): `BOOLEAN | FLOAT | STRING | COLOR`.
  Plugin API `VariableResolvedDataType` adds `EASING | TIMING` (Figma Motion; not exposed via
  REST variables endpoints).
- **Alias** — a variable whose value for a mode is another variable:
  `{type: 'VARIABLE_ALIAS', id}` (VariableAlias). Aliasing = design-token chaining; a variable
  can only alias a variable of the same resolved type; cycles are rejected.
- **Scopes** — UI-only filtering of the variable picker (does not prevent binding):
  FLOAT: `ALL_SCOPES, CORNER_RADIUS, TEXT_CONTENT, WIDTH_HEIGHT, GAP, STROKE_FLOAT, OPACITY,
  EFFECT_FLOAT, FONT_WEIGHT, FONT_SIZE, LINE_HEIGHT, LETTER_SPACING, PARAGRAPH_SPACING,
  PARAGRAPH_INDENT`; STRING: `ALL_SCOPES, TEXT_CONTENT, FONT_FAMILY, FONT_STYLE,
  FONT_VARIATIONS`; COLOR: `ALL_SCOPES, ALL_FILLS, FRAME_FILL, SHAPE_FILL, TEXT_FILL,
  STROKE_COLOR, EFFECT_COLOR`.
- **codeSyntax** — `{WEB, ANDROID, iOS}` platform → string snippets (Dev Mode).
- **Binding**: node-level `boundVariables` (see §3/§5) maps field names (e.g. `visible`,
  `opacity`, `itemSpacing`, `paddingLeft`, `topLeftRadius`, `rectangleCornerRadii.
  RECTANGLE_TOP_LEFT_CORNER_RADIUS`, `fills[]`, `componentProperties[name]`,
  `textRangeFills[]`, …) to `VariableAlias`es. Paints/effects/grids also carry their own
  `boundVariables`; `ColorStop.boundVariables` supports gradient stops.
- **Mode resolution**: nodes/pages use a collection's `defaultModeId` until explicitly set;
  explicit per-node (or page/frame) modes live in `explicitVariableModes`
  (collectionId → modeId) on the node. When a bound variable's collection mode changes, the
  resolved value (e.g. paint color) changes accordingly. Prototype actions `SET_VARIABLE` /
  `SET_VARIABLE_MODE` can change values/modes at runtime.
- **Extended collections** (Nov 2025): a collection that extends a parent collection
  (`parentVariableCollectionId`), inheriting all variables/modes with optional per-mode
  overrides; extended mode IDs look like `VariableCollectionId:2:5/1:0`.

### REST endpoints (Enterprise-org gated for local/published reads)

- `GET /v1/files/:file_key/variables/local` — local variables **and** remote variables used
  in the file; response `meta.variables` / `meta.variableCollections` maps. Scope
  `file_variables:read`.
- `GET /v1/files/:file_key/variables/published` — variables published from this file; adds
  `subscribed_id` + `updatedAt`; **omits modes** (use local endpoint for modes). Main file key
  only (not branches).
- `POST /v1/files/:file_key/variables` — atomic bulk create/update/delete via arrays
  `variableCollections`, `variableModes`, `variables`, `variableModeValues` (each item with
  `action: CREATE|UPDATE|DELETE`); temporary IDs supported; body ≤ 4 MB; scope
  `file_variables:write`.

Plugin API: `figma.variables.getLocalVariablesAsync()`, `getVariableByIdAsync`,
`createVariable(name, collection, resolvedType)`, `createVariableCollection`,
`variable.setBoundVariableForPaint/Effect/LayoutGrid`, `setBoundVariable(field, variable)`, etc.

---

## 11. Pages & Sections

- **Pages** = `CANVAS` nodes (REST) / `PageNode` `type: 'PAGE'` (Plugin). A file can have many
  pages; pages contain top-level layers. CANVAS fields (REST): `children`, `backgroundColor`
  (deprecated in favor of `backgrounds` paint list in Plugin API), `prototypeStartNodeID`
  (deprecated), `flowStartingPoints: [{nodeId, name}]`, `prototypeDevice`
  (`{type: NONE|PRESET|CUSTOM|PRESENTATION, size, presetIdentifier, rotation: NONE|CCW_90}`),
  `exportSettings`, `measurements` (Dev Mode pinned distances).
- **Sections** (2024, `SECTION` node): top-level canvas element by default (cannot be nested
  inside frames/groups; can contain any layers, including other sections). Use cases
  (help article "Organize your canvas with sections"): designate canvas areas, organize
  navigation, share links to a grouping, mark content **ready for development**. REST fields:
  `sectionContentsHidden`, `devStatus`, `fills`, `strokes`, `strokeWeight`, `strokeAlign`,
  `children`, `absoluteBoundingBox`, `absoluteRenderBounds`. Prototype connections to a
  section return to the last visited frame in it. Keyboard: ⇧S; "Wrap in new section" via
  right-click.
- **Multi-edit** (March 2024): select and edit matching objects across multiple
  frames/groups/sections in bulk — resize/align objects to their frames, batch-edit text,
  update fills, etc. Pure editor behavior; no special node type.
- **Frame naming conventions** — no enforced convention; slash (`/`) naming organizes
  components/variants in the assets panel (§9). Pages commonly split by process stage
  (Cover, Foundations, Components, Explore, Prototype, Archive…).
- **Dev status** (`devStatus`): `READY_FOR_DEV` / `COMPLETED` (+ optional description) on
  frames and sections; edits flip status to "Changed" in Dev Mode.

---

## 12. Boolean operations & vector editing

- **Boolean operation nodes** (`BOOLEAN_OPERATION`, children = operated shapes):
  `booleanOperation: 'UNION' | 'INTERSECT' | 'SUBTRACT' | 'EXCLUDE'`
  (union = merged; subtract = removes overlap from bottom shape; intersect = keeps overlap;
  exclude = removes overlapping regions). REST: has VECTOR props + `children`;
  `expanded` (Plugin) indicates layers-panel expansion. Non-destructive: flatten to
  VECTOR to bake.
- **Vector networks vs paths** (Plugin API only):
  - `VectorPath` (recommended): SVG-style path data (`data` string with M/L/C/Z commands,
    `windingRule: 'NONE'|'NONZERO'|'EVENODD'`) — chains of segments.
  - `VectorNetwork` (advanced): graph of `vertices[{x,y}]` + `segments[{start, end,
    tangentStart?, tangentEnd?}]` + `regions[{windingRule, loops, fills}]`; supports >2
    segments meeting at one point — a superset of paths; not representable in the REST API
    (REST only returns `fillGeometry`/`strokeGeometry` path arrays with `geometry=paths`).
  - `VectorPath` also has `overrideId` linking per-region fills to the node's
    `fillOverrideTable` (REST, added Nov 2022).
- Masks: `isMask` + `maskType` (`ALPHA | VECTOR | LUMINANCE`) apply to siblings in front.

---

## 13. Node IDs

- Format: **`I:N`** — a string of colon-separated non-negative integers, e.g. `1:3`, `12:34;
  56` style compound ids also appear (e.g. `I1:7347`). The first segment typically relates to
  the page/context; ids grow longer for copies (`1:23`, `1:23;2:45`).
- **In file URLs node ids are hyphenated** (`?node-id=1-3`); for API calls they must use
  colons (`1:3`). (Plugin docs, `nodes-id` page.)
- **Uniqueness**: unique within the document ("A string uniquely identifying this node within
  the document"; "Every node has an id property, which is unique within the document").
- **Stability**: stable for the lifetime of the node, but **copy/paste/duplicate creates new
  nodes with new IDs** (clones are distinct nodes; REST/Plugin give no ID-stability guarantee
  across duplication or across some edits — a node that is deleted/recreated, or whose
  ancestor is flattened, will change ID; forum guidance treats "node ID no longer exists" as
  the standard failure mode). Node `id` is `readonly` in the Plugin API.
- IDs appear in: `GET /v1/files/:key/nodes?ids=`, `GET /v1/images/:key?ids=`,
  `instance.componentId`, `components` map keys, comment `client_meta` frame offsets,
  prototype `transitionNodeID`/`destinationId`, webhooks.
- Related identifiers: **file key** (22-char, from URL), file `version` id, component/style
  `key` (stable across publishes), variable `key` vs `id` vs `subscribed_id`
  (subscribed_id changes on every publish).

---

## 14. Naming discrepancies (REST vs Plugin API vs UI)

| Concept | REST API | Plugin API | UI / help wording |
|---|---|---|---|
| Page node | `CANVAS` | `PAGE` (`PageNode`) | "Page" |
| Polygon node | `REGULAR_POLYGON` | `POLYGON` (`PolygonNode`) | "Polygon" |
| Sticky note | `STICKY` | `STICKY` (`StickyNode`) | "Sticky note" (older docs said STICKY_NOTE) |
| Constraint horizontal | `LEFT / RIGHT / CENTER / LEFT_RIGHT / SCALE` | `MIN / CENTER / MAX / STRETCH / SCALE` | "Left, Right, Center, Left & Right, Scale" |
| Constraint vertical | `TOP / BOTTOM / CENTER / TOP_BOTTOM / SCALE` | `MIN / CENTER / MAX / STRETCH / SCALE` | "Top, Bottom, Center, Top & Bottom, Scale" |
| Frame overflow | `HORIZONTAL_SCROLLING / VERTICAL_SCROLLING / HORIZONTAL_AND_VERTICAL_SCROLLING / NONE` | `HORIZONTAL / VERTICAL / BOTH / NONE` (`OverflowDirection`) | "Overflow behavior: horizontal / vertical / both" |
| Component property types | `BOOLEAN / TEXT / INSTANCE_SWAP / VARIANT` | adds `SLOT` | Boolean, Text, Instance swap, Variant, Slot |
| Variable types | `BOOLEAN / FLOAT / STRING / COLOR` | adds `EASING / TIMING` | Color, Number, String, Boolean, Timing, Easing |
| Auto-layout sizing (legacy) | `primaryAxisSizingMode` / `counterAxisSizingMode` (`FIXED/AUTO`) | same | "Hug" / "Fixed" (pre-2022 "Fit") |
| Auto-layout sizing (modern) | `layoutSizingHorizontal/Vertical` (`FIXED/HUG/FILL`) | same | "Hug contents / Fill container / Fixed" |
| Absolute positioning | `layoutPositioning: 'ABSOLUTE'` | same | "Ignore auto layout" (formerly "Absolute position") |
| Styles map key | `styles` map + `styleType` `FILL/TEXT/EFFECT/GRID` | `StyleType` `PAINT/TEXT/EFFECT/GRID` (typings) | "Paint style / Color style / Fill style" |
| Text style object | `style` (TypeStyle) on TEXT nodes; `styleType` = styleId link | `textStyleId`, `fontName` etc. as live properties | "Text" in right sidebar |
| Group vs frame | GROUP "See properties for FRAME" | GroupNode (no fills/layout) | "Group" selection ⌘G |
| Text background | connector `textBackground` (`ConnectorTextBackground`); sticky/shape fills | `PageNode.backgrounds`; no `hasBackgroundColor` in current typings | "Background" |
| Blend "Plus darker/lighter" | `LINEAR_BURN` / `LINEAR_DODGE` | same | "Plus darker" / "Plus lighter" |
| Node position | `absoluteBoundingBox` / `relativeTransform` (geometry=paths) | `x`, `y`, `width`, `height` | X/Y/W/H fields |
| Export scale types | Constraint `SCALE/WIDTH/HEIGHT` | `ExportSettingsConstraints` | "Scale / Width / Height" |

Other gotchas:
- REST `visible` default true; REST omits `rotation` when 0; `relativeTransform`/`size`/
  `fillGeometry`/`strokeGeometry` require `geometry=paths`.
- Deprecated REST fields still emitted: `background`, `backgroundColor` (frames),
  `prototypeStartNodeID`, `preserveRatio`, `horizontalPadding`, `verticalPadding`,
  `isMaskOutline`, `lineHeightPercent`, `textAutoResize: 'TRUNCATE'`.
- The REST docs' node-type table omits WIDGET/EMBED/LINK_UNFURL/MEDIA/STAMP even though
  WIDGET/EMBED/LINK_UNFURL are in the official TS `Node` union (widgets serialize as FRAME-like
  nodes); MEDIA/STAMP/HIGHLIGHT/CODE_BLOCK/SLIDE*/SLOT are Plugin-API-only today.
- `components` (REST) uses **node IDs** as keys; library endpoints use **component keys**.

---

## 15. Sources

**REST API (developers.figma.com):**
1. https://developers.figma.com/docs/rest-api/files/ — global properties, DOCUMENT→CANVAS hierarchy
2. https://developers.figma.com/docs/rest-api/file-endpoints/ — GET /v1/files/:key, GET /v1/files/:key/nodes, images endpoints
3. https://developers.figma.com/docs/rest-api/file-node-types/ — full node-type property catalog
4. https://developers.figma.com/docs/rest-api/file-property-types/ — Paint, Effect, BlendMode, LayoutConstraint, TypeStyle, ComponentProperty, VariableAlias, prototype types, etc.
5. https://developers.figma.com/docs/rest-api/component-types/ — Component/ComponentSet/Style/FrameInfo
6. https://developers.figma.com/docs/rest-api/component-endpoints/ — library component endpoints
7. https://developers.figma.com/docs/rest-api/variables-endpoints/ — local/published/POST variables
8. https://developers.figma.com/docs/rest-api/variables-types/ — VariableCollection/Variable/VariableScope
9. https://developers.figma.com/docs/rest-api/changelog/ — feature history (componentProperties 2022, variables 2023-06, layoutSizing 2023-08, extended collections 2025-11, etc.)
10. https://github.com/figma/rest-api-spec — official OpenAPI spec + `dist/api_types.ts` (fetched raw)

**Plugin API (developers.figma.com/docs/plugins):**
11. https://developers.figma.com/docs/plugins/api/nodes/ — NodeType union, BaseNode/SceneNode
12. https://developers.figma.com/docs/plugins/api/FrameNode/ — auto-layout property list
13. https://developers.figma.com/docs/plugins/api/properties/nodes-layoutsizinghorizontal/ — HUG/FILL/FIXED semantics + examples
14. https://developers.figma.com/docs/plugins/api/Constraints/ — ConstraintType + UI names
15. https://developers.figma.com/docs/plugins/api/properties/nodes-relativetransform/ — container-parent rule, unit axes, auto-layout translation
16. https://developers.figma.com/docs/plugins/api/properties/nodes-rotation/ — −180..180, atan2 formula
17. https://developers.figma.com/docs/plugins/api/Transform/ — matrix format & rotation matrix
18. https://developers.figma.com/docs/plugins/api/properties/nodes-id/ — id format, URL hyphenation
19. https://developers.figma.com/docs/plugins/api/properties/nodes-x/ — x === relativeTransform[0][2]
20. https://developers.figma.com/docs/plugins/api/InstanceNode/ — mainComponent, swapComponent, detachInstance, overrides
21. https://developers.figma.com/docs/plugins/api/ComponentNode/ — componentPropertyDefinitions, #id suffixes
22. https://developers.figma.com/docs/plugins/api/ComponentPropertyType/ — BOOLEAN/TEXT/INSTANCE_SWAP/VARIANT/SLOT
23. https://developers.figma.com/docs/plugins/api/TextNode/ — text properties
24. https://developers.figma.com/docs/plugins/api/properties/TextNode-getstyledtextsegments/ — mixed-style segments
25. https://developers.figma.com/docs/plugins/api/VectorNetwork/ — vector networks vs paths
26. https://developers.figma.com/docs/plugins/api/BooleanOperationNode/ — booleanOperation enum
27. https://developers.figma.com/docs/plugins/api/SectionNode/, /StickyNode/, /WidgetNode/, /EmbedNode/, /LinkUnfurlNode/, /MediaNode/, /StampNode/, /ShapeWithTextNode/, /ConnectorNode/, /TableCellNode/, /TransformGroupNode/, /WashiTapeNode/ — per-type doc pages
28. https://developers.figma.com/docs/plugins/api/figma-variables/ — variable API surface
29. https://developers.figma.com/docs/plugins/api/VariableResolvedDataType/ — BOOLEAN/COLOR/EASING/FLOAT/STRING/TIMING
30. https://github.com/figma/plugin-typings (raw plugin-api.d.ts) — authoritative enums (BlendMode, TextCase, LayoutMode, VariableScope, ComponentProperties, NodeType, PageNode/DocumentNode interfaces)

**Help Center (help.figma.com):**
31. https://help.figma.com/hc/en-us/articles/9771500257687-Organize-your-canvas-with-sections
32. https://help.figma.com/hc/en-us/articles/21635177948567-Edit-objects-on-the-canvas-in-bulk (multi-edit)
33. https://help.figma.com/hc/en-us/articles/14506821864087-Overview-of-variables-collections-and-modes
34. https://help.figma.com/hc/en-us/articles/15343816063383-Modes-for-variables
35. https://help.figma.com/hc/en-us/articles/360039957734-Apply-constraints-to-define-how-layers-resize
36. https://help.figma.com/hc/en-us/articles/360040451453-Scale-layers-while-maintaining-proportions
37. https://help.figma.com/hc/en-us/articles/360040451373-Guide-to-auto-layout
38. https://help.figma.com/hc/en-us/articles/360056440594-Create-and-use-variants
39. https://help.figma.com/hc/en-us/articles/5579474826519-Explore-component-properties
40. https://help.figma.com/hc/en-us/articles/360039957534-Boolean-operations
41. https://help.figma.com/hc/en-us/articles/360038511293-Create-and-manage-pages
42. https://help.figma.com/hc/en-us/articles/24005082123159-Create-and-manage-pages-in-FigJam

**Other:**
43. https://forum.figma.com/product-updates-3/meet-multi-edit-35320 — multi-edit announcement (2024-03-06)
44. https://www.figma.com/blog/behind-the-feature-the-multiple-lives-of-multi-edit
45. https://forum.figma.com/report-a-problem-6/node-id-is-not-unique-32258 — node-id uniqueness discussion
46. https://forum.figma.com/ask-the-community-7/gettting-component-s-containing-frame-value-from-rest-api-33519 — containing_frame usage
47. https://forum.figma.com/ask-the-community-7/bug-of-figma-rest-api-23504 — instance ids in nodes endpoint
48. https://www.figma.com/best-practices/team-file-organization — file/page organization best practices

Raw extracted doc text + search result JSON for all of the above are saved alongside this file
in `/home/z/my-project/scripts/research/` (`figma-*.txt`, `help-*.txt`, `changelog.txt`,
`api_types.ts`, `plugin-api.d.ts`, `r1-*.json`).
