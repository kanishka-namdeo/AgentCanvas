# Agent Eval Report

- Date: 2026-08-23T08:53:40.154Z
- Scenarios: 1 (0 pass / 1 fail / 0 error)
- Assertions: 4/8 passed

## ❌ simple-shape — FAIL

> **Prompt:** Draw a red rounded rectangle, 240x120, in the top-left area of the canvas.

1 tool calls · 6s · 0 layers · top tools: pen_create_shapex1

- ❌ **rectangle near 240x120 exists** — no rectangle in the 180..320 x 80..180 size range
- ❌ **fill is red** — no rectangle with a red-hue fill
- ❌ **corners rounded** — no rectangle with radius >= 4
- ❌ **placed top-left (x<600, y<400)** — no layer in the top-left quadrant
- ✅ **no failed tool calls** — all 1 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ✅ **reasonable tool-call count** — 1 tool calls
- ✅ **no agent errors** — clean turn
