# Agent Eval Report

- Date: 2026-08-23T09:50:56.883Z
- Scenarios: 8 (4 pass / 4 fail / 0 error)
- Assertions: 58/68 passed

## ✅ simple-shape — PASS

> **Prompt:** Draw a red rounded rectangle, 240x120, in the top-left area of the canvas.

1 tool calls · 4s · 1 layers · top tools: pen_create_shapex1

- ✅ **rectangle near 240x120 exists** — 1 match(es)
- ✅ **fill is red** — found #ef4444
- ✅ **corners rounded** — radius=8
- ✅ **placed top-left (x<600, y<400)** — position ok
- ✅ **no failed tool calls** — all 1 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 1 tool calls
- ✅ **no agent errors** — clean turn

## ✅ text-heading — PASS

> **Prompt:** Add a bold heading that says 'Quarterly Report' at 32px, centered near the top of the canvas.

2 tool calls · 7s · 1 layers · top tools: pen_create_shapex1, pen_select_shapex1

- ✅ **heading text present** — Quarterly Report
- ✅ **fontSize ~32** — 32px
- ✅ **near top (y < 300)** — y ok
- ✅ **no failed tool calls** — all 2 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 2 tool calls
- ✅ **no agent errors** — clean turn

## ❌ login-hifi — FAIL

> **Prompt:** Design a polished, high-fidelity mobile login screen for a fintech app called 'Vaultly' with an email field, a password field, and a Sign In button.

18 tool calls · 26s · 11 layers · top tools: pen_set_variablex11, pen_set_shadowx4, pen_generate_wireframex1, pen_list_shapesx1, pen_apply_palettex1

- ✅ **canvas has layers** — 11 layers
- ✅ **uses a container/frame** — 1 container(s)
- ✅ **email + password copy present** — email=true password=true
- ❌ **brand "Vaultly" present** — no "Vaultly" text anywhere
- ✅ **colorful design (hi-fi)** — 3+ saturated layers
- ✅ **shadows on elevated surfaces** — shadow present
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ✅ **Sign In action present** — CTA copy ok
- ✅ **no failed tool calls** — all 18 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 18 tool calls
- ✅ **no agent errors** — clean turn

## ❌ wireframe-lofi — FAIL

> **Prompt:** Draw a low-fidelity wireframe of a blog homepage: header with nav, one hero article block, and a 3-card article grid.

2 tool calls · 10s · 14 layers · top tools: pen_generate_wireframex1, pen_list_shapesx1

- ✅ **canvas has layers** — 14 layers
- ✅ **3-card grid present** — 6 boxes, size-bands=[[800,1],[80,1],[360,1],[180,3]]
- ❌ **stays grayscale (lo-fi)** — 8 saturated layers: Brand:transparent, Hero image:#0ea5e9, Hero title:transparent — wireframe should be grayscale
- ❌ **no shadows (lo-fi)** — shadows present in a wireframe request
- ❌ **no gradients (lo-fi)** — gradient present in a wireframe request
- ✅ **no failed tool calls** — all 2 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ❌ **reasonable tool-call count** — 2 tool calls (expected 4..90)
- ✅ **no agent errors** — clean turn

## ❌ modify-precision — FAIL

> **Prompt:** Change the Banner rectangle fill to green. Leave everything else exactly as it is.

2 tool calls · 5s · 0 layers · top tools: pen_list_shapesx1, pen_update_shapex1

- ❌ **banner recolored green** — rectangle not found
- ❌ **status dot untouched** — ellipse not found (may have been deleted/rebuilt)
- ❌ **note text untouched** — text layer not found
- ❌ **no extra layers added** — 0 layers after a recolor request (expected 3) — agent over-built
- ✅ **used update-style tools** — 1 update call(s)
- ✅ **no failed tool calls** — all 2 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 2 tool calls
- ✅ **no agent errors** — clean turn

## ❌ flowchart — FAIL

> **Prompt:** Create a flowchart for a document approval process with 4 nodes: Start, Review, Approve, End — connected with arrows.

22 tool calls · 55s · 14 layers · top tools: pen_set_variablex5, pen_set_shadowx5, pen_bulk_update_by_filterx3, pen_search_iconsx3, pen_set_gradient_fillx2, pen_generate_diagramx1

- ✅ **4+ node shapes** — 4 node shapes
- ✅ **all 4 node labels present** — start/review/approve/end all present
- ✅ **connector lines present** — 6 line/path connectors
- ✅ **no failed tool calls** — all 22 tool calls succeeded
- ❌ **no duplicate consecutive calls** — 1 repeated identical call(s) in a row
- ✅ **reasonable tool-call count** — 22 tool calls
- ✅ **no agent errors** — clean turn

## ✅ dashboard-hifi — PASS

> **Prompt:** Design a high-fidelity analytics dashboard header bar plus a row of 4 KPI stat cards showing Revenue $128.4K, Active Users 8,421, Churn 2.1%, and NPS 62.

29 tool calls · 55s · 39 layers · top tools: pen_set_variablex11, pen_update_shapex8, pen_set_shadowx7, pen_generate_wireframex1, pen_list_shapesx1, pen_apply_palettex1

- ✅ **all 4 KPI values present** — all values found
- ✅ **4 card-like containers in a row** — 4 candidates, bands=[[96,4]]
- ✅ **colorful (hi-fi)** — 3+ saturated layers
- ✅ **shadows on cards** — shadow present
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ✅ **no failed tool calls** — all 29 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 29 tool calls
- ✅ **no agent errors** — clean turn

## ✅ palette-sunset — PASS

> **Prompt:** Generate a row of 5 color palette swatches for a 'Sunset' theme, each swatch labeled with its hex code.

11 tool calls · 16s · 10 layers · top tools: pen_create_shapex10, pen_generate_palettex1

- ✅ **5 saturated swatches** — 5 swatch layers
- ✅ **hex code labels present** — 5 hex labels
- ✅ **warm sunset hues** — 5/5 warm
- ✅ **no failed tool calls** — all 11 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 11 tool calls
- ✅ **no agent errors** — clean turn
