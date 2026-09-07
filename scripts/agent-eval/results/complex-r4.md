# Agent Eval Report

- Date: 2026-09-06T22:32:16.693Z
- Scenarios: 1 (1 pass / 0 fail / 0 error)
- Assertions: 11/11 passed

## ✅ data-table — PASS

> **Prompt:** Design a high-fidelity 'Recent Orders' table card with columns Order, Customer, Date, Status, Amount and 4 data rows with realistic values, status shown as color-coded text or badges.

9 tool calls · 132s · 48 layers · top tools: pen_update_nodex4, pen_set_variablesx1, pen_create_subtreex1, pen_set_variablex1, pen_bulk_update_by_filterx1, pen_get_metadatax1

- ✅ **all 5 column headers present** — all headers found
- ✅ **4+ amount values** — 4 $-amounts found
- ✅ **status color-coded (2+ text colors or badges)** — 4 distinct status text colors, 0 badge pill(s)
- ✅ **table rows as text layers** — 31 text layers
- ✅ **colorful (hi-fi)** — 3+ saturated layers
- ✅ **card has shadow** — shadow present
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ✅ **no failed tool calls** — all 9 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 9 tool calls
- ✅ **no agent errors** — clean turn

## Variance (1 run per scenario)

| scenario | pass rate | tools (mean/min/max) | duration s (mean/min/max) | assertions | flaky assertions |
| --- | --- | --- | --- | --- | --- |
| data-table | 100% (1/1) | 9.0/9/9 | 132/132/132 | 11/11 | — |
