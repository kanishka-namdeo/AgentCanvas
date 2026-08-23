# Agent Eval Report

- Date: 2026-08-23T08:55:33.014Z
- Scenarios: 8 (2 pass / 6 fail / 0 error)
- Assertions: 49/68 passed

## ✅ simple-shape — PASS

> **Prompt:** Draw a red rounded rectangle, 240x120, in the top-left area of the canvas.

2 tool calls · 7s · 1 layers · top tools: pen_list_shapesx1, pen_create_shapex1

- ✅ **rectangle near 240x120 exists** — 1 match(es)
- ✅ **fill is red** — found #ef4444
- ✅ **corners rounded** — radius=8
- ✅ **placed top-left (x<600, y<400)** — position ok
- ✅ **no failed tool calls** — all 2 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 2 tool calls
- ✅ **no agent errors** — clean turn

## ✅ text-heading — PASS

> **Prompt:** Add a bold heading that says 'Quarterly Report' at 32px, centered near the top of the canvas.

3 tool calls · 8s · 1 layers · top tools: pen_list_shapesx1, pen_create_shapex1, pen_select_shapex1

- ✅ **heading text present** — Quarterly Report
- ✅ **fontSize ~32** — 32px
- ✅ **near top (y < 300)** — y ok
- ✅ **no failed tool calls** — all 3 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 3 tool calls
- ✅ **no agent errors** — clean turn

## ❌ login-hifi — FAIL

> **Prompt:** Design a polished, high-fidelity mobile login screen for a fintech app called 'Vaultly' with an email field, a password field, and a Sign In button.

19 tool calls · 25s · 11 layers · top tools: pen_set_variablex11, pen_set_shadowx4, pen_generate_wireframex1, pen_list_shapesx1, pen_apply_palettex1, pen_set_gradient_fillx1

- ✅ **canvas has layers** — 11 layers
- ✅ **uses a container/frame** — 1 container(s)
- ✅ **email + password copy present** — email=true password=true
- ❌ **brand "Vaultly" present** — no "Vaultly" text anywhere
- ✅ **colorful design (hi-fi)** — 3+ saturated layers
- ✅ **shadows on elevated surfaces** — shadow present
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ✅ **Sign In action present** — CTA copy ok
- ✅ **no failed tool calls** — all 19 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 19 tool calls
- ✅ **no agent errors** — clean turn

## ❌ wireframe-lofi — FAIL

> **Prompt:** Draw a low-fidelity wireframe of a blog homepage: header with nav, one hero article block, and a 3-card article grid.

0 tool calls · 0s · 0 layers · top tools: —

- ❌ **canvas has layers** — only 0 layers
- ❌ **3-card grid present** — no 3+ boxes sharing a similar height band
- ✅ **stays grayscale (lo-fi)** — 0 saturated layer(s) (tolerance 1)
- ✅ **no shadows (lo-fi)** — flat as expected
- ✅ **no gradients (lo-fi)** — no gradients as expected
- ✅ **no failed tool calls** — all 0 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ❌ **reasonable tool-call count** — 0 tool calls (expected 4..90)
- ✅ **no agent errors** — clean turn

## ❌ modify-precision — FAIL

> **Prompt:** Change the Banner rectangle fill to green. Leave everything else exactly as it is.

0 tool calls · 0s · 3 layers · top tools: —

- ❌ **banner recolored green** — fill=#3b82f6 is not green-hued
- ✅ **status dot untouched** — fill=#ef4444
- ✅ **note text untouched** — unchanged
- ✅ **no extra layers added** — still 3 layers
- ❌ **assertion crashed** — t is not defined
- ✅ **no failed tool calls** — all 0 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ❌ **reasonable tool-call count** — 0 tool calls (expected 1..90)
- ✅ **no agent errors** — clean turn

## ❌ flowchart — FAIL

> **Prompt:** Create a flowchart for a document approval process with 4 nodes: Start, Review, Approve, End — connected with arrows.

0 tool calls · 0s · 0 layers · top tools: —

- ❌ **4+ node shapes** — only 0 node shapes
- ❌ **all 4 node labels present** — missing labels: start, review, approve, end
- ❌ **connector lines present** — only 0 line/path layers — no arrows
- ✅ **no failed tool calls** — all 0 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ❌ **reasonable tool-call count** — 0 tool calls (expected 4..90)
- ✅ **no agent errors** — clean turn

## ❌ dashboard-hifi — FAIL

> **Prompt:** Design a high-fidelity analytics dashboard header bar plus a row of 4 KPI stat cards showing Revenue $128.4K, Active Users 8,421, Churn 2.1%, and NPS 62.

0 tool calls · 0s · 0 layers · top tools: —

- ❌ **all 4 KPI values present** — missing values: 128.4, 8,421, 2.1, 62
- ❌ **4 card-like containers in a row** — no 4 similar-height containers — cards not built
- ❌ **colorful (hi-fi)** — too grayscale for a hi-fi dashboard
- ❌ **shadows on cards** — no shadows — flat look
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ✅ **no failed tool calls** — all 0 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ❌ **reasonable tool-call count** — 0 tool calls (expected 4..90)
- ✅ **no agent errors** — clean turn

## ❌ palette-sunset — FAIL

> **Prompt:** Generate a row of 5 color palette swatches for a 'Sunset' theme, each swatch labeled with its hex code.

0 tool calls · 0s · 0 layers · top tools: —

- ❌ **5 saturated swatches** — only 0 saturated swatch layers
- ❌ **hex code labels present** — only 0 text layers contain hex codes
- ✅ **warm sunset hues** — 0/0 warm
- ✅ **no failed tool calls** — all 0 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ❌ **reasonable tool-call count** — 0 tool calls (expected 3..90)
- ✅ **no agent errors** — clean turn
