# UI-Improvement Research: How Production AI UI Tools Produce Good-Looking UI — and What AgentCanvas Is Missing

**Task ID:** 7-b
**Author:** general-purpose (research subagent)
**Date:** 2026-08-24
**Inputs:** 12 web searches via `z-ai function -n web_search`; 9 deep page reads via `z-ai function -n page_reader`; full read of `src/lib/agent/runner-legacy.ts` (SYSTEM_PROMPT_TEMPLATE 185–384), `runner-native.ts` (loop structure 140–260), `subagents/design-critic.ts` (the existing critic), `tools.ts` `pen_self_critique` definition (3180–3240), `planner.ts`.
**Audience:** implementation subagent for Task 7-c (and parent). This document is the actionable spec.

---

## 1. Executive Summary

Despite Task 6-a shipping 6 rich design-prompt sections (INLINE HIGH-FIDELITY FIELDS, PRIMARY COLOR 50-900 RAMPS, 9 COMPONENT RECIPES, 5 LAWS OF BEAUTIFUL UI, WCAG 2.2 AA, LETTER SPACING RULES) plus an existing `pen_self_critique` tool backed by a `design-critic` sub-agent, AgentCanvas's output is still weak by production-AI-tool standards. The research explains why:

> **Prompt-only interventions decay. The Vercel community forum (Aug 2025) shows the *exact* same complaint from v0's own users: "the AI just throws random blocks on the page without any taste or structure… sections feel disconnected, components look like basic UI kits, barely any animation or structure, stacked blocks with placeholder text and colored backgrounds."** v0's prompt is ~2000+ lines and *still* regresses without architectural enforcement.

What production tools do that AgentCanvas does not:

| Capability | v0 | Lovable | bolt.new | AgentCanvas (current) |
|---|---|---|---|---|
| **Design brief generation BEFORE generation** | ✅ `GenerateDesignInspiration` tool, called before every design task | ✅ "Start with the design system. This is CRITICAL" | ✅ Steered by vocabulary ("Premium, Subtle, Minimalistic") | ❌ Jumps straight to `pen_create_shape` calls |
| **Mandatory self-critique loop with N iterations** | ✅ (implicit — quality bar enforced in prompt) | ✅ Step 5 of 5-step loop: "Feedback Loop (Next Cycle)" | ✅ "Automatically tests, refactors, and iterates reducing errors" | ⚠️ `pen_self_critique` exists but is OPT-IN. No max-iterations loop. Agent can declare "done" after one bare wireframe. |
| **VLM screenshot critique** (render canvas → PNG → vision LLM) | ✅ (v0 supports image attachments + Inspect Site) | ✅ Users attach screenshots; agent reads preview | ✅ (live preview iframe + agent reads console logs) | ❌ Critic only reads a TEXT snapshot of shape properties. Cannot see alignment, whitespace balance, or "does this look generic". |
| **Design-token / semantic-color ENFORCEMENT** | ✅ "DO NOT use direct colors like text-white, bg-white, bg-black… Everything must be themed via the design tokens" | ✅ "CRITICAL: USE SEMANTIC TOKENS… DO NOT use direct colors like text-white, text-black, bg-white, bg-black, etc. Everything must be themed via the design system" | ⚠️ (uses Tailwind tokens via templates) | ❌ Allows raw hex. The 9 COMPONENT RECIPES in our prompt use raw hex (`#0ea5e9`, `#6366f1`). `$variable` references are mentioned but not enforced. |
| **Hard caps on color/font count** | ✅ "ALWAYS use exactly 3-5 colors total. NEVER exceed 5." "ALWAYS limit to maximum 2 font families" | ✅ "Maximize reusability of components" + design system tokens | ⚠️ (steered by templates) | ❌ No hard cap. AI can sprawl 12 colors and 4 fonts. |
| **5-step orchestration loop (Goal → Context → Plan → Build → Feedback)** | ✅ (v0 has plan mode + AskUserQuestions + Iterate) | ✅ Explicit 5-step loop, confirmed by technical deep-dive | ✅ "Bolt automatically tests, refactors, and iterates" | ⚠️ Has classify → plan → run → emit. No "Feedback Loop" step that re-enters the agent on quality issues. |
| **Reference-image / brand-inspiration retrieval (RAG)** | ✅ `GenerateDesignInspiration` + Inspect Site + image attachments | ✅ Image attachments; `imagegen` for hero images; `web_search` for real-world refs | ✅ Web search for images; image generation | ⚠️ Brand-inspiration skills exist (Apple/Vercel/Linear/GitHub/Notion/Spotify) but are dormant per Task 6-a note (~150 skills not loaded). No retrieval mechanism. |
| **Few-shot full-canvas examples** | ✅ v0 ships starter templates ("All Projects come with a default set of files and folders") | ✅ "Lovable templates give you a production-ready foundation" | ✅ "Bolt Templates → Production-ready starting points" | ⚠️ Has 9 component recipes (per-shape) but no full-canvas "this is what good looks like" example. |
| **Pre-complete validation gate** (don't declare done until X) | ✅ "Final Rule: Ship something interesting rather than boring, but never ugly" + "Utilize the GenerateDesignInspiration tool before any design work" | ✅ "Test harness: Generated code is validated before deployment to preview" | ✅ "Bolt automatically tests, refactors, and iterates" | ❌ No gate. Agent emits final message whenever it decides. |

The single highest-leverage finding: **v0, Lovable, and Bolt all run an explicit feedback loop (Lovable's Step 5) or a GenerateDesignInspiration pre-step (v0) — AgentCanvas has neither an enforced pre-brief nor an enforced post-critique loop. The prompt-only approach in Task 6-a is necessary but not sufficient; the production tools couple their prompt with architectural enforcement.**

---

## 2. Method

### 2.1 Searches (12 total, raw results saved under `scripts/research/`)

| # | File | Query |
|---|---|---|
| 01 | `01-v0-system-prompt.json` | "v0 vercel generative ui system prompt technique" |
| 02 | `02-lovable-approach.json` | "lovable.dev ai ui design agent approach" |
| 03 | `03-bolt-new-quality.json` | "bolt.new ai generated ui quality" |
| 04 | `04-self-critique.json` | "LLM agent self-critique loop ui design pattern reflection" |
| 05 | `05-vlm-critique.json` | "vision language model UI critique feedback agent" |
| 06 | `06-few-shot.json` | "AI UI generation few-shot prompting examples" |
| 07 | `07-design-tokens.json` | "design token enforcement LLM structured output" |
| 08 | `08-rag-ui.json` | "reference image retrieval UI generation RAG" |
| 09 | `09-v0-leaked.json` | "v0 system prompt leaked" (recency 365d) |
| 10 | `10-lovable-leaked.json` | "lovable system prompt leaked" (recency 365d) |
| 11 | `11-svg-canvas.json` | "AI design canvas SVG generation best practices layout" |
| 12 | `12-structured-output.json` | "react design generation structured output function calling tool" |

### 2.2 Deep page reads (9, saved under `scripts/research/page-*.json`)

| # | File | URL | Bytes |
|---|---|---|---|
| 01 | `page-01-v0-prompt.json` | raw.githubusercontent.com/x1xhlol/.../v0%20Prompts%20and%20Tools/Prompt.txt | 47k |
| 02 | `page-02-lovable-agent.json` | raw.githubusercontent.com/x1xhlol/.../Lovable/Agent%20Prompt.txt | 21k |
| 03 | `page-03-lovable-arch.json` | techaheadcorp.com/blog/inside-lovable-backend-design-system-architecture-ai-agent-orchestration-explained | 688k |
| 04 | `page-04-simon-v0.json` | simonwillison.net/2024/Nov/25/leaked-system-prompts-from-vercel-v0 | 18k |
| 05 | `page-05-langchain-reflection.json` | langchain.com/blog/reflection-agents | 217k |
| 06 | `page-06-vlm-feedback.json` | reddit.com/r/MachineLearning/.../visual_verification_as_a_feedback_loop_for_llm_code | 361k (mostly boilerplate — Reddit hides text from page_reader) |
| 07 | `page-07-v0-quality.json` | community.vercel.com/t/is-it-just-me-or-has-the-ui-quality-in-v0-gotten-worse/17893 | 726k |
| 08 | `page-08-agent-patterns-reflection.json` | agent-patterns.readthedocs.io/en/stable/patterns/reflection.html | 307k |
| 09 | `page-09-bolt-stunning.json` | bolt.new/blog/how-to-create-stunning-websites-with-bolt | 116k |

### 2.3 Codebase reads

- `src/lib/agent/runner-legacy.ts` lines 185–384 — confirmed SYSTEM_PROMPT_TEMPLATE has the 6 design sections, the FIGMA ONTOLOGY block, etc.
- `src/lib/agent/runner-native.ts` lines 140–260 — confirmed agent flow: normalize canvas → create 88 tools → classify → filter tools → plan → web-research → build prompt → resolve pi-ai Model → loop. No feedback step.
- `src/lib/agent/subagents/design-critic.ts` (full file) — confirmed: critic runs in isolated LLM context at temp 0.4, serializes canvas to TEXT snapshot (shape positions + fills + shadow/gradient counts), detects wireframe via heuristic counts. CRITIC IS OPT-IN: only runs when agent calls `pen_self_critique`.
- `src/lib/agent/tools.ts` lines 3180–3240 — confirmed: `pen_self_critique` tool wraps `dispatchDesignCriticSubAgent`. Tool description tells agent "Call this AFTER generating a design" — no enforcement.
- `src/lib/agent/planner.ts` lines 1–60 — confirmed: planner breaks task into SKILL STEPS (e.g. "use wireframe skill, then typography skill"). Does NOT generate a design brief (color palette, typography choice, references).

---

## 3. Current State (post Task 6-a) — What We Have

### 3.1 The 6 prompt sections (good)
1. **INLINE HIGH-FIDELITY FIELDS** — tells the AI to use shadow/gradient/radii/autoLayout/opacity inline (one-shot rich shapes) rather than scaffold-then-style.
2. **PRIMARY COLOR 50-900 RAMPS** — Sky/Violet/Emerald/Amber/Rose/Indigo ramps for shade selection.
3. **9 COMPONENT RECIPES** — Button primary, Button CTA, Card resting, Card raised, Input, Navbar, Hero, Modal, Avatar, Badge/Pill, FAB — concrete field values.
4. **5 LAWS OF BEAUTIFUL UI** — Contrast/Whitespace/Consistency/Feedback/Accessibility.
5. **ACCESSIBILITY CONTRACT (WCAG 2.2 AA)** — 4.5:1/3:1 + focus ring + button hit-target.
6. **LETTER SPACING RULES** — per-role table (DISPLAY -0.8 to LABEL +0.4).

### 3.2 The existing design critic (good, but with a gap)
- Sub-agent in isolated context (temp 0.4 — analytical).
- Strict senior-designer persona.
- Detects wireframe via heuristic: zero shadows + zero gradients + majority gray fills.
- Severity-tagged findings ([BLOCKER] / [MAJOR] / [MINOR] / [PRAISE]).
- 1-10 score.
- **Gap 1: OPT-IN.** The agent must decide to call `pen_self_critique`. There's no `MAX_ITERATIONS` enforced loop, no "must call critic before declaring done" gate. The agent can — and frequently does — emit a single bare rectangle and finish.
- **Gap 2: TEXT-ONLY.** The critic serializes shapes to a text snapshot (positions, fills, shadow counts). It can detect "no shadows, no gradients, mostly gray" heuristically. But it cannot see:
  - Alignment / grid drift (e.g. 3 cards off by 2px each).
  - Whitespace balance (cramped vs. premium-empty).
  - Visual hierarchy (does the most important element pop?).
  - "Generic AI look" — the Bolt guide calls this out: stacked blocks, same repetitive section order, default fonts.
  - Color harmony (does the chosen palette actually look good together, or just 5 random hues within a token ramp).
- **Gap 3: NO FEEDBACK LOOP.** Even if the critic flags a BLOCKER, the agent can ignore it. There's no automatic "re-enter the agent with the critique as a new user message" loop.

### 3.3 What's structurally missing vs. production tools
1. **No design-brief pre-step.** v0 calls `GenerateDesignInspiration` BEFORE any code generation — produces a "detailed visual specifications and creative direction" brief. Lovable says "Start with the design system. This is CRITICAL. All styles must be defined in the design system. You should NEVER write ad hoc styles in components."
   AgentCanvas: planner generates skill steps, not a design brief. The agent jumps straight to `pen_create_shape`.
2. **No enforced critique loop.** LangChain's Basic Reflection runs `generate → reflect → refine` for `MAX_ITERATIONS`. Lovable's 5-step loop has "Feedback Loop (Next Cycle)" as Step 5. AgentCanvas has an opt-in critic with no max-iterations.
3. **No VLM/screenshot critique.** The Reddit visual-verification post describes: *"The coding agent is biased toward its own output. A separate vision agent with no access to the code — only the rendered result — provides [feedback]."* ScreenAgent (IJCAI 2024) and UI-Pro (OpenReview) formalize this for UI. AgentCanvas's critic only reads a TEXT snapshot — it cannot see the rendered canvas.
4. **No design-token enforcement.** Both v0 ("DO NOT use direct colors like text-white, bg-white, bg-black") and Lovable ("NEVER use text-white, bg-white, bg-black, etc. Everything must be themed via the design system") HARD-ENFORCE semantic tokens. Our 9 component recipes use RAW HEX (`#0ea5e9`, `#6366f1`) — directly contradicting the production-tool pattern.
5. **No hard caps on sprawl.** v0: "exactly 3-5 colors total. NEVER exceed 5"; "maximum 2 font families". AgentCanvas has no caps; the AI can emit 12 colors and 4 fonts and the prompt won't object.
6. **No few-shot full-canvas examples.** v0 ships starter templates. Lovable ships templates. Bolt ships templates. AgentCanvas has per-shape recipes but no "here's what a complete fintech dashboard looks like in our schema" example.
7. **No brand/reference-image RAG.** ImageRAG paper (arXiv 2502.09411) — "dynamically retrieves relevant images based on a given text prompt, and uses them as context to guide the generation process." AgentCanvas has ~150 dormant brand-inspiration skills (Apple/Vercel/Linear/GitHub/Notion/Spotify) per Task 6-a note — not loaded.

---

## 4. Catalogued Techniques (12)

Each technique below has: Source / What it does / How production tools use it / How it integrates with AgentCanvas / Implementation complexity + LOC / Expected impact / Risks.

### T1. Pre-Generation Design Brief Tool (`pen_generate_design_brief`)
- **Source:** v0's `GenerateDesignInspiration` tool, referenced 3× in the leaked prompt: *"Utilize the GenerateDesignInspiration tool before any design work."* Example call: `Calls GenerateDesignInspiration with goal: "Landing page for email AI app that helps write better emails" to get detailed visual specifications and creative direction.`
- **What it does:** Before the agent emits any `pen_create_shape`, it calls this tool with the user's prompt. The tool (a sub-agent call, similar to `dispatchDesignCriticSubAgent`) returns a structured brief: chosen color ramp (e.g. "Emerald — primary 500 #10b981"), typography pairing (e.g. "Inter Display for headings, Inter for body"), layout pattern (e.g. "asymmetric hero, bento grid below"), 2-3 reference brands ("Linear, Vercel, Stripe"), and a 1-paragraph "mood" statement ("Cinematic, tactile, composed, surprising, alive" — Bolt's 2026 vocabulary). The agent then references this brief throughout generation.
- **Production usage:** v0 mandates this tool before any design work; Lovable mandates "Start with the design system. This is CRITICAL"; Bolt steers via vocabulary ("Premium, Subtle, Minimalistic, Aesthetic, Smaller, 2026 based").
- **AgentCanvas integration:**
  - New sub-agent file `src/lib/agent/subagents/design-brief.ts` (mirrors `design-critic.ts` structure: isolated LLM context, temp 0.7 for creativity, returns structured brief).
  - New tool `pen_generate_design_brief` in `src/lib/agent/tools.ts` (alongside the existing `pen_self_critique` definition at line 3197). Same `defineTool` pattern, same lazy-import pattern.
  - Update `SYSTEM_PROMPT_TEMPLATE` in `runner-legacy.ts`: add a section "MANDATORY PRE-GENERATION BRIEF — call pen_generate_design_brief BEFORE any pen_create_shape call. The brief is your design north-star for the rest of the turn."
  - Update `runner-native.ts` flow at step 4.5 (between classify and plan) to dispatch the brief sub-agent (similar to how web-research is dispatched at step 7) and inject the brief into the user message (similar to how the web-research summary is injected at step 11).
- **Complexity:** Medium. ~250 LOC (sub-agent + tool + prompt section + runner dispatch).
- **Impact:** High. This is the highest-leverage single change — it forces the agent to "think before it draws" instead of defaulting to a wireframe primitive on the first call.
- **Risks:** Adds ~2–4s + 1 LLM call to every design turn. Brief could be ignored if the agent's main context doesn't re-reference it (mitigate by injecting the brief into the user message AND the system prompt).

### T2. Mandatory Self-Critique Loop with MAX_ITERATIONS
- **Source:** LangChain's Basic Reflection (`MAX_ITERATIONS = 5` in the LangGraph example); Agent Patterns' `ReflectionAgent(max_reflection_cycles=N)`; Lovable's Step 5 of the 5-step loop ("Feedback Loop (Next Cycle): Errors, new requirements, and clarifications feed directly into the next agent cycle").
- **What it does:** After the agent emits its final message, the runner automatically calls the design-critic sub-agent. If the critic returns any `[BLOCKER]` finding OR the score is ≤ 6/10, the runner injects the critique as a new user message ("Critic found these BLOCKERS: … — please fix them.") and re-enters the agent loop. Cap at N=2 iterations to bound cost.
- **Production usage:** Lovable explicitly has Step 5; LangChain shows the LangGraph pattern with `event_loop` returning `END` only when `num_iterations > MAX_ITERATIONS`; Agent Patterns has `max_reflection_cycles` parameter.
- **AgentCanvas integration:**
  - The `design-critic.ts` sub-agent already exists and is well-designed (severity tags, score). REUSE IT.
  - Modify `runner-native.ts`: after the pi-ai agent session yields its final message, instead of returning immediately, run a wrapper loop:
    ```
    for (let iter = 0; iter < MAX_DESIGN_CRITIQUE_ITERATIONS; iter++) {
      const critique = await dispatchDesignCriticSubAgent({canvas, originalPrompt, llm: subAgentLLM});
      yield {kind: 'agent_event', event: {type: 'agent:critique', iteration: iter, summary: critique.summary}};
      if (!hasBlockers(critique.summary) && scoreFromSummary(critique.summary) >= 7) break;
      // inject critique as new user message and re-run agent
      userMessage += `\n\n=== CRITIQUE (iteration ${iter+1}) ===\n${critique.summary}\n=== END CRITIQUE ===\nAddress every [BLOCKER] finding.`;
      // re-run the agent session with the appended message
    }
    ```
  - `MAX_DESIGN_CRITIQUE_ITERATIONS = 2` (default; configurable in `AgentRunSettings`).
  - The existing `pen_self_critique` tool stays — let the agent opt-in mid-turn; the post-turn loop is the safety net.
- **Complexity:** Medium-High. ~150 LOC (wrapper loop in runner + 2 helper parsers + new `agent:critique` event in the translator + new `AgentRunSettings.maxDesignCritiqueIterations` field).
- **Impact:** High. This is the second-highest-leverage change — it ensures the agent can't declare done on a wireframe.
- **Risks:** Doubles or triples LLM cost per turn. Could loop indefinitely if the critic is never satisfied (mitigate with hard cap + "if score doesn't improve between iterations, break"). The translator + UI need to know about the new event type — coordinate with the React side.

### T3. VLM Screenshot Critique (`vlm_design_critic`)
- **Source:** Reddit r/MachineLearning post "[P] Visual verification as a feedback loop for LLM code": *"The coding agent is biased toward its own output. A separate vision agent with no access to the code — only the rendered result — provides [feedback]."* ScreenAgent paper (IJCAI 2024): VLM detects UI elements from screenshots, plans layout, synthesises HTML. UI-Pro paper (OpenReview 2024): VLM designed to enhance autonomous interaction with user interfaces.
- **What it does:** Render the current canvas to a PNG (the Canvas component already renders to SVG — we can rasterize via `@resvg/resvg-js` or `sharp` + `satori`, or puppeteer screenshot of a hidden preview). Send the PNG to a vision LLM (the z-ai SDK has `zai.vision.chat.create()` — uses GLM-4V or equivalent; or call OpenAI GPT-4V via the same client). The VLM returns a structured critique focused on what text-only critics can't see: alignment, whitespace balance, visual hierarchy, "does this look like a generic AI design".
- **Production usage:** v0 supports image attachments + Inspect Site task; Lovable supports image attachments; both treat the visual as the source of truth. The Reddit pattern formalizes it: "separate vision agent with no access to the code".
- **AgentCanvas integration:**
  - New sub-agent `src/lib/agent/subagents/design-critic-vlm.ts` — wraps `zai.vision.chat.create()` (from `z-ai-web-dev-sdk` — already installed).
  - New tool `pen_visual_critique` in `tools.ts` — alongside `pen_self_critique`. Same dispatch pattern.
  - Render pipeline: extend `src/components/canvas/Canvas.tsx` (or extract to `src/lib/canvas/render-to-png.ts`) to produce a PNG from the current `CanvasDocument`. Options:
    - (a) Render the existing SVG output (Canvas.tsx already produces `<svg>` with all shapes/filters/gradients) → rasterize via `@resvg/resvg-js` (pure-Rust SVG renderer, no headless browser needed).
    - (b) Use `satori` + `sharp` (satori turns JSX→SVG; sharp turns SVG→PNG).
    - (c) Puppeteer screenshot of a hidden `<CanvasPreview/>` component.
  - Recommended: option (a) — `@resvg/resvg-js` is fast (~50ms), pure Rust, no browser deps, and we already have the SVG.
- **Complexity:** High. ~400 LOC (new sub-agent + new tool + render-to-png module + vision API call + image upload to a temp URL or base64 inline + prompt). Plus a new npm dep (`@resvg/resvg-js`).
- **Impact:** High. This is what catches the things the text-critic can't see: alignment drift, cramped layouts, "looks generic". The single biggest differentiator between v0/Lovable output and AgentCanvas output.
- **Risks:** Vision LLM cost (each call ~$0.01–0.05 depending on provider). Latency (~2–4s per VLM call). Need to render canvas synchronously mid-turn (the agent loop blocks on the tool call — that's fine, tools are async). ZAI vision API rate limits. The Task 7-a VLM critique loop (referenced in the brief) is the test harness — coordinate.

### T4. Design-Token ENFORCEMENT (Block Raw Hex in pen_create_shape)
- **Source:** v0 leaked prompt: *"DO NOT use direct colors like text-white, bg-white, bg-black, etc. Everything must be themed via the design tokens."* Lovable leaked prompt: *"CRITICAL: USE SEMANTIC TOKENS FOR COLORS, GRADIENTS, FONTS, ETC. DO NOT use direct colors like text-white, text-black, bg-white, bg-black, etc. Everything must be themed via the design system."*
- **What it does:** In `pen_create_shape` and `pen_update_shape`, validate the `fill` / `stroke` / `textColor` / `shadow.color` / `gradient.stops[].color` fields. If they contain a raw hex string (e.g. `#0ea5e9`) instead of a `$variable` reference (e.g. `$color.primary`), the tool call FAILS with a structured error: "Raw hex not allowed. Bind to a $variable first via pen_set_variable, or use one of: $color.primary, $color.surface, $color.text, $color.bg, $color.accent, $color.primary-50..900. See PRIMARY COLOR 50-900 RAMPS in the system prompt."
- **Production usage:** Both v0 and Lovable use soft enforcement (prompt-only) — but they also have a default `globals.css` / `index.css` with all the tokens PRE-DEFINED so the AI doesn't have to invent them. AgentCanvas can do hard enforcement via tool-level validation, which is stronger.
- **AgentCanvas integration:**
  - Update `src/lib/agent/tools.ts` `coerceShapeInput` (around line 195) to validate color fields. If a raw hex is detected, throw a `ToolError` with the structured message.
  - Update `SYSTEM_PROMPT_TEMPLATE` 9 COMPONENT RECIPES section (lines 223–277) to use `$color.primary` / `$color.primary-500` / `$color.surface` / `$color.text` instead of raw hex. (The ramps section already maps ramps — point recipes at the ramps, not raw hex.)
  - Add a default-token bootstrap: at canvas init, auto-define `$color.primary` (Sky 500 #0ea5e9 by default, or from `defaultPalette` setting), `$color.surface` (#ffffff), `$color.bg` (#f8fafc), `$color.text` (#0f172a), `$color.text-subtle` (#94a3b8), `$color.accent` (Indigo 500 #6366f1). Already partially done — the `$variable` system exists. Just ensure defaults exist on canvas init.
- **Complexity:** Low-Medium. ~120 LOC (validation in coerceShapeInput + recipe rewrites in prompt + default-token bootstrap).
- **Impact:** Medium-High. Forces palette consistency; catches the "5 different blues" failure mode.
- **Risks:** Breaking change for existing test fixtures (tests use raw hex in `pen_create_shape` calls). Mitigate: only enforce in production (gate via `settings.enforceDesignTokens === true`), let tests stay loose. Or migrate test fixtures to use `$variable` references (more work).

### T5. Hard Caps on Color/Font Count
- **Source:** v0 leaked prompt: *"ALWAYS use exactly 3-5 colors total. Required Color Structure: Choose 1 primary brand color, add 2-3 neutrals (white, grays, off-whites, black variants) and 1-2 accents. NEVER exceed 5 total colors without explicit user permission." "ALWAYS limit to maximum 2 font families total. More fonts create visual chaos."*
- **What it does:** Add a hard validator to `pen_create_shape` / `pen_update_shape` that tracks the canvas's color inventory. If a new shape introduces a 6th unique color (excluding neutrals), reject with: "Color cap exceeded (5 max). Use one of the existing 5 colors or override a token value via pen_set_variable. See PRIMARY COLOR 50-900 RAMPS." Same for fonts: 3rd font family = rejection.
- **Production usage:** v0 hard-caps at 5 colors / 2 fonts. Lovable enforces via design-system single-source-of-truth. Bolt relies on templates.
- **AgentCanvas integration:**
  - Add `getColorInventory(canvas)` and `getFontInventory(canvas)` helpers in `src/lib/canvas/` (or extend `serializeCanvasForCritic` in `design-critic.ts` which already counts gray fills).
  - In `coerceShapeInput`, before applying the patch, check the new inventories. If cap exceeded, throw `ToolError`.
  - Update `SYSTEM_PROMPT_TEMPLATE` 5 LAWS section to add: "HARD CAP: 5 colors max (1 primary + 2-3 neutrals + 1-2 accents). 2 font families max. The tool will REJECT your call if you exceed."
- **Complexity:** Low. ~80 LOC (2 inventory helpers + validator in coerceShapeInput + 4 lines in prompt).
- **Impact:** Medium. Catches sprawl. Doesn't fix wireframes alone, but combined with T1/T2 it prevents the "12 random colors" failure.
- **Risks:** Could over-reject legitimate designs (e.g. a dashboard with 7 status colors). Mitigate: count UNIQUE HUES (collapse the 50-900 ramp to one hue), not raw hex — so `#0ea5e9` and `#0369a1` count as 1 color (same ramp).

### T6. Prompt Vocabulary Steering
- **Source:** Bolt.new "How to create stunning websites in 2026": *"These are the words that consistently get better results in Bolt.new prompts: Premium, Subtle, Minimalistic, Aesthetic, Smaller, 2026 based. They help steer the model away from the default AI design."*
- **What it does:** Inject a vocabulary list into the system prompt AND auto-append 1-2 of these words to the agent's first `pen_create_shape` call's `name` field (e.g. `name: "Hero (premium, minimalistic)"`). The naming trick is a soft steering mechanism — the LLM sees its own naming and trends toward the mood.
- **Production usage:** Bolt publishes this list. v0 has its `GenerateDesignInspiration` tool produce a mood ("Cinematic, tactile, composed, surprising, alive" — Bolt's own example brief vocabulary).
- **AgentCanvas integration:**
  - Update `SYSTEM_PROMPT_TEMPLATE` — add a small section "DESIGN MOOD VOCABULARY — when describing your design intent in `name` fields and self-talk, prefer: Premium, Subtle, Minimalistic, Aesthetic, Composed, Tactile, Cinematic, Surprising. AVOID: Modern (overused), Sleek (cliché), Cutting-edge (meaningless)."
  - In `runner-native.ts` step 1 (after the design brief from T1 is generated), if the brief contains a mood word, automatically prepend it to the agent's first user message: "Design mood: PREMIUM, MINIMALISTIC. Apply this mood to every shape name and styling decision."
- **Complexity:** Low. ~30 LOC (prompt section + 5-line auto-inject).
- **Impact:** Low-Medium. Soft steering, not a fix on its own.
- **Risks:** None significant. Worst case: ignored.

### T7. Few-Shot Full-Canvas Examples in Prompt
- **Source:** Promptingguide.ai few-shot pattern (the canonical reference); IBM's few-shot definition; Cleanlab's reliable few-shot selection; v0's starter templates ("All Projects come with a default set of files and folders… components/ui/*, hooks/*, lib/utils.ts, app/globals.css" — pre-shipped examples); Lovable templates; Bolt templates.
- **What it does:** Add 2-3 full-canvas "this is what good looks like" examples to the system prompt — not just per-shape recipes (we have those), but COMPLETE shape sequences for a representative design (e.g. a fintech dashboard hero). Each example is a sequence of `pen_create_shape` calls with all inline fields, in order, with comments explaining the design choices.
- **Production usage:** v0 ships starter templates so the AI never starts from zero. Lovable ships templates "production-ready starting points — dashboards, storefronts, portfolios". Bolt ships templates. All three ship concrete examples.
- **AgentCanvas integration:**
  - Update `SYSTEM_PROMPT_TEMPLATE` — extend the 9 COMPONENT RECIPES section into "10 FULL-CANVAS EXAMPLES" — pick 3 representative designs (e.g. "SaaS dashboard hero with stat cards", "pricing page with 3 tiers", "mobile onboarding screen"). Each example shows the complete sequence of 6-10 `pen_create_shape` calls.
  - Each example ~30 lines of pseudo-JSON. Total ~120-200 lines added to the prompt.
  - The examples should demonstrate the inline high-fidelity fields, the color ramp usage, the token references, the shadow scale, the type scale, the letter-spacing rules — i.e. they EXEMPLIFY everything the prompt preaches.
- **Complexity:** Medium. ~200 LOC of prompt content + 0 code.
- **Impact:** Medium-High. Few-shot is the most well-evidenced LLM-improvement technique; concrete examples outperform abstract rules for design tasks.
- **Risks:** Bloats the system prompt (already large after Task 6-a). Mitigate: 3 examples max; each ~30 lines.

### T8. Reference-Image RAG (Brand Inspiration Retrieval)
- **Source:** ImageRAG paper (arXiv 2502.09411): *"dynamically retrieves relevant images based on a given text prompt, and uses them as context to guide the generation process. Training-free framework."*; v0 `Inspect Site` tool + image attachments; Lovable image attachments + `imagegen`; Bolt image search.
- **What it does:** When the user prompt mentions a domain ("fintech dashboard", "saas landing page"), retrieve 1-2 reference images from a local library of brand-inspiration images (Apple, Vercel, Linear, Stripe, Notion, Spotify, Airbnb — the dormant skills per Task 6-a note). Embed the reference image as a base64 inline image in the VLM critic call (T3) OR as a textual description in the design brief (T1).
- **Production usage:** ImageRAG: training-free, dynamic retrieval. v0: image attachments + Inspect Site. Lovable: imagegen + web_search for real-world refs.
- **AgentCanvas integration:**
  - The ~150 dormant skills in `skills/` already include brand-inspiration skills (Apple, Vercel, Linear, GitHub, Notion, Spotify — per Task 6-a worklog). These are TEXT descriptions of brand design languages, not images.
  - Extend the `loadFileSkills()` allowlist in `file-skills.ts` to include 1-2 brand-inspiration skills based on a keyword match with the user prompt. (e.g. "minimalist" → Vercel, "premium" → Apple, "developer" → Linear, "warm" → Notion).
  - Or: build a small image library (~20 curated PNG screenshots of beautiful UIs) at `src/lib/agent/ref-images/`, with a small keyword index. At design-brief generation (T1), pick 1-2 images based on brief keywords, embed as base64 in the VLM critic call.
- **Complexity:** High. ~300 LOC (retrieval index + embedding pipeline + image library curation).
- **Impact:** Medium-High. "Reference-guided" generation is well-evidenced for design tasks.
- **Risks:** Image library curation is manual labor. Storage. Copyright on reference images. Mitigate: use the existing brand-inspiration skills as TEXT (much lower effort); defer image RAG to a future task.

### T9. 5-Step Orchestration Loop (Lovable-Style)
- **Source:** Lovable architecture deep-dive (TechAhead): *"The AI agent runs a five-step orchestration loop: (1) Goal and Boundaries (Task Spec), (2) Context Collection (Task Context), (3) Planning and Generation (Change Set), (4) Build and Preview, (5) Feedback Loop (Next Cycle)."* Plus Lovable's key design strategies: "Prompt structure: Clear, specific task framing significantly improves generation quality. Context management: Processes recent messages. Test harness: Generated code is validated before deployment to preview. Incremental building: Start small and build in increments."
- **What it does:** Re-architect `runner-native.ts` to explicitly model the 5 steps as named phases, with the Feedback Loop (Step 5) being where T2 (self-critique loop) plugs in.
- **Production usage:** Lovable's 5-step loop is explicit and confirmed by the architecture deep-dive.
- **AgentCanvas integration:**
  - Refactor `runner-native.ts` to add phase markers (`agent:phase` events): `phase:goal_setting` → `phase:context_collection` → `phase:planning` → `phase:build` → `phase:feedback`.
  - Step 1 (Goal) — emit `agent:phase` event, ask the agent to restate the user's intent in 1 sentence (forces grounding).
  - Step 2 (Context) — already done (canvas snapshot + skill metadata + file skills).
  - Step 3 (Plan) — already done (planner.ts); optionally merge with T1's design brief.
  - Step 4 (Build) — the pi-ai agent session loop (already done).
  - Step 5 (Feedback) — T2's self-critique loop plugs in here.
  - This is largely a refactor of the existing flow into named phases — most of the work is the events + UI parity, not new logic.
- **Complexity:** Medium. ~200 LOC (phase events + translator updates + UI parity). Most of the logic already exists; this is naming + ordering.
- **Impact:** Medium. Doesn't fix UI quality directly, but makes the architecture match production tools and gives T1/T2/T3 clean plug-in points.
- **Risks:** UI/translator churn — the React side needs to render the new phase events. Coordinate.

### T10. Pre-Complete Validation Gate
- **Source:** Lovable: *"Test harness: Generated code is validated before deployment to preview."* v0: *"Final Rule: Ship something interesting rather than boring, but never ugly."* Bolt: *"Bolt automatically tests, refactors, and iterates reducing errors."*
- **What it does:** Before the agent's final message is yielded, run a structured validator over the current canvas: (a) fidelity gate — at least 1 shadow, at least 1 gradient (or no hero), <50% gray fills, 0 placeholder texts ("Lorem", "Item 1", "Label"); (b) token-binding gate — >50% of shapes have a `$variable` binding; (c) typography gate — at least 2 distinct fontSizes, letterSpacing applied to at least 1 heading; (d) completion gate — at least 3 shapes (not a single rectangle). If any gate fails, inject a system reminder "VALIDATION FAILED: <list>. Fix before declaring done." and re-enter the agent loop (similar to T2).
- **Production usage:** Lovable explicitly has a test harness before preview; v0's prompt enforces the "Final Rule"; Bolt auto-tests.
- **AgentCanvas integration:**
  - The validator runs in `runner-native.ts` after the agent emits its final message, BEFORE yielding the final message to the user.
  - Reuse the fidelity summary already computed in `design-critic.ts` `serializeCanvasForCritic` (lines 240-256) — extract to a shared helper `computeFidelityScore(canvas)`.
  - If any gate fails AND iterations < MAX_DESIGN_CRITIQUE_ITERATIONS, inject the failure as a system reminder and re-run.
- **Complexity:** Low-Medium. ~150 LOC (validator + integration with T2's loop).
- **Impact:** Medium. Catches the "single bare rectangle and done" failure mode that the smoke test in Task 6-b explicitly noted.
- **Risks:** Could over-reject legitimate minimal designs (e.g. "draw a single red square" — the user explicitly asked for one shape). Mitigate: gate only fires when the prompt implies a "design" task (use the classifier's category — skip for `category === 'simple'`).

### T11. Version Switcher / Multi-Alternative Generation
- **Source:** Bolt.new stunning guide: *"Design directly in code… In Bolt.new, you can ask for multiple versions of the same landing page and switch between them. Prompt: suggest 3 great UI alternatives for this landing page — let's make one where the entire page is sort of 'framed' inside a cool full-page container. Let's try all three and create a version switcher in the bottom-right corner."*
- **What it does:** For complex design prompts (classifier category = `multi` or `dashboard`), generate 2-3 alternative designs in parallel branches, show them side-by-side, let the user pick. Each alternative runs T1 (brief) with a different "mood" seed.
- **Production usage:** Bolt explicitly ships this. v0 has Version Box. Lovable has Visual Edits.
- **AgentCanvas integration:**
  - Significant new UI work — a "branches" panel showing 2-3 alternative canvases.
  - Runner spawns N parallel agent sessions (each with a different brief seed), collects the canvases, presents them.
  - Out of scope for a single-pass implementation; mention as a future direction.
- **Complexity:** Very High. ~600+ LOC + significant UI work.
- **Impact:** Medium (mostly affects iteration speed, not first-pass quality).
- **Risks:** Cost multiplier (N× the LLM calls). Out of scope for the immediate improvement pass.

### T12. Reflection Pattern with Reflexion-Style Citations
- **Source:** LangChain Reflexion (Shinn et al.): *"The actor agent explicitly critiques each response and grounds its criticism in external data. It is forced to generate citations and explicitly enumerate superfluous and missing aspects of the generated response."*
- **What it does:** Upgrade the existing `design-critic.ts` system prompt to force the critic to (a) enumerate "MISSING:" (aspects absent from the design that should be present — e.g. "MISSING: footer", "MISSING: CTA"), (b) enumerate "SUPERFLUOUS:" (extra shapes that don't serve the design — e.g. "SUPERFLUOUS: 3rd badge with no clear purpose"), (c) cite specific shape IDs/names for every finding.
- **Production usage:** Reflexion paper shows explicit enumeration + grounding improves reflection quality vs. basic reflection.
- **AgentCanvas integration:**
  - Update `CRITIC_SYSTEM_PROMPT` in `src/lib/agent/subagents/design-critic.ts` to add the MISSING/SUPERFLUOUS/citation requirements. ~40 lines of prompt edits.
- **Complexity:** Low. ~40 LOC of prompt edits.
- **Impact:** Low-Medium. Improves critic quality; doesn't change the architecture.
- **Risks:** None. Pure prompt edit.

---

## 5. Recommended Implementation Order — Ranked by Impact / Complexity

| Rank | Technique | Impact | Complexity | Ratio | Files to touch |
|---|---|---|---|---|---|
| 1 | **T1 Pre-Generation Design Brief** | High | Medium | HIGH | new `subagents/design-brief.ts`, `tools.ts` (new tool), `runner-legacy.ts` (prompt section), `runner-native.ts` (dispatch step) |
| 2 | **T2 Mandatory Self-Critique Loop with MAX_ITERATIONS** | High | Medium-High | HIGH | `runner-native.ts` (post-final wrapper loop), `agent-session-translator.ts` (new `agent:critique` event), `runner-legacy.ts` (mirror for parity) |
| 3 | **T3 VLM Screenshot Critique** | High | High | MEDIUM-HIGH | new `subagents/design-critic-vlm.ts`, `tools.ts` (new tool), new `src/lib/canvas/render-to-png.ts`, new npm dep `@resvg/resvg-js` |
| 4 | **T4 Design-Token Enforcement** | Medium-High | Low-Medium | MEDIUM-HIGH | `tools.ts` `coerceShapeInput` validation, `runner-legacy.ts` (recipe rewrites to use $variables) |
| 5 | **T10 Pre-Complete Validation Gate** | Medium | Low-Medium | MEDIUM | `runner-native.ts` (validator after final message), reuse fidelity helpers from `design-critic.ts` |

### 5.1 Honorable mentions (defer)
- **T7 Few-Shot Full-Canvas Examples** — high impact, low complexity, but bloats the prompt. Defer to a follow-up pass after T1-T4 land and we can measure the delta.
- **T12 Reflexion-Style Citations** — pure prompt edit, low effort. Quick win if budget allows. (~40 LOC)
- **T5 Hard Caps on Color/Font Count** — low effort but risks over-rejection. Defer until T4 (token enforcement) is stable.
- **T6 Prompt Vocabulary Steering** — trivial. Quick add to T1's brief generator. (~30 LOC)
- **T9 5-Step Orchestration Loop Refactor** — architectural; mostly naming. Defer until T1+T2 are stable.
- **T8 Reference-Image RAG** — high effort (image curation). Defer.
- **T11 Version Switcher** — out of scope for this improvement pass.

### 5.2 Why these 5 are the right next step given what's already shipped

**Task 6-a shipped prompt sections.** That's the baseline. But the Vercel community thread proves prompt-only interventions decay: v0's prompt is 2000+ lines and users STILL complain about "stacked blocks with placeholder text". The 5 recommended techniques address the architectural gap, not the prompt gap:

- **T1 (pre-brief)** forces the agent to "think before it draws" — addresses the "first call is a bare rectangle" failure (the smoke test in Task 6-b noted this exact failure mode).
- **T2 (mandatory loop)** ensures the agent can't declare done on a wireframe — addresses the "opt-in critic gets skipped" gap.
- **T3 (VLM critique)** addresses the text-critic's blind spots (alignment, whitespace, "looks generic") — the single biggest differentiator vs v0/Lovable.
- **T4 (token enforcement)** addresses the "5 different blues" failure mode that the recipes (which use raw hex) actually ENCOURAGE.
- **T10 (validation gate)** catches the edge case where the agent emits 1-2 shapes and calls it done.

T1+T2+T10 form a coherent "brief → build → critique → validate" pipeline — Lovable's 5-step loop in miniature. T3 is the quality multiplier on top of T2. T4 is a guardrail that prevents palette drift across all of the above.

### 5.3 Implementation sketches

#### T1 sketch (Pre-Generation Design Brief)
```typescript
// src/lib/agent/subagents/design-brief.ts (NEW)
// Mirrors design-critic.ts structure.
const BRIEF_SYSTEM_PROMPT = `You are a senior design director producing a creative brief for a canvas design.
Given a user's request, produce a 1-paragraph "design north-star" with:
- MOOD: 3-5 words from {Premium, Subtle, Minimalistic, Aesthetic, Composed, Tactile, Cinematic, Surprising, Calm, Bold}.
- COLOR RAMP: pick one of {Sky, Violet, Emerald, Amber, Rose, Indigo} + the use of each shade.
- TYPOGRAPHY: 2 font families max (one display, one body) + the type scale to use.
- LAYOUT PATTERN: 1 sentence (e.g. "asymmetric hero + 3-card bento + footer CTA").
- REFERENCES: 2-3 brand inspirations from {Apple, Vercel, Linear, Stripe, Notion, Spotify, Airbnb, GitHub} + 1-sentence why.
- ANTI-PATTERNS: 2 things to explicitly AVOID (e.g. "don't stack 4 feature cards in a row", "don't use emoji icons").
Return as a JSON block: \`\`\`json {...}\`\`\`.`;
export async function dispatchDesignBriefSubAgent(params) { /* mirrors design-critic.ts */ }

// src/lib/agent/tools.ts (add near line 3197)
const generateBrief = defineTool({
  name: 'pen_generate_design_brief',
  description: 'Dispatch the design-brief sub-agent BEFORE any pen_create_shape. Returns a structured creative brief (mood, color ramp, typography, layout, references, anti-patterns). Use this brief as your design north-star.',
  parameters: Type.Object({ prompt: Type.String() }),
  async execute(_id, params) {
    const { dispatchDesignBriefSubAgent } = await import('./subagents/design-brief');
    return dispatchDesignBriefSubAgent({ task: 'brief', originalPrompt: params.prompt, ... });
  },
});

// src/lib/agent/runner-native.ts (between step 7 web-research and step 8 build-system-prompt)
let designBrief: SubAgentResult | undefined;
if (classification.category !== 'simple' /* skip for trivial single-shape tasks */) {
  designBrief = await dispatchDesignBriefSubAgent({ task: 'brief', originalPrompt: prompt, canvas, llm: subAgentLLM });
  yield { kind: 'agent_event', event: { type: 'agent:design_brief', summary: designBrief.summary } };
}
// at step 11, append designBrief.summary to the user message (like web-research summary injection)
```

#### T2 sketch (Mandatory Self-Critique Loop)
```typescript
// src/lib/agent/runner-native.ts (after the agent session loop yields its final message)
const MAX_DESIGN_CRITIQUE_ITERATIONS = settings?.maxDesignCritiqueIterations ?? 2;
let critiqueIter = 0;
let critiqueSummary = '';
let lastScore = 11;
while (critiqueIter < MAX_DESIGN_CRITIQUE_ITERATIONS) {
  const critique = await dispatchDesignCriticSubAgent({ canvas, originalPrompt: prompt, llm: subAgentLLM });
  critiqueSummary = critique.summary;
  yield { kind: 'agent_event', event: { type: 'agent:critique', iteration: critiqueIter, summary: critique.summary } };
  const score = parseScoreFromSummary(critique.summary);
  const hasBlockers = /\[BLOCKER\]/i.test(critique.summary);
  if (!hasBlockers && score >= 7) break;
  if (score >= lastScore) break; // no improvement — stop
  lastScore = score;
  // re-enter the agent loop with the critique as a new user message
  // (re-invoke createAgentSession with the appended userMessage)
  // [implementation: refactor the agent session into a callable function
  //  that takes a userMessage and yields events; call it again with the
  //  critique appended.]
  critiqueIter++;
}
```

#### T3 sketch (VLM Screenshot Critique)
```typescript
// src/lib/canvas/render-to-png.ts (NEW)
import { Resvg } from '@resvg/resvg-js';
export function renderCanvasToPng(canvas: CanvasDocument): Buffer {
  const svg = renderCanvasToSvgString(canvas); // extract from Canvas.tsx
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: 1024 } });
  return resvg.render().asPng();
}

// src/lib/agent/subagents/design-critic-vlm.ts (NEW)
import ZAI from 'z-ai-web-dev-sdk';
import { renderCanvasToPng } from '../../canvas/render-to-png';
const VLM_SYSTEM_PROMPT = `You are a senior visual designer reviewing a screenshot of a canvas design.
You see the RENDERED output — not the schema. Critique what you SEE:
- Alignment drift (elements off-grid by even 1-2px).
- Whitespace balance (cramped vs premium-empty).
- Visual hierarchy (does the most important element POP?).
- "Generic AI look" (stacked blocks, default fonts, no texture/material).
- Color harmony (do the chosen colors look good together?).
- Typography rhythm (line-height, heading scale).
Output: CRITIQUE: with [BLOCKER]/[MAJOR]/[MINOR] tags, then SCORE: 1-10.`;
export async function dispatchDesignCriticVLMSubAgent(params) {
  const zai = await ZAI.create();
  const png = renderCanvasToPng(params.canvas);
  const base64 = png.toString('base64');
  const response = await zai.vision.chat.create({
    messages: [
      { role: 'system', content: VLM_SYSTEM_PROMPT },
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
        { type: 'text', text: `Original prompt: ${params.originalPrompt}` }
      ]}
    ]
  });
  return { summary: response.choices[0].message.content, toolCalls: 1, success: true };
}

// src/lib/agent/tools.ts (add near pen_self_critique)
const visualCritique = defineTool({
  name: 'pen_visual_critique',
  description: 'Render the current canvas to a PNG and dispatch a VLM (vision LLM) to critique the RENDERED output. Catches issues the text-only pen_self_critique cannot: alignment drift, whitespace balance, "generic AI look".',
  parameters: Type.Object({}),
  async execute(_id, _params) {
    const { dispatchDesignCriticVLMSubAgent } = await import('./subagents/design-critic-vlm');
    return dispatchDesignCriticVLMSubAgent({ task: 'vlm-critique', originalPrompt: '', canvas: ctx.getDocument?.() });
  },
});
```

#### T4 sketch (Design-Token Enforcement)
```typescript
// src/lib/agent/tools.ts coerceShapeInput (around line 195)
const RAW_HEX_RE = /^#?[0-9a-fA-F]{3,8}$/;
const VARIABLE_RE = /^\$.+/;
function validateColor(value: string | undefined, field: string) {
  if (!value) return;
  if (RAW_HEX_RE.test(value) && !VARIABLE_RE.test(value)) {
    throw new ToolError(
      `Raw hex '${value}' in ${field} not allowed. Bind to a $variable first (pen_set_variable) or use $color.primary / $color.surface / $color.text / $color.bg / $color.accent / $color.primary-{50..900}. See PRIMARY COLOR 50-900 RAMPS in the system prompt.`,
      'DESIGN_TOKEN_VIOLATION'
    );
  }
}
// in coerceShapeInput:
if (settings?.enforceDesignTokens) {
  validateColor(input.fill, 'fill');
  validateColor(input.stroke, 'stroke');
  validateColor(input.textColor, 'textColor');
  if (input.shadow) validateColor(input.shadow.color, 'shadow.color');
  if (input.gradient) input.gradient.stops.forEach(s => validateColor(s.color, 'gradient.stop.color'));
}

// runner-legacy.ts COMPONENT RECIPES — rewrite raw hex to $variables:
// BEFORE:  fill:"#0ea5e9",
// AFTER:   fill:"$color.primary-500",
// BEFORE:  gradient:{type:"linear", angle:135, stops:[{offset:0,color:"#0ea5e9"},{offset:1,color:"#6366f1"}]}
// AFTER:   gradient:{type:"linear", angle:135, stops:[{offset:0,color:"$color.primary-500"},{offset:1,color:"$color.accent-500"}]}
```

#### T10 sketch (Pre-Complete Validation Gate)
```typescript
// src/lib/agent/validators.ts (NEW)
export interface FidelityScore {
  shapesCount: number;
  shapesWithShadow: number;
  shapesWithGradient: number;
  grayFills: number;
  placeholderTexts: number;
  distinctFontSizes: number;
  distinctColors: number;
  tokenBoundShapes: number;
}
export function computeFidelityScore(canvas: CanvasDocument): FidelityScore {
  // extract from design-critic.ts serializeCanvasForCritic lines 240-256
}
export function validateForCompletion(canvas: CanvasDocument, category: SkillCategory): { pass: boolean; failures: string[] } {
  if (category === 'simple') return { pass: true, failures: [] }; // skip for trivial
  const s = computeFidelityScore(canvas);
  const failures: string[] = [];
  if (s.shapesCount < 3) failures.push('Design has fewer than 3 shapes — looks incomplete');
  if (s.shapesWithShadow === 0) failures.push('No shape has a shadow — looks flat (wireframe)');
  if (s.shapesWithGradient === 0 && s.shapesCount > 5) failures.push('No gradient on any shape — add a gradient to hero/CTA');
  if (s.grayFills > s.shapesCount * 0.5) failures.push('Majority of shapes are gray — looks like a wireframe');
  if (s.placeholderTexts > 0) failures.push(`${s.placeholderTexts} text shapes have placeholder content (Lorem/Item/Label)`);
  if (s.distinctFontSizes < 2) failures.push('Less than 2 distinct font sizes — no typographic hierarchy');
  if (s.tokenBoundShapes < s.shapesCount * 0.3) failures.push('<30% of shapes are token-bound — use $variables for colors');
  return { pass: failures.length === 0, failures };
}

// runner-native.ts (after agent final message, before yielding it)
const validation = validateForCompletion(canvas, activeCategory);
if (!validation.pass && critiqueIter < MAX_DESIGN_CRITIQUE_ITERATIONS) {
  // inject validation failures as system reminder and re-enter agent
  userMessage += `\n\n=== VALIDATION FAILED ===\n${validation.failures.map(f => `- ${f}`).join('\n')}\n=== END VALIDATION ===\nFix these before declaring done.`;
  // re-run agent session
}
```

---

## 6. The Single Highest-Leverage Finding

**v0, Lovable, and Bolt all run an explicit feedback loop (Lovable's 5-step loop Step 5) and/or a design-brief pre-step (v0's `GenerateDesignInspiration` tool). AgentCanvas has NEITHER — the existing `pen_self_critique` is OPT-IN with no `MAX_ITERATIONS` and no pre-brief step. The Task 6-a prompt-only intervention is necessary but not sufficient; production tools couple their prompt with architectural enforcement (pre-brief + post-critique loop + VLM feedback).**

The Vercel community thread (Aug 2025) is the killer evidence: v0's prompt is 2000+ lines (much bigger than ours) and users STILL report "the AI just throws random blocks on the page without any taste or structure". Prompt-only interventions decay. The architectural enforcement is what holds the line.

---

## 7. Should the Implementation Subagent Do All 5 in One Pass, or Top 1-2 First?

**Recommendation: implement T1 + T2 first as a coherent pair, then measure, then add T3 + T4 + T10 in a second pass.**

Rationale:
- **T1 + T2 form a coherent "brief → build → critique → refine" pipeline** (Lovable's 5-step loop in miniature). They share infrastructure (sub-agent dispatch pattern, runner integration point). Implementing them together saves refactor churn.
- **T3 (VLM critique) is the highest-impact single technique but also the highest-complexity** (new npm dep `@resvg/resvg-js`, PNG render pipeline, vision API integration, base64 image encoding, rate-limit handling). It deserves a focused implementation pass after T1+T2 are stable, with the Task 7-a VLM critique loop as the test harness.
- **T4 (token enforcement) is a breaking change** — the existing test fixtures use raw hex. It needs coordination with the test suite. Defer to a third pass after T1+T2 land cleanly.
- **T10 (validation gate) depends on T2's loop infrastructure** (it's a sibling check that runs alongside the critique loop). Land it after T2 is stable.

**Sequencing recommendation for the implementation subagent:**

| Pass | Techniques | Estimated LOC | Test harness |
|---|---|---|---|
| Pass 1 (immediate) | T1 + T2 | ~400 | Task 7-a VLM critique loop + existing 470 tests |
| Pass 2 (after Pass 1 lands + measured) | T3 + T10 | ~550 | Task 7-a VLM critique loop (extended) |
| Pass 3 (after Pass 2 stable) | T4 + T12 (quick win) | ~160 | Update test fixtures to use $variables |

This sequencing keeps each pass under ~600 LOC, lands the highest-impact pair first, and respects the architectural dependency: T10 needs T2's loop, T3 needs a stable critique pattern to plug into.

---

## 8. Key Insight (Why Task 6-a's Prompt-Only Approach Isn't Enough)

The Vercel community thread (Aug 2025) is the smoking gun: v0's prompt is ~2000+ lines (we have ~600 lines of design sections), and v0 users STILL report "the AI just throws random blocks on the page without any taste or structure, sections feel disconnected, components look like basic UI kits, barely any animation or structure, stacked blocks with placeholder text and colored backgrounds". This is EXACTLY what AgentCanvas users are reporting. The lesson: prompt-only interventions decay. Production tools ship their prompt WITH architectural enforcement: v0's `GenerateDesignInspiration` tool called before every design task, Lovable's explicit 5-step orchestration loop with Step 5 = Feedback, Bolt's "automatically tests, refactors, and iterates" loop. AgentCanvas has a rich prompt (Task 6-a) and an opt-in critic (`pen_self_critique`), but no architectural enforcement: the agent can skip the critic, ignore the recipes, and emit a single bare rectangle as its final answer. The 5 recommended techniques (T1 pre-brief + T2 mandatory critique loop + T3 VLM critique + T4 token enforcement + T10 validation gate) close the architectural gap. They are the difference between a tool whose prompt is "really good design guidance" and a tool whose architecture MAKES the agent produce good design.

---

## 9. Appendix — Source URLs (canonical for the implementation subagent to revisit)

### Leaked production prompts (most important — read these before implementing T1/T4)
- v0 system prompt: https://raw.githubusercontent.com/x1xhlol/system-prompts-and-models-of-ai-tools/main/v0%20Prompts%20and%20Tools/Prompt.txt (45KB, 2000+ lines)
- Lovable agent prompt: https://raw.githubusercontent.com/x1xhlol/system-prompts-and-models-of-ai-tools/main/Lovable/Agent%20Prompt.txt (20KB)
- More leaked prompts in the same repo (Cursor, Bolt, Devin, Manus): https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools

### Architecture deep-dives
- Lovable's 5-step orchestration loop: https://www.techaheadcorp.com/blog/inside-lovable-backend-design-system-architecture-ai-agent-orchestration-explained
- LangChain reflection agents (Basic Reflection + Reflexion + LATS): https://www.langchain.com/blog/reflection-agents
- Agent Patterns reflection (Generate-Reflect-Refine cycle, MAX_ITERATIONS): https://agent-patterns.readthedocs.io/en/stable/patterns/reflection.html

### User-complaint threads (validate the "prompt-only decays" thesis)
- Vercel community on v0 quality dropping: https://community.vercel.com/t/is-it-just-me-or-has-the-ui-quality-in-v0-gotten-worse/17893
- Bolt stunning guide (vocabulary + 6 techniques): https://bolt.new/blog/how-to-create-stunning-websites-with-bolt

### VLM critique (for T3)
- Reddit visual verification as feedback loop: https://www.reddit.com/r/MachineLearning/comments/1rrzwp9/p_visual_verification_as_a_feedback_loop_for_llm_code
- ScreenAgent paper (IJCAI 2024): https://www.researchgate.net/publication/382789674_ScreenAgent_A_Vision_Language_Model-driven_Computer_Control_Agent
- UI-Pro paper: https://openreview.net/forum?id=5wmAfwDBoi
- HuggingFace VLMs 2025: https://huggingface.co/blog/vlms-2025

### RAG / Reference-image (for T8 — deferred)
- ImageRAG paper: https://arxiv.org/html/2502.09411v1
- OpenAI Image Understanding with RAG: https://developers.openai.com/cookbook/examples/multimodal/image_understanding_with_rag

### Simon Willison's analysis
- Leaked v0 prompts commentary: https://simonwillison.net/2024/Nov/25/leaked-system-prompts-from-vercel-v0

---

**End of report. Full path: `/home/z/my-project/download/ui-improvement-research.md` (this file).**
