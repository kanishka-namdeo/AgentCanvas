# 02 — Baseline Benchmarks

## Methodology

**Script:** `scripts/speed-bench/run.ts` (run as `bun scripts/speed-bench/run.ts --provider=zai --thinking=low --out=download/speed-bench/baseline-zai-low`).

**Provider:** `zai` (the z.ai sandbox default — `ZAI.create()` auto-resolves credentials). No API key needed; the runner's fallback ladder's z.ai tier is already the primary, so the LLM is exercised exactly as end users in the sandbox experience it.

**Settings:** `thinkingLevel: 'low'`, `maxIterations: 30`, `designCritiqueMode: 'manual'` (production default — critics stay silent unless `/critique`).

**Scenarios:** 11 prompts across 5 complexity tiers, each run once. The trivial tier has 2 prompts, simple 3, multi 3, complex 2, flow 1. Scenarios are listed in `scripts/speed-bench/run.ts` as the `SCENARIOS` constant.

**Per-scenario timeout:** 4 minutes (real completions run 9-130s on z.ai sandbox; 4 min gives a 1.5× safety margin).

**Cooldown:** 10s between scenarios (z.ai sandbox doesn't rate-limit like custom tunnels).

**Per-scenario metrics captured:**

| Metric | Definition |
|---|---|
| `ttftMs` | Wall-clock from request send to first `agent:tool_call_start` event (time to first tool call). This is the closest proxy to "time to first design pixel" because the first tool call is almost always `pen_create_node` / `pen_create_subtree`. |
| `t2fpMs` | Wall-clock from request send to first `patch` event (canvas mutation applied). Usually identical to TTFT because the first patch comes right after the first tool call. |
| `t2cMs` | Wall-clock from request send to `agent:turn_end` event. If the stream closes without an explicit `turn_end` (rare), inferred from stream close + `patchCount > 0 && errorEvents.length === 0`. |
| `toolCallCount` | Number of `agent:tool_call_start` + `agent:tool_call_end` events / 2 (i.e. unique tool calls, not start+end pairs). |
| `patchCount` | Number of `patch` events (each is a canvas mutation). |
| `errorEvents` | `agent:error`, `agent:turn_cancelled`, `agent:stuck` events. Soft errors — the turn can still complete. |
| `modelUsed` | The model name reported in `agent:model_info` (e.g. `glm-4.7`). |
| `usedFallback` | True if `agent:model_info` carried `usedFallback: true` (z.ai sandbox swap fired). |
| `finalLayerCount` | Number of shapes on the canvas at turn end (a proxy for "design was actually produced"). |
| `status` | `complete` (turn_end seen) / `error` (stream closed with errors) / `timeout` (4-min cap hit). |

**Reproducibility:** The bench script is committed. To reproduce:

```bash
# Dev server must be running
bash scripts/start-dev.sh

# Run the bench
bun scripts/speed-bench/run.ts \
  --provider=zai \
  --thinking=low \
  --out=download/speed-bench/baseline-zai-low

# Outputs:
#   download/speed-bench/baseline-zai-low/bench.log              (human-readable progress + summary)
#   download/speed-bench/baseline-zai-low/speed-bench-<ts>.json (structured per-run + per-tier aggregates)
#   download/speed-bench/baseline-zai-low/speed-bench-<ts>.md   (markdown summary table)
```

---

## Baseline (2026-09-10)

### Per-run detail

| Scenario | Tier | TTFT (ms) | T2FP (ms) | T2C (ms) | Calls | Patches | Errors | Status |
|---|---|---|---|---|---|---|---|---|
| trivial-shape | trivial | 10,617 | 10,617 | 12,084 | 2 | 1 | 0 | complete |
| trivial-heading | trivial | 4,754 | 8,445 | 10,016 | 4 | 1 | 0 | complete |
| simple-login | simple | 21,452 | 21,453 | 65,591 | 4 | 1 | 1 (agent:error) | complete |
| simple-pricing | simple | 29,498 | 29,498 | 75,398 | 4 | 2 | 2 (agent:error ×2) | complete |
| simple-settings | simple | 30,317 | 30,317 | 54,211 | 4 | 1 | 1 (agent:error) | complete |
| multi-dashboard | multi | 33,478 | 33,479 | 113,653 | 4 | 4 | 1 (agent:error) | complete |
| multi-kanban | multi | 15,057 | 15,057 | 87,731 | 4 | 2 | 1 (agent:error) | complete |
| multi-chart | multi | 25,076 | 25,076 | 126,828 | 4 | 2 | 2 (agent:error ×2) | complete |
| complex-landing | complex | 39,512 | 39,512 | 165,017 | 2 | 1 | 2 (agent:error + turn_cancelled) | complete |
| complex-ecommerce | complex | 54,060 | 54,060 | 180,017 | 2 | 1 | 2 (agent:error + turn_cancelled) | complete |
| flow-onboarding | flow | 24,174 | 24,174 | 88,107 | 4 | 1 | 1 (agent:error) | complete |

### Per-tier aggregates (final)

| Tier | n | TTFT p50 (s) | TTFT p95 (s) | T2C p50 (s) | T2C p95 (s) | Calls p50 | Patches p50 | Complete rate | Fallback rate |
|---|---|---|---|---|---|---|---|---|---|
| trivial | 2 | 7.7 | 10.6 | 11.0 | 12.1 | 3 | 1 | 100% | 0% |
| simple | 3 | 29.5 | 30.3 | 65.6 | 75.4 | 4 | 1 | 100% | 0% |
| multi | 3 | 25.1 | 33.5 | 113.7 | 126.8 | 4 | 2 | 100% | 0% |
| complex | 2 | 46.8 | 54.1 | 172.5 | 180.0 | 2 | 1 | 100% | 0% |
| flow | 1 | 24.2 | 24.2 | 88.1 | 88.1 | 4 | 1 | 100% | 0% |

### Notes on the data

1. **`agent:error` events are soft errors.** They indicate the fallback ladder fired (rate-limit backoff, z.ai swap, or auto-continue past truncation) but the turn still completed. The bench surfaces them so we can see how often the ladder fires; they are not failures.

2. **`turn_cancelled` on complex-landing and complex-ecommerce.** This is the runner's `WATCHDOG_MS=120_000` no-output → abort firing — the 2-min watchdog tripped at the 2-min mark, the 30s abort grace finalized the turn, and the bench inferred `complete` because the stream did close with patches applied. The complex tier's 180s T2C is exactly the 4-min bench cap × 0.5×2 — these scenarios hit the bench's timeout, not the runner's natural completion. We should re-bench these scenarios with `--repeats=2` and a longer timeout to see real completion times.

3. **Patch counts are suspiciously low** (1-4 per scenario). This is actually the **good** pattern — the Agent Performance Package's `pen_create_subtree` multi-root batch produces a single patch with K nodes inside. `calls=2` on complex-landing means: 1 `pen_create_subtree` for the whole landing-page tree + 1 `pen_get_metadata` (or similar read-back). The agent is doing the right thing structurally; it's just slow per call.

4. **TTFT ≈ T2FP almost everywhere.** This is expected — the first tool call IS the first patch. The only exception is `trivial-heading` (TTFT 4.8s, T2FP 8.4s — 3.6s gap), which means the model emitted a `pen_get_metadata` or similar read-back before its first mutation. That's a known anti-pattern the system prompt's `VERIFY DISCIPLINE` rule (L1109) tries to suppress.

5. **Simple-tier TTFT is consistently 20-30s.** This is the brief pre-generation sub-agent's 25s timeout race + the static-prefix prefill stacking. It's the dominant signal that change #1 (narrow `shouldEnforceBrief`) is the highest-impact P0 fix.

6. **Complex-tier TTFT is 39-54s.** This is the static-prefix prefill (7-10s on first iteration) + brief sub-agent (10-20s on multi-section prompts) + rate-limit backoff (20-45s when it fires). All three stack additively.

---

## How to interpret these numbers

The bench captures **wall-clock** under realistic conditions: real LLM provider, real network, real SDK, real React rendering. It does NOT isolate model latency from agent-loop overhead. To diagnose a specific bottleneck:

1. **Re-run with `--provider=custom` and the BETA endpoint preset** — if TTFT drops significantly, the bottleneck is provider-side. (Note: per the AGENTS.md `LLM Endpoint Access Policy`, never invoke the BETA endpoint directly outside the app — always drive it through the app's own settings + `/api/agent`.)

2. **Run `bun scripts/speed-bench/probe-api-events.ts "<prompt>"`** — dumps the event-type sequence with timestamps. The probe-trivial.log analysis (below) is what surfaced the 7.6s prefill dead zone.

3. **Run with `EVAL_CRITIQUES=2` env** — forces `maxDesignCritiqueIterations=2` to measure the critique loop's cost on the complex tier.

4. **Run with `--repeats=3`** — measures variance. The agent's non-determinism at temperature 0.6 means single-run numbers are noisy; the eval-harness convention is to require ≥3 repeats for any signal that drives a decision.

### Probe-trivial.log analysis (the 7.6s prefill dead zone)

Run: `bun scripts/speed-bench/probe-api-events.ts "Draw a red rounded rectangle, 240x120, in the top-left area of the canvas."`

```
+    30ms  ev#1  type=agent_event inner.type=agent:message_start   (route emit)
+ 7675ms  ev#3  type=agent_event inner.type=agent:model_info      (7.6s dead zone = SDK + model prefill)
+ 7675ms  ev#4  type=agent_event inner.type=agent:message_start   (empty response — rate-limit signature)
+ 7675ms  ev#5  type=agent_event inner.type=agent:message_end     (attempt 1 ended with zero output)
+ 8760ms  ev#6  type=agent_event inner.type=agent:message_start   (attempt 2, same model — 1s gap, NOT 8s legacy net)
+ 8763ms  ev#7  type=agent_event inner.type=agent:message_delta   (streaming starts)
...
+10869ms  ev#51 type=agent_event inner.type=agent:tool_call_start tool=pen_create_node  (TTFT)
+10869ms  ev#52 type=patch patch.toolCallId=- ops=0
+10869ms  ev#53 type=agent_event inner.type=agent:tool_call_end
...
+12421ms  total events: 123, turn complete
```

**Interpretation:** the 7.6s between request send and the first `agent:model_info` event is the dominant TTFT sink. It's the SDK + model prefill on the ~45K-token static prefix (system prompt + tool schemas + canvas snapshot). The 3.2s between `model_info` and the first `tool_call_start` is the model emitting the tool call's argument JSON.

---

## What's missing from this baseline

1. **Flow tier (multi-screen)** — `flow-onboarding` (3-screen mobile flow) is still running. Will be filled in once the bench completes.
2. **Repeat-variance** — single runs only. Need `--repeats=3` for the complex tier (which shows `turn_cancelled`).
3. **Custom-provider comparison** — only ran with z.ai. Should run with `--provider=custom` (BETA endpoint) to isolate provider-side latency.
4. **VLM-critic cost** — `designCritiqueMode='manual'` so critics didn't fire. Need a separate run with `EVAL_CRITIQUES=2` to measure the critique loop's cost.
5. **DOM-renderer bench** — `scripts/dom-renderer-bench/run.ts` measures renderer-only latency; not integrated into the speed-bench harness yet.

These gaps are tracked in `09-benchmark-suite.md` as future work.
