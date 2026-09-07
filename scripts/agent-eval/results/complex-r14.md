# Agent Eval Report

- Date: 2026-09-06T23:35:15.172Z
- Scenarios: 1 (1 pass / 0 fail / 0 error)
- Assertions: 11/11 passed

## ✅ data-table — PASS

> **Prompt:** Design a high-fidelity 'Recent Orders' table card with columns Order, Customer, Date, Status, Amount and 4 data rows with realistic values, status shown as color-coded text or badges.

22 tool calls · 195s · 36 layers · top tools: pen_bulk_update_by_filterx14, pen_get_metadatax3, pen_set_variablesx2, pen_create_tablex1, pen_list_variablesx1, pen_update_nodex1

- ✅ **all 5 column headers present** — all headers found
- ✅ **4+ amount values** — 4 $-amounts found
- ✅ **status color-coded (2+ text colors or badges)** — 1 distinct status text colors, 3 badge pill(s)
- ✅ **table rows as text layers** — 26 text layers
- ✅ **colorful (hi-fi)** — 3+ saturated layers
- ✅ **card has shadow** — shadow present
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ✅ **no failed tool calls** — all 22 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 22 tool calls
- ✅ **no agent errors** — clean turn

## Variance (1 run per scenario)

| scenario | pass rate | tools (mean/min/max) | duration s (mean/min/max) | assertions | flaky assertions |
| --- | --- | --- | --- | --- | --- |
| data-table | 100% (1/1) | 22.0/22/22 | 195/195/195 | 11/11 | — |
