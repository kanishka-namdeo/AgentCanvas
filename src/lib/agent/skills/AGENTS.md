# AGENTS.md — `src/lib/agent/skills/`

## Purpose

The skill system: progressive-disclosure task specialization for the pi agent.
Implements the Anthropic Agent Skills standard (also adopted by Manus):
  https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview

7 skills cover ~95% of user intents:
  wireframe, layout, styling, inspect, export, web_research, vector

## Ownership

- `types.ts` — Skill, SkillCategory, ClassificationResult, Plan, SubAgentResult interfaces.
- `registry.ts` — The 7 skill definitions (Level 1 metadata + Level 2 body + allowedTools + keywords).
  Also exports CORE_TOOL_NAMES, ALL_TOOL_NAMES, getToolNamesForCategory, formatSkillMetadataForPrompt, formatSkillBodyForPrompt.
- `index.ts` — Barrel export (also re-exports classifier, planner, sub-agent).

## Local Contracts

### Skill definition
Every skill MUST have:
- `id` — matches a SkillCategory
- `name` — human-readable
- `description` — Level 1 metadata (~100 tokens, always loaded). Must say WHAT + WHEN.
- `body` — Level 2 instructions (loaded on activation, <5k tokens). Tool selection guide, argument rules, completion criteria.
- `allowedTools` — which of the 56 canvas tools this skill exposes
- `keywords` — for the intent classifier (case-insensitive match)

### Progressive disclosure levels
- Level 1 (always loaded): `formatSkillMetadataForPrompt()` — name + description, ~100 tokens/skill
- Level 2 (on activation): `formatSkillBodyForPrompt(category)` — full body, injected into system prompt
- Level 3 (on demand): not used at our scale (7 skills, each self-contained)

### Core tools (always loaded)
9 tools are included in EVERY skill: create_shape, update_shape, delete_shape,
list_shapes, clear, set_background, select_shape, undo, redo.

### Tool subset loading
`getToolNamesForCategory(category)` returns core tools + skill-specific tools.
For 'multi', returns ALL_TOOL_NAMES (the full 56-tool flat list — fallback).

### Adding a new skill
1. Add the category to `SkillCategory` in `types.ts`
2. Add the skill definition to `SKILLS` in `registry.ts`
3. If the skill has new tools, add them to `ALL_TOOL_NAMES`
4. Update the eval harness (`scripts/eval-agent.ts`) with test prompts
5. Run `bun run scripts/eval-agent.ts` — must stay ≥80% accuracy

## Verification

- `bun run scripts/eval-agent.ts` — 20-prompt intent classifier eval (currently 100% accuracy)
- Manual: test via Agent Browser with prompts from each skill category

## Child DOX Index

No child `AGENTS.md` files. This folder is flat: `types.ts` + `registry.ts` + `index.ts`.
