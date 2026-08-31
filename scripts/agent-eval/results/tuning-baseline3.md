# Agent Eval Report

- Date: 2026-08-30T23:06:25.475Z
- Scenarios: 10 (5 pass / 5 fail / 0 error)
- Repeats per scenario: 2 (results below are per-run; see the Variance table)
- Assertions: 61/90 passed

## ✅ simple-shape (run 1/2) — PASS

> **Prompt:** Draw a red rounded rectangle, 240x120, in the top-left area of the canvas.

4 tool calls · 25s · 1 layers · top tools: pen_create_nodex2, pen_get_metadatax1, pen_generate_design_briefx1

- ✅ **rectangle near 240x120 exists** — 1 match(es)
- ✅ **fill is red** — found #f43f5e
- ✅ **corners rounded** — radius=12
- ✅ **placed top-left (x<600, y<400)** — position ok
- ✅ **no failed tool calls** — all 4 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 4 tool calls
- ✅ **no agent errors** — clean turn

## ✅ simple-shape (run 2/2) — PASS

> **Prompt:** Draw a red rounded rectangle, 240x120, in the top-left area of the canvas.

4 tool calls · 14s · 1 layers · top tools: pen_create_nodex2, pen_get_metadatax1, pen_generate_design_briefx1

- ✅ **rectangle near 240x120 exists** — 1 match(es)
- ✅ **fill is red** — found #f43f5e
- ✅ **corners rounded** — radius=12
- ✅ **placed top-left (x<600, y<400)** — position ok
- ✅ **no failed tool calls** — all 4 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 4 tool calls
- ✅ **no agent errors** — clean turn

## ✅ login-hifi (run 1/2) — PASS

> **Prompt:** Design a polished, high-fidelity mobile login screen for a fintech app called 'Vaultly' with an email field, a password field, and a Sign In button.

16 tool calls · 65s · 22 layers · top tools: pen_create_nodex8, pen_create_subtreex2, pen_get_metadatax2, pen_generate_design_briefx1, pen_update_nodex1, pen_set_variablesx1

- ✅ **canvas has layers** — 22 layers
- ✅ **uses a container/frame** — 2 container(s)
- ✅ **email + password copy present** — email=true password=true
- ✅ **brand "Vaultly" present** — brand copy ok
- ✅ **colorful design (hi-fi)** — 3+ saturated layers
- ✅ **shadows on elevated surfaces** — shadow present
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ✅ **Sign In action present** — CTA copy ok
- ✅ **no failed tool calls** — all 16 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 16 tool calls
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

## ✅ modify-precision (run 2/2) — PASS

> **Prompt:** Change the Banner rectangle fill to green. Leave everything else exactly as it is.

2 tool calls · 6s · 3 layers · top tools: pen_get_metadatax1, pen_update_nodex1

- ✅ **banner recolored green** — #10b981
- ✅ **status dot untouched** — fill=#ef4444
- ✅ **note text untouched** — unchanged
- ✅ **no extra layers added** — still 3 layers
- ✅ **used update-style tools** — 1 update call(s)
- ✅ **no failed tool calls** — all 2 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 2 tool calls
- ✅ **no agent errors** — clean turn

## ✅ flowchart (run 1/2) — PASS

> **Prompt:** Create a flowchart for a document approval process with 4 nodes: Start, Review, Approve, End — connected with arrows.

24 tool calls · 72s · 15 layers · top tools: pen_get_metadatax4, pen_set_shadowx4, pen_create_nodex4, pen_update_nodex3, pen_generate_diagramx2, pen_find_nodesx2

- ✅ **4+ node shapes** — 4 node shapes
- ✅ **all 4 node labels present** — start/review/approve/end all present
- ✅ **connector lines present** — 6 line/path connectors
- ✅ **no failed tool calls** — all 24 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 24 tool calls
- ✅ **no agent errors** — clean turn

## ❌ flowchart (run 2/2) — FAIL

> **Prompt:** Create a flowchart for a document approval process with 4 nodes: Start, Review, Approve, End — connected with arrows.

1 tool calls · 27s · 0 layers · top tools: pen_generate_design_briefx1

- ❌ **4+ node shapes** — only 0 node shapes
- ❌ **all 4 node labels present** — missing labels: start, review, approve, end
- ❌ **connector lines present** — only 0 line/path layers — no arrows
- ✅ **no failed tool calls** — all 1 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ❌ **reasonable tool-call count** — 1 tool calls (expected 2..90)
- ✅ **no agent errors** — clean turn

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

## Variance (2 runs per scenario)

| scenario | pass rate | tools (mean/min/max) | duration s (mean/min/max) | assertions | flaky assertions |
| --- | --- | --- | --- | --- | --- |
| simple-shape | 100% (2/2) | 4.0/4/4 | 20/14/25 | 16/16 | — |
| login-hifi | 50% (1/2) | 8.0/0/16 | 43/20/65 | 15/24 | canvas has layers 50%; uses a container/frame 50%; email + password copy present 50%; brand "Vaultly" present 50% |
| modify-precision | 50% (1/2) | 1.0/0/2 | 13/6/20 | 14/18 | banner recolored green 50%; used update-style tools 50%; reasonable tool-call count 50%; no agent errors 50% |
| flowchart | 50% (1/2) | 12.5/1/24 | 50/27/72 | 10/14 | 4+ node shapes 50%; all 4 node labels present 50%; connector lines present 50%; reasonable tool-call count 50% |
| dashboard-hifi | 0% (0/2) | 0.0/0/0 | 20/20/20 | 6/18 | all 4 KPI values present 0%; 4 card-like containers in a row 0%; colorful (hi-fi) 0%; shadows on cards 0% |
