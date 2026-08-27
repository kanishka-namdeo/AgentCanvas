# HTML/DOM Renderer — Design Doc & Implementation Spec

> Status: **IMPLEMENTED (2026-08-25) — Phases 0–3, 6, 7 landed; Phase 4 (scale hardening) partially landed (bench generator + memoization-ready structure; browser perf gates deferred); Phase 5 (default flip) intentionally deferred pending dogfooding.** See Implementation Status below. Phases are ordered (0–5 renderer track, 6–7 Figma-alignment track), independently shippable, and each ends in a verifiable state.
> **Implementation Status (2026-08-25, implementation session):** Phase 0+1 → DOM renderer parity mode behind `settings.renderer` + parity harness + bench generator (commits `b79d71e`, `92d635b`); defects D1/D3/D4/D5/D6 closed (`16b0a1b`). Phase 2 → native CSS layout mode + measured-bounds readback + variable publishing + D2 (`5a87db6`). Phase 3 → `pen_insert_html` + Figma-MCP read ladder (`pen_get_metadata`, `pen_get_design_context`, `pen_get_variable_defs`, `pen_get_computed`, `pen_get_screenshot`, `pen_bake_layout`) + copy-as-code v2 via one serializer + client round-trip channel + VLM ground-truth screenshots + snapshot `measured=` enrichment; D7/D8 closed (`3c2fc86`, `0b9dff2`). Phase 6 → .pen v3 Figma-canonical data model (figma-ontology tables, 2.17→3.0 migration, alias normalizer, dual-field output), 17 tool renames via alias registry, v3 snapshot vocabulary; D9–D12 closed (`8e8918b`, `69bcb1b`, `6505210`). Phase 7 → shortcut registry + marquee/deep-select/hierarchy-navigation/zoom-fit/outline-mode/snap-to-pixel + Hug/Fill/Fixed dropdowns + Pages column + scale tool + version-history checkpoints; D13 partially closed (rulers/measure/comment/assets deferred), D14 closed (`b1482bf`, `8bd7baf`, `490f898`). Suite: 523 → 1134 passing tests. Known deferred: Phase 4 browser perf gates + L4/L5 culling, Phase 5 default flip, mounted-iframe HTML import (M6 v2), rulers/guides/measure overlay, assets tab, INSTANCE_SWAP/SLOT component-property semantics.
> Spec source: full codebase audit conducted 2026-08-25 (rendering core, .pen model, agent pipeline, export paths, tests). All `file:line` references verified against `main` @ `c388147`.
> Revision 2 (2026-08-25, later): **Figma-ontology alignment pass.** Four fresh research/scan subagents re-audited the codebase (terminology inventory: 118 tools, 42 patch ops, 17 LayerTypes, full UI-label map) and researched Figma's canonical surfaces — REST/Plugin API node ontology, Dev Mode MCP Server tool set (`get_metadata`, `get_design_context`, `get_screenshot`, `get_variable_defs`, …), Figma Make/First Draft agent loops, and Figma UI3 canvas workflows/shortcuts. Raw research: `scripts/research/r1-figma-ontology.md`, `r2-figma-agent-tooling.md`, `r3-figma-ui-workflows.md`. This revision adds §1.6, §5.6–5.8, §9 (ontology alignment), §10 (test strategy), Phases 6–7, Appendices G–I, risks R11–R15.
> Code touchpoints: `src/components/canvas/Canvas.tsx`, `src/lib/canvas/{types,patch,store,export,render-to-png,server}.ts`, `src/lib/pen/{types,resolve,document,converters}.ts`, `src/lib/agent/{tools,pen-tools,figma-tools,runner-native,runner-legacy}.ts`, `src/lib/agent/subagents/*`, `src/components/canvas/{TopMenuBar,Toolbar,LayersPanel,PropertiesPanel,AgentPanel}.tsx`, `tests/unit/ShapeRenderer.test.tsx`, `tests/integration/renderer.test.tsx`.
> Test coverage planned: `tests/unit/dom-node.test.tsx` (new), `tests/integration/renderer-dom.test.tsx` (new), `tests/integration/renderer-parity.test.tsx` (new), `tests/unit/figma-ontology-contract.test.ts` (new), `tests/unit/pen-migration.test.ts` (new), `tests/unit/tool-registry.test.ts` (new), `tests/unit/shortcut-registry.test.ts` (new), perf benchmark harness `scripts/dom-renderer-bench/` (new), plus migration of `renderer.test.tsx` / `ShapeRenderer.test.tsx` assertions to the data-attribute contract.

---

## Table of contents

- [0. Executive summary and verdicts](#0-executive-summary-and-verdicts)
- [1. Current-state audit (evidence)](#1-current-state-audit-evidence)
- [2. Evaluation — the four questions, answered](#2-evaluation--the-four-questions-answered)
- [3. Architecture](#3-architecture)
- [4. Scalability plan for large designs](#4-scalability-plan-for-large-designs)
- [5. Agent (pi-agent) integration](#5-agent-pi-agent-integration)
- [6. Migration plan — Phases 0–7](#6-migration-plan--phases-07)
- [7. Risk register](#7-risk-register)
- [8. Open questions](#8-open-questions)
- [9. Figma ontology alignment (terms, data model, tools, UI)](#9-figma-ontology-alignment-terms-data-model-tools-ui)
- [10. Test strategy](#10-test-strategy)
- [Appendix A — Node → DOM element mapping](#appendix-a--node--dom-element-mapping)
- [Appendix B — .pen property → CSS mapping](#appendix-b--pen-property--css-mapping)
- [Appendix C — DOM data-attribute contract](#appendix-c--dom-data-attribute-contract)
- [Appendix D — New tool schemas (Figma-MCP-aligned)](#appendix-d--new-tool-schemas-figma-mcp-aligned)
- [Appendix E — File change manifest](#appendix-e--file-change-manifest)
- [Appendix F — Benchmark definitions and perf gates](#appendix-f--benchmark-definitions-and-perf-gates)
- [Appendix G — Figma ontology alignment matrix](#appendix-g--figma-ontology-alignment-matrix)
- [Appendix H — Figma UI workflow & shortcut alignment](#appendix-h--figma-ui-workflow--shortcut-alignment)
- [Appendix I — Figma Dev Mode MCP tool mapping](#appendix-i--figma-dev-mode-mcp-tool-mapping)

---

## 0. Executive summary and verdicts

**The question set:** (1) Do we actually render components as HTML elements on the canvas today? (2) Is HTML/DOM rendering feasible? (3) Does it make life easier for the pi-agent? (4) Can it scale to large designs and many screens in one project?

**Verdict 1 — No.** The canvas is a single `<svg>` element. Every layer — including component instances — is flattened by `resolvePenTree()` into absolutely-positioned primitives and painted as `<rect>`/`<ellipse>`/`<text>`/`<line>`/`<polygon>`/`<image>` SVG elements (`src/components/canvas/Canvas.tsx:494-568`, switch at `:810-1262`). Component instances are expanded into cloned primitive subtrees *before* render (`src/lib/pen/document.ts:263-299`). The only HTML that exists anywhere is the "copy as code" export — a ~30-line absolute-positioning-only emitter that drops typography, shadows, gradients, auto-layout, nesting, and component semantics (`src/lib/agent/tools.ts:2642-2663`, `src/lib/canvas/export.ts:280-317`). Evidence in §1.

**Verdict 2 — Yes, feasible, with a clean seam.** The renderer consumes a derived, renderer-agnostic projection (`Layer[]` with absolute geometry, or the `.pen` tree directly). The Zustand store, the 42-op patch system, the Socket.IO sync fan-out, and all 90+ agent tools are completely renderer-independent — verified end-to-end (§1.1, §2.2). The `.pen` layout vocabulary (`layout`/`gap`/`padding`/`justifyContent`/`alignItems`/`fit_content`/`fill_container`) is already CSS-flexbox-shaped (`src/lib/pen/types.ts:60-75`). The existing copy-as-code path already proves a shape→absolutely-positioned-div mapping works. Recommended architecture: a **hybrid DOM-primary renderer** — real DOM/CSS for frames, components, text, rectangles, ellipses, images; inline `<svg>` islands for freeform paths, boolean ops, stars, polygons; CSS custom properties for variables/themes (§3).

**Verdict 3 — Yes, materially easier.** HTML/CSS is the highest-frequency design vocabulary in LLM training data; `.pen`/Figma-REST JSON is not. Concretely: a new `pen_insert_html` tool lets the agent author a whole card in one tool call instead of 15 `pen_create_shape` calls; copy-as-code v2 serializes the live DOM so the canvas *is* production-grade code; `pen_get_computed` + a measured-bounds readback close the text-measurement gap that the current resolver cannot solve (no text measurement exists — text without explicit size falls back to 100×100, `src/lib/pen/resolve.ts:315-322`); and the VLM design critic can finally screenshot the *real* canvas instead of a parallel server-side SVG re-render that drops images and judges a different picture than users see (`src/lib/canvas/render-to-png.ts:219-224`). Full analysis in §2.3 and §5.

**Verdict 4 — Yes, scalable — and the DOM plan is an upgrade from a renderer with zero performance infrastructure.** The current SVG renderer has no memoization, no culling, no virtualization: every pan/zoom frame re-renders the entire shape tree (the `zoom` prop is passed to every `ShapeRenderer` for handle compensation, `Canvas.tsx:554-561`), and shape dragging emits one full-store round-trip per mousemove (`Canvas.tsx:216-224`). The DOM design makes pan/zoom a single compositor-only CSS transform on a world container, moves selection chrome to a screen-space overlay (shapes become fully memoizable), and adds `content-visibility`/containment-based culling — targeting 60 fps pan/zoom with ~1.5k mounted nodes inside a 50k-node document (§4). The `.pen` Pages abstraction already exists for multi-screen projects (`src/lib/pen/types.ts:535-566`).

**Verdict 5 (added in Revision 2) — Figma's ontology should be followed, and the repo is ~40% of the way there already, but with a contradiction in the middle.** The good news: `LayerType` already carries the 17 Figma-canonical node types (`canvas/types.ts:30-47`, comment: *"Figma-canonical node types (added in the ontology alignment)"*), a dedicated `figma-tools.ts` surface already implements pages/sections/components/component-sets/variants/component-properties (`src/lib/agent/figma-tools.ts:26-450`), and the system prompt already instructs the model to think in "FRAMES, LAYERS, COMPONENTS, VARIANTS, VARIABLES, STYLES, AUTO LAYOUT, and PAGES — never in terms of generic 'shapes' or 'tokens'" (`runner-legacy.ts:105`). The bad news: **the 72-tool `pen_*` surface those instructions drive is still shape/token-shaped** (`pen_create_shape`, `shapeId`, `pen_update_tokens`, `gap`/`padding`, `theme axes`) — the model is told to think in Figma's vocabulary and then handed a different one. Full alignment is specified in §9 + Phases 6–7: adopt Figma REST API naming as the canonical data-model surface (.pen v3), adopt Figma Dev Mode MCP tool conventions for the agent read surface (`pen_get_metadata`, `pen_get_design_context`, `pen_get_screenshot`, `pen_get_variable_defs`), and adopt Figma UI3 workflows/shortcuts for the app chrome — each behind compat aliases with a deprecation window, never a hard break.

**Recommended path:** two tracks, eight phases, each independently shippable. **Renderer track (Phases 0–5):** parity harness → absolute-positioning DOM parity mode → native CSS layout → agent superpowers → scale hardening → default flip, behind a settings flag (`settings.appearance.renderer: 'svg' | 'dom'`). Nothing in the patch contract, tool surface, or sync protocol changes during this track — the migration risk is concentrated in exactly one component boundary. **Figma-alignment track (Phases 6–7):** ontology unification (.pen v3 + tool vocabulary + MCP-shaped read tools, alias-compat) and UI workflow alignment (Figma UI3 panels, toolbar, shortcuts, marquee/deep-select/scale/measure interactions, version-history checkpoints). Phase 6 may start once Phase 2 lands (so `styleFor` consumes Figma-shaped fields exactly once); Phase 7 is renderer-independent and can start any time after Phase 1.

---

## 1. Current-state audit (evidence)

### 1.1 Rendering pipeline — what actually paints pixels

The complete data flow, from agent tool call to pixels:

```
LLM tool_call (pi SDK)
  → tool.execute() builds CanvasPatch, ctx.applyPatch() applies to runner-local doc
    (src/lib/agent/runner-native.ts:157-165)
  → agent-session-translator.extractPatchesFromToolResult yields {kind:'patch'}
    (src/lib/agent/agent-session-translator.ts:62-71, 209-239)
  → NDJSON stream from /api/agent  (src/app/api/agent/route.ts:104-124)
  → canvas-sync Socket.IO service applies patch to server doc, broadcasts 'canvas:patch'
    (src/lib/canvas/server.ts:193-207)
  → client Zustand _onSync → applyPatchToCanvas(document, patch)  (src/lib/canvas/store.ts:743-771)
  → applyPatchToCanvas mutates the .pen TREE immutably, then recomputeDerived:
      shapes = resolvePenTree(doc)   (src/lib/canvas/patch.ts:146-153, 856)
  → Canvas.tsx renders ONE <svg>:
      <g transform="translate(panX,panY) scale(zoom)>   (Canvas.tsx:516)
        flat, zIndex-sorted map of <ShapeRenderer>       (Canvas.tsx:546-564)
```

Key structural facts, each load-bearing for the DOM decision:

- **Source of truth is the `.pen` tree** (`document.children` + `variables` + `themes`); `document.shapes` is a derived cache recomputed from scratch on every mutation (`src/lib/canvas/types.ts:1-14`, `src/lib/canvas/patch.ts:146-153`). The renderer never computes layout — it only reads `document.shapes` (`Canvas.tsx:395, 527-560`).
- **Rendering is flat, not recursive.** `parentId` is used only for (a) nearest-clipping-ancestor lookup (`Canvas.tsx:532-545`) and (b) absolute→relative coordinate conversion during drag/resize (`Canvas.tsx:209-215`). Children render as flat siblings inside one `<g>`; z-order is a sort by depth-first `zIndex` (`Canvas.tsx:546-548`).
- **Pan/zoom is an SVG `transform` attribute** on the viewport `<g>` (`Canvas.tsx:516`); screen↔canvas conversion is `(sx - panX) / zoom` (`Canvas.tsx:119-128`). Gestures are native pointer/wheel listeners (`src/lib/canvas/use-canvas-gestures.ts:405-434`), zoom clamp 0.1–8 (gestures) vs 0.1–4 (buttons — mismatch noted).
- **Selection chrome lives inside each ShapeRenderer**: 1 selection outline + 8 resize handles, all zoom-compensated (`HANDLE_SIZE / zoom`, `Canvas.tsx:1276`, handles at `:1381-1395`). Consequently `zoom` is a prop of every `ShapeRenderer` (`Canvas.tsx:554-561`) → **every zoom change re-renders every shape**.
- **`ShapeRenderer` is an unmemoized plain function** (`Canvas.tsx:728`); the dedupe/sort/clip-ancestor computation runs inside an inline IIFE on every render (`Canvas.tsx:527-545`). There is no `React.memo`, no `useMemo` in the canvas render path, no viewport culling — every shape in the document mounts and re-renders on every commit, including every pan frame (`use-canvas-gestures.ts:172-214` mutates viewport state per wheel event).
- **Hit-testing** is a bounding-box top-hit over the sorted flat list (`Canvas.tsx:396-399`).
- **Text is single-line SVG `<text>`** — baseline-positioned (`y = shape.y + fontSize`), no wrapping (`Canvas.tsx:870-925`). There is no on-canvas text editing (no `contentEditable`, no `foreignObject` anywhere in `src/`); text is edited in the PropertiesPanel `textarea` (`src/components/canvas/PropertiesPanel.tsx:975-985`).
- **Rotation is NOT rendered on-screen** — `ShapeRenderer` never applies `shape.rotation`; it is honored in both export paths (`export.ts:140-144`, `render-to-png.ts:142`). A latent inconsistency the migration must resolve (§6, Phase 1).

### 1.2 The four parallel shape-painters (the consolidation opportunity)

Four independent emitters currently re-implement "paint a Layer":

| # | Emitter | Lives in | Fidelity |
|---|---------|----------|----------|
| 1 | `ShapeRenderer` JSX (on-screen SVG) | `Canvas.tsx:728-1379` | gradients, filters, radii, typography; no rotation, single-line text |
| 2 | `shapeToSvg` (client export) | `src/lib/canvas/export.ts:102-240` | + rotation; typography partially dropped |
| 3 | `renderShapeToSvg` (server, VLM screenshots) | `src/lib/canvas/render-to-png.ts:135-246` | + full typography; **drops images** (`:219-224`); no-op for groups/sections/instances (`:239-244`) |
| 4 | `exportCode` / `pen_copy_as_code` (HTML/React/Tailwind) | `export.ts:280-317`, `tools.ts:2614-2666` | **absolute-positioning divs only** — no flex, no nesting, no shadows/gradients/typography/z-index/opacity/rotation; the tool's `tailwind` param is silently ignored (`tools.ts:2642-2663`) while the client variant implements a hybrid of classes + inline styles |

A DOM renderer that owns the node→HTML/CSS mapping collapses all four into **one vocabulary** (§5.3): the canvas DOM *is* the export source.

### 1.3 What "components" are today

- A **main component** is any node with `reusable: true` (`pen/types.ts:212`); `collectComponents()` indexes them per page (`pen/document.ts:79-85`).
- An **instance** is a `PenRef` node `{type:'ref', ref: componentId, descendants: {…}, componentProperties: {…}}` (`pen/types.ts:483-501`).
- At resolve time, `expandRef` **deep-clones the component subtree with fresh ids**, applies the `descendants` override map (keyed by slash-separated *source-id paths*, resolved via `_sourceId` tags, `pen/document.ts:263-319`), then the clone is flattened into the same flat `Layer[]` as everything else (`pen/resolve.ts:505-519, 716-718`).
- So: **component instances are never rendered "as components" — they are baked into primitive clones** before any renderer sees them. The renderer's only knowledge of componentry is cosmetic badges ("M"/"◆" drawn by ShapeRenderer, `Canvas.tsx:1042-1126`).

### 1.4 Auto-layout today — a hand-rolled flexbox, recomputed per patch

`resolvePenTree` (`pen/resolve.ts:497-724`) implements a custom two-pass flexbox: bottom-up intrinsic sizing (`computeIntrinsicSize`, `:246-339`) then top-down positioning (`layoutChildren`, `:393-489`). It runs on **every mutation**, full-tree, O(N) with full-tree cloning (`patch.ts:856`). Known deficits (all become moot or fixable in native CSS mode):

1. **No text measurement** — text nodes without explicit size default to 100×100 (`resolve.ts:315-322`); `textGrowth` is ignored by layout.
2. **No `$variable` resolution for layout numbers** — `gap`/`padding`/`width`/`height` go through `num()` which returns defaults for `'$…'` strings (`resolve.ts:190-199`) because variable resolution happens in the emit pass, *after* layout (`resolve.ts:63-75`).
3. No grow/shrink, no wrap, no baseline alignment, no `layoutIncludeStroke`.
4. Empty `fit_content` frames fall back to 100×100 (`resolve.ts:315-322`).

### 1.5 Defect inventory discovered during this audit (fix during migration — nothing deferred)

| # | Defect | Evidence | Fixed in |
|---|--------|----------|----------|
| D1 | **Pages desync**: tree mutations update `next.children` but never write back to `pages[activePageIndex].children`; switching pages reloads stale content | only `pages[…]` writes are the four page ops (`patch.ts:562-606`) | Phase 1 (prerequisite bugfix) |
| D2 | **`componentProperties` are stored but never applied** during instance expansion (no code interprets boolean/text/instance_swap/variant values) | only passthrough consumers (`resolve.ts:682`, `patch.ts:649-664`) | Phase 2 |
| D3 | **Nested refs not recursively expanded** — a `ref` inside a component's subtree survives as a raw `ref` node and maps to a plain rectangle | `expandRef` clones as-is (`document.ts:263-299`); fallback mapping (`resolve.ts:750`) | Phase 1 |
| D4 | **Rotation rendered in exports but not on-screen** | `Canvas.tsx` (absent) vs `export.ts:140-144` | Phase 1 (canonical: render it) |
| D5 | **Double-apply quirk** in HTTP fallback path — client applies patch at `store.ts:484` then `_onSync` applies again at `:760`; mitigated only by render-time id dedupe (`Canvas.tsx:527-530`) | `store.ts:483-491, 743-771` | Phase 1 |
| D6 | Zoom clamp mismatch (gestures 0.1–8 vs buttons 0.1–4) | `use-canvas-gestures.ts:76-87` vs `Canvas.tsx:582-591` | Phase 1 (trivial) |
| D7 | `pen_copy_as_code` ignores its `framework:'tailwind'` parameter | `tools.ts:2642-2663` | Phase 3 (superseded by v2) |
| D8 | Server-side VLM screenshot **silently drops image shapes** and judges a different image than the user sees | `render-to-png.ts:219-224` | Phase 3 |
| D9 | **Vocabulary contradiction**: system prompt orders Figma-term thinking (`runner-legacy.ts:105`) while the tool surface it drives is shape/token-shaped (`pen_create_shape`, `shapeId`, `pen_update_tokens`, `gap`/`padding`, theme axes) | `runner-legacy.ts:105` vs `tools.ts:550-2523` | Phase 6 |
| D10 | **Dual parallel ontologies for the same concepts**: `pen_*` vs `figma_*` tools for components (`pen_create_ref` vs `figma_create_component`), `Layer.instance` vs `PenRef.ref`, tokens vs variables — three vocabularies for one idea | `pen-tools.ts:599` vs `figma-tools.ts:439`; `types.ts:43` vs `pen/types.ts:484` | Phase 6 |
| D11 | **Auto-layout vocabulary drift**: `.pen` uses CSS names (`layout`/`gap`/`padding`/`justifyContent`/`alignItems`/`fit_content`/`fill_container`) while tools use a third dialect (`direction`/`gap`/`padding`/`alignX`/`alignY`) — neither is Figma's (`layoutMode`/`itemSpacing`/`paddingLeft…`/`primaryAxisAlignItems`/`counterAxisAlignItems`/`HUG`/`FILL`/`FIXED`) | `pen/types.ts:60-75` vs `tools.ts:155-161, 1204-1210` | Phase 6 |
| D12 | **Align enum drift**: `alignKind: center_h/center_v/distribute_h/distribute_v` vs Figma UI verbs ("Align horizontal centers", "Distribute horizontal spacing", "Tidy up") | `types.ts:347`; `tools.ts:1123-1133` | Phase 6 |
| D13 | **Marquee selection, deep select, Enter/⇧Enter hierarchy navigation, scale tool, ⌥-hover measure, rulers/guides, pixel grid & snapping, outline mode are absent or stubbed** — core Figma canvas functionalities | `Canvas.tsx` (no marquee handler); `TopMenuBar.tsx:269-272` (grid stubs) | Phase 7 |
| D14 | **No version history / named checkpoints** — agent writes are only recoverable via the linear undo stack; Figma Make's checkpoint model (preview/favorite/restore per AI edit) is the agent-safety pattern we lack | `store.ts:584-604` (undo/redo only) | Phase 7 |

### 1.6 Figma-ontology alignment status (Revision 2 audit)

A terminology inventory of the entire agent tool surface (118 tools: 72 `pen_*` + 8 pen-concept + 10 `figma_*` + 28 plugin), the 42 patch ops, the 17-value `LayerType`, the 20 `.pen` node types, every UI label in the menubar/toolbar/panels, and the full test tree was cross-referenced against Figma's three canonical surfaces (REST API, Plugin API, UI — raw research in `scripts/research/r1..r3`). Headline:

**Already aligned (keep):**
- Node-type taxonomy: `rectangle, ellipse, text, line, frame, group, path, section, component, component_set, instance, boolean_operation, slice, star, polygon` map 1:1 to Figma types (`canvas/types.ts:30-47`). `.pen` adds `note, context, prompt, icon, script, ref` — legitimate extensions, not clashes.
- Pages model (`PenPage`, `pages[]`, `activePageIndex`) — Figma-shaped (`pen/types.ts:535-546`).
- Component-properties model — `componentPropertyDefinitions`, `componentProperties` with `BOOLEAN|TEXT|INSTANCE_SWAP|VARIANT|SLOT`, `variantPropertyAxes`, `preferredValues` — matches Figma exactly (`pen/types.ts:238-263`, `figma-tools.ts:329-385`).
- Constraints semantics — `left/right/center/scale/left_right` + `top/bottom/center/scale/top_bottom` are exactly Figma REST's `LEFT/RIGHT/CENTER/SCALE/LEFT_RIGHT` + `TOP/BOTTOM/CENTER/SCALE/TOP_BOTTOM` in lowercase (`types.ts:94-97`).
- Menu labels for z-order, group/ungroup, lock/hide, align/distribute — Figma verb phrasing (`TopMenuBar.tsx:318-354`).
- Rotation semantics (degrees, clockwise, top-left origin) already match Figma's convention.

**Misaligned (Phase 6 fixes — full matrix in Appendix G):** the shape/node split (D9), the `pen_*`/`figma_*` dual surface (D10), auto-layout dialects (D11), tokens+themes vs variables+collections+modes, single `fill`/`stroke` strings vs paint arrays, `shadow`/`blur`/`gradient` as scattered fields vs a unified `effects[]`, `radius`/`radii` vs `cornerRadius`/`rectangleCornerRadii`, `text`/`textColor`/`textGrowth` vs `characters`/`fills`/`textAutoResize`, lowercase enums vs Figma SCREAMING_SNAKE, `image` as a node type vs image-as-paint, `zIndex`+`zorder` vs child-order z-indexing (D12 for align enums).

**Absent Figma canvas functionalities (Phase 7 adds — full workflow matrix in Appendix H):** marquee/rubber-band selection; deep select (⌘+click); Enter/⇧Enter/Tab hierarchy navigation; scale tool (K); ⌥-hover distance measure; rulers, guides, ⌥-drag redlines; pixel grid + snap-to-pixel; pixel preview; outline mode; zoom-to-fit/selection/100% shortcuts (⇧1/⇧2/⇧0); Figma's canonical tool/panel/align shortcuts (V/H/K, ⌥⌘K create component, ⌥⌘B detach, ⌘⇧L lock, ⌘⇧H hide, ⌥A/W/S/D/V/H align); Assets panel; hug/fill/fixed per-axis sizing dropdowns; wrap-in-section; version-history checkpoints for agent writes; multi-edit / select-same.

**Figma-agent-tooling gap (Phase 3+6 close):** our read surface is `pen_list_shapes`-style text dumps and a whole-canvas `canvasSnapshot`, while Figma's MCP convention is narrow, purpose-built tools — `get_metadata` (sparse structure; page list when no node id), `get_design_context` (code + screenshot + system prompt + assets), `get_screenshot`, `get_variable_defs` — over *scoped* selections. The alignment plan adopts that shape (§5.2, Appendix I).

---

## 2. Evaluation — the four questions, answered

### 2.1 Q1: "Did we actually render components as HTML elements on our canvas?"

**No — definitively.** Three independent lines of evidence:

1. **The render surface is a single `<svg>`** (`Canvas.tsx:494-498`) with a flat, z-sorted list of `ShapeRenderer` outputs (`:546-564`). Every layer type maps to SVG elements: `rect` (rectangle/frame), `ellipse`, `line`, `text`, `polygon`/`polyline` (path/star/polygon), `image`, plus dashed-outline + badge representations for group/section/component/instance/boolean/slice chrome (`:810-1262`).
2. **Component instances are expanded into cloned primitives before render** (`pen/document.ts:263-299` → `pen/resolve.ts:505-519`). By the time any renderer runs, the word "component" no longer exists in the data — only flat `Layer[]` entries with a cosmetic `componentId` field for badging.
3. **A repo-wide search finds no `dangerouslySetInnerHTML`, no `<iframe>`, no `createPortal`, no `contentEditable`, no `foreignObject` in canvas code** — the only HTML-generating code is the copy-as-code export (§1.2 #4) and unrelated web-fetch utilities (`src/lib/web/fetch.ts`).

The only sense in which "HTML" exists today is as an **export artifact** with severe fidelity loss: absolute-positioned flat divs, typography/shadows/gradients/auto-layout/nesting all dropped, Tailwind mode ignored in the agent tool variant.

### 2.2 Q2: "Is rendering components as real HTML elements feasible?"

**Yes — high confidence — because the renderer sits behind a clean seam.** The feasibility case:

**The seam is real and verified.** Everything upstream of `Canvas.tsx`'s paint loop is renderer-agnostic by construction:
- The `.pen` tree is the source of truth; patches mutate it; `resolvePenTree` produces derived data (`patch.ts:146-153`).
- The store applies patches and holds undo history without any SVG assumptions (`store.ts:743-771`).
- The sync service moves `CanvasPatch` objects; it never touches pixels (`server.ts:85-95, 193-207`).
- The PropertiesPanel and LayersPanel read `document`/`document.shapes` from the store; neither queries the DOM (`PropertiesPanel.tsx:59-61`) — they survive a renderer swap untouched.
- The agent's entire 90+ tool surface emits `CanvasPatch` objects (§5.1) — zero coupling to SVG.

**The layout vocabulary is already CSS.** `.pen`'s `PenLayout` is a subset of flexbox: `layout: 'none'|'vertical'|'horizontal'`, `gap`, `padding` (1/2/4-tuple), `justifyContent: start|center|end|space_between|space_around`, `alignItems: start|center|end`, plus `fit_content`/`fill_container` sizing (`pen/types.ts:60-75`). The hand-rolled resolver (`pen/resolve.ts:208-489`) exists precisely because SVG has no layout engine. A DOM renderer deletes the need for it in the interactive path.

**A shape→div mapping is already proven** by `exportCode` (`export.ts:280-317`) — crude, but it demonstrates the coordinate contract translates.

**Three architecture options were considered:**

| Option | Description | Verdict |
|--------|-------------|---------|
| A. **DOM parity port** | Keep `resolvePenTree` as layout authority; render each `Layer` as an absolutely-positioned div (a 1:1 port of `renderShapeToSvg`). | ✅ Lowest risk; perfect parity; zero layout divergence. But keeps the custom flexbox and its defects (no text measurement, no variable-driven sizes). |
| B. **Native DOM tree** | Render the `.pen` tree directly as **nested** DOM; containers with `layout ≠ 'none'` become CSS flexbox; the browser is the layout authority. | ✅ Deletes the custom layout engine from the interactive path; fixes text measurement and variable-driven sizing for free. But diverges from the resolver's predictions, complicating export/VLM parity, and is untestable under jsdom (no real layout). |
| C. **Hybrid, phased (recommended)** | Phase 1 ships Option A behind a flag (parity mode). Phase 2 adds Option B as a per-document *native mode* while keeping parity mode for tests/export/server paths. SVG islands for vector types in both. | ✅ Recommended. Each step verifiable; risks isolated; jsdom-testable baseline retained. |

**The SVG-compat tail is small and well-bounded.** Only these node types genuinely need vector rendering: `path`, `boolean_operation`, `star`, `polygon` (non-trivial corner radius), `ellipse` with `innerRadius`/arc parameters, `icon` (lucide polylines), mesh-gradient/shader fills. Each becomes a small inline `<svg viewBox>` island inside its node div — nested SVG-in-HTML is native browser behavior and imposes no architectural cost.

**Feasibility verdict:** the swap is a reimplementation of exactly one component (`Canvas.tsx`'s render path) plus a chrome overlay — not a platform change. The store, patch, sync, agent, sessions, and panels are untouched.

### 2.3 Q3: "Does it make things easy for our pi-agent?"

**Yes — this is where the largest share of the value sits.** Six concrete mechanisms:

**M1 — LLM-native authoring vocabulary.** The agent currently designs by emitting coordinate-laden JSON patches in a Figma-REST-shaped dialect. HTML/CSS is orders of magnitude better represented in LLM training data than any design-tool JSON. A new `pen_insert_html` tool (§5.2) lets the model emit a semantic HTML+inline-CSS fragment — `<div class="card" style="display:flex; gap:12px; …">` — which the importer converts to a `.pen` subtree. One tool call replaces 10–20 `pen_create_shape` calls: fewer tokens, fewer round-trips, fewer coordinate-arithmetic errors (today the model hand-computes nested x/y offsets; the resolver's relative-coordinate contract, `canvas/AGENTS.md:13`, is a known LLM error source).

**M2 — The canvas becomes the code.** Copy-as-code v2 (§5.3) serializes the *live, layout-authoritative DOM* — real nesting, real flexbox, full typography, shadows, gradients — into HTML / React / Tailwind. Today's export drops all of that (§1.2 #4). Design-to-handoff fidelity goes from "schematic" to "production-shaped."

**M3 — Ground-truth measurements.** The resolver cannot measure text (§1.4). In native mode, `pen_get_computed` (§5.2) returns real `getComputedStyle` + `getBoundingClientRect` data, and the measured-bounds readback (§3.8) feeds real sizes into the agent's canvas snapshot. The agent stops guessing whether its label fits and starts knowing.

**M4 — The VLM critic sees the truth.** Today `design-critic-vlm` screenshots a *parallel server-side re-render* that drops images and renders different fonts (`render-to-png.ts:219-224`, resvg + DejaVu) — the critic literally judges a different picture than the user (§5.4). DOM mode enables `html-to-image` capture of the real canvas.

**M5 — Verification feedback loop.** After a patch, the agent can call `pen_get_computed` to *check its own work* (contrast values, actual widths, computed colors post-variable-resolution). Today `pen_list_shapes` returns the model's own beliefs echoed back.

**M6 — HTML import / paste-to-canvas.** The same import pipeline as M1 (mount → walk → `getComputedStyle` → `.pen` nodes) turns "paste this component from a webpage" into a first-class operation, feeding the web-research subagent loop (`subagents/web-research.ts`) directly into the canvas.

**What does NOT change (important for risk):** the patch contract, tool surface, and sync protocol are untouched (§5.1). DOM rendering is downstream of the agent; the agent keeps working identically during every migration phase, and the new tools are additive.

### 2.4 Q4: "Can this scale — large designs, many screens, one project?"

**Yes, with a deliberate scalability plan (§4) — and crucially, the status quo has no headroom to lose.** The current renderer re-renders every shape on every pan/zoom frame with zero memoization (§1.1); a 2,000-layer document already pays full React reconciliation per wheel tick. The DOM architecture is strictly better positioned for scale:

- **Pan/zoom becomes one compositor-only transform** on a world container; shape elements never re-render during navigation.
- **Selection chrome moves to a screen-space overlay** — selection changes stop touching the world tree entirely (this also removes the `zoom` prop from every node, enabling full memoization).
- **`content-visibility: auto` + CSS containment** let the browser skip layout/paint of offscreen frame subtrees natively — the platform's virtualization primitive, no custom windowing code required for the first two orders of magnitude.
- **Explicit mount-culling** (§4.2) for extreme documents: frames outside viewport + margin unmount to placeholder divs with `contain-intrinsic-size`.
- **Structure already exists**: `.pen` Pages (`pen/types.ts:535-566`) give one-project/many-screens organization; sections and frames give intra-page grouping; the agent already drives page ops (`figma_*` tools).
- **Patch fan-out is per-patch and unbatched today** (`server.ts:85-95, 193-202`) — an agent bulk-build emits N patches = N full re-renders. The plan adds rAF coalescing (§4.4), which benefits both renderers.

**Performance targets** (definitions and gates in Appendix F): 60 fps pan/zoom with a 5,000-node page (~1,500 nodes visible); p95 patch-to-paint ≤ 16 ms for a single `update` at 5k nodes; agent `bulk_add` of 500 nodes coalesced to ≤ 3 full commits. These targets are unreachable on the current renderer and conservative for the DOM design.

---

## 3. Architecture

### 3.1 Principles

1. **The `.pen` tree remains the single source of truth.** The DOM is a projection. No state lives in the DOM that isn't derived from the model (the sole sanctioned exception: measured bounds, §3.8, kept in a separate runtime cache).
2. **The patch contract is frozen through the renderer track.** All 42 ops (`canvas/types.ts:287-334`) and 90+ core tools keep their semantics through Phase 5. Phase 6 then evolves the vocabulary *behind compat aliases* (§9.3) so the renderer migration and the ontology migration never interleave. The renderer is a pure consumer of `CanvasDocument`.
3. **One paint vocabulary.** The node→DOM/CSS mapping (Appendices A/B) becomes the shared vocabulary for on-screen rendering *and* code export, collapsing the four parallel emitters (§1.2).
4. **React owns the DOM.** Per the repo's "no direct DOM mutation" rule, imperative updates are confined to ref-backed transforms on the world container and overlay, mirroring the existing background-grid pattern (`Canvas.tsx:427-435`). No ad-hoc `innerHTML` writes.
5. **Chrome never lives in the world tree.** Selection outlines, resize handles, badges, agent-highlight pulses, snap guides — all render in a screen-space overlay computed from `getBoundingClientRect()`, so navigation and selection never re-render content.
6. **Two layout modes, one document.** *Parity mode*: resolver-computed absolute geometry (identical to today). *Native mode*: containers with `layout ≠ 'none'` render as CSS flexbox and the browser is the layout authority. Mode is a document-level runtime setting, not a fork of the code.
7. **Figma is the vocabulary authority.** Node types, property names, enum spellings, tool verbs, UI labels, and shortcuts follow Figma's canonical surfaces — REST API for the serialized model (Appendix G), Dev Mode MCP for the agent read tools (Appendix I), Figma UI3 for the app chrome (Appendix H). Deviations must be justified in this spec (§9.6 lists the deliberate ones).

### 3.2 The renderer seam — component structure

```
src/components/canvas/
  Canvas.tsx                 # shell: keeps gestures, context menus, zoom UI; swaps paint tree
  dom/
    DomCanvas.tsx            # NEW — world container + chrome overlay + culling coordinator
    DomNode.tsx              # NEW — memoized renderer for ONE .pen node (recursive)
    DomChrome.tsx            # NEW — screen-space selection/handles/badges/highlights
    styleFor.ts              # NEW — pure .pen node → CSSProperties (the shared vocabulary)
    islands.tsx              # NEW — SVG island emitters (path/boolean/star/polygon/icon)
    measure.ts               # NEW — ResizeObserver pool → measuredBounds cache
  svg/                       # legacy renderer moved here verbatim (ShapeRenderer + helpers)
```

`DomCanvas` consumes the **expanded, variable-resolved tree** — i.e. the same intermediate representation `resolvePenTree` produces *before* flattening: ref-expansion (D3 fix), theme/variable resolution, and absolute-vs-flow decisions. In parity mode it additionally consumes the flat `Layer[]` geometry exactly as the SVG renderer does. The tree walk is recursive (real DOM nesting), with z-order preserved via DOM order + `z-index` within each parent (§3.5).

### 3.3 World structure and coordinate system

```tsx
<div className="ac-viewport" style={{ overflow: 'hidden', position: 'relative' }}>
  {/* World layer — pan/zoom is the ONLY thing that changes here */}
  <div
    ref={worldRef}
    data-ac-world
    style={{
      position: 'absolute', top: 0, left: 0,
      transform: `translate(${panX}px, ${panY}px) scale(${zoom})`,
      transformOrigin: '0 0',
      willChange: 'transform',
    }}
  >
    {rootNodes.map(n => <DomNode key={n.id} node={n} mode={layoutMode} />)}
  </div>
  {/* Chrome overlay — screen space, above world, pointer-events managed per-element */}
  <DomChrome selected={selectedIds} highlighted={highlightIds} zoom={zoom} />
</div>
```

- Screen↔canvas math is unchanged: `(sx - panX) / zoom` — the overlay converts measured rects back to canvas coordinates the same way the current code does (`Canvas.tsx:119-128`).
- The world container carries the document background and the CSS custom properties for variables/themes (§3.6).
- **Text zoom fidelity**: DOM text scales with the world transform (vector-true, matching SVG behavior). Chrome overlay text (handle labels, badges) stays constant-size — an improvement over today's `1/zoom` compensation hacks.

### 3.4 Layout strategy — dual mode

> Note (Rev 2): the left column below uses current (2.17) `.pen` field names. Phase 6 renames them to Figma-canonical spellings — `layout→layoutMode`, `gap→itemSpacing`, `padding→paddingLeft/…`, `justifyContent→primaryAxisAlignItems`, `alignItems→counterAxisAlignItems`, `fit_content→HUG`, `fill_container→FILL` (Appendix G §G.1) — with the CSS mapping unchanged.

**Parity mode (Phase 1).** Every node renders `position: absolute` with resolver-produced absolute `x/y/width/height` from `document.shapes`. This is a strict port of the current renderer's contract — pixel-comparable via the Phase 0 harness — and keeps `resolvePenTree` as layout authority. Ships first, proves the seam, fixes D3/D4/D5 along the way.

**Native mode (Phase 2).** Containers with `layout ≠ 'none'` render `display: flex`:

| .pen | CSS |
|------|-----|
| `layout: 'vertical' \| 'horizontal'` | `flex-direction: column \| row` |
| `gap` | `gap` |
| `padding` (1/2/4-tuple) | `padding` (expanded shorthand) |
| `justifyContent: start/center/end/space_between/space_around` | `flex-content` → `flex-start/center/flex-end/space-between/space-around` |
| `alignItems: start/center/end` | `align-items: flex-start/center/flex-end` |
| child `fit_content` | `width/height: auto` (+ `min-width: 0` where the paren fallback `fit_content(100)` exists, until parsed) |
| child `fill_container` | `flex: 1 1 0` on main axis / `align-self: stretch` on cross axis (matches the resolver's two-phase fill semantics, `resolve.ts:279-337`) |
| child `layoutPosition: 'absolute'` | `position: absolute` + own x/y (matches `resolve.ts:406-416`) |

Children of `layout: 'none'` containers stay absolutely positioned (Figma constraints handled per `applyConstraintH/V` semantics). **The resolver remains the layout authority for server-side contexts** (VLM fallback export, `.pen` serialization, parity tests, jsdom tests); the browser is authoritative only for the interactive canvas, with measured bounds flowing back (§3.8) so the two never silently diverge by more than the readback latency.

### 3.5 Z-order, clipping, hit-testing

- **Z-order**: DOM paint order = child order within each container; `zIndex` (depth-first, from the resolver) maps to `z-index` for siblings that need explicit ordering. Absolute-positioned and flow children interleave correctly because both live in the same stacking context per parent.
- **Clipping**: `clip: true` frames get `overflow: hidden` — nested and free, replacing the `<clipPath>` def-per-frame machinery (`Canvas.tsx:506-514, 532-545`).
- **Hit-testing**: DOM gives real-geometry hit-testing (rounded corners, non-rectangular islands) — strictly better than today's bbox top-hit (`Canvas.tsx:396-399`). Pointer events flow: viewport captures gestures; node divs get `pointer-events: auto`; the overlay re-enables per-element (same pattern as `Canvas.tsx:794-799`).
- **Drag/resize math** keeps using canvas-space coordinates; parent-relative conversion (`Canvas.tsx:209-215`) applies unchanged since nesting now matches the tree.

### 3.6 Variables and themes → CSS custom properties

The world container publishes every document variable as a CSS custom property, re-resolved on `set_variable`/`set_theme_axis`/`set_node_theme` patches:

```
--acv-<sanitized-key>: <resolved value under effective theme>;
```

Nodes referencing `$name` (or `tokenBinding`) emit `fill: var(--acv-color-primary)` instead of a baked hex. Consequences:

- Theme switches repaint via one attribute change on the world root (`data-ac-theme="mode:dark"`), no tree re-resolve.
- **Fixes defect class "variables don't work in layout numbers"** (§1.4 #2): CSS custom properties participate in `width`/`gap`/`padding` natively — the exact operation the resolver cannot do because resolution runs after layout.
- Themed values per-node (`set_node_theme`) resolve at publish time for the node's subtree scope (inline `--acv-*` override on that node's element) — the cascade does the inheritance the `mergeTheme` recursion does today (`resolve.ts:103-105`).

### 3.7 SVG islands (vector tail)

`path`, `boolean_operation`, `star`, `polygon` (with corner radius), arc/annulus `ellipse`, and `icon` render as inline `<svg width=100% height=100% viewBox preserveAspectRatio="none">` islands inside their node div. Boolean ops emit `<clipPath>`/`<mask>` composites of child geometries (the one place islands nest non-trivially). Icon nodes mount lucide path data (already polyline-based from `pen_search_icons`, `tools.ts`). Island SVG is **excluded from chrome measurements** except via its parent node rect.

### 3.8 Measured-bounds readback (the sanctioned two-way street)

A `ResizeObserver` pool (`measure.ts`) watches every mounted node element and writes `{ width, height }` into a **separate runtime cache** on the canvas store: `measuredBounds: Record<nodeId, {width: number; height: number}>` — never into the `.pen` tree (no feedback loop: model → DOM → measure → cache, and the cache never re-enters layout).

Consumers: the agent's canvas snapshot (§5.5), the chrome overlay, alignment/distribute tools, and `render-to-png.ts` (which switches from resolver-predicted to measured geometry for server-side screenshots, closing parity drift). A `pen_bake_layout` tool (§5.2) writes measured sizes back into `.pen` `width`/`height` explicitly, on demand — deterministic export when the user wants it.

---

## 4. Scalability plan for large designs

### 4.1 Layered performance model

Scalability comes from five independent layers, each individually shippable and measurable:

| Layer | Mechanism | What it eliminates |
|-------|-----------|--------------------|
| L1. Compositor navigation | World `transform` + `will-change` | Re-rendering anything during pan/zoom |
| L2. Chrome isolation | Screen-space `DomChrome` overlay | Re-rendering the world on selection/hover/zoom-chrome |
| L3. Memoized nodes | `React.memo(DomNode)` keyed by node identity | Re-rendering untouched siblings on patch |
| L4. Browser culling | `content-visibility: auto` + `contain: layout style paint` on frames | Layout/paint cost of offscreen subtrees |
| L5. Mount culling | Explicit unmount of far-offscreen frames → placeholder with `contain-intrinsic-size` | React reconciliation + DOM memory beyond ~10k nodes |

**L1–L3 first** (they also de-risk the migration itself); **L4** is a CSS-only change once nesting exists; **L5** only matters beyond ~10k nodes in one page and is the last thing built.

### 4.2 Culling design

- **L4 (browser-native)**: every `frame`/`component`/`section` node gets `content-visibility: auto` and `contain-intrinsic-size: <w>px <h>px` (from resolver or measured bounds). The browser then skips layout+paint for anything outside the viewport — effectively free virtualization with correct scrollbar-free absolute positioning semantics inside the world div.
- **L5 (explicit)**: a `CullingCoordinator` (inside `DomCanvas`) computes viewport ∩ world-rect ± margin (default 2× viewport) on pan/zoom *end* (debounced 150 ms) and rAF-throttled during motion. Offscreen *top-level* frames (and section children beyond a per-page budget) swap to `<div data-ac-placeholder style="width;height" />`. Mount/unmount hysteresis (1.5× margin) prevents thrash.
- **Culling is disabled below a threshold** (e.g., < 2,000 nodes in page) — below that, React reconciliation of a memoized tree is faster than coordinator overhead.

### 4.3 Memoization contract

`DomNode` is `React.memo`'d with a custom comparator: re-render only when (a) the node's serialized style payload changes (shallow compare of the `styleFor` output object, memoized itself), (b) `layoutMode` changes, or (c) the node's children array identity changes (tree is immutable — patch application produces new arrays only along mutated paths, `patch.ts:157+`). Because chrome is out-of-tree, **selection, hover, highlight, and zoom are not props of `DomNode`** — the single biggest structural difference from `ShapeRenderer` (where `zoom`/`selected`/`highlighted` force full-tree re-renders, §1.1).

### 4.4 Patch coalescing (agent bulk operations)

Today an agent `bulk_add` of 500 shapes arrives as patches that each trigger `applyPatchToCanvas` + `resolvePenTree` + full React commit (`server.ts:193-202`, `store.ts:743-771`). Plan:

1. **Store-side**: queue incoming `canvas:patch` events for ≤ 1 animation frame; apply queued patches as a *sequence* against one clone, then one `resolvePenTree`, then one commit. (Patches are order-dependent; batching must preserve order — apply serially to the same clone, which is what the runner already does server-side.)
2. **Commit-side**: React 18+ automatic batching already coalesces within a tick; the win is avoiding N × `resolvePenTree` (O(N) each → O(N) once).
3. **Drag-side**: local drags emit `update` patches per mousemove (`Canvas.tsx:216-224`); route through the same rAF queue (last-write-wins per shapeId within a frame).

### 4.5 Structural scale — one project, many screens

- **Pages** (D1 fix required): one page per screen-flow area; the model and patch ops already exist (`pen/types.ts:535-566`, `patch.ts:562-606`). The Phase 1 bugfix makes `children ↔ pages[activePageIndex].children` write-back atomic in `applyPatchToCanvas`.
- **Sections** group screens within a page (agent uses `add_section` already).
- **Component sets + refs** are the real node-count lever: a design system page holds main components; screen pages place `ref` instances. DOM rendering keys instance subtrees by `(instanceId, sourcePath)` so override diffs patch only the affected instance subtree (memoization honors subtree identity through expansion — `expandRef` already produces stable fresh-ids per instance, `document.ts:90-105`).
- **Node budget guidance** (documented, then enforced by `pen_audit_design`): ≤ ~300 nodes per screen frame, ≤ ~5k per page before L5 culling engages, `component_set` extraction when a pattern repeats ≥ 3×.

### 4.6 Text and fonts

The world layer uses the app's Inter webfont (same as today's `fontFamily: var(--font-inter)`, `Canvas.tsx:870-925`), so on-screen text matches the shell UI. **Known, pre-existing divergence**: server-side resvg renders with DejaVu/Noto (`render-to-png.ts:43-55`) — already true today, not introduced by this work; Phase 3's real-DOM screenshot path (§5.4) is the fix. Multi-line text, wrapping, and `line-height` become real browser behavior — an upgrade over single-line SVG `<text>` (§1.1).

---

## 5. Agent (pi-agent) integration

### 5.1 What stays frozen (the de-risking contract)

- **All 42 patch ops** (`canvas/types.ts:287-334`) — semantics, names, payloads — **through Phase 5**. Phase 6 evolves the vocabulary behind a normalizing alias layer (§9.3) with the same op set reachable under both spellings during a deprecation window.
- **All 90+ core tools** (72 `tools.ts` + 8 `pen-tools.ts` + 10 `figma-tools.ts` + 28 plugin tools) — they emit patches; the renderer change is invisible to them. Phase 6 renames tools via the alias registry, never by removal (§9.4).
- **The NDJSON/Socket.IO event vocabulary** (`canvas/types.ts:405-462`) and the translator's patch extraction (`agent-session-translator.ts:62-71`).
- **The runner's local-canvas execution model** (`runner-native.ts:157-165`): the agent never reads the DOM — it reads `ctx.getShapes()/getDocument()`. Server-side code stays DOM-free; only the *browser* renders DOM. This keeps `/api/agent`, canvas-sync, and the fallback chain untouched.

### 5.2 New tools — Figma-MCP-aligned from birth (additive; schemas in Appendix D)

**Naming decision.** New read-side tools adopt the exact verb names of Figma's Dev Mode MCP Server — `get_metadata`, `get_design_context`, `get_screenshot`, `get_variable_defs` — under our existing `pen_` namespace (`pen_get_metadata`, …). The prefix keeps our tools collision-free if a user later connects the *real* Figma MCP server through the existing `mcp-adapter` plugin (`src/lib/agent/plugins/mcp-adapter.ts:77-201`): same verbs, unambiguous namespaces. Full Figma-MCP → AgentCanvas mapping in Appendix I.

| Tool | Figma MCP analog | Direction | Purpose |
|------|------------------|-----------|---------|
| `pen_get_metadata` | `get_metadata` | canvas → agent | Sparse structure read — layer ids/names/types/positions/sizes for a `nodeId` subtree; **omitting `nodeId` returns the page list** (Figma's exact recovery behavior: no id or invalid id → page list, never an error dead-end). Becomes the model's navigation entry point, superseding `pen_list_shapes` as the preferred read. |
| `pen_get_design_context` | `get_design_context` | canvas → agent | The flagship handoff payload, 4 parts like Figma's: (1) reference code — React + Tailwind + TS carrying `data-name`/`data-node-id` attributes and `var(--token, fallback)` values, (2) a screenshot of the selection, (3) embedded conversion instructions for retargeting to the user's stack, (4) asset URLs. Built on the §5.3 serializer; subsumes copy-as-code for handoff flows. |
| `pen_get_screenshot` | `get_screenshot` | canvas → agent | Real-canvas PNG of a node / selection / page (client `html-to-image` capture, §5.4) — for the VLM critic and self-verification (M4). |
| `pen_get_variable_defs` | `get_variable_defs` | canvas → agent | Variables + styles used by a selection — names, resolved values, code syntax — so generated code binds tokens (`var(--acv-color-primary)`) instead of raw hex. Feeds the serializer's token-aware emission (§5.3). |
| `pen_get_computed` | — (ours) | canvas → agent | Per-node `getComputedStyle` subset + measured rect (+ effective variable values) via the `agent:computed` round-trip (M3/M5). No Figma analog — scoped DOM readback is the DOM-renderer dividend. |
| `pen_insert_html` | `generate_figma_design` | agent → canvas | Sanitized HTML+inline-CSS fragment → `.pen` subtree under a parent (M1). Figma's tool captures live web UI into layers; ours accepts an HTML string — same code→canvas direction, one call replacing N `pen_create_shape` calls. |
| `pen_bake_layout` | — (ours) | canvas → model | Write measured bounds back into `.pen` sizes (§3.8). |
| `pen_copy_as_code` v2 | (client of `get_design_context`) | canvas → code | Reimplemented on the DOM serializer (§5.3); same tool name, upgraded output (M2). |

**Design principles for the tool surface, distilled from Figma's own choices** (research `scripts/research/r2-figma-agent-tooling.md`; applied verbatim here):

1. **Scope every read** to a node the caller chose — selection id or explicit `nodeId`; never whole-file dumps by default. `pen_get_metadata` with no id returns the page list precisely so the model can navigate before it reads.
2. **Narrow, purpose-built tools** the model composes (structure / code / screenshot / variables are separate) — the excluded context is as important as the included.
3. **Triangulate code + image + structure** — `pen_get_design_context` returns code *and* screenshot *and* instructions because the combination outperforms either alone.
4. **Cheap outline as entry point** — sparse metadata before heavy reads.
5. **Bind tokens, not values** — `var(--token, fallback)` in every emitted artifact; token names survive every transform.
6. **The file carries the semantics** — layer names, components, auto layout, variables are first-class agent inputs; provide cheap tools to improve them (we already have `pen_organize_layers` = Figma's *Rename layers*; `pen_recommend_components` = componentization suggestions).
7. **Prefer reuse over generation** — `pen_find_nodes` on the component index before synthesizing new subtrees; the system prompt teaches check-first (mirrors Figma's `search_design_system` posture).
8. **Writes must be recoverable** — every agent mutation is an undoable patch; Phase 7 adds named checkpoints (Figma Make's model) on top (§9.5).

**`pen_insert_html` pipeline (sanitized, deterministic):**
1. `DOMParser.parseFromString(html, 'text/html')` server-side.
2. Whitelist walk: allowed tags (`div, span, p, h1–h6, ul, ol, li, img, svg, path, button, label, input, textarea, form, a, section, header, footer, nav, hr, br, strong, em`); allowed attributes (`style, src, alt, width, height, href (http/https only), type, placeholder, value`); strip `on*` handlers, `javascript:` URLs, `<script>`, `<style>` (inline styles only in v1 — Tailwind-class import requires the mounted-iframe path below).
3. Map elements → `.pen` nodes via the Appendix A table **inverted**: block containers → `frame` (auto-layout if the computed style is flex), text leaves → `text`, `img` → image-fill node; `x/y/w/h` from parsed inline styles or sequential flow layout inside the target parent (no measurement needed — auto-layout does it).
4. Emit one `bulk_add` patch — agent-visible, undoable, sync-safe. 
5. **v2 (mounted-iframe extraction)** for full-fidelity import (external HTML with classes): mount in a hidden sandboxed `<iframe>` in the *browser*, walk with `getComputedStyle`, emit `.pen` via a new client→server `canvas:import_html` event. Enables paste-from-webpage (M6).

### 5.3 Copy-as-code v2 — one serializer, three frameworks

`serializeDom(root, { framework: 'html' | 'react' | 'tailwind' })` walks the node DOM (which carries `data-node-id/type`, Appendix C) and emits:

- **html**: nested semantic markup + inline styles (or a `<style>` block with generated classes — dedupe repeated style objects).
- **react**: same tree as a component with `style={{…}}` props, `data-node-id` → comments mapping.
- **tailwind**: the mapping table from Appendix B inverted to class candidates (`display:flex; gap:12px` → `flex gap-3`), arbitrary values for the rest (`w-[347px]`) — resolving today's D7 properly.
- Flex containers serialize as flexbox (responsive-ready), absolutely-positioned nodes keep `position:absolute` — matching what the user actually sees, because the DOM *is* what the user sees. Replaces both `exportCode` (`export.ts:280-317`) and the tool's inline emitter (`tools.ts:2642-2663`); the server-side tool gains the serialized string via a client round-trip (same mechanism as `pen_get_computed`) or falls back to the resolver-based emitter for headless contexts.

### 5.4 VLM critic on ground truth

`design-critic-vlm` currently calls `renderCanvasToPng` (server, resvg, images dropped — D8). New flow: when the client is connected, the runner emits `agent:screenshot_request`; the client captures the world layer via `html-to-image` (`toPng(worldRef.current)`, ~2× scale), returns a data URL through the existing pending/answers channel pattern (`/api/agent/answers`, `types.ts:434-441`); the critic consumes the real image. Fallback to the existing path when no client responds within a timeout. This closes the "critic judges a different picture" gap (M4) and fixes D8 incidentally.

### 5.5 Snapshot enrichment

`canvasSnapshot` (`runner-legacy.ts:582-655`) gains a `measured=` field per layer when `measuredBounds` are available (§3.8), e.g. `• id | text "Total" | pos=(320,88) size=auto→measured 84×24 …`. The agent's mental model stops diverging from pixels — cheap tokens, high value. (Long-term: mid-turn snapshot refresh is a separate, orthogonal runner improvement — noted, out of scope here.)

### 5.6 The Semantic Layer discipline (Figma's codegen-quality rules, adopted)

Figma's Dev Mode guidance is explicit that code-generation quality is determined by *file preparation*, not model cleverness — the "semantic layer." Our agent authors the file, so the discipline becomes agent behavior, enforced in the system prompt and measured in evals:

| Figma semantic rule | AgentCanvas enforcement |
|---------------------|--------------------------|
| Clear semantic layer names (`CardContainer`, `CTA_Button` — not `Frame1268`) | `pen_organize_layers` auto-naming already exists (`tools.ts:1153`); system prompt requires semantic names on creation; `pen_get_metadata` output echoes names, making bad names visible to the model mid-turn |
| Components for repeated patterns ("use components for repeats") | `pen_recommend_components` (`tools.ts:3473`) flags repeats ≥ threshold; Phase 6 `pen_get_metadata` reports `component-of` relations inline |
| Auto Layout as responsive intent (avoids absolute-position soup in codegen) | native mode (Phase 2) + `pen_apply_auto_layout`; eval scorer counts auto-layout coverage of frames |
| Variables as tokens — spacing/color/radius/typography | `pen_set_variable` + `pen_bind_variable` (Phase 6 renames from token tools, §9.4); `pen_get_variable_defs` surfaces token identity in every code read |
| Code Connect (component → real code component) | `serializeDom` emits `data-component-of` attributes; Code-Connect mapping table is a deliberate non-goal here (§9.6) |

### 5.7 Tool vocabulary migration (pointer)

Phase 6 renames the shape/token-era write tools to node/variable-era names via the alias registry — old names keep working through a deprecation window, and tool results carry a one-line migration notice that teaches the model the new spelling mid-session. The full rename matrix (old name → new name → parameter changes → phase) is Appendix G §G.3; the compat mechanism is specified in §9.3.

---

## 6. Migration plan — Phases 0–7

Two tracks. **Renderer track (0–5)** swaps the paint surface without touching vocabulary. **Figma-alignment track (6–7)** unifies vocabulary and UI after the renderer seam is proven. Every phase follows the repo's menu-spec format (Goal / Files to touch / Implementation steps / Tests / Acceptance criteria) and lands independently green: `bun run lint`, `bun run test`, and the phase's own acceptance gate. The renderer feature flag lives in `src/lib/settings/types.ts` (`AppSettings.appearance.renderer: 'svg' | 'dom'`, default `'svg'` until Phase 5) and is exposed in the Settings → Appearance section (`src/components/settings/SettingsDialog.tsx`). Phases 6–7 carry their own flags (`settings.ontology.penV3` read-path default; shortcuts are additive).

### Phase 0 — Parity harness + spike (de-risk before anything moves)

**Goal.** Prove the seam empirically and build the measurement tooling every later phase gates on. No product changes.

**Files to touch.**
- `tests/integration/renderer-parity.test.tsx` — **new**. Renders the same `CanvasDocument` through the SVG renderer and a minimal DOM prototype; asserts structural parity (same node count by type, same geometry within ε, same z-order) from a corpus of fixture documents.
- `scripts/dom-renderer-bench/` — **new**. Synthetic document generator (`--nodes N --screens S`) + frame-time probe (see Appendix F).
- `scripts/agent-eval/scenarios.ts` — extend with a `dom-renderer` scenario set (existing eval harness reuse).

**Implementation steps.**
1. Build the fixture corpus: export 5–10 real documents via `pen_export_pen` (dashboard demo, wireframe templates, user flows, vaultly session artifacts in `download/` are good seeds).
2. Write the DOM *prototype* `DomNode` (absolute-positioning only, ~200 lines) inside the parity test — not shipped to `src/` yet.
3. Add the geometry oracle: compare flat `Layer[]` vs rendered DOM rects (`getBoundingClientRect` scaled by 1/zoom) — requires a real-browser runner: use Playwright via the existing `agent-browser` environment for local runs; mark the test `describe.skipIf(!process.env.PARITY_BROWSER)` so CI without browsers still passes.
4. Baseline the current renderer's numbers (frame time at 1k/2k/5k nodes) — these become the "must beat" bars in Appendix F.

**Tests.** The parity test itself; bench harness smoke-runs in `bun test` env without browser.

**Acceptance criteria.**
- [ ] Parity test green on the fixture corpus (prototype DOM vs SVG: geometry ε ≤ 1px, z-order equal, type coverage ≥ the 17 `LayerType` values).
- [ ] Baseline bench numbers recorded in `docs/html-dom-renderer.md` Phase 0 appendix note (or `scripts/dom-renderer-bench/RESULTS.md`).
- [ ] No changes to `src/` product code.

### Phase 1 — DOM renderer, parity mode (the swap)

**Goal.** Ship `renderer: 'dom'` behind the settings flag, pixel-comparable with SVG mode in absolute-positioning terms, with chrome overlay and the data-attribute contract. Fix D1, D3, D4, D5, D6 on the way (they are prerequisites for correct parity, not riders).

**Files to touch.**
- `src/components/canvas/dom/{DomCanvas,DomNode,DomChrome,styleFor,islands}.tsx|ts` — **new** (structure §3.2; mappings Appendices A–C).
- `src/components/canvas/Canvas.tsx` — extract `ShapeRenderer` + SVG paint loop to `src/components/canvas/svg/` verbatim; `Canvas.tsx` becomes the shell choosing `<SvgCanvas/>` or `<DomCanvas/>` by flag.
- `src/lib/canvas/patch.ts` — D1 write-back (`pages[activePageIndex].children = next.children` at the end of `applyPatchToCanvas`); D3 recursive `expandRef`.
- `src/lib/canvas/store.ts` — D5 single-apply fix (remove the `store.ts:484` pre-apply, keep `_onSync` as the one applier in the fallback path; retain render-time dedupe as defense-in-depth).
- `src/lib/pen/resolve.ts` — expose the pre-flatten resolved tree (ref-expanded, variables resolved) as a typed export for `DomCanvas` (the flat `Layer[]` stays for parity mode and panels).
- `src/lib/settings/types.ts` + `src/components/settings/SettingsDialog.tsx` — the flag.
- `tests/unit/dom-node.test.tsx`, `tests/integration/renderer-dom.test.tsx` — **new** (jsdom-safe: absolute mode needs no real layout).

**Implementation steps.**
1. Bugfixes D1/D3/D5/D6 first, with regression tests (they change behavior for the SVG renderer too — all four are strict improvements).
2. Move SVG renderer to `svg/` (pure refactor; existing tests must stay green with updated import paths only).
3. Implement `styleFor.ts` (pure function: resolved node + mode → `CSSProperties`), `DomNode.tsx` (memoized, recursive, `data-*` per Appendix C), `islands.tsx` (path/star/polygon/icon/boolean emitters), `DomChrome.tsx` (selection outline, 8 handles, badges, agent-highlight pulse, snap guides — screen-space, reading measured rects), `DomCanvas.tsx` (world transform, background grid, culling stub disabled).
4. Rotation becomes canonical on-screen (D4): `transform: rotate(θ)` with `transform-origin: top left` in both renderers — align on-screen with exports.
5. Wire gestures: reuse `use-canvas-gestures.ts` untouched; it already drives `viewport` state that feeds the world transform (L1).
6. Wire hit-testing + drag/resize: pointer events on node divs; drag math reuses the existing canvas-space handlers (`Canvas.tsx:209-287` logic moves to a shared hook).

**Tests.** `dom-node.test.tsx` per-type style assertions (jsdom: `style` attributes are inspectable); `renderer-dom.test.tsx` mirrors the behavior coverage of `renderer.test.tsx` (patch → visible mutation → undo/redo) using `[data-node-type=…]` selectors; parity test extended to the real `DomCanvas`; all existing tests stay green (SVG path default).

**Acceptance criteria.**
- [ ] Flag flips renderer live; reload persists (settings store).
- [ ] Parity harness: DOM vs SVG geometry ε ≤ 1px on fixture corpus; visual spot-check screenshots recorded.
- [ ] Selection/drag/resize/context-menu/undo-redo/multi-select/marquee all work in DOM mode (manual checklist in `docs/html-dom-renderer.md` §Phase-1 checklist — port of current behaviors).
- [ ] D1/D3/D4/D5/D6 regression tests added and green.
- [ ] `bun run lint && bun run test` green.

### Phase 2 — Native CSS layout mode (the payoff for fidelity)

**Goal.** Per-document `layoutMode: 'native'`: flex containers render via CSS flexbox; browser measures text; variables resolve through CSS custom properties (fixing §1.4 defect class). Resolver stays authoritative for server/export paths with measured-bounds reconciliation.

**Files to touch.**
- `src/components/canvas/dom/{DomNode,styleFor}.tsx|ts` — flex mapping (§3.4 table), `content-visibility`/containment groundwork (L4).
- `src/components/canvas/dom/measure.ts` — **new** ResizeObserver pool → `measuredBounds` store slice.
- `src/lib/canvas/store.ts` — `measuredBounds` slice (runtime, non-persisted, excluded from undo snapshots).
- `src/lib/pen/document.ts` — D2: apply `componentProperties` during `expandRef` (boolean → `enabled`, text → descendant `content` binding, variant → `ref` swap, instance_swap → nested ref rewrite).
- `src/lib/pen/resolve.ts` — consume `measuredBounds` as intrinsic-size hints for `fit_content` nodes when available (server-side layout approximation improves automatically).
- `src/lib/canvas/render-to-png.ts` — prefer measured geometry over predicted when available (parities server screenshots with screen).

**Implementation steps.**
1. `measure.ts` + store slice + `DomNode` observers (un observe on unmount; pool capped, batched via `ResizeObserver` callback coalescing).
2. Flex CSS emission per §3.4; `fit_content`/`fill_container`/`layoutPosition:'absolute'` semantics; two-phase fill parity verified against resolver on the fixture corpus (geometry will differ where the resolver was *wrong* — text width — so the parity oracle gains a "divergence report" mode that classifies diffs as resolver-defect vs renderer-bug).
3. Variable publishing (§3.6): `--acv-*` on world root; theme attr switching; `set_variable` patch → property update only.
4. D2 `componentProperties` application + tests.
5. `pen_bake_layout` tool (schema Appendix D) writing measured sizes into the tree on demand.

**Tests.** jsdom-safe unit tests for `styleFor` flex mapping and variable publishing; **browser-gated** native-layout tests (`renderer-dom-native.test.tsx`, `skipIf(!process.env.PARITY_BROWSER)`): text measurement (a text node with `fit_content` width measures > 0 and < 100 — impossible today), variable-driven gap, themed recolor without re-resolve, componentProperties behavior. D2 covered in `tests/unit/component-system.test.ts` extensions.

**Acceptance criteria.**
- [ ] Native mode renders the fixture corpus with zero renderer-bug-class divergences (resolver-defect divergences documented and expected).
- [ ] Text nodes measure real widths (browser test); empty `fit_content` frames no longer 100×100.
- [ ] `set_variable` recolors bound nodes with no `resolvePenTree` re-run (perf assertion via bench harness).
- [ ] `componentProperties` (all four types) apply on expansion (D2 closed).
- [ ] Measured bounds flow to `render-to-png.ts` and snapshot enrichment.

### Phase 3 — Agent superpowers (the payoff for the pi-agent)

**Goal.** Ship M1–M6 with Figma-MCP-aligned tool names from day one: `pen_insert_html`, `pen_get_metadata`, `pen_get_design_context`, `pen_get_screenshot`, `pen_get_variable_defs`, `pen_get_computed`, copy-as-code v2, snapshot enrichment, HTML import v1.

**Files to touch.**
- `src/lib/agent/tools.ts` — new tools (`pen_insert_html`, `pen_get_metadata`, `pen_get_design_context`, `pen_get_screenshot`, `pen_get_variable_defs`, `pen_get_computed`, `pen_bake_layout` if not landed in Phase 2); `pen_copy_as_code` reimplemented over the serializer.
- `src/lib/canvas/html-import.ts` — **new**: sanitizer + element→`.pen` converter (server-side, pure, jsdom-testable via `DOMParser` — available in jsdom).
- `src/lib/canvas/dom/serialize.ts` — **new**: `serializeDom(root, {framework})` (§5.3).
- `src/lib/canvas/types.ts` — new `SyncEvent` variants: `agent:computed_request` / `agent:computed_response`, `agent:screenshot_request` / `agent:screenshot_response`, `canvas:import_html` (client→server); extend `ClientEvent` correspondingly.
- `src/lib/canvas/server.ts` — request/response bridging on the socket (mirror the pending/answers pattern, `types.ts:434-441`).
- `src/lib/agent/runner-legacy.ts` — `canvasSnapshot` enrichment (`measured=`).
- `src/lib/agent/subagents/design-critic-vlm.ts` — real-screenshot flow with fallback.
- `package.json` — add `html-to-image` (client capture; ~10 kB gzip). No other new deps.

**Implementation steps.**
1. `html-import.ts` sanitizer + converter + exhaustive tests (XSS corpus: `on*`, `javascript:`, `<script>`, `<style>` injection, nested SVG, `srcset`).
2. `pen_insert_html` tool (server-side path only — v1); wire into the skill registry's `layout`/`wireframe` categories (`skills/registry.ts`) so the classifier can select it.
3. `pen_get_metadata` first (pure model read — no round-trip needed; page-list default, nodeId scoping, Figma-shaped sparse output). Then socket round-trip events + `pen_get_computed` (timeout 2 s → resolver-data fallback so headless runs never hang), `pen_get_screenshot`, `pen_get_variable_defs` (variables/styles for a selection, code-syntax included).
4. `serializeDom` + `pen_get_design_context` (4-part payload over the serializer) + `pen_copy_as_code` v2 + `exportCode` delegation (delete the two stale emitters — D7 closed).
5. `pen_get_screenshot` + VLM critic integration (§5.4; D8 closed).
6. Snapshot enrichment (§5.5).
7. Update the system prompt's TURN FLOW + component-recipes section (`runner-legacy.ts:105-567`) to teach `pen_insert_html` as the preferred high-level construction primitive and the `pen_get_*` read ladder (metadata → design context/screenshot → computed) as the verification loop, with `pen_create_shape` demoted to surgical edits.

**Tests.** Sanitizer unit tests (security-critical — corpus-driven); `pen_insert_html` → `bulk_add` patch-shape tests in the existing `tools.test.ts` style; serializer golden-file tests (html/react/tailwind outputs for 3 fixture selections); round-trip integration test (insert HTML → serialize → semantic equivalence); VLM-critic fallback test (no client → old path).

**Acceptance criteria.**
- [ ] XSS corpus: 100% of malicious fixtures sanitized (no `on*` attributes, no `javascript:` URLs, no script/style nodes survive).
- [ ] Agent eval: `dom-renderer` scenario set shows ≥ 30% fewer tool calls for card/form/nav construction tasks vs baseline (measure via `scripts/agent-eval/run-eval.ts` — token + call-count report).
- [ ] Copy-as-code output for the dashboard fixture is nested flex HTML (not flat absolutes) and renders identically when opened standalone.
- [ ] VLM critic consumes a real screenshot when a client is attached (log line + event trace), falls back cleanly otherwise.
- [ ] `pen_get_computed` returns measured rect + ≥ 20 computed properties for a node in < 2.5 s end-to-end.
- [ ] `pen_get_metadata` with no id returns the page list; with a valid id returns a sparse ≤ 100-line-per-page structure containing id/name/type/x/y/w/h per node (Figma parity of shape).
- [ ] `pen_get_design_context` returns all 4 payload parts; code part carries `data-node-id` attributes and `var(--token, fallback)` for every bound variable.

### Phase 4 — Scale hardening (large designs, one project)

**Goal.** Make 5k-node pages and 20+ screen projects feel like 50-node ones: L4/L5 culling, patch coalescing, budget CI gates.

**Files to touch.**
- `src/components/canvas/dom/{DomCanvas,DomNode}.tsx` — `content-visibility`/`contain-intrinsic-size` (L4); `CullingCoordinator` (L5) with placeholder swap + hysteresis.
- `src/lib/canvas/store.ts` — rAF patch-coalescing queue (§4.4) in `_onSync` and `sendPatch` paths.
- `scripts/dom-renderer-bench/` — full harness: pan/zoom frame-time sampling, patch latency percentiles, heap snapshots (via `performance.memory` + CDP), CI mode with gates (Appendix F).
- `.github/workflows/ci.yml` — bench job (nightly or manual dispatch; browser-based via Playwright runner).

**Implementation steps.**
1. L4 CSS containment on containers (one-line style emission per container, guarded by a sub-flag while soak-testing).
2. Coalescing queue with order-preserving serial application (§4.4); property-test: randomized patch sequences produce identical documents batched vs unbatched.
3. L5 coordinator + placeholders + hysteresis; budget-aware activation (only ≥ 2k nodes).
4. Bench harness completion + record results; wire CI gate.
5. `pen_audit_design` gains node-budget warnings (§4.5 guidance).

**Tests.** Coalescing property tests; culling unit tests (coordinator math: viewport intersection, hysteresis, margin) with injected rects; browser-gated perf suite asserting Appendix F gates.

**Acceptance criteria.**
- [ ] Appendix F gates pass: 60 fps pan/zoom @ 5k-node page; p95 single-update patch-to-paint ≤ 16 ms; 500-node `bulk_add` ≤ 3 commits.
- [ ] 20-screen project fixture (agent-generated via `pen_generate_user_flow` ×5 + edits) loads and navigates without long tasks > 100 ms (except initial mount).
- [ ] Patch coalescing property test green; undo/redo semantics unchanged by batching.
- [ ] Bench results recorded; CI gate active.

### Phase 5 — Default flip + legacy path

**Goal.** DOM becomes the default renderer; SVG renderer becomes an explicit compatibility mode (kept for one minor release, then removal decision).

**Files to touch.**
- `src/lib/settings/types.ts` — default `'dom'`; migration note.
- `docs/AGENTS.md`, `src/components/canvas/AGENTS.md`, root `AGENTS.md` Child DOX Index — DOX pass.
- `README.md` — architecture diagram + features section updates (canvas described as DOM-rendered with SVG islands).
- `tests/integration/renderer.test.tsx` — finalize selector migration to the data-attribute contract (Appendix C) so behavior tests are renderer-agnostic where possible.

**Implementation steps.**
1. Flip default after ≥ 1 week of dogfooding in `dom` mode with the parity + perf suites green.
2. Telemetry-free adoption check: in-app counter on renderer mode usage (local only, respects the repo's no-telemetry posture — a settings-store boolean flipped per session).
3. DOX pass across the chain (root → components/canvas → components/canvas/dom new `AGENTS.md`).
4. Post-flip soak: one release with `'svg'` selectable in Settings; then a removal PR that deletes `svg/` and the flag (separate decision, new spec).

**Acceptance criteria.**
- [ ] Default `'dom'`; fresh sessions render DOM mode without user action.
- [ ] All docs/DOX updated in the same commit (repo contract).
- [ ] Full test suite + parity + perf gates green on default config.
- [ ] Rollback path documented (Settings → Appearance → Renderer → SVG).

### Phase 6 — Figma ontology unification (.pen v3 + tool vocabulary)

**Goal.** Close D9–D12: one Figma-REST-shaped vocabulary end-to-end — model fields, patch payloads, tool names/params, snapshot output — with a compat alias layer so nothing breaks mid-migration. May start once Phase 2 lands (so `styleFor` consumes Figma-shaped fields exactly once); independent of Phases 3–5 timing.

**Files to touch.**
- `src/lib/pen/types.ts` — v3 field shapes per Appendix G §G.1: `layoutMode: NONE|VERTICAL|HORIZONTAL` (+`GRID` reserved), `itemSpacing`, `paddingLeft/Right/Top/Bottom`, `primaryAxisAlignItems: MIN|CENTER|MAX|SPACE_BETWEEN`, `counterAxisAlignItems: MIN|CENTER|MAX`, `layoutSizingHorizontal/layoutSizingVertical: FIXED|HUG|FILL`, `layoutPositioning: AUTO|ABSOLUTE`, `fills: PenPaint[]` / `strokes: PenPaint[]` (SOLID, GRADIENT_LINEAR, GRADIENT_RADIAL, GRADIENT_ANGULAR, IMAGE with `scaleMode: FILL|FIT|TILE|STRETCH`), `effects: PenEffect[]` (DROP_SHADOW, INNER_SHADOW, LAYER_BLUR, BACKGROUND_BLUR), `cornerRadius` + `rectangleCornerRadii: [TL,TR,BR,BL]`, `characters` (text content), `textAutoResize: NONE|HEIGHT|WIDTH_AND_HEIGHT`, `visible` (replacing `enabled`), `blendMode` Figma spellings (`PASS_THROUGH`, …), constraints SCREAMING enums, variables as `Variable {id, name, variableCollectionId, resolvedType: COLOR|FLOAT|STRING|BOOLEAN, valuesByMode, scopes}` with `VariableCollection {id, name, modes: [{modeId, name}], defaultModeId}` replacing theme axes, node-level `boundVariables` + `explicitVariableModes` replacing `tokenBinding` + node `theme`.
- `src/lib/pen/migrate.ts` — **new**: `migratePenDocument(doc) → v3` (2.17 → 3.0, deterministic, total); wired into `penToCanvas` (`converters.ts:52`) and the `.pen` import path.
- `src/lib/pen/normalize.ts` — **new**: the alias normalizer — every legacy spelling (`gap`, `layout`, `fit_content`, `fill_container`, `alignX/alignY`, `center_h`, lowercase constraints, `enabled`, `textGrowth`, single-string fills…) accepted at the parse boundary and canonicalized. One function, used by patch applier, converters, and tool executors.
- `src/lib/canvas/types.ts` — `Layer` gains v3 mirrors (`layoutMode`, `itemSpacing`, `fills`, `effects`, `rectangleCornerRadii`, `characters`, …) populated by `resolvePenTree`; `CanvasPatch` payload fields accept both spellings via normalizer; `alignKind` gains canonical values `LEFT|RIGHT|HCENTER|TOP|BOTTOM|VCENTER|DISTRIBUTE_H|DISTRIBUTE_V|TIDY` (legacy aliases normalized).
- `src/lib/agent/tools.ts` + `pen-tools.ts` + `figma-tools.ts` — tool renames per Appendix G §G.3 via the alias registry (`pen_create_shape`→`pen_create_node`, `pen_update_shape`→`pen_update_node`, `pen_delete_shape`→`pen_delete_nodes`, `pen_find_shapes`→`pen_find_nodes`, `pen_duplicate_shape`→`pen_duplicate_nodes`, `pen_reparent_shape`→`pen_reparent_nodes`, `pen_update_tokens`→`pen_set_variables`, `pen_list_tokens`→`pen_list_variables`, `pen_bind_shape_to_token`→`pen_bind_variable`, `pen_apply_token`→`pen_apply_variable`, `pen_set_theme_axis`→`pen_set_variable_modes`, `pen_list_themes`→`pen_list_collections`, `figma_*` surface folded into the `pen_*` names with the `figma_` aliases retained); params `shapeId`→`nodeId`, `shapeIds`→`nodeIds` (aliases retained).
- `src/lib/agent/tool-aliases.ts` — **new**: `{ oldName → { target, deprecatedSince } }` registry; `executeTool` resolves aliases and appends a one-line deprecation notice to the result content.
- `src/lib/agent/runner-legacy.ts` — `canvasSnapshot` emits v3 vocabulary (`characters=`, `layoutMode=`, `itemSpacing=`, `modes=`), closing the prompt-vs-tools contradiction (D9).
- `src/lib/pen/resolve.ts`, `src/lib/canvas/patch.ts`, `src/lib/canvas/export.ts`, `src/lib/canvas/dom/styleFor.ts`, `html-import.ts`, `serialize.ts` — read/write v3 fields (single vocabulary for all four emitters stays intact).
- `src/lib/canvas/figma-ontology.ts` — **new**: the canonical enum tables (single source of truth for spellings, shared by types, normalizer, tests, and docs).
- `tests/unit/figma-ontology-contract.test.ts`, `tests/unit/pen-migration.test.ts`, `tests/unit/tool-registry.test.ts` — **new** (see §10).

**Implementation steps.**
1. `figma-ontology.ts` enum tables + contract test FIRST (spellings frozen by test before any field moves).
2. `migrate.ts` + fixture round-trip tests (every 2.17 fixture in `tests/fixtures/` migrates losslessly; semantic snapshot comparisons).
3. `normalize.ts` alias layer + exhaustive alias-matrix tests (every legacy spelling → canonical value).
4. Field migration in `types.ts`/`resolve.ts`/`patch.ts` behind normalizer; resolver emits v3 `Layer` mirrors while keeping legacy fields populated during the window (dual output, single source).
5. Tool renames + alias registry + deprecation notices; system prompt TURN FLOW examples rewritten to v3 vocabulary.
6. `pen_export_pen` writes v3 by default with `version: '3.0'`; import accepts 2.x forever (migrate-on-read).
7. Variables UI wiring: PropertiesPanel token/theme sections relabel to Figma UI terms (Variables, Collections, Modes) — display-only change; behavior identical.

**Tests.** Ontology contract test (enums match `figma-ontology.ts` exactly, snapshot-tested against Appendix G); migration round-trip suite; alias normalizer matrix (every entry in Appendix G §G.2 gets a parametrized case); tool-registry snapshot (names, params, alias targets); prompt-compat replay (recorded legacy transcripts still execute green through aliases); `figma-ontology.test.ts` / `component-system.test.ts` / `hierarchy-fixes.test.ts` migrated to v3 assertions with legacy fixtures retained as migration inputs.

**Acceptance criteria.**
- [ ] Every rename in Appendix G §G.1–G.3 implemented; `figma-ontology-contract.test.ts` green against the enum tables.
- [ ] A 2.17 `.pen` file exported before the phase loads, migrates, edits, re-exports as 3.0, reloads — zero semantic loss (round-trip suite).
- [ ] Legacy tool names still execute via aliases with deprecation notices; a recorded pre-migration agent session replays green.
- [ ] `canvasSnapshot` output contains zero occurrences of `shape`/`token`/`theme axis` vocabulary (D9 closed; assert by string scan).
- [ ] All four emitters (on-screen, export SVG, render-to-png, copy-as-code) read the same v3 fields — verified by a shared-fixture emission-parity test.
- [ ] `bun run lint && bun run test` green.

### Phase 7 — Figma UI workflow alignment (canvas functionalities & chrome)

**Goal.** Close D13–D14: implement the missing Figma canvas functionalities, align shortcuts/panels/toolbar to Figma conventions (Appendix H), and add version-history checkpoints for agent writes. Renderer-independent; may start after Phase 1.

**Files to touch.**
- `src/lib/canvas/shortcuts.ts` — **new**: single shortcut registry (action id → {mac, win, label, scope}) driving both the keymap and `KeyboardShortcutsDialog.tsx`; Figma-canonical bindings per Appendix H §H.2 with our documented deviations (⌘⇧1/⌘⇧2 panel toggles stay).
- `src/components/canvas/Canvas.tsx` (+ `dom/DomCanvas.tsx`) — marquee selection (rubber-band; ⌘-drag = nested marquee), deep select (⌘+click cycles selection through the ancestor chain), Enter/⇧Enter/Tab/⇧Tab hierarchy navigation, scale tool (K — proportionally scales W/H/fontSize/strokeWidth, Figma `rescale()` semantics: ignores constraints), ⌥-hover distance measure overlay, snap-to-pixel + pixel grid + pixel preview + outline mode (⌘⇧O) view options.
- `src/components/canvas/Rulers.tsx` — **new**: top/left rulers, drag-out guides, ⌥-drag redline measurements.
- `src/components/canvas/Toolbar.tsx` — restructure to Figma grouping (Move/Hand/Scale | Frame/Section/Slice | Shape menu | Text | Comment) with Figma keys (V, H, K, F, ⇧S, S, T, C); zoom/view-options menu (pixel grid ⌘', snap ⌘⇧', pixel preview, outlines).
- `src/components/canvas/PropertiesPanel.tsx` — restructure section order to Figma's: alignment row (+distribute, tidy) → position (X/Y/rotation/constrain-proportions) → dimensions (W/H with **Fixed/Hug/Fill per-axis dropdowns** writing `layoutSizingHorizontal/Vertical`) → auto layout (direction, gap→itemSpacing, per-side padding, align box, wrap) → constraints → appearance (opacity, blend, corner radius) → fill/stroke/effects → component/instance section (variant properties, swap, detach ⌥⌘B, reset overrides) → export.
- `src/components/canvas/LayersPanel.tsx` — Pages column (page list + add/rename/duplicate/delete), Assets tab (⌥2: component grid from `collectComponents()`, drag-to-canvas places an instance), rename-on-⌘R, lock ⌘⇧L / hide ⌘⇧H per-row.
- `src/components/canvas/TopMenuBar.tsx` — add View items (Zoom to fit ⇧1 / Zoom to selection ⇧2 / 100% ⇧0, Rulers, Pixel grid, Snap to pixel grid, Outline mode), Object items (Frame selection ⌥⌘G, Wrap in new section ⇧S, Flatten ⌥⇧F, Mask ⌃⌘M, Boolean ⌥⇧U/S/I/E, Scale tool), Edit > Select all with same (property/fill/font).
- `src/lib/canvas/version-history.ts` — **new**: named checkpoints (`{id, label, createdAt, document snapshot}` persisted per session file); auto-checkpoint at each agent turn end (Figma Make's model) + manual ⌘⌥S; Version History panel (list/preview/restore); restore = new checkpoint (never destructive).
- `src/lib/canvas/store.ts` — checkpoint actions; selection-state extensions (marquee results, deep-select cycle stack).
- `tests/unit/shortcut-registry.test.ts`, `tests/integration/canvas-interactions.test.tsx`, `tests/integration/version-history.test.tsx` — **new** (see §10).

**Implementation steps.**
1. Shortcut registry first (table-driven; conflict detection test: no two actions bind the same chord in the same scope).
2. Marquee + deep select + keyboard hierarchy navigation (pure interaction work on the existing selection model).
3. Scale tool + measure overlay + rulers/guides (chrome-overlay features — no world-tree changes).
4. View options (pixel grid/snap/preview/outline) — snap-to-pixel rounds drag results to integers when enabled; outline mode toggles a `data-ac-outline` world attr consumed by `styleFor` (fills→none, strokes→1px).
5. Panel restructure (PropertiesPanel section order + Hug/Fill/Fixed dropdowns bound to v3 sizing fields; LayersPanel Pages column + Assets tab).
6. Version history: store slice, turn-end auto-checkpoint hook in the agent translator, panel UI, restore flow.
7. Menubar/toolbar relabel per Appendix H; `KeyboardShortcutsDialog.tsx` regenerated from the registry.

**Tests.** Shortcut-registry table test (every Appendix H binding present, unique, and matching the dialog render); interaction tests for marquee/deep-select/Enter-nav/scale (jsdom pointer-event simulation on the DOM renderer); version-history tests (auto-checkpoint per turn, restore round-trip, undo-after-restore); Hug/Fill/Fixed dropdown ↔ `layoutSizing*` write-through tests; Figma-workflow e2e smoke (browser-gated): draw frame → marquee → group ⌘G → rename ⌘R → checkpoint → restore.

**Acceptance criteria.**
- [ ] Appendix H §H.2 bindings live and conflict-free; shortcuts dialog matches the registry byte-for-byte.
- [ ] Marquee, ⌘-deep-select, Enter/⇧Enter/Tab navigation, K-scale, ⌥-measure, rulers/guides, pixel grid/snap, outline mode all operable (manual checklist + interaction tests green).
- [ ] PropertiesPanel exposes Hug/Fill/Fixed per axis; setting Fill on a child in an auto-layout frame stretches it (native mode) exactly as Figma does.
- [ ] Every agent turn produces a restorable checkpoint; restoring preserves current undo stack semantics (documented, tested).
- [ ] Assets tab lists components and drag-to-canvas places a live instance.
- [ ] `bun run lint && bun run test` green.

---

## 7. Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R1 | **Text-metric divergence** between resolver predictions and browser layout breaks export/VLM parity | High (it's the point of native mode) | Medium | Parity mode ships first (Phase 1, zero divergence); native mode adds a *divergence classifier* to the oracle; measured-bounds readback reconciles server paths; `pen_bake_layout` for deterministic export |
| R2 | **jsdom cannot test native layout** (no real engine) | Certain | Medium | Absolute mode is fully jsdom-testable; native-mode tests are browser-gated (`PARITY_BROWSER`); Playwright/agent-browser runs locally + CI browser job |
| R3 | **Selection/resize fidelity regressions** (chrome moves to overlay) | Medium | High | Overlay reads `getBoundingClientRect` (source of truth); Phase 1 manual checklist ports every current interaction; parity harness covers geometry |
| R4 | **Perf regression vs SVG at small documents** (DOM heavier per node than SVG for simple rects) | Low | Low | L1–L3 optimizations offset; bench gates compare against SVG baseline at 50/200/1000 nodes; culling disabled below 2k |
| R5 | **XSS via `pen_insert_html`** | Medium (LLM-generated HTML) | High | Server-side whitelist sanitizer with corpus-driven security tests; no `dangerouslySetInnerHTML` anywhere (React-escaped children only); v2 iframe path is sandboxed + `getComputedStyle`-only extraction |
| R6 | **Blending/effects gaps** (mix-blend-mode, shader/mesh fills have no CSS equivalent) | Medium | Low | SVG islands for shader/mesh; `mix-blend-mode` CSS for standard blend modes; documented fallback matrix in Appendix B |
| R7 | **Memory growth from measured-bounds + observers** at 10k+ nodes | Medium | Medium | Observer pool with unobserve-on-cull; `measuredBounds` pruned with culling; L5 placeholders shed observers |
| R8 | **Multiplayer patch races** amplified by coalescing | Low | Medium | Coalescing preserves order (serial apply to one clone); property tests; the existing id-dedupe defense stays |
| R9 | **Scope creep into the runner/agent loop** | Medium | High | Phase fence: runner changes are limited to new tools + snapshot enrichment (Phase 3) and event vocabulary additions; the patch contract freeze (§5.1) is the guardrail — any PR touching op semantics is out of scope by definition |
| R10 | **Loss of "SVG-native" debugging** (inspect element changes shape) | Low | Low | `data-*` contract (Appendix C) + a dev-only outline mode; React DevTools integration unchanged |
| R11 | **Alias rot**: legacy spellings linger in prompts/sessions/fixtures forever, or the deprecation window closes before recorded sessions are replayed | Medium | Medium | Alias registry is data (not code paths) — cost of retention is ~0; removal gated on `agent-eval` replay suite passing with zero alias hits across two release cycles |
| R12 | **Enum-casing migration corrupts documents** (lowercase → SCREAMING_SNAKE across .pen, patches, tools, UI simultaneously) | Medium | High | `normalize.ts` canonicalizes at every parse boundary; `migrate.ts` is deterministic + total with round-trip suite; dual-field output during the window; migration runs in CI against every fixture |
| R13 | **Prompt/eval invalidation**: renaming tools degrades the model's tool-selection accuracy mid-window (mixed vocabularies in training-less few-shot examples) | Medium | Medium | System prompt examples rewritten in the same commit as renames; agent-eval regression suite gates the phase; deprecation notices in tool results teach the new spelling mid-session |
| R14 | **Shortcut collisions with browser/OS chords** (⌥⌘K, ⌃⌘M, ⌘' have browser defaults in some environments) | High | Low | Shortcut registry conflict test + `preventDefault` discipline; documented deviations list (Appendix H §H.3); user-rebindable registry is the escape hatch |
| R15 | **Figma-ontology drift**: Figma ships new node types/enums (e.g. TRANSFORM_GROUP, GRID layout, extended collections) faster than we track | Certain (slow) | Low | `figma-ontology.ts` is a versioned table with upstream references; contract test pinpoints drift; additions are additive (new enum values) by design |

---

## 8. Open questions

1. **Does parity mode survive Phase 5, or is it scaffold-only?** Recommendation: keep it as the jsdom-test/export path; revisit at removal time. Cost is low (`styleFor` already parameterized by mode).
2. **Shadow DOM for inserted HTML fragments** (style isolation for v2 import): breaks CSS-var inheritance unless `::part`/props are forwarded — decide during Phase 3 v2 with a spike; default is class-prefix scoping.
3. **`contentEditable` on-canvas text editing** — natural follow-up capability unlocked by DOM mode; deliberately out of this spec's scope (PropertiesPanel remains the editor). Deserves its own small spec after Phase 2.
4. **Playwright as a devDependency** for browser-gated tests vs keeping them env-gated (`agent-browser` available in sandbox): decision at Phase 1 CI wiring; recommendation: dev-dep `playwright-core` + system Chromium in CI, env-gated locally.
5. **Should `renderCanvasToSvg` eventually be derived from the DOM serializer** (single emitter, §1.2 collapses to *one*) rather than kept as parallel SVG path? Deferred to post-Phase-3 once `serializeDom` proves fidelity — the SVG export path has real users via `pen_export_svg`.
6. **Zoom clamp unification** (D6): pick 0.1–8 everywhere (gesture range) — confirm with UX.
7. **(Rev 2) REST vs Plugin vs UI discrepancies** — Figma itself is inconsistent (page = `CANVAS` in REST / `PAGE` in Plugin; polygon = `REGULAR_POLYGON` / `POLYGON`; constraints `LEFT_RIGHT` / `STRETCH`). We canonicalize on **REST** everywhere (§9.1). Revisit only if we ever add a real Figma-file import feature.
8. **(Rev 2) Figma file import/export** (real `.fig`/REST-file ingestion) — deliberately out of scope; the ontology alignment makes it *possible* later but nothing here depends on it. Deserves its own spec if requested.
9. **(Rev 2) Do we keep `zIndex` on `Layer` after Phase 6?** Figma has no zIndex (child order is z-order). Recommendation: keep as derived field (computed from child order) during the window, deprecate writes (`pen_reorder_shape` already models Figma's reorder semantics), remove in a later cleanup — decision at Phase 6 kickoff.
10. **(Rev 2) Auto-checkpoint cadence** — per agent turn (Figma Make's model) vs per N patches vs debounce. Per-turn is the spec default (Phase 7); revisit if session files grow beyond ~5 MB.

---

## 9. Figma ontology alignment (terms, data model, tools, UI)

### 9.1 Canonical-surface decision

Figma itself speaks three dialects that disagree on the same concepts — REST API, Plugin API, and UI labels (research `scripts/research/r1-figma-ontology.md`):

| Concept | REST API | Plugin API | UI label | **AgentCanvas adopts** |
|---------|----------|------------|----------|------------------------|
| Page node type | `CANVAS` | `PAGE` | "Page" | `page` (concept-term; we keep `PenPage`/`pages[]` — type-string `page`, not `canvas`, to match UI and avoid colliding with our own "canvas document" term) |
| Polygon | `REGULAR_POLYGON` | `POLYGON` | "Polygon" | `polygon` (we already use it) |
| Constraints H | `LEFT/RIGHT/CENTER/LEFT_RIGHT/SCALE` | `MIN/CENTER/MAX/STRETCH/SCALE` | Left / Right / Center / Left & Right / Scale | REST (`LEFT_RIGHT`, `SCALE`) |
| Sizing | `layoutSizingHorizontal/Vertical: FIXED/HUG/FILL` | same | "Fixed / Hug contents / Fill container" | REST + UI labels |
| Frame overflow | `HORIZONTAL_SCROLLING/…` | `HORIZONTAL/…` | "Overflow behavior" | REST (Phase 7+, not yet modeled) |
| Variable types | `BOOLEAN/FLOAT/STRING/COLOR` | + `EASING/TIMING` | Boolean / Number / String / Color | REST four |
| Node position | `absoluteBoundingBox`, `relativeTransform` | `x`, `y`, `width`, `height` | X/Y/W/H fields | Plugin-style `x/y/width/height` **relative to parent** (we already do this); REST boxes only in export/inspect outputs |
| Component props | `BOOLEAN/TEXT/INSTANCE_SWAP/VARIANT` | + `SLOT` | + Slot | we keep `SLOT` (already shipped, `pen/types.ts:238-245`) |

**Rules.** (a) Serialized-model enums use REST spellings, SCREAMING_SNAKE (`SPACE_BETWEEN`, `LEFT_RIGHT`, `GRADIENT_LINEAR`). (b) TS field names are REST camelCase (`itemSpacing`, `primaryAxisAlignItems`, `rectangleCornerRadii`). (c) UI labels follow Figma UI3 exactly ("Hug contents", "Fill container", "Auto layout", "Variables", "Wrap in new section"). (d) The agent read-tools follow Dev Mode MCP verbs (§9.4). (e) Extensions are allowed as **supersets** — new enum values or new node types (`.pen`'s `note/prompt/context/icon/script`) — never as renames of Figma concepts.

### 9.2 Terminology unification (summary; full matrix Appendix G)

| Today (legacy) | Figma-canonical (v3) | Where it lives today |
|----------------|----------------------|----------------------|
| shape / `shapeId` | node / `nodeId` | `tools.ts` params, `Shape` alias (`types.ts:50,173`) |
| token / `ColorToken` / `TextStyleToken` | variable (`COLOR/FLOAT/STRING/BOOLEAN`) + text styles | `types.ts:187-205`, token tools `tools.ts:1659-2352` |
| theme axis / `themes` / `theme` | variable collection / modes / `explicitVariableModes` | `pen/types.ts:23-56`, `pen-tools.ts:41-598` |
| `tokenBinding {fillToken,…}` | `boundVariables {fills:[], strokes:[], characters}` | `types.ts:141` |
| `layout/gap/padding/justifyContent/alignItems` | `layoutMode/itemSpacing/paddingLeft…/primaryAxisAlignItems/counterAxisAlignItems` | `pen/types.ts:60-75` |
| `fit_content` / `fill_container` | `HUG` / `FILL` (`layoutSizingHorizontal/Vertical`) | `pen/types.ts:77-95` |
| `layoutPosition: auto/absolute` | `layoutPositioning: AUTO/ABSOLUTE` ("Ignore auto layout" in UI) | `pen/types.ts:223` |
| `fill`/`stroke` strings, `gradient`, `shadow`, `blur` | `fills: Paint[]`, `strokes: Paint[]`, `effects: Effect[]` | `types.ts:114-149`, `pen/types.ts:105-192` |
| `radius` / `radii` | `cornerRadius` / `rectangleCornerRadii [TL,TR,BR,BL]` | `types.ts:117,64-69` |
| text `content` / `textColor` / `textGrowth` | `characters` / color-in-`fills` / `textAutoResize` | `pen/types.ts:330`, `types.ts:118-120` |
| `enabled` | `visible` | `pen/types.ts:216` |
| `alignKind: center_h/…` | `HCENTER/VCENTER/DISTRIBUTE_H/DISTRIBUTE_V/TIDY` + Figma UI labels | `types.ts:347` |
| `zIndex` + `zorder` op | child order (z-order = index in `parent.children`) | `types.ts:137`, `patch.ts:495` |

### 9.3 Compatibility & migration mechanics (how nothing breaks)

1. **Parse-boundary normalization** — `src/lib/pen/normalize.ts` canonicalizes every legacy spelling at the three boundaries where external vocabulary enters: `.pen` import (`penToCanvas`), patch application (`applyPatchToCanvas`), and tool-parameter execution. Old documents and in-flight sessions never see an error, only canonical storage.
2. **Deterministic total migration** — `src/lib/pen/migrate.ts` upgrades 2.17 → 3.0 documents on read; export writes 3.0; import accepts 2.x indefinitely. Round-trip suite in CI (Phase 6).
3. **Dual-field window** — during the deprecation window `resolvePenTree` populates both legacy and v3 `Layer` fields (single source, two projections) so panels, tests, and emitters migrate one-by-one without a flag day.
4. **Tool alias registry** — `src/lib/agent/tool-aliases.ts` maps every old tool name to its successor; `executeTool` resolves aliases and appends a deprecation notice into the result text (teaches the model the new name mid-session — LLMs migrate faster than codebases).
5. **Removal gates** — legacy spellings are deleted only when the agent-eval replay suite records zero alias hits across two release cycles (R11).

### 9.4 Agent tooling alignment (summary of §5.2 + Phase 6 renames)

- **Reads become Figma-MCP-shaped**: `pen_get_metadata` (sparse structure; page-list default), `pen_get_design_context` (code+screenshot+instructions+assets), `pen_get_screenshot`, `pen_get_variable_defs`, plus our DOM dividend `pen_get_computed`. Appendix I maps every Figma MCP tool to our surface.
- **Writes keep granular verbs** (create/update/delete/group/align/…) — Figma's own `use_figma` is one mega-tool, but Figma's *documented design principles* favor narrow composable tools; we follow the principle, not the surface (§9.6).
- **Params unify on `nodeId`/`nodeIds`** with `shapeId` aliases.
- **The snapshot speaks Figma** — `canvasSnapshot` emits v3 vocabulary, so the system prompt's existing "think in FRAMES/COMPONENTS/VARIABLES" instruction finally matches what the model reads and writes (D9).
- **The Semantic Layer discipline** (§5.6) is enforced in the system prompt and measured in evals.

### 9.5 UI workflow alignment (summary of Phase 7; full matrix Appendix H)

Figma UI3 is the reference for chrome: left sidebar (Pages column + Layers/Assets tabs), right sidebar section order (alignment → position → dimensions with Hug/Fill/Fixed → auto layout → constraints → appearance → fill/stroke/effects → component/instance → export), toolbar grouping, the shortcut set (⌥⌘K create component, ⌥⌘B detach, ⌘⇧L lock, ⌘⇧H hide, ⇧1/⇧2/⇧0 zoom, ⌘⇧O outline mode, K scale, ⌥⇧F flatten, ⌃⌘M mask), and the canvas interaction model (marquee, ⌘-deep-select, Enter/⇧Enter/Tab navigation, ⌥-measure, snap-to-pixel, paste-over-selection ⌘⇧V). Version-history checkpoints (Figma Make's recoverable-writes model) land with it. Deviations are enumerated in Appendix H §H.3.

### 9.6 Deliberate deviations from Figma (documented, not drift)

| # | Deviation | Reason |
|---|-----------|--------|
| 1 | `pen_` prefix on MCP-verb tools (`pen_get_metadata` vs `get_metadata`) | Collision-free coexistence with a real Figma MCP server via our `mcp-adapter` plugin |
| 2 | Granular write tools instead of one `use_figma` mega-tool | Figma's own stated principle — narrow purpose-built tools compose better; our runner already proves it |
| 3 | `descendants` id-path instance overrides (superset of Figma's field-diff `overrides`) | Already shipped, strictly more expressive; Figma-shaped `componentProperties` sits alongside it |
| 4 | `.pen` extension node types (`note, prompt, context, icon, script, ref`) | Product surface beyond Figma Design's scope; additive superset |
| 5 | Opaque string node ids (not Figma's `I:N`) | Ids are already ubiquitous; Figma's format is a serialization detail with no semantic gain for us |
| 6 | No FigJam-only types (STICKY, CONNECTOR, SHAPE_WITH_TEXT, TABLE, WASHI_TAPE), no WIDGET/EMBED/prototype mode | Different product domain; `pen_generate_diagram` covers flowcharts at the generator level |
| 7 | No Code Connect round-trip yet | Requires a code-component registry we don't have; `data-component-of` serialization attributes keep the door open |
| 8 | `zIndex` retained as derived field during Phase 6 window | Zero-cost compat; removal is its own cleanup (Open question 9) |

---

## 10. Test strategy

### 10.1 Current inventory and coupling debt (Rev 2 audit)

Vitest 4 + jsdom only (`vitest.config.ts`; no Playwright anywhere — browser checks are ad-hoc scripts). 21 unit + 7 integration files. The renderer-coupled debt, with the exact selectors that must migrate to the Appendix C data-attribute contract:

| File | Coupled assertions | Migrates in |
|------|-------------------|-------------|
| `tests/unit/ShapeRenderer.test.tsx` | `querySelector('rect'/'ellipse'/'path'/'polygon'/'polyline'/'image'/'text'/'line')` :95-102; `querySelectorAll('stop')` :257; `feDropShadow` :364; `feGaussianBlur` :394,416; `animate` :521 | Phase 1 (`tests/unit/dom-node.test.tsx` mirrors coverage via `[data-node-type=…]`) |
| `tests/integration/renderer.test.tsx` | `querySelectorAll('rect, ellipse, circle, polygon, polyline, image, text')` :113; `rect[fill="#ff0000"]`-style attribute matching :124-333; `linearGradient`/`stop`/`filter` :258-282 | Phase 1 + Phase 5 (renderer-agnostic `[data-node-id=…]` + style-property assertions) |
| `tests/unit/export-fixes.test.ts` | SVG string-content matching (legitimate — export output *is* SVG) | Kept as-is; emission-parity test added in Phase 6 |
| Model-level tests (`patch/store/tools/component-system/hierarchy-fixes/figma-ontology/…`) | Assert `Layer`/patch fields, not markup — renderer-agnostic already | Phase 6: v3 field assertions + legacy fixtures as migration inputs |

### 10.2 Ontology test layers (Phase 6 — new)

1. **`tests/unit/figma-ontology-contract.test.ts`** — the enum spellings in `figma-ontology.ts` are snapshot-frozen; every TS union in `pen/types.ts` + `canvas/types.ts` is type-checked against the tables (compile-time) and value-checked at runtime. Any vocabulary drift fails CI with a diff.
2. **`tests/unit/pen-migration.test.ts`** — 2.17 → 3.0 round-trip: for every fixture, `migrate(deserialize(serialize(doc)))` ≡ semantics-preserving (node count, geometry, fills, variables, component relations); golden semantic snapshots.
3. **Alias matrix tests** — parametrized over every Appendix G §G.2 row: legacy spelling in → canonical spelling stored; unknown spellings fail loudly (no silent defaults).
4. **`tests/unit/tool-registry.test.ts`** — registry snapshot (names, params, alias targets, deprecation flags); a legacy-name execution returns the new tool's result + notice; unknown tool names error (never silently resolve).
5. **Prompt-compat replay** — recorded pre-migration agent transcripts (`scripts/agent-eval/` corpora) replay green end-to-end through the alias layer; zero-alias-hit recordings collected as removal evidence.
6. **Snapshot vocabulary scan** — `canvasSnapshot` output contains no legacy tokens (`shape=`, `token`, `theme axis`) — D9's regression guard.

### 10.3 UI workflow tests (Phase 7 — new)

1. **`tests/unit/shortcut-registry.test.ts`** — table-driven: every Appendix H §H.2 binding exists, is unique per scope, and `KeyboardShortcutsDialog` renders from the same registry (no drift between keymap and help).
2. **`tests/integration/canvas-interactions.test.tsx`** — jsdom pointer-event simulation: marquee selects intersected nodes; ⌘+click deep-select cycles the ancestor chain; Enter/⇧Enter/Tab navigation; K-scale multiplies fontSize/strokeWidth; snap-to-pixel rounds dragged coordinates; outline mode strips fills via `styleFor`.
3. **`tests/integration/version-history.test.tsx`** — auto-checkpoint per agent turn; restore produces a new checkpoint; undo-after-restore behaves per spec.
4. **Hug/Fill/Fixed write-through** — panel dropdown ↔ `layoutSizingHorizontal/Vertical` fields ↔ rendered flex behavior (native-mode browser-gated variant).

### 10.4 Agent evals (extend `scripts/agent-eval/`)

1. **Figma-term comprehension eval** — prompts phrased purely in Figma vocabulary ("make the header frame hug its contents", "set the button's corner radius", "wrap these screens in a section", "fill the container", "bind that color as a variable"): success rate and correct-tool-selection rate must not regress across Phase 6 (expect improvement as prompt/tool/snapshot vocabularies converge).
2. **Tool-call efficiency** (existing Phase 3 gate) — ≥ 30% fewer calls on composite construction once `pen_insert_html` + metadata ladder land.
3. **MCP-parity checks** — `pen_get_metadata` output shape compared structurally to Figma's documented sparse-XML (ids/names/types/positions/sizes per node; page list on missing id).
4. **Semantic-layer scorer** — auto-layout coverage of frames, variable-binding coverage of colors/spacing, semantic-name ratio; reported per eval run (feeds §5.6 discipline).

### 10.5 Browser-gated & visual regression

- The Phase 0 parity harness doubles as the visual-regression backbone: Playwright screenshot diffs per fixture per phase (SVG baseline vs DOM parity vs DOM native), `PARITY_BROWSER`-gated so jsdom CI stays green.
- Native-layout tests (text measurement, variable-driven gap, themed recolor) stay browser-gated (R2 mitigation).

### 10.6 Perf gates

Appendix F unchanged, plus Phase 6 additions: migration throughput (10k-node 2.17 document migrates < 500 ms), alias-normalization overhead < 0.1 ms per patch (bench assertion), and dual-field window memory overhead < 5% (heap snapshot diff).

### 10.7 CI tiering

| Tier | Runs | Trigger |
|------|------|---------|
| Fast | jsdom unit + integration (all layers above) | every PR |
| Browser | parity + native + interaction suites (Playwright) | PRs touching `src/components/canvas/**`, `src/lib/canvas/**`, `src/lib/pen/**` |
| Nightly | perf gates (`medium`+`large`), migration soak on fixture corpus | cron |
| Weekly | agent-eval regression (comprehension, efficiency, replay) + removal-gate alias-hit census | cron |

### 10.8 Freeze-invariant guard

A golden-snapshot suite pins the semantics of all 42 patch ops (`patch → document` pairs): it must stay byte-identical across Phases 1–5 (renderer track) and change *only* in the Phase 6 commit that introduces normalized spellings (snapshot then re-pinned with alias-equivalence assertions). This makes the "frozen contract" claim executable rather than aspirational.

---

## Appendix A — Node → DOM element mapping

| `.pen` node type | DOM element | Notes |
|------------------|-------------|-------|
| `frame` | `<div data-node-type="frame">` | `overflow: hidden` when `clip`; `display: flex` when `layout ≠ 'none'` (native mode); background/fill, border (stroke), radius, shadow, blur per Appendix B |
| `section` | `<div data-node-type="section">` | Renders children; label chip rendered by chrome overlay (not in world tree) |
| `component` | `<div data-node-type="component" data-component-master>` | Paints as its subtree; "M" badge via overlay |
| `component_set` | `<div data-node-type="component_set">` | Container of variant components; `variantLayout` maps to flex row/column/grid |
| `ref` (instance) | `<div data-node-type="instance" data-instance-of="<componentId>">` | Children = expanded clone keyed `(instanceId, sourcePath)`; "◆" badge via overlay |
| `rectangle` | `<div data-node-type="rectangle">` | Fill/radius/stroke/shadow via CSS |
| `ellipse` | `<div data-node-type="ellipse">` | `border-radius: 50%`; `innerRadius`/`startAngle`/`sweepAngle` variants → SVG island |
| `text`, `note`, `prompt`, `context` | `<div data-node-type="text">` (real text content) | Full typography: `font-weight`, `letter-spacing`, `line-height`, `text-align`, wrapping; `textGrowth: fixed-width` → explicit width; `auto` → `width: max-content` |
| `line` | `<div data-node-type="line">` | Thin rotated div (`transform: rotate(atan2(dy,dx))`, width = length, height = strokeWidth) or SVG island when arrows/caps land |
| `path` | `<div data-node-type="path">` wrapping `<svg>` island | `geometry` path data, `viewBox`, `fillRule` |
| `boolean_operation` | `<div data-node-type="boolean_operation">` wrapping SVG island | clipPath/mask composite of children geometries |
| `star`, `polygon` | `<div>` wrapping SVG island | polygon points; `cornerRadius` needs vector paths |
| `image` (image fill) | `<img>` inside node div or `background-image` | `mode: fill → object-fit: cover`, `fit → contain`, `stretch → fill` |
| `group` | `<div data-node-type="group">` | Unpainted positioning container (dashed outline via overlay when selected/hovered, replacing today's always-on outline `Canvas.tsx:980-997`) |
| `slice` | nothing in world tree | Chrome overlay only (translucent green), matching today (`Canvas.tsx:1170-1199`) |
| `icon` | `<div>` wrapping `<svg>` island | lucide/feather path data; `weight`/`fill` mapped to stroke/fill attrs |
| `script` | maps to `frame` | Matches `mapNodeType` (`resolve.ts:727-753`); never executed by resolver — unchanged behavior |

## Appendix B — .pen property → CSS mapping

> Note (Rev 2): left column uses current (2.17) names; Phase 6 renames per Appendix G §G.1 (`fill→fills[]`, `stroke→strokes[]`, `cornerRadius→cornerRadius`+`rectangleCornerRadii`, shadow/blur fields→`effects[]`, `layoutPosition→layoutPositioning`). The CSS emission is identical; only the model field spelling moves.

| `.pen` property | CSS | Notes / fallback |
|-----------------|-----|-------------------|
| `fill` (solid color) | `background` / `color` (text) | `$variable` → `var(--acv-<key>)` |
| `fill` (linear gradient) | `background: linear-gradient(<angle>, stops…)` | angle converted to CSS convention (`.pen` 0° = →; CSS 0° = ↑; offset by 90°) |
| `fill` (radial gradient) | `background: radial-gradient(…)` | normalized `center`/`size` → percentages |
| `fill` (image) | `background-image` + `background-size` per `mode` | or `<img>` element |
| `fill` (shader / mesh_gradient) | SVG island | no CSS equivalent |
| `stroke` + `strokeWidth` | `border: <w>px solid <color>` | per-side `{top,right,bottom,left}` → individual border widths |
| `strokeAlignment` | `box-sizing` + inset border trick | center/inside/outside |
| `cornerRadius` (number / 4-tuple) | `border-radius` (shorthand / 4 values) | |
| `opacity` | `opacity` | |
| `rotation` | `transform: rotate(θdeg); transform-origin: top left` | canonical on-screen after D4 |
| `effect.shadow` | `box-shadow: <x> <y> <blur> <spread> <color>` (+ `inset` for inset) | text nodes: `filter: drop-shadow(...)` to follow glyph shape |
| `effect.blur` | `filter: blur(<radius>px)` | `background_blur` → `backdrop-filter: blur(...)` |
| `effect.blendMode` | `mix-blend-mode` | standard modes map 1:1 |
| `layout`/`gap`/`padding`/`justifyContent`/`alignItems` | flexbox per §3.4 | parity mode: ignored (absolute geometry from resolver) |
| `flipX`/`flipY` | `transform: … scaleX(-1)` composed with rotation | |
| typography (`fontSize`, `fontWeight`, `letterSpacing`, `lineHeight`, `textAlign`, `underline`, `strikethrough`, `fontStyle`) | direct CSS (`text-decoration` composes underline/strikethrough) | |
| `clip` | `overflow: hidden` | |
| `theme` (node) | inline `--acv-*` overrides for subtree | §3.6 |
| `enabled: false` | `display: none` (children too) | matches resolver semantics |

## Appendix C — DOM data-attribute contract

Every world-tree node element carries:

```
data-node-id      — the .pen node id (instance clones carry their fresh ids)
data-node-type    — the .pen type ('frame' | 'rectangle' | …) — stable selector vocabulary for tests & tools
data-instance-of  — (refs only) the source componentId
data-source-path  — (expanded instance children only) slash-path of source ids, e.g. "button/label"
data-placeholder  — (L5 culled frames only) marks placeholder divs
```

The world root carries `data-ac-world` and `data-ac-theme="<axis>:<value>;…"` (v3: `data-ac-mode="<collectionId>:<modeId>;…"`). This contract is the query vocabulary for: renderer tests (replacing `querySelector('rect')` style assertions), `serializeDom`, `pen_get_computed`, and the chrome overlay. It is covered by a contract test that walks any rendered document and asserts attribute presence.

## Appendix D — New tool schemas (Figma-MCP-aligned)

```ts
// pen_get_metadata — sparse structure read (Figma MCP: get_metadata)
{
  name: 'pen_get_metadata',
  description: 'Read canvas structure. With nodeId: sparse tree of that subtree — ' +
    'one line per node: id, name, type, x, y, width, height. Without nodeId (or unknown id): ' +
    'the page list (id + name). Always call this before heavier reads.',
  input: { nodeId?: string },
  // pure model read — no client round-trip; output mirrors Figma's sparse-XML shape
}

// pen_get_design_context — 4-part handoff payload (Figma MCP: get_design_context)
{
  name: 'pen_get_design_context',
  description: 'Full design context for a selection: (1) reference code (React+Tailwind+TS, ' +
    'data-name/data-node-id attrs, var(--token, fallback) values), (2) screenshot, ' +
    '(3) conversion instructions, (4) asset URLs.',
  input: {
    nodeId: string,                 // scoped read — no whole-canvas dumps
    clientLanguages?: string[],     // telemetry only, e.g. ['typescript']
    clientFrameworks?: string[],    // telemetry only, e.g. ['react', 'tailwind']
    framework?: 'html' | 'react' | 'tailwind',  // code-part flavor (default react)
  },
  // built on serializeDom + pen_get_screenshot; falls back to resolver-based
  // emission + server PNG when no client is connected (D8 fallback path)
}

// pen_get_screenshot — real-canvas capture (Figma MCP: get_screenshot)
{
  name: 'pen_get_screenshot',
  input: { nodeId?: string, scale?: number },  // default: full canvas @2x
  // emits agent:screenshot_request; client html-to-image → data URL response;
  // 2s timeout → server render-to-png fallback with 'measured: false' flag
}

// pen_get_variable_defs — token definitions for a selection (Figma MCP: get_variable_defs)
{
  name: 'pen_get_variable_defs',
  input: { nodeId?: string },      // default: all variables + text styles
  // returns { variables: [{name, resolvedType, value, modes, codeSyntax}],
  //            styles: [{name, type, value}] } — feeds var() emission everywhere
}

// pen_get_computed — DOM ground-truth readback (ours; no Figma analog)
{
  name: 'pen_get_computed',
  input: { nodeIds: string[], properties?: string[] },  // default: curated ~20-prop subset
  // emits agent:computed_request; resolves from client getComputedStyle + rects;
  // 2s timeout → falls back to resolver data with a 'measured: false' flag
}

// pen_insert_html — author a .pen subtree from sanitized HTML (Figma analog: generate_figma_design)
{
  name: 'pen_insert_html',
  description: 'Insert an HTML fragment (inline styles only) as design nodes under a parent. ' +
    'Block containers become frames (auto-layout when the style is flex); text becomes text nodes; ' +
    'img becomes image fills. Prefer this over repeated pen_create_node for composite UI.',
  input: {
    html: string,            // sanitized server-side; inline styles only
    parentId?: string,       // default: canvas root
    x?: number, y?: number,  // placement of the fragment root
    namePrefix?: string,     // node naming, default 'html'
  },
  // emits ONE bulk_add patch; returns the created node ids + type counts
}

// pen_bake_layout — write measured sizes into the model (ours)
{
  name: 'pen_bake_layout',
  input: { nodeIds?: string[], all?: boolean },  // emits update_many with measured w/h
}
```

Skill registry wiring: `pen_insert_html` → `wireframe` + `layout` categories; `pen_get_metadata`/`pen_get_design_context`/`pen_get_computed`/`pen_get_screenshot` → `inspect`; `pen_get_variable_defs` → `design-system`; `pen_bake_layout` → `export` (`src/lib/agent/skills/registry.ts:49-682`).

## Appendix E — File change manifest

**New files**
```
src/components/canvas/dom/DomCanvas.tsx        (P1)
src/components/canvas/dom/DomNode.tsx          (P1)
src/components/canvas/dom/DomChrome.tsx        (P1)
src/components/canvas/dom/styleFor.ts          (P1)
src/components/canvas/dom/islands.tsx          (P1)
src/components/canvas/dom/measure.ts           (P2)
src/components/canvas/dom/serialize.ts         (P3)
src/components/canvas/dom/AGENTS.md            (P1, DOX)
src/components/canvas/svg/                     (P1 — ShapeRenderer + SvgCanvas moved verbatim)
src/lib/canvas/html-import.ts                  (P3)
src/lib/pen/figma-ontology.ts                  (P6 — canonical enum tables)
src/lib/pen/migrate.ts                         (P6 — 2.17 → 3.0 migration)
src/lib/pen/normalize.ts                       (P6 — legacy-spelling normalizer)
src/lib/agent/tool-aliases.ts                  (P6 — deprecation alias registry)
src/lib/canvas/shortcuts.ts                    (P7 — shortcut registry)
src/lib/canvas/version-history.ts              (P7 — checkpoints)
src/components/canvas/Rulers.tsx               (P7)
tests/unit/dom-node.test.tsx                   (P1)
tests/unit/figma-ontology-contract.test.ts     (P6)
tests/unit/pen-migration.test.ts               (P6)
tests/unit/tool-registry.test.ts               (P6)
tests/unit/shortcut-registry.test.ts           (P7)
tests/integration/renderer-dom.test.tsx        (P1)
tests/integration/renderer-dom-native.test.tsx (P2, browser-gated)
tests/integration/renderer-parity.test.tsx     (P0, browser-gated)
tests/integration/canvas-interactions.test.tsx (P7)
tests/integration/version-history.test.tsx     (P7)
scripts/dom-renderer-bench/                    (P0/P4)
scripts/agent-eval/figma-term-scenarios.ts     (P6 eval corpus)
```

**Modified files**
```
src/components/canvas/Canvas.tsx               (P1 — becomes shell; P7 interactions)
src/lib/canvas/patch.ts                        (P1 — D1 write-back; D3; P6 normalizer hook)
src/lib/canvas/store.ts                        (P1 D5; P2 measuredBounds; P4 coalescing; P7 checkpoints)
src/lib/pen/resolve.ts                         (P1 typed tree export; P2 measured hints; P6 v3 fields)
src/lib/pen/document.ts                        (P2 D2 componentProperties)
src/lib/pen/types.ts                           (P6 — v3 field shapes)
src/lib/pen/converters.ts                      (P6 — migrate-on-read, v3 export)
src/lib/canvas/types.ts                        (P3 new SyncEvents; P6 v3 Layer mirrors + alignKind enums)
src/lib/canvas/server.ts                       (P3 round-trip bridging)
src/lib/canvas/render-to-png.ts                (P2 measured geometry)
src/lib/canvas/export.ts                       (P3 exportCode delegates to serializeDom)
src/lib/agent/tools.ts                         (P3 new MCP-aligned tools; P6 renames via aliases)
src/lib/agent/pen-tools.ts                     (P6 — variables/modes vocabulary)
src/lib/agent/figma-tools.ts                   (P6 — folded into pen_* with figma_ aliases)
src/lib/agent/runner-legacy.ts                 (P3 snapshot enrichment; P6 v3 snapshot vocabulary)
src/lib/agent/subagents/design-critic-vlm.ts   (P3 real screenshots)
src/lib/agent/skills/registry.ts               (P3 category wiring)
src/lib/settings/types.ts                      (P1 flag; P5 default flip; P6 penV3 flag)
src/components/settings/SettingsDialog.tsx     (P1 Appearance: renderer select)
src/components/canvas/TopMenuBar.tsx           (P7 — View/Object/Edit items per Appendix H)
src/components/canvas/Toolbar.tsx              (P7 — Figma grouping + view-options menu)
src/components/canvas/PropertiesPanel.tsx      (P6 relabels; P7 section order + Hug/Fill/Fixed)
src/components/canvas/LayersPanel.tsx          (P7 — Pages column + Assets tab)
src/components/canvas/KeyboardShortcutsDialog.tsx (P7 — generated from shortcut registry)
package.json                                   (P3 + html-to-image; P0/P2 + playwright-core dev-dep)
README.md / AGENTS.md / docs/AGENTS.md         (P5 DOX pass; P6–P7 entries)
```

**Untouched during the renderer track (Phases 0–5)** — `src/lib/agent/runner-native.ts`, `agent-session-translator.ts`, `src/app/api/**`, `mini-services/canvas-sync/**`, `src/lib/sessions/**`, and all 42 patch-op semantics; the panel components keep their behavior (labels only move later). Phases 6–7 then touch vocabulary, panels, and shortcuts per the matrices above — never the sync/transport layer.

## Appendix F — Benchmark definitions and perf gates

**Documents** (synthetic, seeded, committed as generators — not blobs): `small` 50 nodes / 1 screen; `medium` 1k / 4 screens; `large` 5k / 20 screens; `xl` 20k / 80 screens (culling stress). Node mix mirrors real agent output: 40% text, 30% rect/frame, 15% instances, 10% images/icons, 5% paths.

**Metrics** (collected via `requestAnimationFrame` frame-time sampling over scripted gesture replay, `performance.now()` patch timestamps, `performance.memory` + CDP heap snapshots):
1. **Pan/zoom frame rate** — scripted 10 s continuous pan + pinch at each doc size; report p10/p50/p95 frame time.
2. **Patch-to-paint latency** — dispatch `update` patch; timestamp to next `requestAnimationFrame` after commit; 200-sample distribution.
3. **Bulk-build commits** — replay a recorded agent `bulk_add` sequence (500 nodes); count React commits (React Profiler API) and total time to interactive.
4. **Mount time** — fresh page load to first paint of full document.
5. **Heap** — steady-state after 5 min scripted interaction; growth trend over 20 min (leak detection).

**Gates (Phase 4 exit criteria)** — on the reference machine class (mid-range laptop, Chrome stable, default zoom):
- `large` (5k nodes): pan/zoom p95 frame ≤ 16.7 ms (60 fps); mounted nodes ≤ 1.8k (culling effective).
- `medium` (1k): p95 single-update patch-to-paint ≤ 16 ms; pan p95 ≤ 10 ms.
- Bulk 500-node build: ≤ 3 React commits, ≤ 1.5 s to interactive.
- Heap: < 1.5 GB at `xl`; zero upward trend over 20 min.
- **No regression vs SVG baseline at `small`** (the R4 guard).

**Baseline protocol**: Phase 0 records the same metrics on the current SVG renderer; every later phase's bench run includes the baseline columns for comparison. CI runs `medium` on every PR touching `src/components/canvas/**` or `src/lib/canvas/**`; `large`/`xl` nightly.

## Appendix G — Figma ontology alignment matrix

Research basis: `scripts/research/r1-figma-ontology.md` (REST + Plugin + Help Center, cross-checked against `github.com/figma/rest-api-spec` and `figma/plugin-typings`) and the codebase terminology inventory (Task R4). Canonical surface = REST API (§9.1). Every row is an alias-normalizer test case (§10.2 #3).

### G.1 Data-model field renames (.pen 2.17 → 3.0)

| # | Current (2.17) | Canonical (3.0) | Enum / shape mapping | Lives at |
|---|----------------|------------------|----------------------|----------|
| 1 | `layout: none\|vertical\|horizontal` | `layoutMode: NONE\|VERTICAL\|HORIZONTAL` | `none→NONE`, `vertical→VERTICAL`, `horizontal→HORIZONTAL` | `pen/types.ts:60` |
| 2 | `gap` | `itemSpacing` | number (may be negative, Figma allows) | `pen/types.ts:62` |
| 3 | `padding: number\|[v,h]\|[t,r,b,l]` | `paddingLeft`, `paddingRight`, `paddingTop`, `paddingBottom` | tuples expand positionally | `pen/types.ts:64` |
| 4 | `justifyContent: start\|center\|end\|space_between\|space_around` | `primaryAxisAlignItems: MIN\|CENTER\|MAX\|SPACE_BETWEEN\|SPACE_AROUND` | direct value map | `pen/types.ts:65` |
| 5 | `alignItems: start\|center\|end` | `counterAxisAlignItems: MIN\|CENTER\|MAX` | direct value map | `pen/types.ts:66` |
| 6 | `fit_content` / `fill_container` sizing strings | `layoutSizingHorizontal` / `layoutSizingVertical: FIXED\|HUG\|FILL` | `fit_content→HUG`, `fill_container→FILL`, explicit number→`FIXED` | `pen/types.ts:77-95` |
| 7 | `layoutPosition: auto\|absolute` | `layoutPositioning: AUTO\|ABSOLUTE` | UI label "Ignore auto layout" | `pen/types.ts:223` |
| 8 | `fill: string` (hex) | `fills: Paint[]` | `[{type:'SOLID', color}]` | `pen/types.ts:105-165` |
| 9 | gradient fill `{type:'gradient', gradientType: linear\|radial\|angular}` | paint `{type:'GRADIENT_LINEAR'\|'GRADIENT_RADIAL'\|'GRADIENT_ANGULAR', gradientStops, gradientHandlePositions}` | per-type paint entries | `pen/types.ts:120-140` |
| 10 | image fill `{type:'image', mode: stretch\|fill\|fit}` | `{type:'IMAGE', scaleMode: STRETCH\|FILL\|FIT\|TILE}` | `mode→scaleMode` | `pen/types.ts:142-150` |
| 11 | `stroke`, `strokeWidth` | `strokes: Paint[]`, `strokeWeight: number\|{top,right,bottom,left}` | stroke paint array + weights | `pen/types.ts:169-178` |
| 12 | `effect.shadow {x,y,blur,color,spread,inset}` | `effects[]` entries `{type:'DROP_SHADOW'\|'INNER_SHADOW', offset, radius, spread, color}` | `inset:true→INNER_SHADOW` | `pen/types.ts:180-192` |
| 13 | `effect.blur` / `background_blur` | `effects[]` `{type:'LAYER_BLUR', radius}` / `{type:'BACKGROUND_BLUR', radius}` | type-dispatched | `pen/types.ts:181` |
| 14 | `cornerRadius: number\|[t,r,b,l]` | `cornerRadius: number` + `rectangleCornerRadii: [TL,TR,BR,BL]` | 4-tuple migrates to named array (Figma order: TL,TR,BR,BL) | `pen/types.ts:225-229` |
| 15 | text `content` | `characters` | Figma TextNode field name | `pen/types.ts:330` |
| 16 | `textGrowth: auto\|fixed-width\|fixed-width-height` | `textAutoResize: WIDTH_AND_HEIGHT\|NONE\|HEIGHT` | `auto→WIDTH_AND_HEIGHT`, `fixed-width→NONE`, `fixed-width-height→HEIGHT` | `pen/types.ts:330` |
| 17 | `enabled` | `visible` | same boolean semantics (UI "Hide") | `pen/types.ts:216` |
| 18 | `themes: {axis: string[]}` | `variableCollections: [{id, name, modes:[{modeId,name}], defaultModeId}]` | axis→collection, values→modes | `pen/types.ts:550` |
| 19 | `variables: {$name: {type, value\|themedValues}}` | `variables: [{id, name, variableCollectionId, resolvedType: COLOR\|FLOAT\|STRING\|BOOLEAN, valuesByMode, scopes, codeSyntax?}]` | `$name` string-keys → id'd records; `themedValues→valuesByMode`; aliases as `{type:'VARIABLE_ALIAS', id}` | `pen/types.ts:52-56` |
| 20 | node `theme: {axis: value}` | `explicitVariableModes: {collectionId: modeId}` | per-subtree mode resolution | `pen/types.ts:28` |
| 21 | `tokenBinding {fillToken, strokeToken, textToken}` | `boundVariables: {fills?:[alias], strokes?:[alias], characters?:[alias], cornerRadius?:[alias], itemSpacing?:[alias]}` | per-field alias arrays | `canvas/types.ts:141` |
| 22 | constraints `left\|right\|center\|scale\|left_right` (h) / `top\|bottom\|center\|scale\|top_bottom` (v) | `LEFT\|RIGHT\|CENTER\|SCALE\|LEFT_RIGHT` / `TOP\|BOTTOM\|CENTER\|SCALE\|TOP_BOTTOM` | upper-case only | `canvas/types.ts:94-97` |
| 23 | `PenRef.ref` | `componentId` | Figma InstanceNode field name; `descendants` stays (§9.6 #3) | `pen/types.ts:483-501` |
| 24 | `gradient.angle` | `gradientHandlePositions` | normalized object-space handles (TL=(0,0), BR=(1,1)) | `pen/types.ts:126` |
| 25 | `blendMode` (lowercase values) | `PASS_THROUGH\|NORMAL\|DARKEN\|MULTIPLY\|LINEAR_BURN\|COLOR_BURN\|LIGHTEN\|SCREEN\|LINEAR_DODGE\|COLOR_DODGE\|OVERLAY\|SOFT_LIGHT\|HARD_LIGHT\|DIFFERENCE\|EXCLUSION\|HUE\|SATURATION\|COLOR\|LUMINOSITY` | value-case map; groups default `PASS_THROUGH` | `pen/types.ts:99-103` |

### G.2 Enum-value alias table (normalizer input → canonical output)

| Legacy value | Canonical |
|--------------|-----------|
| `none` / `vertical` / `horizontal` (layout) | `NONE` / `VERTICAL` / `HORIZONTAL` |
| `start` / `center` / `end` / `space_between` / `space_around` | `MIN` / `CENTER` / `MAX` / `SPACE_BETWEEN` / `SPACE_AROUND` |
| `fit_content` / `fill_container` | `HUG` / `FILL` |
| `auto` / `absolute` (layoutPosition) | `AUTO` / `ABSOLUTE` |
| `linear` / `radial` / `angular` (gradients) | `GRADIENT_LINEAR` / `GRADIENT_RADIAL` / `GRADIENT_ANGULAR` |
| `stretch` / `fill` / `fit` (image mode) | `STRETCH` / `FILL` / `FIT` |
| `left` / `right` / `center` / `scale` / `left_right` | `LEFT` / `RIGHT` / `CENTER` / `SCALE` / `LEFT_RIGHT` |
| `top` / `bottom` / `center` / `scale` / `top_bottom` | `TOP` / `BOTTOM` / `CENTER` / `SCALE` / `TOP_BOTTOM` |
| `auto` / `fixed-width` / `fixed-width-height` (textGrowth) | `WIDTH_AND_HEIGHT` / `NONE` / `HEIGHT` |
| `center_h` / `center_v` / `distribute_h` / `distribute_v` (alignKind) | `HCENTER` / `VCENTER` / `DISTRIBUTE_H` / `DISTRIBUTE_V` (+ new `TIDY`) |
| `color` / `number` / `string` / `boolean` (variable type) | `COLOR` / `FLOAT` / `STRING` / `BOOLEAN` |
| `inner` / `outer` (shadowType) | `INNER_SHADOW` / `DROP_SHADOW` |
| `enabled: false` | `visible: false` |

### G.3 Agent tool rename matrix (alias registry input)

| Legacy name | Canonical name | Param changes | Note |
|-------------|----------------|---------------|------|
| `pen_create_shape` | `pen_create_node` | `shapeId→nodeId` (n/a); `type` values unchanged (already Figma node names); `autoLayout{direction,gap,padding,alignX,alignY}→autoLayout{layoutMode,itemSpacing,padding*,primaryAxisAlignItems,counterAxisAlignItems}` | the workhorse |
| `pen_update_shape` | `pen_update_node` | `shapeId?/id?→nodeId?`; `changes` keys per G.1 | |
| `pen_delete_shape` | `pen_delete_nodes` | `shapeIds→nodeIds` | plural already |
| `pen_list_shapes` | *(superseded)* → `pen_get_metadata` | — | legacy name aliases to metadata with full-tree default |
| `pen_find_shapes` | `pen_find_nodes` | `shapeIds→nodeIds` in filters | |
| `pen_duplicate_shape` | `pen_duplicate_nodes` | `shapeIds→nodeIds` | |
| `pen_reparent_shape` | `pen_reparent_nodes` | `shapeId(s)→nodeId(s)`, `newParentId→parentId` | |
| `pen_select_shape` | `pen_select_nodes` | `shapeIds→nodeIds` | |
| `pen_update_tokens` | `pen_set_variables` | `colors/textStyles` → unified `variables[]` (Figma POST /variables action semantics: create/update/delete) | text styles remain a `styles[]` param |
| `pen_list_tokens` | `pen_list_variables` | — | |
| `pen_bind_shape_to_token` | `pen_bind_variable` | `shapeId→nodeId`, `tokenKey→variableId`, `property: fill\|stroke\|textColor→Figma scope: fills\|strokes\|characters` | |
| `pen_unbind_shape` | `pen_unbind_variable` | as above | |
| `pen_apply_token` | `pen_apply_variable` | as above | |
| `pen_set_variable` | *(unchanged name)* | `type: color\|number…→COLOR\|FLOAT…`, `themedValues→valuesByMode` | already Figma-ish |
| `pen_set_theme_axis` | `pen_set_variable_modes` | `axis→collectionId`, `values→modes[{modeId,name}]` | |
| `pen_apply_theme` | `pen_set_explicit_modes` | `theme: Record<axis,value>→explicitVariableModes: Record<collectionId,modeId>` | |
| `pen_list_themes` | `pen_list_collections` | — | |
| `pen_generate_wireframe` | `pen_generate_wireframe` *(label fix only)* | UI label "Generate Screen" → "Generate wireframe" | label drift fix |
| `figma_create_page` … `figma_set_instance_property` (10 tools) | fold into `pen_*` equivalents (`pen_create_page`, `pen_set_active_page`, `pen_rename_page`, `pen_delete_page`, `pen_create_section`, `pen_create_component`, `pen_create_component_set`, `pen_add_variant`, `pen_set_component_property`, `pen_set_instance_property`) | none (payloads already Figma-shaped) | `figma_*` names become permanent aliases — D10 closed |
| `pen_copy_as_code` | *(unchanged)* | `framework` param unchanged; output now from `serializeDom` | v2 |
| `web_search` / `web_fetch` | *(unchanged)* | — | not canvas vocabulary |

Z-order ops (`pen_bring_to_front`, `pen_send_to_back`, `pen_move_forward`, `pen_move_backward`, `pen_reorder_shape`) keep names and UI labels (Figma UI verbs match); `pen_reorder_shape`'s `zIndex` param becomes derived-from-child-order.

### G.4 Patch payload aliases (normalizer, not renames)

Patch op names stay frozen (42 ops, §5.1). Payload fields normalize: `shapeId→nodeId`, `shapeIds→nodeIds`, `alignKind` values per G.2, `themeAxis→collectionId`, `themeValues→modes`, `variableType` values per G.2, `constraints` enum casing per G.2. The `align` op additionally accepts `TIDY` (new capability, Figma "Tidy up").

## Appendix H — Figma UI workflow & shortcut alignment

Research basis: `scripts/research/r3-figma-ui-workflows.md` (26 help.figma.com pages + shortcut references; reflects Figma UI3). Items marked ⚠ are unverified in Figma's current docs (flagged by the research agent) — adopt only after verification.

### H.1 Panel structure mapping

| Region | AgentCanvas today | Figma target (Phase 7) |
|--------|-------------------|------------------------|
| Left sidebar | LayersPanel only (header + search + tree + footer stats) | Pages column (list, add/rename/duplicate/delete) + Layers/Assets tabs; Assets = component grid, drag-to-canvas places instance |
| Right sidebar | PropertiesPanel: Quick Actions, Name, Parent, X/Y/W/H, Constraints, Style, Auto Layout, Theme, Slot, Text Content, Font Size, Text Color | Figma order: alignment row (+distribute, tidy) → position (X/Y/rotation) → dimensions (W/H + Fixed/Hug/Fill per axis) → Auto layout (direction, itemSpacing, per-side padding, align box, wrap) → Constraints → appearance (opacity, blend, corner radius) → Fill/Stroke/Effects → Component/Instance (variant, swap, detach, reset) → Export |
| Toolbar | floating bottom-center pill (Select, Pan, Rectangle, Ellipse, Text, Line, Frame, Undo, Redo, Clear) | Figma grouping: Move (V) / Hand (H) / Scale (K) · Frame (F) / Section (⇧S) / Slice (S) · Shape menu (R, O, L) · Text (T) · Comment (C) + zoom/view-options menu (pixel grid, snap, pixel preview, outlines) |
| Menubar | File/Edit/View/Insert/Object/Help (classic bar) | Keep the classic bar (power-user surface, no conflict with Figma's ⌘K Actions model); add View items (Zoom ⇧1/⇧2/⇧0, Rulers, Pixel grid, Snap, Outline mode) and Object items (Frame selection ⌥⌘G, Wrap in section ⇧S, Flatten ⌥⇧F, Mask ⌃⌘M, Boolean ⌥⇧U/S/I/E) |
| Canvas | click, shift-click, drag, 8-handle resize, alt-drag duplicate, arrows nudge, context menus | + marquee, ⌘-drag nested marquee, ⌘+click deep select, Enter/⇧Enter/Tab/⇧Tab navigation, K scale, ⌥-hover measure, rulers + drag-out guides, snap-to-pixel, paste-over-selection ⌘⇧V |

### H.2 Shortcut table (adopt unless listed in H.3)

| Action | Mac | Windows | Status in AgentCanvas |
|--------|-----|---------|----------------------|
| Move tool | V | V | have (implicit) — make explicit |
| Hand tool / hold-pan | H / Space | same | have |
| Scale tool | K | K | **add** (Phase 7) |
| Frame tool | F | F | have |
| Section tool | ⇧S | ⇧S | **add** |
| Slice tool | S | S | **add** (with slice node type — exists in LayerType) |
| Rectangle / Ellipse / Line / Arrow | R / O / L / ⇧L | same | R/O/L/T have; arrow **add** |
| Text tool | T | T | have |
| Pen / Pencil | P / ⇧P | same | P (path) have; pencil out of scope |
| Comment | C | C | stub → implement |
| Group / Ungroup | ⌘G / ⌘⇧G | Ctrl+G / Ctrl+Shift+G | have ✓ |
| Frame selection | ⌥⌘G | Ctrl+Alt+G | **add** |
| Duplicate | ⌘D / ⌥drag | Ctrl+D / Alt+drag | have ✓ |
| Copy as PNG | ⌘⇧C | Ctrl+Shift+C | **add** |
| Paste over selection | ⌘⇧V | Ctrl+Shift+V | have (paste in place) — retarget label |
| Rename | ⌘R | Ctrl+R | **add** (layers panel) |
| Lock / Hide | ⌘⇧L / ⌘⇧H | Ctrl+Shift+L / Ctrl+Shift+H | have as ⌘L / ⌘; → **rebind** to Figma chords |
| Bring forward / front | ⌘] / ⌘⌥] | Ctrl+] / Ctrl+Shift+] | have ✓ (also plain ]/[ alt forms) |
| Send backward / back | ⌘[ / ⌘⌥[ | Ctrl+[ / Ctrl+Shift+[ | have ✓ |
| Align left/top/bottom/right | ⌥A / ⌥W / ⌥S / ⌥D | Alt+A/W/S/D | **add** |
| Align centers H/V | ⌥H / ⌥V | Alt+H / Alt+V | **add** |
| Flip H/V | ⇧H / ⇧V | same | **add** |
| Create component | ⌥⌘K | Ctrl+Alt+K | have as ⌘⇧C → **rebind** |
| Detach instance | ⌥⌘B | Ctrl+Alt+B | **add** |
| Boolean ops | ⌥⇧U/S/I/E | Alt+Shift+U/S/I/E | **add** |
| Mask | ⌃⌘M | Ctrl+Alt+M | **add** |
| Flatten | ⌥⇧F | Alt+Shift+F | **add** (wires the dead `flatten_boolean` op) |
| Outline mode | ⌘⇧O | Ctrl+Shift+O | **add** |
| Pixel grid | ⌘' | Ctrl+' | **add** |
| Snap to pixel grid | ⌘⇧' | Ctrl+Shift+' | **add** |
| Zoom in/out/fit/selection/100% | ⇧+ / ⇧− / ⇧1 / ⇧2 / ⇧0 | same | buttons only today → **add chords** |
| Show/hide UI | ⌘\ | Ctrl+\ | have ✓ (zen mode) |
| Left sidebar toggle | ⇧⌘\ | Shift+Ctrl+\ | have as ⌘⇧1 → keep ours (H.3) |
| Actions / command palette | ⌘K | Ctrl+K | have ✓ |
| Shortcuts panel | ⌃⇧? | Ctrl+Shift+? | have as ⌘/ → **rebind** |
| Save version | ⌘⌥S | Ctrl+Alt+S | **add** (Phase 7 checkpoints) |
| Deep select | ⌘+click | Ctrl+click | **add** |
| Enter child / ⇧Enter parent / Tab siblings | Enter / ⇧Enter / Tab, ⇧Tab | same | **add** |
| Measure distances | ⌥+hover | Alt+hover | **add** |

### H.3 Documented deviations (deliberate)

1. **Panel toggles stay ⌘⇧1/⌘⇧2** (Layers/Chat) — pre-existing muscle memory in the product; Figma's ⌥1/⌥2/⌥3 are tab selectors, which we adopt *inside* the left sidebar (Layers ⌥1 / Assets ⌥2) without stealing the top-level chords.
2. **Classic menubar kept** (File/Edit/View/Object/Help) instead of Figma UI3's Actions-menu-only model — AgentCanvas is a desktop-app-shaped web app; the bar costs nothing and hosts the new View/Object items.
3. **⌘L/⌘; legacy chords retained as aliases** for one release after rebinding Lock/Hide, then removed (shortcut registry handles the transition).
4. **No prototype mode / ⇧E** — out of product scope.
5. **Dev Mode ⇧D** — deferred: the AgentPanel already occupies that role; revisit if a dev-handoff view ships (would pair naturally with `pen_get_design_context`).
6. ⚠-flagged Figma chords (e.g. ⇧0 zoom-100%, Move=V) are verified against a live Figma session before Phase 7 merge (research flag, not spec doubt).

## Appendix I — Figma Dev Mode MCP tool mapping

Research basis: `scripts/research/r2-figma-agent-tooling.md` (developers.figma.com Tools-and-prompts, Figma blog 2025–2026, forum-confirmed renames). Our policy: adopt the *read* tools and the design principles; keep granular writes (§9.6 #2).

| Figma MCP tool | What it does in Figma | AgentCanvas counterpart | Status |
|----------------|----------------------|-------------------------|--------|
| `get_metadata` | Sparse XML: layer ids/names/types/positions/sizes; page list when no nodeId | `pen_get_metadata` | **new, Phase 3** |
| `get_design_context` (ex `get_code`, renamed Oct 2025) | 4-part payload: reference code (React+Tailwind, `data-name`, `var(--token,fallback)`), screenshot, system prompt, asset URLs | `pen_get_design_context` (+ `pen_copy_as_code` v2 engine) | **new, Phase 3** |
| `get_screenshot` (ex `get_image`) | PNG of selection, base64 or URL | `pen_get_screenshot` | **new, Phase 3** |
| `get_variable_defs` | Variables + styles in selection with code syntax | `pen_get_variable_defs` | **new, Phase 3** |
| `get_code_connect_map` | instance nodeId → code component mapping | — | **not adopted** (§9.6 #7); `data-component-of` serialization attribute keeps the door open |
| `use_figma` | General write tool (create/edit/delete pages, frames, components, variables, text…) | the 72 granular `pen_*` write tools | **deviation** (§9.6 #2): principle adopted, mega-tool not |
| `generate_figma_design` | Live web UI → editable design layers | `pen_insert_html` (+ v2 mounted-iframe import) | **new, Phase 3** (string input instead of live capture) |
| `create_new_file` | blank Design/FigJam/Slides file in drafts | session creation (`SessionSidebar` "New chat") | exists, different granularity — no change |
| `download_assets` / `upload_assets` | export renders / upload images as fills | `pen_export_png` / `pen_upload_image`, `pen_generate_image` | exists ✓ |
| `get_libraries` / `search_design_system` | reuse design-system elements before creating | `pen_find_nodes` over the component index; Phase 6 adds component-aware search | **partial**; enrich in Phase 6 |
| `get_motion_context` | keyframes, easing, CSS @keyframes | — | **not adopted** (no motion model; future spec if animations ship) |
| `get_figjam` | FigJam diagram metadata as XML | — | **not adopted** (no FigJam domain) |
| `list_shader_*` / `get_shader_*` | account shaders | `.pen` shader fills exist (`pen/types.ts:150-165`); no account-level registry | **not adopted** (out of scope) |
| `weave_*` (run_tool, cost gates) | paid community tool runs | background-tasks plugin (`background_enqueue`/`_status`/`_result`) | analogous surface exists; no change |
| `whoami` | authenticated identity / seats | single-user local app | **not needed** |
| MCP prompt `create_design_system_rules` | generate agent rules file | system-prompt TURN FLOW section (`runner-legacy.ts:105-567`) | analogous; updated in Phases 3/6 |
