# video-capture — AgentCanvas landing video harness

Captures production-grade product videos of the AgentCanvas workspace for the
landing page. LLM-free by contract (no `/api/agent` calls, no endpoint
touches — root AGENTS.md endpoint policy): every canvas mutation is
choreographed through the app's own store surface, and the "typed prompt"
lands in the composer but is **never sent**.

## Usage

```bash
# one scenario, video mode (default)
bunx tsx scripts/video-capture/capture.ts --scenario=smoke-canvas --takes=1

# everything, 3 takes each, into a custom dir
bunx tsx scripts/video-capture/capture.ts --takes=3 --out=download/landing-capture/run-a

# frames mode (QA scrubbing — fixed-timestep PNGs, no ffmpeg needed)
bunx tsx scripts/video-capture/capture.ts --scenario=build-reveal --mode=frames --fps=10

# list scenarios
bunx tsx scripts/video-capture/capture.ts --list
```

Flags: `--scenario=<id[,id2]>` (default: all) · `--list` · `--mode=video|frames`
· `--takes=N` (default 1) · `--fps=N` (frames mode, default 10) ·
`--out=download/landing-capture/<name>` (default `<scenario>-<timestamp>`) ·
`--base-url=http://127.0.0.1:3000` (default: `LANDING_BASE_URL` env, then
`http://127.0.0.1:3000`).

Requirements: dev server running on the project port (default `3000`); system
`ffmpeg` + `ffprobe` on PATH (video mode), playwright-core (launches bundled
Chromium → system Chrome → system Edge, per `scripts/screenshot-landing.ts`).

## Outputs (all under `download/`, per scripts/AGENTS.md)

```
download/landing-capture/<run>/
  manifest.json          scenario metadata + per-take verdicts (see below)
  console.log            timestamped harness + console log for the run
  take-01/
    video.mp4            H.264/yuv420p, CRF 18, 30fps, +faststart, fades
    poster.png           frame at ~90% duration (fully-assembled state)
    raw/*.webm           Playwright recordVideo original (kept for QA)
    frames/frame-NNNNN.png   (frames mode) fixed-timestep viewport PNGs
    console.log          per-take log
```

`manifest.json` carries: scenario id/title, base URL, mode, fps (frames
mode), viewport + deviceScaleFactor, theme, timestamp, git SHA, browser
channel, the choreography + seeding notes, and per-take
`{index, mp4, poster, webm, framesDir, frameCount, durationS, dimensions,
bytes, consoleErrors[], pageErrors[], verdict: PASS|FAIL, failure,
actionsExecuted}`. Exit code is non-zero unless every take passes.

## Take verdicts

A take **PASSES** only when: zero action throws, every
`requireSelectors` entry exists at the end, zero page errors, and zero
*unfiltered* console errors. Filtered (expected dev-server noise, each
documented in `capture.ts`): socket.io handshake 404s / failed WebSocket
retries (the browser socket cannot connect on a direct-port dev server — see
below), the React DevTools suggestion, and the known-benign
`caret-color` hydration-mismatch dev warning.

## Choreography contract (the important bit)

Canvas mutations are replayed through the app's OWN store surface:

```js
page.evaluate(() => window.__canvasStore.getState().sendPatch(patch))
```

**Why not a Socket.IO "ghost collaborator"?** The client socket connects to
`io('/?XTransformPort=3003')` — same-origin — and the `?XTransformPort`
routing only exists behind the z.ai Caddy gateway (`Caddyfile`). On a
direct-port dev server (`127.0.0.1:3000`) the `/socket.io` handshake 404s, so
the browser socket never connects; a Node-side `socket.io-client` emitting to
the in-process canvas-sync server on :3003 would journal patches server-side
without the browser UI ever seeing them. The store path always applies
optimistically in-UI (`store.ts` `sendPatch` → `enqueuePatch`) with the app's
own mutation identity / undo semantics — exactly like a user edit.

Facts that follow from this (all verified, recorded in each manifest):

- **Seeding** = `POST /api/documents {id}` before navigation + `?doc=<id>` on
  the URL. One FRESH document per take guarantees an empty canvas — no
  localStorage/socket persistence is involved in take isolation. (User
  patches are NOT journaled server-side when the socket is down, and are not
  restored from the outbox across reloads, so pre-seeding "before recording"
  can only happen inside the same page session — i.e. during the take.)
- **Freehand stroke**: the UI has no freehand tool (P routes to chat), so the
  `stroke` action adds a `path` shape via sendPatch and streams its
  `points` (absolute canvas coords) while the pointer sweeps an eased sine
  curve. Each streamed update is its own undo entry, so Ctrl+Z walks the
  stroke back chunk-by-chunk (the smoke-canvas undo beat).
- **Pack swaps restyle live**: pack `--color-*` vars are referenced directly
  by shape fills and resolve against the `PackTokensStyle`-injected
  tokens.css, so `setActivePack` restyles the canvas instantly. `radius` is
  numerically coerced at patch ingest (`num()` in `patch.ts`), so radii are
  static numbers — the strongest cross-pack deltas are `--color-border-strong`
  (shadcn `#d4d4d8` → geist `#0a0a0a`) and the accent hues.
- **Keyboard chords need focus discipline**: window key handlers bail on
  editable/composite targets, so scenarios blur `document.activeElement`
  before chord sequences (after the palette, after the layers DnD, after
  typing).
- **Playwright gotchas encoded in `scenarios.ts`**: `page.evaluate(string)`
  treats the string as an *expression* (pass real functions or IIFE calls);
  tsx/esbuild decorates named inner functions with a `__name` helper that
  does not exist in the page (no named functions inside evaluate callbacks).

## Coordinates

Action `canvas` points are **relative to the visible canvas center**
(computed live from the store's viewport pan/zoom), so scenarios never depend
on panel widths or the default `panX/panY` = 120/80. `canvasPatches` builders
receive the ABSOLUTE canvas center (they need real geometry). Note the
toolbar drops shapes at *window* center (half under the right panel in the
3-column layout) — reposition with a `dragTo` action.

## Conventions

- Light theme always (landing contract) — seeded via
  `localStorage['agentcanvas.settings.v1']` BEFORE app scripts load
  (`context.addInitScript`), together with `agentcanvas.onboarding.v1`
  (suppresses the first-visit onboarding dialog).
- Take dirs are 2-digit prefixed (`take-01/…`); every take gets a fresh
  document id `vid-<scenario>-<stamp>-t<NN>` (≤64 chars, matches the
  `/api/documents` id regex).
- Scenario ids are stable — never rename one that has been used in a
  manifest (the id is the join key for the landing edit).

## Adding a scenario

1. Append a `Scenario` to `SCENARIOS` in `scenarios.ts`: `id`, `title`,
   `description`, optional `viewport` (default 1600×1000 @2x),
   `theme` (default light), `seedLocalStorage`, `cursor`, `requireSelectors`,
   and the ordered `actions` list.
2. Actions: `navigate`, `click` (selector / text / canvas point), `move`,
   `drag`, `dragTo`, `stroke`, `type`, `key`, `wait`, `waitForSelector`,
   `scroll`, `canvasPatches` (static `patches` or a `build(env)` factory),
   `guideDrag`, `layersReparent`, `eval`. Canvas points in actions are
   center-relative; patch builders get absolute geometry.
3. If the scenario needs page-side diagnostics, follow the probe pattern
   (`probe-dialog.ts`, `probe-vars.ts`) instead of printing from the
   scenario itself.
4. Run `--scenario=<id> --takes=1`, then check `qa/` frames extracted with
   `ffmpeg -ss <t> -i take-01/video.mp4 -vframes 1 out.png` before calling it
   done. Edit the saved script in place on failure (scripts/AGENTS.md rule).

## From takes to landing cuts

The harness PASS verdict only proves the actions ran — it says nothing about
whether the footage is watchable. The selection pipeline is:

```bash
# 1. multi-take capture (one scenario per invocation; ~1 min/take)
bunx tsx scripts/video-capture/capture.ts --scenario=build-reveal --takes=3 --out=download/landing-capture/multi/build-reveal

# 2. QA corpus + objective timeline per candidate take
bash scripts/video-capture/qa-frames.sh <take>/video.mp4 download/landing-uplift/qa/<name> 12 4
#    → fNN.png, montage.png, frames-timeline.txt, scenes.txt, freezes.txt, motion.txt
#    Read the frames (montage for triage, full-res for the finalists). Reject
#    dark takes, mid-state freezes, empty-canvas stretches, mid-typing ends.

# 3. cut the chosen take (outside the take's 0.4s fades) + poster + check frames
bash scripts/video-capture/make-cut.sh <take>/video.mp4 download/landing-uplift/selected/<scenario>-cut.mp4 20.3 13.7 20
#    Read qa-check-<name>/check-1..4.png: first frame clean, key beats intact,
#    last frame clean. ≤3MB per cut; raise CRF one step only if over.
```

Selection records (per-take verdicts, rejection evidence, placement notes) go
next to the cuts, e.g. `download/landing-uplift/capture-selection.md`.

## Files

- `capture.ts` — CLI, orchestration, seeding, console-error policy, manifest.
- `scenarios.ts` — action types + executor + the four scenario definitions
  and patch builders.
- `record.ts` — browser launch (bundled→chrome→msedge), ffmpeg transcode
  (H.264 yuv420p CRF 18 30fps +faststart, even dims, fade in/out), poster
  extraction, fixed-timestep frame loop.
- `qa-frames.sh` — QA corpus + activity/freeze/scene timelines for one take.
- `make-cut.sh` — landing cut + poster + 4 verification frames for one take.
- `probe-dialog.ts`, `probe-vars.ts` — standalone diagnostics for the two
  non-obvious behaviors (localStorage seeding before hydration; live pack-var
  resolution across a swap). Run via `bunx tsx scripts/video-capture/<file>`.
