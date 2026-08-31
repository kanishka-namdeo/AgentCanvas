# Agent Eval Report

- Date: 2026-08-30T22:19:33.375Z
- Scenarios: 16 (7 pass / 9 fail / 0 error)
- Repeats per scenario: 2 (results below are per-run; see the Variance table)
- Assertions: 94/136 passed

## ✅ simple-shape (run 1/2) — PASS

> **Prompt:** Draw a red rounded rectangle, 240x120, in the top-left area of the canvas.

3 tool calls · 15s · 1 layers · top tools: pen_create_nodex2, pen_generate_design_briefx1

- ✅ **rectangle near 240x120 exists** — 1 match(es)
- ✅ **fill is red** — found #ef4444
- ✅ **corners rounded** — radius=12
- ✅ **placed top-left (x<600, y<400)** — position ok
- ✅ **no failed tool calls** — all 3 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 3 tool calls
- ✅ **no agent errors** — clean turn

## ✅ simple-shape (run 2/2) — PASS

> **Prompt:** Draw a red rounded rectangle, 240x120, in the top-left area of the canvas.

3 tool calls · 13s · 1 layers · top tools: pen_create_nodex2, pen_generate_design_briefx1

- ✅ **rectangle near 240x120 exists** — 1 match(es)
- ✅ **fill is red** — found #f43f5e
- ✅ **corners rounded** — radius=12
- ✅ **placed top-left (x<600, y<400)** — position ok
- ✅ **no failed tool calls** — all 3 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 3 tool calls
- ✅ **no agent errors** — clean turn

## ✅ text-heading (run 1/2) — PASS

> **Prompt:** Add a bold heading that says 'Quarterly Report' at 32px, centered near the top of the canvas.

2 tool calls · 16s · 1 layers · top tools: pen_get_metadatax1, pen_create_nodex1

- ✅ **heading text present** — Quarterly Report
- ✅ **fontSize ~32** — 32px
- ✅ **near top (y < 300)** — y ok
- ✅ **no failed tool calls** — all 2 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 2 tool calls
- ✅ **no agent errors** — clean turn

## ✅ text-heading (run 2/2) — PASS

> **Prompt:** Add a bold heading that says 'Quarterly Report' at 32px, centered near the top of the canvas.

2 tool calls · 7s · 1 layers · top tools: pen_get_metadatax1, pen_create_nodex1

- ✅ **heading text present** — Quarterly Report
- ✅ **fontSize ~32** — 32px
- ✅ **near top (y < 300)** — y ok
- ✅ **no failed tool calls** — all 2 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 2 tool calls
- ✅ **no agent errors** — clean turn

## ❌ login-hifi (run 1/2) — FAIL

> **Prompt:** Design a polished, high-fidelity mobile login screen for a fintech app called 'Vaultly' with an email field, a password field, and a Sign In button.

11 tool calls · 73s · 11 layers · top tools: pen_set_shadowx4, pen_generate_design_briefx1, pen_create_subtreex1, pen_set_variablesx1, pen_apply_palettex1, pen_set_gradient_fillx1

- ✅ **canvas has layers** — 11 layers
- ✅ **uses a container/frame** — 1 container(s)
- ❌ **email + password copy present** — email=false password=true
- ✅ **brand "Vaultly" present** — brand copy ok
- ✅ **colorful design (hi-fi)** — 3+ saturated layers
- ✅ **shadows on elevated surfaces** — shadow present
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ❌ **Sign In action present** — no "Sign In" text
- ❌ **no failed tool calls** — 1 failed: pen_bulk_update_by_filter (Validation failed for tool "pen_bulk_update_by_filter":
  - )
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 11 tool calls
- ✅ **no agent errors** — clean turn

## ❌ login-hifi (run 2/2) — FAIL

> **Prompt:** Design a polished, high-fidelity mobile login screen for a fintech app called 'Vaultly' with an email field, a password field, and a Sign In button.

0 tool calls · 20s · 0 layers · top tools: —

- ❌ **canvas has layers** — only 0 layers — too few for a login screen
- ❌ **uses a container/frame** — no frame/group — flat layer soup
- ❌ **email + password copy present** — email=false password=false
- ❌ **brand "Vaultly" present** — no "Vaultly" text anywhere
- ❌ **colorful design (hi-fi)** — fewer than 3 saturated-color layers — looks grayscale
- ❌ **shadows on elevated surfaces** — no shadow anywhere — flat/wireframe look
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ❌ **Sign In action present** — no "Sign In" text
- ✅ **no failed tool calls** — all 0 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ❌ **reasonable tool-call count** — 0 tool calls (expected 4..90)
- ❌ **no agent errors** — errors: The model returned an empty response (no text and no tool calls). This usually means the LLM provider is rate-limited (HTTP 429) or temporarily unavailable. Wait about a minute and resend your prompt;

## ❌ wireframe-lofi (run 1/2) — FAIL

> **Prompt:** Draw a low-fidelity wireframe of a blog homepage: header with nav, one hero article block, and a 3-card article grid.

0 tool calls · 20s · 0 layers · top tools: —

- ❌ **canvas has layers** — only 0 layers
- ❌ **3-card grid present** — no 3+ boxes sharing a similar height band
- ✅ **stays grayscale (lo-fi)** — 0 saturated layer(s) (tolerance 1)
- ✅ **no shadows (lo-fi)** — flat as expected
- ✅ **no gradients (lo-fi)** — no gradients as expected
- ✅ **no failed tool calls** — all 0 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ❌ **reasonable tool-call count** — 0 tool calls (expected 1..90)
- ❌ **no agent errors** — errors: The model returned an empty response (no text and no tool calls). This usually means the LLM provider is rate-limited (HTTP 429) or temporarily unavailable. Wait about a minute and resend your prompt;

## ✅ wireframe-lofi (run 2/2) — PASS

> **Prompt:** Draw a low-fidelity wireframe of a blog homepage: header with nav, one hero article block, and a 3-card article grid.

1 tool calls · 6s · 14 layers · top tools: pen_generate_wireframex1

- ✅ **canvas has layers** — 14 layers
- ✅ **3-card grid present** — 6 boxes, size-bands=[[800,1],[80,1],[360,1],[180,3]]
- ✅ **stays grayscale (lo-fi)** — 0 saturated layer(s) (tolerance 1)
- ✅ **no shadows (lo-fi)** — flat as expected
- ✅ **no gradients (lo-fi)** — no gradients as expected
- ✅ **no failed tool calls** — all 1 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 1 tool calls
- ✅ **no agent errors** — clean turn

## ✅ modify-precision (run 1/2) — PASS

> **Prompt:** Change the Banner rectangle fill to green. Leave everything else exactly as it is.

3 tool calls · 4s · 3 layers · top tools: pen_get_metadatax2, pen_update_nodex1

- ✅ **banner recolored green** — #10b981
- ✅ **status dot untouched** — fill=#ef4444
- ✅ **note text untouched** — unchanged
- ✅ **no extra layers added** — still 3 layers
- ✅ **used update-style tools** — 1 update call(s)
- ✅ **no failed tool calls** — all 3 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 3 tool calls
- ✅ **no agent errors** — clean turn

## ✅ modify-precision (run 2/2) — PASS

> **Prompt:** Change the Banner rectangle fill to green. Leave everything else exactly as it is.

2 tool calls · 4s · 3 layers · top tools: pen_get_metadatax1, pen_update_nodex1

- ✅ **banner recolored green** — #10b981
- ✅ **status dot untouched** — fill=#ef4444
- ✅ **note text untouched** — unchanged
- ✅ **no extra layers added** — still 3 layers
- ✅ **used update-style tools** — 1 update call(s)
- ✅ **no failed tool calls** — all 2 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 2 tool calls
- ✅ **no agent errors** — clean turn

## ❌ flowchart (run 1/2) — FAIL

> **Prompt:** Create a flowchart for a document approval process with 4 nodes: Start, Review, Approve, End — connected with arrows.

24 tool calls · 54s · 15 layers · top tools: pen_get_metadatax6, pen_set_shadowx4, pen_create_nodex4, pen_generate_diagramx2, pen_find_nodesx2, pen_generate_design_briefx1

- ✅ **4+ node shapes** — 4 node shapes
- ✅ **all 4 node labels present** — start/review/approve/end all present
- ✅ **connector lines present** — 6 line/path connectors
- ✅ **no failed tool calls** — all 24 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 24 tool calls
- ❌ **no agent errors** — errors: Critique-fix turn produced no output (rate-limit / transient outage). Skipping remaining critique iterations.

## ❌ flowchart (run 2/2) — FAIL

> **Prompt:** Create a flowchart for a document approval process with 4 nodes: Start, Review, Approve, End — connected with arrows.

0 tool calls · 22s · 0 layers · top tools: —

- ❌ **4+ node shapes** — only 0 node shapes
- ❌ **all 4 node labels present** — missing labels: start, review, approve, end
- ❌ **connector lines present** — only 0 line/path layers — no arrows
- ✅ **no failed tool calls** — all 0 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ❌ **reasonable tool-call count** — 0 tool calls (expected 2..90)
- ❌ **no agent errors** — errors: The model returned an empty response (no text and no tool calls). This usually means the LLM provider is rate-limited (HTTP 429) or temporarily unavailable. Wait about a minute and resend your prompt;

## ❌ dashboard-hifi (run 1/2) — FAIL

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
| simple-shape | 100% (2/2) | 3.0/3/3 | 14/13/15 | 16/16 | — |
| text-heading | 100% (2/2) | 2.0/2/2 | 11/7/16 | 14/14 | — |
| login-hifi | 0% (0/2) | 5.5/0/11 | 47/20/73 | 12/24 | email + password copy present 0%; Sign In action present 0%; canvas has layers 50%; uses a container/frame 50% |
| wireframe-lofi | 50% (1/2) | 0.5/0/1 | 13/6/20 | 14/18 | canvas has layers 50%; 3-card grid present 50%; reasonable tool-call count 50%; no agent errors 50% |
| modify-precision | 100% (2/2) | 2.5/2/3 | 4/4/4 | 18/18 | — |
| flowchart | 0% (0/2) | 12.0/0/24 | 38/22/54 | 8/14 | no agent errors 0%; 4+ node shapes 50%; all 4 node labels present 50%; connector lines present 50% |
| dashboard-hifi | 0% (0/2) | 0.0/0/0 | 20/20/20 | 6/18 | all 4 KPI values present 0%; 4 card-like containers in a row 0%; colorful (hi-fi) 0%; shadows on cards 0% |
| palette-sunset | 0% (0/2) | 0.0/0/0 | 20/20/20 | 6/14 | 5 saturated swatches 0%; hex code labels present 0%; reasonable tool-call count 0%; no agent errors 0% |
