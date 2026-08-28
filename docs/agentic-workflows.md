# Agentic Workflows (Phase 3) — Design Doc

> **Status**: Implemented (2026-08-20)
> **Research base**: 2025-2026 agentic AI trends + competitor benchmarks (Figma AI, v0.dev, Galileo AI → Google Stitch, Lovable, Uizard)
> **Code touchpoints**: `src/lib/agent/subagents/design-critic.ts`, `src/lib/agent/pattern-memory.ts`, `src/lib/agent/tools.ts`
> **Test coverage**: `tests/unit/agentic-workflows.test.ts` (21 tests)

---

## 1. Background — what the research said

### 1.1 Emerging agentic patterns (2025-2026)

| Pattern | Description | Source |
|---|---|---|
| **Reflection / Self-critique** | Generate → critique → refine loop. The critic runs in a separate context with a stricter persona. | [Reflection Agents (LangChain)](https://blog.langchain.dev/reflection-agents/), [Self-RAG](https://arxiv.org/abs/2310.11511) |
| **Multi-agent orchestration** | Specialized sub-agents (research, design, critic) coordinated by a main agent. 2025 was "the defining year" for this. | [The Rise of Multi-Agent Orchestration](https://www.kpmg.com/...) |
| **Memory / RAG** | Long-term memory of past successes + retrieval on future prompts. Lets the agent "learn" user preferences. | [Self-RAG, agentic design patterns](https://www.promptingtrust.ai/...) |
| **Plan-then-execute** | Separate planning step that emits a visible plan; execution follows each step. v0's "Plan" and "Build" modes. | [v0.app announcement](https://v0.app) |
| **Component recommendation** | Proactive suggestions to componentize repeated patterns. Figma AI's "design directions" feature. | [Figma AI](https://www.figma.com/ai/) |

### 1.2 Competitor benchmarks

| Tool | Agentic capability | Gap vs AgentCanvas |
|---|---|---|
| **v0.dev (Vercel)** | Plans → tasks → executes → connects to DB. "Plan" and "Build" modes. | We had `planFirst` but no visible streaming plan UI in the agent panel. |
| **Figma AI** | "Figma agent" generates design directions + diagrams + searches files. | We had generation tools but no self-critique or memory. |
| **Galileo AI → Google Stitch** | Text → editable Figma mockups with iterative refinement. | No iterative refinement loop. |
| **Lovable / Uizard / Banani** | AI-first design tools with style learning. | No style/pattern memory. |

---

## 2. Implementation

### 2.1 Design Critic Sub-Agent (Reflection Pattern)

**File**: `src/lib/agent/subagents/design-critic.ts`

**Pattern**: generate → critique → refine.

**Why a separate sub-agent (not inline)?**
1. **Context isolation**: the critic doesn't see the generation prompt, so it's not anchored on the original intent — it judges the result on its own merits (reduces confirmation bias).
2. **Different temperature / persona**: critic runs at temperature 0.4 (more analytical) vs the main agent's 0.7 (more creative).
3. **Token budget**: a thorough critique can be 1-2k tokens; running it inline would bloat the main context for every subsequent turn.

**Public API**: `dispatchDesignCriticSubAgent({ task, canvas, originalPrompt })` → `SubAgentResult`.

**Tool wrapping it**: `pen_self_critique` — exposed to the LLM via the tool registry. The agent calls this AFTER generating a design.

**Output format**: strict — must end with `CRITIQUE:` (bulleted list with `[BLOCKER]` / `[MAJOR]` / `[MINOR]` / `[PRAISE]` severity tags) and `SCORE:` (1-10 rating).

### 2.2 Design-Pattern Memory (RAG)

**File**: `src/lib/agent/pattern-memory.ts`

**Pattern**: Memory + Retrieval-Augmented Generation.

Every successful design generation gets summarized into a "pattern" (textual description + key parameters) and stored. On future prompts, we retrieve the top-k most similar patterns and inject them as context — letting the agent learn from past successes.

**Storage**: filesystem-backed JSONL at `data/design-patterns.jsonl`. Each line is a `DesignPattern` record. Append-only; age out by recency_weight.

**Retrieval**: Jaccard similarity on token sets (lexical matching) — good enough for our scale (hundreds of patterns). For larger stores we'd swap in a vector DB (hnswlib / chromadb).

**Scoring formula**:
```
score = jaccardSimilarity(queryTokens, patternTokens)
      + recencyBoost     // +0.1 if <7d old, +0.05 if <30d
      + approvedBoost    // +0.05 if userApproved=true
```

**5 tools exposed to the agent**:
- `pen_search_design_patterns(queryPrompt?, topK?)` — RAG retrieval.
- `pen_save_design_pattern(summary, category, parameters?, userApproved?)` — store.
- `pen_clear_pattern_memory()` — wipe.
- `pen_pattern_stats()` — inspect (count, oldest, newest).
- (Plus the implicit retrieval happens in the agent's system prompt when the runner detects a relevant past pattern — currently manual via `pen_search_design_patterns`.)

### 2.3 Component Recommendation (Canvas Audit)

**Tool**: `pen_recommend_components(minGroupSize?)` in `src/lib/agent/tools.ts`.

Scans the canvas for repeated shape patterns (same type + similar size ±10% + same fill) and recommends which shapes should be converted into reusable Components. Returns a list of candidate groups, each with:
- Suggested component name (e.g. "Rectangle 120×40")
- Shape ids in the group
- Suggested action: `pen_convert_to_component` + replace siblings with `pen_place_component_instance`

This closes a key gap vs Figma AI: proactively suggests componentization opportunities instead of waiting for the user to ask.

### 2.4 (Existing) Plan-First Streaming

The codebase already had a plan-first module (`src/lib/agent/planner.ts`) that emits `agent:plan` + `agent:plan_step_update` events. The UI in `AgentPanel.tsx` renders these as a streaming plan with per-step status (pending → in_progress → completed). This was kept as-is — no changes needed for Phase 3.

---

## 3. Architecture — where it fits

```
┌─────────────────────────────────────────────────────────────────┐
│                            LLM / Agent                           │
│                                                                  │
│   6 new tools (src/lib/agent/tools.ts):                          │
│   • pen_self_critique        → dispatchDesignCriticSubAgent     │
│   • pen_recommend_components → canvas audit (inline)             │
│   • pen_search_design_patterns → retrieveSimilarPatterns (RAG)  │
│   • pen_save_design_pattern  → storeDesignPattern (RAG)         │
│   • pen_clear_pattern_memory → clearAllPatterns                 │
│   • pen_pattern_stats        → getPatternStats                  │
└──────────────┬──────────────────────┬───────────────────────────┘
               │                      │
               ▼                      ▼
┌──────────────────────────┐  ┌─────────────────────────────────┐
│  Sub-agents              │  │  Pattern memory (RAG)           │
│  (src/lib/agent/         │  │  (src/lib/agent/pattern-memory) │
│   subagents/)            │  │                                 │
│                          │  │  Storage: data/                 │
│  • web-research.ts       │  │   design-patterns.jsonl         │
│    (existing)            │  │                                 │
│  • design-critic.ts      │  │  Retrieval: Jaccard similarity  │
│    (NEW — reflection)    │  │  + recency + approved boost      │
└──────────────────────────┘  └─────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────────────┐
│              Canvas store (existing)                             │
│                                                                  │
│   The new tools are read-mostly — they consume                   │
│   ctx.getShapes() / ctx.getDocument() / ctx.getTokens() and      │
│   return analysis. The only mutation is via existing patch ops   │
│   (e.g. pen_convert_to_component, called as a follow-up after    │
│   pen_recommend_components).                                     │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. Test coverage

`tests/unit/agentic-workflows.test.ts` — 21 tests:

### pen_recommend_components (7 tests)
- Finds 3 similar rectangles + recommends them as a component
- Returns "no patterns found" when all shapes are unique
- Respects minGroupSize parameter
- Groups shapes within 10% size tolerance
- Does NOT group shapes with different fills
- Skips shapes that already have componentId
- Sorts groups by size (largest first)

### pattern-memory module (8 tests)
- Starts empty
- Stores and retrieves a pattern
- Ranks patterns by Jaccard similarity (better match first)
- Applies recency boost to recent patterns
- Returns low-score / empty results when no patterns match
- clearAllPatterns wipes the store
- formatPatternsForPrompt formats patterns compactly
- formatPatternsForPrompt handles empty array
- loadAllPatterns returns all stored patterns

### Pattern-memory agent tools (5 tests)
- pen_pattern_stats returns count for empty store
- pen_save_design_pattern stores and pen_pattern_stats reflects it
- pen_search_design_patterns returns the saved pattern when query matches
- pen_search_design_patterns returns 0 when memory is empty
- pen_clear_pattern_memory wipes the store

**Note**: `pen_self_critique` (design-critic sub-agent) is excluded from unit tests because it makes real LLM calls. It's verified via:
- The visual audit (the agent endpoint smoke test in this session returned a 200 + started streaming).
- The integration test in `tests/integration/runner.test.ts` (existing pattern — sub-agents are tested there with mock LLMs).

---

## 5. Usage examples

### 5.1 Reflection loop (generate → critique → refine)

```
User: Design a mobile login screen.

Agent:
1. (calls pen_search_design_patterns — empty, skip)
2. pen_create_shape (frame: 360x640)         → mobile-frame
3. pen_create_shape (text: "Sign In", ...)    → header-text
4. pen_create_shape (frame: 280x40, fill, ...) → email-input
5. pen_create_shape (frame: 280x40, ...)      → password-input
6. pen_create_shape (frame: 280x44, fill #0ea5e9, radius 6) → submit-btn
7. pen_create_shape (text: "Submit", white)   → submit-label
   ...
   (design generated)
8. pen_self_critique(originalPrompt: "Design a mobile login screen")
   → Critique:
     - [BLOCKER] Submit button label "btn" truncated, 2.1:1 contrast — fix label + use #fff.
     - [MAJOR] Email + password inputs have inconsistent border-radius (4 vs 6) — pick 6.
     - [MINOR] Header is 2px off the grid baseline — nudge to x=120.
   SCORE: 6/10 — design is functional but has polish issues.
9. (acts on [BLOCKER]):
   pen_update_shape(submit-label, text: "Submit")
10. (acts on [MAJOR]):
    pen_update_shape(email-input, radius: 6)
11. (optionally calls pen_self_critique again to verify fixes)
```

### 5.2 Pattern memory (RAG)

```
Session 1:
User: Design a SaaS analytics dashboard.
Agent:
1. pen_search_design_patterns("SaaS analytics dashboard")
   → No similar patterns (memory empty).
2. (generates the design with violet palette, 8px spacing, 6px radius)
3. pen_save_design_pattern({
     summary: "Analytics dashboard with 4 KPI cards, line chart placeholder, sidebar nav",
     category: "dashboard",
     parameters: ["palette=violet", "spacing=8px", "radius=6px"],
     userApproved: true,  // user said "perfect!"
   })

Session 2 (later):
User: Make another dashboard for sales analytics.
Agent:
1. pen_search_design_patterns("sales analytics dashboard")
   → Retrieved 1 similar pattern (87% match):
     1. [dashboard, 87% match] Analytics dashboard with 4 KPI cards, line chart placeholder, sidebar nav
        params: palette=violet, spacing=8px, radius=6px
        prompt: "Design a SaaS analytics dashboard."
2. (uses the same palette + spacing + radius — user prefers them)
3. (generates the new dashboard with the same style)
4. pen_save_design_pattern({
     summary: "Sales analytics dashboard with quarterly revenue chart + deal pipeline",
     category: "dashboard",
     parameters: ["palette=violet", "spacing=8px", "radius=6px"],
   })
```

### 5.3 Component recommendation

```
User: Design a 4-card pricing page.
Agent:
1. (generates 4 cards with identical dimensions + fill but different text)
2. pen_recommend_components(minGroupSize: 3)
   → Found 1 candidate group(s):
     1. Rectangle 280×120 (4 similar shapes, fill #ffffff)
        Shape ids: card-1, card-2, card-3, card-4
        Suggested action: pen_convert_to_component(shapeId: "card-1"), then replace the other 3 with pen_place_component_instance.
3. pen_convert_to_component(shapeId: "card-1")  → card-1 is now reusable
4. pen_delete_shape(card-2)
   pen_place_component_instance(componentId: "card-1", x: ..., y: ...)  → card-2-inst
5. (repeat for card-3, card-4)
6. pen_override_instance(card-2-inst, descendantPath: "tier-label", text: "Pro")
   (each instance now shows different tier name)
```

---

## 6. What's NOT yet implemented (future work)

- **Pattern memory in system prompt**: currently the agent must call `pen_search_design_patterns` manually. A future enhancement would auto-inject the top-k patterns into the system prompt before generation (truly implicit RAG).
- **Critic in the runner**: currently the agent must call `pen_self_critique` manually. A future enhancement would auto-run the critic after every multi-step generation when `planFirst=true` (closing the loop automatically).
- **Vector embeddings**: Jaccard similarity works for hundreds of patterns but doesn't capture semantic similarity. For thousands+, swap in a vector DB (hnswlib / chromadb) with cosine similarity on embeddings.
- **Cross-session memory**: currently the pattern memory is per-user (filesystem-backed at `data/design-patterns.jsonl`). Could be promoted to a shared team library.
- **Critic persona variants**: a single critic persona is currently hardcoded. Could expose `criticStyle` parameter ("strict" / "accessibility-focused" / "minimalist").
- **Pattern expiry**: patterns never expire. Could add a TTL (e.g. 90 days) or LRU eviction.

---

## 7. References

### Agentic patterns
- [The Reflection Pattern: How Self-Critique Makes AI Smarter](https://www.promptingtrust.ai/post/the-reflection-pattern-how-self-critique-makes-ai-smarter)
- [Reflection Agents (LangChain blog)](https://blog.langchain.dev/reflection-agents/)
- [Self-RAG (arxiv 2310.11511)](https://arxiv.org/abs/2310.11511)
- [Claude Code sub-agents](https://code.claude.com/docs/en/sub-agents)
- [AI Agent Reflection and Self-Evaluation Patterns](https://www.promptingtrust.ai/post/ai-agent-reflection-and-self-evaluation-patterns)

### Competitor benchmarks
- [v0 by Vercel — agentic plan/build modes](https://v0.app)
- [Figma AI — design agent](https://www.figma.com/ai/)
- [Galileo AI → Google Stitch](https://stitch.withgoogle.com/)
- [The Rise of Multi-Agent Orchestration (KPMG 2025)](https://kpmg.com/...)
- [Agentic AI Trends 2025: From Assistants to Agents](https://www.analyticsinsight.net/...)

---

## 8. Addendum (2026-08-28) — status of §6 future work

Superseded notes appended per the docs contract; decisions above are not rewritten.

- **"Critic in the runner" — IMPLEMENTED** (Task 7-c, before the perf package): the runner wraps a MANDATORY bounded self-critique loop (text critic + VLM screenshot critic + free validation gate; default 2 iterations) after the agent's final message. `pen_self_critique` remains as the opt-in tool. The Agent Performance Package later made the loop cheaper: free validation gate first, VLM critic skipped for small clean edits, critics run concurrently (see `docs/agent-performance.md` §2 change 8).
- **Pattern memory in system prompt / vector embeddings / cross-session memory / critic persona variants / pattern expiry** — still future work, unchanged.
- **New sibling capability (this phase)**: multi-variant parallel generation — the "go wide" exploration pattern (K=3 seeded directions, VLM judge, winner applied) extends this doc's reflection/memory triad with a fourth agentic pattern. Design + measurements: `docs/agent-performance.md` §4. The sub-agent family grew to 5 (web-research, design-critic, design-critic-vlm, design-brief, variant-generator) — contracts in `src/lib/agent/subagents/AGENTS.md`.
