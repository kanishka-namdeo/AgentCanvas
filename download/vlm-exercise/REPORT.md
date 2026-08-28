# VLM-Driven Agent Tools & Prompts Optimization — Exercise Report

Date: 2026-08-27 → 2026-08-28 · Harness: `scripts/vlm-inspect/` · Results: `download/vlm-exercise/{baseline,after,after2,perf-pass,final}/`

## 1. Methodology

The agent was driven through the REAL UI (browser automation through the Caddy gateway, so the
socket.io path is exercised) across a scenario matrix deliberately distinct from the eval-suite
prompts (no teaching-to-the-test):

- **4 one-shot scenarios** (generation quality): hero section, profile card, kanban board, bar chart.
- **3 multi-shot scenarios** × 3 turns (editing fidelity, preservation, refinement): navbar, pricing
  cards, settings panel — 13 turns total.
- Every agent event was captured by an in-process socket tap (`tap-events/*.jsonl`); the canvas is
  cleared per scenario (shared-canvas model); turn end is detected from `agent:turn_end` (the Stop
  button disappears during the mandatory critique loop and cannot be trusted).
- Each turn's final canvas was scored by an **external VLM** (no code shared with the app's in-loop
  design-critic) against an 8-dimension rubric + defect/missing/regression lists.
- Baseline was captured BEFORE any fix; `after1` after fixes 1–5; `after2` after fixes 6–7.

## 2. Root causes found (with evidence)

| # | Root cause | Evidence |
|---|-----------|----------|
| 1 | **L4 culling paint-clipped overflowing children.** `content-visibility: auto` inherently applies `contain: paint`; every container got it, so children outside a frame's box were clipped even without `clip: true` (breaks Figma overflow-visible semantics). | Nav links / Sign Up label / Email field / Save-Cancel buttons present in DOM AND document but painting nothing (pixel-sampled pure white); VLM reported them "missing". |
| 2 | **Text nodes defaulted to the 100×100 placeholder.** No text measurement exists in the resolver; `normalizeToNode` filled 100 into every text lacking explicit size. | All baseline text shapes `h=100`; 100px gaps between labels; children pushed past container bounds (which then hit bug #1). |
| 3 | **Layout-direction spellings were case-sensitive.** `autoLayout.direction: 'VERTICAL'` never matched the resolver's `=== 'vertical'` checks → children stacked at the parent origin. | `after2` ms-pricing t2: Starter/Team cards' children ALL resolved to the card's origin (100,100); t1's card (lowercase 'vertical') laid out fine. |
| 4 | **Classifier keyword false-positives.** Substring matching: "Ac**count**" matched inspect's `count`, "rea**list**ic" matched `list`; quoted labels ("'Save Changes'") matched export's `save`. | "Create an 'Account Settings' panel…" routed to **inspect** (0.50) — a read-only skill for a create op. |
| 5 | **No retry when the fallback itself failed.** Pinggy primary down → preflight swaps to glm-5.3 sandbox → sandbox rate-limited returns empty → turn dies with 0 tool calls. | 3 empty baseline turns; dev.log shows the exact chain. |
| 6 | **Cold-tunnel preflight failures cached 60s.** The 4s single-attempt GET /models fails on cold pinggy connects while the endpoint is actually alive; the cached 'down' poisons the next turn. | Probes succeeded while the app kept serving cached 'down' → empty turns that would have worked. |
| 7 | **Text width estimate too tight** (0.55 × fontSize × chars): digit/cap-heavy strings clipped ("$12"→"$1", "Team"→"Tea"). | `after1` ms-pricing t2/t3 missing-element reports; patch dump showed model omitted widths. |

Secondary observations (not fixed, LLM-behavior): zoom-to-fit shrinking real content when the agent
creates oversized empty frames (os-hero runs); duplicate elements when the agent re-creates instead
of updates (ms-pricing t3); tool-call counts vary 5–82 per identical prompt across runs.

## 3. Fixes implemented (7)

| # | Fix | Files |
|---|-----|-------|
| 1 | Overflow-aware culling gate: skip `content-visibility: auto` when direct children escape a non-clip container's box | `src/components/canvas/dom/styleFor.ts`, `DomNode.tsx` |
| 2 | fontSize-based text size estimation (0.62 × chars + slack / 1.35 × lines); patch normalizer no longer fills 100×100 into text nodes | `src/lib/pen/resolve.ts`, `src/lib/canvas/patch.ts` |
| 3 | `container_overflow` resolver warning (agent-visible via pen_get_metadata + per-turn snapshot) naming the escapee and the fix | `src/lib/pen/resolve.ts` |
| 4 | Classifier: strip quoted labels, start-word-boundary keyword matching, creation nouns added to wireframe keywords; system prompt gains CONTAINER SIZING + BATCH CONSTRUCTION rules; tool descriptions updated | `src/lib/agent/classifier.ts`, `skills/registry.ts`, `runner-legacy.ts`, `tools.ts` |
| 5 | Empty-response retry on the already-fallen-back model (8s backoff, one retry, same bound) | `src/lib/agent/runner-native.ts` |
| 6 | Preflight retry (4s then 8s) + asymmetric cache TTL (ok 60s / down 20s) | `src/lib/agent/pi-ai-model-resolver.ts` |
| 7 | Layout-direction normalization at BOTH write and read time ('VERTICAL'/'row'/'column' → canonical) | `src/lib/canvas/patch.ts`, `src/lib/pen/resolve.ts` |

All 1623 unit tests pass; typecheck clean.

## 4. Results

| Pass | Mean overall | Defects | Notes |
|------|-------------|---------|-------|
| baseline | **4.92**/10 | 50 | 12 high-severity prompt_fidelity (missing elements) |
| after1 (fixes 1–5) | **6.46**/10 | 45 | Clipping-bug scenarios transformed (navbar 3→7 ×3) |
| after2 (fixes 1–7) | **5.44**/10 | 42 | Full re-run incl. late fixes; see variance note |
| **final (perf + todo-batch + variants, 14 turns)** | **6.02**/10 | 47 | All 3 optimization tasks shipped; per-scenario table below |

**Dimension means (baseline → after2 → final):** prompt_fidelity 5.00 → 5.77 → **6.86** · typography
4.54 → 6.38 → **6.71** · color_cohesion 6.38 → 7.62 → **7.07** · spacing 5.00 → 5.92 → **5.64** ·
component_polish 4.38 → 5.08 → **5.93**.

**Per-scenario comparison (mean overall where multi-turn):**

| scenario | baseline | after1 | after2 | final |
|----------|---------:|-------:|-------:|------:|
| os-hero | 3 | 2 | 5.75 | **6** |
| os-profile | 6 | 7 | 9 | 7.75 |
| os-kanban | 8 | 8 | 3 | **2** ← regression (oversized board → 26% zoom → illegible text) |
| os-barchart | 5 | 6 | 3 | **8** |
| ms-navbar (3 turns) | 3 | 5.7 | — | **5.8** |
| ms-pricing (3 turns) | 6.3 | 6 | 2 | 5.0 (t1 **8**; t2/t3 row-overflow regression) |
| ms-settings (3 turns) | 4.7 | 7.3 | — | 6.7 |
| smoke-variants | — | — | — | **8** (variant generator, 0 missing elements) |

**Deterministic verifications (not subject to LLM variance):**
- Navbar repro: nav links went from DOM-present-but-invisible to **pixel-verified visible** (0 → 437 dark pixels).
- Classifier: 4 misroutes → 0 (all 10 scenario prompts route correctly; tested standalone).
- `container_overflow` warning fires for fixed-height overflow, not for `fit_content` (unit-verified).
- Pricing-card repro: children stacked at origin → correctly flowed after fix 7.
- Fallback retry + preflight retry paths observed firing in dev.log during live runs.

**Variance caveat (important):** single-run VLM scores swing ±1.5 points for the SAME prompt
(os-kanban 8 baseline vs 3 after2; ms-pricing t1 4 → 7 → 2). The mean is therefore a weak instrument;
the per-defect-class analysis above and the deterministic verifications are the load-bearing results.
This mirrors the earlier eval-methodology critique: repeat-run variance reporting is required for any
future scoring (the harness now supports this via `--repeats`).

**Round-trip tax:** total tool calls baseline 400 → after1 381 → after2 415 → **final 348** across 13
comparable turns (13% below baseline) — and the composition is healthier: `pen_get_metadata` read-backs
down to 22 total, batch tools (`pen_bulk_update_by_filter`, `pen_update_node` multi-patch) carrying more
of the load. The batch tool + prompt rules give the agent the means; they do not compel it.

### 4.1 Optimization task 1 — todo-plugin bookkeeping noise (target: <15% of calls)

**Result: 0.9% (3 todo calls of 348)** vs 1.5% baseline / 3.7% after1. The todo plugin now fires only
for gated tasks (5+ steps, 10+ calls), accepts a BATCH of status transitions in one call, auto-advances
WIP=1, and returns the full list on every mutation (no read-backs). Edit turns are dramatically leaner:
ms-navbar t2 7 tools/129s, t3 6 tools/48s (baseline t2 78→497s-class behavior lives on in ms-pricing t2
at 34 tools — still model-dependent, but the bookkeeping tax is gone).

### 4.2 Optimization task 2 — multi-variant parallel generation (R1 pattern 9)

Deployed as `pen_generate_variants` (runner-native detection → 3 staggered-parallel spec generations →
off-canvas renders → VLM judge → winner applied with id-manifest). Fired in **6 of 14 turns** (all the
ambiguous-creation ones: hero, profile, barchart, pricing t1, settings t1, smoke-variants — and correctly
NOT for kanban/navbar where the prompt pins structure). smoke-variants scored **8/10 with 0 missing
elements** — the best first-shot pricing-page result of any pass.

Live-fire findings that shaped the implementation (kimi-k2-5 through a single SSH tunnel):
- **Schema non-adherence**: the model invents its own JSON ontology despite a strict example — fixed by
  a 3-layer defense: prompt few-shot + `coerceNodeTree` salvage (wraps `ui_components`/`sections`
  arrays, degrades invented node types, drops descriptor fields) + a bounded format-repair round-trip
  (the model reliably converts existing content to a given format).
- **Transport starvation**: un-staggered parallel big generations starve each other past ~110s — fixed
  by 15s staggered launches + a sequential retry wave on the empty wire.
- **Retry multiplication**: per-call 300s client timeout × callLLMWithRetry attempts × retry wave ×
  repairs stalled ONE tool call past **19 minutes** (canvas silently empty, UI spinning). Fixed with a
  **300s wall-clock budget** across the whole dispatch — every phase (generation waves, repair, judge)
  races the deadline; exhaustion degrades to heuristic judging or the pen_create_subtree fallback.
  Unit-tested with hanging-LLM mocks: dispatch now returns in 1.20s against a 1.2s budget.
- **Stale server module**: a dev-server restart was required — the dynamic `import()` of the variant
  module was cached from before the fix (operational note, not a code bug).

## 5. Remaining weaknesses (future work)

1. **Oversized-canvas zoom regression (os-kanban 8→2)** — the agent built the board at dimensions so
   large the viewport fit at **26% zoom**, making every label illegible to the VLM (correctly
   penalized). Same family as the old zoom-to-fit finding, now the dominant kanban failure mode.
   Candidate: reveal fits NON-EMPTY content bounds; agent prompt rule capping screen-frame dimensions.
2. **Row-of-cards overflow (ms-pricing t2/t3)** — "three cards side by side" produced a row wider than
   the canvas: Team card clipped off-screen, no Popular badge, truncated feature text. Candidate:
   resolver warning when a subtree exceeds viewport width; prompt rule to compute card width from
   count and canvas width.
3. **Zoom-to-fit vs oversized empty frames** — when the agent creates a huge frame with small content, reveal fits the frame and shrinks the content to illegibility. Candidate: fit to NON-EMPTY content bounds, or teach the agent fit_content on hero/screen frames.
4. **Re-create instead of update** — the agent sometimes rebuilds a component ("Pro Pricing Card New") leaving duplicates. Candidate: patch-op diffing or stronger prompt guidance on targeted updates.
5. **Self-critique loop runtime** — the mandatory loop can double turn duration (os-kanban 19 min); worth bounding by wall clock.
6. **Eval noise** — adopt `--repeats=N` with variance reporting as the default acceptance gate.

## 6. Reproduction

```bash
# scenario matrix (one turn per invocation; resumable)
bun scripts/vlm-inspect/run-scenarios.ts download/vlm-exercise/<pass> [--scenario=<id>|--redo=<id>:<n>]
# VLM critique (external; needs z.ai sandbox; --only=<id> retries rate-limited turns,
# then merge from disk: bun scripts/vlm-inspect/merge-critiques.ts <pass>)
bun scripts/vlm-inspect/vlm-critique.ts download/vlm-exercise/<pass>
# transcript analysis (tool-call histograms, todo-call share, cross-run comparison)
bun scripts/vlm-inspect/analyze-transcripts.ts download/vlm-exercise/<pass>
bun scripts/vlm-inspect/analyze-final.ts
# deterministic unit checks
bun scripts/vlm-inspect/test-classifier.ts && bun scripts/vlm-inspect/test-overflow-warning.ts
```
