# 09 — Benchmark Suite

> **Scope:** The permanent benchmark harness for tracking speed-parity progress. Every code change must show a before/after table from this harness; CI runs the bench on every PR to `main`.

---

## The benchmark harness

### `scripts/speed-bench/run.ts` — the primary speed benchmark

**Location:** `/home/z/my-project/scripts/speed-bench/run.ts`
**Entry point:** `bun scripts/speed-bench/run.ts [options]`

**Options:**

| Flag | Default | Description |
|---|---|---|
| `--provider=<id>` | `DEFAULT_SETTINGS.llmProvider` | LLM provider (`zai`, `custom`, `anthropic`, `openai`, etc.) |
| `--thinking=<level>` | `DEFAULT_SETTINGS.thinkingLevel` | Thinking level (`off|minimal|low|medium|high|xhigh|max`) |
| `--only=id1,id2` | all | Run only the named scenarios |
| `--out=<dir>` | `results/speed-bench` | Output directory for JSON + markdown reports |
| `--repeats=N` | 1 | Run each scenario N times for variance measurement |
| `--delay=S` | 10 | Cooldown between scenarios (seconds) |

**Scenarios:** 11 prompts across 5 complexity tiers, defined in the `SCENARIOS` constant in `run.ts`:

| ID | Tier | Prompt (abbreviated) |
|---|---|---|
| `trivial-shape` | trivial | Draw a red rounded rectangle, 240x120 |
| `trivial-heading` | trivial | Add a bold heading 'Quarterly Report' at 32px |
| `simple-login` | simple | Mobile login screen for fintech app 'Vaultly' |
| `simple-pricing` | simple | 3 plan cards: Starter $9, Pro $29 highlighted, Enterprise $99 |
| `simple-settings` | simple | Account settings: avatar, name, email, timezone, Save/Cancel |
| `multi-dashboard` | multi | Analytics dashboard header + 4 KPI cards |
| `multi-kanban` | multi | Kanban board: 3 columns × 2 task cards |
| `multi-chart` | multi | Analytics chart panel with bar+line combo |
| `complex-landing` | complex | Marketing landing page: nav + hero + features + testimonials + pricing + footer |
| `complex-ecommerce` | complex | E-commerce category page: filter sidebar + 4×2 product grid + sticky header + pagination |
| `flow-onboarding` | flow | 3-screen mobile onboarding flow side-by-side |

**Per-scenario metrics captured:**

| Metric | Definition |
|---|---|
| `ttftMs` | Time to first `agent:tool_call_start` event (closest proxy to "time to first design pixel") |
| `t2fpMs` | Time to first `patch` event (canvas mutation applied) |
| `t2cMs` | Time to `agent:turn_end` event (or stream close with patches) |
| `toolCallCount` | Number of unique tool calls (tool_call_start + tool_call_end / 2) |
| `patchCount` | Number of canvas patches |
| `errorEvents` | Soft errors (agent:error, agent:turn_cancelled, agent:stuck) |
| `modelUsed` | Model name from `agent:model_info` |
| `usedFallback` | Whether z.ai sandbox swap fired |
| `finalLayerCount` | Number of shapes on canvas at turn end |
| `status` | `complete` / `error` / `timeout` |

**Outputs:**

1. **`<out>/bench.log`** — human-readable progress + summary table printed during the run.
2. **`<out>/speed-bench-<timestamp>.json`** — structured per-run + per-tier aggregates.
3. **`<out>/speed-bench-<timestamp>.md`** — markdown summary table for easy diff in PRs.

### `scripts/speed-bench/probe-api-events.ts` — event-stream inspector

**Location:** `/home/z/my-project/scripts/speed-bench/probe-api-events.ts`
**Entry point:** `bun scripts/speed-bench/probe-api-events.ts "<prompt>"`

Dumps one agent turn's event-type sequence with timestamps. Use to diagnose specific bottlenecks (e.g. "where did the 7.6s pre-event dead zone come from?").

**Output:**

```
+    30ms  ev#1  type=agent_event inner.type=agent:message_start
+ 7675ms  ev#3  type=agent_event inner.type=agent:model_info
...
total events: 123  in 12421ms
histogram:
  agent_event                              122
  patch                                    1
```

### `scripts/speed-bench/start-detached.sh` — orphan-safe launcher

**Location:** `/home/z/my-project/scripts/speed-bench/start-detached.sh`
**Entry point:** `bash scripts/speed-bench/start-detached.sh "<bench args>" <out-dir>`

Launches the bench detached (orphan-to-PID-1 pattern, like `scripts/start-dev.sh`) so it survives between tool calls. The bench can take 10-30 minutes for a full run; without this wrapper, the host kills the bench process at the end of each tool call.

### `scripts/measure-tool-cost.ts` — token cost estimator

**Location:** `/home/z/my-project/scripts/measure-tool-cost.ts`
**Entry point:** `bun scripts/measure-tool-cost.ts`

Builds the full tool registry, converts via `toolsToOpenAISpec`, JSON-stringifies, reports `length/4` as token estimate. Per-tool breakdown sorted by token cost (biggest first) — surfaces which tools dominate the per-iteration schema budget.

After tier-allowlist changes, re-run with each tier's allowlist to measure actual token savings per tier. Checkin output to `download/speed-bench/tool-cost-by-tier.json`.

### `scripts/dom-renderer-bench/run.ts` — DOM renderer latency bench

**Location:** `/home/z/my-project/scripts/dom-renderer-bench/run.ts`
**Entry point:** `bun run scripts/dom-renderer-bench/run.ts [--ci] [--corpus=small|medium|large|all] [--no-headless]`

Benchmarks the DOM renderer in isolation (Playwright-driven). Standard corpora: small (50/1), medium (200/2 or 1000/4), large (1000/4 or 5000/20), xl (5000/20 or 20000/80). Reports per-corpus `CorpusMetrics` (pan/zoom stats, patch latency stats, bulk_add commit count) + a `GateResult` (pass/fail + violation list).

Gates:

- `p95Frame ≤ 16ms` (pan/zoom at ≥1000 nodes)
- `p95Patch ≤ 16ms` (single-update patch-to-paint)
- `bulkAddCommits ≤ 3` (500-node bulk_add React commits)
- `panFrameGateMinNodes = 1000` (gate enforced only on real workloads)

This benchmarks the renderer, NOT the agent loop. Use it to isolate canvas-paint latency from LLM latency.

### `scripts/vlm-inspect/run-scenarios.ts` — VLM quality critic

**Location:** `/home/z/my-project/scripts/vlm-inspect/run-scenarios.ts`
**Entry point:** `MAX_WAIT=560 timeout 580 bun scripts/vlm-inspect/run-scenarios.ts <outDir> [--scenario=os-hero] [--redo=os-hero:2]`

Live browser-driven VLM inspection of agent turns. ONE TURN PER INVOCATION (sandbox reaps background processes between tool calls). Resumable: writes `inFlight` manifest entry on timeout, re-invoked with `--redo` flag.

8-dimension rubric: prompt_fidelity, layout_structure, spacing_consistency, typography, color_cohesion, component_polish, cleanliness, overall_polish.

Aggregates into `summary.json` + `summary.md` (dimension means, defect histogram, missing elements, regressions, top fixes).

This is the QUALITY gate — speed changes must not regress the VLM-critic mean overall score (≥ 6.0 baseline).

---

## CI integration

### Pre-merge gate (PR to `main`)

Every PR that touches the agent loop, runner, tools, subagents, or canvas patch layer must include:

1. **Speed bench before/after table** — appended to the PR description as a markdown table.
2. **`scripts/measure-tool-cost.ts` output** — if tool schemas changed.
3. **`scripts/dom-renderer-bench/run.ts --ci`** — if canvas / patch / store changed.
4. **`scripts/vlm-inspect/run-scenarios.ts` on at least 3 representative scenarios** — if agent behaviors changed.

The PR is blocked from merge if:

- Speed bench TTFT regresses by > 20% on any tier.
- VLM-critic mean overall regresses below 6.0 on any scenario.
- DOM-renderer bench gates fail.

### Nightly regression bench

A nightly CI job runs the full speed bench + 14-turn VLM matrix on `main`:

```bash
bun scripts/speed-bench/run.ts \
  --provider=zai \
  --thinking=low \
  --out=download/speed-bench/nightly-$(date +%Y-%m-%d)

MAX_WAIT=560 timeout 580 bun scripts/vlm-inspect/run-scenarios.ts \
  download/vlm-exercise/nightly-$(date +%Y-%m-%d)
```

Results are archived in `download/speed-bench/nightly-<date>/` and `download/vlm-exercise/nightly-<date>/`. A trend chart (TTFT p50 by tier over time) is generated and committed to `download/speed-bench/trend.md`.

---

## How to add a new scenario

1. **Add to `SCENARIOS` in `scripts/speed-bench/run.ts`:**

```ts
{
  id: 'my-new-scenario',
  tier: 'multi', // trivial | simple | multi | complex | flow
  prompt: 'Design a ...',
  // optional seed: a non-empty CanvasDocument for follow-up-turn scenarios
},
```

2. **Run the bench** with `--only=my-new-scenario --repeats=3` to validate.

3. **Check in the scenario** with a comment explaining what complexity tier it represents and why it's a useful signal.

4. **Update the spec docs** (`02-baseline-benchmarks.md` if it's a baseline scenario; `03-industry-parity-targets.md` if it maps to an industry parity tier).

---

## How to add a new metric

1. **Extend `ScenarioMetrics` interface** in `scripts/speed-bench/run.ts`.

2. **Detect the metric in the event-stream loop.** Most metrics can be derived from `agent_event` inner types — see the existing detection logic at L240-265.

3. **Add to the per-tier aggregate** in `tierAgg` (L328-345).

4. **Add to the markdown summary table** in the output writer (L390-420).

5. **Update `02-baseline-benchmarks.md`** with the new metric's definition and what it tells you.

---

## Reproducibility notes

- **Non-determinism:** The agent runs at temperature 0.6 (production default). Single-run numbers are noisy. For any signal that drives a decision, use `--repeats=3` minimum. The eval-harness convention is `--repeats=5` for final validation.

- **Provider variability:** The z.ai sandbox provider has its own latency profile. For provider-agnostic signal, run with `--provider=custom` (BETA endpoint preset) — but per the AGENTS.md `LLM Endpoint Access Policy`, never invoke the BETA endpoint directly outside the app.

- **First-run warm-up:** The first scenario in a bench run pays the cold-cache compile cost (Next.js Turbopack). Subsequent scenarios hit the warm cache. To eliminate this from cross-scenario comparisons, add a warm-up scenario at the top of the bench (e.g. the `trivial-shape` scenario is already the first one — it absorbs the warm-up cost).

- **Wall-clock includes everything:** The bench measures real wall-clock: LLM streaming, tool execution, patch application, client round-trips, fallback ladder retries. It does NOT isolate model latency from agent-loop overhead. To isolate, use `probe-api-events.ts` and read the event timeline.

---

## What's missing from the current harness (future work)

1. **VLM-critic mode toggle** — currently the bench runs with `designCritiqueMode='manual'` (production default). Need a flag to force `EVAL_CRITIQUES=2` to measure critique-loop cost on complex tier.

2. **Multi-turn continuity bench** — `scripts/e2e-design-scenarios.ts` exists but isn't integrated into the speed-bench harness. Need to add multi-turn scenarios that measure per-turn TTFT + T2C across a 5-turn refinement sequence.

3. **Cross-provider comparison** — currently only `zai` provider is benched. Need to run with `--provider=custom` (BETA endpoint) + `--provider=anthropic` (Claude) to isolate provider-side latency.

4. **Trend dashboard** — the nightly CI job generates JSON results but doesn't yet render a trend chart. Need a `scripts/speed-bench/render-trend.ts` that aggregates nightly JSONs into a markdown chart.

5. **A/B comparison helper** — currently before/after comparison is manual. Need a `scripts/speed-bench/compare.ts <before-dir> <after-dir>` that diffs two bench runs and prints the deltas.

These are tracked as future work; the P0 spec changes don't depend on them.
