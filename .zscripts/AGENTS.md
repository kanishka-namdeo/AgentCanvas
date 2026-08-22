# AGENTS.md — `.zscripts/`

## Purpose

z.ai sandbox + deploy toolchain scripts. Two families: (1) the sandbox dev boot flow (`dev.sh` — auto-run by the container's `/start.sh` at every restart) and (2) the production deploy artifact pipeline (`build.sh` → `start.sh` + `mini-services-*` + runtime bundlers). These are scaffold-layer scripts (Chinese comments reflect the template's origin — do not rewrite for style).

The full sandbox operating runbook (project location, process survival, persistence) is `docs/zai-sandbox-setup.md` — read it before touching anything here.

## Ownership

- `dev.sh` — sandbox dev boot, auto-run by the container's `/start.sh` at every restart: `bun install` → `db:push` → `next dev` on :3000 (60s wait + health check) → per-service `bun install` + `bun run dev` for each `mini-services/*` with a `dev` script (logs to `.zscripts/mini-service-<name>.log`).
- `start.sh` — production container entrypoint (deploy artifact; NOT the sandbox boot script despite the name — the sandbox boot script is the container-root `/start.sh`): starts `next-service-dist/server.js` (NODE_ENV=production, PORT=3000, packaged-DB fail-fast on `/app/db/custom.db`), optional `/app/python-runtime` env, `mini-services-dist` services, then `exec caddy run` as the foreground main process.
- `build.sh` — production artifact assembly: `bun install` + `next build` with standalone-output self-heal (injects `output: "standalone"` into next.config if missing, `.zbak` backup, fails loudly on incompatible output), mini-services install+build, python/database runtime bundling, copies Caddyfile + start.sh, tars to `/tmp/build_fullstack_$BUILD_ID.tar.gz`.
- `mini-services-install.sh` — runs `bun install` in every `mini-services/*` dir with a package.json; prints success/failure summary.
- `mini-services-build.sh` — `bun build --target bun --minify` of each mini-service entry (`src/index.ts` | `index.ts` | `src/index.js` | `index.js`) → `mini-service-<name>.js` in the deploy dist dir; copies `mini-services-start.sh` alongside.
- `mini-services-start.sh` — production launcher for the built `mini-service-*.js` bundles (background bun processes, graceful SIGTERM shutdown trap).
- `python-runtime-build.sh` — uv-based Python runtime bundling: detects `.py` sources / `requirements.txt` / `pyproject.toml`(+`uv.lock`), installs prod deps to `<build>/python-runtime/site-packages`, rewrites console-script shebangs, copies `.py` sources into `next-service-dist`; exits 0 (skip) for pure-Node projects.
- `database-runtime-build.sh` — copies the preview `db/` into the deploy artifact (or initializes an empty DB) and runs `DATABASE_URL=file:<artifact>/db/custom.db bun run db:push` to sync schema.

## Local Contracts

- **Boot contract**: the container's `/start.sh` restores `/home/sync/repo.tar` then auto-runs `dev.sh` as user `z` at every restart. If `dev.sh` breaks, the app is dead after restart. Refresh the archive after durable changes: `bash scripts/setup-zai-sandbox.sh --archive`.
- **Name-collision warning**: `.zscripts/start.sh` is the *production* entrypoint, NOT the sandbox boot script (that is container-root `/start.sh`). Never confuse them.
- **Port discipline**: dev flow = `next dev` :3000; :3003 is owned by the in-process canvas-sync twin — the standalone mini-service exits 0 on EADDRINUSE (see `mini-services/canvas-sync/AGENTS.md`).
- **Deploy artifact layout**: `next-service-dist/` + `mini-services-dist/` + optional `python-runtime/` + `db/` + `Caddyfile` + `start.sh` → tar.gz.
- `build.sh` may self-modify `next.config` (injects `output: "standalone"`, keeps a `.zbak`).
- Runtime-build scripts are env-driven (`PROJECT_DIR` / `BUILD_DIR`) and are smoke-tested by `tests/*.sh` with fakes.

## Work Guidance

- NEVER rename `dev.sh` — the boot path is hardcoded in the container's `/start.sh`.
- Keep POSIX sh compatibility where the template uses `sh`.
- `.zscripts/*.log` and `mini-service-*.log` are runtime output — gitignored, excluded from repo.tar.
- Changes to the boot flow must be mirrored in `docs/zai-sandbox-setup.md`.

## Verification

- `bash -n .zscripts/*.sh` — syntax check.
- `bash tests/python-runtime-build.sh` + `bash tests/database-runtime-build.sh` — smoke-test two of these scripts.
- End-to-end: a container restart brings up `:3000` + `:3003` (see `scripts/setup-zai-sandbox.sh --verify`).

## Child DOX Index

No child `AGENTS.md` files. This folder is flat.
