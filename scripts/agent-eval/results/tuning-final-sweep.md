# Agent Eval Report

- Date: 2026-08-31T03:47:10.123Z
- Scenarios: 6 (4 pass / 2 fail / 0 error)
- Repeats per scenario: 2 (results below are per-run; see the Variance table)
- Assertions: 44/46 passed

## ✅ text-heading (run 1/2) — PASS

> **Prompt:** Add a bold heading that says 'Quarterly Report' at 32px, centered near the top of the canvas.

1 tool calls · 16s · 1 layers · top tools: pen_create_nodex1

- ✅ **heading text present** — Quarterly Report
- ✅ **fontSize ~32** — 32px
- ✅ **near top (y < 300)** — y ok
- ✅ **no failed tool calls** — all 1 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 1 tool calls
- ✅ **no agent errors** — clean turn

## ✅ text-heading (run 2/2) — PASS

> **Prompt:** Add a bold heading that says 'Quarterly Report' at 32px, centered near the top of the canvas.

1 tool calls · 12s · 1 layers · top tools: pen_create_nodex1

- ✅ **heading text present** — Quarterly Report
- ✅ **fontSize ~32** — 32px
- ✅ **near top (y < 300)** — y ok
- ✅ **no failed tool calls** — all 1 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 1 tool calls
- ✅ **no agent errors** — clean turn

## ✅ wireframe-lofi (run 1/2) — PASS

> **Prompt:** Draw a low-fidelity wireframe of a blog homepage: header with nav, one hero article block, and a 3-card article grid.

2 tool calls · 15s · 14 layers · top tools: pen_generate_wireframex1, pen_get_metadatax1

- ✅ **canvas has layers** — 14 layers
- ✅ **3-card grid present** — 6 boxes, size-bands=[[800,1],[80,1],[360,1],[180,3]]
- ✅ **stays grayscale (lo-fi)** — 0 saturated layer(s) (tolerance 1)
- ✅ **no shadows (lo-fi)** — flat as expected
- ✅ **no gradients (lo-fi)** — no gradients as expected
- ✅ **no failed tool calls** — all 2 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 2 tool calls
- ✅ **no agent errors** — clean turn

## ✅ wireframe-lofi (run 2/2) — PASS

> **Prompt:** Draw a low-fidelity wireframe of a blog homepage: header with nav, one hero article block, and a 3-card article grid.

1 tool calls · 13s · 14 layers · top tools: pen_generate_wireframex1

- ✅ **canvas has layers** — 14 layers
- ✅ **3-card grid present** — 6 boxes, size-bands=[[800,1],[80,1],[360,1],[180,3]]
- ✅ **stays grayscale (lo-fi)** — 0 saturated layer(s) (tolerance 1)
- ✅ **no shadows (lo-fi)** — flat as expected
- ✅ **no gradients (lo-fi)** — no gradients as expected
- ✅ **no failed tool calls** — all 1 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 1 tool calls
- ✅ **no agent errors** — clean turn

## ❌ palette-sunset (run 1/2) — FAIL

> **Prompt:** Generate a row of 5 color palette swatches for a 'Sunset' theme, each swatch labeled with its hex code.

2 tool calls · 37s · 18 layers · top tools: pen_generate_palettex1, pen_create_subtreex1

- ❌ **5 saturated swatches** — only 4 saturated swatch layers
- ✅ **hex code labels present** — 5 hex labels
- ✅ **warm sunset hues** — 3/4 warm
- ✅ **no failed tool calls** — all 2 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 2 tool calls (macro-tool exception applied: pen_generate_palette, pen_create_subtree)
- ✅ **no agent errors** — clean turn

## ❌ palette-sunset (run 2/2) — FAIL

> **Prompt:** Generate a row of 5 color palette swatches for a 'Sunset' theme, each swatch labeled with its hex code.

2 tool calls · 42s · 18 layers · top tools: pen_generate_palettex1, pen_create_subtreex1

- ❌ **5 saturated swatches** — only 4 saturated swatch layers
- ✅ **hex code labels present** — 5 hex labels
- ✅ **warm sunset hues** — 4/4 warm
- ✅ **no failed tool calls** — all 2 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 2 tool calls (macro-tool exception applied: pen_generate_palette, pen_create_subtree)
- ✅ **no agent errors** — clean turn

## Variance (2 runs per scenario)

| scenario | pass rate | tools (mean/min/max) | duration s (mean/min/max) | assertions | flaky assertions |
| --- | --- | --- | --- | --- | --- |
| text-heading | 100% (2/2) | 1.0/1/1 | 14/12/16 | 14/14 | — |
| wireframe-lofi | 100% (2/2) | 1.5/1/2 | 14/13/15 | 18/18 | — |
| palette-sunset | 0% (0/2) | 2.0/2/2 | 40/37/42 | 12/14 | 5 saturated swatches 0% |
