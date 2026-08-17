# Figma Ontology — Canonical Mapping to AgentCanvas

> This document is the **authoritative mapping** between Figma's REST/Plugin
> API types and AgentCanvas's internal types (`src/lib/canvas/types.ts` and
> `src/lib/pen/types.ts`).
>
> **Source of truth for Figma's schema**: the OpenAPI YAML at
> `research/figma-ontology/openapi-figma.yaml`, fetched from
> [`figma/rest-api-spec`](https://github.com/figma/rest-api-spec).
>
> When in doubt, the Figma spec wins for Figma's behavior; the .pen
> types win for our serialised format. The mapping table is the
> contract between them.

---

## 1. Node type hierarchy

Figma's `Node` is a discriminated union on the `type` field. We mirror
the same discriminated-union shape in `.pen` (using a `type` field) and
in our resolved `Shape` type (using a `type` field).

### 1.1 Node types — full table

| Figma `type`        | Figma TS interface         | Traits ( mixins )                                                                                                  | .pen type             | AgentCanvas `ShapeType` | Status in v2.0 |
| ------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------- | ----------------------- | -------------- |
| `DOCUMENT`          | `DocumentNode`             | — (root)                                                                                                            | *(root doc)*          | —                       | ✅              |
| `CANVAS`            | `CanvasNode`               | `IsLayerTrait`, `HasChildrenTrait`                                                                                 | *(top-level `children[]`)* | —                       | ✅              |
| `FRAME`             | `FrameNode`                | `FrameTraits`                                                                                                       | `PenFrame`            | `'frame'`               | ✅              |
| `GROUP`             | `GroupNode`                | `FrameTraits`                                                                                                       | `PenGroup`            | `'group'`               | ✅              |
| `COMPONENT`         | `ComponentNode`            | `FrameTraits` + `ComponentPropertiesTrait`                                                                          | `PenFrame` w/ `reusable:true` | `'component'` *(new)* | ✅ v2.0         |
| `COMPONENT_SET`     | `ComponentSetNode`         | `FrameTraits` + `ComponentPropertiesTrait`                                                                          | `PenFrame` w/ `metadata.isComponentSet:true` | `'component_set'` *(new)* | ✅ v2.0 |
| `INSTANCE`          | `InstanceNode`             | `FrameTraits` + `componentId`, `overrides`, `componentProperties`                                                  | `PenRef`              | `'instance'` *(new)*    | ✅ v2.0         |
| `BOOLEAN_OPERATION` | `BooleanOperationNode`     | `IsLayerTrait`, `HasBlendModeAndOpacityTrait`, `HasChildrenTrait`, `HasLayoutTrait`, `HasGeometryTrait`, `HasEffectsTrait`, `HasMaskTrait`, `TransitionSourceTrait` | `PenBooleanOp` *(new)* | `'boolean_op'` *(new)* | ✅ v2.0 |
| `VECTOR`            | `VectorNode`               | `CornerRadiusShapeTraits`, `AnnotationsTrait`                                                                       | `PenPath`             | `'path'`                | ✅              |
| `STAR`              | `StarNode`                 | `CornerRadiusShapeTraits`, `AnnotationsTrait`                                                                       | `PenStar` *(new)*     | `'star'` *(new)*        | 🟡 v2.1         |
| `LINE`              | `LineNode`                 | `DefaultShapeTraits`, `AnnotationsTrait`                                                                             | `PenPath` (2-point)   | `'line'`                | ✅              |
| `ELLIPSE`           | `EllipseNode`              | `DefaultShapeTraits`, `AnnotationsTrait`, `arcData`                                                                  | `PenEllipse`          | `'ellipse'`             | ✅              |
| `REGULAR_POLYGON`   | `RegularPolygonNode`       | `CornerRadiusShapeTraits`, `AnnotationsTrait`                                                                       | `PenPolygon`          | `'polygon'` *(new)*     | ✅ v2.0         |
| `RECTANGLE`         | `RectangleNode`            | `RectangularShapeTraits`, `AnnotationsTrait`                                                                         | `PenRectangle`        | `'rectangle'`           | ✅              |
| `TEXT`              | `TextNode`                 | `DefaultShapeTraits`, `TypePropertiesTrait`, `AnnotationsTrait`                                                     | `PenText`             | `'text'`                | ✅              |
| `TEXT_PATH`         | `TextPathNode`             | `DefaultShapeTraits`, `TextPathPropertiesTrait`                                                                      | *(planned v2.x)*      | —                       | ❌              |
| `TABLE`             | `TableNode`                | `IsLayerTrait`, `HasChildrenTrait`, `HasLayoutTrait`, `MinimalStrokesTrait`, `HasEffectsTrait`, `HasBlendModeAndOpacityTrait`, `HasExportSettingsTrait` | *(planned v2.x)*      | —                       | ❌              |
| `TABLE_CELL`        | `TableCellNode`            | `IsLayerTrait`, `MinimalFillsTrait`, `HasLayoutTrait`, `HasTextSublayerTrait`                                       | *(planned v2.x)*      | —                       | ❌              |
| `TRANSFORM_GROUP`   | `TransformGroupNode`       | `FrameTraits` + `TransformModifiersTrait`                                                                           | *(planned v2.x)*      | —                       | ❌              |
| `SLICE`             | `SliceNode`                | `IsLayerTrait`                                                                                                      | `PenFrame` w/ `metadata.isSlice:true` | `'slice'` *(new)* | ✅ v2.0 |
| `SECTION`           | `SectionNode`              | `IsLayerTrait`, `HasGeometryTrait`, `HasChildrenTrait`, `HasLayoutTrait`, `DevStatusTrait`                          | `PenFrame` w/ `metadata.isSection:true` | `'section'` *(new)* | ✅ v2.0 |
| `STICKY`            | `StickyNode`               | *(FigJam-only)*                                                                                                     | `PenNote`             | `'note'`                | ✅ (mapped)     |
| `CONNECTOR`         | `ConnectorNode`            | *(FigJam-only)*                                                                                                     | *(planned v2.x)*      | —                       | ❌              |
| `EMBED`             | `EmbedNode`                | `IsLayerTrait`, `HasExportSettingsTrait`                                                                            | `PenFrame` w/ `metadata.embedUrl` | `'embed'` *(new)* | 🟡 v2.1 |
| `LINK_UNFURL`       | `LinkUnfurlNode`           | `IsLayerTrait`                                                                                                      | *(planned v2.x)*      | —                       | ❌              |
| `SHAPE_WITH_TEXT`   | `ShapeWithTextNode`        | *(FigJam-only)*                                                                                                     | *(planned v2.x)*      | —                       | ❌              |
| `WASHI_TAPE`        | `WashiTapeNode`            | *(FigJam-only)*                                                                                                     | —                     | —                       | ❌              |
| `WIDGET`            | `WidgetNode`               | *(widget runtime — out of scope)*                                                                                   | —                     | —                       | ❌              |

**Legend**: ✅ supported · 🟡 planned · ❌ out of scope.

---

## 2. Traits — the Figma mixin composition

Figma composes node types from **Traits** (their name for mixins).
AgentCanvas's .pen types compose the same way using TS `extends`.

| Figma Trait                       | .pen mixin (TS interface)                                | What it adds |
| --------------------------------- | -------------------------------------------------------- | ------------ |
| `IsLayerTrait`                    | `PenEntity`                                              | `id`, `name`, `visible`, `locked`, `rotation`, `boundVariables`, `scrollBehavior`, `componentPropertyReferences`, `pluginData` |
| `HasBlendModeAndOpacityTrait`     | *(merged into `PenEntity`)*                              | `blendMode`, `opacity` |
| `HasChildrenTrait`                | `PenCanHaveChildren`                                     | `children: PenChild[]` |
| `HasLayoutTrait`                  | `PenLayout` + `PenSize` + `PenLayoutConstraint` *(new v2.0)* | `absoluteBoundingBox`, `constraints`, `layoutAlign`, `layoutGrow`, `layoutPositioning`, `minWidth/maxWidth/minHeight/maxHeight`, `layoutSizingHorizontal/Vertical`, grid props |
| `HasFramePropertiesTrait`         | *(merged into `PenFrame`)*                               | `clipsContent`, `layoutGrids`, `overflowDirection`, `layoutMode`, `primaryAxisSizingMode`, `counterAxisSizingMode`, `primaryAxisAlignItems`, `counterAxisAlignItems`, `padding*`, `itemSpacing`, `itemReverseZIndex`, `strokesIncludedInLayout`, `layoutWrap`, `counterAxisSpacing`, `counterAxisAlignContent` |
| `HasGeometryTrait`                | `PenCanHaveGraphics`                                     | `fills`, `strokes`, `strokeWeight`, `strokeAlign`, `strokeJoin`, `strokeCap`, `strokeDashes`, `strokeMiterAngle`, `fillOverrideTable` |
| `MinimalFillsTrait`               | *(part of `PenCanHaveGraphics`)*                         | `fills`, `styles` |
| `MinimalStrokesTrait`             | `PenCanHaveStroke`                                       | `strokes`, `strokeWeight`, `strokeAlign`, `strokeJoin`, `strokeDashes` |
| `IndividualStrokesTrait`          | *(part of `PenCanHaveStroke`)*                           | `individualStrokeWeights: { top, right, bottom, left }` |
| `VariableWidthStrokesTrait`       | *(planned v2.x — empty placeholder in Figma today)*      | — |
| `ComplexStrokesTrait`             | *(planned v2.x — empty placeholder in Figma today)*      | — |
| `CornerTrait`                     | *(part of `PenRectangleish`)*                            | `cornerRadius`, `cornerSmoothing`, `rectangleCornerRadii` |
| `HasExportSettingsTrait`          | `PenExportable` *(new v2.0)*                             | `exportSettings: ExportSetting[]` |
| `HasEffectsTrait`                 | `PenCanHaveEffects`                                      | `effects: Effect[]` |
| `HasMaskTrait`                    | `PenMaskable` *(new v2.0)*                               | `isMask`, `maskType: ALPHA \| VECTOR \| LUMINANCE`, `isMaskOutline` (deprecated) |
| `TransitionSourceTrait`           | *(planned v2.x)*                                         | `transitionNodeID`, `transitionDuration`, `transitionEasing`, `interactions` |
| `DevStatusTrait`                  | *(planned v2.x)*                                         | `devStatus: { type, description }` |
| `AnnotationsTrait`                | `PenAnnotatable` *(new v2.0)*                            | `annotations: Annotation[]` |
| `ComponentPropertiesTrait`        | `PenComponentDefinition` *(new v2.0)*                    | `componentPropertyDefinitions: { [name]: ComponentPropertyDefinition }` |
| `TypePropertiesTrait`             | *(part of `PenText`)*                                    | `characters`, `style: TypeStyle`, `characterStyleOverrides`, `styleOverrideTable`, `lineTypes`, `lineIndentations` |
| `TextPathPropertiesTrait`         | *(planned v2.x)*                                         | — |
| `HasTextSublayerTrait`            | *(part of `PenFrame` when `metadata.hasTextSublayer`)*   | `characters` |
| `TransformModifiersTrait`         | *(planned v2.x)*                                         | — |

---

## 3. Paints (fills & strokes)

Figma's `Paint` is a discriminated union on `type`. .pen's `PenFill`
mirrors this but adds two extra paint kinds (`shader`, `mesh_gradient`)
that exist in pen.dev.

| Figma paint type     | Figma TS interface    | .pen variant                                | Notes |
| -------------------- | --------------------- | ------------------------------------------- | ----- |
| `SOLID`              | `SolidPaint`          | `{ type: 'color', color }` (or bare hex string) | .pen allows bare hex shorthand. |
| `GRADIENT_LINEAR`    | `GradientPaint`       | `{ type: 'gradient', gradientType: 'linear' }` | Figma uses 3 normalized handle vectors; .pen uses `center`, `size`, `rotation` for ergonomics. |
| `GRADIENT_RADIAL`    | `GradientPaint`       | `{ type: 'gradient', gradientType: 'radial' }`  | Same handle representation as above. |
| `GRADIENT_ANGULAR`   | `GradientPaint`       | `{ type: 'gradient', gradientType: 'angular' }` | Conic gradient. |
| `GRADIENT_DIAMOND`   | `GradientPaint`       | *(planned v2.x — fall back to radial on import)* | Rarely used; deferred. |
| `IMAGE`              | `ImagePaint`          | `{ type: 'image', url, mode }`                | Figma `imageRef` resolved to URL on import. `scaleMode: FILL/FIT/TILE/STRETCH` maps to .pen `mode: 'fill'/'fit'/'tile'/'stretch'`. |
| `PATTERN`            | `PatternPaint`        | *(planned v2.x)*                              | Tiles another node's render. |
| *(n/a)*              | *(n/a)*               | `{ type: 'shader', url, uniforms }`           | .pen-only — WebGL fragment shader fill. |
| *(n/a)*              | *(n/a)*               | `{ type: 'mesh_gradient', ... }`              | .pen-only — multi-point gradient. |

### ColorStop ↔ .pen gradient color

| Figma `ColorStop`     | .pen `{ color, position }` |
| --------------------- | -------------------------- |
| `position: 0..1`      | `position: 0..1`           |
| `color: RGBA`         | `color: '#RRGGBBAA'`       |
| `boundVariables.color`| *(resolved at write time)* |

---

## 4. Effects

| Figma effect type | Figma TS interface        | .pen variant                                          |
| ----------------- | ------------------------- | ----------------------------------------------------- |
| `DROP_SHADOW`     | `DropShadowEffect`        | `{ type: 'shadow', shadowType: 'outer', offset, radius, spread, color, blendMode }` |
| `INNER_SHADOW`    | `InnerShadowEffect`       | `{ type: 'shadow', shadowType: 'inner', offset, radius, spread, color, blendMode }` |
| `LAYER_BLUR`      | `NormalBlurEffect`        | `{ type: 'blur', radius }`                            |
| `BACKGROUND_BLUR` | `NormalBlurEffect`        | `{ type: 'background_blur', radius }`                 |
| *(PROGRESSIVE)*   | `ProgressiveBlurEffect`   | *(planned v2.x — `type: 'progressive_blur'`)*         |
| `TEXTURE`         | `TextureEffect`           | *(planned v2.x)*                                       |
| *(noise)*         | `NoiseEffect` + sub-types | *(planned v2.x)*                                       |

---

## 5. Color & alpha

| Figma             | .pen                  |
| ----------------- | --------------------- |
| `RGBA { r, g, b, a }` (each 0..1) | `'#RRGGBBAA'` hex string |
| `RGB { r, g, b }`  | `'#RRGGBB'`           |

Conversion is lossless for opaque and alpha < 1 colors. .pen does NOT
support Figma's per-color `boundVariables` natively — the variable
binding is hoisted to the field level (`fill = '$brand.primary'`).

---

## 6. Text & typography

| Figma `TypeStyle` field        | .pen `PenTextStyle` field     | Notes |
| ------------------------------ | ----------------------------- | ----- |
| `fontFamily`                   | `fontFamily`                  | |
| `fontPostScriptName`           | *(ignored)*                   | PostScript name is a font-engine detail. |
| `fontStyle`                    | `fontStyle`                   | "Bold", "Italic", "Regular" — string. |
| `italic`                       | `fontStyle: 'italic'`         | .pen encodes italic inside `fontStyle`. |
| `fontWeight`                   | `fontWeight`                  | Numeric (100..900). .pen accepts string ("Bold") too. |
| `fontSize`                     | `fontSize`                    | px. |
| `textCase`                     | *(applied as CSS `text-transform`)* | `ORIGINAL`/`UPPER`/`LOWER`/`TITLE`/`SMALL_CAPS`/`SMALL_CAPS_FORCED`. |
| `textAlignHorizontal`          | `textAlign`                   | `LEFT`/`RIGHT`/`CENTER`/`JUSTIFIED` → `left`/`right`/`center`/`justify`. |
| `textAlignVertical`            | `textAlignVertical`           | `TOP`/`CENTER`/`BOTTOM` → `top`/`middle`/`bottom`. |
| `letterSpacing`                | `letterSpacing`               | px. |
| `lineHeightPx`                 | `lineHeight`                  | px (numeric). |
| `lineHeightPercentFontSize`    | `lineHeight` (as multiplier)  | 1.5 = 150%. |
| `lineHeightUnit`               | *(derived from value type)*   | .pen: numeric = px; string like `'1.5em'` = font-size-relative. |
| `paragraphSpacing`             | *(planned v2.x)*              | |
| `paragraphIndent`              | *(planned v2.x)*              | |
| `listSpacing`                  | *(planned v2.x)*              | |
| `textDecoration`               | `underline` / `strikethrough` | .pen splits into two booleans. |
| `textAutoResize` / `textTruncation` | `textGrowth`              | .pen: `'auto'` / `'fixed-width'` / `'fixed-width-height'`. |
| `maxLines`                     | *(planned v2.x)*              | |
| `fills` (text fill)            | `fill`                        | .pen reuses the same `PenFill` type. |
| `hyperlink`                    | `href`                        | |
| `opentypeFlags`                | *(planned v2.x)*              | |
| `semanticWeight` / `semanticItalic` | *(ignored)*               | Used by Figma for override semantics. |

### Per-character overrides

Figma supports per-character styling via `characterStyleOverrides`
+ `styleOverrideTable` — e.g. colored emphasis on a single word.

.pen v2.0 supports **flat text style only** (whole-node). Per-character
overrides are stored in `metadata.characterStyleOverrides` on import
and re-emitted on export, but not editable in the UI yet.

---

## 7. Auto Layout — full mapping

This is the densest part of the Figma spec. .pen mirrors it field by
field.

| Figma field                   | Figma enum/values                | .pen field                   | .pen values                          |
| ----------------------------- | -------------------------------- | ---------------------------- | ------------------------------------ |
| `layoutMode`                  | `NONE`/`HORIZONTAL`/`VERTICAL`/`GRID` | `layout`                  | `'none'`/`'vertical'`/`'horizontal'`/`'grid'` *(new v2.0)* |
| `primaryAxisSizingMode`       | `FIXED`/`AUTO`                   | `width` *(HORIZONTAL)* / `height` *(VERTICAL)* | `'fit_content'` (=AUTO) or numeric (=FIXED) |
| `counterAxisSizingMode`       | `FIXED`/`AUTO`                   | *(opposite of primary)*      | Same as above. |
| `primaryAxisAlignItems`       | `MIN`/`CENTER`/`MAX`/`SPACE_BETWEEN` | `justifyContent`          | `'start'`/`'center'`/`'end'`/`'space_between'`/`'space_around'` |
| `counterAxisAlignItems`       | `MIN`/`CENTER`/`MAX`/`BASELINE`  | `alignItems`                 | `'start'`/`'center'`/`'end'` (BASELINE not supported) |
| `paddingLeft`/`Right`/`Top`/`Bottom` | number                  | `padding`                    | `n` \| `[v,h]` \| `[t,r,b,l]` |
| `itemSpacing`                 | number                           | `gap`                        | number |
| `itemReverseZIndex`           | boolean                          | *(planned v2.x — `reverseZIndex`)* | |
| `strokesIncludedInLayout`     | boolean                          | `layoutIncludeStroke`        | boolean |
| `layoutWrap`                  | `NO_WRAP`/`WRAP`                 | *(planned v2.x — `wrap: 'nowrap' \| 'wrap'`)* | |
| `counterAxisSpacing`          | number                           | *(planned v2.x)*             | |
| `counterAxisAlignContent`     | `AUTO`/`SPACE_BETWEEN`           | *(planned v2.x)*             | |
| `overflowDirection`           | `HORIZONTAL_SCROLLING`/`VERTICAL_SCROLLING`/`HORIZONTAL_AND_VERTICAL_SCROLLING`/`NONE` | `overflow` *(new v2.0)* | `'hidden'`/`'scroll-x'`/`'scroll-y'`/`'scroll-both'` |
| `clipsContent`                | boolean                          | `clip`                       | boolean |
| `layoutGrids`                 | `LayoutGrid[]`                   | `metadata.layoutGrids`       | Same shape. |

### Child-of-Auto-Layout fields

| Figma field          | Figma enum/values                | .pen field             | Notes |
| -------------------- | -------------------------------- | ---------------------- | ----- |
| `layoutAlign`        | `INHERIT`/`STRETCH`/`MIN`/`CENTER`/`MAX` | `layoutAlign` *(new v2.0)* | Cross-axis alignment override. |
| `layoutGrow`         | `0`/`1`                          | `layoutGrow` *(new v2.0)* | 0=fixed, 1=stretch. |
| `layoutPositioning`  | `AUTO`/`ABSOLUTE`                | `layoutPosition`        | `'auto'`/`'absolute'`. |
| `minWidth`/`maxWidth`/`minHeight`/`maxHeight` | number | `minWidth`/`maxWidth`/`minHeight`/`maxHeight` *(new v2.0)* | |
| `layoutSizingHorizontal` | `FIXED`/`HUG`/`FILL`          | `width`                 | `number` (FIXED) / `'fit_content'` (HUG) / `'fill_container'` (FILL) |
| `layoutSizingVertical`   | `FIXED`/`HUG`/`FILL`          | `height`                | Same. |

### Grid-specific fields (when `layoutMode: "GRID"`)

| Figma field              | .pen field           | Notes |
| ------------------------ | -------------------- | ----- |
| `gridRowCount`           | `gridRowCount` *(new)* | |
| `gridColumnCount`        | `gridColumnCount` *(new)* | |
| `gridRowGap`             | `gridRowGap` *(new)* | |
| `gridColumnGap`          | `gridColumnGap` *(new)* | |
| `gridColumnsSizing`      | `gridColumnsSizing` *(new)* | CSS `grid-template-columns` string. |
| `gridRowsSizing`         | `gridRowsSizing` *(new)* | CSS `grid-template-rows` string. |
| `gridChildHorizontalAlign` | `gridChildHorizontalAlign` *(new)* | `AUTO`/`MIN`/`CENTER`/`MAX`. |
| `gridChildVerticalAlign` | `gridChildVerticalAlign` *(new)* | Same. |
| `gridRowSpan`            | `gridRowSpan` *(new)* | Default 1. |
| `gridColumnSpan`         | `gridColumnSpan` *(new)* | Default 1. |

---

## 8. Constraints

| Figma `LayoutConstraint` | .pen `PenLayoutConstraint` *(new v2.0)* |
| ------------------------ | --------------------------------------- |
| `vertical: TOP`          | `vertical: 'top'`                       |
| `vertical: BOTTOM`       | `vertical: 'bottom'`                    |
| `vertical: CENTER`       | `vertical: 'center'`                    |
| `vertical: TOP_BOTTOM`   | `vertical: 'top_bottom'`                |
| `vertical: SCALE`        | `vertical: 'scale'`                     |
| `horizontal: LEFT`       | `horizontal: 'left'`                    |
| `horizontal: RIGHT`      | `horizontal: 'right'`                   |
| `horizontal: CENTER`     | `horizontal: 'center'`                  |
| `horizontal: LEFT_RIGHT` | `horizontal: 'left_right'`              |
| `horizontal: SCALE`      | `horizontal: 'scale'`                   |

---

## 9. Components, Variants, Instances

### 9.1 Component definition

A `ComponentNode` in Figma is a Frame that can be instanced. In .pen,
this is a `PenFrame` (or any node) with `reusable: true`.

| Figma field                    | .pen field                              | Notes |
| ------------------------------ | --------------------------------------- | ----- |
| `type: "COMPONENT"`            | `type: 'frame'` + `reusable: true`      | |
| `componentPropertyDefinitions` | `metadata.componentProperties` *(new v2.0)* | Map of name → definition. |
| `documentationLinks`           | *(planned v2.x)*                        | |

### 9.2 Component Set (variant family)

| Figma field          | .pen field                                | Notes |
| -------------------- | ----------------------------------------- | ----- |
| `type: "COMPONENT_SET"` | `type: 'frame'` + `metadata.isComponentSet: true` | |
| `componentPropertyDefinitions` (with `VARIANT` types) | `metadata.componentProperties` | The variant axes. |

### 9.3 Instance

| Figma field                | .pen field                       | Notes |
| -------------------------- | -------------------------------- | ----- |
| `type: "INSTANCE"`         | `type: 'ref'`                    | |
| `componentId`              | `ref`                            | ID of the referenced Component. |
| `componentProperties`      | *(passed via `descendants`)*     | Variant/boolean/text/instance-swap overrides. |
| `overrides`                | `descendants[idPath]`            | Per-descendant property overrides. |
| `isExposedInstance`        | *(planned v2.x)*                 | |
| `exposedInstances`         | *(planned v2.x)*                 | |

### 9.4 Component Property types

| Figma `ComponentPropertyType` | .pen encoding                                    |
| ----------------------------- | ------------------------------------------------ |
| `BOOLEAN`                     | `{ type: 'boolean', defaultValue: false }`       |
| `TEXT`                        | `{ type: 'string', defaultValue: 'Label' }`      |
| `INSTANCE_SWAP`               | `{ type: 'instance_swap', defaultValue: 'compId', preferredValues: [...] }` |
| `VARIANT`                     | `{ type: 'variant', variantOptions: ['Default', 'Hover', ...] }` |

---

## 10. Variables, Modes, Collections

### 10.1 Variable

| Figma `LocalVariable` field | .pen `PenVariableDef` field                |
| --------------------------- | ------------------------------------------ |
| `id`                        | *(key in `variables` map)*                 |
| `name`                      | *(key in `variables` map)*                 |
| `key`                       | *(ignored — Figma-publishing detail)*      |
| `variableCollectionId`      | *(derived from theme axis name)*           |
| `resolvedType: BOOLEAN`     | `type: 'boolean'`                          |
| `resolvedType: FLOAT`       | `type: 'number'`                           |
| `resolvedType: STRING`      | `type: 'string'`                           |
| `resolvedType: COLOR`       | `type: 'color'`                            |
| `valuesByMode`              | `value` (single) or `value: ThemedValue[]` |
| `description`               | *(planned v2.x — `metadata.description`)*  |
| `scopes`                    | *(planned v2.x — `metadata.scopes`)*       |
| `codeSyntax`                | *(planned v2.x — `metadata.codeSyntax`)*   |
| `hiddenFromPublishing`      | *(planned v2.x)*                            |

### 10.2 Variable Collection

| Figma `LocalVariableCollection` field | .pen equivalent                          |
| ------------------------------------- | ---------------------------------------- |
| `id` / `name`                         | *(key in `themes` map)*                  |
| `modes: [{ modeId, name }]`           | `themes[axis] = [value1, value2, ...]`   |
| `defaultModeId`                       | *(first value in array)*                 |
| `variableIds`                         | *(derived — variables reference this axis by name)* |
| `isExtension` / `parentVariableCollectionId` | *(planned v2.x)*                  |

### 10.3 Bound variables

In Figma, a node field can be bound to a variable via
`boundVariables: { fieldName: { type: 'VARIABLE_ALIAS', id } }`.

In .pen, the same binding is expressed by replacing the literal value
with a `$variable-name` string:

```
// Figma
{ fills: [{ type: 'SOLID', color: { r: 0.2, g: 0.4, b: 0.8, a: 1 } }],
  boundVariables: { fills: [{ type: 'VARIABLE_ALIAS', id: 'VariableID:1:42' }] } }

// .pen
{ fill: '$brand.primary' }
```

---

## 11. Boolean operations

| Figma field                | .pen `PenBooleanOp` field          |
| -------------------------- | ---------------------------------- |
| `type: "BOOLEAN_OPERATION"` | `type: 'boolean_op'` *(new v2.0)* |
| `booleanOperation: UNION`    | `operation: 'union'`              |
| `booleanOperation: INTERSECT`| `operation: 'intersect'`          |
| `booleanOperation: SUBTRACT` | `operation: 'subtract'`           |
| `booleanOperation: EXCLUDE`  | `operation: 'exclude'`            |
| `children: Node[]`           | `children: PenChild[]`            |

The result is non-destructive — the original children remain in the
tree and the boolean is resolved at render time.

---

## 12. Mask

| Figma `HasMaskTrait` field | .pen `PenMaskable` field *(new v2.0)* |
| -------------------------- | ------------------------------------- |
| `isMask: true`             | `metadata.isMask = true`              |
| `maskType: ALPHA`          | `metadata.maskType = 'alpha'`         |
| `maskType: VECTOR`         | `metadata.maskType = 'vector'`        |
| `maskType: LUMINANCE`      | `metadata.maskType = 'luminance'`     |

A mask node clips the visibility of its siblings in front of it. In
.pen, the masking semantics are the same — a mask node masks all
following siblings within its parent.

---

## 13. Stroke — full detail

| Figma field               | .pen field                | Notes |
| ------------------------- | ------------------------- | ----- |
| `strokes: Paint[]`        | `stroke: PenFills`        | |
| `strokeWeight`            | `strokeWidth`             | Uniform. |
| `individualStrokeWeights` | `strokeWidth: { top, right, bottom, left }` | Per-side. |
| `strokeAlign`             | `strokeAlignment`         | `INSIDE`/`OUTSIDE`/`CENTER` → `'inner'`/`'outer'`/`'center'`. |
| `strokeJoin`              | `strokeLinejoin`          | `MITER`/`BEVEL`/`ROUND` → `'miter'`/`'bevel'`/`'round'`. |
| `strokeCap`               | `strokeLinecap`           | `NONE`/`ROUND`/`SQUARE`/`LINE_ARROW`/… → `'butt'`/`'round'`/`'square'`/… |
| `strokeDashes`            | `strokeDashes` *(new v2.0)* | `[dash, gap, ...]` numeric array. |
| `strokeMiterAngle`        | `strokeMiterLimit` *(new v2.0)* | Default 28.96°. |

---

## 14. Layout grids (guides, not Auto Layout)

| Figma `LayoutGrid` field | .pen `PenLayoutGrid` *(new v2.0)* |
| ------------------------ | --------------------------------- |
| `pattern: COLUMNS`       | `pattern: 'columns'`              |
| `pattern: ROWS`          | `pattern: 'rows'`                 |
| `pattern: GRID`          | `pattern: 'grid'`                 |
| `sectionSize`            | `sectionSize`                     |
| `visible`                | `visible`                         |
| `color`                  | `color`                           |
| `alignment: MIN/MAX/STRETCH/CENTER` | `alignment`           |
| `gutterSize`             | `gutterSize`                      |
| `offset`                 | `offset`                          |
| `count`                  | `count`                           |

---

## 15. Blend modes

Figma and .pen share the same 18 blend modes. .pen uses camelCase
(`linearBurn`) while Figma uses SCREAMING_SNAKE (`LINEAR_BURN`).
Conversion is mechanical.

| Figma              | .pen           |
| ------------------ | -------------- |
| `PASS_THROUGH`     | *(mapped to `normal` on import — .pen has no pass-through concept for non-frames)* |
| `NORMAL`           | `normal`       |
| `DARKEN`           | `darken`       |
| `MULTIPLY`         | `multiply`     |
| `LINEAR_BURN`      | `linearBurn`   |
| `COLOR_BURN`       | `colorBurn`    |
| `LIGHTEN`          | `lighten`      |
| `SCREEN`           | `screen`       |
| `LINEAR_DODGE`     | `linearDodge`  |
| `COLOR_DODGE`      | `colorDodge`   |
| `OVERLAY`          | `overlay`      |
| `SOFT_LIGHT`       | `softLight`    |
| `HARD_LIGHT`       | `hardLight`    |
| `DIFFERENCE`       | `difference`   |
| `EXCLUSION`        | `exclusion`    |
| `HUE`              | `hue`          |
| `SATURATION`       | `saturation`   |
| `COLOR`            | `color`        |
| `LUMINOSITY`       | `luminosity`   |

---

## 16. Easing

| Figma `EasingType`   | .pen value            |
| -------------------- | --------------------- |
| `EASE_IN`            | `'ease_in'`           |
| `EASE_OUT`           | `'ease_out'`          |
| `EASE_IN_AND_OUT`    | `'ease_in_out'`       |
| `LINEAR`             | `'linear'`            |
| `EASE_IN_BACK`       | `'ease_in_back'`      |
| `EASE_OUT_BACK`      | `'ease_out_back'`     |
| `EASE_IN_AND_OUT_BACK` | `'ease_in_out_back'` |
| `CUSTOM_CUBIC_BEZIER` | `[x1, y1, x2, y2]`   |

*(Easing only matters for prototyping transitions — v2.x roadmap.)*

---

## 17. What we deliberately drop

These Figma concepts are **out of scope** for AgentCanvas v2.0:

- **FigJam-only nodes**: `STICKY` (mapped to `PenNote`), `CONNECTOR`,
  `SHAPE_WITH_TEXT`, `WASHI_TAPE`, `LINK_UNFURL`.
- **Widget nodes**: `WIDGET` — runs a sandboxed React runtime.
- **Tables**: `TABLE` / `TABLE_CELL` — planned for v2.x.
- **Text paths**: `TEXT_PATH` — planned for v2.x.
- **Transform groups**: `TRANSFORM_GROUP` — planned for v2.x.
- **Progressive blur**: `ProgressiveBlurEffect` — planned for v2.x.
- **Texture & noise effects**: deferred.
- **Pattern paint**: `PatternPaint` — planned for v2.x.
- **Prototyping transitions**: `TransitionSourceTrait`,
  `Interactions`, `Triggers`, `Actions` — v2.x roadmap.
- **Dev status**: `DevStatusTrait` — v2.x roadmap.
- **Plugin data**: `pluginData` / `sharedPluginData` — runtime-only,
  never serialized to .pen.
- **Semantic weight/italic**: `semanticWeight`, `semanticItalic` —
  Figma internal bookkeeping for text-style overrides.
- **Per-character text styles**: stored on import as
  `metadata.characterStyleOverrides` but not editable in UI yet.

---

## 18. References

- Figma REST API: <https://developers.figma.com/docs/rest-api>
- Figma Plugin API: <https://www.figma.com/plugin-docs/>
- Figma OpenAPI spec (cached): `research/figma-ontology/openapi-figma.yaml`
- Figma Variables: <https://help.figma.com/hc/en-us/articles/15339657135383-Guide-to-variables-in-Figma>
- Figma Component Properties: <https://help.figma.com/hc/en-us/articles/5559363925015>
- Penpot: <https://help.penpot.app/developer-guide/>
- tldraw: <https://tldraw.dev/docs/shapes>
- W3C Design Tokens: <https://www.w3.org/community/design-tokens/>
