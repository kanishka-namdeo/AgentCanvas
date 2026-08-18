# P0-09 — Inline Stop button below streaming response

## Goal
Render a second Stop button inline below the streaming chat response so users don't have to move their cursor to the top-right header to stop a generation in progress.

## Files to touch
- `src/components/canvas/AgentPanel.tsx` — add an inline Stop button inside the streaming-response block.

## Implementation steps
1. In `AgentPanel.tsx`, find the streaming-response block (the loader with the `agentBusy` guard).
2. Render a `<Button variant="destructive" size="sm">` with the `Square` icon + "Stop" label, visible only when `agentBusy === true`.
3. The button's `onClick` calls `useCanvasStore(s => s.stopAgent)()`.
4. Place it right-aligned inside the streaming-response container, just below the loader animation.
5. Match the visual style of the existing `RunStopButton` (red bg, pulsing dot is optional but the button itself should be subtle, not full-width).

## Tests
- `tests/unit/AgentPanel.test.tsx` (new) — render AgentPanel with `agentBusy=true`, assert the inline Stop button is visible and clicking it calls `stopAgent`.

## Acceptance criteria
- [ ] Inline Stop button is visible only while `agentBusy === true`.
- [ ] Clicking the inline Stop button calls `stopAgent()`.
- [ ] Button is right-aligned, just below the streaming-response loader.
- [ ] The header Stop button (existing) continues to work.
- [ ] No visual duplication — when not busy, neither button shows.
