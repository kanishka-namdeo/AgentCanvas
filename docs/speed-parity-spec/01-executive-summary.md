# 01 — Executive Summary

## TL;DR

Pi-agent is **5-10× slower than industry parity on TTFT** and **2-4× slower on T2C** across all complexity tiers. The gap is concentrated in three places: (1) ~45K-token static prefix driving LLM prefill, (2) a brief pre-generation sub-agent that fires too aggressively on trivial prompts, (3) tier-blind defaults for iteration budgets, critique iterations, and tool catalogs. **Five changes close ~80% of the gap** — all are simplifications, none require new infrastructure.

---

## The baseline (2026-09-10, z.ai sandbox provider, thinking=low)

11 scenarios × 1 repeat, 4-tier matrix. Each scenario = real `/api/agent` POST + NDJSON stream consumed.

| Tier | Scenario | TTFT | T2C | Calls | Patches | Status |
|---|---|---|---|---|---|---|
| trivial | trivial-shape | 10.6s | 12.1s | 2 | 1 | complete |
| trivial | trivial-heading | 4.8s | 10.0s | 4 | 1 | complete |
| simple | simple-login | 21.5s | 65.6s | 4 | 1 | complete |
| simple | simple-pricing | 29.5s | 75.4s | 4 | 2 | complete |
| simple | simple-settings | 30.3s | 54.2s | 4 | 1 | complete |
| multi | multi-dashboard | 33.5s | 113.7s | 4 | 4 | complete |
| multi | multi-kanban | 15.1s | 87.7s | 4 | 2 | complete |
| multi | multi-chart | 25.1s | 126.8s | 4 | 2 | complete |
| complex | complex-landing | 39.5s | 165.0s | 2 | 1 | complete (turn_cancelled) |

> Note: trivial-tier benchmarks capped at 4 min; complex and flow tiers can run longer. Full results land in `download/speed-bench/baseline-zai-low/` as the bench completes.

### The gap vs industry parity

| Tier | Industry TTFT | Industry T2C | Industry Calls | Actual TTFT | Actual T2C | Actual Calls | TTFT Gap | T2C Gap |
|---|---|---|---|---|---|---|---|---|
| trivial | ≤1s | 3-8s | ≤2 | 7.7s avg | 11s avg | 3 avg | **7.7×** | **1.4-3.7×** |
| simple | ≤3s | 10-30s | ≤6 | 27s avg | 65s avg | 4 | **9×** | **2.2-6.5×** |
| multi | ≤5s | 30-90s | ≤12 | 25s avg | 109s avg | 4 | **5×** | **1.2-3.6×** |
| complex | ≤8s | 90-180s | ≤20 | 39.5s | 165s | 2 | **4.9×** | within |

**Key observation:** tool-call counts are within industry budgets. The gap is wall-clock latency per call, not call count.

---

## What's wrong (concentrated, not diffuse)

### 1. Static prefix bloat → 70% of trivial-tier TTFT

The system prompt template (~20K tokens) + tool schemas (~25K tokens) form a ~45K-token static prefix that every LLM iteration pays. The prompt IS byte-stable and prompt-cacheable (the Agent Performance Package change 5 made it so), but **the FIRST iteration of every turn pays the full cost** — and every session is `SessionManager.inMemory` so cross-turn cache advantage is lost.

Probe-trivial.log shows 7,675ms of dead time between request send and the first `agent:model_info` event. That's pure prefill. The remaining 3s to TTFT is the model emitting the first tool call.

### 2. Brief sub-agent race → 25% of trivial-tier TTFT

`shouldEnforceBrief` (`runner-native.ts:600-602`) gates on `isDesignRequest(prompt)` which is a keyword regex including `draw|create|make|build|design`. **Trivial prompts match this regex** ("Draw a red rounded rectangle" matches `draw`), so the 25s-timeout brief pre-generation race fires — producing a 1.3K-token JSON brief that's injected into the first user message, consuming one extra iteration and 3-25s of wall-clock.

The brief is intended for multi-section designs where palette + typography + IA coherence matter. For a single rectangle, the brief is pure waste.

### 3. Tier-blind defaults → 5% of trivial-tier TTFT, 30% of complex-tier T2C

- `maxIterations ?? 20` (runner-native.ts:278) is the same across all tiers. Trivial can't legally exceed 2 calls, but the hard cap doesn't enforce that.
- `maxCritiqueIterations ?? 2` (runner-native.ts:2520) is the same across all tiers. The `shouldRunCritics` gate already exempts trivial, but the belt-and-suspenders is missing.
- `DELTA_MIN_SHAPES=60` (runner-native.ts:1540) means simple-tier follow-up turns (20-40 shape canvases) pay full snapshot cost when they could pay delta.
- Tool catalog is the same for all tiers — trivial prompts see all 85+ tools, including component variants, figma-canonical, design-critic plugins, etc.

### 4. Rate-limit backoff in the hot path → 5% of trivial-tier, 15% of complex-tier

The fallback ladder has a 20s+45s rate-limit backoff tier (`runner-native.ts:2068-2106`) that fires on first-attempt empty responses (rate-limit signature). On the z.ai sandbox provider, empty responses happen on cold-cache first iterations — so the backoff tier fires frequently. The 65s of dead time happens inside the user's perceived TTFT, not in the background.

### 5. Critique loop on complex tier → 30% of complex-tier T2C

`maxCritiqueIterations=2` means up to 2 fix-turns on complex designs. Each fix-turn is a full re-prompt (30-180s). The `designCritiqueMode='manual'` default exempts the trivial tier (good), but on complex-tier the critics are auto-eligible via the `shouldRunCritics` gate (≥20 new nodes OR fresh-document ≥12 nodes).

---

## The 5 changes that close 80% of the gap (ICE-ranked)

### Change 1 — Narrow `shouldEnforceBrief` predicate [complexity: S]

**What:** Extend `runner-native.ts:600-602` to require `prompt.length > 12` AND a multi-section design keyword (page/screen/dashboard/landing/app/website) for the brief sub-agent to fire.

**Impact:** Trivial-tier TTFT drops 10.6s → ~3-4s (deletes 7s of brief sub-agent wall-clock).

**Risk:** A multi-section prompt that's < 12 words would skip the brief. Mitigation: keep the `pen_generate_design_brief` tool available — the model can call it explicitly if it decides it needs a brief.

### Change 2 — Tier-aware tool catalog [complexity: M]

**What:** For trivial-tier prompts (keyword classifier confidence ≥ 0.7 + prompt < 12 words + no design keyword), reduce the visible toolset to ~6 tools: `pen_create_node`, `pen_create_subtree`, `pen_update_node`, `pen_get_metadata`, `pen_search_icons`, `pen_apply_palette`.

**Impact:** Static prefix drops from ~45K → ~12-15K tokens → prefill drops from 7.6s → ~2-2.5s → trivial TTFT from 10.6s → ~2-3s.

**Risk:** A model needing an out-of-tier tool gets an "unknown tool" error. Mitigation: keep `pen_create_subtree` always-on (the workhorse); add a 1-iteration escape hatch (if first attempt errors with "tool not found", widen to the full category allowlist on attempt 2).

### Change 3 — Tier-aware iteration + critique budgets [complexity: S]

**What:**
- `maxIterations` tier-aware: trivial=4, simple=8, multi=14, complex=24, enterprise=32 (keyed off classifier output at `runner-native.ts:278`).
- `maxCritiqueIterations` tier-aware: trivial=0, simple=1, multi/complex/enterprise=2 (at `runner-native.ts:2520`).

**Impact:** Bounds worst-case turn wall-clock per tier. Belt-and-suspenders on the `shouldRunCritics` gate. Trivial tier can't spiral into 78-call runaway (the original Agent Performance Package motivation).

**Risk:** A complex prompt misclassified as simple loses a critique iteration. Mitigation: deterministic Gate 0 (`validateCanvasBeforeComplete` at L2608) still runs every build turn — it surfaces defects even when critics don't fire.

### Change 4 — Lower `DELTA_MIN_SHAPES` 60 → 20 [complexity: S]

**What:** One constant change at `runner-native.ts:1540`. Delta snapshot kicks in earlier on follow-up turns.

**Impact:** Simple-tier follow-up turns (20-40 shape canvases) save 2-5K tokens of snapshot per turn → ~0.5-1s TTFT savings on those turns.

**Risk:** The original 60-threshold was set because small canvases don't benefit much from delta (the snapshot is small anyway). Lowering to 20 is safe because the `canvasSnapshotDelta` function correctly handles the empty-changed-set case (renders full when needed).

### Change 5 — Drop legacy 8s net for z.ai rate-limit-shaped failures [complexity: S]

**What:** Predicate change at `runner-native.ts:2213`. When the failure IS rate-limit-shaped (already handled by the 20s+45s backoff tier), skip the additional 8s sleep.

**Impact:** Removes 8s of dead time on z.ai rate-limited turns. Real impact bounded by how often the rate-limit tier fires — observed in 3 of 9 completed scenarios (`agent:error` events in the bench log).

**Risk:** A non-rate-limit empty response loses the 8s recovery sleep. Mitigation: keep the legacy net for `!rateLimitSignature` failures (the existing predicate already separates the two cases).

---

## Why these 5, not others

The bottleneck analysis (`04-bottleneck-analysis.md`) identifies 11 cost centers. After ICE-ranking, the top 5 above carry ~80% of the impact. The next 5 (in priority order) are:

6. **Skip VLM critic client-screenshot round-trip for ≤20-shape canvases** — saves 3s per critic dispatch on small canvases.
7. **Lower brief timeout 25s → 12s** — worst-case brief wait drops 13s on slow endpoints.
8. **Lower classifier LLM-fallback retry budget** — `maxRetries: 3, baseDelayMs: 3000` → `maxRetries: 1, baseDelayMs: 1500`. Worst-case ambiguous-prompt TTFT 18s → ~5s.
9. **Structural sharing in `applyPatchToCanvas`** — drops O(N) → O(log N) per patch on deep trees. Deferred unless complex-tier bench shows rendering as a top-3 bottleneck.
10. **Run `scripts/measure-tool-cost.ts` + checkin JSON** — empirically ground per-tool token budget for data-driven future decisions.

These are detailed in `08-implementation-roadmap.md` as P1/P2 (post-P0).

---

## What we explicitly are NOT doing

- **No rewrite of the agent loop.** The existing `runner-native.ts` is structurally correct; the fixes are predicate / constant / allowlist changes.
- **No new SDK.** `@earendil-works/pi-coding-agent` already exposes `shouldStopAfterTurn`, compaction, prompt-cache flags. We're not swapping the runtime.
- **No new model.** The z.ai sandbox provider is the default; tier-aware tool slimming reduces the cost without requiring a smaller model.
- **No compromise on quality.** The VLM-critic suite (`download/vlm-exercise/`) remains the regression gate. Mean overall score ≥ 6.0 must hold.
- **No new UI.** The perceived-performance patterns (skeleton screens, streaming) are documented in `07-agent-behaviors-flows.md` as future work, not P0.

---

## Acceptance criteria

This spec is "done" when:

1. **Speed:** All 5 P0 changes land on `main` + benchmark before/after table is in `02-baseline-benchmarks.md`.
2. **Parity:** TTFT hits ≤3s on trivial, ≤8s on simple, ≤12s on multi, ≤15s on complex (industry parity targets in `03-industry-parity-targets.md`).
3. **Quality:** VLM-critic mean overall score holds ≥ 6.0 across the 14-turn matrix in `download/vlm-exercise/`.
4. **Coverage:** Every P0 change has a unit test asserting the new behavior; `09-benchmark-suite.md` is wired into CI.
5. **Docs:** Every code change has a corresponding doc update in this directory; the worklog at `/home/z/my-project/worklog.md` records every milestone.
