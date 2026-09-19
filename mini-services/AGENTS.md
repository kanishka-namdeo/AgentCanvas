# AGENTS.md — `mini-services/`

## Purpose

Reserved deploy target boundary for standalone TypeScript microservices (one folder per service). The z.ai sandbox deploy pipeline (`.zscripts/mini-services-install.sh` + `mini-services-build.sh` + `mini-services-start.sh`) auto-discovers and bundles every `mini-services/*` subdir that has a `package.json` into the production artifact. The folder is currently empty (only `.gitkeep`) — the historical `mini-services/canvas-sync/` service was retired (port collision with the in-process twin; see Mistakes & Lessons).

## Ownership

- The folder itself is the contract — the z.ai deploy pipeline walks `mini-services/*/package.json` to install, build, and launch services.
- No mini-service source exists today. The in-process equivalent of the retired `canvas-sync` service lives in `src/lib/canvas/server.ts`.

## Local Contracts

- **Auto-discovery contract**: `.zscripts/mini-services-install.sh` runs `bun install` in every `mini-services/*` dir with a `package.json`. `.zscripts/mini-services-build.sh` then `bun build --target bun --minify` of the entry (`src/index.ts` | `index.ts` | `src/index.js` | `index.js`) → `mini-service-<name>.js` in the deploy dist dir.
- **Launcher contract**: `.zscripts/mini-services-start.sh` runs the built `mini-service-*.js` bundles as background bun processes with graceful SIGTERM shutdown trap.
- **Entry-point discovery**: build script probes in order `src/index.ts`, `index.ts`, `src/index.js`, `index.js` — first match wins.
- **Dev-time boot**: `.zscripts/dev.sh` runs `bun install` + `bun run dev` for every `mini-services/*` with a `dev` script (logs to `.zscripts/mini-service-<name>.log`).

## Work Guidance

- Before adding a new mini-service: confirm its port does NOT collide with the in-process app ports (`:3000` Next.js, `:3003` canvas-sync twin, `:81` gateway). Add an `EADDRINUSE` handler that exits 0 if a port collision is detected.
- Each mini-service MUST have its own `package.json` to be picked up by the install/build/start pipeline.
- Mini-service code is NOT part of the Next.js app — it cannot import from `src/` directly. Communicate via Socket.IO / HTTP / shared DB rows.
- Sandbox dev log: `.zscripts/mini-service-<name>.log` is gitignored runtime output — do not check in.

## Verification

- `bash .zscripts/mini-services-install.sh` (after adding a service) — should print one success line per mini-service.
- `bash .zscripts/mini-services-build.sh` — should emit one `mini-service-<name>.js` per service in the deploy dist dir.
- End-to-end: a container restart brings up each mini-service (see `.zscripts/AGENTS.md` "Verification").

## Mistakes & Lessons

### Failure Modes

- Check the proposed mini-service port against in-process app ports (`:3000`, `:3003`, `:81`) before adding a service, because the previous standalone `canvas-sync` collided with its in-process twin on `:3003` and was retired.
- Check that an `EADDRINUSE` handler is present in any new service, because the build pipeline launches services in background and a collision-kill looks like a clean exit otherwise.

### Lessons Learned

- Do not run a standalone mini-service alongside its in-process twin, because the historical `mini-services/canvas-sync/` collided with `src/lib/canvas/server.ts` on `:3003` with no EADDRINUSE handler and the standalone was retired to `.gitkeep`. The in-process twin now owns the port.
- Prefer folding new shared-canvas / sync functionality into the in-process `src/lib/canvas/server.ts` over a new standalone service, because the deploy pipeline is simpler and the port-collision class of bug disappears.

## Child DOX Index

No child `AGENTS.md` files. Each future mini-service subdir MAY get its own AGENTS.md when it grows past a single entry file.
