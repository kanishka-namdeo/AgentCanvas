# z.ai Sandbox — One-Shot Setup Runbook

How to bring AgentCanvas up in the z.ai sandbox in a single pass: correct project
location, dependencies, database, dev server, verification, and restart
persistence. Read this before any sandbox bring-up, restart debugging, or
"why does my server keep dying" investigation.

Companion scripts:

- `scripts/setup-zai-sandbox.sh` — one-shot bring-up (env + install + DB + start + verify + persist)
- `scripts/start-dev.sh` — orphan-safe dev-server launcher

---

## The sandbox model (know these 8 facts first)

1. **The project root is `/home/z/my-project` — never a subdirectory.** The
   sandbox's auto dev-server, the Caddy gateway (`:81` → `:3000`), the global
   `DATABASE_URL`, the `.zscripts/dev.sh` boot flow, and mini-service routing
   all hardcode this location. Cloning into `/home/z/my-project/AgentCanvas`
   and running from there breaks boot persistence, the gateway, and the DB path.

2. **A fresh sandbox boots with a scaffold project at that root**
   (`package.json`, `src/app/page.tsx`, `.env`, `db/`, `download/`, `skills/`,
   `upload/`). Setup means replacing it wholesale — but **preserve `upload/`**
   (an OSS mount point) and **leave `skills/` alone** (re-extracted at boot from
   `/home/official_skills`; both stay gitignored).

3. **`DATABASE_URL` is forced to the absolute path
   `file:/home/z/my-project/db/custom.db`.** The container exports it globally
   and `/start.sh` rewrites `.env` with exactly that value at every boot. The
   repo's default `file:./db/custom.db` is CWD-relative (and the Prisma CLI
   resolves it against `prisma.config.ts`), which silently creates the DB in a
   different directory. In the sandbox, always use the absolute path.

4. **Background processes are killed at the end of every agent tool call.**
   The host reaps every descendant of the call's shell when the call finishes.
   A process survives **only if it is reparented to PID 1 (tini) before the
   call ends**. This is the single biggest source of setup trial-and-error —
   see [Process survival rules](#process-survival-rules).

5. **Container boot auto-starts the app via `.zscripts/dev.sh`.** If that file
   exists at boot, `/start.sh` runs it as user `z`: `bun install` →
   `bun run db:push` → `bun run dev` (port 3000; canvas-sync boots in-process
   on 3003 via `instrumentation.ts`). No manual babysitting needed after a
   restart.

6. **The project directory is ephemeral; `/home/sync/repo.tar` is the
   persistence layer.** `/home/sync` is an OSS-mounted volume that survives
   container restarts. At boot, `repo.tar` is extracted over `/home/z/my-project`.
   If it is missing, you get a clean scaffold instead. **After setup — and after
   any durable change — refresh the archive** (`setup-zai-sandbox.sh --archive`),
   or the next restart reverts the project.
   (The platform host also auto-commits working-tree changes with a UUID
   message; a local branch ahead of `origin` is normal.)

7. **One external port: `:81` (Caddy gateway).** Default route proxies to
   `:3000` (Next.js). Any other service port is reached by adding
   `?XTransformPort=<port>` to the URL — e.g. canvas-sync:
   `io('/?XTransformPort=3003')`. Browser code must use relative URLs only;
   `http://localhost:<port>` from the browser never works. The **only
   user-visible route is `/`**; users preview via the sandbox Preview Panel,
   never via localhost links.

8. **canvas-sync runs in-process only.** `next dev` boots it via
   `instrumentation.ts` and it owns `:3003` directly. (A standalone
   `mini-services/canvas-sync` twin used to race for the port and lose with
   `EADDRINUSE`; it was deleted — it could never win, and its semantics
   silently differed: no DB seed, dropped `agent:steer`, dead measured-bounds
   cache.) If a standalone relay is ever needed again, extract a shared core
   from `src/lib/canvas/server.ts` instead of forking it.

Bonus: the app's default LLM is now a custom OpenAI-compatible endpoint
(`custom` / `kimi-k2-5` / `https://irhnglwoxe.a.pinggy.link/v1`, key `123456`
— see `DEFAULT_SETTINGS` in `src/lib/settings/types.ts`), so no credentials
are needed out of the box. `z-ai-web-dev-sdk` auto-resolves credentials inside
the sandbox as a fallback for the `zai` provider — still no
`ZAI_API_KEY` / `OPENAI_API_KEY` needed for that path.

**Automatic z.ai sandbox fallback (resilience):** when the configured endpoint
is unreachable (network error, HTTP 5xx/429, 401/403, OR a 200 response with
empty content + no tool calls), the runner automatically retries the SAME turn
ONCE using `ZAI.create()` with model `glm-5.3`. This means agent turns SUCCEED
even when the pinggy tunnel is down — the user gets resilient LLM access via
the z.ai sandbox as the default fallback. Bounded to ONE retry per turn;
skipped when the configured provider is already `zai`; skipped with a warn
when `ZAI.create()` reports no sandbox creds (i.e. running outside the z.ai
sandbox). Two layers cooperate:

1. **Preflight** (`src/lib/agent/pi-ai-model-resolver.ts`): a 4s GET against
   `${baseUrl}/models` BEFORE the session is created. Cached 60s per
   (baseUrl, apiKeyPrefix). On network error or non-2xx, the resolver returns
   a z.ai-sandbox-resolved `glm-5.3` Model with `usedFallback=true` instead of
   the synthetic custom Model.
2. **Reactive fallback** (`src/lib/agent/runner-native.ts`): if the preflight
   passed but the turn still produced zero `message_delta` AND zero
   `tool_call_start` events (e.g. the endpoint returned an empty 200 body),
   the runner re-creates the AgentSession with a fresh z.ai-sandbox Model and
   re-runs the turn. Bounded by `ResolvedModel.usedFallback` — if the
   preflight already swapped, the runner does NOT retry again.

Both layers emit `console.warn('[llm-fallback] …')` server-side when they
trigger. Verify the fallback fires via `scripts/endpoint-switch-verify.sh`
(the API-SMOKE step counts `message_delta` + `tool_call_start` events — with
the fallback in place, the smoke test passes even when the pinggy tunnel is
dead).

---

## One-shot setup (fresh sandbox)

```bash
# 1) Clone with credentials and replace the scaffold in place
git clone https://<user>:<PAT>@github.com/kanishka-namdeo/AgentCanvas.git /tmp/AgentCanvas
cd /home/z/my-project
find . -mindepth 1 -maxdepth 1 ! -path ./upload ! -path ./skills -exec rm -rf {} +
shopt -s dotglob && mv /tmp/AgentCanvas/* . && shopt -u dotglob && rmdir /tmp/AgentCanvas

# 2) One-shot bring-up: env + install + DB + dev server + verify + persist
bash scripts/setup-zai-sandbox.sh
```

That is the entire setup. If every verification line prints `PASS`, the app is
live in the Preview Panel and will self-heal across container restarts.

### What `setup-zai-sandbox.sh` does

| Step | Command | Notes |
| --- | --- | --- |
| Env | force `DATABASE_URL` to the absolute sandbox path | preserves other `.env` lines |
| Install | `bun install` | ~1.5k packages |
| DB | `bun run db:generate` + `bun run db:push` | SQLite at `db/custom.db` |
| Start | `bash scripts/start-dev.sh` | skipped if `:3000` already responds |
| Verify | health checks (below) | exit 1 on any failure |
| Persist | refresh `/home/sync/repo.tar` | excludes `node_modules/`, `.next/`, `skills/`, `upload/`, logs |

Subcommands: `--verify` (checks only), `--archive` (persistence only),
`--no-start` (env + install + DB only).

---

## Process survival rules

The part that costs the most trial-and-error if you don't know it. The host
kills every descendant of a tool call's shell when the call ends; only
processes already reparented to PID 1 escape.

| Pattern | Survives? | Why |
| --- | --- | --- |
| `bash scripts/start-dev.sh` | ✅ | double-fork `( setsid … & )` orphans to init mid-call, then waits for readiness |
| `( setsid bash -c 'exec CMD' & )` | ✅ | wrapping subshell exits immediately → reparent happens before call end |
| `nohup CMD &` | ❌ | direct child of the call shell until cleanup kills it |
| `setsid CMD &` (bare) | ❌ | new session, but still a child of the call shell — gets reaped |
| `CMD & disown` | ❌ | disown only removes the job table entry; the PID is still a descendant |
| `bun run dev &` then kill bun mid-call | ⚠️ | the orphaned grandchild survives (this is how the first successful bring-up happened), but it is fragile — use the script |

Related rule: never `bun run build` / `next start` in the sandbox — the boot
flow and the gateway only support the dev server on port 3000.

---

## Verification checklist

All of these must pass before reporting the app as running:

```bash
curl -s http://localhost:3000                     # 200 + <title>AgentCanvas — Figma for AI agents</title>
curl -s http://localhost:3000/api/sessions        # JSON containing "sessions"
curl -s "http://localhost:3003/socket.io/?EIO=4&transport=polling"   # handshake payload containing "sid"
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:81/         # 200 (gateway)
```

Plus, in a real browser (e.g. `agent-browser`): the workspace renders (menubar,
toolbar, layers panel, agent panel), the canvas SVG is present, and the console
is free of errors. `scripts/setup-zai-sandbox.sh --verify` automates the curl
set and checks `dev.log` for compile failures.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Server dies seconds after launch | non-orphaned background pattern | use `bash scripts/start-dev.sh` |
| DB created in an unexpected directory | relative `file:./db/custom.db` resolved against CWD | set absolute `DATABASE_URL`; `setup-zai-sandbox.sh` fixes it |
| `curl :3000` fails while processes are alive | server still compiling (Turbopack cold start) | wait and re-check; `start-dev.sh` waits up to 45s |
| Port 3000 already in use | previous instance survived (that is the point) | `start-dev.sh` kills stale instances first |
| Project reverted after container restart | `repo.tar` not refreshed after changes | run `setup-zai-sandbox.sh --archive`, restart again |
| `bun run build`/`next start` hangs or 404s behind the gateway | boot flow only supports dev server on 3000 | use the dev server |

---

## Anti-patterns

- Cloning into `/home/z/my-project/AgentCanvas` and running from the subdirectory.
- Expecting `nohup` / bare `setsid` / `disown` to keep a server alive across calls.
- Absolute `http://localhost:<port>` URLs in browser code (use `?XTransformPort=`).
- Telling the user to open `localhost:3000` (the Preview Panel is the only user-facing entry).
- Editing `.env` to a relative DB path and expecting it to stick (boot rewrites it).
- Committing `upload/`, `skills/`, `node_modules/`, `db/`, `dev.log`, or `.zscripts/*.log`.
