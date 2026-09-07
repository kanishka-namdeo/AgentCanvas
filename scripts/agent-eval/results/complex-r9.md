# Agent Eval Report

- Date: 2026-09-06T23:02:32.671Z
- Scenarios: 2 (1 pass / 1 fail / 0 error)
- Assertions: 20/22 passed

## ✅ analytics-chart — PASS

> **Prompt:** Design a high-fidelity analytics dashboard card titled 'Monthly Revenue' containing a bar chart of Jan through Jun revenue — $42K, $48K, $45K, $56K, $61K, $68K — with a month label under each bar.

7 tool calls · 94s · 23 layers · top tools: pen_set_variablesx2, pen_get_metadatax2, pen_create_chartx1, pen_set_shadowx1, pen_update_nodex1

- ✅ **title + all 6 values present** — title and all values found
- ✅ **6 month labels present** — jan-jun found
- ✅ **6-bar chart structure (same width, common baseline, varying heights)** — 6 rects at one baseline, 1 width band(s), 6 distinct heights
- ✅ **colorful (hi-fi)** — 3+ saturated layers
- ✅ **card has shadow** — shadow present
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ✅ **no failed tool calls** — all 7 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 7 tool calls
- ✅ **no agent errors** — clean turn

## ❌ ecommerce-grid — FAIL

> **Prompt:** Design a high-fidelity e-commerce product grid, 4 product cards in a 2x2 layout, each card with a product image area, product name, price, and an Add to Cart button. Products: Aurora Lamp at $89, Drift Speaker at $129, Lumen Desk at $249, Arc Charger at $45.

4 tool calls · 225s · 32 layers · top tools: pen_set_variablesx1, pen_create_subtreex1, pen_list_variablesx1, pen_find_nodesx1

- ✅ **all 4 product names present** — all names found
- ✅ **all 4 prices present** — all prices found
- ✅ **2x2 card lattice** — 3 row band(s) with 2+ cards
- ✅ **Add to Cart on each card** — 4 occurrences
- ✅ **4 product image areas** — 12 image-area rects
- ❌ **colorful (hi-fi)** — too grayscale for a hi-fi grid
- ✅ **cards have shadows** — shadow present
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ✅ **no failed tool calls** — all 4 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 4 tool calls
- ❌ **no agent errors** — errors: Agent stream stalled — no output for 2 minutes. The run was closed to avoid hanging; resend the prompt to retry.

## Variance (1 run per scenario)

| scenario | pass rate | tools (mean/min/max) | duration s (mean/min/max) | assertions | flaky assertions |
| --- | --- | --- | --- | --- | --- |
| analytics-chart | 100% (1/1) | 7.0/7/7 | 94/94/94 | 10/10 | — |
| ecommerce-grid | 0% (0/1) | 4.0/4/4 | 225/225/225 | 10/12 | colorful (hi-fi) 0%; no agent errors 0% |
