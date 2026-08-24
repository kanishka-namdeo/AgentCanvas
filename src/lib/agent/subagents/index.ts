// Sub-agents barrel export.
//
// Each sub-agent runs in its own LLM context (isolated from the main canvas
// agent) so it can produce large intermediate outputs without polluting the
// main context. They all return a synthesized summary (SubAgentResult)
// rather than raw tool call results.
//
// Sub-agents currently implemented:
//
//   1. Web Research (web-research.ts) — searches the web + fetches pages.
//      Used by the `web_research` skill (auto-classified for prompts that
//      ask for "current" or "latest" info).
//
//   2. Design Critic (design-critic.ts) — runs the reflection pattern.
//      Dispatched by the `pen_self_critique` agent tool. Takes a senior-
//      designer persona and returns a structured critique with severity-
//      tagged findings ([BLOCKER] / [MAJOR] / [MINOR] / [PRAISE]) + 1-10
//      score. Runs at temperature 0.4 (analytical, less agreeable than
//      the main agent's 0.7).
//
// Adding a new sub-agent:
//   1. Create `src/lib/agent/subagents/<name>.ts` with a `dispatch<Name>SubAgent(params)` function.
//   2. The function MUST return a `SubAgentResult` (see `src/lib/agent/skills/types.ts`).
//   3. Export it here.
//   4. Wire it into a tool in `src/lib/agent/tools.ts` (use a lazy `await import()` to keep the module graph lean).
//   5. The runner emits `agent:subagent_dispatch` + `agent:subagent_result` events so the UI can show progress.

export { dispatchWebResearchSubAgent } from './web-research';
export { dispatchDesignCriticSubAgent } from './design-critic';
export { dispatchDesignBriefSubAgent, type DesignBrief, parseBriefJson } from './design-brief';
export type { VlmCritique, dispatchDesignCriticVlmSubAgent } from './design-critic-vlm';
