# AGENTS.md — `src/lib/pen/`

## Purpose

The .pen format layer: canonical TypeScript schema for the pen.dev .pen file format, the Figma-ontology enum tables (v3 vocabulary authority), the alias normalizer + 2.17→3.0 document migration, the tree resolver that converts the object tree to a flat render list, document-tree mutation helpers, and CanvasDocument <-> PenDocument converters. This is the .pen-aligned core of AgentCanvas — the agent tools, import/export routes, and canvas renderer all reference these types.

## Ownership

- `types.ts` — The canonical .pen format TypeScript schema (transcribed from https://docs.pen.dev/for-developers/the-pen-format). Defines `PenDocument`, `PenChild` (discriminated union of 20 node types), `PenPage` + multi-page support (`pages`, `activePageIndex`), `PenTheme`, `PenVariableDef`, `PenLayout`, and all graphics/fill/effect/component property types. Versioned via `PEN_FORMAT_VERSION = '2.17'` (legacy baseline) + `PEN_FORMAT_VERSION_V3 = '3.0'` (Figma-canonical export stamp). ALSO carries the v3 dual-carry field mirrors (spec Phase 6 part 1): optional `layoutMode`/`itemSpacing`/`paddingLeft…`/`primaryAxisAlignItems`/`counterAxisAlignItems`/`layoutSizing*`/`layoutPositioning`/`fills: FigmaPaint[]`/`strokes`/`strokeWeight`/`effects: FigmaEffect[]`/`rectangleCornerRadii`/`characters`/`textAutoResize`/`visible`/`blendMode`/`explicitVariableModes`/`boundVariables` on nodes; `variableCollections`/`variableRecords` on the document. ALL optional + additive — legacy readers are untouched.
- `figma-ontology.ts` — **The vocabulary authority** (spec Phase 6, §9.1/Appendix G): the frozen canonical enum tables (`FIGMA_LAYOUT_MODE`, `FIGMA_AXIS_ALIGN`, `FIGMA_LAYOUT_SIZING`, `FIGMA_PAINT_TYPE`, `FIGMA_SCALE_MODE`, `FIGMA_EFFECT_TYPE`, `FIGMA_CONSTRAINT_H/V`, `FIGMA_VARIABLE_TYPE`, `FIGMA_BLEND_MODE`, `FIGMA_ALIGN_KIND`, …) in Figma-REST spellings (SCREAMING_SNAKE values, camelCase fields), the per-domain `FIGMA_ENUM_ALIASES` legacy→canonical maps (G.2), `FIGMA_ALIAS_MERGES` (documented non-injective merges: light/lighten→LIGHTEN, pass_through/pass-through→PASS_THROUGH), and `normalizeEnum(domain, value)` (total; null on unknown). Snapshot-frozen by tests/unit/figma-ontology-contract.test.ts — vocabulary changes must be deliberate.
- `normalize.ts` — **The parse-boundary alias normalizer** (spec §9.3 #1, G.2/G.4): per-domain normalizers (`normalizeLayoutMode`, `normalizeAxisAlign`, `normalizeConstraintsH/V`, `normalizeVariableType`, `normalizeBlendMode`, `normalizeAlignKind`, … — pure, total, unknown passthrough; `{ strict: true }` throws for tests), fill/stroke/effect converters (`fillsToFigmaPaints`, `effectsToFigmaEffects`, `gradientAngleToHandles` per G.1 row 24), `normalizePenNode` (legacy spellings in → v3 fields populated out, legacy kept — DUAL-CARRY; idempotent), and `normalizePatchPayload` (G.4: patch op/field names FROZEN per §5.1, only enum VALUES normalize — alignKind canonicalized UP; constraints/variableType accept canonical but store the LEGACY spelling so legacy readers + tests stay byte-identical).
- `migrate.ts` — **2.17 → 3.0 document migration** (spec Phase 6, §9.3 #2): `migratePenDocument(doc)` — deterministic (name-derived ids: `col:<axis>`, `var:<key>`, `mode:<axis>:<value>` — no clock/random), total (never throws), idempotent (version >= 3 early-returns = the idempotence gate). Applies every G.1 row: themes→variableCollections, variables $key map→variableRecords (valuesByMode keyed by modeId; compound legacy themes assign to each constituent mode — documented approximation; `$ref` values become VARIABLE_ALIAS entries), nodes dual-carry via normalizePenNode + constraints→SCREAMING + groups default blendMode PASS_THROUGH. Wired into converters (export writes v3 / import migrates-on-read).
- `resolve.ts` — The resolve engine: expands `ref` instances, computes absolute positions via a two-pass flexbox layout engine (bottom-up intrinsic sizing + top-down positioning), resolves `$variable` references honoring inherited themes, maps each .pen node to a `Shape` (the renderer's flat render type). Exports `resolvePenTree(doc: CanvasDocument): Shape[]` and `resolvePenTreeDetailed(doc, opts): { layers, tree, warnings }`. RESOLVER WARNINGS: every degradation site collects a `ResolverWarning` (kinds: placeholder_size, dropped_ref, ref_unexpanded, unknown_node_type, unresolved_variable, path_geometry_dropped, effects_dropped) — deduped by (nodeId, kind), mirrored into the optional `ResolveOpts.warnings` accumulator; delivered to the LLM by pen_get_metadata + the runner's canvasSnapshot. The degradation checks sit in the per-node hot path and MUST stay O(1) (Set lookups / presence guards) — a naive `PEN_NODE_TYPES.includes(String(...))` per node added ~2s to the 4k-node audit test. ALSO emits the v3 Layer mirrors (`applyV3Mirrors` — spec Phase 6 dual-field output: `layoutMode`/`itemSpacing`/`padding*`/`primary+counterAxisAlignItems`/`layoutSizing*`/`characters`/`textAutoResize`/`rectangleCornerRadii`/`fills`/`effects`) ALONGSIDE unchanged legacy fields — single source, two projections. `applyConstraintH/V` tolerate BOTH constraint casings (legacy lowercase from patches, SCREAMING from migrated files) with identical behavior.
- `document.ts` — Pure tree helpers: `walkTree`, `findNode`, `findNodeArray`, `collectComponents`, `deepCloneNode`, `insertNode`, `removeNode`, `moveNode`, `isDescendant`, `getAncestorOffset`, `getAbsolutePosition`, `updateNode`, `expandRef`, `newId()` (plus module-private `applyDescendants` / `findBySourcePath` / `expandRefAtDepth` / `expandNestedRefs` used internally). Browser-safe, no React/Node dependencies. NOTE: all walk/mutate helpers descend into EVERY container type (frame, group, section, component, component_set, boolean_operation) — `updateNode` included (bug fix: it previously only descended frame/group, so update patches silently no-opped on nodes inside sections/components).
- `converters.ts` — Near-identity converters: `canvasToPen` (strips runtime/derived caches; **migrates to v3 — exported files carry `version: '3.0'` + canonical fields WITH legacy dual-carry kept, so old code can still load them**), `penToCanvas` (wraps with runtime defaults + empty derived caches; **migrate-on-read — any 2.x or version-less doc upgrades through migratePenDocument, forever**), `serializePenDocument` (pretty JSON for download).

## Local Contracts

### .pen Format Version
- `PEN_FORMAT_VERSION = '2.17'` (legacy baseline, constant in `types.ts`) / `PEN_FORMAT_VERSION_V3 = '3.0'` (Figma-canonical export stamp). All import/export/converters reference these constants. `PenDocument.version` is a plain `string` (2.x or 3.x).

### Figma ontology v3 / dual-field window (spec Phase 6 part 1)
- **figma-ontology.ts is the vocabulary authority** — every enum spelling (serialized values AND the TS unions in types.ts/canvas/types.ts) derives from its tables; drift is caught by the contract test's snapshot.
- **Dual-carry**: migrated/normalized nodes carry BOTH spellings (`gap` + `itemSpacing`); the document carries `themes` + `variableCollections` and `variables` (legacy $key map, still what the resolver/tools read) + `variableRecords` (v3 id'd records). Legacy field READS are never removed or altered during the window — Phase 6 part 2 migrates consumers.
- **Value-casing policy**: `normalizePatchPayload` accepts canonical spellings for constraints/variableType but STORES legacy (legacy readers match on it); `migratePenDocument` writes canonical SCREAMING constraints + blend modes into the serialized v3 form; the resolver's constraint application tolerates both casings identically.
- **Migrate-on-read, export v3**: `penToCanvas` upgrades 2.x docs forever; `canvasToPen` writes 3.0. Migration is idempotent + deterministic (name-derived ids) — asserted in tests/unit/pen-migration.test.ts.

### Node Type Coverage (20 types)
`PenChild` discriminated union covers: `frame`, `section`, `component`, `component_set`, `boolean_operation`, `slice`, `group`, `rectangle`, `ellipse`, `star`, `polygon`, `path`, `line`, `text`, `note`, `context`, `prompt`, `icon`, `script`, `ref`. The resolver's `mapNodeType()` maps these to the renderer's `Layer['type']` (8 base types: rectangle, ellipse, text, line, frame, group, path, image + extended: section, component, component_set, boolean_operation, slice, star, polygon).

### Pages abstraction
`PenPage` (`types.ts`) extends the canonical Document with Figma-style multi-page support: `CanvasDocument.pages?: PenPage[]` + `activePageIndex`. The `figma_*` page tools and the `add_page` / `delete_page` / `rename_page` / `set_active_page` patch ops operate on it; the converters round-trip pages between canvas and .pen form.

### Resolve Engine Contract (`resolve.ts`)
- **Input**: `CanvasDocument` (which extends `PenDocument` + adds `shapes`, `tokens`, `background` derived caches).
- **Output**: `Shape[]` — flat depth-first list with absolute positions, expanded refs, resolved variables/themes, and all graphics mapped to `Shape` fields (`fill`, `stroke`, `radius`, `radii`, `gradient`, `shadow`, `blur`, `maskId`, `autoLayout`, `tokenBinding`, `componentId`, `points`, `closed`, `src`, `constraints`, Figma ontology extensions).
- **Two-pass layout**:
  1. Bottom-up: compute intrinsic sizes (`fit_content` derives from children).
  2. Top-down: position children inside parent content box per flexbox rules (`justifyContent`, `alignItems`, `gap`, `padding`). Enforced by the dedicated `layoutTree()` post-pass inside `resolvePenTree`: a container's children are laid out only AFTER the container's own absolute position is final, recursively. (Bug fix: previously each recursion level laid out its own children immediately, while containers nested ≥ 2 levels deep still had absX/absY = 0 — grandchildren rendered missing all ancestor offsets above depth 1. Caught by tests/unit/patch-edge-bugs.test.ts + the nested-frame probe.)
- **Theme inheritance**: each node's effective theme = parent theme merged with own `theme` property. Variable resolution honors the effective theme (themed values: last matching theme wins).
- **Ref expansion**: `ref` nodes deep-clone their target component, apply `descendants` overrides (by slash-separated source-id path), tag clone with `componentId = ref.ref` for component-instance badging. Nested refs are expanded RECURSIVELY (D3 fix): a component whose subtree contains a `ref` to another component gets that instance expanded too (clone + overrides + fresh ids). Cycle protection: expansion is cut when a component transitively references itself (ancestor chain set) or nesting exceeds `MAX_REF_DEPTH` (16); leftover raw `ref` nodes map to a plain rectangle in the resolver (Figma-style cycle guard).
- **Null-safety**: all property access uses optional chaining + `num()` helper for numeric coercion.

### Document Helpers Contract (`document.ts`)
- All functions are **pure** and **immutable** (return new trees, never mutate input).
- Tree operations assume `frame` and `group` are the only container types with `children` (the legacy container set). The resolver additionally handles `section`, `component`, `component_set`, `boolean_operation`.
- `getAncestorOffset` / `getAbsolutePosition` compute cumulative relative x/y — **ignores auto-layout positioning** (known limitation, documented).
- `expandRef` tags each cloned node with `_sourceId` so descendant overrides (which reference source ids) still work after cloning. It expands nested refs recursively (depth-capped at 16, cycle-guarded — see the Resolve Engine Contract above; D3 fix), preserving `_sourceId` tagging and the nested ref's own `descendants` overrides + root overrides.

### Converters Contract (`converters.ts`)
- `canvasToPen`: keeps the canonical .pen fields (`version`, `themes`, `imports`, `variables`, `variableCollections`, `variableRecords`, `children`, `pages`) — strips `id`, `name`, `viewport`, `background`, `shapes`, `tokens` — then migrates to v3 when the version is < 3.0 (exported files stamp `'3.0'`).
- `penToCanvas`: migrate-on-read (2.x → 3.0 through `migratePenDocument`), then adds runtime defaults (`id`, `name`, `viewport`, `background`) + empty derived caches (`shapes: []`, `tokens: {colors: [], textStyles: []}`). Derived caches are recomputed by the store via `resolvePenTree` + `variablesToTokens`.
- `serializePenDocument`: `JSON.stringify(doc, null, 2) + '\n'` — used by `/api/pen/export` and `pen_export_pen` tool.

### Type Guards
- `isPenNode(value)` — narrows to `PenChild` (checks `type` against `PEN_NODE_TYPES` const array).
- `isPenDocument(value)` — validates top-level shape (version string + children array of PenNodes).
- `isContainerNode(node)` — type guard for nodes with `children` (frame, group, section, component, component_set, boolean_operation).

### Incremental resolve caches (Phase C, R9c — read before touching resolve.ts)

`resolvePenTreeDetailed` runs on EVERY document mutation (recomputeDerived at the tail of every `applyPatchToCanvas`, DomCanvas native-mode useMemo, canvasSnapshot per agent turn, the journal fold per row). Two module-level WeakMap caches key on PEN NODE OBJECT identity and reuse previous results:

1. **Expansion cache** (`expandTree`): while a container's children ARRAY keeps its identity, the previous expansion result is reused — same expanded array, same cached container clone, same ref-expansion subtrees (instance-descendant ids are STABLE across resolves now; they used to regenerate per call). Unchanged containers are returned AS-IS, so `ResolvedTreeNode.pen` IS the source node.
2. **Emit cache**: per node, the emitted `Shape` + resolved subtree + emit-time warnings are reused when every emit input is unchanged, stamped by: an order-sensitive subtree hash (node id + version + post-layout geometry, mixed with the kids' hashes recursively), a content-stamped theme chain (`themeStamp`), a memoized serialization of `doc.variables`, `parentId`, and the node's own `zIndex`. measuredBounds is deliberately NOT a stamp field — hints influence the emit only THROUGH phase-2 geometry, which IS stamped, so measuring one node invalidates exactly its ancestors and subtree.

HARD RULES:
- The pen tree is IMMUTABLE (path-copy on update). In-place mutation of a node or its children array goes UNNOTICED by these caches — always go through the applier's pure helpers (`insertNode`/`updateNode`/`removeNode`).
- The emit reads EXACTLY: node fields, `rn.absX/absY/width/height/theme`, `doc.variables`, `parentId`, the DFS `zIndex` counter. If you add a new external input to the emit, ADD IT TO THE STAMP or you will serve stale shapes.
- Emitted `Shape` objects are shared across resolves on cache hits — nothing may mutate a Shape after emit.
- `applyPatchToCanvas` shallow-clones every TOP-LEVEL child per patch, so top-level emit entries never hit across patches — that churn stops at depth 1 (where the node count lives); do not "fix" the defensive clone without proving no op mutates in place.
- Test hook: `__clearResolveCachesForTests()` + `resolveCacheStats` (emitHits/emitMisses). Identity-reuse contract is pinned by `tests/unit/resolve-cache.test.ts`.

## Work Guidance

- When pen.dev releases a schema update: update `types.ts` (add/remove fields, bump `PEN_FORMAT_VERSION`), then check `resolve.ts` (mapping logic), `document.ts` (if new container types), `converters.ts` (usually no change — near-identity), and `src/lib/canvas/types.ts` (Shape extensions).
- When adding a new .pen-aligned agent tool: the tool schema should reference `PenChild` / `PenDocument` types from here. The tool implementation will call `resolvePenTree` or use `document.ts` helpers.
- When changing the resolver: the output `Shape[]` is consumed by `src/lib/canvas/store.ts` (replaces `document.shapes`), `src/components/canvas/Canvas.tsx` (renders shapes), and `src/components/canvas/LayersPanel.tsx` (tree from `document.children`). All three must stay in sync.
- The resolver is the **single source of truth** for absolute positions. Do not compute positions elsewhere.

## Verification

- `bunx tsc --noEmit` — typecheck.
- `bun run test` — unit tests in `tests/unit/` exercise this layer directly via `figma-ontology-contract.test.ts` (enum freeze guard), `pen-normalize.test.ts` (full G.2 alias matrix + dual-carry), `pen-migration.test.ts` (every G.1 row + idempotence + round-trip + resolver equivalence), `resolve-v3.test.ts` (dual-field Layer output), and indirectly via patch/tools/store tests.
- Manual: import a 2.17 .pen file via the UI — verify it loads (migrated on read), renders identically, and re-exports as `version: '3.0'` with legacy fields still present.

## Child DOX Index

No child `AGENTS.md` files. This folder is flat: `types.ts`, `figma-ontology.ts`, `normalize.ts`, `migrate.ts`, `resolve.ts`, `document.ts`, `converters.ts`.

*Siblings: `../agent/AGENTS.md` (Agent layer), `../canvas/AGENTS.md` (Canvas state), `../sessions/AGENTS.md` (Session persistence), `../settings/AGENTS.md` (Settings store), `../web/AGENTS.md` (Web search/fetch), `../llm/AGENTS.md` (LLM provider registry).*