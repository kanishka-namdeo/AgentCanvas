# AGENTS.md — `src/components/canvas/agent-tools/`

## Purpose

Per-tool visualizer registry for the agent chat panel's tool-call cards. Mirrors the OpenHands pattern 5.1: instead of a giant `switch (kind)` over tool names inside `AgentPanel.tsx`'s `ToolCallEntry`, each tool gets its own React component registered via `defineToolVisualizer({ toolName, Body })`. The dispatcher is a single Map lookup — adding a new per-tool visualizer is 3 lines and touches no existing code path. The registry is **additive**: unregistered tools render `null` from the dispatcher and the parent's existing default `<pre>{prettyArgs}</pre>` JSON dump carries the load. Nothing about the default rendering changes when a visualizer is added — the visualizer's output sits BETWEEN the args pre-block and the summary inside the expanded tool card.

## Ownership

- `registry.ts` — the `defineToolVisualizer()` registration function + `getToolVisualizer()` lookup + the module-level `Map<string, ToolVisualizerBody>` keyed by exact tool name. Exports `ToolVisualizer` (record), `ToolVisualizerProps` (props every visualizer receives), and `ToolVisualizerBody` (the `ComponentType<ToolVisualizerProps>` alias, reachable as `ToolVisualizer['Body']` to avoid a name clash with the dispatcher component of the same identifier).
- `dispatcher.tsx` — `<ToolVisualizerBody tc={tc} />`. The ONLY React component the parent (`AgentPanel.tsx`) imports. Looks up the visualizer for `tc.name`; renders it if found, returns `null` if not. This file NEVER needs editing when a new visualizer is added — that is the whole point of the pattern.
- `visualizers/` — one file per tool, each self-registering via `defineToolVisualizer` at module top level. `create-node.tsx` is the seed example (proves the pattern for `pen_create_node`: a colored-chip preview card showing shape type + dimensions + fill, instead of just JSON).
- `index.ts` — barrel + manifest. Re-exports the dispatcher component + the registry helpers/types, AND side-effect-imports every `visualizers/*.tsx` so they self-register on first module load. This is the single place to add a new visualizer: append one `import './visualizers/<tool>'` line. Side-effect imports live in the barrel (not in `dispatcher.tsx`) so the dispatcher stays a pure generic lookup.

## Local Contracts

### Registration contract
- `toolName` MUST be the exact string the agent emits in `agent:tool_call_start.toolName` (e.g. `pen_create_node`, `pen_get_metadata`). No prefix matching, no globbing, no lowercasing — the lookup is `Map.get(name)`, O(1) and predictable.
- One visualizer per `toolName`. Re-registering the same name overwrites (last write wins) and logs a dev-only `console.warn` so HMR reloads are visible but production stays silent.
- A visualizer MUST NOT throw on malformed `tc.argsPreview` — the translator truncates args previews to ~2K chars, so JSON.parse can fail mid-string. Visualizers MUST parse defensively (try/catch) and render `null` (not a broken card) on failure. The parent's default JSON dump still renders below, so the user always sees SOMETHING.
- A visualizer MUST NOT read the canvas store, fetch, or have side effects. It receives `tc: AgentToolCallEntry` and renders a pure presentational card. If a visualizer needs canvas context (e.g. resolved variable color for a `$primary` fill), it should defer to the default rendering — the registry is for glanceable previews, not full fidelity.

### Rendering contract
- A visualizer renders inside `ToolCallEntry`'s expanded panel, AFTER the existing `<pre>{prettyArgs}</pre>` block and BEFORE the `tc.summary` line. It is additive — never replaces the args pre-block, never replaces the summary.
- A visualizer MUST consume the `--ac-*` design tokens (`.ac-surface-*`, `.ac-border-subtle`, `.ac-text-*`) just like the rest of `src/components/canvas/`. No hardcoded `slate-{n}` / `zinc-{n}` / `gray-{n}` literals. Inline `style={{ backgroundColor: ... }}` is allowed for the SHAPE'S OWN color (the actual fill the agent is setting on a canvas node) — that is data, not chrome.
- A visualizer's outermost element should use `mt-1` so it stacks cleanly under the args pre-block (which also uses `mt-1`) without doubling margins when the visualizer returns `null`.
- Dimensions and numeric fields MUST be coerced via `Number()` before `Math.round` / `toFixed` — `argsPreview` is a JSON string, but the agent can emit string-typed sizing tokens like `"fit_content"` / `"fill_container"` for width/height. Render those verbatim; do not `NaN` them.

### Where the dispatcher renders
- `AgentPanel.tsx` `ToolCallEntry` (~line 3175, inside the `expanded && (...)` block). The dispatcher is called as `<ToolVisualizerBody tc={tc} />` with no surrounding conditional — the dispatcher itself returns `null` for unregistered tools, so there is no flash of empty space when no visualizer matches.

## Work Guidance

- Adding a new per-tool visualizer:
  1. Create `visualizers/<tool-short-name>.tsx`.
  2. Export a React component typed `(props: ToolVisualizerProps) => JSX.Element | null`.
  3. Call `defineToolVisualizer({ toolName: '<exact-name>', Body: YourComponent })` at module top level (side effect on import).
  4. Append `import './visualizers/<tool-short-name>';` to `index.ts` (the barrel manifest).
  5. Done — no edit to `dispatcher.tsx`, no edit to `AgentPanel.tsx`.
- Visualizer files are named after the tool's short name (the part after `pen_`), kebab-cased: `create-node.tsx`, `get-metadata.tsx`, `apply-palette.tsx`. One tool per file.
- A visualizer that needs a richer preview than the args alone can carry (e.g. reading the resolved variable color) should be skipped — keep visualizers pure. The agent's raw args are the contract.
- The dispatcher's `null`-on-miss return is the fallback contract. Do NOT change `ToolVisualizerBody` to render a placeholder ("no visualizer registered") — that would defeat the additive-fallback guarantee.

## Verification

- `bunx tsc --noEmit --skipLibCheck src/components/canvas/agent-tools/*.tsx src/components/canvas/agent-tools/*.ts` — typecheck the new module in isolation (the rest of the codebase is verified separately; this guards against a broken visualizer slipping into the bundle).
- Manual: trigger an agent turn that calls `pen_create_node` (e.g. via the ⌘K prompt `Add a blue rectangle`). Expand the tool card — the colored-chip preview should appear between the args JSON dump and the summary line. Trigger a turn that calls an unregistered tool (e.g. `pen_get_metadata`) — no extra block should appear; the existing args + summary layout is unchanged.
- `curl -s -o /dev/null -w '%{http_code}' --max-time 30 http://localhost:3000/app` — the dev server should respond `200` (the new module compiles without breaking the app bundle).

## Mistakes & Lessons

### Failure Modes
- Check that a new visualizer parses `tc.argsPreview` defensively (try/catch + null return) — the translator truncates args at ~2K chars, so `JSON.parse` WILL fail mid-string on large arg sets; a thrown error would unmount the entire tool card.
- Check that a new visualizer's outermost element uses `mt-1` (matching the args pre-block) — without it, the visualizer either overlaps the pre-block or leaves an inconsistent gap when it returns `null`.
- Check that a new visualizer does NOT read the canvas store or fetch — visualizers are pure presentational children of `ToolCallEntry`; store reads here would re-render every tool card on every canvas patch.
- Check that the `toolName` passed to `defineToolVisualizer` matches the EXACT wire string (including the `pen_` prefix) — `Map.get` is case-sensitive and prefix-unaware; a typo silently registers under a key nothing ever looks up.

### Lessons Learned
- Do not edit `dispatcher.tsx` when adding a visualizer — the whole point of the registry pattern is that the dispatcher is a generic lookup that never changes; the barrel `index.ts` is the manifest, append the side-effect import there.
- Do not use the same identifier for the dispatcher component AND the registry's `ComponentType` alias in the barrel — TypeScript will complain about the duplicate export; re-export the type only as `ToolVisualizer['Body']` (or rename the type to `ToolVisualizerBodyComponent`) to avoid the clash.
- Do not return an empty `<></>` from the dispatcher on miss — return `null` so React skips the slot entirely and the parent's spacing collapses cleanly when no visualizer matches.

## Child DOX Index

| Path | Scope |
|------|-------|
| (none yet) | `visualizers/` holds one-file-per-tool self-registering visualizer components; the directory is small enough to own directly via this doc's Ownership + Work Guidance rows. Promote to a child AGENTS.md when the visualizer count crosses ~8 or a sub-pattern (e.g. shared preview primitives) emerges. |

*Siblings: parent `../AGENTS.md` (`src/components/canvas/`) owns `AgentPanel.tsx` (which hosts the dispatcher's render slot), `Canvas.tsx`, `Toolbar.tsx`, `LayersPanel.tsx`, `PropertiesPanel.tsx`, the `dom/` renderer module. The agent-tools registry is the consumer of `AgentToolCallEntry` from `@/lib/canvas/store`; the dispatcher does not write back to the store.*
