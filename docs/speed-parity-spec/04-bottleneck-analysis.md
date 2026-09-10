# 04 — Bottleneck Analysis

> **Source:** Task ID 6 subagent report (appended to `/home/z/my-project/worklog.md`). Code-anchored diagnosis per file:line. Recommendations only — no implementation in this doc. Implementation details live in docs 05-07.

The pi-agent's design generation pipeline was mapped end-to-end by the Explore subagent (Task ID 2). The full pipeline map is in `/home/z/my-project/worklog.md`. This doc is the bottleneck-by-bottleneck analysis paired with each bottleneck's:

- **Diagnosis** (file:line + why it matters)
- **Baseline measurement** (from the live speed bench)
- **Industry gap** (Δ to parity target)
- **Proposal** (what to change + expected impact)
- **Complexity** (S / M / L / XL)
- **Risk** (what could break + mitigation)
- **Tests** (existing coverage that protects the change)

---

## A. System prompt + tool-schema bloat (per-iteration token cost)

**Diagnosis** — `src/lib/agent/runner-legacy.ts:117-1194` (`SYSTEM_PROMPT_TEMPLATE`, ~20K tokens) + `src/lib/agent/tools.ts` + `pen-tools.ts` + `figma-tools.ts` + `plugins/index.ts` (~25K tokens of JSON-schema for ~85 production tools). Combined: ~45K-token static prefix. The Phase C P5/P6 audit fixes already moved `canvasSnapshot()` and per-turn sections OUT of the system prompt (`buildSystemPrompt(... includeSnapshot: false)` at `runner-legacy.ts:1536-1547`), so the prefix IS byte-stable and prompt-cacheable. BUT:

1. Every session is `SessionManager.inMemory` (`runner-native.ts:1763`) — fresh session per turn, so cross-turn cache advantage is **only realized inside a single turn's multi-iteration loop**.
2. The FIRST iteration of EVERY turn pays the full ~45K-token prefill cost.
3. The probe timeline (`download/speed-bench/probe-trivial.log`) shows 7,675ms of dead time between request send and the first `agent:model_info` event on trivial-shape — pure prefill.

**Baseline measurement** — 7,675ms prefill on trivial-shape. ~72% of trivial-tier TTFT.

**Industry gap** — Industry trivial TTFT ≤1s. Baseline 7.7s avg. **Δ = 6.7s (7.7× over target)**. Claude Code's documented ~5,600-token/turn → 60s prefill is the direct analog; AgentCanvas is ~8× larger.

**Proposal** — Tier-aware tool-schema slimming. The runner already has the infrastructure (`ONE_SHOT_DROP_TOOLS` at `runner-native.ts:519-527`; `categoryAllowedToolNames` at L475-480). Extend: on trivial-tier prompts, reduce the visible toolset to ~6 tools. Expected: static prefix drops from ~45K → ~12-15K tokens → prefill drops from 7.6s → ~2-2.5s → trivial TTFT from 10.6s → ~4-5s. Combined with the brief-skip proposal (H) trivial tier should hit ≤2s TTFT.

**Complexity** — **M** (single concern: add a `trivialTierToolAllowlist` constant + tier-classification predicate; touch `runner-native.ts:507-527` and `classifier.ts:107-220`).

**Risk** — A model needing an out-of-tier tool gets an "unknown tool" error (self-corrects per the alias-removal rationale at `runner-native.ts:504-505`). Mitigation: keep `pen_create_subtree` always-on (workhorse); add a 1-iteration escape hatch (if first attempt errors with "tool not found", widen to full category allowlist on attempt 2).

**Tests covering** — `tests/unit/agent-performance-package.test.ts` (12 tests on existing one-shot slimming + subtree); `tests/unit/modes-2026-08-30.test.ts:46-50` (mutating-tool-sample source-scan invariant); `tests/unit/agent-optimization-2026-09-05.test.ts` (one-shot tool dropping). Add: `tests/unit/trivial-tier-tool-allowlist.test.ts`.

---

## B. Tool-call round-trips (per-turn call budget)

**Diagnosis** — `src/lib/agent/runner-native.ts:278` (`maxIterations ?? 20`). Speed-bench overrides to 30. The hard cap is too high for the trivial tier (target ≤2 calls; observed 2-4).

Specific waste sources:

1. **Design-brief detour** — `runner-native.ts:600-602, 702-724`. `shouldEnforceBrief` matches `isDesignRequest(prompt)` which includes `draw|create|make|build|design`. Trivial-shape ("Draw a red rounded rectangle…") matches `draw` → brief sub-agent pre-generated → adds ~3-25s wall-clock on a prompt needing ZERO design-system thinking. The brief is then injected into the first user message (L1553-1555) and the model consumes another iteration reading it. This explains trivial-heading's 4 calls (brief-read + read-back + create + read-back).
2. **Read-backs after `pen_create_node`** — `tools.ts:1066-1291`: `pen_create_subtree` returns a full id-manifest (kills mandatory read-back), BUT probe-trivial.log shows `pen_create_node` was used instead of the batched `pen_create_subtree`. The system prompt's `pen_create_node` recipe (L948-960) is more visible than the `pen_create_subtree` batch recipe (L1066-1080) for single-shape prompts.
3. **Single-node emission when batched alternatives exist** — `pen_duplicate_nodes` (count/direction/spacing) and `pen_bulk_update_by_filter` exist, but the model emits N single `pen_create_node` / `pen_update_node` calls.

**Baseline measurement** — trivial-shape: 2 calls (within target ≤2). trivial-heading: **4 calls** (2× over target). simple-tier: 4 calls (within ≤6). multi-tier: 4 calls (within ≤12 — TTFT-bound, not call-count-bound).

**Industry gap** — Trivial ≤2 calls vs observed 4 = **2× over**. The 2 extra calls are (a) the design-brief detour (1 extra iteration) and (b) a `pen_get_metadata` read-back.

**Proposal** — Tier-specific iteration budgets in `DEFAULT_SETTINGS`. Add `maxIterationsTrivial=4, maxIterationsSimple=8, maxIterationsMulti=14, maxIterationsComplex=24, maxIterationsEnterprise=32` keyed off active skill + prompt-length heuristic; runner resolves per-tier budget at top of `runAgentNative`. Also: system-prompt nudge to prefer `pen_create_subtree` over `pen_create_node` for single shapes (the id-manifest result means the read-back is structurally impossible to need).

**Complexity** — **S** for per-tier budget (switch on `activeCategory` near `runner-native.ts:278`); **S** for brief-skip predicate (extend `shouldEnforceBrief` at L600-602 to require `canvasShapeCount===0 AND prompt.length > 12 AND design keyword matches`).

**Risk** — A complex prompt misclassified as trivial loses the brief sub-agent (palette/typography improvised). Mitigation: existing `isAmbiguousCreation` / `clarifyOnEmptyCanvas` / `detectMultitaskPrompt` heuristics already cover misclassification surface. The brief fallback gate at the tool layer (`runner-native.ts:760-804`) still enforces brief-first for non-trivial design requests.

**Tests covering** — `tests/unit/agent-performance-package.test.ts:96-150` (pen_create_subtree multi-root manifest); `tests/unit/critique-manual-mode-2026-09-06.test.ts` (manual-mode gating); `tests/unit/design-generation-hardening-2026-09-06.test.ts` (brief-first enforcement). Add: `tests/unit/trivial-tier-iteration-budget.test.ts`.

---

## C. Sub-agent overhead

**Diagnosis** — Five sub-agent dispatch paths in `runner-native.ts`:

1. **`design-brief`** (`subagents/design-brief.ts:148-228`) — pre-generated via `preGeneratedBriefPromise` raced against **25,000ms timeout** (`runner-native.ts:712-713`), joined at `runner-native.ts:1146-1152`. Fires on `shouldEnforceBrief` = design keyword + build mode + empty canvas + !clarify. For trivial prompts ("Draw a red rounded rectangle") `draw` matches → 25s race fires → 1.3K-token brief injected → model spends 1 extra iteration absorbing it. **The brief is wasted on trivial prompts.**
2. **`web-research`** (`subagents/web-research.ts:68-250`) — `MAX_SUBAGENT_ITERATIONS=6`, serially awaited before main loop. Only fires when classifier routes to `web_research` category. Does NOT fire on trivial design prompts.
3. **`design-critic` + `design-critic-vlm`** — run concurrently in critique loop (`runner-native.ts:2686-2737`). Default `designCritiqueMode='manual'` makes critics silent unless `/critique` keyword. **Trivial tier is exempt.**
4. **`variant-generator`** — `DEFAULT_BUDGET_MS=300s`, K=3 staggered by 15s. Only fires on explicit `/variants` or "explore|directions" keyword. When it fires, dominates wall-clock.
5. **`multitask`** — `TOTAL_BUDGET_MS=600s`, K up to 5. Only fires on `/multitask` prefix or detected multi-screen heuristic. When it fires, dominates wall-clock.

**Baseline measurement** — Sub-agent overhead is invisible in trivial-tier baselines (manual critic mode + no variant keyword + no multitask keyword + no web-research keyword). The ONLY sub-agent that fires on trivial-shape is `design-brief` — the probe-trivial.log shows 7.6s pre-event dead zone consistent with brief sub-agent wall-clock. The simple-tier TTFT (21-30s) is roughly trivial-tier prefill (7.6s) + brief sub-agent (10-20s) stacked.

**Industry gap** — Variant-gen + multitask dominate when they fire (300s / 600s budgets), exceeding complex-tier T2C target (180s). But these are correctly gated to explicit opt-in — the gap is in the brief sub-agent firing on trivial prompts.

**Proposal** — Three changes:

1. **Skip the brief pre-gen race on trivial-tier prompts** — extend `shouldEnforceBrief` to require `prompt.length > 12` (one-line trivial prompts don't need palette/typography/IA brief).
2. **Lower the brief timeout from 25s → 12s** for non-trivial prompts.
3. **Parallelize web-research with the main loop instead of awaiting it** — currently `runner-native.ts:945-1110` dispatches + awaits before user-message assembly. If web-research is needed, fire sub-agent and let main loop start on the bare prompt; if research returns in time, inject as follow-up turn.

**Complexity** — **S** for proposal 1 (one predicate clause); **S** for proposal 2 (one constant change); **M** for proposal 3 (need a follow-up injection mechanism; translator already supports mid-turn message deltas).

**Risk** — Proposal 1: a trivial-seeming prompt that DOES need a brief ("draw a stripe-style login") would lose the brief. Mitigation: keep the brief tool available — model can still call `pen_generate_design_brief` as its first tool call.

**Tests covering** — `tests/unit/design-generation-hardening-2026-09-06.test.ts` (brief-first enforcement); `tests/unit/critique-manual-mode-2026-09-06.test.ts` (manual mode gating); `tests/unit/modes-2026-08-30.test.ts:731+` (multitask detection). Add: `tests/unit/trivial-tier-brief-skip.test.ts`.

---

## D. Client round-trips

**Diagnosis** — `src/lib/agent/client-roundtrip.ts:41-52` `ROUNDTRIP_DEFAULTS` = {computed 2s, screenshot 2s, critic-screenshot 3s, html-extract 4s}. Server emits `agent:computed_request` / `agent:screenshot_request` via per-turn event sink and blocks on Promise keyed by `toolCallId` (L94-110). Resolution comes through `POST /api/agent/client-responses`. Hang-safety: `awaitClientResponse` NEVER rejects — resolves `null` on timeout (L100-103), caller falls back to resolver data or server-side render.

Three cost centers:

1. **`pen_get_computed`** (`tools.ts:4526`) — fetches real `getComputedStyle` / `getBoundingClientRect` from connected browser. 2s timeout per call.
2. **`pen_get_screenshot`** (`tools.ts:4600`) — fetches `html-to-image` capture of live DOM. 2s timeout.
3. **VLM critic screenshot** (`subagents/design-critic-vlm.ts:140-146`) — every critic dispatch sends `agent:screenshot_request` and waits up to 3s; on timeout falls back to `renderCanvasToPng` (server-side resvg, now in a child process per `src/lib/canvas/render-to-png.ts:22,102`).

**Baseline measurement** — Zero client round-trips observed in trivial / simple / multi speed-bench runs (no `agent:computed_request` or `agent:screenshot_request` events in probe-trivial.log). Critics gated by `designCritiqueMode='manual'`. `pen_get_computed` / `pen_get_screenshot` are model-emitted — when model uses them, each adds 2s wait + 200-500ms LLM round-trip latency per call.

**Industry gap** — When triggered: 2s per round-trip × N calls. Industry target is 200-500ms for tool-call round-trip. **4-10× over** per-call, but bounded by how often model emits these reads. Complex-tier T2C target (180s) leaves room for 6-12 such reads.

**Proposal** — Two changes:

1. **Skip VLM critic client-screenshot round-trip when canvas is small** (≤20 shapes) — server-side resvg render is accurate enough (the prior concern was resvg panics; now isolated in child process). Drop the 3s client wait and go straight to resvg. Saves 3s per critic dispatch on small canvases.
2. **Cache `pen_get_computed` results per turn** — model often calls `pen_get_computed` for the same node multiple times in one turn (especially after mutations). Add per-turn LRU keyed by `(nodeId, turnId)` with 5s TTL — a mutation invalidates the entry. Reduces 2-4 redundant 2s round-trips per complex turn to 1.

**Complexity** — **S** for proposal 1 (predicate change in `design-critic-vlm.ts:140`); **M** for proposal 2 (cache layer in `client-roundtrip.ts` + invalidation hook in `applyPatchToCanvas`).

**Risk** — Proposal 1: the critic's screenshot-source telemetry was added because resvg approximation diverged from real DOM on 100% of mandatory critic runs (Audit 2-c S2 at `runner-native.ts:2663-2672`). Reverting on small canvases re-opens that gap. Mitigation: keep `screenshotSource` telemetry so users see when the critic judged the approximation. The canvasSnapshot's measured-bounds already threads real browser sizes into resolver, so resvg's geometry is more accurate now.

**Tests covering** — `tests/unit/client-roundtrip.test.ts` (hang-safety + resolver); `tests/unit/canvas-snapshot-delta.test.ts:57-59` (round-trip reset between tests).

---

## E. Canvas snapshot cost

**Diagnosis** — `src/lib/agent/runner-legacy.ts:1221-1310` `canvasSnapshot(canvas)` rebuilds layer tree string on EVERY turn, capped at `SNAPSHOT_LINE_CAP=300` (L1205) + 15 resolver warnings. For empty canvas, ~200 bytes. For 60+ shape canvas, 5-10K tokens. `canvasSnapshotDelta` (Phase C R9a) only fires when `deltaIds && deltaIds.length > 0 && canvas.shapes.length > DELTA_MIN_SHAPES` (`runner-native.ts:1540-1544`, `DELTA_MIN_SHAPES=60`). Below 60 shapes, full snapshot. **The trivial tier ALWAYS pays full snapshot cost** — but for empty canvas it's ~200 bytes so cost is negligible. Real cost on multi-tier canvases (50+ shapes) where snapshot is 5-10K tokens AND fresh session per turn loses cache advantage.

**Baseline measurement** — multi-dashboard: TTFT 33.5s. Snapshot for multi-tier canvas (4 patches in 4 calls) is small because canvas starts empty and grows incrementally. Snapshot cost is hidden by model prefill cost (dominant). For follow-up turn on 60-shape canvas, snapshot adds ~1-2s to TTFT (estimated from 5-10K token addition to user message).

**Industry gap** — Negligible on trivial / simple tiers (snapshot small). On enterprise tier (60+ shapes), delta digest is the right optimization but its 60-shape threshold means **simple-tier follow-up turns (20-40 shape canvases) pay full snapshot cost when they shouldn't need to**.

**Proposal** — Lower `DELTA_MIN_SHAPES` from 60 → 20 at `runner-native.ts:1540`. The 60-threshold was originally set because small canvases don't benefit much from delta; 20-60 is the range where savings start to matter. The `canvasSnapshotDelta` function correctly handles empty-changed-set case (renders full when needed).

**Complexity** — **S** (one constant change at `runner-native.ts:1540`).

**Risk** — The 2026-09-07 follow-up-turn fix at `runner-native.ts:1527-1539` specifically calls out that empty changed-set would produce digest with ZERO expanded nodes — model would have to hydrate its own canvas blind via `pen_get_metadata` before every edit. Lowering to 20 doesn't change empty-changed-set fallback; just means more turns use delta mode. Mitigation: keep empty-changed-set fallback (already in place); add test asserting non-empty changed-set on 25-shape canvas produces correct delta.

**Tests covering** — `tests/unit/canvas-snapshot-delta.test.ts` (219 lines — globals-survival, byte-determinism, collapsed subtrees, expanded hydration); `tests/unit/followup-delta-2026-09-07.test.ts` (empty-changed-set fallback).

---

## F. Critique loop overhead

**Diagnosis** — `src/lib/agent/runner-native.ts:2520` `maxCritiqueIterations ?? 2`. Loop runs 0-2 iterations; each fix-turn is full re-prompt of same session (Task 7-e Fix 3 at L2890-2967 — reuses main session for context preservation). Each iteration = 1 text-critic + 1 VLM-critic (concurrent, L2686-2737) + 1 fix-turn re-prompt = ~3 LLM calls + 30-180s wall-clock.

The `shouldRunCritics` gate (`modes.ts:245-258`) is **already correctly exempting trivial tier**: default `designCritiqueMode='manual'` means critics fire ONLY on `/critique` or "critique|review|polish|audit|refine|make it beautiful" keyword. Trivial prompts don't match → no critics → no extra cost. Confirmed by `tests/unit/critique-manual-mode-2026-09-06.test.ts`.

**Baseline measurement** — Zero critique-loop overhead in trivial / simple / multi speed-bench runs (no `agent:critique` events, no `agent:subagent_dispatch: design_critic*` events in probe-trivial.log). Manual-mode gate is doing its job.

**Industry gap** — None on trivial / simple tiers. On complex tier, the 2-iteration cap with text+VLM+fix-turn can consume 90-180s — exactly at industry complex T2C ceiling (90-180s).

**Proposal** — Mode-aware default for `maxCritiqueIterations`. Currently `settings?.maxDesignCritiqueIterations ?? 2` is the same across all tiers. Change to: trivial=0, simple=1, multi/complex/enterprise=2. `shouldRunCritics` gate already prevents dispatch on trivial; setting `maxCritiqueIterations=0` is belt-and-suspenders — also short-circuits the FREE deterministic validation gate's iteration count.

**Complexity** — **S** (one tier-aware default at `runner-native.ts:2520`).

**Risk** — A complex prompt misclassified as simple would lose the second critique iteration. Mitigation: the deterministic Gate 0 (`validateCanvasBeforeComplete` at L2608) still runs every build turn regardless of mode — it's free and surfaces defects even when critics don't fire.

**Tests covering** — `tests/unit/critique-manual-mode-2026-09-06.test.ts` (manual-mode gating + skip-reason surfacing); `tests/unit/modes-2026-08-30.test.ts` (shouldRunCritics adaptive ladder + thresholds); `tests/unit/audit-design-budget.test.ts` (FREE deterministic validator).

---

## G. Stream / rendering latency

**Diagnosis** — Three layers:

1. **Route layer** — `src/app/api/agent/route.ts:309-322`: `ReadableStream` with immediate `controller.enqueue` per event. NDJSON with `\n` delimiters. Watchdog at `WATCHDOG_MS=120_000` (L366) + 30s abort grace (L377). **No buffering bottleneck at wire layer.**
2. **Translator layer** — `src/lib/agent/agent-session-translator.ts`: pushes AgentStreamEvents onto async queue drained by runner's `for await (const ev of queue.drain())` loop (`runner-native.ts:1925-2000`). **Events reach the route as fast as SDK emits them.**
3. **Patch applier** — `src/lib/canvas/patch.ts:217-260` `applyPatchToCanvas`: clones the ENTIRE `canvas.children` array shallowly per child on EVERY patch (`next.children = (canvas.children ?? []).map((c) => ({ ...c }))` at L232). Per-patch cost is O(N) where N = total child count. Store batches at ≤1 rAF via `applyPatchesToCanvas` — but inside the batch, each patch is still O(N) → batched cost is O(N×K) for K patches. For 50-shape creation burst using N=50 sequential `pen_create_node` calls, that's O(50×50) = 2,500 shallow clones. The Agent Performance Package's `pen_create_subtree` multi-root batch collapses this to O(50) — one clone, one `recomputeDerived`.

**Baseline measurement** — Patch counts 1-4 per scenario. DOM render latency invisible (sub-100ms per patch on 60-shape canvas). Patch cost only matters on complex-tier turns with 20+ sequential mutations.

**Industry gap** — None at wire layer (NDJSON unbuffered, sub-ms per event). Patch applier's O(N) per-patch cost is a known scaling cliff for complex tiers — the `pen_create_subtree` migration is the existing fix, working (probe-trivial.log shows `pen_create_node` was used on trivial-shape, but that's a 1-shape creation so cost is O(1)).

**Proposal** — Two changes:

1. **Structural share for the patch applier** — replace `canvas.children.map((c) => ({ ...c }))` with structural-sharing map that only clones nodes on mutation path (path from root to patched node). For deep tree, drops O(N) → O(log N) per patch. The immutable-JSON-tree pattern (used by tldraw / Excalidraw / Immer) is well-established.
2. **Progressive UI rendering for multi-patch bursts** — for K-node `pen_create_subtree` patch, React renderer should paint incrementally as patch is applied (one `set()` per rAF). Currently store batches at 1 rAF, so 50-node subtree is one commit. For K > 30, split into 2-3 rAFs.

**Complexity** — **L** for proposal 1 (touches `patch.ts:217+`'s clone strategy + `recomputeDerived` + children-insertion paths; needs property test to verify immutability semantics); **M** for proposal 2 (store-side rAF splitter).

**Risk** — Proposal 1: structural sharing changes equality semantics that downstream code (React.memo, zustand selectors, snapshot byte-determinism) depends on. `tests/unit/canvas-full-merge.test.ts` and `tests/unit/patch-coalesce.test.ts` property tests would catch regressions, but wide-blast-radius change. Defer unless complex-tier bench shows rendering as a top-3 bottleneck.

**Tests covering** — `tests/unit/canvas-full-merge.test.ts`, `tests/unit/patch-coalesce.test.ts`, `tests/unit/canvas-input-hardening-2026-09-07.test.ts`; `scripts/dom-renderer-bench/{run,stats}.ts` exists as live measurement tool.

---

## H. Brief pre-generation waste

**Diagnosis** — `src/lib/agent/runner-native.ts:600-602, 702-724`:

```ts
const shouldEnforceBrief = isDesignRequest(prompt) && mode === 'build'
  && turnStartShapeIds.size === 0
  && !clarifyOnEmptyCanvas;
```

`isDesignRequest` at L579-582 is keyword regex: `/\b(design|dashboard|landing\s*page|app|ui|build|create|make|draw|scaffold|layout|interface|website|page|screen)\b/`. For trivial prompts like "Draw a red rounded rectangle, 240x120, in the top-left area of the canvas" — `draw` matches → `shouldEnforceBrief = true` → brief sub-agent dispatched at L702-724 with **25,000ms timeout race** (L712-713).

The brief produces a 1.3K-token JSON (`subagents/design-brief.ts:79-132`) covering palette / typography / layout grid / information architecture — **none needed for a single rectangle**.

The brief is then joined at `runner-native.ts:1146-1152` and injected into first user message at L1553-1555:

```
[PRE-GENERATED DESIGN BRIEF — the palette / typography / layout source of truth for this whole turn. Do NOT call pen_generate_design_brief; build directly from this brief:]
${preGeneratedBrief}
```

This adds ~1.3K tokens to first user message AND consumes 3-25s of wall-clock waiting for the brief sub-agent's `callLLMWithRetry` (maxRetries=3, baseDelayMs=3000). On z.ai sandbox endpoint, brief sub-agent takes 5-10s. On slow custom tunnel, can hit 25s timeout.

**False-positive rate is high** for trivial prompts because `draw|create|make` are extremely common verbs. The `isAmbiguousCreation` predicate at L632-656 was already narrowed to require explicit `/variants` or "explore|directions" keywords; brief predicate needs the same narrowing.

**Baseline measurement** — Probe-trivial.log shows 7.6s pre-event dead zone — consistent with brief sub-agent consuming wall-clock. Simple-tier TTFT (21-30s) is roughly trivial-tier prefill (7.6s) + brief sub-agent (10-20s) stacked. trivial-heading prompt ("Add a bold heading that says 'Quarterly Report' at 32px, centered near the top") — `add` doesn't match regex → `shouldEnforceBrief = false`. That's why trivial-heading has LOWER TTFT (4.8s) than trivial-shape (10.6s) despite MORE calls (4 vs 2) — brief sub-agent didn't fire on trivial-heading.

**Industry gap** — Brief pre-gen adds 3-25s to trivial-tier TTFT. Industry trivial target ≤1s. **The brief alone is the entire gap for trivial-shape.**

**Proposal** — Three changes, ordered by impact:

1. **Narrow `shouldEnforceBrief`** to require a multi-section design signal: prompt length > 12 words AND at least one of (page/screen/dashboard/landing/app/website) keyword. Trivial prompts skip brief entirely.
2. **Lower the brief timeout from 25s → 12s.** The brief is best-effort; the tool-layer gate at `runner-native.ts:760-804` is the recovery path. 12s is still above the callLLMWithRetry first-attempt success time on most providers (3-8s).
3. **Skip the brief when the canvas is non-empty AND the prompt is an edit** — already implemented at `runner-native.ts:600-602` (`turnStartShapeIds.size === 0`), but multi-screen-build case ("now create the dashboard screen") is currently in no-brief path. Keep this — it's correct.

**Complexity** — **S** for proposal 1 (predicate extension); **S** for proposal 2 (one constant change at L713).

**Risk** — A prompt like "design a minimal login card" (5 words, matches "design" + "login") would skip the brief under proposal 1. The model would improvise the palette — but for single-card design, system prompt's FIDELITY POLICY section (`runner-legacy.ts:117+`) already names canonical palettes. The brief's value is highest on multi-section designs where palette + IA coherence matter; the proposal preserves brief dispatch for those. The brief tool itself (`pen_generate_design_brief` at `tools.ts:5470`) stays available — model can call it explicitly if it decides it needs the brief.

**Tests covering** — `tests/unit/design-generation-hardening-2026-09-06.test.ts` (brief-first enforcement contract); `tests/unit/agent-optimization-2026-09-05.test.ts` (one-shot tool slimming). Add: `tests/unit/trivial-tier-brief-skip.test.ts` asserting that "draw a red rectangle" + "add a bold heading" + "create a 240x120 button" all skip the brief pre-gen.

---

## I. Intent classification cost

**Diagnosis** — `src/lib/agent/classifier.ts:45-94` `classifyIntent`: keyword pass first (instant, zero cost) at L61-64 with 0.7 confidence threshold; LLM fallback at L67-79 sees ONLY 7 skill descriptions (~200 tokens) via `callLLMWithRetry` with `maxRetries: 3, baseDelayMs: 3000` (L321). The LLM fallback was previously a dead path (runner passed `llm: undefined`); the 2-c S9 fix at `runner-native.ts:437` wires `subAgentLLM` so it can actually fire.

For trivial prompts ("Draw a red rounded rectangle"), keyword pass should always hit with high confidence — `draw` matches `wireframe` skill's keyword list. LLM fallback only fires on genuinely ambiguous prompts.

**Baseline measurement** — Keyword pass is instant (sub-millisecond). LLM fallback, when it fires, costs 1 LLM call (~3-8s on z.ai sandbox, longer on slow tunnels). Bench doesn't measure classification cost separately, but probe-trivial.log shows first event fires at 30ms — classification is fast.

**Industry gap** — None on trivial tier (keyword pass always hits). On ambiguous prompts, LLM fallback adds 3-8s — but this is correct behavior (prevents wrong skill routing). Industry concern is `maxRetries: 3` with `baseDelayMs: 3000` — slow endpoint could consume 3×3s + 3 attempts = up to 18s before falling back to keyword result.

**Proposal** — Lower classifier's LLM-fallback retry budget from `maxRetries: 3, baseDelayMs: 3000` → `maxRetries: 1, baseDelayMs: 1500`. The classifier is best-effort; if LLM unavailable, keyword result (always computed first) is a safe fallback. Expected impact: ambiguous-prompt TTFT drops by up to 6-12s on slow endpoints.

**Complexity** — **S** (one constant change at `classifier.ts:321`).

**Risk** — A genuinely ambiguous prompt that keyword pass can't route would fall through to 'multi' safe fallback at L87-93 — which loads all skills. That's existing behavior; proposal just makes it happen faster.

**Tests covering** — `tests/unit/classifier.test.ts` (need to verify it exists; the classifier's keyword pass is exercised by every `runner-legacy.ts` test that injects a MockLLM). Add: `tests/unit/classifier-llm-fallback-budget.test.ts` asserting the LLM fallback fires only once before falling through.

---

## J. Fallback ladder cost

**Diagnosis** — `src/lib/agent/runner-native.ts:1700-2217` attempt loop. The ladder:

1. **Attempt 1** — primary model.
2. **Same-provider rate-limit backoff** (L2068-2106) — when `!sawActivity && rateLimitSignature`, wait 20s (retry 1) then 45s (retry 2). Up to **65s of dead time** per turn that hits rate limit. Watchdog feeds `agent:tool_progress` heartbeats every ≤20s (L2092-2100) so route's 120s watchdog doesn't fire.
3. **z.ai sandbox swap** (L2189-2206) — when `!currentModel.usedFallback && providerId !== 'zai' && (!sawActivity || diedMidStream || textOnlyDesignTurn)`. Recreates the AgentSession (L1754 `createAgentSession`) with new model — **fresh session = fresh system prompt build + fresh tool schema registration = full ~45K-token prefill cost again**.

The probe timeline:
- t=30ms: route emit `agent:message_start`
- t=7675ms: `agent:model_info` (7.6s of SDK + model prefill — attempt 1 starting)
- t=7675ms: `agent:message_end` immediately — attempt 1 ended with zero output (empty response = rate-limit signature)
- t=8760ms: streaming starts — attempt 2 (same model, ~1s gap, NOT 8s — meaning legacy 8s net was bypassed, OR rate-limit backoff tier declined because `sawActivity` was true from message_start event)
- t=10869ms: first `tool_call_start` — TTFT signal
- t=12421ms: turn_end

The 7.6s dead zone is dominant cost; fallback ladder adds 1-3s on top.

**Baseline measurement** — probe-trivial.log shows 7.6s prefill + 3.2s post-prefill to first tool call. The 4-attempt worst-case ladder can consume up to 65s (backoff) + 8s (legacy net) + 1× prefill = ~74s on rate-limited turn. The bench's simple-pricing scenario hit 2 `agent:error` events (status=complete but with errors in stream) — consistent with fallback ladder firing at least once.

**Industry gap** — Industry trivial-tier TTFT ≤1s; fallback ladder alone can consume 65s on rate-limited turns. The 20s+45s backoff is engineered for per-account rate-limit window clearing, which is the right model — but the BACKOFF happens INSIDE user's perceived TTFT, not in the background.

**Proposal** — Two changes:

1. **Make rate-limit backoff user-visible** — heartbeat at L2092-2100 already emits `agent:tool_progress` events; surface these as prominent "Rate-limited — retrying in Ns" banner in UI (existing `06-retry-banner-rate-limit.png` in `download/progressive-disclosure/` shows UI already has this affordance). User can choose to abort or wait — instead of staring at a spinner. Doesn't speed up turn, eliminates perceived-latency penalty.
2. **Drop the legacy 8s net (L2213)** when provider is z.ai — z.ai sandbox is auto-credential fallback; 8s sleep + retry on same dead endpoint is rarely productive. Probe shows this path was bypassed anyway — formalize the bypass.

**Complexity** — **S** for proposal 1 (UI banner already exists, just needs the heartbeat event wired); **S** for proposal 2 (predicate change at L2213).

**Risk** — Proposal 2: dropping legacy 8s net means z.ai endpoint that produces transient empty response gets only rate-limit backoff tier (20s+45s) before giving up. If empty response was NOT rate-limit-shaped (e.g. tunnel blip), turn fails instead of recovering. Mitigation: keep legacy net for `!rateLimitSignature` failures (which is what existing `!sawActivity && !rateLimitSignature` clause already does at L2164) — just drop 8s sleep when failure IS rate-limit-shaped (backoff tier already handled that).

**Tests covering** — `tests/unit/agent-error.test.ts` (error classification + retryable flag); `tests/unit/boot-recovery.test.ts` (session recovery). The fallback ladder's full behavior isn't covered by a single test — it's a runtime-observable path that the speed-bench surfaces.

---

## K. Compaction

**Diagnosis** — `src/lib/agent/runner-native.ts:168-172` `NATIVE_COMPACTION_SETTINGS` = {enabled: true, reserveTokens: 32_768, keepRecentTokens: 40_000}. SDK's auto-compaction fires when context window is ~32K from full (so 128K window fires at ~96K used). The summarization call goes through same `ModelRuntime.getAuth()` path as main loop.

For trivial tier: total per-turn tokens = ~45K (static prefix) + ~1K (user message + brief) + ~3K (tool calls + results) = ~49K — well below 96K trigger. **Compaction never fires on trivial / simple tiers.** For complex-tier turns with 12+ iterations and 50+ shapes, compaction can fire mid-turn — adding 5-15s of summarization overhead.

**Baseline measurement** — Zero compaction events in trivial / simple / multi speed-bench runs (no `agent:context_update` events in probe-trivial.log). Compaction cost is invisible in partial bench.

**Industry gap** — None on trivial / simple / multi tiers. On complex / enterprise tiers, the 5-15s compaction cost is the price of an unbounded context — industry-leading tools (Cursor Composer, Claude Code) all auto-compact. AgentCanvas's settings (32K reserve / 40K keep-recent) are tuned ABOVE SDK defaults (16K / 20K) per audit rationale at L147-152 — appropriate for tool-heavy design turns.

**Proposal** — No change. Current settings are correct for design-turn profile. Consider env override for ops tuning (`AGENT_COMPACTION_RESERVE_TOKENS` / `AGENT_COMPACTION_KEEP_RECENT_TOKENS` already exist at L170-171) — surface these in a Settings → Agent → Advanced panel so power users can tune for their model's context window.

**Complexity** — **S** (settings UI wiring only — env-override path exists).

**Risk** — None — proposal is observability-only.

**Tests covering** — `tests/unit/journal-fold.test.ts` (journal-fold watermark that drives compaction triggers); `tests/unit/journal-catchup.test.ts` (replay semantics). The compaction itself is SDK behavior, not directly tested.

---

## Top-10 ranked priority list (ICE-style: impact × ease)

| # | Change | File | Complexity | Expected Δ |
|---|---|---|---|---|
| 1 | **Narrow `shouldEnforceBrief`** — require prompt > 12 words AND multi-section keyword; trivial prompts skip brief sub-agent entirely. | `runner-native.ts:600-602` | S | trivial-shape TTFT 10.6s → ~3-4s (deletes 7s of brief sub-agent wall-clock) |
| 2 | **Tier-aware tool catalog** — trivial tier sees only ~6 tools (pen_create_node, pen_create_subtree, pen_update_node, pen_get_metadata, pen_search_icons, pen_apply_palette); ~80% schema slimming. | `runner-native.ts:507-527` | M | trivial-tier prefill 7.6s → ~2-2.5s; static prefix 45K → ~12-15K tokens |
| 3 | **Lower brief timeout 25s → 12s** — brief is best-effort; tool-layer gate at L760-804 is the recovery. | `runner-native.ts:712-713` | S | worst-case brief wait 25s → 12s on slow endpoints |
| 4 | **Tier-aware `maxIterations`** — trivial=4, simple=8, multi=14, complex=24, enterprise=32 (keyed off classifier output). | `runner-native.ts:278, 1793` | S | bounds worst-case turn wall-clock per tier; trivial tier can't spiral |
| 5 | **Tier-aware `maxCritiqueIterations`** — trivial=0, simple=1, multi/complex/enterprise=2. | `runner-native.ts:2520` | S | belt-and-suspenders on shouldRunCritics gate; bounds fix-turn cost |
| 6 | **Lower `DELTA_MIN_SHAPES` 60 → 20** — delta snapshot kicks in earlier on follow-up turns. | `runner-native.ts:1540` | S | simple-tier follow-up turns save 2-5K tokens of snapshot |
| 7 | **Drop the legacy 8s net for z.ai rate-limit-shaped failures** — 20s+45s backoff tier already handled that; 8s sleep is redundant. | `runner-native.ts:2213` | S | removes 8s of dead time on z.ai rate-limited turns |
| 8 | **Skip VLM critic client-screenshot round-trip for ≤20-shape canvases** — go straight to resvg (now child-process isolated). | `design-critic-vlm.ts:140-146` | S | saves 3s per critic dispatch on small canvases |
| 9 | **Lower classifier LLM-fallback retry budget** — `maxRetries: 3, baseDelayMs: 3000` → `maxRetries: 1, baseDelayMs: 1500`. | `classifier.ts:321` | S | worst-case ambiguous-prompt TTFT 18s → ~5s |
| 10 | **Run `scripts/measure-tool-cost.ts` + checkin the JSON** — empirically ground per-tool token budget for data-driven future decisions. | `scripts/measure-tool-cost.ts` | S | enables data-driven tool deprecation decisions |

**ICE rationale:** Items 1-2 together attack the **7.6s pre-event dead zone** (dominant TTFT sink) from two angles — item 1 deletes brief sub-agent's wall-clock, item 2 shrinks static prefix that drives prefill. Combined, they should drop trivial-tier TTFT from 10.6s → ~2-3s, hitting industry trivial target (≤1s is aggressive; ≤3s is realistic given z.ai sandbox endpoint's baseline latency). Items 3-9 are small-surface-area changes that compound. Item 10 is observability — doesn't speed anything up today, but unlocks data-driven decisions for the next round.
