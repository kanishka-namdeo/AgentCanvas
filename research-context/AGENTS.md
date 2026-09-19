# AGENTS.md — `research-context/`

## Purpose

Read-only research context files (JSON) capturing UX patterns and feature snapshots from competing AI design tools (Cline, OpenCode, Claude Code, cursor-ui, etc.) plus the project's own design probes (`chat-attach-*`, `pd-*` selection / hover / cursor / canvas-attach, `vision-badges-*`, `model-selector-ux`, `chat-scroll`, `model-switcher-ui`). These informed specific UX decisions during the design phase and are reference material only — NOT executable code, NOT imported by the app.

## Ownership

- Owned by the project maintainer. Not owned by any feature folder.
- These files are NOT imported by any code in `src/` or `mini-services/`. They exist for human/agent reference only.

## Local Contracts

### Read-only

- Do NOT edit, rename, or delete files in this folder.
- Do NOT import from this folder in any `src/` or `mini-services/` code.
- If the research is outdated, add a new file with a note explaining what superseded it — do not modify the original.

### File inventory (flat)

- `cline-context.json`, `cline-ui.json` — Cline AI IDE research snapshots (context window + UI chrome).
- `claude-code-context.json` — Claude Code context-window + tool-call pattern reference.
- `opencode.json` — OpenCode tool surface research.
- `cursor-ui.json`, `pd-cursor.json` — Cursor-style inline cursor UX snapshots.
- `pd-hover.json`, `pd-selection.json`, `pd-toolcalls.json`, `pd-canvas-attach.json` — design probes for selection / hover / tool-call surface / canvas attachment affordances.
- `chat-attach-1.json`, `chat-attach-2.json` — chat attachment UX snapshots (the basis for the `SessionAttachment` model + `/api/sessions/[id]/attachments` route).
- `chat-scroll.json` — chat scroll-position preservation research (basis for `src/components/sessions` scroll-anchoring).
- `model-selector-ux.json`, `model-switcher-ui.json` — model selector / switcher UX snapshots (basis for `src/components/settings` model picker).
- `vision-badges-1.json`, `vision-badges-2.json` — vision-capability badge UX (basis for the eye-icon model badge in the agent panel).

### Format

- All files are heterogeneous JSON dumps — do not reformat, do not dedupe. They are raw research artifacts.

## Work Guidance

- Read these files when designing a feature that touches the corresponding UX surface (cursor, attachment, model picker, scroll, vision badge, etc.).
- Cite the file (not specific entries) in worklog entries when a design decision traces back to research here.
- If new research is needed for a feature, add it as a new file — do not append to existing files.

## Verification

- No automated verification — these are reference-only JSON files.
- If a file becomes invalid JSON (should not happen — they are never edited), restore from git history.

## Mistakes & Lessons

### Failure Modes

- Check that you are not importing from this folder in `src/` or `mini-services/` code, because these are reference-only JSON snapshots and importing them creates silent coupling to research artifacts.
- Check that research is added as a new file rather than appended to an existing one, because the provenance of each snapshot matters and edits erase the original record.

### Lessons Learned

- Treat this folder as read-only reference material (do not edit, rename, or delete), because the research informed concrete UX decisions and downstream reasoning traces back to specific entries — modifying the originals breaks the audit trail.
- If research is outdated, add a new file with a note explaining what superseded it, because deleting or rewriting the original loses the historical reasoning.

## Child DOX Index

No child `AGENTS.md` files. This folder is flat.
