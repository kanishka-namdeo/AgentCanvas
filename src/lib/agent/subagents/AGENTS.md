# AGENTS.md — `src/lib/agent/subagents/`

## Purpose

Isolated-context sub-agents: single-purpose LLM calls that run OUTSIDE the main agent loop with their own system prompt, tool subset, and (where relevant) throwaway canvas state. Each returns a `SubAgentResult` summary, keeping tens of thousands of tokens of intermediate content out of the main context. Created when the folder held only web-research + design-critic; now 5 dispatch sub-agents + the multitask decomposition path.

## Ownership

- `index.ts` — barrel export.
- `web-research.ts` — search+fetch synthesis. Own LLM context with ONLY `web_search` + `web_fetch`; 1-3 searches + 1-3 fetches (capped at 6 iterations); returns a synthesized SUMMARY (not raw page content — keeps 50K+ tokens of page content out of the main context). Dispatched when `web_research` is a secondary category AND `recommendPlan`; if the primary task IS web research, the summary IS the answer.
- `design-critic.ts` — text reflection critic behind `pen_self_critique` (Phase 3, `docs/agentic-workflows.md`). Temperature 0.4 persona; strict output contract (`CRITIQUE:` bulleted list with `[BLOCKER]`/`[MAJOR]`/`[MINOR]`/`[PRAISE]` tags + `SCORE:` 1-10). Does NOT see the generation prompt (context isolation — reduces confirmation bias).
- `design-critic-vlm.ts` — VLM screenshot critic (Task 7-c T3). Prefers the real client screenshot via the `agent:screenshot_request` round-trip (3s budget); falls back to server-side `renderCanvasToPng` (resvg). Critiques the actual rendered picture with the 8-dimension rubric. The critique loop (runner-native, when `designCritiqueMode` allows — 'manual' default since 2026-09-06) dispatches text + VLM critics CONCURRENTLY and merges defects.
- `design-brief.ts` — pre-generation design brief (`pen_generate_design_brief` tool + runner pre-generation). Strict-JSON `DesignBrief` output (palette / typography / component count / layout grid / IA list). The runner pre-generates the brief BEFORE the main loop and injects it into the first user message (40s timeout race) — the tool-layer gate remains as fallback. SKIPPED on ambiguous-creation turns (the variant explorer must not have its palette pre-decided).
- `variant-generator.ts` — K=3 parallel whole-design exploration behind `pen_generate_variants` ("go wide", R1 pattern 9 — Figma design directions / tldraw Fairies). See the contract below. Dispatched by the runner on ambiguous creation prompts (no direction pinned); the winner is applied, losers are discarded.
- `multitask.ts` — the `/multitask` path (forces build mode): decomposes the prompt (one cheap LLM call → 2-5 screen tasks + sharedStyle), generates screen specs in parallel with disjoint region lanes, applies them as patches with Gate-0 validation; degrades to the single-agent path on <2 tasks or decomposition failure. Not an isolated-context critic — a parallel worker fan-out.

## Local Contracts

### Shared sub-agent plumbing
- All sub-agents emit `agent:subagent_dispatch` / `agent:subagent_result` events and retry through `llm-retry.ts` (5s→40s exponential backoff, 5 attempts on 429/transient errors).
- The sub-agent LLM client is built by `buildSubAgentLLMClient` (`../runner-legacy.ts`) with `timeoutMs: 300_000` (raised from 120s — healthy 80s generations were being aborted under parallel load; threaded through `src/lib/llm/types.ts` + `registry.ts`).
- Constrained transports (single-connection tunnels like pinggy) starve under simultaneous long calls: sub-agents launch STAGGERED (~15s apart) with sequential retry waves.
- Provider-aware client: `getActiveLLM()` (from `plugins/subagents.ts`) exposes the runner-armed client so pen tools can dispatch sub-agents; falls back to `ZAI.create()` sandbox credentials when unset.

### Variant generator (`dispatchVariantGeneration`)
Three-layer schema defense (from live kimi-k2-5 failures — models invent alternative JSON schemas under long prompts):
1. **Prevention**: `SPEC_SYSTEM_PROMPT` embeds the exact output schema with an example + a forbidden-keys list (`page_title`, `theme`, `ui_components`, …).
2. **Coercion**: `extractSpecJson` (with a parse-whole fast path before fenced-block extraction) → `coerceNodeTree` maps near-miss containers (`ui_components`/`sections`) into the node tree, rewrites invented types to the closest `KNOWN_TYPES` entry, and `stripDescriptorFields` drops descriptor keys. Never throws — salvage what parses.
3. **Repair**: a `REPAIR_SYSTEM_PROMPT` round-trip at temperature 0.1 re-emits wrong-schema output as pure transcription into the required schema (keeps the design, changes only the JSON shape).

Wall-clock budget (live finding: retry multiplication — 300s client timeout × retry attempts × sequential retry wave × repair round-trips — stalled ONE tool call past 19 minutes):
- `DEFAULT_BUDGET_MS = 300_000` across the whole dispatch; every phase races the deadline via a `withTimeout` helper.
- Per-phase caps: generation waves `GEN_TIMEOUT_MS = 150_000`, repair `REPAIR_TIMEOUT_MS = 90_000`, judge `JUDGE_TIMEOUT_MS = 75_000` (+ `JUDGE_RESERVE_MS = 45_000` held back for the judge).
- The launch stagger is budget-aware; exhausted phases record budget-skip notes in the result.

Degradation ladder (never hangs, never hard-fails):
- Judge timeout → heuristic judge (rule-based winner ranking, no render needed).
- Total exhaustion / all variants unparseable → the result tells the agent to fall back to `pen_create_subtree` (the runner-side ladder).

Result shape: winner applied via patch; the result embeds the winner's full id-manifest, all variant scores, and resolver warnings INLINE — no `pen_get_metadata` read-back round trip.

**Variant runner-up parking (2026-09-12 — designer-workflow-parity Tasks 3–6)**: the loser variants are no longer discarded. After the winner is applied, the runner-up variants are PARKED on the Explorations page (a dedicated page created via `add_page` with `pageName: 'Explorations'` when it doesn't already exist). The parking patches are `add_subtree` ops with `pageId: 'Explorations'` (page-target patch ops — the applier writes to the specified page instead of the active page). Each parked variant is wrapped in a `section` node with a descriptive label ("Variant B — Emerald palette", etc.). After parking, the runner emits `agent:alternatives_parked` with the parked section node ids (`alternatives[].id` — the stable promote key), thumbnails (base64 PNG data URLs, stripped from the journaled copy to stay under the 65K row cap), and judge scores. The frontend renders an AlternativesCard promote card; "Use this" calls the store action `promoteAlternative(sectionId)` which POSTs `/api/documents/[id]/variants/promote` to swap the parked design into the active page (the promote route resolves the section, removes the current active page's children, and copies the parked section's children into the active page — see `src/app/api/AGENTS.md`). The card state persists on the session message and survives reloads / session switches.

## Work Guidance

- A new sub-agent gets: a `dispatch*SubAgent` / `dispatch*` function returning `SubAgentResult` (or its own result type), dispatch/result events, an entry in `index.ts`, and a row above. Keep its system prompt IN ITS OWN FILE — never inline it in the runner.
- Sub-agents that need canvas state receive a snapshot argument; they must NOT import the Zustand store or emit patches directly (variant-generator renders throwaway off-canvas state and returns ONE winner patch through the tool layer).
- Any new long-running dispatch MUST carry a wall-clock budget with per-phase races — see the variant generator for the pattern and `tests/unit/todo-batch-variants.test.ts` for the hanging-LLM mock style (a 1.2s budget against an eternally-hanging LLM must return in ~1.2s).

## Verification

- `bun run test` — variant-generator coverage lives in `tests/unit/todo-batch-variants.test.ts` (coercion, composites, budget races with hanging-LLM mocks; 26 tests).
- `bun scripts/vlm-inspect/probe-variant-gen.ts` / `probe-variant-dispatch.ts` — live single-dispatch probes (model injected, 300s timeouts). LEGACY: they predate the endpoint-preset access rule and carry a hard-coded kimi-k2-5 model string against the pinggy tunnel — the endpoint now serves qwen3.7-plus (BETA preset), so refresh the model string or route through the app's API before relying on them.
- Final 14-turn matrix evidence: `download/vlm-exercise/final/` + `REPORT.md` (variant-gen fired on 6/14 creation turns; smoke-variants 8/10 with 0 missing elements).

## Child DOX Index

No child `AGENTS.md` files. This folder is flat.
