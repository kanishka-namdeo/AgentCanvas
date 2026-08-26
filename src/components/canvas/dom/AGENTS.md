# AGENTS.md — `src/components/canvas/dom/`

## Purpose

The DOM renderer — spec `docs/html-dom-renderer.md` Phases 1–5. Real DOM/CSS per node instead of one flat `<svg>`: every resolved `Layer` becomes a nested `<div>` (per `parentId`), freeform vector types become inline SVG islands, and all selection chrome renders in a screen-space overlay. Always mounted by the Canvas shell (the legacy SVG renderer was removed in the post-Phase-5 cleanup sweep — SVG-as-export-format is unaffected and continues to flow through `src/lib/canvas/export.ts` + `src/lib/canvas/render-to-png.ts`). Phase 4 adds L4 CSS containment (`content-visibility: auto` + `contain` on container subtrees) + L5 mount culling (CullingCoordinator: viewport intersection + hysteresis + budget-aware ≥2k nodes + placeholder swap).

## Ownership

- `DomCanvas.tsx` — world container + chrome coordinator. Builds the layer tree from `document.shapes` (`useMemo`): dedupe by id (last-writer-wins), children index sorted by zIndex, roots = parentId null / missing parent (orphans render as roots so nothing disappears vs SVG mode) / cycle-broken chains (defensive promote-to-root, one `console.warn` in dev). Owns hover state (`hoveredId`). Pan/zoom is a single CSS `transform` on the world div (`data-ac-world`, `willChange: transform`) — the only thing that changes during navigation. M2-c: the world div is REGISTERED on the store (`setWorldElement`, both layout modes — cleared on unmount) for the client round-trips (screen→canvas-space conversion + html-to-image capture), and a throttled (800ms trailing, native mode only) effect pushes the measured-bounds digest to the server (`pushMeasuredBounds` → socket `canvas:measured_bounds` + POST) so `canvasSnapshot` / `pen_bake_layout` see fresh sizes.
- `DomNode.tsx` — `React.memo`'d recursive renderer for ONE layer. Emits the data-attribute contract, wires `onMouseDown`/`onMouseEnter`/`onMouseLeave`, renders type-specific children content (islands, `<img>`, text string, section label chip, slice tag) and recurses into zIndex-sorted children with parent-relative offsets. Parent position arrives as `parentX`/`parentY` numbers (not an object) so the memo shallow-compare stays effective.
- `styleFor.ts` — pure `Layer` → `React.CSSProperties` mapping (the shared paint vocabulary, spec Appendix B): base absolute geometry + zIndex, fill → `background` (solid / `linear-gradient` with angle+90 / `radial-gradient`), stroke → `border`, radii → `borderRadius` (4-corner string), shadow → `boxShadow` (`textShadow` on text), blur → `filter`, opacity, rotation (`transform: rotate()`, origin `0 0` — spec defect D4), clip → `overflow: hidden`, full text typography, line-as-rotated-pill, and type specials (group transparent, section dashed + chip colors, component/instance accent borders, slice overlay, boolean dashed placeholder). No React state, no DOM reads.
- `DomChrome.tsx` — screen-space overlay (`data-ac-chrome`, `zIndex` above the world, `pointerEvents: none` except handles). Canvas→screen: `sx = x * zoom + panX`. Renders: selection outlines, 8 resize handles (via `handleMath.ts`'s `handlePosition`/`cursorForHandle` at constant screen size — DOM chrome uses 8px, no zoom-compensation unlike the legacy SVG renderer), agent-highlight pulse (`ac-agent-pulse` keyframes in `src/app/globals.css`), component M/I + type badges, auto-layout indicator, group dashed outline on select/hover. Selection/hover changes re-render ONLY this overlay — never the world tree.
- `islands.tsx` — `renderIsland(layer)`: inline `<svg>` islands for `path` (absolute points + offset viewBox), `star`, `polygon` (relative-center point math mirroring the legacy SVG renderer), plus the non-vector content emitters: `<img>` for `image`, dashed op-symbol placeholder for `boolean_operation`. Islands never intercept pointer events.

## Local Contracts

### DOM data-attribute contract (spec Appendix C)

Every world-tree node div carries:
- `data-node-id` — the layer id (instance clones carry their fresh ids).
- `data-node-type` — the `LayerType`; the stable selector vocabulary for tests and future tools (`pen_get_computed`, `serializeDom`).
- `data-instance-of` — instances only: the source `componentId`.

The world root carries `data-ac-world`; the chrome root carries `data-ac-chrome`; handles carry `data-chrome-handle` (`nw|n|ne|e|se|s|sw|w`); selection outlines carry `data-chrome-selection`. This contract is covered by `tests/unit/dom-node.test.tsx` + `tests/integration/renderer-dom.test.tsx`.

### Parity-mode invariants

- Geometry comes ONLY from `document.shapes` (resolver-computed absolute x/y/w/h) — the DOM is a projection; no layout is computed here (native CSS layout is Phase 2).
- `visible === false` → `visibility: hidden`, subtree STAYS MOUNTED (SVG mode unmounts; DOM mode is Figma-correct — hidden parents hide children — and keeps measurement/nesting stable). Documented divergence.
- Chrome never lives in the world tree (spec §3.1 principle 5) — badges, outlines, handles, highlight pulses are overlay-only.
- `styleFor` is the single CSS vocabulary — type-specific CSS belongs there, structure/content belongs to `DomNode`/`islands`.
- Design tokens: use the `--ac-canvas-*` variables (selection/handle-fill/component/instance/highlight/autolayout/default-stroke/default-text/bg) — no hardcoded hex.
- Known parity divergences (documented in code comments): text first-baseline placement (~10% fontSize), gradient-island fallback to solid fill on vector types, SVG-mode leaking visible children through hidden parents (pre-existing flat-renderer limitation that DOM mode fixes).

## Work Guidance

- New LayerType support: add the CSS mapping in `styleFor.ts`, the content/island emitter in `islands.tsx` or `DomNode.tsx`, a chrome badge if structural, and a per-type block in `tests/unit/dom-node.test.tsx`.
- Keep `DomNode` memo-friendly: only pass stable props (layers, numbers, stable callbacks). Selection/hover/highlight/zoom must NEVER become `DomNode` props — they belong to `DomChrome`.
- When the spec's Phase 2 (native CSS layout / measure.ts) lands here, extend `DomCanvasProps` with the layout mode and keep parity mode the default path.

## Verification

- `bunx vitest run tests/unit/dom-node.test.tsx` — per-type style + contract assertions.
- `bunx vitest run tests/integration/renderer-dom.test.tsx` — store-driven behavior in DOM mode (add/update/remove/undo/redo/bulk/nesting/chrome).
- `bunx vitest run tests/integration/renderer-dom-native.test.tsx` — native layout mode (Phase 2) DOM tree + measured-bounds flow.
- `bun run lint` + `bunx tsc --noEmit`.
- Manual: open the app; shapes, selection, drag, resize, context menu, zoom, undo/redo all work. The DOM renderer is always mounted — there's no renderer toggle in Settings.

## Child DOX Index

No child AGENTS.md files in this folder.

*Parent: `../AGENTS.md`. The legacy `../svg/` directory was removed in the post-Phase-5 cleanup sweep; handle-math now lives in `../handleMath.ts`.*
