# AGENTS.md — `src/lib/agent/skills/`

## Purpose

The skill system: progressive-disclosure task specialization for the pi agent.
Implements the Anthropic Agent Skills standard (also adopted by Manus):
  https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview

7 skills cover ~95% of user intents:
  wireframe, layout, styling, inspect, export, web_research, vector

## Ownership

- `types.ts` — Skill, SkillCategory, ClassificationResult, Plan, PlanStep, SubAgentParams, SubAgentResult interfaces.
- `registry.ts` — The 7 skill definitions (Level 1 metadata + Level 2 body + allowedTools + keywords).
  Also exports SKILLS, getSkill, getSkillMetadata, CORE_TOOL_NAMES, ALL_TOOL_NAMES, getToolNamesForCategory, formatSkillMetadataForPrompt, formatSkillBodyForPrompt.
  The Level 2 bodies carry the prompt-tuned guardrails (2026-08-31 rev `.4`): the VERIFY step names every resolver-warning kind with its fix (container_overflow / text_overflow / flow_child_absolute_coords / unresolved $vars), and the layout body carries the batch-construction + call-budget rules. Skill bodies and the SYSTEM_PROMPT_TEMPLATE must not drift — both are stamped by the same PROMPT_VERSION rev.
- `index.ts` — Barrel export (also re-exports classifier, planner, sub-agent).

## Local Contracts

### Skill definition
Every skill MUST have:
- `id` — matches a SkillCategory
- `name` — human-readable
- `description` — Level 1 metadata (~100 tokens, always loaded). Must say WHAT + WHEN.
- `body` — Level 2 instructions (loaded on activation, <5k tokens). Tool selection guide, argument rules, completion criteria.
- `allowedTools` — which of the 87 LLM-visible canvas/web tools this skill exposes (from `ALL_TOOL_NAMES`)
- `keywords` — for the intent classifier (case-insensitive match)

### Progressive disclosure levels
- Level 1 (always loaded): `formatSkillMetadataForPrompt()` — name + description, ~100 tokens/skill
- Level 2 (on activation): `formatSkillBodyForPrompt(category)` — full body, injected into system prompt
- Level 3 (on demand): not used at our scale (7 skills, each self-contained)

### Core tools (always loaded)
10 tools are included in EVERY skill: pen_create_node, pen_create_subtree, pen_update_node, pen_delete_nodes, pen_get_metadata, pen_clear, pen_set_background, pen_select_nodes, pen_undo, pen_redo (`CORE_TOOL_NAMES` — node-era names; shape-era spellings still dispatch via `../tool-aliases.ts` but are not advertised).

### Tool subset loading
`getToolNamesForCategory(category)` returns core tools + skill-specific tools.
For 'multi', returns ALL_TOOL_NAMES (the full 87-tool flat list — fallback; excludes the 10 always-loaded figma tools).

### Adding a new skill
1. Add the category to `SkillCategory` in `types.ts`
2. Add the skill definition to `SKILLS` in `registry.ts`
3. If the skill has new tools, add them to `ALL_TOOL_NAMES`
4. Update the eval harness (`scripts/eval-agent.ts`) with test prompts
5. Run `bun run scripts/eval-agent.ts` — must stay ≥80% accuracy

## Verification

- `bun run scripts/eval-agent.ts` — 20-prompt intent classifier eval (currently 95% accuracy; gate is ≥80%)
- Manual: test via Agent Browser with prompts from each skill category

## Child DOX Index

No child `AGENTS.md` files. This folder is flat: `types.ts` + `registry.ts` + `index.ts`.
