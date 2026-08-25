# HTML/DOM Renderer — Design Doc & Implementation Spec

> Status: **Proposed — not started.** Phases 0–5 below are ordered, independently shippable, and each ends in a verifiable state.
> Spec source: full codebase audit conducted 2026-08-25 (rendering core, .pen model, agent pipeline, export paths, tests). All `file:line` references verified against `main` @ `c388147`.
> Code touchpoints: `src/components/canvas/Canvas.tsx`, `src/lib/canvas/{types,patch,store,export,render-to-png,server}.ts`, `src/lib/pen/{types,resolve,document,converters}.ts`, `src/lib/agent/{tools,pen-tools,runner-native,runner-legacy}.ts`, `src/lib/agent/subagents/*`, `tests/unit/ShapeRenderer.test.tsx`, `tests/integration/renderer.test.tsx`.
> Test coverage planned: `tests/unit/dom-node.test.tsx` (new), `tests/integration/renderer-dom.test.tsx` (new), `tests/integration/renderer-parity.test.tsx` (new), perf benchmark harness `scripts/dom-renderer-bench/` (new), plus migration of `renderer.test.tsx` assertions.

---

## Table of contents

- [0. Executive summary and verdicts](#0-executive-summary-and-verdicts)
- [1. Current-state audit (evidence)](#1-current-state-audit-evidence)
- [2. Evaluation — the four questions, answered](#2-evaluation--the-four-questions-answered)
- [3. Architecture](#3-architecture)
- [4. Scalability plan for large designs](#4-scalability-plan-for-large-designs)
- [5. Agent (pi-agent) integration](#5-agent-pi-agent-integration)
- [6. Migration plan — Phases 0–5](#6-migration-plan--phases-05)
- [7. Risk register](#7-risk-register)
- [8. Open questions](#8-open-questions)
- [Appendix A — Node → DOM element mapping](#appendix-a--node--dom-element-mapping)
- [Appendix B — .pen property → CSS mapping](#appendix-b--pen-property--css-mapping)
- [Appendix C — DOM data-attribute contract](#appendix-c--dom-data-attribute-contract)
- [Appendix D — New tool schemas](#appendix-d--new-tool-schemas)
- [Appendix E — File change manifest](#appendix-e--file-change-manifest)
- [Appendix F — Benchmark definitions and perf gates](#appendix-f--benchmark-definitions-and-perf-gates)

---

## 0. Executive summary and verdicts

**The question set:** (1) Do we actually render components as HTML elements on the canvas today? (2) Is HTML/DOM rendering feasible? (3) Does it make life easier for the pi-agent? (4) Can it scale to large designs and many screens in one project?

**Verdict 1 — No.** The canvas is a single `<svg>` element. Every layer — including component instances — is flattened by `resolvePenTree()` into absolutely-positioned primitives and painted as `<rect>`/`<ellipse>`/`<text>`/`<line>`/`<polygon>`/`<image>` SVG elements (`src/components/canvas/Canvas.tsx:494-568`, switch at `:810-1262`). Component instances are expanded into cloned primitive subtrees *before* render (`src/lib/pen/document.ts:263-299`). The only HTML that exists anywhere is the "copy as code" export — a ~30-line absolute-positioning-only emitter that drops typography, shadows, gradients, auto-layout, nesting, and component semantics (`src/lib/agent/tools.ts:2642-2663`, `src/lib/canvas/export.ts:280-317`). Evidence in §1.

**Verdict 2 — Yes, feasible, with a clean seam.** The renderer consumes a derived, renderer-agnostic projection (`Layer[]` with absolute geometry, or the `.pen` tree directly). The Zustand store, the 46-op patch system, the Socket.IO sync fan-out, and all 90+ agent tools are completely renderer-independent — verified end-to-end (§1.1, §2.2). The `.pen` layout vocabulary (`layout`/`gap`/`padding`/`justifyContent`/`alignItems`/`fit_content`/`fill_container`) is already CSS-flexbox-shaped (`src/lib/pen/types.ts:60-75`). The existing copy-as-code path already proves a shape→absolutely-positioned-div mapping works. Recommended architecture: a **hybrid DOM-primary renderer** — real DOM/CSS for frames, components, text, rectangles, ellipses, images; inline `<svg>` islands for freeform paths, boolean ops, stars, polygons; CSS custom properties for variables/themes (§3).

**Verdict 3 — Yes, materially easier.** HTML/CSS is the highest-frequency design vocabulary in LLM training data; `.pen`/Figma-REST JSON is not. Concretely: a new `pen_insert_html` tool lets the agent author a whole card in one tool call instead of 15 `pen_create_shape` calls; copy-as-code v2 serializes the live DOM so the canvas *is* production-grade code; `pen_get_computed` + a measured-bounds readback close the text-measurement gap that the current resolver cannot solve (no text measurement exists — text without explicit size falls back to 100×100, `src/lib/pen/resolve.ts:315-322`); and the VLM design critic can finally screenshot the *real* canvas instead of a parallel server-side SVG re-render that drops images and judges a different picture than users see (`src/lib/canvas/render-to-png.ts:219-224`). Full analysis in §2.3 and §5.

**Verdict 4 — Yes, scalable — and the DOM plan is an upgrade from a renderer with zero performance infrastructure.** The current SVG renderer has no memoization, no culling, no virtualization: every pan/zoom frame re-renders the entire shape tree (the `zoom` prop is passed to every `ShapeRenderer` for handle compensation, `Canvas.tsx:554-561`), and shape dragging emits one full-store round-trip per mousemove (`Canvas.tsx:216-224`). The DOM design makes pan/zoom a single compositor-only CSS transform on a world container, moves selection chrome to a screen-space overlay (shapes become fully memoizable), and adds `content-visibility`/containment-based culling — targeting 60 fps pan/zoom with ~1.5k mounted nodes inside a 50k-node document (§4). The `.pen` Pages abstraction already exists for multi-screen projects (`src/lib/pen/types.ts:535-566`).

**Recommended path:** six phases, each independently shippable and behind a settings flag (`settings.appearance.renderer: 'svg' | 'dom'`), starting with a parity harness and absolute-positioning parity mode, then native CSS layout, then agent superpowers, then scale hardening, then the default flip (§6). Nothing in the patch contract, tool surface, or sync protocol changes — the migration risk is concentrated in exactly one component boundary.

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
2. **The patch contract is frozen.** All 46 ops (`canvas/types.ts:288-334`) and 90+ tools keep their semantics. The renderer is a pure consumer of `CanvasDocument`.
3. **One paint vocabulary.** The node→DOM/CSS mapping (Appendices A/B) becomes the shared vocabulary for on-screen rendering *and* code export, collapsing the four parallel emitters (§1.2).
4. **React owns the DOM.** Per the repo's "no direct DOM mutation" rule, imperative updates are confined to ref-backed transforms on the world container and overlay, mirroring the existing background-grid pattern (`Canvas.tsx:427-435`). No ad-hoc `innerHTML` writes.
5. **Chrome never lives in the world tree.** Selection outlines, resize handles, badges, agent-highlight pulses, snap guides — all render in a screen-space overlay computed from `getBoundingClientRect()`, so navigation and selection never re-render content.
6. **Two layout modes, one document.** *Parity mode*: resolver-computed absolute geometry (identical to today). *Native mode*: containers with `layout ≠ 'none'` render as CSS flexbox and the browser is the layout authority. Mode is a document-level runtime setting, not a fork of the code.

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

- **All 46 patch ops** (`canvas/types.ts:288-334`) — semantics, names, payloads.
- **All 90+ tools** (72 `tools.ts` + 8 `pen-tools.ts` + 10 `figma-tools.ts` + plugins) — they emit patches; the renderer change is invisible to them.
- **The NDJSON/Socket.IO event vocabulary** (`canvas/types.ts:405-462`) and the translator's patch extraction (`agent-session-translator.ts:62-71`).
- **The runner's local-canvas execution model** (`runner-native.ts:157-165`): the agent never reads the DOM — it reads `ctx.getShapes()/getDocument()`. Server-side code stays DOM-free; only the *browser* renders DOM. This keeps `/api/agent`, canvas-sync, and the fallback chain untouched.

### 5.2 New tools (additive; schemas in Appendix D)

| Tool | Direction | Purpose |
|------|-----------|---------|
| `pen_insert_html` | agent → canvas | Sanitized HTML+inline-CSS fragment → `.pen` subtree under a parent (M1). One call replaces N `pen_create_shape` calls. |
| `pen_get_computed` | canvas → agent | Per-node `getComputedStyle` subset + measured rect (+ effective variable values) via a new `agent:computed` round-trip (M3/M5). |
| `pen_bake_layout` | canvas → model | Write measured bounds back into `.pen` sizes (§3.8). |
| `pen_screenshot` | canvas → agent | Request a real-canvas screenshot (client `html-to-image`) for the VLM critic (M4). |
| `pen_copy_as_code` v2 | canvas → code | Reimplemented on the DOM serializer (§5.3); same tool name, upgraded output (M2). |

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

---

## 6. Migration plan — Phases 0–5

Every phase follows the repo's menu-spec format (Goal / Files to touch / Implementation steps / Tests / Acceptance criteria) and lands independently green: `bun run lint`, `bun run test`, and the phase's own acceptance gate. The feature flag lives in `src/lib/settings/types.ts` (`AppSettings.appearance.renderer: 'svg' | 'dom'`, default `'svg'` until Phase 5) and is exposed in the Settings → Appearance section (`src/components/settings/SettingsDialog.tsx`).

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

**Goal.** Ship M1–M6: `pen_insert_html`, `pen_get_computed`, `pen_screenshot`, copy-as-code v2, snapshot enrichment, HTML import v1.

**Files to touch.**
- `src/lib/agent/tools.ts` — new tools (`pen_insert_html`, `pen_get_computed`, `pen_screenshot`, `pen_bake_layout` if not landed in Phase 2); `pen_copy_as_code` reimplemented over the serializer.
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
3. Socket round-trip events + `pen_get_computed` (timeout 2 s → resolver-data fallback so headless runs never hang).
4. `serializeDom` + `pen_copy_as_code` v2 + `exportCode` delegation (delete the two stale emitters — D7 closed).
5. `pen_screenshot` + VLM critic integration (§5.4; D8 closed).
6. Snapshot enrichment (§5.5).
7. Update the system prompt's TURN FLOW + component-recipes section (`runner-legacy.ts:105-567`) to teach `pen_insert_html` as the preferred high-level construction primitive, with `pen_create_shape` demoted to surgical edits.

**Tests.** Sanitizer unit tests (security-critical — corpus-driven); `pen_insert_html` → `bulk_add` patch-shape tests in the existing `tools.test.ts` style; serializer golden-file tests (html/react/tailwind outputs for 3 fixture selections); round-trip integration test (insert HTML → serialize → semantic equivalence); VLM-critic fallback test (no client → old path).

**Acceptance criteria.**
- [ ] XSS corpus: 100% of malicious fixtures sanitized (no `on*` attributes, no `javascript:` URLs, no script/style nodes survive).
- [ ] Agent eval: `dom-renderer` scenario set shows ≥ 30% fewer tool calls for card/form/nav construction tasks vs baseline (measure via `scripts/agent-eval/run-eval.ts` — token + call-count report).
- [ ] Copy-as-code output for the dashboard fixture is nested flex HTML (not flat absolutes) and renders identically when opened standalone.
- [ ] VLM critic consumes a real screenshot when a client is attached (log line + event trace), falls back cleanly otherwise.
- [ ] `pen_get_computed` returns measured rect + ≥ 20 computed properties for a node in < 2.5 s end-to-end.

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

---

## 8. Open questions

1. **Does parity mode survive Phase 5, or is it scaffold-only?** Recommendation: keep it as the jsdom-test/export path; revisit at removal time. Cost is low (`styleFor` already parameterized by mode).
2. **Shadow DOM for inserted HTML fragments** (style isolation for v2 import): breaks CSS-var inheritance unless `::part`/props are forwarded — decide during Phase 3 v2 with a spike; default is class-prefix scoping.
3. **`contentEditable` on-canvas text editing** — natural follow-up capability unlocked by DOM mode; deliberately out of this spec's scope (PropertiesPanel remains the editor). Deserves its own small spec after Phase 2.
4. **Playwright as a devDependency** for browser-gated tests vs keeping them env-gated (`agent-browser` available in sandbox): decision at Phase 1 CI wiring; recommendation: dev-dep `playwright-core` + system Chromium in CI, env-gated locally.
5. **Should `renderCanvasToSvg` eventually be derived from the DOM serializer** (single emitter, §1.2 collapses to *one*) rather than kept as parallel SVG path? Deferred to post-Phase-3 once `serializeDom` proves fidelity — the SVG export path has real users via `pen_export_svg`.
6. **Zoom clamp unification** (D6): pick 0.1–8 everywhere (gesture range) — confirm with UX.

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

The world root carries `data-ac-world` and `data-ac-theme="<axis>:<value>;…"`. This contract is the query vocabulary for: renderer tests (replacing `querySelector('rect')` style assertions), `serializeDom`, `pen_get_computed`, and the chrome overlay. It is covered by a contract test that walks any rendered document and asserts attribute presence.

## Appendix D — New tool schemas

```ts
// pen_insert_html — author a .pen subtree from sanitized HTML
{
  name: 'pen_insert_html',
  description: 'Insert an HTML fragment (inline styles only) as design nodes under a parent. ' +
    'Block containers become frames (auto-layout when the style is flex); text becomes text nodes; ' +
    'img becomes image fills. Prefer this over repeated pen_create_shape for composite UI.',
  input: {
    html: string,            // sanitized server-side; inline styles only
    parentId?: string,       // default: canvas root
    x?: number, y?: number,  // placement of the fragment root
    namePrefix?: string,     // node naming, default 'html'
  },
  // emits ONE bulk_add patch; returns the created node ids + type counts
}

// pen_get_computed — ground-truth readback (requires connected client)
{
  name: 'pen_get_computed',
  input: { nodeIds: string[], properties?: string[] },  // default: curated ~20-prop subset
  // emits agent:computed_request; resolves from client getComputedStyle + rects;
  // 2s timeout → falls back to resolver data with a 'measured: false' flag
}

// pen_bake_layout — write measured sizes into the model
{
  name: 'pen_bake_layout',
  input: { nodeIds?: string[], all?: boolean },  // emits update_many with measured w/h
}

// pen_screenshot — real-canvas capture for critique/verification
{
  name: 'pen_screenshot',
  input: { scale?: number },  // default 2
  // emits agent:screenshot_request; client html-to-image → data URL response
}
```

Skill registry wiring: `pen_insert_html` → `wireframe` + `layout` categories; `pen_get_computed`/`pen_screenshot` → `inspect`; `pen_bake_layout` → `export` (`src/lib/agent/skills/registry.ts:49-682`).

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
tests/unit/dom-node.test.tsx                   (P1)
tests/integration/renderer-dom.test.tsx        (P1)
tests/integration/renderer-dom-native.test.tsx (P2, browser-gated)
tests/integration/renderer-parity.test.tsx     (P0, browser-gated)
scripts/dom-renderer-bench/                    (P0/P4)
```

**Modified files**
```
src/components/canvas/Canvas.tsx               (P1 — becomes shell; paint tree extracted)
src/lib/canvas/patch.ts                        (P1 — D1 write-back; D3)
src/lib/canvas/store.ts                        (P1 D5; P2 measuredBounds; P4 coalescing)
src/lib/pen/resolve.ts                         (P1 typed tree export; P2 measured hints)
src/lib/pen/document.ts                        (P2 D2 componentProperties)
src/lib/canvas/types.ts                        (P3 new SyncEvents/ClientEvents)
src/lib/canvas/server.ts                       (P3 round-trip bridging)
src/lib/canvas/render-to-png.ts                (P2 measured geometry)
src/lib/canvas/export.ts                       (P3 exportCode delegates to serializeDom)
src/lib/agent/tools.ts                         (P3 new tools + copy_as_code v2)
src/lib/agent/runner-legacy.ts                 (P3 snapshot enrichment)
src/lib/agent/subagents/design-critic-vlm.ts   (P3 real screenshots)
src/lib/agent/skills/registry.ts               (P3 category wiring)
src/lib/settings/types.ts                      (P1 flag; P5 default flip)
src/components/settings/SettingsDialog.tsx     (P1 Appearance: renderer select)
package.json                                   (P3 + html-to-image)
README.md / AGENTS.md / docs/AGENTS.md         (P5 DOX pass)
```

**Untouched (the frozen seam)** — `src/lib/agent/runner-native.ts`, `agent-session-translator.ts`, `src/app/api/**`, `mini-services/canvas-sync/**`, `src/lib/sessions/**`, `src/components/canvas/{PropertiesPanel,LayersPanel,Toolbar,AgentPanel}.tsx`, all 46 patch-op semantics.

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
