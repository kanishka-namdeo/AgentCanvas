# Agent Performance & Variant Generation — Design Doc

> **Status**: Implemented (2026-08-27/28)
> **Research base**: R1 (bolt/v0/Figma-Make/tldraw architecture study), R2 (agent efficiency best practices), R3 (own-stack audit) — session research notes; VLM output-inspection exercise (`scripts/vlm-inspect/`, results in `download/vlm-exercise/`)
> **Code touchpoints**: `src/lib/agent/tools.ts`, `src/lib/agent/tool-execution-mode.ts`, `src/lib/agent/tool-aliases.ts`, `src/lib/agent/runner-native.ts`, `src/lib/agent/runner-legacy.ts`, `src/lib/agent/subagents/variant-generator.ts`, `src/lib/agent/plugins/todo.ts`, `src/lib/agent/plugins/subagents.ts`, `src/lib/llm/types.ts` + `registry.ts`
> **Test coverage**: `tests/unit/agent-performance-package.test.ts` (12 tests), `tests/unit/todo-batch-variants.test.ts` (26 tests)

---

## 1. Problem statement

Live VLM-inspection of the agent (`scripts/vlm-inspect/`, baseline pass) measured three systemic efficiency problems on the same 13-turn scenario matrix:

1. **Round-trip tax.** The model burned calls on read-backs and one-at-a-time mutations: `ms-pricing` took 173 tool calls; the worst turn hit 78 calls / 489s. `pen_create_subtree` produced a tree the agent could not see (ids unknown) → a guaranteed `pen_get_metadata` read-back after every construction.
2. **Bookkeeping noise.** The todo plugin emitted 13 bookkeeping calls in a 31-call turn (~42% of the turn doing zero design work): one `todo_write` to create, then one `todo_update` + one `todo_list` read-back per step.
3. **No exploration.** Ambiguous creation prompts ("a pricing page") committed to a single direction on the first try — the palette/typography was decided by whatever the design brief guessed, with no comparison of alternatives.

## 2. The Agent Performance Package (10 changes)

1. **`pen_create_subtree` multi-root `nodes[]` batches** — one call builds MANY whole nested trees; the result embeds the FULL id-manifest + inline resolver warnings. Kills the mandatory `pen_get_metadata` read-back.
2. **`pen_duplicate_nodes`** — `count`/`direction`/`spacing` batch duplication ("turn one card into three" = 1 call, was 78); fixes silently-ignored `offsetX`/`offsetY`.
3. **`tool-execution-mode.ts`** — canvas mutations marked `executionMode: 'sequential'`; pi-agent-core applies multi-tool batches in emission order (create-then-style survives), reads stay concurrent.
4. **System prompt** — PARALLEL TOOL EMISSION RULE + CALL BUDGET RULE (≤12 calls/turn).
5. **Byte-stable system prompt** — `canvasSnapshot` moved from the system-prompt tail into the first user message, so the ~45K-token static prefix is prefix-cacheable.
6. **Alias slimming** — 26 legacy alias tool entries dropped from the LLM-visible catalog (~28KB/call); stale transcripts still dispatch through `tool-aliases.ts`.
7. **`maxIterations` enforcement** — wired via `session.agent.shouldStopAfterTurn` (was read but never used).
8. **Critique-loop economy** — free validation gate first, VLM critic skipped for small clean edits, text + VLM critics run concurrently.
9. **Design brief pre-generation** — the brief sub-agent runs BEFORE the main loop and is injected into the first user message (the guaranteed brief round trip is deleted; tool gate remains as fallback).
10. **Prompt caching** — `supportsLongCacheRetention` + `PI_CACHE_RETENTION=long` for custom OpenAI-compatible endpoints.

**Measured** (live A/B on the same scenarios): round-trips cut 2.4× (ms-pricing 173 → 72 calls; worst turn 78 → 31 calls / 489 → 258s); prompt cache ~90-99% hit on the static prefix (usage.cacheRead 43-47K/call, structurally 0 before); multi-tool batches of 5-7 calls observed; quality within VLM noise.

## 3. Todo-batch noise fix

- `todo_update` accepts a **BATCH of transitions** (1-20 in one call — never one call per status change).
- **WIP=1 auto-advance**: marking a step `in_progress` implicitly completes the previous one — no separate "completed" call.
- Every mutation returns the **FULL list state** — no `todo_list` read-backs.
- **Prompt gating**: todos only on 5+ step / 10+ call tasks (<1/4 of total calls).
- Backward compatible: the single-step schema is normalized into a 1-element batch (old tests + stale transcripts keep working).

**Measured** (final 14-turn matrix): todo share **0.9%** of tool calls (target <15%; was ~42% of bookkeeping-heavy turns).

## 4. Multi-variant parallel generation ("go wide")

**Pattern**: R1 pattern 9 — Figma "design directions" / tldraw Fairies. On ambiguous creation prompts (no direction pinned), explore K=3 whole-design directions in parallel and let a vision judge pick, instead of committing to the first guess.

**Flow** (`subagents/variant-generator.ts`, behind the `pen_generate_variants` tool):
1. K=3 staggered-parallel spec generations with SEEDED directions (`DEFAULT_VARIANT_DIRECTIONS`: Minimal Light / Bold Vibrant / Dark Premium) — stagger + sequential retry waves because single-connection tunnels (pinggy) starve under simultaneous long calls.
2. Throwaway off-canvas renders → one composite image (`compositeVariantPngs`).
3. ONE VLM-judge call on the composite (A/B/C labeled) — heuristic judge fallback when no render is available.
4. Only the winner is applied; the result embeds the winner's id-manifest + all scores + resolver warnings inline (no read-back).

**Three-layer schema defense** (from live kimi-k2-5 failures — models invent alternative JSON schemas under long prompts):
1. *Prevention* — `SPEC_SYSTEM_PROMPT` embeds the exact output schema + forbidden-keys list.
2. *Coercion* — `extractSpecJson` (parse-whole fast path) → `coerceNodeTree` salvages near-miss containers (`ui_components`/`sections`), rewrites invented types to `KNOWN_TYPES`, `stripDescriptorFields` drops descriptor keys. Never throws.
3. *Repair* — a temperature-0.1 `REPAIR_SYSTEM_PROMPT` round-trip re-emits wrong-schema output as pure transcription into the required schema.

**Wall-clock budget** (live finding: retry multiplication — 300s client timeout × retry attempts × sequential retry wave × repair round-trips — stalled ONE tool call past 19 minutes): `DEFAULT_BUDGET_MS = 300s` across the whole dispatch; every phase races the deadline (generation waves 150s, repair 90s, judge 75s + 45s reserve); budget-aware stagger; budget-skip notes. Degradation ladder: judge timeout → heuristic judge; exhaustion → the agent falls back to `pen_create_subtree`.

**Runner integration**: ambiguous-creation detection skips the design brief on those turns (the brief would pre-decide the palette the exploration exists to settle) and nudges to the explorer; the brief gate is exempted on ambiguous turns.

**Measured** (final matrix): variant-gen fired on 6/14 creation turns; `smoke-variants` scenario scored 8/10 with 0 missing elements; the turn completed cleanly at 480s / 48 tool calls (first tool call = `pen_generate_variants`, 3 custom directions, winner 98 nodes, agent refined on top).

## 5. Final verification pass (14-turn matrix)

Full matrix on the latest code (13 core turns + smoke-variants) into `download/vlm-exercise/final/`, all turns via `turn_end`, every output critiqued by an external VLM on the 8-dimension rubric:

| Metric | Baseline | Final | Δ |
|---|---|---|---|
| Mean overall score | 4.92 | 6.02 | +1.10 |
| prompt_fidelity | 5.00 | 6.86 | +1.86 |
| Total tool calls | 400 | 348 | −13% |
| Todo-call share | ~42% (worst turns) | 0.9% | target <15% ✓ |
| Variant-gen usage | — | 6/14 turns | new capability |

Known remaining weaknesses (documented in `download/vlm-exercise/REPORT.md` §5): os-kanban zoom regression (8→2 at 26% zoom), ms-pricing row overflow on turns 2-3.

## 6. Ownership map

| Concern | File |
|---|---|
| Multi-root subtree + id-manifest + `pen_generate_variants` / `pen_duplicate_nodes` tools | `src/lib/agent/tools.ts` |
| Sequential/parallel execution policy | `src/lib/agent/tool-execution-mode.ts` |
| Legacy alias map (dispatch-only) | `src/lib/agent/tool-aliases.ts` |
| Brief pre-generation, brief-skip on ambiguity, shouldStopAfterTurn, cache flags | `src/lib/agent/runner-native.ts` |
| Sub-agent client (300s timeout, stagger) | `src/lib/agent/runner-legacy.ts` (`buildSubAgentLLMClient`) |
| Variant dispatch + budgets + coercion + judge | `src/lib/agent/subagents/variant-generator.ts` |
| Todo batching | `src/lib/agent/plugins/todo.ts` |
| Provider-aware sub-agent client | `src/lib/agent/plugins/subagents.ts` (`getActiveLLM`) |
| `timeoutMs` threading | `src/lib/llm/types.ts` + `registry.ts` |

Runbook for re-running the matrix: `scripts/AGENTS.md` → `vlm-inspect/` entry (`MAX_WAIT=560 timeout 580 bun scripts/vlm-inspect/run-scenarios.ts download/vlm-exercise/<pass>`).
