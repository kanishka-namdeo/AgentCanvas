# Landing video selection — AgentCanvas (2026-09-19)

Source: `scripts/video-capture/` harness, dev server `http://127.0.0.1:3100`, git `eb7b7eb`,
viewport 1600×1000 @2x, theme **light** (seeded pre-hydration), browser = bundled Chromium.
All captures are LLM-free by contract (no `/api/agent`, no endpoint traffic; the build-reveal
prompt is typed into the composer and never sent).

Runs (all verdicts from each run's `manifest.json`; **every take PASS, 0 console errors, 0 page errors**):

| Run dir | Scenario | Takes |
|---|---|---|
| `download/landing-capture/multi/build-reveal/` | build-reveal | 35.08 / 34.72 / 35.00 s |
| `download/landing-capture/multi/tooling-tour/` | tooling-tour | 31.16 / 30.80 / 30.92 s |
| `download/landing-capture/multi/design-pack/` | design-pack | 25.68 / 25.60 / 25.52 s |
| `download/landing-capture/multi/smoke-canvas/` | smoke-canvas | 22.68 / 22.00 s |

QA evidence per take lives in `download/landing-uplift/qa/<scenario>-take<N>/`:
`f01..f12` (evenly spaced full-res frames), `montage.png`, `frames-timeline.txt` (exact pts of each
frame), `scenes.txt` (scene-change pts), `freezes.txt` (≥0.6 s near-static intervals),
`motion.txt` (5 Hz frame-difference energy — the objective activity curve used for every trim
decision). Cross-take comparisons: `qa/cmp/*-takes-rows.png` (same timestamps, one row per take).

Harness PASS ≠ usable footage. The verdict only proves the actions ran; every take was judged
again on the frames.

---

## 1. Take verdicts

### build-reveal — dashboard assembles block-by-block while a prompt is typed
Beats (take-01, calibrated from the run log + frames): prompt typed 3.5→9.9 s; the *invisible*
white `dash-root` frame lands 10.7 s (white on white — no visible change); sidebar 13.5 s;
header 16.2 s; KPI cards 18.9 / 21.6 / 24.2 s; revenue chart 27.0 s; activity table 29.6 s;
zoom-to-fit 32.0→32.8 s; then 1.4 s static and the harness's 0.4 s fade-out (34.6→35.07).

| Take | Verdict | What the frames showed | Notes |
|---|---|---|---|
| take-01 | PASS | 12-frame montage (f01≈0.0 → f12≈32.1 s): empty canvas + typing through f05 (13.1 s); dark sidebar from f06 (16.0 s); KPIs f07-f08; chart f09-f10; table + completed dashboard f11-f12. Individual frames read: f02 (4.38 s, composer mid-prompt), f05 (13.13 s, canvas still blank, Layers already lists "Pulse Dashboard"), f06/f07 (16.0/18.9 s, sidebar+header+KPI), f08 (21.9 s), f9-f12. | Chosen |
| take-02 | PASS | Same beats, ~0.3 s earlier (14.23 s first visible change vs 14.53 s). Comparison grid row 2 (14.5/17/20/23/26.5/30 s) shows a marginally more advanced build at 14.5 s. No defects, no artifacts, cursor clean. | Rejected — no advantage, beat grid slightly ahead of the chosen cut's boundaries |
| take-03 | PASS | Identical content again (14.57 s first change); grid row 3 matches take-01 frame-for-frame at every sampled timestamp. | Rejected — same as take-01 but unverified at full frame level; no reason to switch |

Rejection reason for **all three takes as landing assets** (not as candidates):
1.4→14.5 s is one long near-static stretch (freeze log + motion profile agree) — 11 s of which
~9 s is *empty canvas after the typing stops*. The harness choreography drops one block every
2.7 s, so the visible build only starts at 13.5 s and the composition stays partly hidden behind
the right panel until the final zoom. Nothing here is a "botched drag" — the takes are simply
unusable **whole**; the money segment is 20.3→34.0 s (used for the cut).

### tooling-tour — command palette, layers, properties, rulers/guide
Beats (take-01): palette open 6.9 s, "ellipse" typed 7.3→8.1 s, INSERT ELLIPSE highlighted
~8.3 s, Enter inserts at 8.9 s, Escape 9.3 s; Layers tab 10.2 s, row select 11.5 s, Tag→Board
reparent 12.7 s; Properties 14.4 s, rect selected 15.0 s, Width 240→320 at 15.9 s; fill clicked
17.0 s, `#f97316` typed 18.6→19.2 s (canvas turns orange); app menu 19.8 s → Rulers 20.3 s;
guide dragged 23.4 s; panel drag 28.2 s; 30.8 s fade-out.

| Take | Verdict | What the frames showed | Notes |
|---|---|---|---|
| take-01 | PASS | 12-frame montage + full frames f05 (10.39 s: layers list Ellipse/Board/Tag/Title/Note/Panel B/Panel A, newly inserted ellipse selected), f06 (12.99 s: Ellipse row highlighted, Tag nested under Board = reparent done), f07 (15.58 s: Properties, Panel A, W 240, Fill #e2e8f0), f08 (18.18 s: W 320, Fill mid-typed "#f97", rect orange), f09 (20.78 s), f10 (23.37 s: rulers + red guide), f11 (25.97 s). 1 s-interval montage 5→16 s for the opening. | Chosen |
| take-02 | PASS | 12-frame montage + comparison-grid row 2: same states at the same timestamps (7.8 s palette, 10.4 s board+ellipse, 18.2 s orange fill, 23.4 s guide, 28.6 s end). | Rejected — identical, no advantage |
| take-03 | PASS | Comparison-grid row 3: content matches, but the take runs ~0.5 s *ahead* of 01/02 (Layers panel already open at 10.4 s where 01/02 still show the canvas). The montage tile at 13.3 s renders the Layers tree with a row label that reads oddly at thumbnail scale ("Ant" vs "Tag"). | Rejected — timing drift, needs its own boundary calibration; simplest to stay on take-01 |

Hazard found while cutting: the last ~1.5 s of the take has the **app menu dropdown open**
("FILE / EDIT" covering the left edge, labels clipped). Any cut that runs into it ends on a
half-covered dropdown — the cut stops at 20.7 s, before the menu opens.

### design-pack — pack swap restyles a token-bound hero card
Beats (take-01): hero card assembles 0→8.5 s (7 token-bound blocks, 1.4 s apart); picker dialog
opens 12.3 s; Vercel Geist selected + applied ~14.5 s (corners square off, BORDER token goes
black, toast "Design system set to vercel-geist"); picker again 17.8 s; Mantine selected +
applied ~20.5 s; zoom-to-fit 23.8 s (100 % → 122 %); fade 25.3→25.68 s.

| Take | Verdict | What the frames showed | Notes |
|---|---|---|---|
| take-01 | PASS | 12-frame montage + full frames f05 (8.56 s: complete shadcn card — rounded, blue accent, BORDER swatch light gray, stats row), f08 (14.97 s: Geist applied — square corners, BORDER swatch black, "vercel-geist" toast bottom-right), f10 (19.25 s: "Choose a design system" dialog with shadcn/ui, Vercel Geist, Mantine (highlighted), Radix Themes, Catalyst + Cancel/Use this pack), f12 (23.53 s: Mantine applied, 122 % zoom). | Chosen |
| take-02 | PASS | 12-frame montage: identical to take-01 (12.0-12.4 s picker spike, 14.4-14.8 s Geist swap, 17.6-18.0 s dialog, 20.4-20.8 s Mantine swap, 25.2 s fade). | Rejected — identical; 2.60 MB source, largest of the three |
| take-03 | PASS | 12-frame montage: identical (12.0-12.2 / 14.2-14.6 / 17.6-17.8 / 20.2-20.6 s). | Rejected — identical |

Honest weakness: the visible restyle delta between packs is **subtle** (corner radii + one border
token + the toast). The labelled swatch row and the dialog do the storytelling; at landing-tile
size the pack change alone will not read without a caption.

### smoke-canvas — toolbar add + freehand stroke + undo/redo + selection
Beats (take-01): rect placed 3.7 s (window centre, then dragged 4.5→5.5 s); Select tool 6.2 s;
freehand stroke sweep ~6→8 s; 4× Ctrl+Z retracts it 8.5→10 s; 4× Ctrl+Shift+Z replays it
~11→13.4 s; the rectangle is clicked (selection handles) ~20.5 s; fade 22.3→22.68 s.

| Take | Verdict | What the frames showed | Notes |
|---|---|---|---|
| take-01 | PASS | 12-frame montage + full frames f05 (7.56 s: rect selected, W160 H100, empty canvas), f07 (11.33 s: partial stroke + selection box — mid-undo), f08 (13.22 s: complete blue stroke, nothing selected), f12 (20.78 s: rect selected + stroke), plus a 1 s montage 5→16 s and a 16.5/18/19.5/21/21.9 s tail probe. | Chosen |
| take-02 | PASS | 12-frame montage + comparison-grid row 2 at 3.8/6.5/9.5/11.5/15/20.5 s: same states, same positions. | Rejected — identical, 0.4 s shorter tail only |

Honest weaknesses: the canvas is *sparse* (one gray rect + one blue curve), the undo/redo walk is
thin-line detail that will not read at landing size, and the source is dead from ~16 s (redo tail)
to 22.3 s. The cut takes only 4.0→13.3 s and drops the late rectangle-selection beat (it sits
behind ~6 s of nothing).

---

## 2. Landing cuts

Commands (`scripts/video-capture/make-cut.sh` — re-encode, never stream-copy, so the cut starts on
a keyframe):

```
bash scripts/video-capture/make-cut.sh <take>/video.mp4 <out>.mp4 <startS> <durationS> 20
```

All cuts: H.264 `yuv420p`, CRF 20, `-preset slow`, 30 fps, `+faststart`, no audio, source
resolution 1600×1000 kept. Start/end chosen **outside** the take's 0.4 s fades.

| Cut | Duration | Bytes | CRF | Window (take time) | Trim rationale |
|---|---|---|---|---|---|
| `build-reveal-cut.mp4` | 13.70 s | 437 KB | 20 | 20.30 → 34.00 | Drops the 11 s dead lead-in and the fade. Starts on the second KPI card landing, ends on the settled zoom-to-fit reveal (the only moment the whole dashboard is visible — pre-zoom it is clipped by the right panel). No speed-up: the assembly pace is the point. |
| `tooling-tour-cut.mp4` | 13.10 s | 638 KB | 20 | 7.60 → 20.70 | Starts on the palette with "ellipse" typed and INSERT ELLIPSE highlighted (not on the generic FILE/EDIT list 0.6 s earlier), ends on the orange fill + Properties **before** the app menu opens (20.7 s; menu open ≈20.9-21.7 s would have been the last frame). Covers palette → insert → layers reparent → width 320 → fill #f97316. |
| `design-pack-cut.mp4` | 13.80 s | 1 488 KB | 20 | 11.40 → 25.20 | Starts on the complete shadcn card (assembly already done, so no half-drawn shapes in frame 1), ends on the settled Mantine + 122 % zoom frame 0.1 s before the fade. Two pack swaps + both dialog appearances inside the window. |
| `smoke-canvas-cut.mp4` | 9.30 s | 386 KB | 20 | 4.00 → 13.30 | Window is bounded by dead time, not by taste: before 3.7 s the canvas is empty, after ~13.6 s the undo strip leaves the frame mid-state. Starts as the rectangle is dropped (no empty-canvas opener), ends on the completed stroke. |

Byte budget: hero-grade research budget ≤3 MB — the largest cut is 1.49 MB, so no CRF increase was
needed; CRF 20 kept as specified.

Poster frames (PNG, extracted from the cut, deliberately chosen — the harness's own `poster.png`
at 90 % lands mid-zoom and is not the best still):

| Poster | Cut time | Shows |
|---|---|---|
| `build-reveal-cut-poster.png` | 13.20 s | Completed dashboard at 66 % — sidebar, 3 KPI cards, revenue chart, activity table |
| `tooling-tour-cut-poster.png` | 13.00 s | Orange rectangle selected (W 320), Fill `#f97316`, Properties inspector, board composition |
| `design-pack-cut-poster.png` | 7.85 s | "Choose a design system" dialog with the 5 packs + Use this pack |
| `smoke-canvas-cut-poster.png` | 9.10 s | Rectangle + completed freehand stroke |

Cut verification (4 frames per cut read at full resolution — `selected/qa-check-<cut>/check-1..4.png`):

- build-reveal: check-1 20.3 s = mid-build (sidebar + header + 1 KPI, prompt visible in composer,
  clean) ✓; check-2 24.8 s = 2 KPIs ✓; check-3 29.3 s = 2.5 KPIs + chart bars (churn card and chart
  right edge still clipped by the right panel — expected, resolved by the end zoom) ✓;
  check-4 33.95 s = zoomed complete dashboard ✓.
- tooling-tour: check-1 = palette + INSERT ELLIPSE highlighted ✓; check-2 11.9 s = Layers tree ✓;
  check-3 16.25 s = Properties W 240 Fill #e2e8f0 ✓; check-4 20.65 s = orange rect + Properties,
  no menu ✓.
- design-pack: check-1 = complete shadcn card ✓; check-2 15.7 s = Geist applied (black BORDER
  swatch + toast) ✓; check-3 20.05 s = picker dialog, Mantine highlighted ✓; check-4 25.15 s =
  Mantine + 122 % ✓.
- smoke-canvas: check-1 4.0 s = rectangle just placed at window centre ✓; check-2 7.07 s = rect
  dragged, pre-stroke ✓; check-3 10.14 s = mid-undo state, stroke partly retracted (by design) ✓;
  check-4 13.25 s = rectangle + complete stroke ✓.

---

## 3. Legacy `public/landing/` mp4s (not deleted)

| File | Spec | Assessment |
|---|---|---|
| `core-agent-chat.mp4` | 35.1 s, 1280×800, 25 fps | **Stale / not usable.** Frames show a Claude-Code-style permission UI — "CLAUDE" provider label with a thinking spinner, a "Redirect (Shift+Tab to cycle)" confirmation row with Allow/Deny, old window chrome ("agentcanvas — Untitled", Docs/camera buttons) and an **empty canvas for the whole clip** ("Describe what to build in the chat — or press Ctrl+K for presets" stays on screen). It is one UI generation old and shows no product output. |
| `core-trust-loop.mp4` | 12.1 s, 1280×800, 25 fps | **Closest legacy asset, but still one generation old.** Light theme ✓; canvas shows a "Vaultly" dashboard (TOTAL REVENUE $128.4K, ACTIVE USERS 8,249, Revenue Trend) and the real TrustLoop payoff: "Approve destructive operation — The agent wants to run an operation that deletes content… Delete 2 layers … Deny / Approve". But the chrome is old (File/Edit/View/Object/Window/Help menubar, "Adjust" + "Claude 2.5" chips, right panel with Chat/Design/History tabs instead of the current Agent Chat + preset chips), the resolution is 1280×800 (soft when scaled), and the canvas content is scrappy agent output (giant yellow star, purple hexagon, half-finished green rect). Usable only as a last-resort TrustLoop motion clip. |

Gap for the main agent: **no current-UI footage of the approval dialog exists** in this capture set
(the harness has no approval scenario). For the TrustLoop section, either use the existing static
`public/landing/approval-dialog.png`, or commission a new LLM-free scenario that opens the
approval dialog with the current chrome — `core-trust-loop.mp4` would visibly regress the UI.

---

## 4. Placement recommendation

| Cut | Best section | Why |
|---|---|---|
| `build-reveal-cut.mp4` | **MagicSequence** (sticky 4/3 frame, currently crossfading hero-build.png → AgentTimeline mock → dashboard-complete.png) | It *is* the sequence: 13 s of a dashboard assembling to exactly the `dashboard-complete.png` state, ending on the zoom reveal — it can replace the first crossfade with real motion (crop 1600×1000 → centred 4/3 ≈ 1333×1000 or letterbox). Second choice: Hero 100vh opener as the autoplay visual, looped. |
| `tooling-tour-cut.mp4` | **FeatureGallery** bento tile (wide tile, "the pro tool surface") | One clip shows four distinct surfaces in sequence — ⌘K palette with a live search, Layers tree with DnD reparent, Properties inspector numbers, and a colour change — so a single tile communicates depth. Also works in the **parallax screenshot band** (16:10 matches the band's wide crop). |
| `design-pack-cut.mp4` | **FeatureGallery** tile for design-system packs | The "Choose a design system" dialog is the most legible frame and unique to this feature; pair it with a caption ("swap packs, re-theme the canvas") because the token delta is subtle at tile size. Alternative: HowItWorks step where the system is chosen. |
| `smoke-canvas-cut.mp4` | **HowItWorks** step ("draw and refine directly on the canvas") — or leave unused | Only clip showing direct-manipulation + undo/redo, but it is visually sparse and the undo walk is thin-line detail. If HowItWorks needs three beats, this is the weakest of the four and the first to drop. |

---

## 5. Files

```
download/landing-uplift/
  capture-selection.md
  selected/
    build-reveal-take1.mp4      (35.07 s, 1.33 MB, full take)
    build-reveal-cut.mp4        (13.70 s, 437 KB)  + build-reveal-cut-poster.png
    tooling-tour-take1.mp4      (31.17 s, 1.85 MB)
    tooling-tour-cut.mp4        (13.10 s, 638 KB)  + tooling-tour-cut-poster.png
    design-pack-take1.mp4       (25.67 s, 2.33 MB)
    design-pack-cut.mp4         (13.80 s, 1.49 MB) + design-pack-cut-poster.png
    smoke-canvas-take1.mp4      (22.67 s, 1.03 MB)
    smoke-canvas-cut.mp4        (9.30 s, 386 KB)   + smoke-canvas-cut-poster.png
    qa-check-<cut>/check-1..4.png        cut verification frames (read at full res)
  qa/                                   per-take frame corpora + objective timelines
```

Raw takes stay in `download/landing-capture/multi/<scenario>/take-0N/` (with `manifest.json`,
`console.log`, `raw/*.webm`).
