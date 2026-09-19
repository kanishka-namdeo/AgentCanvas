// Tool visualizer registry — the OpenHands pattern 5.1.
//
// Adding a per-tool React component is a 3-line registration:
//   1. create `visualizers/<tool>.tsx`
//   2. call `defineToolVisualizer({ toolName, Body })` at module top level
//   3. add a side-effect `import './visualizers/<tool>'` to `index.ts`
//
// No edit to `dispatcher.tsx` is ever required — the dispatcher is a generic
// Map lookup. Unregistered tools fall through to `null`, and the caller
// (`AgentPanel.tsx` `ToolCallEntry`) keeps its existing default `<pre>` JSON
// rendering. The registry is purely additive.

import type { ComponentType } from 'react';
import type { AgentToolCallEntry } from '@/lib/canvas/store';

/// Props every per-tool visualizer receives. Mirrors the `tc` the dispatcher
/// is handed by `ToolCallEntry` — visualizers read `tc.argsPreview` (a JSON
/// string) and `tc.summary` / `tc.success` as needed. They MUST NOT assume
/// `argsPreview` parses as JSON — the translator may truncate it.
export interface ToolVisualizerProps {
  tc: AgentToolCallEntry;
}

/// A per-tool React body. Pure, presentational, no store reads — the parent
/// already has the `tc` in hand.
export type ToolVisualizerBody = ComponentType<ToolVisualizerProps>;

/// The registry record. `toolName` is the exact tool name string the agent
/// emits in `agent:tool_call_start` (e.g. `pen_create_node`, `pen_get_metadata`).
export interface ToolVisualizer {
  toolName: string;
  Body: ToolVisualizerBody;
}

/// Module-level Map keyed by EXACT tool name. No prefix matching — keep the
/// lookup O(1) and predictable; the dispatcher is the only consumer.
const REGISTRY = new Map<string, ToolVisualizerBody>();

/// `__DEV__` shim — the rest of the codebase reads `process.env.NODE_ENV`
/// but this module is imported by client components; guard for SSR safety.
const __DEV__ =
  typeof process !== 'undefined' && process.env && process.env.NODE_ENV !== 'production';

/// Register a per-tool visualizer. Idempotent within a module reload (HMR
/// re-runs the registration, overwriting the prior entry — safe). Re-registering
/// the same `toolName` is allowed (last write wins) but discouraged; prefer one
/// visualizer per tool name to keep behavior obvious.
export function defineToolVisualizer(opts: ToolVisualizer): void {
  if (__DEV__) {
    // dev-only guard: surface a duplicate-registration hint without crashing.
    // HMR re-executes module top-level — duplicates ARE expected across
    // reloads; we just overwrite silently in production.
    if (REGISTRY.has(opts.toolName) && typeof console !== 'undefined') {
      console.warn(
        `[agent-tools] re-registering visualizer for "${opts.toolName}" (likely HMR reload)`,
      );
    }
  }
  REGISTRY.set(opts.toolName, opts.Body);
}

/// Look up the registered visualizer for a tool name. Returns `undefined`
/// when no visualizer is registered — the dispatcher then renders `null`
/// so the caller falls back to its default rendering.
export function getToolVisualizer(toolName: string): ToolVisualizerBody | undefined {
  return REGISTRY.get(toolName);
}

/// Test-only helper (kept tiny): does the registry have a visualizer for a
/// given tool name? Used by the example visualizer's smoke check; not for
/// production code paths.
export function hasToolVisualizer(toolName: string): boolean {
  return REGISTRY.has(toolName);
}
