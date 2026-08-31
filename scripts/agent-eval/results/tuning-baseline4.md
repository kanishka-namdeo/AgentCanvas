# Agent Eval Report

- Date: 2026-08-31T00:50:20.132Z
- Scenarios: 10 (0 pass / 10 fail / 0 error)
- Repeats per scenario: 2 (results below are per-run; see the Variance table)
- Assertions: 30/90 passed

## ❌ simple-shape (run 1/2) — FAIL

> **Prompt:** Draw a red rounded rectangle, 240x120, in the top-left area of the canvas.

0 tool calls · 85s · 0 layers · top tools: —

- ❌ **rectangle near 240x120 exists** — no rectangle in the 180..320 x 80..180 size range
- ❌ **fill is red** — no rectangle with a red-hue fill
- ❌ **corners rounded** — no rectangle with radius >= 4
- ❌ **placed top-left (x<600, y<400)** — no layer in the top-left quadrant
- ✅ **no failed tool calls** — all 0 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ❌ **reasonable tool-call count** — 0 tool calls (expected 1..90)
- ❌ **no agent errors** — errors: The model returned an empty response (no text and no tool calls). This usually means the LLM provider is rate-limited (HTTP 429) or temporarily unavailable. Wait about a minute and resend your prompt;

## ❌ simple-shape (run 2/2) — FAIL

> **Prompt:** Draw a red rounded rectangle, 240x120, in the top-left area of the canvas.

0 tool calls · 85s · 0 layers · top tools: —

- ❌ **rectangle near 240x120 exists** — no rectangle in the 180..320 x 80..180 size range
- ❌ **fill is red** — no rectangle with a red-hue fill
- ❌ **corners rounded** — no rectangle with radius >= 4
- ❌ **placed top-left (x<600, y<400)** — no layer in the top-left quadrant
- ✅ **no failed tool calls** — all 0 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ❌ **reasonable tool-call count** — 0 tool calls (expected 1..90)
- ❌ **no agent errors** — errors: The model returned an empty response (no text and no tool calls). This usually means the LLM provider is rate-limited (HTTP 429) or temporarily unavailable. Wait about a minute and resend your prompt;

## ❌ login-hifi (run 1/2) — FAIL

> **Prompt:** Design a polished, high-fidelity mobile login screen for a fintech app called 'Vaultly' with an email field, a password field, and a Sign In button.

0 tool calls · 84s · 0 layers · top tools: —

- ❌ **canvas has layers** — only 0 layers — too few for a login screen
- ❌ **uses a container/frame** — no frame/group — flat layer soup
- ❌ **email + password copy present** — email=false password=false
- ❌ **brand "Vaultly" present** — no "Vaultly" text anywhere
- ❌ **colorful design (hi-fi)** — fewer than 3 saturated-color layers — looks grayscale
- ❌ **shadows on elevated surfaces** — no shadow anywhere — flat/wireframe look
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ❌ **Sign In action present** — no "Sign In" text
- ✅ **no failed tool calls** — all 0 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ❌ **reasonable tool-call count** — 0 tool calls (expected 4..90)
- ❌ **no agent errors** — errors: The model returned an empty response (no text and no tool calls). This usually means the LLM provider is rate-limited (HTTP 429) or temporarily unavailable. Wait about a minute and resend your prompt;

## ❌ login-hifi (run 2/2) — FAIL

> **Prompt:** Design a polished, high-fidelity mobile login screen for a fintech app called 'Vaultly' with an email field, a password field, and a Sign In button.

0 tool calls · 83s · 0 layers · top tools: —

- ❌ **canvas has layers** — only 0 layers — too few for a login screen
- ❌ **uses a container/frame** — no frame/group — flat layer soup
- ❌ **email + password copy present** — email=false password=false
- ❌ **brand "Vaultly" present** — no "Vaultly" text anywhere
- ❌ **colorful design (hi-fi)** — fewer than 3 saturated-color layers — looks grayscale
- ❌ **shadows on elevated surfaces** — no shadow anywhere — flat/wireframe look
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ❌ **Sign In action present** — no "Sign In" text
- ✅ **no failed tool calls** — all 0 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ❌ **reasonable tool-call count** — 0 tool calls (expected 4..90)
- ❌ **no agent errors** — errors: The model returned an empty response (no text and no tool calls). This usually means the LLM provider is rate-limited (HTTP 429) or temporarily unavailable. Wait about a minute and resend your prompt;

## ❌ modify-precision (run 1/2) — FAIL

> **Prompt:** Change the Banner rectangle fill to green. Leave everything else exactly as it is.

0 tool calls · 83s · 3 layers · top tools: —

- ❌ **banner recolored green** — fill=#3b82f6 is not green-hued
- ✅ **status dot untouched** — fill=#ef4444
- ✅ **note text untouched** — unchanged
- ✅ **no extra layers added** — still 3 layers
- ❌ **used update-style tools** — no update/set_fill tool used
- ✅ **no failed tool calls** — all 0 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ❌ **reasonable tool-call count** — 0 tool calls (expected 1..90)
- ❌ **no agent errors** — errors: The model returned an empty response (no text and no tool calls). This usually means the LLM provider is rate-limited (HTTP 429) or temporarily unavailable. Wait about a minute and resend your prompt;

## ❌ modify-precision (run 2/2) — FAIL

> **Prompt:** Change the Banner rectangle fill to green. Leave everything else exactly as it is.

0 tool calls · 83s · 3 layers · top tools: —

- ❌ **banner recolored green** — fill=#3b82f6 is not green-hued
- ✅ **status dot untouched** — fill=#ef4444
- ✅ **note text untouched** — unchanged
- ✅ **no extra layers added** — still 3 layers
- ❌ **used update-style tools** — no update/set_fill tool used
- ✅ **no failed tool calls** — all 0 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ❌ **reasonable tool-call count** — 0 tool calls (expected 1..90)
- ❌ **no agent errors** — errors: The model returned an empty response (no text and no tool calls). This usually means the LLM provider is rate-limited (HTTP 429) or temporarily unavailable. Wait about a minute and resend your prompt;

## ❌ flowchart (run 1/2) — FAIL

> **Prompt:** Create a flowchart for a document approval process with 4 nodes: Start, Review, Approve, End — connected with arrows.

0 tool calls · 85s · 0 layers · top tools: —

- ❌ **4+ node shapes** — only 0 node shapes
- ❌ **all 4 node labels present** — missing labels: start, review, approve, end
- ❌ **connector lines present** — only 0 line/path layers — no arrows
- ✅ **no failed tool calls** — all 0 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ❌ **reasonable tool-call count** — 0 tool calls (expected 2..90)
- ❌ **no agent errors** — errors: The model returned an empty response (no text and no tool calls). This usually means the LLM provider is rate-limited (HTTP 429) or temporarily unavailable. Wait about a minute and resend your prompt;

## ❌ flowchart (run 2/2) — FAIL

> **Prompt:** Create a flowchart for a document approval process with 4 nodes: Start, Review, Approve, End — connected with arrows.

0 tool calls · 85s · 0 layers · top tools: —

- ❌ **4+ node shapes** — only 0 node shapes
- ❌ **all 4 node labels present** — missing labels: start, review, approve, end
- ❌ **connector lines present** — only 0 line/path layers — no arrows
- ✅ **no failed tool calls** — all 0 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ❌ **reasonable tool-call count** — 0 tool calls (expected 2..90)
- ❌ **no agent errors** — errors: The model returned an empty response (no text and no tool calls). This usually means the LLM provider is rate-limited (HTTP 429) or temporarily unavailable. Wait about a minute and resend your prompt;

## ❌ dashboard-hifi (run 1/2) — FAIL

> **Prompt:** Design a high-fidelity analytics dashboard header bar plus a row of 4 KPI stat cards showing Revenue $128.4K, Active Users 8,421, Churn 2.1%, and NPS 62.

0 tool calls · 83s · 0 layers · top tools: —

- ❌ **all 4 KPI values present** — missing values: 128.4, 8,421, 2.1, 62
- ❌ **4 card-like containers in a row** — no 4 similar-height containers — cards not built
- ❌ **colorful (hi-fi)** — too grayscale for a hi-fi dashboard
- ❌ **shadows on cards** — no shadows — flat look
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ✅ **no failed tool calls** — all 0 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ❌ **reasonable tool-call count** — 0 tool calls (expected 4..90)
- ❌ **no agent errors** — errors: The model returned an empty response (no text and no tool calls). This usually means the LLM provider is rate-limited (HTTP 429) or temporarily unavailable. Wait about a minute and resend your prompt;

## ❌ dashboard-hifi (run 2/2) — FAIL

> **Prompt:** Design a high-fidelity analytics dashboard header bar plus a row of 4 KPI stat cards showing Revenue $128.4K, Active Users 8,421, Churn 2.1%, and NPS 62.

0 tool calls · 83s · 0 layers · top tools: —

- ❌ **all 4 KPI values present** — missing values: 128.4, 8,421, 2.1, 62
- ❌ **4 card-like containers in a row** — no 4 similar-height containers — cards not built
- ❌ **colorful (hi-fi)** — too grayscale for a hi-fi dashboard
- ❌ **shadows on cards** — no shadows — flat look
- ✅ **realistic copy (no placeholders)** — no placeholder text
- ✅ **no failed tool calls** — all 0 tool calls succeeded
- ✅ **no duplicate consecutive calls** — no repeated identical calls
- ❌ **reasonable tool-call count** — 0 tool calls (expected 4..90)
- ❌ **no agent errors** — errors: The model returned an empty response (no text and no tool calls). This usually means the LLM provider is rate-limited (HTTP 429) or temporarily unavailable. Wait about a minute and resend your prompt;

## Variance (2 runs per scenario)

| scenario | pass rate | tools (mean/min/max) | duration s (mean/min/max) | assertions | flaky assertions |
| --- | --- | --- | --- | --- | --- |
| simple-shape | 0% (0/2) | 0.0/0/0 | 85/85/85 | 4/16 | rectangle near 240x120 exists 0%; fill is red 0%; corners rounded 0%; placed top-left (x<600, y<400) 0% |
| login-hifi | 0% (0/2) | 0.0/0/0 | 83/83/84 | 6/24 | canvas has layers 0%; uses a container/frame 0%; email + password copy present 0%; brand "Vaultly" present 0% |
| modify-precision | 0% (0/2) | 0.0/0/0 | 83/83/83 | 10/18 | banner recolored green 0%; used update-style tools 0%; reasonable tool-call count 0%; no agent errors 0% |
| flowchart | 0% (0/2) | 0.0/0/0 | 85/85/85 | 4/14 | 4+ node shapes 0%; all 4 node labels present 0%; connector lines present 0%; reasonable tool-call count 0% |
| dashboard-hifi | 0% (0/2) | 0.0/0/0 | 83/83/83 | 6/18 | all 4 KPI values present 0%; 4 card-like containers in a row 0%; colorful (hi-fi) 0%; shadows on cards 0% |
