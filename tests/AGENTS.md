# AGENTS.md — `tests/`

## Purpose

Two kinds of tests live here:

1. **Shell-based smoke tests** for the project's runtime build pipeline (Python runtime bundling, database runtime bundling, container builds). These are NOT part of the Next.js app — they verify the deployment artifact shape.
2. **Vitest unit + component tests** for the Next.js app code. These live in `tests/unit/` and use Vitest + jsdom + @testing-library/react.

## Ownership

### Shell-based smoke tests (root-level `.sh` files)
- `python-runtime-build.sh` — tests that the Python runtime build script (`../.zscripts/python-runtime-build.sh`) correctly bundles Python scripts and excludes `.venv/` from the output.
- `python-runtime-container.sh` — tests the containerized Python runtime build.
- `database-runtime-build.sh` — tests that the database runtime build correctly bundles schema + seed data.

### Vitest unit tests (`tests/unit/`)

| File | What it covers |
|------|----------------|
| `patch.test.ts` | `applyPatchToCanvas` — all patch ops, with focus on the new Phase 1+2+5 ops: `zorder` (front / back / forward / backward), `reorder`, `undo`/`redo` (no-op at patch layer), `viewport`, and `normalizeShape` handling of new Shape fields (`points`, `closed`, `src`, `radii`, `gradient`, `shadow`, `blur`, `maskId`). Also regression-tests the tokens-patch binding re-application. |
| `tools.test.ts` | All agent tools via `executeTool`. Uses an in-memory `CanvasToolContext` that records patches and applies them through `applyPatchToCanvas`. Covers happy paths, error paths (missing shape / token / wrong type), and a registration sanity check (79 tools, unique names, non-empty descriptions). |
| `html-import.test.ts` | The HTML→.pen sanitizer + converter (`src/lib/canvas/html-import.ts`, spec Phase 3). SECURITY-CRITICAL XSS corpus: on* attrs stripped, javascript:/vbscript:/data:text/ URLs dropped (http/https, //, /, ./, ../, #, data:image/ kept), script/style/iframe/object/embed dropped WITH contents (incl. raw-text `1 < 2` inside script), unknown tags unwrapped keeping text, class/id/data-*/srcset dropped, comments/doctypes dropped, malformed nesting auto-closed, stray closes ignored, bare `<` as text, void tags, entity decoding (named + numeric). Converter: div→frame (fit_content), flex style→layout/gap/padding/justify/align, h1-h6 scale, strong/em, ul/li nesting, img→image fill, input→rectangle, hr→line, br→newline, svg skipped+counted, style mappings (fill/radius/50%→9999/border/box-shadow incl. inset + unitless offsets/4-value padding/fixed sizes/opacity), naming prefix + slug, per-type stats. |
| `serialize.test.ts` | The three-framework serializer (`src/lib/canvas/serialize.ts`, spec §5.3 copy-as-code v2). Fixture doc (auto-layout frame + texts + rect + image fill + loose absolute rect) → `resolvePenTreeDetailed` → `serializeNodes`: html nested-flex markup with gap/padding styles + data-name/data-node-id on every element + text escaping + `var(--acv-key, fallback)` for token-bound fills; react JSX shape (`export function`, `style={{…}}`, PascalCase, JS-string children for JSX-special text); tailwind class candidates (flex/flex-col/gap-3/p-4/rounded-xl, color table) + arbitrary values (w-[347px]/left-[400px]); flat `Shape[]` input path matches tree-path output byte-for-byte; subtree scoping. |
| `tools-mcp.test.ts` | The Phase 3 Figma-MCP-aligned tools (spec §5.2/Appendix D) via the same in-memory harness: `pen_get_metadata` (page-list default + multi-page lines, sparse `id \| name \| type \| x/y/w/h` tree, subtree scope, unknown-id page-list recovery), `pen_get_variable_defs` (values + themedValues + `var(--acv-…)` codeSyntax + sanitization), `pen_insert_html` (ONE `bulk_add` patch with nested .pen children + parentId, apply→tree structure, fit_content preserved, ids/typeCounts/skipped in details, unknown-parent error, malicious-fragment sanitization), `pen_get_design_context` (4 labeled parts, scoped code with data-name + assets, react default, unknown-nodeId error), `pen_bake_layout` (no-measured notice, zero patches). Round-trip: insert HTML → applyPatch → resolve → serializeNodes → text content + flex structure survive in all three frameworks. Plus a patch.ts regression: `bulk_add` preserves `fit_content`/`fill_container` sizing strings through `normalizeToNode`. |
| `client-roundtrip.test.ts` | The server-side round-trip registry (`src/lib/agent/client-roundtrip.ts`, M2-c): `awaitClientResponse` NEVER rejects (timeout → null — the agent loop cannot hang), resolvers resolve + clean up, emit runs AFTER registration (no instant-answer race), late resolvers are no-ops; typed resolvers (`resolveComputedResponse` array coercion, `resolveScreenshotResponse` valid/invalid/missing dataUrl); the measured-bounds store (per-document isolation, replace-not-merge semantics, 20-doc LRU cap + touch-refresh, garbage input ignored). |
| `tools-roundtrip.test.ts` | The M2-c round-trip tools: `pen_get_computed` (no-sink instant resolver fallback with measured:false + resolver-derived styles; sink-installed timeout → emit shape `agent:computed_request` + fallback; client answering DURING the wait → measured:true live data; mixed live/fallback; unknown ids; properties filter; empty nodeIds error), `pen_get_screenshot` (no-sink resvg fallback measured:false, timeout fallback, client error surfacing, real client dataUrl measured:true, empty canvas), `pen_bake_layout` (no-measured notice, ONE `update_many` with real sizes, all=true, fit_content/fill_container NEVER baked — skipped with a note, missing-measured notice). Uses `setEventSink` per-test + `ROUNDTRIP_DEFAULTS` shrunk to 10ms + a module-mock of `render-to-png`. |
| `snapshot-measured.test.ts` | `canvasSnapshot` measured= enrichment (spec §5.5): no suffix without entries (baseline line format unchanged), ` measured=<w>×<h>` appended after `size=` when present, fractional rounding, partial maps stay partial, per-document scoping (no cross-doc leak), NaN-guarded, nested child lines enriched with indentation preserved. |
| `agentic-workflows.test.ts` | Phase 3 agentic-workflow tools: `pen_recommend_components` (repeated-shape detection) and the pattern-memory RAG lifecycle (`pen_pattern_stats`, `pen_save_design_pattern`, `pen_search_design_patterns`, `pen_clear_pattern_memory` via `src/lib/agent/pattern-memory.ts`). |
| `component-system.test.ts` | Phase 2 component-system patch ops: `convert_to_component`, `place_instance`, `set_instance_override`, `reset_instance`, `detach_instance`, `combine_as_variants`, `swap_variant` (PenRef/PenComponent/PenComponentSet handling in `applyPatchToCanvas`). |
| `hierarchy-fixes.test.ts` | The 5 hierarchy gap fixes in `resolvePenTree` (`src/lib/pen/resolve.ts`): absolute `layoutPosition`, layout-constraints enforcement, frame clip surfacing, group auto-size fallback (0×0), nested fill_container/fit_content sizing cycle. |
| `gap-fixes.test.ts` | Spec-compliance regressions from `research/gap-analysis-2.md`: 7 new node types in the DOM renderer, pages/`activePageIndex` round-trip through converters, `background_blur` resolve effect. |
| `store.test.ts` | `useCanvasStore` undo/redo behavior — `undo()` / `redo()` actions, `_onSync` undo/redo interception, undo-stack push before mutating patches, redo-stack clearing on mutation, 50-entry cap, full undo/redo cycle, and select-patch non-mutation. Bypasses `init()` (which opens a WebSocket) by directly setting state. M2-c additions: the client round-trip handlers — `agent:computed_request` reads a jsdom-mounted `[data-node-id]` div (getComputedStyle + rect + ≥30-prop curated subset, properties filter, canvasRect with a registered world element, unmounted nodes omitted) and POSTs to `/api/agent/client-responses`; `agent:screenshot_request` without a world element POSTs `no-dom-renderer`; `pushMeasuredBounds` emits the socket ClientEvent + POSTs the digest (empty digest = no-op). Fetch is captured via a `globalThis.fetch` stub. |
| `shared-canvas.test.ts` | The shared-canvas acceptance suite (Figma/Cursor model): `switchSession` preserves the document (transcript-only — the canvas is never swapped), `newSession` continues on the current shared canvas, `captureSnapshot` is document-scoped with session provenance (newest-first listing), `restoreSnapshot` appends an append-only `'restore'` snapshot + reverts the document via the canvas-store action (incl. the `document:restore` broadcast — mocked socket), `forkSession` copies the message prefix (runs/toolCalls NOT copied; canvas + parent untouched), `deleteSession` KEEPS document snapshots, and the persist v1→v2 migration re-keys session-owned snapshots to document scope. |
| `dom-node.test.tsx` | The DOM renderer's `DomNode` (`src/components/canvas/dom/DomNode.tsx`) — per-type inline-style assertions (fill/radius/border, 4-corner radii, linear+radial gradients with angle+90 conversion, boxShadow/textShadow, blur filter, opacity, rotation transform, clip overflow, ellipse 50%, text typography + content, line pill geometry, SVG islands for path/star/polygon, section chip, slice overlay, boolean symbol, component/instance accent borders), the data-attribute contract (`data-node-id`/`data-node-type`/`data-instance-of`), and the `visible:false → visibility:hidden with subtree still mounted` divergence. |
| `bench-generator.test.ts` | Smoke tests for the benchmark corpus generator (`scripts/dom-renderer-bench/generate.ts`): node counts + per-screen frames, Appendix F type mix coverage, structural invariants (parenting, instance links, payloads), mulberry32 determinism. |
| `registry.test.ts` | Skill registry registration — verifies Figma-hierarchy tools (`pen_reparent_shape`, `pen_set_constraints`) are in the correct skill `allowedTools` lists and in `ALL_TOOL_NAMES`. Guards against tools being defined but not exposed to the LLM. Also tests layout skill keywords include hierarchy triggers. |
| `clipboard.test.ts` | Pure clipboard helpers — `serializeShapes`, `deserializeShapes`, `offsetShapes`, `detectPayloadKind`. Tests round-trip serialization, field preservation, ID rewriting for parent references, and payload kind detection (shape/color/value/constraints). |
| `figma-ontology.test.ts` | Figma ontology alignment — tests for Pages, Sections, Components, Component Sets, Variants, Component Properties. Verifies `add_page`, `set_active_page`, `rename_page`, `delete_page`, `add_section`, `create_component`, `create_component_set`, `add_variant`, `set_component_property`, `set_instance_property` patch ops + resolver mapping. |
| `figma-ontology-contract.test.ts` | **The vocabulary freeze guard** (spec Phase 6 part 1, §10.2 #1): every canonical table in `src/lib/pen/figma-ontology.ts` is unique + order-snapshot-frozen; REST spellings (SCREAMING_SNAKE) enforced; alias targets are canonical members; alias maps injective per domain EXCEPT the documented merges (`light`/`lighten`→LIGHTEN, `pass_through`/`pass-through`→PASS_THROUGH); `normalizeEnum` canonical-passthrough / alias-mapping / null-on-unknown; full ontology JSON snapshot (any vocabulary drift fails with a diff). |
| `pen-normalize.test.ts` | The alias normalizer matrix (spec §10.2 #3, Appendix G §G.2 + §G.4): EVERY G.2 row parametrized (legacy in → canonical out) across layoutMode/axisAlign/layoutSizing/layoutPositioning/paintType/scaleMode/constraints H+V/textAutoResize/alignKind/variableType/effectType/blendMode/textAlign; canonical inputs idempotent; unknown passthrough (total) vs strict-mode throws; `gradientAngleToHandles` math; `normalizePenNode` dual-carry (full legacy fixture → every v3 field populated + legacy byte-identical + recursive children + ref componentId + idempotence + v3-wins precedence + malformed-input safety); `normalizePatchPayload` (alignKind canonicalized, constraints/variableType both-casings-accepted-legacy-stored, frozen field names, purity). |
| `pen-migration.test.ts` | The 2.17→3.0 migration suite (spec §10.2 #2, G.1 rows 1–25): rich fixture (nested auto-layout frame, gradient + image fills, shadow + blur, per-corner radii, textGrowth, disabled node, 2 theme axes × 2 values, themed + unthemed + aliased variables, bound tokens, component + ref instance with descendant override, constraints) → assert EVERY G.1 row's canonical field + legacy dual-carry; name-derived ids (`col:`/`var:`/`mode:`); idempotence (migrate² ≡ migrate); purity; serialize→deserialize→migrate semantic equality; **resolver equivalence** (identical geometry/fill/text/shadow before vs after migration — the runtime-identical proof) incl. SCREAMING-vs-lowercase constraints; converter wiring (canvasToPen writes '3.0' with legacy kept, penToCanvas migrates-on-read, pages mirror stays reference-identical). |
| `resolve-v3.test.ts` | Resolver dual-field output (spec Phase 6 part 1, §9.3 #3): auto-layout + text + shadow + gradient + per-corner-radii doc → Layer carries BOTH legacy fields EXACTLY as before (autoLayout incl. the tuple→0 padding collapse regression) AND v3 mirrors (`layoutMode`, `itemSpacing`, per-side paddings, axis alignments, `layoutSizing*` HUG/FILL/FIXED, `characters`, `textAutoResize`, `rectangleCornerRadii`, `fills` SOLID/GRADIENT_LINEAR with angle-derived handles, `effects` DROP_SHADOW); mirrors stay absent on plain nodes; v3-source nodes resolve to the same mirrors; patch-inserted (`add`) nodes dual-carry from creation; canonical alignKind (HCENTER) ≡ legacy (center_h), TIDY ≡ DISTRIBUTE_H (v1), set_constraints accepts SCREAMING input; export→import round-trip preserves geometry + mirrors. |
| `llm-providers.test.ts` | LLM provider registry — tests `getProvider()`, `listProviders()`, `createLLMClient()` for the provider registry. Verifies factory creation, capability flags, metadata completeness, and OpenAI-compatible factory behavior. |
| `zoom-clamp.test.ts` | Zoom clamp unification (spec defect D6): the shared `clampZoom` helper + `MIN_ZOOM`/`MAX_ZOOM` constants exported from `src/lib/canvas/use-canvas-gestures.ts` — canonical range 0.1–8 for every zoom control (gestures, Canvas zoom buttons, context-menu items), plus a source-level guard that `Canvas.tsx` consumes the shared clamp instead of inline caps. |

### Vitest integration tests (`tests/integration/`)

| File | What it covers |
|------|----------------|
| `pipeline.test.ts` | Full pipeline: tool → `ctx.applyPatch` → `useCanvasStore._onSync` → undo/redo. Each new tool category gets a full-chain test (create+undo+redo, z-order+undo, token binding+re-theme, bulk_update+undo, reorder+undo, export_json round-trip). Also a simulated agent turn driven through `_onSync` verifying the store + session store end up consistent. |
| `scenarios.test.ts` | Realistic multi-tool design workflows: "Design a card" (create→text→group→shadow→per-corner radii→undo all→redo all), "Design system with tokens + binding" (update_tokens→create buttons→apply_token bind→re-theme→unbind→re-theme), "Find & replace text", "Lock + hide + find" with undo, "Z-order across multiple operations", "Export SVG reflects latest fills", "Generate wireframe emits one atomic bulk_add". |
| `session-bridge.test.ts` | Session store mirroring: message stream → assistant message + live turn, tool call start/end recorded on the run, document-scoped snapshot captured at turn_end (with createdBy='agent' + sessionId provenance), duplicate turn_end guard, stopAgent finalizes as cancelled + user-created snapshot, error path finalizes run as failed, session switching PRESERVES the shared document (transcript-only rebuild), newSession continues on the current canvas, forkActiveSession creates a conversation-fork child session. |
| `renderer.test.tsx` | Canvas component subscription to store mutations (DOM mode): empty canvas, add/update/remove/clear, all shape types (rectangle, ellipse, text, path, image), shadow/gradient/per-corner radii rendering, undo/redo reflected in DOM, hidden shapes, bulk_add, background op. (heatmap op test REMOVED — feature dropped for .pen purity.) |
| `renderer-dom.test.tsx` | Mirror of `renderer.test.tsx` with the settings store forced to `renderer: 'dom'`: DOM-node data-attribute assertions for add/update/remove/undo/redo/bulk_add, text content, group nesting (child div inside parent div), multi-select chrome outlines (2 selections + 16 handles inside `[data-ac-chrome]`), hidden nodes staying mounted. |
| `renderer-parity.test.tsx` | *(removed)* — the SVG/DOM parity harness was deleted with the SVG renderer in the post-Phase-5 cleanup. The DOM renderer's per-type coverage lives in `dom-node.test.tsx` + `renderer-dom.test.tsx` + `renderer-dom-native.test.tsx`. |
| `runner.test.ts` | **End-to-end runner tests** — drives `runAgent` with a scriptable `MockLLM` that returns deterministic completions per iteration. Covers: text-only response, single-tool turn, multi-tool single-iteration turn, combined content+tool_calls, multi-iteration tool-result feedback (LLM sees prior tool results), system snapshot refresh between iterations, 5-iteration design flow, LLM throw → agent:error, tool error recovery (LLM sees error in tool result), malformed tool arguments (JSON.parse fallback to {}), MAX_ITERATIONS cap (graceful exit), empty message (no content + no tool_calls), input isolation (runner deep-clones canvas, doesn't mutate caller's object), skill-filtered tool-spec passthrough. |
| `conversation.test.ts` | **Multi-run conversation flows** — sequences of `runAgent` calls wired through `useCanvasStore._onSync`, verifying the full chain: runner → store → session mirroring + undo/redo. Covers: run 2 sees run 1's output in system snapshot, undo/redo via tools (op=undo intercepted by store), token binding across runs (bind in run 1, re-theme in run 2), error recovery across runs (run 1 fails, run 2 succeeds, both recorded correctly), snapshot accumulation via `listSnapshots(documentId)` (3 runs → 3 document-scoped snapshots, newest-first ordering), full chat history across 3 runs (6 messages, alternating user/assistant, tool calls recorded). |

### Setup file (`tests/setup.ts`)
- Registers `@testing-library/jest-dom` matchers.
- Polyfills `crypto.randomUUID` (for older jsdom), `matchMedia`, `ResizeObserver`, and `SVGElement.prototype.getBBox` — all of which jsdom lacks but our code relies on.

### Vitest config (`vitest.config.ts` at repo root)
- Environment: `jsdom`.
- Globals: `true` (so `describe` / `it` / `expect` don't need imports — though our tests import them explicitly for clarity).
- Setup file: `tests/setup.ts`.
- Include pattern: `tests/unit/**/*.test.{ts,tsx}` and `tests/integration/**/*.test.{ts,tsx}`.
- Path alias: `@` → `./src` (mirrors `tsconfig.json`).
- Coverage: includes `src/lib/canvas/patch.ts`, `src/lib/canvas/store.ts`, `src/lib/agent/tools.ts`, `src/components/canvas/Canvas.tsx`.
- Snapshots: `tests/unit/__snapshots__/figma-ontology-contract.test.ts.snap` freezes the Figma-ontology enum tables (spec Phase 6 part 1). It MUST be committed — deleting it re-freezes the vocabulary silently. Update it ONLY via a deliberate `bunx vitest run -u tests/unit/figma-ontology-contract.test.ts` after an intentional vocabulary change.

## Local Contracts

### Shell-based smoke tests
- Each `.sh` file is a self-contained Bash test that:
  1. Creates a temp directory (`mktemp -d`).
  2. Sets up a minimal fixture project structure.
  3. Invokes the corresponding build script from `../.zscripts/`.
  4. Asserts the output shape with `test -f` / `test ! -e`.
  5. Cleans up the temp directory on exit (`trap 'rm -rf "$TEST_ROOT"' EXIT`).
- They use `set -euo pipefail` — fail fast on any error.

### Vitest unit tests
- Each test file is self-contained — no shared state between files.
- The store test resets both `useCanvasStore` and `useSessionStore` state in `beforeEach` to prevent leakage.
- The tools test uses a tiny in-memory harness (`makeHarness()`) that wraps `applyPatch` to apply mutations locally so subsequent `getShapes()` calls see them.
- The `dom-node.test.tsx` suite imports `DomNode` directly from `src/components/canvas/dom/DomNode.tsx` so it can be tested in isolation without mounting the full `<Canvas>` shell (which depends on websockets + the canvas store). The integration suites (`renderer*.test.tsx`) mount the full `<Canvas>` and drive it through `useCanvasStore._onSync` + `useSettings.setState`.

### What these tests are NOT
- The shell tests are NOT run by `bun run lint` or `bun run build`. They must be invoked manually.
- The Vitest tests ARE run by `bun run test` (or `bun run test:watch` / `bun run test:coverage`).
- The shell tests depend on `../.zscripts/` (git-tracked in this repo) — they run in any fresh clone of this repo.

## Running

### Vitest (app-level unit tests)
```bash
bun run test              # one-shot run
bun run test:watch        # watch mode
bun run test:ui           # Vitest UI (browser-based)
bun run test:coverage     # generate coverage report
```

### Shell-based smoke tests (deployment pipeline)
```bash
bash tests/python-runtime-build.sh
bash tests/python-runtime-container.sh
bash tests/database-runtime-build.sh
```
Each prints a "passed" message on success and exits non-zero on failure.

## Work Guidance

- The shell tests are low-priority — they exist to verify a deployment pipeline that is not the primary deliverable of this repo.
- The Vitest tests are the canonical app-level test suite. When adding new agent tools, new patch ops, or new Shape fields, ADD CORRESPONDING TESTS to the matching file in `tests/unit/`. The pattern is established — copy a similar test and adapt.
- For new tools: add a `describe('tools: pen_<name>', ...)` block to `tests/unit/tools.test.ts`. Cover the happy path + at least one error path (missing shape, wrong type, etc.).
- For new patch ops: add a `describe('patch: <op>', ...)` block to `tests/unit/patch.test.ts`. Cover the mutation + the purity (new shape objects, not mutated originals).
- For new Shape fields: add normalization tests to `tests/unit/patch.test.ts` (under `patch: normalizeShape`) and rendering tests to `tests/unit/dom-node.test.tsx`.
- For new store actions: add tests to `tests/unit/store.test.ts`. Reset state in `beforeEach`.

## Verification

- `bun run test` — should print "Test Files 18 passed (18)" and "Tests 417 passed (417)" (or higher as tests are added).
- `bash tests/python-runtime-build.sh` — should print "python runtime build tests passed".
- `bash tests/database-runtime-build.sh` — should print the corresponding pass message.
- `bunx tsc --noEmit` — typecheck (currently clean; `skills/` is excluded in tsconfig because the z.ai sandbox extracts sandbox-owned skill sources there).
- CI (`.github/workflows/ci.yml`) is INTENDED to run `bun run lint` + `bun run test` on pushes/PRs to `main` (typecheck is currently disabled — the workflow comment cites ~30 legacy tsc errors that have since been fixed, so it can be re-enabled). **Known bug**: both triggers contain a typo (`branches: ain]` instead of `branches: [main]`), so CI never actually fires. The fix must be made directly on GitHub (the sandbox blocks workflow-trigger edits).

## Child DOX Index

No child `AGENTS.md` files. This folder is flat.
