# AgentCanvas Speed Parity Spec

**Goal:** Bring pi-agent's design generation speed to industry parity across all complexity tiers (trivial → enterprise design systems), without compromising design quality.

**Status:** Spec / RFC — 2026-09-10
**Owner:** AgentCanvas team
**Tracking:** All changes documented in this directory; benchmarks in `download/speed-bench/`; commits land on `main` per milestone.

---

## Why this spec exists

Live baseline measurement (2026-09-10, z.ai sandbox provider, thinking=low) showed pi-agent is **5-10× slower than industry parity on time-to-first-token (TTFT)** and **2-4× slower on time-to-completion (T2C)** across all complexity tiers. The call-count budget is already within industry norms — the gap is wall-clock, not tool-call efficiency.

The cost centers are concentrated, not diffuse:

| Cost center | Share of trivial-tier TTFT | Share of complex-tier T2C |
|---|---|---|
| LLM prefill on the ~45K-token static prefix (system prompt + tool schemas + canvas snapshot) | ~70% | ~30% |
| Brief pre-generation sub-agent race (25s timeout) | ~25% | ~10% |
| Rate-limit backoff (20s + 45s) on first-attempt empty responses | ~5% | ~15% |
| Critique-loop fix-turns (1-2 iterations × 30-180s) | 0% (manual mode) | ~30% |
| Sub-agent dispatch (variant-gen, multitask) | 0% (gated off) | ~15% (when fired) |

The fixes are mostly **simplifications**: tier-aware tool slimming, tier-aware iteration budgets, narrower brief-skip predicate, lower delta-snapshot threshold. None of them require new infrastructure or rewrites.

---

## Document index

| # | Doc | What's inside |
|---|---|---|
| 00 | `README.md` (this file) | Index + how to navigate |
| 01 | `01-executive-summary.md` | Top-level findings + the 5 changes that close 80% of the gap |
| 02 | `02-baseline-benchmarks.md` | The 2026-09-10 baseline measurement + how to reproduce it |
| 03 | `03-industry-parity-targets.md` | Industry research summary + the 5-tier parity table |
| 04 | `04-bottleneck-analysis.md` | Bottleneck-by-bottleneck diagnosis with code references |
| 05 | `05-canvas-simplification.md` | Canvas + snapshot changes |
| 06 | `06-agent-tools-simplification.md` | Tool surface slimming + tier-aware catalogs |
| 07 | `07-agent-behaviors-flows.md` | Brief / critic / fallback / sub-agent flow changes |
| 08 | `08-implementation-roadmap.md` | Phased plan (P0 → P3) with milestone definitions |
| 09 | `09-benchmark-suite.md` | Permanent benchmark harness for regression tracking |

---

## Reading order

- **If you want the headline:** `01-executive-summary.md`
- **If you want the data:** `02-baseline-benchmarks.md` → `03-industry-parity-targets.md`
- **If you want the why:** `04-bottleneck-analysis.md`
- **If you're implementing:** `05-canvas-simplification.md` → `06-agent-tools-simplification.md` → `07-agent-behaviors-flows.md`
- **If you're planning:** `08-implementation-roadmap.md`
- **If you're measuring:** `09-benchmark-suite.md`

---

## Guiding principles (these apply to every doc)

1. **Simplification over engineering.** Every change must reduce a surface area (tool count, prompt tokens, sub-agent calls, iteration budget). Adding complexity is the default failure mode.
2. **Tier-aware defaults.** Trivial prompts ("draw a red rectangle") should never pay the same cost as enterprise flows ("design a 30-token design system with 4 screens"). Every tunable knob has a per-tier default.
3. **Quality is non-negotiable.** A faster broken design is worse than a slow correct one. The existing VLM-critic suite (`scripts/vlm-inspect/`, `download/vlm-exercise/`) is the regression gate — every change must show no regression on the 8-dimension rubric (mean overall ≥ 6.0).
4. **Measure before optimizing.** The benchmark harness in `09-benchmark-suite.md` is the single source of truth. If a change isn't covered by a benchmark, it doesn't ship.
5. **Commit per milestone.** Every P0 / P1 / P2 milestone lands as one commit with: (a) code change, (b) benchmark before/after table, (c) test added, (d) doc updated.
