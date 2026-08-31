# Agent Eval Report

- Date: 2026-08-31T02:53:47.899Z
- Scenarios: 10 (8 pass / 2 fail / 0 error)
- Repeats per scenario: 2 (results below are per-run; see the Variance table)
- Assertions: 88/90 passed

## ✅ simple-shape (run 1/2) — PASS

> **Prompt:** Draw a red rounded rectangle, 240x120, in the top-left area of the canvas.

1 tool calls · 23s · 1 layers · top tools: pen_create_nodex1

- ✅ **rectangle near 240x120 exists** — 1 match(es)
- ✅ **fill is red** — found #f43f5e
- ✅ **corners rounded** — radius=12
- ✅ **placed top-left (x<600, y<400)** — position ok
- ✅ **no failed tool calls** — all 1 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 1 tool calls
- ✅ **no agent errors** — clean turn

## ✅ simple-shape (run 2/2) — PASS

> **Prompt:** Draw a red rounded rectangle, 240x120, in the top-left area of the canvas.

1 tool calls · 14s · 1 layers · top tools: pen_create_nodex1

- ✅ **rectangle near 240x120 exists** — 1 match(es)
- ✅ **fill is red** — found #ef4444
- ✅ **corners rounded** — radius=12
- ✅ **placed top-left (x<600, y<400)** — position ok
- ✅ **no failed tool calls** — all 1 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 1 tool calls
- ✅ **no agent errors** — clean turn

## ❌ login-hifi (run 1/2) — FAIL

> **Prompt:** Design a polished, high-fidelity mobile login screen for a fintech app called 'Vaultly' with an email field, a password field, and a Sign In button.

14 tool calls · 105s · 23 layers · top tools: pen_update_nodex4, pen_get_metadatax3, pen_set_gradient_fillx2, pen_create_subtreex1, pen_set_variablesx1, pen_create_nodex1

- ✅ **canvas has layers** — 23 layers
- ✅ **uses a container/frame** — 9 container(s)
- ✅ **email + password copy present** — email=true password=true
- ✅ **brand "Vaultly" present** — brand copy ok
- ✅ **colorful design (hi-fi)** — 3+ saturated layers
- ✅ **shadows on elevated surfaces** — shadow present
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ❌ **Sign In action present** — no "Sign In" text
- ✅ **no failed tool calls** — all 14 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 14 tool calls
- ✅ **no agent errors** — clean turn

## ✅ login-hifi (run 2/2) — PASS

> **Prompt:** Design a polished, high-fidelity mobile login screen for a fintech app called 'Vaultly' with an email field, a password field, and a Sign In button.

25 tool calls · 166s · 14 layers · top tools: pen_update_nodex12, pen_get_metadatax4, pen_find_nodesx2, pen_create_nodex2, pen_generate_wireframex1, pen_set_variablesx1

- ✅ **canvas has layers** — 14 layers
- ✅ **uses a container/frame** — 1 container(s)
- ✅ **email + password copy present** — email=true password=true
- ✅ **brand "Vaultly" present** — brand copy ok
- ✅ **colorful design (hi-fi)** — 3+ saturated layers
- ✅ **shadows on elevated surfaces** — shadow present
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ✅ **Sign In action present** — CTA copy ok
- ✅ **no failed tool calls** — all 25 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 25 tool calls
- ✅ **no agent errors** — clean turn

## ✅ modify-precision (run 1/2) — PASS

> **Prompt:** Change the Banner rectangle fill to green. Leave everything else exactly as it is.

1 tool calls · 10s · 3 layers · top tools: pen_update_nodex1

- ✅ **banner recolored green** — #10b981
- ✅ **status dot untouched** — fill=#ef4444
- ✅ **note text untouched** — unchanged
- ✅ **no extra layers added** — still 3 layers
- ✅ **used update-style tools** — 1 update call(s)
- ✅ **no failed tool calls** — all 1 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 1 tool calls
- ✅ **no agent errors** — clean turn

## ✅ modify-precision (run 2/2) — PASS

> **Prompt:** Change the Banner rectangle fill to green. Leave everything else exactly as it is.

1 tool calls · 10s · 3 layers · top tools: pen_update_nodex1

- ✅ **banner recolored green** — #10b981
- ✅ **status dot untouched** — fill=#ef4444
- ✅ **note text untouched** — unchanged
- ✅ **no extra layers added** — still 3 layers
- ✅ **used update-style tools** — 1 update call(s)
- ✅ **no failed tool calls** — all 1 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 1 tool calls
- ✅ **no agent errors** — clean turn

## ✅ flowchart (run 1/2) — PASS

> **Prompt:** Create a flowchart for a document approval process with 4 nodes: Start, Review, Approve, End — connected with arrows.

19 tool calls · 144s · 11 layers · top tools: pen_update_nodex7, pen_set_shadowx4, pen_get_metadatax3, pen_find_nodesx2, pen_generate_diagramx1, pen_set_variablesx1

- ✅ **4+ node shapes** — 4 node shapes
- ✅ **all 4 node labels present** — start/review/approve/end all present
- ✅ **connector lines present** — 3 line/path connectors
- ✅ **no failed tool calls** — all 19 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 19 tool calls
- ✅ **no agent errors** — clean turn

## ✅ flowchart (run 2/2) — PASS

> **Prompt:** Create a flowchart for a document approval process with 4 nodes: Start, Review, Approve, End — connected with arrows.

22 tool calls · 170s · 11 layers · top tools: pen_update_nodex8, pen_find_nodesx5, pen_get_metadatax3, pen_bulk_update_by_filterx3, pen_generate_diagramx1, pen_set_variablesx1

- ✅ **4+ node shapes** — 4 node shapes
- ✅ **all 4 node labels present** — start/review/approve/end all present
- ✅ **connector lines present** — 3 line/path connectors
- ✅ **no failed tool calls** — all 22 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 22 tool calls
- ✅ **no agent errors** — clean turn

## ✅ dashboard-hifi (run 1/2) — PASS

> **Prompt:** Design a high-fidelity analytics dashboard header bar plus a row of 4 KPI stat cards showing Revenue $128.4K, Active Users 8,421, Churn 2.1%, and NPS 62.

4 tool calls · 133s · 46 layers · top tools: pen_get_metadatax3, pen_generate_variantsx1

- ✅ **all 4 KPI values present** — all values found
- ✅ **4 card-like containers in a row** — 4 candidates, bands=[[168,4]]
- ✅ **colorful (hi-fi)** — 3+ saturated layers
- ✅ **shadows on cards** — shadow present
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ✅ **no failed tool calls** — all 4 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 4 tool calls
- ✅ **no agent errors** — clean turn

## ❌ dashboard-hifi (run 2/2) — FAIL

> **Prompt:** Design a high-fidelity analytics dashboard header bar plus a row of 4 KPI stat cards showing Revenue $128.4K, Active Users 8,421, Churn 2.1%, and NPS 62.

1 tool calls · 113s · 60 layers · top tools: pen_generate_variantsx1

- ✅ **all 4 KPI values present** — all values found
- ✅ **4 card-like containers in a row** — 4 candidates, bands=[[192,4]]
- ✅ **colorful (hi-fi)** — 3+ saturated layers
- ✅ **shadows on cards** — shadow present
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ✅ **no failed tool calls** — all 1 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ❌ **reasonable tool-call count** — 1 tool calls (expected 4..90)
- ✅ **no agent errors** — clean turn

## Variance (2 runs per scenario)

| scenario | pass rate | tools (mean/min/max) | duration s (mean/min/max) | assertions | flaky assertions |
| --- | --- | --- | --- | --- | --- |
| simple-shape | 100% (2/2) | 1.0/1/1 | 19/14/23 | 16/16 | — |
| login-hifi | 50% (1/2) | 19.5/14/25 | 135/105/166 | 23/24 | Sign In action present 50% |
| modify-precision | 100% (2/2) | 1.0/1/1 | 10/10/10 | 18/18 | — |
| flowchart | 100% (2/2) | 20.5/19/22 | 157/144/170 | 14/14 | — |
| dashboard-hifi | 50% (1/2) | 2.5/1/4 | 123/113/133 | 17/18 | reasonable tool-call count 50% |
