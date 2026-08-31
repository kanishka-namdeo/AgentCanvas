# Agent Eval Report

- Date: 2026-08-30T21:57:21.577Z
- Scenarios: 16 (7 pass / 9 fail / 0 error)
- Repeats per scenario: 2 (results below are per-run; see the Variance table)
- Assertions: 99/136 passed

## ✅ simple-shape (run 1/2) — PASS

> **Prompt:** Draw a red rounded rectangle, 240x120, in the top-left area of the canvas.

4 tool calls · 20s · 1 layers · top tools: pen_create_nodex2, pen_generate_design_briefx1, pen_set_variablesx1

- ✅ **rectangle near 240x120 exists** — 1 match(es)
- ✅ **fill is red** — found #f43f5e
- ✅ **corners rounded** — radius=12
- ✅ **placed top-left (x<600, y<400)** — position ok
- ✅ **no failed tool calls** — all 4 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 4 tool calls
- ✅ **no agent errors** — clean turn

## ❌ simple-shape (run 2/2) — FAIL

> **Prompt:** Draw a red rounded rectangle, 240x120, in the top-left area of the canvas.

4 tool calls · 14s · 1 layers · top tools: pen_create_nodex2, pen_generate_design_briefx1, pen_set_variablesx1

- ✅ **rectangle near 240x120 exists** — 1 match(es)
- ❌ **fill is red** — no rectangle with a red-hue fill
- ✅ **corners rounded** — radius=12
- ✅ **placed top-left (x<600, y<400)** — position ok
- ✅ **no failed tool calls** — all 4 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 4 tool calls
- ✅ **no agent errors** — clean turn

## ✅ text-heading (run 1/2) — PASS

> **Prompt:** Add a bold heading that says 'Quarterly Report' at 32px, centered near the top of the canvas.

2 tool calls · 15s · 1 layers · top tools: pen_get_metadatax1, pen_create_nodex1

- ✅ **heading text present** — Quarterly Report
- ✅ **fontSize ~32** — 32px
- ✅ **near top (y < 300)** — y ok
- ✅ **no failed tool calls** — all 2 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 2 tool calls
- ✅ **no agent errors** — clean turn

## ✅ text-heading (run 2/2) — PASS

> **Prompt:** Add a bold heading that says 'Quarterly Report' at 32px, centered near the top of the canvas.

2 tool calls · 22s · 1 layers · top tools: pen_get_metadatax1, pen_create_nodex1

- ✅ **heading text present** — Quarterly Report
- ✅ **fontSize ~32** — 32px
- ✅ **near top (y < 300)** — y ok
- ✅ **no failed tool calls** — all 2 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 2 tool calls
- ✅ **no agent errors** — clean turn

## ❌ login-hifi (run 1/2) — FAIL

> **Prompt:** Design a polished, high-fidelity mobile login screen for a fintech app called 'Vaultly' with an email field, a password field, and a Sign In button.

7 tool calls · 195s · 1 layers · top tools: pen_get_metadatax2, pen_generate_design_briefx1, pen_create_subtreex1, pen_set_variablesx1, pen_apply_palettex1, pen_clearx1

- ❌ **canvas has layers** — only 1 layers — too few for a login screen
- ✅ **uses a container/frame** — 1 container(s)
- ❌ **email + password copy present** — email=false password=false
- ❌ **brand "Vaultly" present** — no "Vaultly" text anywhere
- ❌ **colorful design (hi-fi)** — fewer than 3 saturated-color layers — looks grayscale
- ❌ **shadows on elevated surfaces** — no shadow anywhere — flat/wireframe look
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ❌ **Sign In action present** — no "Sign In" text
- ✅ **no failed tool calls** — all 7 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 7 tool calls
- ❌ **no agent errors** — errors: Agent stream stalled — no output for 2 minutes. The run was closed to avoid hanging; resend the prompt to retry.

## ✅ login-hifi (run 2/2) — PASS

> **Prompt:** Design a polished, high-fidelity mobile login screen for a fintech app called 'Vaultly' with an email field, a password field, and a Sign In button.

18 tool calls · 77s · 17 layers · top tools: pen_update_nodex7, pen_set_shadowx3, pen_get_metadatax2, pen_generate_design_briefx1, pen_create_subtreex1, pen_set_variablesx1

- ✅ **canvas has layers** — 17 layers
- ✅ **uses a container/frame** — 1 container(s)
- ✅ **email + password copy present** — email=true password=true
- ✅ **brand "Vaultly" present** — brand copy ok
- ✅ **colorful design (hi-fi)** — 3+ saturated layers
- ✅ **shadows on elevated surfaces** — shadow present
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ✅ **Sign In action present** — CTA copy ok
- ✅ **no failed tool calls** — all 18 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 18 tool calls
- ✅ **no agent errors** — clean turn

## ✅ wireframe-lofi (run 1/2) — PASS

> **Prompt:** Draw a low-fidelity wireframe of a blog homepage: header with nav, one hero article block, and a 3-card article grid.

2 tool calls · 7s · 14 layers · top tools: pen_generate_wireframex1, pen_get_metadatax1

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

1 tool calls · 8s · 14 layers · top tools: pen_generate_wireframex1

- ✅ **canvas has layers** — 14 layers
- ✅ **3-card grid present** — 6 boxes, size-bands=[[800,1],[80,1],[360,1],[180,3]]
- ✅ **stays grayscale (lo-fi)** — 0 saturated layer(s) (tolerance 1)
- ✅ **no shadows (lo-fi)** — flat as expected
- ✅ **no gradients (lo-fi)** — no gradients as expected
- ✅ **no failed tool calls** — all 1 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 1 tool calls
- ✅ **no agent errors** — clean turn

## ❌ modify-precision (run 1/2) — FAIL

> **Prompt:** Change the Banner rectangle fill to green. Leave everything else exactly as it is.

0 tool calls · 20s · 3 layers · top tools: —

- ❌ **banner recolored green** — fill=#3b82f6 is not green-hued
- ✅ **status dot untouched** — fill=#ef4444
- ✅ **note text untouched** — unchanged
- ✅ **no extra layers added** — still 3 layers
- ❌ **used update-style tools** — no update/set_fill tool used
- ✅ **no failed tool calls** — all 0 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ❌ **reasonable tool-call count** — 0 tool calls (expected 1..90)
- ❌ **no agent errors** — errors: The model returned an empty response (no text and no tool calls). This usually means the LLM provider is rate-limited (HTTP 429) or temporarily unavailable. Wait about a minute and resend your prompt;

## ❌ modify-precision (run 2/2) — FAIL

> **Prompt:** Change the Banner rectangle fill to green. Leave everything else exactly as it is.

0 tool calls · 20s · 3 layers · top tools: —

- ❌ **banner recolored green** — fill=#3b82f6 is not green-hued
- ✅ **status dot untouched** — fill=#ef4444
- ✅ **note text untouched** — unchanged
- ✅ **no extra layers added** — still 3 layers
- ❌ **used update-style tools** — no update/set_fill tool used
- ✅ **no failed tool calls** — all 0 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ❌ **reasonable tool-call count** — 0 tool calls (expected 1..90)
- ❌ **no agent errors** — errors: The model returned an empty response (no text and no tool calls). This usually means the LLM provider is rate-limited (HTTP 429) or temporarily unavailable. Wait about a minute and resend your prompt;

## ❌ flowchart (run 1/2) — FAIL

> **Prompt:** Create a flowchart for a document approval process with 4 nodes: Start, Review, Approve, End — connected with arrows.

0 tool calls · 22s · 0 layers · top tools: —

- ❌ **4+ node shapes** — only 0 node shapes
- ❌ **all 4 node labels present** — missing labels: start, review, approve, end
- ❌ **connector lines present** — only 0 line/path layers — no arrows
- ✅ **no failed tool calls** — all 0 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ❌ **reasonable tool-call count** — 0 tool calls (expected 2..90)
- ❌ **no agent errors** — errors: The model returned an empty response (no text and no tool calls). This usually means the LLM provider is rate-limited (HTTP 429) or temporarily unavailable. Wait about a minute and resend your prompt;

## ✅ flowchart (run 2/2) — PASS

> **Prompt:** Create a flowchart for a document approval process with 4 nodes: Start, Review, Approve, End — connected with arrows.

23 tool calls · 59s · 12 layers · top tools: pen_set_shadowx5, pen_get_metadatax5, pen_bulk_update_by_filterx4, pen_generate_diagramx2, pen_find_nodesx2, pen_generate_design_briefx1

- ✅ **4+ node shapes** — 4 node shapes
- ✅ **all 4 node labels present** — start/review/approve/end all present
- ✅ **connector lines present** — 3 line/path connectors
- ✅ **no failed tool calls** — all 23 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 23 tool calls
- ✅ **no agent errors** — clean turn

## ❌ dashboard-hifi (run 1/2) — FAIL

> **Prompt:** Design a high-fidelity analytics dashboard header bar plus a row of 4 KPI stat cards showing Revenue $128.4K, Active Users 8,421, Churn 2.1%, and NPS 62.

4 tool calls · 97s · 11 layers · top tools: pen_generate_variantsx1, pen_create_subtreex1, pen_set_variablesx1, pen_apply_palettex1

- ❌ **all 4 KPI values present** — missing values: 128.4, 8,421, 2.1, 62
- ✅ **4 card-like containers in a row** — 4 candidates, bands=[[264,4]]
- ✅ **colorful (hi-fi)** — 3+ saturated layers
- ✅ **shadows on cards** — shadow present
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ✅ **no failed tool calls** — all 4 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 4 tool calls
- ❌ **no agent errors** — errors: Critique-fix turn produced no output (rate-limit / transient outage). Skipping remaining critique iterations.

## ❌ dashboard-hifi (run 2/2) — FAIL

> **Prompt:** Design a high-fidelity analytics dashboard header bar plus a row of 4 KPI stat cards showing Revenue $128.4K, Active Users 8,421, Churn 2.1%, and NPS 62.

0 tool calls · 20s · 0 layers · top tools: —

- ❌ **all 4 KPI values present** — missing values: 128.4, 8,421, 2.1, 62
- ❌ **4 card-like containers in a row** — no 4 similar-height containers — cards not built
- ❌ **colorful (hi-fi)** — too grayscale for a hi-fi dashboard
- ❌ **shadows on cards** — no shadows — flat look
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ✅ **no failed tool calls** — all 0 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ❌ **reasonable tool-call count** — 0 tool calls (expected 4..90)
- ❌ **no agent errors** — errors: The model returned an empty response (no text and no tool calls). This usually means the LLM provider is rate-limited (HTTP 429) or temporarily unavailable. Wait about a minute and resend your prompt;

## ❌ palette-sunset (run 1/2) — FAIL

> **Prompt:** Generate a row of 5 color palette swatches for a 'Sunset' theme, each swatch labeled with its hex code.

0 tool calls · 20s · 0 layers · top tools: —

- ❌ **5 saturated swatches** — only 0 saturated swatch layers
- ❌ **hex code labels present** — only 0 text layers contain hex codes
- ✅ **warm sunset hues** — 0/0 warm
- ✅ **no failed tool calls** — all 0 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ❌ **reasonable tool-call count** — 0 tool calls (expected 3..90)
- ❌ **no agent errors** — errors: The model returned an empty response (no text and no tool calls). This usually means the LLM provider is rate-limited (HTTP 429) or temporarily unavailable. Wait about a minute and resend your prompt;

## ❌ palette-sunset (run 2/2) — FAIL

> **Prompt:** Generate a row of 5 color palette swatches for a 'Sunset' theme, each swatch labeled with its hex code.

0 tool calls · 20s · 0 layers · top tools: —

- ❌ **5 saturated swatches** — only 0 saturated swatch layers
- ❌ **hex code labels present** — only 0 text layers contain hex codes
- ✅ **warm sunset hues** — 0/0 warm
- ✅ **no failed tool calls** — all 0 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ❌ **reasonable tool-call count** — 0 tool calls (expected 3..90)
- ❌ **no agent errors** — errors: The model returned an empty response (no text and no tool calls). This usually means the LLM provider is rate-limited (HTTP 429) or temporarily unavailable. Wait about a minute and resend your prompt;

## Variance (2 runs per scenario)

| scenario | pass rate | tools (mean/min/max) | duration s (mean/min/max) | assertions | flaky assertions |
| --- | --- | --- | --- | --- | --- |
| simple-shape | 50% (1/2) | 4.0/4/4 | 17/14/20 | 15/16 | fill is red 50% |
| text-heading | 100% (2/2) | 2.0/2/2 | 19/15/22 | 14/14 | — |
| login-hifi | 50% (1/2) | 12.5/7/18 | 136/77/195 | 17/24 | canvas has layers 50%; email + password copy present 50%; brand "Vaultly" present 50%; colorful design (hi-fi) 50% |
| wireframe-lofi | 100% (2/2) | 1.5/1/2 | 8/7/8 | 18/18 | — |
| modify-precision | 0% (0/2) | 0.0/0/0 | 20/20/20 | 10/18 | banner recolored green 0%; used update-style tools 0%; reasonable tool-call count 0%; no agent errors 0% |
| flowchart | 50% (1/2) | 11.5/0/23 | 40/22/59 | 9/14 | 4+ node shapes 50%; all 4 node labels present 50%; connector lines present 50%; reasonable tool-call count 50% |
| dashboard-hifi | 0% (0/2) | 2.0/0/4 | 59/20/97 | 10/18 | all 4 KPI values present 0%; no agent errors 0%; 4 card-like containers in a row 50%; colorful (hi-fi) 50% |
| palette-sunset | 0% (0/2) | 0.0/0/0 | 20/20/20 | 6/14 | 5 saturated swatches 0%; hex code labels present 0%; reasonable tool-call count 0%; no agent errors 0% |
