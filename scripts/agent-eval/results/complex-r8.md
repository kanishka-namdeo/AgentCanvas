# Agent Eval Report

- Date: 2026-09-06T22:56:17.029Z
- Scenarios: 1 (0 pass / 1 fail / 0 error)
- Assertions: 9/10 passed

## ❌ analytics-chart — FAIL

> **Prompt:** Design a high-fidelity analytics dashboard card titled 'Monthly Revenue' containing a bar chart of Jan through Jun revenue — $42K, $48K, $45K, $56K, $61K, $68K — with a month label under each bar.

16 tool calls · 178s · 23 layers · top tools: pen_get_metadatax6, pen_bulk_update_by_filterx4, pen_update_nodex3, pen_set_variablesx2, pen_create_chartx1

- ✅ **title + all 6 values present** — title and all values found
- ✅ **6 month labels present** — jan-jun found
- ❌ **6-bar chart structure (same width, common baseline, varying heights)** — best group: 5 rects, 1 width band(s), 4 distinct heights — bars not built as per-point rects
- ✅ **colorful (hi-fi)** — 3+ saturated layers
- ✅ **card has shadow** — shadow present
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ✅ **no failed tool calls** — all 16 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 16 tool calls
- ✅ **no agent errors** — clean turn

## Variance (1 run per scenario)

| scenario | pass rate | tools (mean/min/max) | duration s (mean/min/max) | assertions | flaky assertions |
| --- | --- | --- | --- | --- | --- |
| analytics-chart | 0% (0/1) | 16.0/16/16 | 178/178/178 | 9/10 | 6-bar chart structure (same width, common baseline, varying heights) 0% |
