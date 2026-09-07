# Agent Eval Report

- Date: 2026-09-06T22:52:01.697Z
- Scenarios: 2 (1 pass / 1 fail / 0 error)
- Assertions: 20/21 passed

## ❌ analytics-chart — FAIL

> **Prompt:** Design a high-fidelity analytics dashboard card titled 'Monthly Revenue' containing a bar chart of Jan through Jun revenue — $42K, $48K, $45K, $56K, $61K, $68K — with a month label under each bar.

9 tool calls · 101s · 15 layers · top tools: pen_get_metadatax3, pen_set_variablesx2, pen_update_nodex2, pen_create_chartx1, pen_bulk_update_by_filterx1

- ❌ **title + all 6 values present** — missing: 42, 48, 45, 56, 61, 68
- ✅ **6 month labels present** — jan-jun found
- ✅ **6-bar chart structure (same width, common baseline, varying heights)** — 6 rects at one baseline, 1 width band(s), 6 distinct heights
- ✅ **colorful (hi-fi)** — 3+ saturated layers
- ✅ **card has shadow** — shadow present
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ✅ **no failed tool calls** — all 9 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 9 tool calls
- ✅ **no agent errors** — clean turn

## ✅ marketing-landing — PASS

> **Prompt:** Design a high-fidelity SaaS landing page for 'Nimbus', a cloud monitoring tool: a navbar with the Nimbus logo, a hero section with the headline 'Monitor your cloud in real time', a short subheadline, and a Start Free Trial primary button, a features section with 3 feature cards, and a footer with a copyright line.

30 tool calls · 342s · 33 layers · top tools: pen_update_nodex21, pen_get_metadatax4, pen_create_subtreex2, pen_bulk_update_by_filterx2, pen_set_variablesx1

- ✅ **brand + headline + CTA present** — all key strings found
- ✅ **brand repeated (navbar + footer/hero)** — 2 occurrences of Nimbus
- ✅ **3 feature cards in a row** — 3 candidates, bands=[[160,3]]
- ✅ **landing page = stacked sections** — 6 wide sections, 6 vertical bands
- ✅ **colorful (hi-fi)** — 3+ saturated layers
- ✅ **shadows present** — shadow present
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ✅ **no failed tool calls** — all 30 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 30 tool calls
- ✅ **no agent errors** — clean turn

## Variance (1 run per scenario)

| scenario | pass rate | tools (mean/min/max) | duration s (mean/min/max) | assertions | flaky assertions |
| --- | --- | --- | --- | --- | --- |
| analytics-chart | 0% (0/1) | 9.0/9/9 | 101/101/101 | 9/10 | title + all 6 values present 0% |
| marketing-landing | 100% (1/1) | 30.0/30/30 | 342/342/342 | 11/11 | — |
