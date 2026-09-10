# 08 — Implementation Roadmap

> **Scope:** Phased plan for landing the spec changes. Each phase has a clear definition-of-done, a benchmark before/after expectation, and a commit-per-milestone contract.

---

## Phase summary

| Phase | Theme | Duration | Risk | Acceptance gate |
|---|---|---|---|---|
| P0 | Tier-aware defaults + brief predicate narrowing | 1 week | Low | TTFT ≤3s on trivial, ≤8s on simple |
| P1 | Sub-agent budget tuning + classifier hardening | 1 week | Low | TTFT ≤5s on multi, ≤15s on complex |
| P2 | Parallel dispatch + caching + perceived-performance UX | 2 weeks | Medium | TTFT ≤3s on multi, ≤12s on complex |
| P3 | Structural sharing + speculative streaming + rapid-build scaffolds | 4+ weeks | High | TTFT ≤1s on trivial, ≤5s on multi |

---

## P0 — Tier-aware defaults + brief predicate narrowing

**Goal:** Eliminate the brief sub-agent's wall-clock on trivial prompts + apply tier-aware iteration budgets + apply tier-aware tool catalogs.

### P0.1: Define tier allowlists + classifier extension

**Files:**
- new `src/lib/agent/tier-allowlists.ts`
- `src/lib/agent/classifier.ts` (extend `ClassifierResult` with `tier`)

**Acceptance:**
- Each of the 5 tier allowlists (trivial, simple, multi, complex, enterprise) is a `Set<string>` of tool names.
- Each allowlist is a subset of the production tool surface (no orphan names).
- The classifier returns the tier for representative prompts.
- Unit test: `tests/unit/tier-allowlists.test.ts` + `tests/unit/classifier-tier.test.ts`.

**Complexity:** S

### P0.2: Wire tier allowlists into the runner

**Files:**
- `src/lib/agent/runner-native.ts:507-527` (intersect `turnTools` with `getTierAllowlist(classifierResult.tier)` after existing filters)
- `src/lib/agent/runner-native.ts` attempt loop (escape hatch on tool-not-found → widen to category allowlist on attempt 2)

**Acceptance:**
- Trivial-tier prompts see only 6 tools in the LLM-visible catalog.
- If the model errors with "tool not found", attempt 2 widens to the full category allowlist.
- Unit test: `tests/unit/tier-tool-filtering.test.ts`.

**Complexity:** M

### P0.3: Narrow `shouldEnforceBrief`

**Files:**
- `src/lib/agent/runner-native.ts:600-602` (require `prompt.length > 12 words` AND multi-section keyword)
- new helper `isMultiSectionDesignRequest(prompt)` in the same file

**Acceptance:**
- "draw a red rectangle" → `shouldEnforceBrief === false`.
- "add a bold heading" → `shouldEnforceBrief === false`.
- "create a 240x120 button" → `shouldEnforceBrief === false`.
- "design a high-fidelity analytics dashboard with 4 KPI cards" → `shouldEnforceBrief === true`.
- "design a marketing landing page for an AI tool" → `shouldEnforceBrief === true`.
- Unit test: `tests/unit/trivial-tier-brief-skip.test.ts`.

**Complexity:** S

### P0.4: Lower brief timeout 25s → 12s

**Files:**
- `src/lib/agent/runner-native.ts:712-713`

**Acceptance:**
- Brief pre-generation race times out after 12s instead of 25s.
- The tool-layer brief gate at L760-804 still fires for non-trivial prompts that need a brief.

**Complexity:** S

### P0.5: Tier-aware `maxIterations` + `maxCritiqueIterations`

**Files:**
- `src/lib/agent/runner-native.ts:278` (tier-aware `maxIterations`)
- `src/lib/agent/runner-native.ts:2520` (tier-aware `maxCritiqueIterations`)
- new constants `TIER_MAX_ITERATIONS` and `TIER_MAX_CRITIQUE_ITERATIONS` in the same file

**Acceptance:**
- Trivial tier: `maxIterations=4`, `maxCritiqueIterations=0`.
- Simple tier: `maxIterations=8`, `maxCritiqueIterations=1`.
- Multi/complex/enterprise: `maxIterations=14/24/32`, `maxCritiqueIterations=2`.
- Unit test: `tests/unit/tier-iteration-budget.test.ts`.

**Complexity:** S

### P0.6: Drop legacy 8s net for z.ai rate-limit-shaped failures

**Files:**
- `src/lib/agent/runner-native.ts:2213`

**Acceptance:**
- For z.ai provider + rate-limit-shaped failure: no 8s sleep.
- For non-z.ai provider OR non-rate-limit failure: 8s sleep preserved.
- Unit test: `tests/unit/fallback-ladder-zai-skip.test.ts`.

**Complexity:** S

### P0.7: Skip VLM critic client-screenshot for ≤20-shape canvases

**Files:**
- `src/lib/agent/subagents/design-critic-vlm.ts:140-146`

**Acceptance:**
- For canvases ≤20 shapes: skip client round-trip, use resvg.
- For canvases >20 shapes: keep client round-trip.
- `screenshotSource: 'server'` telemetry preserved.

**Complexity:** S

### P0.8: Lower `DELTA_MIN_SHAPES` 60 → 20

**Files:**
- `src/lib/agent/runner-native.ts:1540`

**Acceptance:**
- Canvases 20-59 shapes use delta snapshot on follow-up turns.
- Empty-changed-set fallback preserved (renders full when delta is empty).

**Complexity:** S

### P0.9: Run + checkin `measure-tool-cost.ts` output

**Files:**
- `scripts/measure-tool-cost.ts` (run with each tier's allowlist)
- `download/speed-bench/tool-cost-by-tier.json` (checkin output)

**Acceptance:**
- JSON output exists with per-tier token cost breakdown.
- Per-tool token budget empirically grounded (not estimated).

**Complexity:** S

### P0.10: System-prompt recipe reorder + tier hint

**Files:**
- `src/lib/agent/runner-legacy.ts:117+` (`SYSTEM_PROMPT_TEMPLATE`):
  - Move `pen_create_subtree` batch recipe ABOVE `pen_create_node` single-shape recipe.
  - Add explicit note about id-manifest in subtree result.
  - Add per-tier hint at the top of the per-turn section.

**Acceptance:**
- The model prefers `pen_create_subtree` for batch creation.
- The model does NOT call `pen_get_metadata` after `pen_create_subtree` (the result already includes the manifest).

**Complexity:** S

### P0 verification (benchmark)

**Before:** (current baseline, from `download/speed-bench/baseline-zai-low/`)

| Tier | TTFT p50 | T2C p50 |
|---|---|---|
| trivial | 7.7s | 11.0s |
| simple | 29.5s | 65.6s |
| multi | 25.1s | 113.7s |
| complex | 46.8s | 172.5s |
| flow | 24.2s | 88.1s |

**After P0 target:**

| Tier | TTFT target | T2C target | Industry parity |
|---|---|---|---|
| trivial | ≤3s | ≤8s | ≤1s / 3-8s |
| simple | ≤10s | ≤30s | ≤3s / 10-30s |
| multi | ≤12s | ≤90s | ≤5s / 30-90s |
| complex | ≤15s | ≤150s | ≤8s / 90-180s |
| flow | ≤12s | ≤90s | ≤8s / 90-180s |

**Verification command:**
```bash
bun scripts/speed-bench/run.ts \
  --provider=zai \
  --thinking=low \
  --out=download/speed-bench/after-p0
```

**Quality gate:** Re-run the 14-turn VLM matrix (`MAX_WAIT=560 timeout 580 bun scripts/vlm-inspect/run-scenarios.ts download/vlm-exercise/after-p0/`). Mean overall score ≥ 6.0 (no regression from `download/vlm-exercise/final/`'s 6.02).

---

## P1 — Sub-agent budget tuning + classifier hardening

**Goal:** Lower sub-agent retry budgets + add classifier tier-classification LLM fallback.

### P1.1: Lower classifier LLM-fallback retry budget

**Files:**
- `src/lib/agent/classifier.ts:321` (`maxRetries: 3, baseDelayMs: 3000` → `maxRetries: 1, baseDelayMs: 1500`)

**Acceptance:**
- Ambiguous-prompt classifier fallback fires once, then falls through to keyword result.
- Unit test: `tests/unit/classifier-llm-fallback-budget.test.ts`.

**Complexity:** S

### P1.2: Add classifier LLM-fallback tier classification

**Files:**
- `src/lib/agent/classifier.ts:67-79` (extend LLM-fallback prompt to also classify tier)

**Acceptance:**
- LLM fallback returns `{ category, confidence, tier }` not just `{ category, confidence }`.
- For ambiguous prompts, the LLM classifies the tier correctly.

**Complexity:** S

### P1.3: Run + compare bench before/after

**Verification command:**
```bash
bun scripts/speed-bench/run.ts \
  --provider=zai \
  --thinking=low \
  --out=download/speed-bench/after-p1
```

**Expected improvement:** Marginal TTFT reduction on ambiguous prompts (rare in the bench scenarios).

---

## P2 — Parallel dispatch + caching + perceived-performance UX

**Goal:** Eliminate serial sub-agent waits + cache redundant reads + surface perceived-latency affordances.

### P2.1: Parallelize web-research with main loop

**Files:**
- `src/lib/agent/runner-native.ts:945-1110` (dispatch + don't await; inject mid-turn via `session.steer()`)

**Acceptance:**
- Web-research fires as a background promise.
- Main loop starts immediately on the bare prompt.
- If web-research returns within the first main-loop iteration, summary is injected via `session.steer()`.
- If it doesn't return in time, the main loop finishes without it.

**Complexity:** M

### P2.2: Cache `pen_get_computed` per turn

**Files:**
- `src/lib/agent/client-roundtrip.ts` (add LRU)
- `src/lib/canvas/patch.ts` (add invalidation hook in `applyPatchToCanvas`)

**Acceptance:**
- Per-turn LRU keyed by `(nodeId, turnId)` with 5s TTL.
- A mutation invalidates the entry.
- Unit test: `tests/unit/client-roundtrip-cache.test.ts`.

**Complexity:** M

### P2.3: Make rate-limit backoff user-visible

**Files:**
- `src/lib/agent/runner-native.ts:2068-2106` (heartbeat event already emitted; add `retryInMs` field)
- `src/components/canvas/AgentPanel.tsx` (wire heartbeat to the existing retry-banner UI affordance)

**Acceptance:**
- Rate-limit backoff shows a "Rate-limited — retrying in Ns" banner.
- User can abort or wait.

**Complexity:** S

### P2.4: Progressive UI rendering for K > 30 patches

**Files:**
- `src/lib/canvas/store.ts:1044` (split patches into 2-3 rAFs for K > 30)

**Acceptance:**
- For K > 30 patches in a single batch, split into 2-3 rAFs.
- Canvas state updates atomically; only the React rendering schedule changes.
- DOM-renderer bench (`scripts/dom-renderer-bench/run.ts`) shows no regression on p95 frame time.

**Complexity:** M

### P2.5: Run + compare bench

**Verification:** Re-run the speed bench + 14-turn VLM matrix. Expected:

| Tier | TTFT target | T2C target |
|---|---|---|
| trivial | ≤2s | ≤5s |
| simple | ≤5s | ≤25s |
| multi | ≤8s | ≤60s |
| complex | ≤12s | ≤120s |
| flow | ≤8s | ≤60s |

**Quality gate:** VLM matrix mean overall ≥ 6.0.

---

## P3 — Structural sharing + speculative streaming + rapid-build scaffolds

**Goal:** Adopt the architectural patterns used by industry leaders (Aider's prefix-stable layout, Replit's rapid-build mode, Cursor's speculative tool-call streaming).

### P3.1: Structural-sharing patch applier (Immer)

**Files:**
- `src/lib/canvas/patch.ts:217-260` (replace `canvas.children.map((c) => ({ ...c }))` with `produce(canvas, draft => ...)`)

**Acceptance:**
- O(N) → O(log N) per patch on deep trees.
- All existing property tests pass: `tests/unit/canvas-full-merge.test.ts`, `tests/unit/patch-coalesce.test.ts`, `tests/unit/canvas-snapshot-delta.test.ts`.
- DOM-renderer bench (`scripts/dom-renderer-bench/run.ts`) shows no regression on p95 frame time.

**Complexity:** L

### P3.2: Memoize `canvasSnapshot` by canvas rev

**Files:**
- `src/lib/agent/runner-legacy.ts:1221` (add `let snapshotCache: { key, value } | null`)

**Acceptance:**
- Snapshot is memoized by `(canvas.id, canvas.shapes.length, canvas._rev)`.
- Tests pass (snapshot byte-determinism preserved).

**Complexity:** S

### P3.3: Speculative tool-call streaming

**Files:**
- `src/lib/agent/agent-session-translator.ts` (parse token stream for tool-call delimiters; fire tool call before model emits closing tag)

**Acceptance:**
- Saves 200-500ms per tool call.
- Tests pass (translator event ordering preserved).

**Complexity:** L (requires SDK cooperation)

### P3.4: Rapid-build scaffold emission (Replit pattern)

**Files:**
- new `src/lib/agent/scaffolds/` directory with per-design-type scaffold templates (login, dashboard, landing, kanban, pricing, settings, onboarding)
- `src/lib/agent/runner-native.ts` (on turn 0, emit the scaffold immediately while the real model call proceeds in the background)

**Acceptance:**
- For "design a dashboard" prompt, user sees a generic dashboard skeleton within 1s.
- Real model output replaces the skeleton within 15-60s.
- Skeleton is replaced (not appended) when the real output arrives.

**Complexity:** XL

### P3.5: Skeleton-screen UX for first 2s

**Files:**
- `src/components/canvas/CanvasStage.tsx` (render gray rectangles matching the requested design layout before any model output arrives)

**Acceptance:**
- For trivial prompts ("draw a red rectangle"), skeleton shows a single rectangle outline within 100ms.
- For complex prompts ("design a dashboard"), skeleton shows a generic dashboard layout within 1s.

**Complexity:** M

### P3.6: Tier-aware model routing (composite)

**Files:**
- `src/lib/agent/pi-ai-model-resolver.ts` (route trivial tier to a Haiku-class model, simple/multi to Sonnet, complex/enterprise to Opus)

**Acceptance:**
- Trivial tier uses a fast small model.
- Complex tier uses a frontier model.
- User can override per-tier model choice in Settings → LLM provider.

**Complexity:** XL (requires provider cooperation)

---

## Milestone commit contract

Every milestone (P0.1, P0.2, ..., P3.6) lands as a single commit with:

1. **Code change** — the actual implementation.
2. **Unit test** — asserting the new behavior.
3. **Benchmark before/after table** — appended to the corresponding spec doc (or `02-baseline-benchmarks.md` for the overall progress).
4. **Worklog entry** — appended to `/home/z/my-project/worklog.md`.
5. **DOX update** — if the change affects contracts, the nearest `AGENTS.md` is updated per the DOX framework.

The commit message format:

```
perf(speed-parity): P0.X — <one-line summary>

<2-3 paragraph body explaining the change, the bottleneck it addresses,
and the before/after measurement>

References: docs/speed-parity-spec/0X-<doc>.md#<section>
Bench: download/speed-bench/<before-vs-after>.json
```

---

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Tier classifier misclassifies a complex prompt as trivial | Medium | High (loses brief, loses iterations) | Escape hatch (tool-not-found widens); brief tool available as fallback; Gate 0 deterministic validator still runs |
| VLM critic judges resvg approximation as defect (P0.7) | Medium | Medium | Keep `screenshotSource` telemetry; user can opt back into client screenshot via Settings |
| Structural-sharing patch applier (P3.1) breaks downstream equality semantics | Low | High | Property tests catch regressions; defer to P3 unless complex-tier bench shows rendering as top-3 bottleneck |
| Web-research parallelization (P2.1) misses context the agent needed | Low | Medium | Web-research is rare for design prompts; classifier doesn't route there by default |
| Brief timeout 12s too aggressive for slow endpoints (P0.4) | Low | Medium | Tool-layer brief gate at L760-804 is the recovery; model can call `pen_generate_design_brief` directly |

---

## What we explicitly are NOT doing in this roadmap

- **No new SDK.** The `@earendil-works/pi-coding-agent` SDK is stable; we're not swapping it.
- **No new model.** The z.ai sandbox provider is the default; tier-aware tool slimming reduces the cost without requiring a smaller model.
- **No rewrite of the agent loop.** The `runner-native.ts` is structurally correct; the fixes are predicate / constant / allowlist changes.
- **No compromise on quality.** The VLM-critic suite (`download/vlm-exercise/`) remains the regression gate. Mean overall score ≥ 6.0 must hold.
- **No new UI for P0/P1.** Perceived-performance UX patterns are P2/P3.
