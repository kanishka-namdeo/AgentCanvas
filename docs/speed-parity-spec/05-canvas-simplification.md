# 05 — Canvas Simplification

> **Scope:** Changes to the canvas state, snapshot generation, patch application, and rendering pipeline that reduce per-turn token cost and per-patch latency. This doc covers the data layer; agent-facing tool changes are in `06-agent-tools-simplification.md`.

---

## What the canvas is today

The AgentCanvas document model is in `src/lib/canvas/types.ts`. Per the `src/lib/canvas/AGENTS.md`:

- **`CanvasDocument`** — top-level container with `id`, `name`, `shapes` (array of `Layer`), `variables` (collections + modes), `textStyles`, `pages` abstraction.
- **`Layer`** — the canonical node type. Has `id`, `type` (Frame / Rect / Text / Image / Path / Instance / Component / ComponentSet / Group / BooleanOp / Mask / Section / Page), `name`, geometry (`x`, `y`, `width`, `height`, `rotation`), style (`fill`, `stroke`, `shadow`, `blur`, `cornerRadius`, `opacity`), text properties (`content`, `fontSize`, `fontWeight`, `fontFamily`, `lineHeight`, `letterSpacing`, `textAlign`), and `children` (recursive).
- **Variables** — design tokens (`color`, `number`, `string` modes, with collection + mode semantics for theme switching).
- **`CanvasPatch`** — the mutation unit: `{ id, ops: PatchOp[], toolCallId? }` where `PatchOp` is a JSON-patch-style operation (`add`, `remove`, `replace`, `move`, `copy`, `test`) on the document tree.

The agent emits patches; the server sanitizes + journals + applies them; the client renders via the DOM renderer (`src/components/canvas/CanvasStage.tsx`).

---

## What's slow about the canvas today

### 1. Snapshot rebuild per turn — full tree on small canvases

**File:** `src/lib/agent/runner-legacy.ts:1221-1310` (`canvasSnapshot`), `src/lib/agent/runner-native.ts:1540-1544` (delta threshold check).

**Problem:** `canvasSnapshot(canvas)` is called every turn to inject the canvas state into the first user message. It rebuilds the layer-tree string from scratch — walking every shape, formatting every property, capping at 300 lines + 15 resolver warnings. For an empty canvas, it's ~200 bytes. For a 60+ shape canvas, it's 5-10K tokens.

The `canvasSnapshotDelta` digest (Phase C R9a) was added to send only changed nodes — but it's gated by `DELTA_MIN_SHAPES=60` at `runner-native.ts:1540`. Below 60 shapes, full snapshot is sent. Above 60 shapes with no delta info, full snapshot is sent. The trivial tier (1-3 shapes) ALWAYS pays full snapshot cost — but for empty canvas the cost is negligible.

The real waste is on **simple-tier follow-up turns** (20-40 shape canvases) — those pay the full 5-10K token snapshot cost on every turn, even when only 2-3 shapes changed.

**Change:**

- Lower `DELTA_MIN_SHAPES` from 60 → 20 at `runner-native.ts:1540`.
- Keep the existing empty-changed-set fallback (renders full when `delta.nodeIds.length === 0`) — already in place at `runner-native.ts:1527-1539`.

**Expected impact:**

- Simple-tier follow-up turns save 2-5K tokens per turn → ~0.5-1s TTFT savings.
- Multi-tier follow-up turns already get delta; no change.
- Trivial tier unchanged (snapshot is already tiny).

**Risk:** Low. The delta digest handles the empty-changed-set case correctly. Adding a test asserting non-empty changed-set on a 25-shape canvas produces a correct delta eliminates the regression surface.

### 2. Patch applier is O(N) per patch

**File:** `src/lib/canvas/patch.ts:217-260` (`applyPatchToCanvas`).

**Problem:** Each patch clones the entire `canvas.children` array shallowly per child:

```ts
next.children = (canvas.children ?? []).map((c) => ({ ...c }));
```

For a K-node `pen_create_subtree` patch on a 50-shape canvas, that's 50 shallow clones. The store batches patches at ≤1 rAF, but inside the batch each patch is still O(N).

The `pen_create_subtree` multi-root batch (Agent Performance Package change 1) collapses K sequential `pen_create_node` calls into 1 patch with K nodes — so the O(N) cost is paid once, not K times. Good. But the per-patch clone is still O(N).

**Change:** Structural-sharing patch applier. Replace `canvas.children.map((c) => ({ ...c }))` with a structural-sharing map that only clones nodes on the mutation path (path from root to patched node). For deep trees, drops O(N) → O(log N) per patch.

The immutable-JSON-tree pattern (used by tldraw, Excalidraw, Immer) is well-established. Immer's `produce` is the canonical implementation.

**Implementation sketch:**

```ts
import { produce } from 'immer'; // or use structural-sharing custom impl

export function applyPatchToCanvas(canvas: CanvasDocument, patch: CanvasPatch): CanvasDocument {
  return produce(canvas, (draft) => {
    for (const op of patch.ops) {
      applyOpToDraft(draft, op); // mutates draft in place
    }
  });
}
```

Immer's structural sharing means unchanged subtrees share references with the previous state — `React.memo` and zustand selectors automatically skip re-renders.

**Expected impact:**

- For a 50-shape canvas with a 10-node subtree create: drops 50 shallow clones → ~3 clones (one per ancestor of the patched node). ~16× speedup per patch.
- For a 1000-shape enterprise canvas with a 1-node update: drops 1000 clones → ~5 clones. ~200× speedup per patch.

**Risk:** Medium-high. Structural sharing changes equality semantics that downstream code (React.memo, zustand selectors, snapshot byte-determinism, journal fold) depends on.

**Mitigation:**

- Property tests `tests/unit/canvas-full-merge.test.ts` and `tests/unit/patch-coalesce.test.ts` already assert immutability semantics — they'd catch regressions.
- Snapshot byte-determinism (`tests/unit/canvas-snapshot-delta.test.ts`) would catch any change in serialized output.
- Defer this change to P2 unless the complex-tier bench shows rendering as a top-3 bottleneck.

### 3. Progressive UI rendering for multi-patch bursts

**File:** `src/lib/canvas/store.ts` (the zustand store's patch application + rAF batching).

**Problem:** The store batches incoming patches at ≤1 rAF via `applyPatchesToCanvas` (`store.ts:1044-1055`). For a K-node `pen_create_subtree` patch (one patch, K nodes), the React renderer paints ALL K nodes in a single commit. For K > 30, the user sees nothing for 16ms then everything at once.

The perceived-latency research (`03-industry-parity-targets.md`) shows that streaming partial results feels faster than batched results — even when the batched result arrives sooner in absolute terms.

**Change:** For K > 30 (large subtree creation), split the patch into 2-3 rAFs:

1. First rAF: paint the top-level frame + first 30 children (user sees structure immediately).
2. Second rAF: paint remaining children (user sees content fill in).
3. Third rAF (if needed): paint grandchildren / details.

**Implementation:** Modify `applyPatchesToCanvas` to detect K > 30 patches in the same batch and split them across rAFs. The patches are still applied atomically to the canvas state (so the agent's view is consistent), but the React renderer is fed the changes incrementally.

**Expected impact:**

- For complex-tier turns (50+ node creations): user sees pixels 1-2 rAFs earlier (~16-32ms improvement). Negligible wall-clock but meaningful perceived-latency improvement (~20% per the skeleton-screen research).

**Risk:** Low. The canvas state is unchanged; only the React rendering schedule changes. The zustand store batches rAF updates already, so this is a tuning of the existing batcher.

### 4. Snapshot byte-stability for cache hits

**File:** `src/lib/agent/runner-legacy.ts:1221-1310`.

**Problem:** The snapshot string is rebuilt from scratch every turn. Even when the canvas hasn't changed (rare but possible — e.g. an agent that just answers a question without mutating), the string is recomputed. This invalidates the prompt-cache hit on the static prefix.

**Change:** Memoize `canvasSnapshot(canvas)` by `canvas.id + canvas.shapes.length + canvas._rev` (where `_rev` is a canvas revision counter bumped on every patch). If the inputs match the cached value, return the cached string.

**Implementation:**

```ts
let snapshotCache: { key: string; value: string } | null = null;

export function canvasSnapshot(canvas: CanvasDocument): string {
  const key = `${canvas.id}:${canvas.shapes.length}:${canvas._rev ?? 0}`;
  if (snapshotCache?.key === key) return snapshotCache.value;
  const value = buildCanvasSnapshot(canvas);
  snapshotCache = { key, value };
  return value;
}
```

**Expected impact:** Negligible for production turns (canvas almost always changes), but eliminates redundant snapshot builds in tests + non-mutation turns.

**Risk:** None. Memoization is referentially transparent.

---

## What we explicitly are NOT changing

### The document model

The `CanvasDocument` / `Layer` / `Variable` schema in `src/lib/canvas/types.ts` is stable and well-tested. Adding new node types, removing properties, or changing the schema would break every persisted canvas in the DB and every saved `.pen` file. Not in scope.

### The patch protocol

The `CanvasPatch` / `PatchOp` JSON-patch-style protocol is stable. The agent emits patches; the server sanitizes + journals + applies them. Changing the protocol would require coordinated agent + server + client changes.

### The renderer

The DOM renderer (`src/components/canvas/CanvasStage.tsx`) is the only live renderer (post-Phase-5 cleanup of the SVG renderer). It uses React 19's concurrent rendering + zustand selectors. The `scripts/dom-renderer-bench/` benchmarks the renderer in isolation — its p95 frame times are already within the 16ms gate. Not changing.

### The .pen format

The .pen file format (`src/lib/pen/`) is the persistence layer. It's v2.17 with 20 node types and a documented resolver. Changing it would break every saved file. Not in scope.

---

## Summary of changes (priority-ordered)

| # | Change | File | Complexity | P-level | Expected Δ |
|---|---|---|---|---|---|
| 1 | Lower `DELTA_MIN_SHAPES` 60 → 20 | `runner-native.ts:1540` | S | P0 | simple-tier follow-up turns save 2-5K tokens |
| 2 | Memoize `canvasSnapshot` by canvas rev | `runner-legacy.ts:1221` | S | P0 | eliminates redundant builds in tests + non-mutation turns |
| 3 | Progressive UI rendering for K > 30 patches | `store.ts:1044` | M | P2 | ~20% perceived-latency improvement on complex tier |
| 4 | Structural-sharing patch applier (Immer) | `patch.ts:217` | L | P2 | 16-200× patch-apply speedup on large canvases |
