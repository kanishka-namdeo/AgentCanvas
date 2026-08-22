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
| `tools.test.ts` | All agent tools via `executeTool`. Uses an in-memory `CanvasToolContext` that records patches and applies them through `applyPatchToCanvas`. Covers happy paths, error paths (missing shape / token / wrong type), and a registration sanity check (70 tools, unique names, non-empty descriptions). |
| `agentic-workflows.test.ts` | Phase 3 agentic-workflow tools: `pen_recommend_components` (repeated-shape detection) and the pattern-memory RAG lifecycle (`pen_pattern_stats`, `pen_save_design_pattern`, `pen_search_design_patterns`, `pen_clear_pattern_memory` via `src/lib/agent/pattern-memory.ts`). |
| `component-system.test.ts` | Phase 2 component-system patch ops: `convert_to_component`, `place_instance`, `set_instance_override`, `reset_instance`, `detach_instance`, `combine_as_variants`, `swap_variant` (PenRef/PenComponent/PenComponentSet handling in `applyPatchToCanvas`). |
| `hierarchy-fixes.test.ts` | The 5 hierarchy gap fixes in `resolvePenTree` (`src/lib/pen/resolve.ts`): absolute `layoutPosition`, layout-constraints enforcement, frame clip surfacing, group auto-size fallback (0×0), nested fill_container/fit_content sizing cycle. |
| `gap-fixes.test.ts` | Spec-compliance regressions from `research/gap-analysis-2.md`: 7 new node types in the Canvas SVG switch, pages/`activePageIndex` round-trip through converters, `background_blur` resolve effect. |
| `store.test.ts` | `useCanvasStore` undo/redo behavior — `undo()` / `redo()` actions, `_onSync` undo/redo interception, undo-stack push before mutating patches, redo-stack clearing on mutation, 50-entry cap, full undo/redo cycle, and select-patch non-mutation. Bypasses `init()` (which opens a WebSocket) by directly setting state. |
| `ShapeRenderer.test.tsx` | The `ShapeRenderer` component — new shape types (`path` → polygon/polyline, `image`), new effects (gradient fill, drop shadow, blur, per-corner radii), visibility, selected/highlighted states, and regression coverage for existing shape types. Calls `ShapeRenderer` directly inside an `<svg>` wrapper. |
| `registry.test.ts` | Skill registry registration — verifies Figma-hierarchy tools (`pen_reparent_shape`, `pen_set_constraints`) are in the correct skill `allowedTools` lists and in `ALL_TOOL_NAMES`. Guards against tools being defined but not exposed to the LLM. Also tests layout skill keywords include hierarchy triggers. |
| `clipboard.test.ts` | Pure clipboard helpers — `serializeShapes`, `deserializeShapes`, `offsetShapes`, `detectPayloadKind`. Tests round-trip serialization, field preservation, ID rewriting for parent references, and payload kind detection (shape/color/value/constraints). |
| `figma-ontology.test.ts` | Figma ontology alignment — tests for Pages, Sections, Components, Component Sets, Variants, Component Properties. Verifies `add_page`, `set_active_page`, `rename_page`, `delete_page`, `add_section`, `create_component`, `create_component_set`, `add_variant`, `set_component_property`, `set_instance_property` patch ops + resolver mapping. |
| `llm-providers.test.ts` | LLM provider registry — tests `getProvider()`, `listProviders()`, `createLLMClient()` for the provider registry. Verifies factory creation, capability flags, metadata completeness, and OpenAI-compatible factory behavior. |

### Vitest integration tests (`tests/integration/`)

| File | What it covers |
|------|----------------|
| `pipeline.test.ts` | Full pipeline: tool → `ctx.applyPatch` → `useCanvasStore._onSync` → undo/redo. Each new tool category gets a full-chain test (create+undo+redo, z-order+undo, token binding+re-theme, bulk_update+undo, reorder+undo, export_json round-trip). Also a simulated agent turn driven through `_onSync` verifying the store + session store end up consistent. |
| `scenarios.test.ts` | Realistic multi-tool design workflows: "Design a card" (create→text→group→shadow→per-corner radii→undo all→redo all), "Design system with tokens + binding" (update_tokens→create buttons→apply_token bind→re-theme→unbind→re-theme), "Find & replace text", "Lock + hide + find" with undo, "Z-order across multiple operations", "Export SVG reflects latest fills", "Generate wireframe emits one atomic bulk_add". |
| `session-bridge.test.ts` | Session store mirroring: message stream → assistant message + live turn, tool call start/end recorded on the run, snapshot captured at turn_end (with createdBy='agent'), duplicate turn_end guard, stopAgent finalizes as cancelled + user-created snapshot, error path finalizes run as failed, session switching restores canvas + rebuilds turns, newSession clears canvas, forkActiveSession creates child session. |
| `renderer.test.tsx` | Canvas component subscription to store mutations: empty canvas, add/update/remove/clear, all shape types (rectangle, ellipse, text, path, image), shadow/gradient/per-corner radii rendering, undo/redo reflected in DOM, hidden shapes, bulk_add, background op. (heatmap op test REMOVED — feature dropped for .pen purity.) |
| `runner.test.ts` | **End-to-end runner tests** — drives `runAgent` with a scriptable `MockLLM` that returns deterministic completions per iteration. Covers: text-only response, single-tool turn, multi-tool single-iteration turn, combined content+tool_calls, multi-iteration tool-result feedback (LLM sees prior tool results), system snapshot refresh between iterations, 5-iteration design flow, LLM throw → agent:error, tool error recovery (LLM sees error in tool result), malformed tool arguments (JSON.parse fallback to {}), MAX_ITERATIONS cap (graceful exit), empty message (no content + no tool_calls), input isolation (runner deep-clones canvas, doesn't mutate caller's object), skill-filtered tool-spec passthrough. |
| `conversation.test.ts` | **Multi-run conversation flows** — sequences of `runAgent` calls wired through `useCanvasStore._onSync`, verifying the full chain: runner → store → session mirroring + undo/redo. Covers: run 2 sees run 1's output in system snapshot, undo/redo via tools (op=undo intercepted by store), token binding across runs (bind in run 1, re-theme in run 2), error recovery across runs (run 1 fails, run 2 succeeds, both recorded correctly), snapshot accumulation (3 runs → 3 snapshots, newest-first ordering), full chat history across 3 runs (6 messages, alternating user/assistant, tool calls recorded). |

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
- The ShapeRenderer test exports `ShapeRenderer` directly from `Canvas.tsx` (a non-breaking export added in this pass) so it can be tested in isolation without mounting the full `<Canvas>` component (which depends on websockets + the canvas store).

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
- For new Shape fields: add normalization tests to `tests/unit/patch.test.ts` (under `patch: normalizeShape`) and rendering tests to `tests/unit/ShapeRenderer.test.tsx`.
- For new store actions: add tests to `tests/unit/store.test.ts`. Reset state in `beforeEach`.

## Verification

- `bun run test` — should print "Test Files 18 passed (18)" and "Tests 417 passed (417)" (or higher as tests are added).
- `bash tests/python-runtime-build.sh` — should print "python runtime build tests passed".
- `bash tests/database-runtime-build.sh` — should print the corresponding pass message.
- `bunx tsc --noEmit` — typecheck (currently clean; `skills/` is excluded in tsconfig because the z.ai sandbox extracts sandbox-owned skill sources there).
- CI (`.github/workflows/ci.yml`) is INTENDED to run `bun run lint` + `bun run test` on pushes/PRs to `main` (typecheck is currently disabled — the workflow comment cites ~30 legacy tsc errors that have since been fixed, so it can be re-enabled). **Known bug**: both triggers contain a typo (`branches: ain]` instead of `branches: [main]`), so CI never actually fires. The fix must be made directly on GitHub (the sandbox blocks workflow-trigger edits).

## Child DOX Index

No child `AGENTS.md` files. This folder is flat.
