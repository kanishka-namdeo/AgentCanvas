# Computed Visual Audit — Multishot Final Canvases (Round 3, Task 10-d)

No LLM involved: pure geometry/color arithmetic over `scripts/agent-eval/results/ms-*-final-canvas.json`.

## Per-canvas metrics

| Canvas | Layers | % shadowed | % saturated (of colored / of all) | Hue clusters (≥2 colors) | Font sizes (on-scale %) | 4px grid adherence |
|---|---|---|---|---|---|---|
| ms-dashboard-edit | 30 | 13% | 39% / 37% | 3 (0-30° orange, 120-150° green, 210-240° blue) | 50% on scale · 11px×4, 12px×4, 14px×3, 32px×4, 38px×1 | 51% of 120 vals |
| ms-login-refine | 47 | 2% | 22% / 17% | 3 (0-30° orange, 150-180° teal, 210-240° blue) | 81% on scale · 11px×2, 12px×2, 14px×8, 16px×3, 28px×1 | 55% of 188 vals |
| ms-pricing-iterate | 124 | 5% | 10% / 7% | 3 (150-180° teal, 210-240° blue, 240-270° indigo) | 92% on scale · 12px×1, 14px×40, 16px×7, 18px×1, 20px×6, 24px×1, 48px×4 | 55% of 496 vals |

## Detail

### ms-dashboard-edit-final-canvas.json

- **(a) Layer count:** 30
- **(b) Shadows:** 13% of layers carry a shadow
- **(c) Saturated fills:** 39% of the 28 color-carrying layers have (max−min)/max > 0.3 (37% of all layers)
- **(d) Hue clusters:** 3 distinct 30° clusters (≥2 color uses): 0-30° orange, 120-150° green, 210-240° blue
- **(e) Typography:** 50% of text layers on the 12/14/16/20/24/30/38 scale; off-scale sizes: 11px×4, 32px×4
- **(f) Spacing grid:** 51% of 120 x/y/width/height values divisible by 4

### ms-login-refine-final-canvas.json

- **(a) Layer count:** 47
- **(b) Shadows:** 2% of layers carry a shadow
- **(c) Saturated fills:** 22% of the 37 color-carrying layers have (max−min)/max > 0.3 (17% of all layers)
- **(d) Hue clusters:** 3 distinct 30° clusters (≥2 color uses): 0-30° orange, 150-180° teal, 210-240° blue
- **(e) Typography:** 81% of text layers on the 12/14/16/20/24/30/38 scale; off-scale sizes: 11px×2, 28px×1
- **(f) Spacing grid:** 55% of 188 x/y/width/height values divisible by 4

### ms-pricing-iterate-final-canvas.json

- **(a) Layer count:** 124
- **(b) Shadows:** 5% of layers carry a shadow
- **(c) Saturated fills:** 10% of the 90 color-carrying layers have (max−min)/max > 0.3 (7% of all layers)
- **(d) Hue clusters:** 3 distinct 30° clusters (≥2 color uses): 150-180° teal, 210-240° blue, 240-270° indigo
- **(e) Typography:** 92% of text layers on the 12/14/16/20/24/30/38 scale; off-scale sizes: 18px×1, 48px×4
- **(f) Spacing grid:** 55% of 496 x/y/width/height values divisible by 4

## Reading

- Saturated % uses the requested (max−min)/max > 0.3 chroma test on fill/fills/textColor; grays and near-grays (slate borders, #e2e8f0 dividers, #0f172a ink) correctly fail it.
- Hue clusters counted in 30° HSV bins over deduplicated fill+text colors, threshold ≥2 uses (bin shown as range + representative name of its midpoint).
- Grid adherence counts raw geometry values (x/y/w/h), so a single centered 375-wide mobile frame (375 % 4 = 3) drags the number down even when internal spacing is disciplined.
