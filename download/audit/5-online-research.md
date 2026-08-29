# Best-Practices Research Report: AI Design-Generation Agents & Collaborative Canvas Apps

**Task ID:** 2-e · **Type:** Online research (no project code touched)
**Date:** 2026-08-30
**Method:** Grounded in existing prior research (`scripts/research/`, `download/agent-durability-research.md`, `download/canvas-durability-research.md`), then 17 fresh web searches + 10 full-page fetches (Anthropic engineering, Figma blog/help, Progress, EclipseSource, Brian Love, TechAhead, Lovable/v0 leaked prompts). Raw snapshots: `download/audit/search-1..17.json`, `download/audit/page-1..10*.json`.
**Goal:** Better design output quality + better agent↔canvas interaction for AgentCanvas.

---

## Part 1 — Per-product analysis

### 1.1 v0 (Vercel) — constraints-as-law + design brief before design work
**Sources:** leaked system prompt (`scripts/research/page-01-v0-prompt.json`, 45K tokens, current to May 2026), fresh searches 1, prior durability research §3.2.

- **How generation is structured:** Full agentic loop (tools: Glob/Grep/Read/Write/Edit/Bash in a Linux VM, preview with HMR). Two things stand out for design quality:
  - **`GenerateDesignInspiration` tool is mandatory before ANY design work** — generates a detailed visual spec/creative direction (unique palette, typography, layout concept) first, then implements against it. Final rule: *"Ship something interesting rather than boring, but never ugly."*
  - **Hard design constraints as law:** exactly 3–5 colors (1 primary + 2–3 neutrals + 1–2 accents; never prominent purple/violet), max 2 font families, body line-height 1.4–1.6, no decorative fonts <14px, semantic design tokens only (`bg-background`, never raw hex), Tailwind spacing scale (never `p-[16px]`), flexbox→grid priority (never absolute unless necessary), no gradients unless requested, never emojis as icons, mobile-first, no abstract blob filler.
- **Quality enforcement:** few-shot "Alignment" examples (~12) showing exact expected thought/tool-trace format; plan mode (`EnterPlanMode`) + `TodoManager` + `AskUserQuestions` for large tasks; self-verification via runtime feedback (`console.log("[v0]…")` → read debug log, skip stale errors by timestamp).
- **Context economy:** old tool results auto-compressed ("Content omitted to save context") with retrieval paths; parallel tool calls mandated where independent.
- **Counter-signal (important!):** Vercel Community (Aug 2025, `page-07-v0-quality.json`): when constraints/quality guardrails loosen, output collapses into "stacked blocks with placeholder text" — 1.4k views, 33 likes. **The constraints ARE the product.**
- **Adopt:** pre-generation design brief step; hard numeric design constraints; few-shot trace exemplars; runtime-feedback self-verification; context compression.

### 1.2 Lovable (ex-GPT Engineer) — closed-loop planning + design-system absolutism
**Sources:** leaked agent prompt (`page-02-lovable-agent.json`), TechAhead architecture deep-dive (fetched, `page-6-lovable-arch.json`), search 2.

- **Architecture:** five-step orchestration loop — **goal-setting → context collection → change-set planning → build-and-preview → feedback loop** feeding the next cycle. "Treats development as a closed loop rather than one-shot generation."
- **Prompt discipline:** ordered required workflow (check useful-context → tool review → **default to discussion** → THINK & PLAN → clarify → gather → implement → verify & conclude). THINK & PLAN contract: restate what the user is ACTUALLY asking; define EXACTLY what will change and what remains untouched; minimal-but-correct approach. Anti-pitfalls: OVERENGINEERING, SCOPE CREEP, MONOLITHIC FILES, DOING TOO MUCH AT ONCE, sequential calls that could be batched.
- **Quality enforcement:** *"CRITICAL: The design system is everything"* — never custom styles in components; semantic tokens only; customize shadcn components via variants; "Beautiful designs are your top priority — edit index.css/tailwind.config as often as necessary to avoid boring designs." Dark/light-mode contrast is called out as a known failure mode ("you often make mistakes having white text on white background").
- **UX:** chat left + live preview right; point-and-edit Visual Edits; Agent Mode for autonomous multi-step work; error escalation ladder (auto-fix → investigate → revert to older version → edit past message).
- **Adopt:** plan contract with change/no-change scope; design-system-first law; verify-and-conclude step; revert-to-previous-version affordance.

### 1.3 Bolt.new — anti-"AI-slop" design vocabulary + durability machinery
**Sources:** Bolt blog "How to create stunning websites in 2026" (`scripts/research/page-09-bolt-stunning.json`), support.bolt.new "Prompt effectively" (search 3), bolt.diy analysis in prior durability research §3.1.

- **2026 design guidance:** the baseline one-prompt result is now "really good" (dynamic layout shifts, intentional hover animations, modern spacing, rounded corners) — so to stand out you must go beyond "competent": **cinematic, tactile, composed, surprising, alive**. Explicit anti-AI-slop list: heavy gradients everywhere, rigid cookie-cutter grids, emoji overuse, repetitive section order (features→pricing→testimonials→CTA), generic fonts.
- **Engineering:** model routing per task; auto-tests/refactor/iterate loops; bolt.diy (OSS) contributes the durability toolkit already mined in prior research (watchdog, SwitchableStream auto-continue, selectContext, IndexedDB rewind, typed error envelopes).
- **Adopt:** anti-slop vocabulary in the design-brief step; motion/depth hints; avoid defaulting to the same section order.

### 1.4 Figma (agent + Make + First Draft + MCP) — the canvas-native reference
**Sources:** fetched `figma.com/blog/the-figma-agent-is-here` (page-2), `the-figma-canvas-is-now-open-to-agents` (page-3), help article "Work with the Figma agent" (page-8); prior `r2-figma-agent-tooling.md` (239-line verified inventory).

- **Figma agent (May 20, 2026):** first-party, canvas + left-rail, "fine-tuned for editing Figma files." Key mechanics:
  - **Prompt from any layer** — select a layer → Agents → on-canvas prompt box (Cmd/Ctrl+Enter).
  - **Parallel prompts** — start a prompt on one frame, move to the next; each running prompt shows an **animated loading indicator on the canvas**; click it to open a chat window with steps completed + result; keep riffing.
  - **Design-system steering:** uses your most frequently/recently used components as starting point; **@-mention tokens, variables, components** in prompts ("a key command for your design system"); connect libraries as chat context.
  - **Edit while the agent edits**; **Undo in chat** or Cmd+Z to revert the most recent agent change; side-by-side compare before undo (duplicate → undo original).
  - Bulk busywork: rename variables, swap component across screens, padding change across a flow, realistic content fill, dark-mode conversion, library documentation.
  - **Exploration framing:** "The best designs rarely come from the first idea — or the first prompt." Go wide (3 distinct stylistic approaches, multiple IAs) then deep (iterate, compare, stay aligned with DS). "Once you've chosen a direction, hands-on is often faster and more token-efficient than prompting your way to the ideal output."
- **Figma Make:** conversational agent → working React app; **checkpoints = version history** (preview/favorite/restore every AI and manual edit); point-and-edit toolbar + properties panel + element-anchored annotations; "go to source" jumps element→code; code edits reflect instantly.
- **First Draft (2024→folded into agent 2026):** composes from constrained Figma-built component libraries ("selects, arranges, customizes" — never free-form), style sliders (color/radius/spacing/typography) + light/dark toggle; output = fully editable native layers.
- **MCP surface (write):** `use_figma` — general-purpose write tool that **"checks your design system or existing content before creating from scratch"**; skills = markdown instruction files (`/figma-use` foundational + team-authored skills defining workflow, sequencing, conventions, "what good looks like").
- **Reads:** `get_design_context` returns **reference code + screenshot + embedded system prompt + asset URLs** ("a screenshot combined with code outputs performs better than either alone"); `get_metadata` = cheap sparse outline entry point; everything node-scoped; `get_variable_defs` for token fidelity; `search_design_system`/`get_libraries` to reuse before generating.
- **Adopt:** parallel prompt UI with on-canvas progress indicators; @-mention DS elements; per-change undo; checkpoints; DS-check-before-create; triangulated context; skills/rules files.

### 1.5 tldraw — provenance hierarchy & dual-channel context
**Sources:** prior durability research §3.5 (make-real clone), tldraw blog/docs + Ruiz talks (searches 6), prior `6b-tldraw/report.md`.

- **make-real lessons:** provenance hierarchy in prompt ("code = source of truth; canvas image = user's NEW changes; old screenshots = IGNORE") to prevent cross-iteration drift; validate-and-rollback (generated HTML <100 chars → delete shape + categorized toast); action sanitization layer (fix nonexistent IDs, unique IDs, normalized coords); determinism (temperature 0, seed 42); versioned prompt (`MIGRATION_VERSION = 13`).
- **tldraw AI docs:** **dual-channel canvas context** — viewport screenshot + simplified structured shape data + off-viewport cluster summaries + current selection + recent actions; "each channel covers the other's blindness."
- **Comments (not shapes) as the human↔agent channel** — threaded, pinned, resolvable.
- Ruiz's 2026 thesis: agents must leave the sidebar — the canvas is the interface to generative systems; multi-agent + multi-user coordination on one surface.
- **Adopt:** provenance rules in prompt; dual-channel context (already roadmap E1 — this research confirms its quality impact, not just token savings); comment-anchored agent communication.

### 1.6 Others found (2026 landscape)
**Source:** Progress "Designing on the Canvas, with Agents" (fetched, page-9) — the definitive mid-2026 map.

- **Google Stitch 2.0 (Mar 2026):** infinite canvas + agent that **reasons across the project's full history** (not just last prompt); multi-screen generation; voice-driven critique; exports to Figma/code. Weakness: generates from Google's models, not your library → generic output.
- **MagicPath:** the "Cursor moment for design" — real-time multiplayer canvas where humans and AI agents collaborate **with visible presence**; multiple AI agents working in parallel; prompt→canvas, image→canvas, code-to-design.
- **Pencil:** closest architectural cousin to AgentCanvas — **open JSON `.pen` files in Git** + local MCP server; Claude Code/Cursor/Codex read/write canvas files directly; agent reads underlying vector nodes (padding = 1rem, not guessed from PNG) → high-fidelity code mapping; design+code committed together.
- **Subframe:** canvas built from code-grade primitives (React+Tailwind components with props/variants, not vector approximations); auto-layout-only, 1280px max.
- **Framer 3.0 (Jun 2026):** agents act on live site project; **Branching to review/compare agent changes before publishing**; supports external agents (Claude, Codex, Cursor).
- **Claude Design (Anthropic):** ingests a design system, hands off to Claude Code — prompt-driven, limited canvas.
- **Cross-cutting thesis (Progress):** the shift is "the canvas is becoming a surface an agent can **read and write**, not just paint on." The design system is the shared contract. Quality of output tracks quality of the design system fed in: "well-structured tokens and components yield clean results; poorly structured files produce poor agent behavior."

---

## Part 2 — Cross-cutting best practices for design agents

1. **Hard design constraints as law** (v0 leaked prompt; v0 community counter-signal). → *AgentCanvas should:* encode non-negotiable numeric rules in the system prompt — ≤5 palette colors, ≤2 font families, 8px spacing grid, line-height 1.4–1.6, radius/size scale steps, semantic token references only (never raw hex except when defining the theme), no emoji-as-icons, no decorative blobs — AND enforce with a post-generation lint pass that auto-fixes violations.
2. **Design brief before any design work** (v0 `GenerateDesignInspiration`; Figma "go wide" framing). → *AgentCanvas should:* make the existing brief pre-generation mandatory and richer: named palette w/ hexes + roles, font pairing, spacing/radius scale, layout concept, anti-slop keywords (cinematic/tactile/composed), section structure that avoids the features→pricing→testimonials→CTA default.
3. **Visual self-critique grounded in external signal** (LangChain Reflection; r/MachineLearning visual-verification pattern; VLM critic exercise in `download/vlm-exercise/`). Best pattern: **a separate vision model that sees ONLY the rendered result, not the tool stream or code** — unbiased vs. self-critique. → *AgentCanvas should:* screenshot the rendered canvas (or export per-frame PNG) after generation and run the VLM critic on the image alone with a fixed rubric; agent applies ranked fixes; ≤2 iterations (already capped).
4. **Design-system-first: reuse before generate** (Figma `use_figma` checks DS first; First Draft composes from libraries; Lovable "design system is everything"; Progress: output quality tracks DS quality). → *AgentCanvas should:* require the agent to search existing components/themes/tokens first and prefer `pen_insert_component`/component refs over hand-built shapes; log DS-reuse ratio per run.
5. **Few-shot trace exemplars** (v0's ~12 Alignment examples; promptingguide few-shot consensus). → *AgentCanvas should:* add 8–12 curated ideal `pen_*` tool-trace examples (brief → theme/tokens → component refs → autolayout → realistic text → self-check) to the prompt.
6. **Consolidate tools; fewer, task-shaped, semantic** (Anthropic "Writing effective tools for agents", Sep 2025: more tools ≠ better; consolidate `list_users+list_events+create_event` → `schedule_event`; "SWE-bench SOTA after refining tool descriptions"; MCP-overload research: tool defs can eat >20% of context; arXiv 2602.14878: fuller tool descriptions help but cost overhead). → *AgentCanvas should:* audit the ~100 tools — promote compound, task-shaped tools (`pen_create_card`, `pen_apply_theme`, `pen_insert_screen_from_component`) for the hot path and keep micro-ops (`set_fill`…) as the long tail; treat tool descriptions as prompt engineering (unambiguous param names, examples, boundaries).
7. **Return semantic names, not opaque IDs** (Anthropic: resolving UUIDs → semantic names "significantly improves precision"). → *AgentCanvas should:* make every tool result echo human-meaningful node names/paths (and keep enforcing semantic naming of created shapes — feeds future turns AND any future design-to-code path).
8. **Triangulated, node-scoped context** (Figma `get_design_context` = code+screenshot+prompt+assets; tldraw dual-channel; Figma `get_metadata` cheap outline first). → *AgentCanvas should:* keep the digest-first pattern, add a viewport screenshot channel for visual tasks, and hydrate full node details on demand (`pen_read_node`) — this is roadmap E1, now confirmed as a *quality* lever, not just token savings.
9. **Plan contract with change/no-change scope** (Lovable THINK & PLAN; durability research C3). → *AgentCanvas should:* every multi-step turn opens with a plan naming exactly which shape IDs will change and which are untouched; emit `agent:plan` events; prompt rule "canvas state = source of truth; screenshots = verification only."
10. **Checkpoints, undo, and diff for every agent write** (Figma Make checkpoints preview/favorite/restore; Figma agent Undo-in-chat + duplicate-to-compare; Framer branching). → *AgentCanvas should:* snapshot per agent turn (exists), add one-click restore, and side-by-side compare of before/after for the agent's diff.
11. **Parallel, multi-variant exploration** (Figma agent parallel prompts + "go wide"; MagicPath multiple agents with visible presence). → *AgentCanvas should:* support "give me 3 style directions" producing 3 sibling frames each with its own mini-brief; render on-canvas progress indicators per running prompt; let user pick and then iterate deep.
12. **On-canvas, selection-anchored prompting** (Figma: select layer → Cmd+Enter; MCP desktop = selection-based scope). → *AgentCanvas should:* allow launching an agent prompt scoped to the current selection directly from the canvas, and @-mention components/tokens in the composer.
13. **Realistic content generation** (Figma "Replace text" + First Draft custom content; v0 "never placeholder images"). → *AgentCanvas should:* a mandatory final pass replacing placeholder text with realistic, varied copy (real-sounding names, cities, prices) — never repeated identical strings across cards.
14. **User-editable rules/skills file** (Figma skills markdown; Lovable LOVABLE.md governance; v0 Rules settings). → *AgentCanvas should:* a per-document `design-rules.md` (brand colors, fonts, tone, layout conventions) injected into the system prompt — let teams encode "what good looks like."
15. **Token-efficiency affordances in tools** (Anthropic: concise/detailed `response_format`, 25K caps, pagination; programmatic tool calling to batch multi-tool workflows). → *AgentCanvas should:* offer concise tool results by default with an on-demand detail flag; keep the 25K truncation; consider a "batch" tool that applies a list of patches in one call (cuts round trips for dense layouts).

---

## Part 3 — Top 12 prioritized recommendations

Ranked by expected impact on (a) design output quality and (b) agent-canvas interaction experience.

1. **Mandatory richer design brief step.** Before any `create_shape`, the agent must emit a structured brief: palette (≤5 hexes + semantic roles), font pairing, spacing/radius scale, layout concept, anti-slop style keywords, non-default section order. Render it as an editable card in chat so users can tweak before generation. *(v0 GenerateDesignInspiration; Bolt anti-slop vocabulary.)*
2. **Hard constraints + automatic lint/fix pass.** Encode v0's numeric rules (colors ≤5, fonts ≤2, 8px grid, line-height 1.4–1.6, tokens-only fills, no emoji icons) in the prompt AND as a deterministic post-generation validator that auto-corrects violations (snap to grid, swap raw hex → nearest theme token) and reports what it fixed. *(v0 prompt; v0 community counter-signal proves guardrails are the product.)*
3. **Unbiased VLM critique on rendered output.** After generation, screenshot the canvas/frames and run a vision critic that sees ONLY the image (never the tool stream) with a fixed rubric (alignment, spacing consistency, contrast, hierarchy, realism of content, overlap/overflow); return a ranked fix list the agent executes. *(r/MachineLearning visual-verification pattern; existing vlm-exercise infrastructure.)*
4. **Design-system-first generation with reuse accounting.** Agent must query existing components/themes/tokens before creating geometry; prefer component refs; surface a "reuse ratio" per run. *(Figma `use_figma` DS-check; First Draft; Lovable.)*
5. **Few-shot pen\_\* trace exemplars.** Add 8–12 curated ideal traces (brief → theme → components → autolayout → realistic copy → self-check) to the system prompt. *(v0 Alignment examples.)*
6. **Compound tools + semantic tool results.** Introduce task-shaped compound tools for hot paths (`pen_create_card`, `pen_apply_theme`, `pen_insert_component_tree`) above the ~100 micro-ops; rewrite tool descriptions as prompt engineering (unambiguous names, examples, boundaries); all tool results echo semantic node names, not just IDs. *(Anthropic writing-tools-for-agents.)*
7. **Dual-channel context with screenshot channel.** Ship roadmap E1: digest + selection + off-viewport summary + **viewport screenshot for visual tasks** + `pen_read_node` hydration. Confirmed as a quality lever (triangulation beats any single channel). *(Figma get_design_context; tldraw dual-channel.)*
8. **Multi-variant exploration ("go wide").** One prompt → N sibling frames, each a distinct style direction with its own mini-brief; on-canvas per-prompt progress indicator; user picks one, agent iterates deep. *(Figma agent parallel prompts + exploration framing.)*
9. **Per-turn checkpoints with restore + before/after compare.** Extend existing snapshots/diff cards with one-click restore and side-by-side compare of the agent's last diff (duplicate-then-undo pattern). *(Figma Make checkpoints; Figma agent undo; Framer branching.)*
10. **Plan contract + provenance rules in prompt.** Each multi-step turn opens with an `agent:plan` naming exactly which shape IDs change and which stay untouched; prompt rule: "document tree = source of truth; screenshots = verification only." *(Lovable THINK&PLAN; tldraw make-real provenance hierarchy; durability C3.)*
11. **Selection-anchored on-canvas prompting + @-mentions.** Cmd/Ctrl+Enter on a selection opens a scoped agent prompt; composer supports @-mentioning components and tokens to steer generation. *(Figma agent on-canvas prompt box; Figma @-mention tokens/components.)*
12. **Realistic-content final pass + user design-rules file.** (a) Mandatory end-of-turn pass replacing placeholder text with varied realistic copy; (b) per-document `design-rules.md` injected into the prompt so teams encode brand conventions. *(Figma Replace text; v0 "never placeholders"; Figma skills / LOVABLE.md.)*

---

## Appendix — fresh sources fetched this session
- Anthropic, *Writing effective tools for agents* (Sep 11, 2025) → `page-1-anthropic-tools.json`
- Figma blog, *The Figma design agent is here* (May 20, 2026) → `page-2-figma-agent.json`
- Figma blog, *Agents, meet the Figma canvas* (Mar 24, 2026) → `page-3-figma-canvas-agents.json`
- EclipseSource, *MCP and Context Overload* (Jan 22, 2026) → `page-4-mcp-overload.json`
- Brian Love, *The Landscape of Generative UI in 2026* (Feb 20, 2026) → `page-5-genui-landscape.json`
- TechAhead, *Inside Lovable: architecture & agent orchestration* (Aug 2026) → `page-6-lovable-arch.json`
- Figma Help, *Work with the Figma agent in design files* → `page-8-figma-agent-help.json`
- Progress, *AI Design Tools: The Rise of Agentic Design Canvases* (Aug 11, 2026) → `page-9-agentic-canvas.json`
- Searches 1–17 → `search-1.json` … `search-17.json` (v0, Lovable, Bolt, Figma agent/Make/MCP, tldraw, tool-calling best practices, Anthropic/OpenAI guidance, self-critique loops, design tokens/typography, design-to-code agents, canvas multiplayer architecture, 2026 tool landscape, MCP tool overload, visual verification, infinite-canvas agent UX)
