# AGENTS.md — `scripts/`

## Purpose

Utility scripts for development, screenshots, and watchdogs. Mix of shell (`.sh`) and TypeScript (`.ts`, run via `bunx tsx`).

## Ownership

- `start-dev.sh` — detached Next.js dev server launcher. Kills any existing `next-server` / `next dev` / `bun run dev` process, truncates `dev.log`, starts fresh via `setsid + nohup + disown`, waits up to 20s for `http://127.0.0.1:3000/` to respond.
- `start-canvas-sync.sh` — launcher for the `mini-services/canvas-sync/` Socket.IO service on port 3003.
- `canvas-sync-watchdog.sh` — monitors the canvas-sync service and restarts it if it dies.
- `screenshot-ui-after.ts` — Playwright script. Captures 5 UI states (initial, hover-session, input-focused, snapshots-tab, runs-expanded) to `download/ui-polish-after/`. Run via `bunx tsx scripts/screenshot-ui-after.ts`.
- `screenshot-polish-pass2.ts` — Playwright script. Captures 8 states covering the three pass-2 deliverables: empty-canvas drop zone, "New chat" hover, session row hover, dropdown menu open, rename dialog, dark-mode empty, dark-mode dropdown, dark-mode rename dialog. Output to `download/polish-pass2/`. Run via `bunx tsx scripts/screenshot-polish-pass2.ts`.

## Local Contracts

### Script persistence (root contract, restated)
- Any generation script (Python/Node/Shell longer than ~10 lines) MUST be saved to this folder before execution.
- No inline `python -c`, `bash -c`, or heredoc pipes for non-trivial work.
- On failure: edit the saved script in place via the `Edit` tool, re-run — do not regenerate from scratch.

### Shell script rules
- `set -e` (or `set -euo pipefail` for stricter) at the top.
- `cd "$(dirname "$0")/.."` explicitly — do not rely on the caller's CWD.
- Quote all paths with spaces (none currently, but be defensive).
- Kill commands use `pkill -9 -f "..." 2>/dev/null || true` — never fail the script if the process isn't running.

### Playwright / TS script rules
- Run via `bunx tsx scripts/<name>.ts` — the project has no global Playwright install, `tsx` resolves it.
- Output paths MUST be relative to the repo root under `download/`.
- Capture screenshots at a consistent viewport (default 1440x900).
- Name files with a 2-digit prefix for sort order: `01-initial.png`, `02-running.png`, etc.

## Work Guidance

- When adding a new dev helper: name it `start-<service>.sh` or `stop-<service>.sh` for consistency.
- When adding a screenshot script: model it on `screenshot-ui-after.ts` — same Playwright setup, same output convention.
- When a script fails: read the error, edit the script, re-run. Do not delete + rewrite unless the change is pervasive.

## Verification

- `bash scripts/start-dev.sh` — should print "Dev server ready after Ns" and exit 0.
- `bash scripts/start-canvas-sync.sh` — should leave the canvas-sync service running on port 3003.
- `bunx tsx scripts/screenshot-ui-after.ts` — should produce 5 PNGs in `download/ui-polish-after/`.

> **Windows note**: These shell scripts use Linux-only utilities (`setsid`, `ss`, `pkill`, `tail`) and won't run on Windows PowerShell. On Windows, use `bun run dev` directly.

## Child DOX Index

No child `AGENTS.md` files. This folder is flat.
