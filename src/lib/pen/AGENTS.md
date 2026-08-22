# AGENTS.md — `src/lib/pen/`

## Purpose

The .pen format layer: canonical TypeScript schema for the pen.dev .pen file format, the tree resolver that converts the object tree to a flat render list, document-tree mutation helpers, and CanvasDocument <-> PenDocument converters. This is the .pen-aligned core of AgentCanvas — the agent tools, import/export routes, and canvas renderer all reference these types.

## Ownership

- `types.ts` — The canonical .pen format TypeScript schema (transcribed from https://docs.pen.dev/for-developers/the-pen-format). Defines `PenDocument`, `PenChild` (discriminated union of 20 node types), `PenPage` + multi-page support (`pages`, `activePageIndex`), `PenTheme`, `PenVariableDef`, `PenLayout`, and all graphics/fill/effect/component property types. Versioned via `PEN_FORMAT_VERSION = '2.17'`.
- `resolve.ts` — The resolve engine: expands `ref` instances, computes absolute positions via a two-pass flexbox layout engine (bottom-up intrinsic sizing + top-down positioning), resolves `$variable` references honoring inherited themes, maps each .pen node to a `Shape` (the renderer's flat render type). Exports `resolvePenTree(doc: CanvasDocument): Shape[]`.
- `document.ts` — Pure tree helpers: `walkTree`, `findNode`, `findNodeArray`, `collectComponents`, `deepCloneNode`, `insertNode`, `removeNode`, `moveNode`, `isDescendant`, `getAncestorOffset`, `getAbsolutePosition`, `updateNode`, `expandRef`, `newId()` (plus module-private `applyDescendants` / `findBySourcePath` used internally). Browser-safe, no React/Node dependencies.
- `converters.ts` — Near-identity converters: `canvasToPen` (strips runtime/derived caches), `penToCanvas` (wraps with runtime defaults + empty derived caches), `serializePenDocument` (pretty JSON for download).

## Local Contracts

### .pen Format Version
- `PEN_FORMAT_VERSION = '2.17'` (constant in `types.ts`). Update when pen.dev releases a breaking schema change. All import/export/converters must reference this constant.

### Node Type Coverage (20 types)
`PenChild` discriminated union covers: `frame`, `section`, `component`, `component_set`, `boolean_operation`, `slice`, `group`, `rectangle`, `ellipse`, `star`, `polygon`, `path`, `line`, `text`, `note`, `context`, `prompt`, `icon`, `script`, `ref`. The resolver's `mapNodeType()` maps these to the renderer's `Layer['type']` (8 base types: rectangle, ellipse, text, line, frame, group, path, image + extended: section, component, component_set, boolean_operation, slice, star, polygon).

### Pages abstraction
`PenPage` (`types.ts`) extends the canonical Document with Figma-style multi-page support: `CanvasDocument.pages?: PenPage[]` + `activePageIndex`. The `figma_*` page tools and the `add_page` / `delete_page` / `rename_page` / `set_active_page` patch ops operate on it; the converters round-trip pages between canvas and .pen form.

### Resolve Engine Contract (`resolve.ts`)
- **Input**: `CanvasDocument` (which extends `PenDocument` + adds `shapes`, `tokens`, `background` derived caches).
- **Output**: `Shape[]` — flat depth-first list with absolute positions, expanded refs, resolved variables/themes, and all graphics mapped to `Shape` fields (`fill`, `stroke`, `radius`, `radii`, `gradient`, `shadow`, `blur`, `maskId`, `autoLayout`, `tokenBinding`, `componentId`, `points`, `closed`, `src`, `constraints`, Figma ontology extensions).
- **Two-pass layout**:
  1. Bottom-up: compute intrinsic sizes (`fit_content` derives from children).
  2. Top-down: position children inside parent content box per flexbox rules (`justifyContent`, `alignItems`, `gap`, `padding`).
- **Theme inheritance**: each node's effective theme = parent theme merged with own `theme` property. Variable resolution honors the effective theme (themed values: last matching theme wins).
- **Ref expansion**: `ref` nodes deep-clone their target component, apply `descendants` overrides (by slash-separated source-id path), tag clone with `componentId = ref.ref` for component-instance badging.
- **Null-safety**: all property access uses optional chaining + `num()` helper for numeric coercion.

### Document Helpers Contract (`document.ts`)
- All functions are **pure** and **immutable** (return new trees, never mutate input).
- Tree operations assume `frame` and `group` are the only container types with `children` (the legacy container set). The resolver additionally handles `section`, `component`, `component_set`, `boolean_operation`.
- `getAncestorOffset` / `getAbsolutePosition` compute cumulative relative x/y — **ignores auto-layout positioning** (known limitation, documented).
- `expandRef` tags each cloned node with `_sourceId` so descendant overrides (which reference source ids) still work after cloning.

### Converters Contract (`converters.ts`)
- `canvasToPen`: keeps only canonical .pen fields (`version`, `themes`, `imports`, `variables`, `children`). Strips `id`, `name`, `viewport`, `background`, `shapes`, `tokens`.
- `penToCanvas`: adds runtime defaults (`id`, `name`, `viewport`, `background`) + empty derived caches (`shapes: []`, `tokens: {colors: [], textStyles: []}`). Derived caches are recomputed by the store via `resolvePenTree` + `variablesToTokens`.
- `serializePenDocument`: `JSON.stringify(doc, null, 2) + '\n'` — used by `/api/pen/export` and `pen_export_pen` tool.

### Type Guards
- `isPenNode(value)` — narrows to `PenChild` (checks `type` against `PEN_NODE_TYPES` const array).
- `isPenDocument(value)` — validates top-level shape (version string + children array of PenNodes).
- `isContainerNode(node)` — type guard for nodes with `children` (frame, group, section, component, component_set, boolean_operation).

## Work Guidance

- When pen.dev releases a schema update: update `types.ts` (add/remove fields, bump `PEN_FORMAT_VERSION`), then check `resolve.ts` (mapping logic), `document.ts` (if new container types), `converters.ts` (usually no change — near-identity), and `src/lib/canvas/types.ts` (Shape extensions).
- When adding a new .pen-aligned agent tool: the tool schema should reference `PenChild` / `PenDocument` types from here. The tool implementation will call `resolvePenTree` or use `document.ts` helpers.
- When changing the resolver: the output `Shape[]` is consumed by `src/lib/canvas/store.ts` (replaces `document.shapes`), `src/components/canvas/Canvas.tsx` (renders shapes), and `src/components/canvas/LayersPanel.tsx` (tree from `document.children`). All three must stay in sync.
- The resolver is the **single source of truth** for absolute positions. Do not compute positions elsewhere.

## Verification

- `bunx tsc --noEmit` — typecheck.
- `bun run test` — unit tests in `tests/unit/` (patch, tools, store, ShapeRenderer, registry, clipboard) exercise the resolver indirectly.
- Manual: import a .pen file via the UI — verify the canvas renders correctly, variables resolve, themes apply, refs expand, auto-layout works.
- Manual: export a .pen file — verify the downloaded file is valid JSON with correct `version`, `children`, `variables`, `themes`.

## Child DOX Index

No child `AGENTS.md` files. This folder is flat: `types.ts`, `resolve.ts`, `document.ts`, `converters.ts`.

*Siblings: `../agent/AGENTS.md` (Agent layer), `../canvas/AGENTS.md` (Canvas state), `../sessions/AGENTS.md` (Session persistence), `../settings/AGENTS.md` (Settings store), `../web/AGENTS.md` (Web search/fetch), `../llm/AGENTS.md` (LLM provider registry).*