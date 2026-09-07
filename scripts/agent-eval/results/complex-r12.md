# Agent Eval Report

- Date: 2026-09-06T23:25:06.520Z
- Scenarios: 2 (1 pass / 0 fail / 1 error)
- Assertions: 11/11 passed

## 💥 data-table — ERROR

> **Prompt:** Design a high-fidelity 'Recent Orders' table card with columns Order, Customer, Date, Status, Amount and 4 data rows with realistic values, status shown as color-coded text or badges.

29 tool calls · 363s · 38 layers · top tools: pen_get_metadatax10, pen_update_nodex7, pen_bulk_update_by_filterx6, pen_set_variablesx1, pen_create_tablex1, pen_list_variablesx1

**ERROR:** scenario timed out after 6 min


## ✅ marketing-landing — PASS

> **Prompt:** Design a high-fidelity SaaS landing page for 'Nimbus', a cloud monitoring tool: a navbar with the Nimbus logo, a hero section with the headline 'Monitor your cloud in real time', a short subheadline, and a Start Free Trial primary button, a features section with 3 feature cards, and a footer with a copyright line.

34 tool calls · 192s · 35 layers · top tools: pen_update_nodex21, pen_search_iconsx3, pen_create_nodex3, pen_get_metadatax3, pen_create_subtreex2, pen_set_variablesx1

- ✅ **brand + headline + CTA present** — all key strings found
- ✅ **brand repeated (navbar + footer/hero)** — 2 occurrences of Nimbus
- ✅ **3 feature cards in a row** — 3 candidates, bands=[[160,3]]
- ✅ **landing page = stacked sections** — 6 wide sections, 5 vertical bands
- ✅ **colorful (hi-fi)** — 3+ saturated layers
- ✅ **shadows present** — shadow present
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ✅ **no failed tool calls** — all 34 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 34 tool calls
- ✅ **no agent errors** — clean turn

## Variance (1 run per scenario)

| scenario | pass rate | tools (mean/min/max) | duration s (mean/min/max) | assertions | flaky assertions |
| --- | --- | --- | --- | --- | --- |
| data-table | 0% (0/1) | 29.0/29/29 | 363/363/363 | 0/0 | — |
| marketing-landing | 100% (1/1) | 34.0/34/34 | 192/192/192 | 11/11 | — |
