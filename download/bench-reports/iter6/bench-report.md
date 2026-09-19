# World-class test bench report

**Generated:** 2026-09-18T22:30:05.243Z
**Repeats per scenario:** 1
**VLM layer:** agnes-3.0-flash vision

## Headline metrics

| Metric | Value |
|---|---|
| Overall AQS (0-100) | **49.9** |
| Scenarios fully passing | 4 / 6 |

## Per-scenario breakdown

| ID | Pass rate | Wilson 95% CI lower | Mean latency (s) | Mean toolcalls | VLM overall | AQS |
|---|---|---|---|---|---|---|
| login-hifi | 1 | 0.207 | 75.4±0 | 21±0 | 4 | **62.5** |
| dashboard-hifi | 1 | 0.207 | 155.3±0 | 24±0 | 4 | **60.8** |
| mwc-mindmap | 1 | 0.207 | 108.8±0 | 31±0 | 1 | **42.9** |
| mwc-404-page | 0 | 0 | 61.3±0 | 0±0 | 2 | **45** |
| mwc-multistep-wizard | 0 | 0 | 209.9±0 | 22±0 | 1 | **35.8** |
| mwc-stripe-inspired | 1 | 0.207 | 179±0 | 21±0 | 2 | **52.5** |

## Layer composition (per scenario)

AQS = 0.40·L1 + 0.25·L5 + 0.20·L7_speed + 0.15·L7_toolcount (when VLM is enabled)
AQS = 0.50·L1 + 0.25·L7_speed + 0.25·L7_toolcount (when VLM is skipped)

- **L1 (deterministic)**: Wilson 95% CI lower bound on pass rate — the value we're 95% confident the true pass rate is AT LEAST this high.
- **L5 (VLM-as-judge)**: mean of agnes-3.0-flash's 5-dim rubric (aesthetics + learnability + efficiency + usability + overall), normalized to 0-100.
- **L7_speed**: 180s / mean latency (seconds), clamped to [0, 1] × 100. Faster = higher.
- **L7_toolcount**: 20 / mean tool calls, clamped to [0, 1] × 100. Fewer calls (more efficient) = higher.

## VLM top fixes (most common across runs)

- [mwc-multistep-wizard r1] Reposition the numbered progress bar (steps 1-5) to the top of the container, as explicitly requested in the prompt, rather than at the bottom.
- [mwc-multistep-wizard r1] Fix the container width and layout to prevent the large empty whitespace on the right and ensure the template cards are evenly spaced in a cohesive grid or row.
- [mwc-multistep-wizard r1] Resolve overlapping UI elements, specifically ensuring the navigation buttons ('Back', 'Review & Launch') do not collide with the progress bar or template card descriptions.
- [mwc-mindmap r1] Implement auto-layout or centering to distribute nodes across the available canvas width instead of cramming them into a tiny vertical column.
- [mwc-mindmap r1] Enlarge node shapes significantly and increase padding to ensure comfortable touch targets.
- [mwc-mindmap r1] Place text labels inside the node shapes (centered) rather than outside the bottom edge to create a unified visual element.
- [login-hifi r1] Add a 'show password' eye toggle icon inside the Password field for better usability.
- [login-hifi r1] Enhance the visual appeal with a subtle gradient on the main button or the background to elevate the 'fintech' brand personality.
- [login-hifi r1] Refine the input fields to use small labels above the fields rather than inside them, reducing visual ambiguity during form filling.
- [dashboard-hifi r1] Add subtle drop shadows to the KPI cards to improve depth and visual separation from the background.
- [dashboard-hifi r1] Implement a focus state for the 'AR' avatar button and the search bar to improve accessibility.
- [dashboard-hifi r1] Increase the visual weight of the 'Insightly' brand name in the header to balance it against the search bar.
- [mwc-stripe-inspired r1] Fix the layout in the hero section to prevent the subtitle 'Plans for every stage' from overlapping with the CTA buttons and 'No credit card' text.
- [mwc-stripe-inspired r1] Ensure the subheading 'Transparent per-transaction pricing...' is fully contained within the viewport width and properly aligned.
- [mwc-stripe-inspired r1] Reorder the hero content logically: Headline -> Subhead -> CTA Buttons -> Micro-copy (No credit card required).
- [mwc-404-page r1] Increase the text contrast for 'Page Not Found' and the helper text to at least #555555 to meet accessibility standards.
- [mwc-404-page r1] Increase the visual weight of the '404' headline and add a subtle drop shadow or gradient to make it stand out more.
- [mwc-404-page r1] Add visual hierarchy to the right-hand panel ('You might be looking for') so it is not just a faint, nearly invisible list.