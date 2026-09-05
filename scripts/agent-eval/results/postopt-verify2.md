# Agent Eval Report

- Date: 2026-09-05T20:06:11.901Z
- Scenarios: 1 (0 pass / 1 fail / 0 error)
- Assertions: 7/9 passed

## ❌ dashboard-hifi — FAIL

> **Prompt:** Design a high-fidelity analytics dashboard header bar plus a row of 4 KPI stat cards showing Revenue $128.4K, Active Users 8,421, Churn 2.1%, and NPS 62.

20 tool calls · 243s · 37 layers · top tools: pen_update_nodex12, pen_set_variablesx2, pen_get_metadatax2, pen_create_subtreex1, pen_list_variablesx1, pen_delete_nodesx1

- ✅ **all 4 KPI values present** — all values found
- ✅ **4 card-like containers in a row** — 4 candidates, bands=[[120,4]]
- ❌ **colorful (hi-fi)** — too grayscale for a hi-fi dashboard
- ✅ **shadows on cards** — shadow present
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ❌ **no failed tool calls** — 1 failed: pen_update_node (Validation failed for tool "pen_update_node":
  - changes.autoLayout.alignX: must be equal to constant
  - changes.autoLayout.alignX: must be equal to constant
)
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 20 tool calls
- ✅ **no agent errors** — clean turn

## Variance (1 run per scenario)

| scenario | pass rate | tools (mean/min/max) | duration s (mean/min/max) | assertions | flaky assertions |
| --- | --- | --- | --- | --- | --- |
| dashboard-hifi | 0% (0/1) | 20.0/20/20 | 243/243/243 | 7/9 | colorful (hi-fi) 0%; no failed tool calls 0% |
