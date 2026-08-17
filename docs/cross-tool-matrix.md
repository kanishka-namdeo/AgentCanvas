# Cross-Tool Comparison Matrix

> Side-by-side mapping of how the **same concept** is named across Figma,
> Penpot, Sketch, tldraw, the W3C Design Tokens spec, and our `.pen`
> format. Use this when designing importers / exporters / migration
> paths, or when reading source from another tool.

---

## 1. Node types

| Concept              | Figma                       | Penpot         | Sketch         | tldraw              | W3C Design Tokens     | .pen v2.0                          |
| -------------------- | --------------------------- | -------------- | -------------- | ------------------- | --------------------- | ---------------------------------- |
| Root container       | `DocumentNode`              | `Page`         | Document       | —                    | `$metadata`           | `PenDocument`                      |
| Page / canvas        | `CanvasNode`                | `Page`         | Page           | `TLDoc`              | —                     | top-level `children[]`             |
| Frame / div          | `FrameNode`                 | `Frame`        | Artboard       | `FrameShape`        | —                     | `PenFrame`                         |
| Group                | `GroupNode`                 | `Group`        | Group          | `GroupShape`        | —                     | `PenGroup`                         |
| Component (master)   | `ComponentNode`             | `Component`    | Symbol         | *(asset)*           | —                     | `PenFrame` + `reusable: true`      |
| Component Set        | `ComponentSetNode`          | `Component`*   | *(symbol variants)* | —              | —                     | `PenFrame` + `metadata.isComponentSet` |
| Instance             | `InstanceNode`              | `Instance`     | Symbol instance | *(asset reference)* | —                     | `PenRef`                           |
| Rectangle            | `RectangleNode`             | `Rect`         | Rectangle      | `GeoShape` (`geo='rectangle'`) | — | `PenRectangle`                     |
| Ellipse / circle     | `EllipseNode`               | `Ellipse`      | Oval           | `GeoShape` (`geo='ellipse'`) | —    | `PenEllipse`                       |
| Polygon (regular)    | `RegularPolygonNode`        | `PolygonPath`  | Polygon        | `GeoShape` (`geo='triangle'/'pentagon'/…`) | — | `PenPolygon`                       |
| Star                 | `StarNode`                  | `Path` (manual) | Star          | —                   | —                     | `PenStar` *(planned v2.1)*         |
| Line                 | `LineNode`                  | `Line`         | Line           | `LineShape`         | —                     | `PenPath` (2-point)                |
| Vector / path        | `VectorNode`                | `Path`         | Shape path     | `DrawShape`         | —                     | `PenPath`                          |
| Text                 | `TextNode`                  | `Text`         | Text           | `TextShape`         | —                     | `PenText`                          |
| Boolean op           | `BooleanOperationNode`      | `Bool`         | Boolean op     | `DrawShape` (combined) | —                  | `PenBooleanOp` *(new v2.0)*        |
| Slice / export       | `SliceNode`                 | `Rect` w/ export | Slice        | —                   | —                     | `PenFrame` + `metadata.isSlice`    |
| Section              | `SectionNode`               | *(canvas section)* | —           | —                   | —                     | `PenFrame` + `metadata.isSection`  |
| Sticky note          | `StickyNode`                | —              | —              | `NoteShape`         | —                     | `PenNote`                          |
| Image                | `RectangleNode` + `ImagePaint` | `Image`     | Image          | `AssetShape`        | —                     | `PenFrame` + image `fill`          |

\* Penpot doesn't have a separate Component Set concept — variant-like
behavior is achieved via nested components and overrides.

---

## 2. Auto Layout / Flex

| Concept              | Figma                              | Penpot               | Sketch (Smart Layout) | CSS               | .pen                          |
| -------------------- | ---------------------------------- | -------------------- | --------------------- | ----------------- | ----------------------------- |
| Direction            | `layoutMode: HORIZONTAL/VERTICAL`  | `flexDirection`      | `layout: row/column`  | `flex-direction`  | `layout: 'horizontal'/'vertical'` |
| Grid layout          | `layoutMode: GRID`                 | CSS Grid             | —                     | `display: grid`   | `layout: 'grid'` *(new v2.0)* |
| Padding (all sides)  | `paddingTop/Right/Bottom/Left`     | `padding`            | `padding`             | `padding`         | `padding: n`                  |
| Padding (per side)   | same four fields                   | `padding: [t,r,b,l]` | `padding: {top,…}`    | `padding: t r b l` | `padding: [t,r,b,l]`          |
| Gap between children | `itemSpacing`                      | `gap`                | `gutter`              | `gap`             | `gap`                         |
| Main-axis align      | `primaryAxisAlignItems`            | `justifyContent`     | `align: start/center/end` | `justify-content` | `justifyContent`           |
| Cross-axis align     | `counterAxisAlignItems`            | `alignItems`         | —                     | `align-items`     | `alignItems`                  |
| Space between        | `primaryAxisAlignItems: SPACE_BETWEEN` | `justifyContent: space-between` | — | `justify-content: space-between` | `justifyContent: 'space_between'` |
| Wrap                 | `layoutWrap: WRAP`                 | `flex-wrap: wrap`    | —                     | `flex-wrap: wrap` | *(planned v2.x)*              |
| Hug (fit content)    | `layoutSizingHorizontal: HUG`      | `width: auto`        | `resizing: hug`       | `width: fit-content` | `width: 'fit_content'`    |
| Fill                 | `layoutSizingHorizontal: FILL`     | `width: 100%`        | `resizing: fill`      | `width: 100%`     | `width: 'fill_container'`     |
| Fixed                | `layoutSizingHorizontal: FIXED`    | `width: 240px`       | `resizing: fixed`     | `width: 240px`    | `width: 240`                  |
| Min/max size         | `minWidth/maxWidth/minHeight/maxHeight` | `minWidth/maxWidth` | — | `min-width`/`max-width` | same fields *(new v2.0)* |
| Positioning mode     | `layoutPositioning: AUTO/ABSOLUTE` | `position: relative/absolute` | — | `position` | `layoutPosition: 'auto'/'absolute'` |
| Reverse z-index      | `itemReverseZIndex`                | —                    | —                     | `z-index`         | *(planned v2.x)*              |
| Strokes in layout    | `strokesIncludedInLayout`          | `box-sizing: border-box` | —              | `box-sizing`      | `layoutIncludeStroke`         |

---

## 3. Constraints (non-Auto-Layout)

| Concept              | Figma                       | Penpot          | Sketch          | .pen                       |
| -------------------- | --------------------------- | --------------- | --------------- | -------------------------- |
| Horizontal constraint | `LayoutConstraint.horizontal` | `constraints.horizontal` | `resizingConstraint.horizontal` | `constraints.horizontal` *(new v2.0)* |
| Vertical constraint   | `LayoutConstraint.vertical` | `constraints.vertical` | `resizingConstraint.vertical` | `constraints.vertical` *(new v2.0)* |
| Left                 | `LEFT`                      | `left`          | `left`          | `'left'`                   |
| Right                | `RIGHT`                     | `right`         | `right`         | `'right'`                  |
| Left+Right (stretch) | `LEFT_RIGHT`                | `leftRight`     | `leftRight`     | `'left_right'`             |
| Center               | `CENTER`                    | `center`        | `center`        | `'center'`                 |
| Scale                | `SCALE`                     | `scale`         | `scale`         | `'scale'`                  |
| Top                  | `TOP`                       | `top`           | `top`           | `'top'`                    |
| Bottom               | `BOTTOM`                    | `bottom`        | `bottom`        | `'bottom'`                 |
| Top+Bottom (stretch) | `TOP_BOTTOM`                | `topBottom`     | `topBottom`     | `'top_bottom'`             |

---

## 4. Fills & Paints

| Concept            | Figma                          | Penpot                  | Sketch              | CSS                 | .pen                          |
| ------------------ | ------------------------------ | ----------------------- | ------------------- | ------------------- | ----------------------------- |
| Solid color        | `SolidPaint`                   | `SolidColor`            | Fill                | `background-color`  | `{ type: 'color', color }`    |
| Linear gradient    | `GradientPaint` (LINEAR)       | `LinearGradient`        | Gradient fill       | `linear-gradient()` | `{ type: 'gradient', gradientType: 'linear' }` |
| Radial gradient    | `GradientPaint` (RADIAL)       | `RadialGradient`        | Gradient fill       | `radial-gradient()` | `{ type: 'gradient', gradientType: 'radial' }` |
| Angular gradient   | `GradientPaint` (ANGULAR)      | *(plugin)*              | *(plugin)*          | `conic-gradient()`  | `{ type: 'gradient', gradientType: 'angular' }` |
| Image fill         | `ImagePaint`                   | `ImageFill`             | Image fill          | `background-image`  | `{ type: 'image', url, mode }` |
| Pattern fill       | `PatternPaint`                 | —                       | Pattern fill        | `background-image`  | *(planned v2.x)*              |
| Multiple fills     | `Paint[]`                      | `Paint[]`               | Fill stack          | `background` layered | `PenFill[]`                   |
| Fill opacity       | inside RGBA `a` or `opacity`   | `opacity`               | `opacity`           | `opacity`           | alpha in hex color            |
| Fill blend mode    | `blendMode`                    | `blendMode`             | `blendMode`         | `mix-blend-mode`    | `blendMode`                   |
| Fill visibility    | `visible`                      | `visible`               | —                   | `display: none`     | `enabled`                     |

---

## 5. Strokes

| Concept            | Figma                       | Penpot             | Sketch        | SVG                 | .pen                  |
| ------------------ | --------------------------- | ------------------ | ------------- | ------------------- | --------------------- |
| Stroke color       | `strokes: Paint[]`          | `strokeColor`      | Border color  | `stroke`            | `stroke`              |
| Stroke weight      | `strokeWeight`              | `strokeWidth`      | Border width  | `stroke-width`      | `strokeWidth`         |
| Per-side weights   | `individualStrokeWeights`   | —                  | —             | —                   | `strokeWidth: {top,right,bottom,left}` |
| Stroke alignment   | `strokeAlign`               | `strokeAlign`      | `position`    | `paint-order`       | `strokeAlignment`     |
| Stroke join        | `strokeJoin`                | `strokeLinejoin`   | `join`        | `stroke-linejoin`   | `strokeLinejoin`      |
| Stroke cap         | `strokeCap`                 | `strokeLinecap`    | `cap`         | `stroke-linecap`    | `strokeLinecap`       |
| Dashes             | `strokeDashes`              | `strokeDasharray`  | —             | `stroke-dasharray`  | `strokeDashes` *(new v2.0)* |
| Miter limit        | `strokeMiterAngle`          | —                  | —             | `stroke-miterlimit` | `strokeMiterLimit` *(new v2.0)* |

---

## 6. Effects

| Concept              | Figma                  | Penpot             | Sketch         | CSS                  | .pen                          |
| -------------------- | ---------------------- | ------------------ | -------------- | -------------------- | ----------------------------- |
| Drop shadow          | `DropShadowEffect`     | `Shadow` (outer)   | Shadow         | `box-shadow`         | `{ type: 'shadow', shadowType: 'outer' }` |
| Inner shadow         | `InnerShadowEffect`    | `Shadow` (inner)   | Inner shadow   | `box-shadow inset`   | `{ type: 'shadow', shadowType: 'inner' }` |
| Layer blur           | `NormalBlurEffect`     | `Blur`             | Blur           | `filter: blur()`     | `{ type: 'blur' }`            |
| Background blur      | `BACKGROUND_BLUR`      | `BackdropBlur`     | —              | `backdrop-filter`    | `{ type: 'background_blur' }` |
| Multiple effects     | `Effect[]`             | `Effect[]`         | Stack          | multiple filters     | `PenEffect[]`                 |

---

## 7. Typography

| Concept              | Figma                  | Penpot              | Sketch        | CSS                  | .pen                  |
| -------------------- | ---------------------- | ------------------- | ------------- | -------------------- | --------------------- |
| Font family          | `fontFamily`           | `fontFamily`        | font          | `font-family`        | `fontFamily`          |
| Font size            | `fontSize`             | `fontSize`          | size          | `font-size`          | `fontSize`            |
| Font weight          | `fontWeight`           | `fontWeight`        | weight        | `font-weight`        | `fontWeight`          |
| Italic               | `italic` / `fontStyle` | `fontStyle: italic` | italic        | `font-style: italic` | `fontStyle`           |
| Letter spacing       | `letterSpacing`        | `letterSpacing`     | character     | `letter-spacing`     | `letterSpacing`       |
| Line height (px)     | `lineHeightPx`         | `lineHeight`        | line spacing  | `line-height`        | `lineHeight`          |
| Line height (%)      | `lineHeightPercentFontSize` | —              | —             | `line-height: 1.5`   | `lineHeight` (numeric multiplier) |
| Text align H         | `textAlignHorizontal`  | `textAlign`         | alignment     | `text-align`         | `textAlign`           |
| Text align V         | `textAlignVertical`    | —                   | —             | `vertical-align`     | `textAlignVertical`   |
| Text decoration      | `textDecoration`       | `textDecoration`    | underline     | `text-decoration`    | `underline`/`strikethrough` |
| Text case            | `textCase`             | `textTransform`     | —             | `text-transform`     | *(applied as CSS)*    |
| Auto-resize          | `textAutoResize`       | —                   | auto-size     | —                    | `textGrowth`          |
| Truncation           | `textTruncation`       | —                   | truncate      | `text-overflow`      | *(via `textGrowth: 'fixed-width-height'` + `maxLines`)* |

---

## 8. Variables / Tokens / Modes

| Concept              | Figma                    | Penpot         | Sketch (Variables) | W3C Design Tokens   | .pen                          |
| -------------------- | ------------------------ | -------------- | ------------------ | ------------------- | ----------------------------- |
| Token / variable     | `LocalVariable`          | `Token`        | Variable           | `$value`            | `variables[key]`              |
| Color token          | `resolvedType: COLOR`    | `Token` (color) | Color Variable     | `{$type:'color'}`   | `{ type: 'color', value }`    |
| Number token         | `resolvedType: FLOAT`    | `Token` (number) | Number Variable   | `{$type:'number'}`  | `{ type: 'number', value }`   |
| String token         | `resolvedType: STRING`   | `Token` (text) | Text Variable      | `{$type:'text'}`    | `{ type: 'string', value }`   |
| Boolean token        | `resolvedType: BOOLEAN`  | —              | Boolean Variable   | `{$type:'boolean'}` | `{ type: 'boolean', value }`  |
| Collection           | `LocalVariableCollection` | `TokensGroup`  | Collection         | `{$description}` group | `themes[axis]` (axis = collection name) |
| Mode                 | `modes: [{modeId, name}]` | —             | Appearance (light/dark) | — | `themes[axis] = [v1, v2, …]` |
| Theme-conditional value | `valuesByMode: {modeId: value}` | — | per-collection values | — | `value: [{ value, theme }]` |
| Alias                | `VariableAlias`          | `TokenAlias`   | alias              | `{$ref:'#token'}`   | `$variable-name` literal       |
| Bound to a field     | `boundVariables: {field: alias}` | `TokenRef` | bound variable     | `{$ref}` on the field | replace literal value with `$name` |
| Code syntax          | `codeSyntax: {WEB, iOS, ANDROID}` | —        | —                  | `{$extensions}`     | *(planned v2.x)*              |

---

## 9. Components & Instances

| Concept              | Figma                  | Penpot         | Sketch         | tldraw       | .pen                          |
| -------------------- | ---------------------- | -------------- | -------------- | ------------ | ----------------------------- |
| Master / definition  | `ComponentNode`        | `Component`    | Symbol         | *(asset)*    | node + `reusable: true`       |
| Instance             | `InstanceNode`         | `Instance`     | Symbol instance | *(asset ref)* | `PenRef`                      |
| Variant family       | `ComponentSetNode`     | nested comps   | symbol variants | —            | Frame + `metadata.isComponentSet` |
| Variant              | Component in set       | nested comp    | symbol variant | —            | Component + variant properties |
| Override             | `Overrides[]`          | `overrides`    | override       | —            | `descendants[idPath]`         |
| Component Property   | `ComponentProperty`    | —              | —              | —            | `metadata.componentProperties` *(new v2.0)* |
| Detach instance      | (UI action)            | (UI action)    | detach         | —            | rewrite `ref` → flat `frame`  |

---

## 10. Boolean operations

| Concept     | Figma              | Penpot         | Sketch       | SVG              | .pen                  |
| ----------- | ------------------- | -------------- | ------------ | ---------------- | --------------------- |
| Union       | `UNION`             | `union`        | Union        | `clip-rule`      | `operation: 'union'`  |
| Intersect   | `INTERSECT`         | `intersection` | Intersect    | `clip-path`      | `operation: 'intersect'` |
| Subtract    | `SUBTRACT`          | `difference`   | Subtract     | `mask`           | `operation: 'subtract'` |
| Exclude     | `EXCLUDE`           | `xor`          | Difference   | `evenodd` rule   | `operation: 'exclude'` |

---

## 11. Masks

| Concept          | Figma                          | Penpot         | Sketch    | SVG / CSS              | .pen                              |
| ---------------- | ------------------------------ | -------------- | --------- | ---------------------- | --------------------------------- |
| Is mask          | `isMask: true`                 | `isMask`       | mask      | `<mask>`               | `metadata.isMask = true` *(new v2.0)* |
| Mask type alpha  | `maskType: ALPHA`              | —              | alpha     | alpha mask             | `metadata.maskType = 'alpha'`     |
| Mask type vector | `maskType: VECTOR`             | `vectorMask`   | vector    | luminance mask         | `metadata.maskType = 'vector'`    |
| Mask type lum    | `maskType: LUMINANCE`          | —              | —         | luminance mask         | `metadata.maskType = 'luminance'` |
| Clip overflow    | `clipsContent`                 | `overflow: hidden` | clip   | `overflow: hidden`     | `clip`                            |

---

## 12. Coordinate systems

| Concept              | Figma                          | Penpot            | Sketch        | SVG               | .pen                  |
| -------------------- | ------------------------------ | ----------------- | ------------- | ----------------- | --------------------- |
| Origin               | top-left of canvas             | top-left          | top-left      | top-left          | top-left              |
| Y axis direction     | down (positive)                | down              | down          | down              | down                  |
| Position             | absolute `x`,`y` from canvas   | `x`,`y` from page | `x`,`y`       | `x`,`y`           | `x`,`y`               |
| Rotation             | degrees CCW (around top-left)  | degrees           | degrees       | degrees (around center) | degrees CCW (around top-left) |
| Transform            | 2×3 matrix                     | 2×3 matrix        | affine        | 2×3 matrix        | decomposed `rotation`+`x`+`y`+`flipX`+`flipY` |
| Bounding box         | `absoluteBoundingBox`          | `boundingBox`     | `rect`        | `getBBox()`       | derived `x`,`y`,`width`,`height` |

⚠ **Known incompatibility**: Figma rotates around the **top-left corner**;
SVG rotates around the **center**. .pen stores Figma-style (top-left)
and the SVG renderer translates it. Importing from SVG requires
recomputing the rotation center.

---

## 13. File format

| Concept              | Figma         | Penpot        | Sketch        | tldraw        | W3C Tokens    | .pen            |
| -------------------- | ------------- | ------------- | ------------- | ------------- | ------------- | --------------- |
| Extension            | `.fig` (binary)| `.penpot` (zip)| `.sketch` (zip)| `.tldr` (json)| `.tokens.json` | `.pen` (JSON)   |
| Encoding             | binary        | JSON in zip   | JSON in zip   | JSON          | JSON          | JSON            |
| Bundled assets       | yes (images baked in) | yes      | yes           | no            | no            | no (relative URLs) |
| Versioning           | internal      | schemaVersion | fileFormat    | schemaVersion | `$schema`     | `version`       |
| Open spec?           | ❌ (REST/Plugin API documented; file format closed) | ✅ | ❌ (reverse-engineered) | ✅ | ✅ | ✅ |

---

## 14. Collaboration model

| Concept              | Figma                | Penpot              | Sketch (Workspaces) | tldraw          | .pen                |
| -------------------- | -------------------- | ------------------- | -------------------- | --------------- | ------------------- |
| Real-time multiplayer| CRDT (live)          | CRDT (live)         | live (since 2024)    | CRDT (live)     | Socket.IO broadcast *(single-writer model today)* |
| History              | server-side          | server-side         | server-side          | local snapshots | localStorage snapshots |
| Branch / fork       | branching (paid)     | —                   | —                    | —               | `fork` patch op     |
| Comments             | server-side          | server-side         | —                    | —               | planned v2.x        |

---

## 15. Practical migration notes

### 15.1 Figma → .pen
- Use Figma REST API `GET /v1/files/:key?geometry=paths` to fetch the
  full tree.
- Map each `Node` to its .pen equivalent using §1.
- Resolve `VariableAlias` references to actual variable names by
  fetching `GET /v1/files/:key/variables/local` and walking the
  collection → variable → mode chain.
- Convert `RGBA { r, g, b, a }` (0..1 floats) to `#RRGGBBAA` hex.
- Drop unsupported node types (§17 of `figma-ontology.md`).

### 15.2 Penpot → .pen
- Penpot's `Frame`/`Rect`/`Ellipse`/`Path`/`Text` map directly.
- Penpot's `Bool` maps to `PenBooleanOp`.
- Penpot's `Token` maps to `variables[key]`.
- Penpot uses 2×3 transform matrices — decompose to .pen's
  `rotation`+`x`+`y`+`flipX`+`flipY`.

### 15.3 Sketch → .pen
- Sketch Symbol → `PenFrame` + `reusable: true`.
- Sketch Symbol Instance → `PenRef`.
- Sketch's `.sketch` is a zip; unzip and parse `document.json`,
  `pages/*.json`, `symbols.json`.

### 15.4 tldraw → .pen
- tldraw is the closest open-source peer — `TLShape` is a discriminated
  union on `type`, just like our `PenChild`.
- `GeoShape` with `geo='rectangle'/'ellipse'/'triangle'/...` →
  `PenRectangle` / `PenEllipse` / `PenPolygon`.
- `TextShape` → `PenText`.
- `DrawShape` (freehand) → `PenPath` with SVG path data.
- `ArrowShape` → `PenPath` with `metadata.isArrow = true`.
- `FrameShape` → `PenFrame`.
- `GroupShape` → `PenGroup`.
- `NoteShape` → `PenNote`.
- tldraw's asset references → `PenRef` to a `reusable: true` asset node.

### 15.5 W3C Design Tokens → .pen
- `$value` → `variables[key].value`.
- `$type` → `variables[key].type` (color → 'color', dimension →
  'number', text → 'string', boolean → 'boolean').
- `{$ref:'#token-name'}` → `$token-name` alias.
- Group nesting → flat namespace with `group.subgroup.token` keys.
- No mode concept in W3C tokens today — themes are application-level.
