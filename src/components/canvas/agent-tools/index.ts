// Barrel + registration manifest for the agent-tools visualizer registry.
//
// THIS FILE is the single place to add a new per-tool visualizer: append a
// side-effect `import './visualizers/<tool>'` line below. The visualizer file
// then calls `defineToolVisualizer({ toolName, Body })` at its top level and
// the dispatcher picks it up on the next render — no edit to `dispatcher.tsx`
// or `AgentPanel.tsx`.
//
// Why side-effect imports here (not in dispatcher.tsx): keeps the dispatcher
// a pure generic lookup that NEVER changes as visualizers are added, mirroring
// the OpenHands pattern. The barrel is the manifest.

// Pure exports — the dispatcher component + the registration helpers/types.
// `ToolVisualizerBody` is the dispatcher COMPONENT (a value) here; the
// registry's same-named TYPE alias is reachable as `ToolVisualizer['Body']`
// so consumers do not need a second exported symbol.
export { ToolVisualizerBody } from './dispatcher';
export {
  defineToolVisualizer,
  getToolVisualizer,
  hasToolVisualizer,
  type ToolVisualizer,
  type ToolVisualizerProps,
} from './registry';

// Side-effect imports — register every visualizer. Adding a new visualizer
// is one line here + one `defineToolVisualizer` call in the new file.
import './visualizers/create-node';
