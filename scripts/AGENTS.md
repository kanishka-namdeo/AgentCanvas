# AGENTS.md — `scripts/`

## Purpose

Utility scripts for development, screenshots, watchdogs, eval, and measurement. Mix of shell (`.sh`) and TypeScript (`.ts`, run via `bunx tsx`).

## Ownership

- `start-dev.sh` — detached Next.js dev server launcher, sandbox-safe. Kills any existing `next-server` / `next dev` / `bun run dev` process, truncates `dev.log`, starts fresh via a double-fork `( setsid … & )` so the server is reparented to PID 1 and survives the end of the agent tool call (the sandbox host kills all other descendants), waits up to 45s for `http://127.0.0.1:3000/` to respond.
- `setup-zai-sandbox.sh` — one-shot z.ai sandbox bring-up: forces the absolute `DATABASE_URL`, `bun install`, `bun run db:generate` + `db:push`, starts the dev server via `start-dev.sh` (skipped if `:3000` already serves), runs the health-check suite, and refreshes the persistence archive `/home/sync/repo.tar`. Subcommands: `--verify`, `--archive`, `--no-start`. The full runbook is `docs/zai-sandbox-setup.md`.
- `screenshot-ui-after.ts` — Playwright script. Captures 5 UI states (initial, hover-session, input-focused, snapshots-tab, runs-expanded) to `download/ui-polish-after/`. Viewport 1600×1000. Run via `bunx tsx scripts/screenshot-ui-after.ts`.
- `screenshot-polish-pass2.ts` — Playwright script. Captures 8 states covering the three pass-2 deliverables: empty-canvas drop zone, "New chat" hover, session row hover, dropdown menu open, rename dialog, dark-mode empty, dark-mode dropdown, dark-mode rename dialog. Output to `download/polish-pass2/`. Run via `bunx tsx scripts/screenshot-polish-pass2.ts`.
- `eval-agent.ts` — Evaluation harness for the agent's intent classifier. Runs the keyword classifier against 20 hand-labeled prompts across 7 skill categories + multi-step prompts. Exit 0 if accuracy >= 80%, exit 1 otherwise. Run via `bun run scripts/eval-agent.ts`.
- `probe-zai-endpoint.ts` — Discovers what the z.ai sandbox LLM endpoint serves: ZAI.create() config shape, direct chat completions with candidate models, and pi-ai's zai model catalog. Run via `bun run scripts/probe-zai-endpoint.ts` (mind 429s — space the calls).
- `probe-zai-models-2.ts` — Second-pass probe: glm-5.x availability + function-calling capability through the sandbox endpoint (spaced to dodge rate limits).
- `verify-default-llm.ts` — Verifies the default LLM config end-to-end: resolves DEFAULT_SETTINGS → must be `custom/kimi-k2-5` at `https://irhnglwoxe.a.pinggy.link/v1` (synthetic openai-completions Model), runs a real completion through `createAgentSession` (production path), and checks the `apiBaseUrl` custom-endpoint override. Exit 0 on success. Run via `bun run scripts/verify-default-llm.ts`.
- `cleanup-orphan-sessions.ts` — one-time data repair: deletes Session rows with no messages/runs/snapshots (empty shells from the pre-fix session-id bug; 2,733 at discovery). `--dry-run` lists without deleting. Run via `bun run scripts/cleanup-orphan-sessions.ts`.
- `measure-tool-cost.ts` — Measures the token cost of the agent's tool registry + system prompt. Estimates tokens as chars/4, prints per-tool breakdown sorted by size. Run via `bun run scripts/measure-tool-cost.ts`.
- `dom-renderer-bench/` — Synthetic benchmark corpus generator for the HTML/DOM renderer perf track (spec `docs/html-dom-renderer.md` Appendix F / Phase 0). `generate.ts` exports `generateDocument({nodes, screens, seed})` — deterministic mulberry32 PRNG, Appendix F node mix (40% text / 30% rect+frame / 15% instances / 10% images / 5% paths), one root frame per screen with `clip: true`. `README.md` documents the standard corpora (small/medium/large/xl) + the Phase 4 browser perf-runner plan (NOT implemented). Smoke-tested by `tests/unit/bench-generator.test.ts`.
- `agent-eval/` — Prompt-vs-output scenario suite for the design agent. `scenarios.ts` defines 11 scenarios: 8 dev scenarios (simple shape, text heading, hi-fi login, lo-fi wireframe, modify-precision on a seeded canvas, flowchart, hi-fi dashboard, palette) each with deterministic canvas-state assertions + trajectory checks (failed tool calls, duplicate consecutive calls, runaway loops, agent errors), and 3 HELD-OUT scenarios (pricing-cards, profile-settings, kanban-board — `heldOut: true`) that are EXCLUDED from default runs so dev iteration can never teach to them (final validation: `--include-heldout`; once used to grade a change, a held-out scenario is burned — write a new one). `run-eval.ts` drives the LIVE `/api/agent` NDJSON route, applies patches through the app's own `applyPatchToCanvas`, and writes JSON + markdown reports to `agent-eval/results/` — JSON shape is `{ runs: ScenarioResult[], aggregate: ScenarioAggregate[] }`. Rate-limit aware: probes `/etc/.z-ai-config`'s endpoint before starting/retrying, sleeps between scenarios AND repeats (`--delay=N`, default 20s), retries empty turns after endpoint recovery. VARIANCE MODE: `--repeats=N` runs each scenario N times and reports a per-scenario pass rate, tool-call/duration mean+min+max, and per-assertion-name flakiness (single-run pass/fail is nearly meaningless at this agent's non-determinism level — same scenario passed and failed 7 min apart in the 2026-08-23 history); exit code requires EVERY run of a scenario to pass (flaky is not green). `run-multishot.ts` drives the 3 multi-shot (iterative-refinement) scenarios the same way — per-turn snapshots, per-turn assertion table, `--only=`/`--out=`/`--delay=`; used by the prompt-tuning exercise (logs in `download/prompt-tuning/eval-*.log`). `vlm-critique-pt.ts` is the prompt-tuning VLM review pass: 6-dimension rubric over rendered scenario PNGs (`--provider=kimi|zai|auto`, `--repeats=N`, defensive JSON parse; results in `download/prompt-tuning/vlm-*`). `visual-test.sh` runs the visual-flagged scenarios through the real browser UI (socket.io path) and screenshots to `download/agent-eval/` (held-out scenarios are non-visual by design — no shell-script entries needed). Run via `bun scripts/agent-eval/run-eval.ts [--only=id,…] [--out=results/<name>] [--repeats=N] [--include-heldout] [--delay=S]`.

- `vlm-inspect/` — VLM output-inspection exercise harness (2026-08-27/28; results in `download/vlm-exercise/` + `REPORT.md`). Not a unit suite — it drives the LIVE agent with real LLM calls and critiques every output with an external VLM. Pieces:
  - `run-scenarios.ts` — RESUMABLE scenario-matrix runner: one scenario/turn per invocation (bash tool calls cap at 10 min → run as `MAX_WAIT=560 timeout 580 bun scripts/vlm-inspect/run-scenarios.ts download/vlm-exercise/<pass> [--scenario=X|--redo=X:N]`); taps every NDJSON event to `<pass>/tap-events/<turn>.jsonl` with a 10s incremental flush (a killed RUN phase keeps its partial tap — indistinguishable-from-hang bug fixed), waits for `turn_end`, skips completed turns on re-run.
  - `scenarios.json` — the 14-turn matrix (13 core turns: 4 one-shot + 3×3 multi-shot scenarios + `smoke-variants`).
  - `vlm-critique.ts` + `merge-critiques.ts` — external VLM critique of each turn's final screenshot (8-dimension rubric, 1-10 scores) + merge into `summary.json`/`summary.md` (mind 429s — space the calls).
  - `analyze-transcripts.ts` / `analyze-final.ts` — transcript analysis: todo-call share, variant-generator usage, tool-call counts per turn.
  - Probes: `probe-variant-gen.ts` / `probe-variant-dispatch.ts` (live variant-pipeline probes against the real kimi endpoint — model injected, 300s timeouts), `probe-cache-fields.ts` (prompt-cache usage fields), `probe-should-stop.ts` (shouldStopAfterTurn), `probe-endpoints.ts` (tunnel health), `probe-vlm-quota.ts` (vision-quota probe: z.ai createVision vs the kimi endpoint with a 64×64 solid-color image — picks the VLM provider when z.ai is 429-blocked), `probe-resolve-warnings.ts` (retroactive check: resolve the dumped multishot canvases and print the ResolverWarnings the agent WOULD have seen — proves a defect class is catchable without a live LLM run).
  - Debugging one-shots: `debug-classifier.ts` / `test-classifier.ts` (intent routing), `test-overflow-warning.ts`, `llm-bisect*.ts` (regression bisection), `replay-turn.ts` (patch replay for canvas-state reconstruction), `dump-canvas.ts` / `dump-pen-tree.ts` / `dump-node-json.ts` (state dump), `vlm-describe.ts`, `repro-navbar.ts` / `repro-text-bug.ts` / `repro-nested-fontsize.ts`.

## Local Contracts

### Script persistence (root contract, restated)
- Any generation script (Python/Node/Shell longer than ~10 lines) MUST be saved to this folder before execution.
- No inline `python -c`, `bash -c`, or heredoc pipes for non-trivial work.
- On failure: edit the saved script in place via the `Edit` tool, re-run — do not regenerate from scratch.

### Shell script rules
- `set -e` (or `set -euo pipefail` for stricter) at the top — EXCEPT watchdog-style respawn loops that must survive non-zero child exits.
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

- `bash scripts/start-dev.sh` — should print "Dev server ready after Ns" and exit 0, and the server must still respond in a later tool call (survival is the point of the script).
- `bun run scripts/setup-zai-sandbox.sh --verify` — should print 5 PASS lines and exit 0 (page, `/api/sessions`, `:3003` handshake, gateway `:81`, clean `dev.log`).
- `bun run scripts/verify-default-llm.ts` — should print the resolver label `custom/kimi-k2-5`, a completion via `createAgentSession`, the custom-endpoint check, and `ALL CHECKS PASSED`.
- `bunx tsx scripts/screenshot-ui-after.ts` — should produce 5 PNGs in `download/ui-polish-after/`.

> **Windows note**: These shell scripts use Linux-only utilities (`setsid`, `ss`, `pkill`, `tail`) and won't run on Windows PowerShell. On Windows, use `bun run dev` directly.

## Child DOX Index

No child `AGENTS.md` files. This folder is flat.
