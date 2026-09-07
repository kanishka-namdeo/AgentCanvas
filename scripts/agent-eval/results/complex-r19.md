# Agent Eval Report

- Date: 2026-09-07T06:04:51.428Z
- Scenarios: 2 (1 pass / 1 fail / 0 error)
- Assertions: 19/21 passed

## ✅ analytics-chart — PASS

> **Prompt:** Design a high-fidelity analytics dashboard card titled 'Monthly Revenue' containing a bar chart of Jan through Jun revenue — $42K, $48K, $45K, $56K, $61K, $68K — with a month label under each bar.

13 tool calls · 128s · 29 layers · top tools: pen_bulk_update_by_filterx4, pen_get_metadatax3, pen_set_variablesx2, pen_update_nodex2, pen_create_chartx1, pen_set_shadowx1

- ✅ **title + all 6 values present** — title and all values found
- ✅ **6 month labels present** — jan-jun found
- ✅ **6-bar chart structure (same width, common baseline, varying heights)** — 6 rects at one baseline, 1 width band(s), 5 distinct heights
- ✅ **colorful (hi-fi)** — 3+ saturated layers
- ✅ **card has shadow** — shadow present
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ✅ **no failed tool calls** — all 13 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 13 tool calls
- ✅ **no agent errors** — clean turn

## ❌ data-table — FAIL

> **Prompt:** Design a high-fidelity 'Recent Orders' table card with columns Order, Customer, Date, Status, Amount and 4 data rows with realistic values, status shown as color-coded text or badges.

20 tool calls · 325s · 37 layers · top tools: pen_get_metadatax5, pen_update_nodex5, pen_set_variablesx2, pen_create_tablex2, pen_apply_typographyx2, pen_apply_variablex1

- ✅ **all 5 column headers present** — all headers found
- ❌ **4+ amount values** — only 3 $-amounts — 4 data rows not filled
- ✅ **status color-coded (2+ text colors or badges)** — 4 distinct status text colors, 2 badge pill(s)
- ✅ **table rows as text layers** — 26 text layers
- ✅ **colorful (hi-fi)** — 3+ saturated layers
- ✅ **card has shadow** — shadow present
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ✅ **no failed tool calls** — all 20 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 20 tool calls
- ❌ **no agent errors** — errors: The model stopped mid-turn with a provider error (finish reason: error). Everything built so far is on the canvas — resend your prompt and the agent will continue from the current state. If it keeps h

## Variance (1 run per scenario)

| scenario | pass rate | tools (mean/min/max) | duration s (mean/min/max) | assertions | flaky assertions |
| --- | --- | --- | --- | --- | --- |
| analytics-chart | 100% (1/1) | 13.0/13/13 | 128/128/128 | 10/10 | — |
| data-table | 0% (0/1) | 20.0/20/20 | 325/325/325 | 9/11 | 4+ amount values 0%; no agent errors 0% |
