# Agent Eval Report

- Date: 2026-09-06T21:18:03.700Z
- Scenarios: 3 (2 pass / 1 fail / 0 error)
- Assertions: 29/30 passed

## ✅ login-hifi — PASS

> **Prompt:** Design a polished, high-fidelity mobile login screen for a fintech app called 'Vaultly' with an email field, a password field, and a Sign In button.

30 tool calls · 348s · 38 layers · top tools: pen_update_nodex14, pen_get_metadatax8, pen_search_iconsx4, pen_create_subtreex2, pen_set_variablesx1, pen_delete_nodesx1

- ✅ **canvas has layers** — 38 layers
- ✅ **uses a container/frame** — 17 container(s)
- ✅ **email + password copy present** — email=true password=true
- ✅ **brand "Vaultly" present** — brand copy ok
- ✅ **colorful design (hi-fi)** — 3+ saturated layers
- ✅ **shadows on elevated surfaces** — shadow present
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ✅ **Sign In action present** — CTA copy ok
- ✅ **no failed tool calls** — all 30 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 30 tool calls
- ✅ **no agent errors** — clean turn

## ✅ wireframe-lofi — PASS

> **Prompt:** Draw a low-fidelity wireframe of a blog homepage: header with nav, one hero article block, and a 3-card article grid.

5 tool calls · 59s · 14 layers · top tools: pen_get_metadatax2, pen_update_nodex2, pen_generate_wireframex1

- ✅ **canvas has layers** — 14 layers
- ✅ **3-card grid present** — 6 boxes, size-bands=[[800,1],[80,1],[360,1],[180,3]]
- ✅ **stays grayscale (lo-fi)** — 0 saturated layer(s) (tolerance 1)
- ✅ **no shadows (lo-fi)** — flat as expected
- ✅ **no gradients (lo-fi)** — no gradients as expected
- ✅ **no failed tool calls** — all 5 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 5 tool calls
- ✅ **no agent errors** — clean turn

## ❌ dashboard-hifi — FAIL

> **Prompt:** Design a high-fidelity analytics dashboard header bar plus a row of 4 KPI stat cards showing Revenue $128.4K, Active Users 8,421, Churn 2.1%, and NPS 62.

9 tool calls · 158s · 31 layers · top tools: pen_update_nodex3, pen_set_variablesx2, pen_get_metadatax2, pen_create_subtreex1, pen_bulk_update_by_filterx1

- ✅ **all 4 KPI values present** — all values found
- ❌ **4 card-like containers in a row** — no 4 similar-height containers — cards not built
- ✅ **colorful (hi-fi)** — 3+ saturated layers
- ✅ **shadows on cards** — shadow present
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ✅ **no failed tool calls** — all 9 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 9 tool calls
- ✅ **no agent errors** — clean turn

## Variance (1 run per scenario)

| scenario | pass rate | tools (mean/min/max) | duration s (mean/min/max) | assertions | flaky assertions |
| --- | --- | --- | --- | --- | --- |
| login-hifi | 100% (1/1) | 30.0/30/30 | 348/348/348 | 12/12 | — |
| wireframe-lofi | 100% (1/1) | 5.0/5/5 | 59/59/59 | 9/9 | — |
| dashboard-hifi | 0% (0/1) | 9.0/9/9 | 158/158/158 | 8/9 | 4 card-like containers in a row 0% |
