# AGENTS.md — `research/`

## Purpose

Read-only research notes (JSON) gathered during the project's design phase. These are reference material — they informed the architecture but are NOT executable code and should NOT be edited or deleted unless the underlying research is superseded.

## Ownership

- Owned by the project maintainer. Not owned by any feature folder.
- These files are NOT imported by any code in `src/`. They exist for human/agent reference only.

## Local Contracts

### Read-only
- Do NOT edit, rename, or delete files in this folder.
- Do NOT import from this folder in any `src/` or `mini-services/` code.
- If the research is outdated, add a new file with a note explaining what superseded it — do not modify the original.

### File inventory
- `figma_features.json` — Figma feature research focused on Auto Layout, layers panel, and canvas properties that informed the tool surface.
- `figma_ai_plugins.json` — survey of AI plugins and AI features for Figma that informed the agent design.
- `figma_api.json` — Figma REST API, design tokens, and variables reference (used to model the canvas document shape).
- `ai_design_tools.json` — survey of AI design tools (Uizard, Galileo AI, etc.) that informed the UX.
- `ai_design_scenarios.json` — articles on AI + design systems integration and MCP servers that informed the agent–design-system workflow.
- `agent_function_calling.json` — survey of OpenAI Agents SDK and function-calling patterns that informed the runner's tool-calling protocol.
- `pi_agent_sdk.json` — survey of the Pi Agent SDK surface that informed `src/lib/agent/`.

### Format
- Each file is a JSON array of `{ url, name, snippet, host_name, rank, date, favicon }` objects — the shape returned by web search.
- Do not reformat. Do not dedupe. These are raw research artifacts.

## Work Guidance

- Read these files when designing a new feature that touches the corresponding area.
- Cite the file (not specific entries) in worklog entries when a design decision traces back to research here.
- If new research is needed for a feature, add it as a new file — do not append to existing files.

## Verification

- No automated verification — these are reference-only JSON files.
- If a file becomes invalid JSON (should not happen — they are never edited), restore from git history.

## Child DOX Index

No child `AGENTS.md` files. This folder is flat.
