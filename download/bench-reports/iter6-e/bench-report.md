# World-class test bench report

**Generated:** 2026-09-18T22:53:19.780Z
**Repeats per scenario:** 1
**VLM layer:** agnes-3.0-flash vision

## Headline metrics

| Metric | Value |
|---|---|
| Overall AQS (0-100) | **50.3** |
| Scenarios fully passing | 3 / 6 |

## Per-scenario breakdown

| ID | Pass rate | Wilson 95% CI lower | Mean latency (s) | Mean toolcalls | VLM overall | AQS |
|---|---|---|---|---|---|---|
| login-hifi | 1 | 0.207 | 114±0 | 16±0 | 4 | **63.3** |
| dashboard-hifi | 0 | 0 | 113.4±0 | 24±0 | 3 | **47.5** |
| mwc-mindmap | 1 | 0.207 | 82.6±0 | 7±0 | 2 | **53.3** |
| mwc-404-page | 1 | 0.207 | 93.2±0 | 8±0 | 4 | **63.3** |
| mwc-multistep-wizard | 0 | 0 | 296.9±0 | 36±0 | 1 | **25.5** |
| mwc-stripe-inspired | 0 | 0 | 127.9±0 | 22±0 | 3 | **48.6** |

## Layer composition (per scenario)

AQS = 0.40·L1 + 0.25·L5 + 0.20·L7_speed + 0.15·L7_toolcount (when VLM is enabled)
AQS = 0.50·L1 + 0.25·L7_speed + 0.25·L7_toolcount (when VLM is skipped)

- **L1 (deterministic)**: Wilson 95% CI lower bound on pass rate — the value we're 95% confident the true pass rate is AT LEAST this high.
- **L5 (VLM-as-judge)**: mean of agnes-3.0-flash's 5-dim rubric (aesthetics + learnability + efficiency + usability + overall), normalized to 0-100.
- **L7_speed**: 180s / mean latency (seconds), clamped to [0, 1] × 100. Faster = higher.
- **L7_toolcount**: 20 / mean tool calls, clamped to [0, 1] × 100. Fewer calls (more efficient) = higher.

## VLM top fixes (most common across runs)

- [mwc-multistep-wizard r1] Create a structured container for the wizard steps to replace the floating top elements.
- [mwc-multistep-wizard r1] Add clear text labels to the progress steps and the 'Pick a template' section.
- [mwc-multistep-wizard r1] Label the three template options with names and descriptions to provide context.
- [mwc-mindmap r1] Add clear, continuous lines or paths connecting the central 'Product Strategy' node to the four branch cards to fulfill the 'mindmap' visual expectation.
- [mwc-mindmap r1] Unify the color scheme; use a single color family for the headers or a consistent logic (e.g., color-coding by function, not just random colors) to improve aesthetic cohesion.
- [mwc-mindmap r1] Increase the size of the central node or the connecting elements so the hierarchy is more balanced and the central element feels like a proper anchor rather than a floating tag.
- [login-hifi r1] Remove the light grey background from the 'Email' and 'Password' labels to distinguish them clearly from the input fields below them.
- [login-hifi r1] Refine the visual hierarchy of the form so labels appear as standard floating or top-aligned labels rather than as part of the input's background block.
- [login-hifi r1] Add placeholder text within the email field (e.g., 'Enter your email') to further guide user input.
- [dashboard-hifi r1] Remove or replace the large gray rectangular placeholders in each KPI card with high-quality sparklines or data visualization.
- [dashboard-hifi r1] Improve the header spacing; the brand name and breadcrumb are currently cramped within the gray block areas.
- [dashboard-hifi r1] Add subtle border-radius or shadow to the KPI cards to improve their separation from the background.
- [mwc-stripe-inspired r1] Fix text overflow and clipping in the Starter and Professional cards by ensuring the card height is sufficient for the content and line-heights are appropriate.
- [mwc-stripe-inspired r1] Resolve the overlap in the Professional card where the 'Most Popular' badge covers the text below the title.
- [mwc-stripe-inspired r1] Reduce the excessive vertical whitespace between the pricing cards and the footer to improve information density and visual flow.
- [mwc-404-page r1] Remove the HTML underline from the 'Homepage' text and style the bottom navigation links uniformly.
- [mwc-404-page r1] Tighten the vertical spacing between the search box and the 'Go Home' CTA to improve visual hierarchy.
- [mwc-404-page r1] Add a subtle illustration or brand element to the 404 area to increase visual appeal.