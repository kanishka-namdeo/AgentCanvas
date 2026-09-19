// Tool visualizer dispatcher — the OpenHands pattern 5.1.
//
// Generic Map lookup. NEVER grows when a new visualizer is added — registering
// a new per-tool component is purely a `defineToolVisualizer` call + a barrel
// side-effect import (see `index.ts`). The dispatcher stays a thin lookup.

import { getToolVisualizer } from './registry';
import type { ToolVisualizerProps } from './registry';

/// `<ToolVisualizerBody tc={tc} />` — looks up the registered visualizer for
/// `tc.name`. If found, renders it. If not found, renders `null` and lets the
/// caller (`AgentPanel.tsx` `ToolCallEntry`) keep its existing default
/// `<pre>{prettyArgs}</pre>` JSON dump. The registry is purely additive — it
/// never REPLACES the default rendering, it sits beside it as an extra preview
/// block when a richer visualizer is registered.
///
/// Returns `null` (not an empty fragment) on miss so the caller can decide
/// spacing — `ToolCallEntry` wraps this in a `mt-1` block that collapses
/// cleanly when nothing renders.
export function ToolVisualizerBody({ tc }: ToolVisualizerProps) {
  const Body = getToolVisualizer(tc.name);
  if (!Body) return null;
  return <Body tc={tc} />;
}
