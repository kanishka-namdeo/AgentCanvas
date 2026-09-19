# AGENTS.md — `scripts/video-capture/`

## Purpose

Landing-video capture harness: records production-grade product videos of the
AgentCanvas workspace (`/app`) for the landing page edit. Four LLM-free
scenarios (smoke-canvas, build-reveal, tooling-tour, design-pack) driven
through Playwright + the app's own store surface. Outputs land under
`download/landing-capture/<run>/` — `video.mp4` (H.264, CRF 18, 30fps,
faststart, fades), `poster.png`, optional `frames/` QA corpus, and a
`manifest.json` with per-take PASS/FAIL verdicts.

Two helpers turn takes into landing cuts: `qa-frames.sh` (frame corpus +
objective activity timeline per take) and `make-cut.sh` (web-grade trim +
poster + verification frames). Deliverables and the selection record live
under `download/landing-uplift/`.

## Ownership

- `capture.ts` — CLI (`bunx tsx scripts/video-capture/capture.ts
  [--scenario=id] [--list] [--mode=video|frames] [--takes=N] [--fps=N]
  [--out=…] [--base-url=…]`). Orchestrates warmup → per-take document
  creation → browser context → scenario run → transcode → verdict →
  manifest. Owns the console-error filter policy (documented, each entry
  names why the noise is expected) and the localStorage seeding
  (`agentcanvas.settings.v1` theme light + `agentcanvas.onboarding.v1`
  suppressed, injected via `context.addInitScript` BEFORE app scripts).
- `scenarios.ts` — the action vocabulary (`navigate/click/move/drag/dragTo/
  stroke/type/key/wait/waitForSelector/scroll/canvasPatches/guideDrag/
  layersReparent/eval`), the executor, the four scenario definitions, and the
  patch builders (`dashboardBlocks`, `packHeroBlocks`, `tourShapes`). Owns the
  choreography contract: canvas mutations go through
  `window.__canvasStore.getState().sendPatch()` via `page.evaluate` — the
  Socket.IO ghost-collaborator path is non-viable on a direct-port dev server
  (same-origin `/socket.io` 404s without the Caddy gateway; rationale in the
  file header + README). Canvas points in actions are relative to the visible
  canvas center; patch builders receive the absolute center.
- `record.ts` — browser launch ladder (bundled Chromium → system Chrome →
  system Edge, copied from `scripts/screenshot-landing.ts`), ffmpeg/ffprobe
  verification + transcode (yuv420p, even dims, fade in/out, poster at ~90%),
  fixed-timestep frame loop (`scale: 'css'` keeps frames at viewport size).
- `probe-dialog.ts`, `probe-vars.ts` — standalone diagnostics for the two
  non-obvious behaviors (localStorage seeding before hydration; live pack-var
  resolution across a swap). Not part of the harness; run on demand.
- `qa-frames.sh` — take QA corpus + objective timeline:
  `bash scripts/video-capture/qa-frames.sh <take.mp4> <outDir> [frames] [cols]`
  → `fNN.png` (evenly spaced, full duration), `montage.png`,
  `frames-timeline.txt` (exact pts per frame via `showinfo`), `scenes.txt`
  (scene-change pts), `freezes.txt` (≥0.6s near-static intervals),
  `motion.txt` (5Hz frame-difference energy). The timelines — not the run
  log — are the trim instrument.
- `make-cut.sh` — landing cut:
  `bash scripts/video-capture/make-cut.sh <take.mp4> <out.mp4> <startS> <durationS> [crf]`
  → re-encoded cut (H.264 yuv420p, CRF 20 default, 30fps, +faststart, no
  audio, source resolution), `<out>-poster.png` at 10%, and
  `qa-check-<cutname>/check-1..4.png` (first / 33% / 66% / last) for the
  eyes-on pass.
- `README.md` — usage, choreography contract, conventions, scenario-authoring
  guide.

## Local Contracts

- **LLM-free by contract** (root AGENTS.md endpoint policy): no `/api/agent`
  calls, no endpoint touches. The build-reveal prompt is typed into the
  composer and NEVER sent.
- **Dev server**: targets `http://127.0.0.1:3000` by default (the project's own
  dev port; override with `--base-url` or `LANDING_BASE_URL` when the server
  runs elsewhere).
- **Take isolation** = one fresh `POST /api/documents {id}` per take
  (`vid-<scenario>-<stamp>-t<NN>`, matches the route's id regex) + `?doc=`
  on the URL. Do not share documents across takes.
- **Theme light always** (landing contract) — seeded pre-hydration.
- **Console-error policy**: verdict-relevant errors are FAILs; expected
  dev-server noise is filtered with a documented regex list in `capture.ts`.
  Extend the list only with a comment explaining why the noise is benign.
- **Playwright pitfalls (will bite again)**: `page.evaluate(string)` treats
  strings as expressions (arrow-function strings serialize to undefined —
  pass real functions or IIFE calls); tsx/esbuild decorates named inner
  functions with a module-scope `__name` that doesn't exist in the page (no
  named functions inside evaluate callbacks); esbuild performs no typecheck,
  so `bunx tsc --noEmit --skipLibCheck --target es2022 --module esnext
  --moduleResolution bundler --strict scripts/video-capture/*.ts` is the
  pre-run gate for action-payload typos (a mistyped field name fails only at
  runtime otherwise).
- **App facts the scenarios rely on** (re-verify after touching these areas):
  toolbar drops shapes at WINDOW center (needs `dragTo` repositioning);
  window keyboard handlers bail on editable/composite targets (blur focus
  before chord sequences); `radius` is numerically coerced at patch ingest
  while `fill` var() strings stay live (pack swaps restyle fills/borders,
  not radii); LayersPanel DnD drop targets must be containers (frame/group)
  and Chromium's `locator.dragTo` does not trigger the React synthetic DnD —
  `layersReparent` dispatches DragEvents through the panel's own contract and
  verifies the store.
- **Multi-take selection contract** (measured 2026-09-19, 3 takes × 3
  scenarios + 2 smoke takes): a PASS take is a *candidate*, never a
  deliverable. Every candidate gets a `qa-frames.sh` corpus + montage read at
  full resolution before selection; the harness `poster.png` (90%) is not
  necessarily the best still. Takes of the same scenario differ mainly in
  ±0.5s beat drift — check the drift against the cut boundaries before
  switching takes.
- **Cut boundaries**: the take wraps 0.4s fade-in/out — a cut must start and
  end outside them. Cuts must not end on an open dropdown, a mid-animation
  frame, or a mid-typing field: tooling-tour's last ~1.5s has the app menu
  open (ends before 20.7s), build-reveal's visible build starts only at 13.5s
  (the white `dash-root` frame is invisible on the white canvas; one block
  lands every 2.7s per `atMs`). Verify with `check-1`/`check-4` before
  shipping a cut.
- **Frame timestamps, not log timestamps**: the run log's wall-clock action
  times drift up to ~1.5s from the mp4 timeline (recordVideo starts at page
  creation; the transcode is CFR 30). Calibrate boundaries on extracted
  frames (`-ss <t> -frames:v 1`) or on `frames-timeline.txt`.

## Work Guidance

- When adding a scenario: follow README "Adding a scenario"; keep scenarios
  data-driven (builders over inline scripts), verify visually with extracted
  frames, and record any new app-behavior discovery here.
- On failure: edit the saved scripts in place (scripts/AGENTS.md rule); the
  failure message includes the failing action index + stack.
- After changing the harness, run the strict typecheck (see above) — the
  runtime gives no type safety.

## Verification

- `bunx tsx scripts/video-capture/capture.ts --list` — prints the 4 scenarios.
- `bunx tsx scripts/video-capture/capture.ts --scenario=smoke-canvas --takes=1`
  — exits 0, produces `take-01/video.mp4` + `poster.png` + `manifest.json`
  with verdict PASS (16-22s, 1600×1000).
- `bunx tsc --noEmit --skipLibCheck --target es2022 --module esnext
  --moduleResolution bundler --strict scripts/video-capture/*.ts` — clean.
- Extract QA frames with `ffmpeg -ss <t> -i take-01/video.mp4 -vframes 1
  out.png` and eyeball them; non-blank canvas content is the bar.
- All four scenarios verified 2026-09-19 against a dev server on the project
  port (sha eb7b7eb): smoke-canvas, build-reveal, tooling-tour, design-pack —
  video mode 1/1 PASS each; smoke-canvas frames mode 2/2 PASS.
- Multi-take selection run 2026-09-19 (same sha): 3 takes each of build-reveal
  / tooling-tour / design-pack + 2 of smoke-canvas, 11/11 PASS; landing cuts
  and the selection record in `download/landing-uplift/`
  (`capture-selection.md`). `bash scripts/video-capture/qa-frames.sh
  download/landing-capture/multi/build-reveal/take-01/video.mp4
  download/landing-uplift/qa/build-reveal-take01` → 12 PNGs + montage +
  timelines + freezes. `bash scripts/video-capture/make-cut.sh <take> <out>
  <start> <dur> 20` → cut + poster + 4 check frames, ≤3MB per cut.

## Child DOX Index

No child AGENTS.md files. This folder is flat.
