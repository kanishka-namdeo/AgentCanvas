# Prompt Tuning Research Summary (grounded web research, 2026-08-31)

## Sources
1. **Anthropic — "Writing effective tools for AI agents"** (Sep 2025)
   https://www.anthropic.com/engineering/writing-tools-for-agents
2. **"What Prompts Don't Say: Understanding and Managing Underspecification in LLM Prompts"** (arXiv 2505.13360, v3 Apr 2026)
3. **"Curse of Instructions"** (OpenReview, K Harada) — LLMs cannot follow all instructions simultaneously as count increases
4. **Anthropic — "Effective context engineering for AI agents"** (Sep 2025) — "System prompts should be extremely clear, simple, direct language, right altitude"; Claude Code cut ~80% of its system prompt with improvements
5. **v0 (Vercel) leaked system prompt** (github.com/x1xhlol/system-prompts-and-models-of-ai-tools) — the closest design-generation-agent reference
6. **LLM-as-judge best practices** (deepeval/evidentlyai guides) — rubric dimensions, before/after regression detection, aggregate stats

## Key findings applicable to AgentCanvas

### F1. Instruction overload is real and measurable
- AgentCanvas system prompt = ~48.7K chars (~15K tokens), 24 sections, dozens of MUST/RULES, 12 component recipes, 6 color ramps × 10 hex values each, 194-icon catalog.
- Research: adding instructions can DEGRADE adherence; requirements conflict; LLMs fail to follow all instructions as count grows (Curse of Instructions).
- v0's ENTIRE prompt (mostly coding guidelines for a different paradigm) is similar size BUT its *design* section is compact with hard numeric constraints ("ALWAYS use exactly 3-5 colors total", "max 2 font families").

### F2. Tool overlap confuses agents (Anthropic)
- "Too many tools or overlapping tools distract agents from pursuing efficient strategies."
- AgentCanvas has: 5 overlapping color tools (pen_set_variable / pen_set_variables / pen_apply_variable / pen_bind_variable / pen_apply_palette), 5 component paths (pen_create_component / pen_convert_to_component / pen_instantiate_component / pen_place_component_instance / pen_create_ref), and 3 competing construction idioms (pen_create_node vs pen_create_subtree vs pen_insert_html) — all advertised simultaneously.
- Anthropic: consolidate; make each tool's purpose distinct; namespacing matters; ultra-short descriptions (pen_set_background = 32 chars) are weak; destructive tools should say so (pen_clear, pen_delete_nodes).

### F3. Tool descriptions ARE prompt engineering (Anthropic)
- "One of the most effective methods for improving tools... even small refinements can yield dramatic improvements" (SWE-bench SOTA via description refinements alone).
- Eval-driven iteration: track tool-call counts, tool errors, redundant calls, durations; use held-out sets; verifiers must not reject valid alternatives.

### F4. v0's design philosophy vs AgentCanvas's (tension)
- v0: "ALWAYS use exactly 3-5 colors total", "Avoid gradients entirely unless explicitly asked", "NEVER use purple or violet prominently unless asked", max 2 fonts, solid colors.
- AgentCanvas TURN FLOW mandates: variables → palette → elevate (shadows) → gradients — gradients/elevation by default, 13 semantic $color.* variables, 60-30-10 rule.
- Question to test empirically: does the gradient/elevation mandate produce better VLM scores than a restraint-first policy? The repo's own "5 Laws of Beautiful UI" already encode restraint; the TURN FLOW's elevate/gradients steps may conflict.

### F5. Eval methodology
- Single runs are meaningless at this nondeterminism level → use repeats (repo already knows this: --repeats).
- LLM-as-judge: dimension rubrics 1-10, defect lists with severity/location, regression detection vs previous turn (repo's vlm-critique.ts already implements this pattern well).
- Track: pass rate, assertion-level results, tool-call counts, tool errors, duration, layer counts.

### F6. Claude Code lesson
- Anthropic cut 80% of Claude Code's system prompt → less conflict between instructions. Leaner prompts with higher-signal rules outperform exhaustive rule books.

## Hypotheses to test (H1-H6)
- H1: The 9-step TURN FLOW + recipes + ramps over-constrain and cause mid-sequence drift (agent forgets later steps); fewer, prioritized rules will score higher on VLM rubric.
- H2: 5 overlapping color tools cause wrong-tool selection and wasted calls; clarifying descriptions (or guidance in prompt) will cut tool errors/redundant calls.
- H3: Gradients-by-default hurts cohesion scores vs restraint-first (v0-style) defaults — test A/B.
- H4: Component recipes with literal field values cause copy-paste lookalike output (all screens converge to same style); keeping structure but parameterizing will increase prompt-fidelity scores.
- H5: The prompt's long static prefix mostly wastes attention; moving low-frequency rules (figma ontology, .pen format) behind just-in-time lookup will not hurt and may help.
- H6: Destructive-tool descriptions (pen_clear 32 chars, pen_delete_nodes 90) need side-effect warnings to reduce accidental destructive calls in edit turns.
