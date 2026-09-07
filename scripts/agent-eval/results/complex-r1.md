# Agent Eval Report

- Date: 2026-09-06T22:16:07.361Z
- Scenarios: 1 (0 pass / 1 fail / 0 error)
- Assertions: 9/10 passed

## ❌ analytics-chart — FAIL

> **Prompt:** Design a high-fidelity analytics dashboard card titled 'Monthly Revenue' containing a bar chart of Jan through Jun revenue — $42K, $48K, $45K, $56K, $61K, $68K — with a month label under each bar.

15 tool calls · 174s · 15 layers · top tools: pen_apply_variablex6, pen_get_metadatax4, pen_update_nodex2, pen_set_variablesx1, pen_create_chartx1, pen_bulk_update_by_filterx1

- ❌ **title + all 6 values present** — missing: 42, 48, 45, 56, 61, 68
- ✅ **6 month labels present** — jan-jun found
- ✅ **6-bar chart structure (same width, common baseline, varying heights)** — 6 rects at one baseline, 1 width band(s), 6 distinct heights
- ✅ **colorful (hi-fi)** — 3+ saturated layers
- ✅ **card has shadow** — shadow present
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ✅ **no failed tool calls** — all 15 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 15 tool calls
- ✅ **no agent errors** — clean turn

## Variance (1 run per scenario)

| scenario | pass rate | tools (mean/min/max) | duration s (mean/min/max) | assertions | flaky assertions |
| --- | --- | --- | --- | --- | --- |
| analytics-chart | 0% (0/1) | 15.0/15/15 | 174/174/174 | 9/10 | title + all 6 values present 0% |
