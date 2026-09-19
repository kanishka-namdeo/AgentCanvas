# World-class test bench report

**Generated:** 2026-09-18T23:21:57.269Z
**Repeats per scenario:** 1
**VLM layer:** agnes-3.0-flash vision

## Headline metrics

| Metric | Value |
|---|---|
| Overall AQS (0-100) | **47.5** |
| Scenarios fully passing | 3 / 6 |

## Per-scenario breakdown

| ID | Pass rate | Wilson 95% CI lower | Mean latency (s) | Mean toolcalls | VLM overall | AQS |
|---|---|---|---|---|---|---|
| login-hifi | 1 | 0.207 | 124±0 | 17±0 | 2 | **53.3** |
| dashboard-hifi | 0 | 0 | 371.8±0 | 17±0 | 5 | **49.7** |
| mwc-mindmap | 1 | 0.207 | 127.9±0 | 20±0 | 1 | **48.3** |
| mwc-404-page | 0 | 0 | 67.8±0 | 0±0 | 4 | **55** |
| mwc-multistep-wizard | 1 | 0.207 | 225.8±0 | 30±0 | 2 | **44.2** |
| mwc-stripe-inspired | 0 | 0 | 209.3±0 | 24±0 | 1 | **34.7** |

## Layer composition (per scenario)

AQS = 0.40·L1 + 0.25·L5 + 0.20·L7_speed + 0.15·L7_toolcount (when VLM is enabled)
AQS = 0.50·L1 + 0.25·L7_speed + 0.25·L7_toolcount (when VLM is skipped)

- **L1 (deterministic)**: Wilson 95% CI lower bound on pass rate — the value we're 95% confident the true pass rate is AT LEAST this high.
- **L5 (VLM-as-judge)**: mean of agnes-3.0-flash's 5-dim rubric (aesthetics + learnability + efficiency + usability + overall), normalized to 0-100.
- **L7_speed**: 180s / mean latency (seconds), clamped to [0, 1] × 100. Faster = higher.
- **L7_toolcount**: 20 / mean tool calls, clamped to [0, 1] × 100. Fewer calls (more efficient) = higher.

## VLM top fixes (most common across runs)

- [mwc-multistep-wizard r1] Fix the overlapping layout of the 'Marketing Site' card so it aligns properly with the other columns.
- [mwc-multistep-wizard r1] Standardize the background color of the template cards (currently a mix of white and gray).
- [mwc-multistep-wizard r1] Ensure text descriptions for the cards are not clipped by overlapping elements.
- [mwc-mindmap r1] Fix the auto-layout engine to ensure node labels (e.g., 'User Research', 'Metrics') do not get clipped or split into separate text nodes.
- [mwc-mindmap r1] Remove the large gray background rectangles that are obscuring the connection lines and creating visual confusion.
- [mwc-mindmap r1] Group the child nodes tightly with their branch headers so the tree structure is visually cohesive and not scattered.
- [login-hifi r1] Remove the light-blue background 'block' behind the fields to create a cleaner, modern white interface.
- [login-hifi r1] Increase padding and visual separation between the form fields and the 'Forgot password?' link to prevent accidental taps and improve clarity.
- [login-hifi r1] Ensure the bottom legal text ('Sign up', Terms, etc.) is fully contained within the frame and not overlapping or cut off.
- [dashboard-hifi r1] Reduce the height of the KPI cards to remove the excessive empty white space at the bottom of each card.
- [dashboard-hifi r1] Tighten the header layout by grouping the time-filter button and notification icons closer to the search bar to improve the use of the middle section.
- [dashboard-hifi r1] Ensure the green 'vs last month' text in the cards meets WCAG AA contrast standards, as the small green text appears faint.
- [mwc-stripe-inspired r1] Fix the heading text so it is fully visible and not clipped on the left.
- [mwc-stripe-inspired r1] Align the three pricing cards (Starter, Scale, Enterprise) into a uniform grid with consistent heights and positions.
- [mwc-stripe-inspired r1] Add a label to the empty button in the 'Scale' tier and remove the floating/overlapping grey boxes that break the layout.
- [mwc-404-page r1] Increase the contrast ratio of the 'Go Home' text when it appears as a secondary link to ensure it passes accessibility standards.
- [mwc-404-page r1] Add a more visible focus state (outline or glow) for the search bar and CTA button to improve keyboard navigation usability.
- [mwc-404-page r1] Increase the vertical whitespace around the 'Go Home' button in the left panel to better separate it from the search input.