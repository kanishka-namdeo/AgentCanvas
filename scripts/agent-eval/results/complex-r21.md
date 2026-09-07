# Agent Eval Report

- Date: 2026-09-07T06:16:25.338Z
- Scenarios: 1 (0 pass / 1 fail / 0 error)
- Assertions: 11/12 passed

## ❌ ecommerce-grid — FAIL

> **Prompt:** Design a high-fidelity e-commerce product grid, 4 product cards in a 2x2 layout, each card with a product image area, product name, price, and an Add to Cart button. Products: Aurora Lamp at $89, Drift Speaker at $129, Lumen Desk at $249, Arc Charger at $45.

23 tool calls · 225s · 34 layers · top tools: pen_get_metadatax6, pen_apply_auto_layoutx5, pen_bulk_update_by_filterx4, pen_apply_variablex2, pen_set_variablesx1, pen_create_card_gridx1

- ✅ **all 4 product names present** — all names found
- ✅ **all 4 prices present** — all prices found
- ❌ **2x2 card lattice** — cards not arranged in a 2-row x 2-col grid
- ✅ **Add to Cart on each card** — 4 occurrences
- ✅ **4 product image areas** — 9 image-area rects
- ✅ **colorful (hi-fi)** — 3+ saturated layers
- ✅ **cards have shadows** — shadow present
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ✅ **no failed tool calls** — all 23 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 23 tool calls
- ✅ **no agent errors** — clean turn

## Variance (1 run per scenario)

| scenario | pass rate | tools (mean/min/max) | duration s (mean/min/max) | assertions | flaky assertions |
| --- | --- | --- | --- | --- | --- |
| ecommerce-grid | 0% (0/1) | 23.0/23/23 | 225/225/225 | 11/12 | 2x2 card lattice 0% |
