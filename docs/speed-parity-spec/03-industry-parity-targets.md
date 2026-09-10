# 03 — Industry Parity Targets

> **Source:** web-research subagent report (Task ID 5, appended to `/home/z/my-project/worklog.md`). 56 targeted web searches across 26 commercial tools, 9 open-source agents, and 8 academic benchmarks. Numbers tagged **[measured]** (independent test/reproduction), **[claimed]** (vendor blog/marketing), or **[extrapolated]** (inferred from architecture + latency math).

---

## The 5-tier parity table (synthesized)

This is the single table every AgentCanvas change must move us toward.

| Tier | Examples | Target TTFT | Target T2C | Target Calls | Provenance |
|---|---|---|---|---|---|
| **Trivial** (1-3 shapes / single component) | Button, badge, icon, color chip | ≤1s | 3-8s | ≤2 | [extrapolated] from Cursor 250 tok/s; [claimed] by Cursor Composer marketing |
| **Simple screen** (login, card, empty state) | Login form, pricing card, settings row | ≤3s | 10-30s | ≤6 | [measured] Cursor/v0 single-component; [claimed] by Magic Patterns |
| **Multi-section page** (dashboard, landing) | Analytics dashboard, marketing homepage | ≤5s | 30-90s | ≤12 | [measured] v0/Lovable; [claimed] by Figma Make, Galileo/Stitch |
| **Complex flow** (multi-screen app) | 5-screen onboarding, dashboard+detail+settings | ≤8s | 90-180s | ≤20 | [measured] Lovable <10 min full app, Bolt 2-8 min, Replit 3-10 min |
| **Enterprise design system** (tokens + components + flows) | 30+ tokens, 12+ components, 4+ screens | ≤12s | 180-300s | ≤30 | [extrapolated] from Webflow AI multi-page + design system; [claimed] by Webflow |

---

## The leader benchmarks we measured against

### Latency leaders (TTFT / T2C for single-screen generation)

| Tool | TTFT | T2C | Source |
|---|---|---|---|
| **Cursor Composer** | 1-3s (250 tok/s streamed diff) | 5-30s | [claimed + reproduced] |
| **Vercel v0** | 1-3s (TTFT Claude Sonnet 4) | 10-60s | [claimed + reviews] |
| **Bolt.new** | 2-5s | 60-180s (full-stack) | [claimed + reviews] |
| **Lovable.dev** | 3-8s | 5-10 min (full app) | [measured] |
| **Replit Agent (rapid build)** | 3-8s | 3-10 min | [claimed] |
| **Claude Code (verbose tools)** | up to 60s (prefill) | minutes-hours | [measured] |
| **Claude Code (cached)** | 2-5s | varies | [measured] |
| **Claude Artifacts** | 1-3s (TTFT) | 5-30s | [claimed] |
| **Figma Make** | 5-15s | 30-90s | [claimed + forum] |
| **Galileo / Google Stitch** | 2-5s | 15-45s | [claimed] |
| **Magic Patterns** | 2-5s | 10-30s per component | [measured] |
| **Uizard** | 3-8s | 30-60s | [claimed] |
| **Builder Visual Copilot** | 3-8s | 30-90s | [claimed] |
| **Musho.ai** | 5-10s | ~60s | [measured] |
| **Relume** | 2-5s (sitemap) / 5-15s (wireframe) | 30-60s full wireframe set | [claimed] |
| **Webflow AI** | 5-10s | 1-5 min (multi-page) | [claimed] |
| **TeleportHQ** | 5-15s | 30-120s | [claimed] |
| **OpenHands** | 2-5s | minutes-hours (autonomous) | [measured] |
| **Aider (cached)** | <1s | 5-60s per edit | [measured] |
| **Anthropic Computer Use** | 5-15s per step (screenshot loop) | minutes (multi-step) | [measured] |

### Quality benchmarks (design / code generation)

| Benchmark | SOTA model | SOTA score | Reference |
|---|---|---|---|
| **Design2Code** (484 webpages) | GPT-4o | Block-Match 93.0 / Text 98.2 / Position 85.5 / Color 84.1 / CLIP 90.4 | [measured] |
| **SWE-bench Verified** | Claude Opus 5 (Vals.ai) | 96-97% | [measured] |
| **SWE-bench Pro** (long-horizon) | top models | ~23% | [measured] |
| **OSWorld** (computer use) | Simular Agent S3 | 72.6% (vs human) | [claimed] |
| **OSWorld** (general agents) | best agent | 42.5% / 17.4% strict | [measured] |
| **ScreenSpot-Pro** (GUI grounding) | SE-GUI 7B | 47.2% | [claimed] |
| **Terminal-Bench 2.0** | Cursor Composer 1.5 | 47.9% | [claimed] |
| **WebGen-Bench** | various | varies per agent framework | [measured] |
| **OpenHands Index** | Claude Opus 4.5 era | varies per task class | [measured] |

---

## Where AgentCanvas sits today (vs the leaders)

| Tier | Industry TTFT leader | AgentCanvas baseline | Gap |
|---|---|---|---|
| Trivial | ≤1s (Cursor) | 7.7s | **7.7× over** |
| Simple | ≤3s (Cursor / v0) | 27s | **9× over** |
| Multi | ≤5s (v0 / Lovable) | 25s | **5× over** |
| Complex | ≤8s (Lovable) | 47s | **5.9× over** |
| Flow | ≤8s (Lovable) | _pending_ | _pending_ |

**The gap is not in tool-call count** (AgentCanvas is within budget on every tier). The gap is in **wall-clock latency per iteration**, driven by:

1. **Static prefix bloat** — AgentCanvas's ~45K-token system prompt + tool schemas vs Aider's ~5K-token minimal prompt vs Cursor's MoE-routed sparse activation. The Claude Code `claude-code-local` benchmark documented ~60s prefill at ~5,600 tokens/turn — AgentCanvas's 8× larger prompt pays a proportional cost on the first iteration.

2. **Brief pre-generation sub-agent** — AgentCanvas fires a 25s-timeout brief sub-agent on most design prompts. None of the leaders do this on the hot path; they emit a scaffold immediately (Replit's "rapid build mode") or skip the brief entirely (v0, Cursor).

3. **Tier-blind defaults** — AgentCanvas applies the same `maxIterations`, `maxCritiqueIterations`, tool catalog, and brief predicate to every prompt. Leaders route by complexity: trivial goes to a fast small model with a narrow tool set; complex goes to a frontier model with the full tool set.

---

## Architecture patterns that correlate with speed (and patterns that hurt)

### Patterns that correlate with speed

1. **Composite model routing** (v0). Route trivial work to cheap/fast models, complex work to frontier models. v0's AutoFix model runs *concurrently* with the streaming output — error detection is free in wall-clock time.

2. **Prompt-cache-friendly message layout** (Aider). System prompt + repo/canvas map + read-only files form a stable prefix that the provider caches; only the chat suffix mutates. Aider reports "80% reduction in repo map tokens" via `.aiderignore`.

3. **Client-side execution** (Bolt WebContainer). Build/run happens in the browser — no server round-trip for compile/run cycles. The LLM call still touches the network, but everything else is local.

4. **Rapid-build pre-generation** (Replit). Pre-computed scaffold emitted on turn 0, agentic loop runs only for refinement. Trades a small amount of token cost for a large reduction in time-to-first-pixel.

5. **Parallel sub-agent dispatch** (Cursor Background Agents, OpenHands). Independent sub-tasks dispatched to parallel agents/VMs, each with its own context window — total wall-clock is the max of the parallel branches, not the sum.

6. **Speculative / streaming tool-call detection** (getstream.io pattern). Parse the token stream for tool-call delimiters and fire the tool call as soon as the delimiter appears, before the model emits the closing tag.

7. **Sparse MoE inference** (Cursor Composer). Activate only specialized sub-models, achieving 250 tok/s — 4× frontier throughput. Cursor built this in-house.

8. **Two-stage structured-then-visual** (Relume). Sitemap (structured output, fast) → wireframes (visual, slower). Decouples cheap planning from expensive rendering.

9. **Closed-loop context re-send** (Lovable). Re-sending full context each turn trades token cost for statelessness — every turn is independent and can be replayed. Good for reliability, bad for token budget.

10. **Decision-time guidance / loop governors** (Replit). Hard caps on consecutive tool calls to prevent runaway loops.

### Patterns that hurt speed

1. **Verbose tool schemas in the prompt**. Claude Code's measured ~60s prefill at ~5,600 tokens/turn is the cautionary tale. AgentCanvas's ~45K-token prompt is ~8× this.

2. **Full-context re-send without caching**. Each tool call costs 200-500ms LLM latency plus tokens for the entire conversation history. Without prompt caching, an agentic loop with 20 tool calls pays 4-10s just in history re-transmission.

3. **Server-side execution round-trips**. Serverless build/test cycles add 200-800ms per round-trip. Bolt's WebContainer eliminates this; AgentCanvas's `client-roundtrip.ts` defaults (2-3s) are a known tax.

4. **Serial sub-agent dispatch**. Dispatching sub-agents one-at-a-time pays the sum; parallel with staggered start is better.

5. **Single large LLM call for complex designs**. The "one big prompt → one big response" pattern doesn't scale past a single screen.

6. **Token-hog loops without governors**. Claude Code users report "50M tokens in a loop before killing the chat" — AgentCanvas's `maxIterations` cap is the right defensive pattern, but it should be tier-aware.

7. **Screenshot round-trips for VLM critique**. OSWorld-Human found screenshot-loop agents are 3× slower per step as context grows. Cache screenshots, downscale aggressively, and skip VLM critique on low-stakes turns.

---

## UX patterns for perceived performance (the leaders' playbooks)

These don't speed up wall-clock but make waiting feel shorter. Documented here so we can adopt them later (post-P0).

1. **Streaming > batched response**. "A 3-second streaming response often feels faster than a 1-second batch response" — perceived progress beats absolute latency.

2. **Skeleton screens > spinners**. Skeleton screens feel approximately 20% faster than spinners for identical wait times. Render gray rectangles matching the requested design layout before any model output arrives.

3. **Progressive disclosure / partial renders**. As soon as the model emits the first node of a subtree, render it; don't wait for the full batch.

4. **Optimistic UI**. Apply user edits immediately to local state, reconcile with model output asynchronously.

5. **Think-time affordances**. For long agentic loops, surface what the agent is thinking (TODO list, current tool call, progress bar) — Claude Code's TODO-based planning is the canonical example.

6. **Tool-call streaming detection**. Parse the LLM's output stream for tool call tokens and fire the tool call before the model finishes its turn — shaves 200-500ms per tool invocation.

7. **Rapid-build / pre-generation**. Replit's "rapid build mode" emits a generic scaffold immediately while the real model call proceeds in the background. User sees pixels in <3s; the model refines within 15-60s.

8. **Latency-elastic trust window**. Academic proposal — compute a per-session latency budget and adjust UX (skeleton → progress → cancel) accordingly.

9. **Per-tool-call sub-status**. Bolt, Cursor, Claude Code all surface "running tool X" status — turns dead time into perceived progress.

10. **Cache-warming UI hint**. Aider and Claude Code both benefit from prompt caching — but the *first* call is uncached. The UX pattern: indicate "warming up…" on first call, "cached" on subsequent calls.

---

## What this means for the spec

The leaders' speed patterns are well-known and well-documented. AgentCanvas doesn't need new inventions — it needs to adopt the patterns:

- **Aider's prefix-stable message layout** → already implemented (Agent Performance Package change 5).
- **Replit's rapid-build pre-generation** → future work (P2 in the roadmap).
- **Composite model routing** → out of scope for this spec (would require provider-side changes).
- **Tier-aware tool catalogs** → P0 change #2 in this spec.
- **Skeleton-screen UX** → future work (P3 in the roadmap).
- **Speculative tool-call streaming** → future work (P3 — requires SDK changes).
- **Loop governors** → already implemented (`maxIterations`, `shouldStopAfterTurn`); P0 change #3 makes them tier-aware.

The P0 changes in this spec focus on the **highest-leverage, lowest-risk simplifications**: predicate narrowing, constant tuning, and tier-aware defaults. The architectural patterns that would require new infrastructure (composite routing, speculative streaming, rapid-build scaffolds) are documented in `08-implementation-roadmap.md` as P2/P3 future work.
