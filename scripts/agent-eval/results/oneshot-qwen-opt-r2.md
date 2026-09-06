# Agent Eval Report

- Date: 2026-09-06T21:32:28.182Z
- Scenarios: 4 (4 pass / 0 fail / 0 error)
- Repeats per scenario: 2 (results below are per-run; see the Variance table)
- Assertions: 42/42 passed

## ✅ login-hifi (run 1/2) — PASS

> **Prompt:** Design a polished, high-fidelity mobile login screen for a fintech app called 'Vaultly' with an email field, a password field, and a Sign In button.

19 tool calls · 238s · 22 layers · top tools: pen_update_nodex6, pen_search_iconsx4, pen_get_metadatax3, pen_set_variablesx2, pen_create_subtreex2, pen_list_variablesx1

- ✅ **canvas has layers** — 22 layers
- ✅ **uses a container/frame** — 9 container(s)
- ✅ **email + password copy present** — email=true password=true
- ✅ **brand "Vaultly" present** — brand copy ok
- ✅ **colorful design (hi-fi)** — 3+ saturated layers
- ✅ **shadows on elevated surfaces** — shadow present
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ✅ **Sign In action present** — CTA copy ok
- ✅ **no failed tool calls** — all 19 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 19 tool calls
- ✅ **no agent errors** — clean turn

## ✅ login-hifi (run 2/2) — PASS

> **Prompt:** Design a polished, high-fidelity mobile login screen for a fintech app called 'Vaultly' with an email field, a password field, and a Sign In button.

8 tool calls · 107s · 25 layers · top tools: pen_update_nodex4, pen_set_variablesx1, pen_create_subtreex1, pen_set_variablex1, pen_get_metadatax1

- ✅ **canvas has layers** — 25 layers
- ✅ **uses a container/frame** — 12 container(s)
- ✅ **email + password copy present** — email=true password=true
- ✅ **brand "Vaultly" present** — brand copy ok
- ✅ **colorful design (hi-fi)** — 3+ saturated layers
- ✅ **shadows on elevated surfaces** — shadow present
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ✅ **Sign In action present** — CTA copy ok
- ✅ **no failed tool calls** — all 8 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 8 tool calls
- ✅ **no agent errors** — clean turn

## ✅ dashboard-hifi (run 1/2) — PASS

> **Prompt:** Design a high-fidelity analytics dashboard header bar plus a row of 4 KPI stat cards showing Revenue $128.4K, Active Users 8,421, Churn 2.1%, and NPS 62.

17 tool calls · 171s · 37 layers · top tools: pen_update_nodex10, pen_get_metadatax3, pen_set_variablesx2, pen_create_subtreex1, pen_set_variablex1

- ✅ **all 4 KPI values present** — all values found
- ✅ **4 card-like containers in a row** — 4 candidates, bands=[[144,4]]
- ✅ **colorful (hi-fi)** — 3+ saturated layers
- ✅ **shadows on cards** — shadow present
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ✅ **no failed tool calls** — all 17 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 17 tool calls
- ✅ **no agent errors** — clean turn

## ✅ dashboard-hifi (run 2/2) — PASS

> **Prompt:** Design a high-fidelity analytics dashboard header bar plus a row of 4 KPI stat cards showing Revenue $128.4K, Active Users 8,421, Churn 2.1%, and NPS 62.

8 tool calls · 133s · 33 layers · top tools: pen_set_variablesx4, pen_get_metadatax3, pen_create_subtreex1

- ✅ **all 4 KPI values present** — all values found
- ✅ **4 card-like containers in a row** — 4 candidates, bands=[[144,4]]
- ✅ **colorful (hi-fi)** — 3+ saturated layers
- ✅ **shadows on cards** — shadow present
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ✅ **no failed tool calls** — all 8 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 8 tool calls
- ✅ **no agent errors** — clean turn

## Variance (2 runs per scenario)

| scenario | pass rate | tools (mean/min/max) | duration s (mean/min/max) | assertions | flaky assertions |
| --- | --- | --- | --- | --- | --- |
| login-hifi | 100% (2/2) | 13.5/8/19 | 173/107/238 | 24/24 | — |
| dashboard-hifi | 100% (2/2) | 12.5/8/17 | 152/133/171 | 18/18 | — |
