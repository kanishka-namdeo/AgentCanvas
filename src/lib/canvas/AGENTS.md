# AGENTS.md — `src/lib/canvas/`

## Purpose

The canvas state layer: types, the Zustand store that is the single source of truth for the React UI, patch application logic, and the Socket.IO canvas-sync service.

The store intentionally has no direct dependency on the Pi Agent SDK — the agent runs server-side; the frontend only renders the result of tool calls (canvas patches) and the chat stream.

## Ownership

- `types.ts` — `CanvasDocument`, `Shape`, `CanvasPatch`, `SyncEvent`, `ClientEvent`, `Constraints`, design-token types. Owned by this folder; consumed by `agent/`, `sessions/`, `components/canvas/`, `app/api/`.
- `store.ts` — the Zustand store. Single source of truth for the React UI. Bridges every prompt + event into the persistent session store.
- `patch.ts` — `applyPatchToCanvas(document, patch)`. Pure function. Null-safe. Tree-aware (.pen aligned). COORDINATE CONTRACT: stored node x/y are RELATIVE to the parent; ops that move nodes across parents (`group`, `duplicate`, `reparent`, `ungroup`, `align`) must remap between coordinate systems via `getAbsolutePosition` / `getAncestorOffset` so absolute positions are preserved. `group` nests under the targets' common parent (Figma semantics) and remaps children into group space; `duplicate` keeps the clone in the original's parent (via `findNodeArray` — .pen nodes do NOT store parentId) offset +24 in absolute space; `align` converts the computed absolute positions back to relative before writing.
- `server.ts` — Socket.IO WebSocket service for live canvas broadcast. NOT a Prisma loader. (Note: the server-side canvas loading is currently handled inline in the API route, not via a dedicated loader module.)
- `clipboard.ts` — Pure clipboard helpers: `serializeShapes`, `deserializeShapes`, `offsetShapes`, `ClipboardPayload` type, `detectPayloadKind`. Browser-safe, unit-testable. Wrapped by `useClipboard` hook.
- `export.ts` — client-side export utilities (`exportSvg`, `exportSvgWithSize`, `exportPngDataUrl` (async, REAL canvas rasterization @2x — previously returned the SVG data URL mislabeled as PNG), `exportJson`, `exportCode`, `downloadFile`, `downloadDataUrl`, `copyToClipboard`) mirroring the export tools without an LLM round-trip. SVG output carries gradients (<linearGradient>/<radialGradient> in <defs>), drop shadows (feDropShadow, 8-digit hex → rgba), opacity, rotation, and star/polygon nodes. `frameId` filtering is tree-based (frame + descendants) with a bbox fallback for childless frames.
- `use-canvas-gestures.ts` — React hook unifying mouse/trackpad/touch input: cursor-anchored wheel zoom, pinch-zoom, 2-finger pan, space+drag pan, touch momentum.

## Local Contracts

### Store contract (`store.ts`)
- The store holds: `document` (CanvasDocument), `connected` (WebSocket status), `turns` (live streaming chat buffer), `selectedIds`, `agentHighlightIds` (transient agent-selected shape highlights), `viewerCount`, `activeSessionId`, `agentBusy`, `toolMode` ('select' | 'pan'), `undoStack`, `redoStack`, plus actions.
- **toolMode**: controls canvas interaction mode. `'select'` (default) = click-to-select shapes. `'pan'` = click-drag pans the canvas. Toggled by the Toolbar's Select/Pan buttons + V/H keyboard shortcuts. Space-held temporarily overrides to pan.
- **Undo/redo**: `undo()` and `redo()` pop/push the stacks (capped at 50). Wired to `⌘Z` / `⌘⇧Z` keyboard shortcuts in `page.tsx`. `sendPatch` pushes to `undoStack` for mutating ops (was previously only pushed when patches arrived over WS — now works for offline edits too).
- **Session management**: `switchSession(sessionId)` loads a session's snapshot and rebuilds `turns`. `newSession()` creates a fresh session. `forkActiveSession(fromMessageId?)` forks from a specific message's snapshot (if found) or from latest state.
- **Agent control**: `stopAgent()` aborts the in-flight HTTP fetch (if any) and finalizes the turn as cancelled, triggering snapshot capture and run closeout. `steer(text)` sends an `agent:steer` event mid-run to redirect the agent without aborting.
- The store exposes a `window.__canvasStore` global in dev for debugging. Do not remove.
- **Settings injection**: `promptAgent` calls `agentRunSettings(useSettings.getState())` and injects the result into both the WebSocket emit path (`socket.emit('client', { type: 'agent:prompt', ..., settings })`) and the HTTP fallback path (`fetch('/api/agent', { body: { ..., settings } })`). This ensures the server-side runner respects user-configured temperature, maxIterations, planFirst, defaultPalette, skillSelectionMode, and LLM provider config.
- The store has an HTTP fallback: if the WebSocket connection fails, `promptAgent` falls back to `fetch('/api/agent')` and parses the chunked NDJSON response. Do not remove the fallback — it is the primary path in the sandbox.
- The store bridges into `useSessionStore`: `promptAgent` starts a Run + appends Messages; `_onSync` mirrors every event (deltas, tool calls, errors) into the session store; `turn_end` captures a Snapshot (respecting the `snapshotCadence` setting + `maxSnapshotsPerSession` cap).
- **Snapshot cadence**: `turn_end` handler reads `useSettings.getState().snapshotCadence` ('every-turn' / 'every-3-turns' / 'every-5-turns' / 'manual'). 'manual' skips auto-capture; the user must use the History panel's "Capture current state" button. When `maxSnapshotsPerSession` is exceeded, oldest non-bookmarked snapshots are auto-deleted.
- `_syncTurnsFromSession` rebuilds the live `turns` buffer from session-store messages when switching sessions. Tool calls are joined by `runId`.
- The store bridges into `useSessionStore`, which uses `skipHydration: true` + a manual `hydrateSessionStore()` call in `init()` to avoid SSR hydration mismatches.
- **forkActiveSession(fromMessageId)**: when `fromMessageId` is provided, finds the snapshot whose `sourceMessageId` matches and calls `forkSessionFromSnapshot()` to seed the fork from that point in history (not the parent's latest state). Falls back to `forkSession()` (latest state) if no matching snapshot is found.

### React subscription safety
- Zustand selectors MUST return stable references. Never write `useCanvasStore((s) => s.document.tokens ?? { colors: [], textStyles: [] })` — the `?? {}` creates a new object every render and triggers an infinite loop.
- Use a stable module-level fallback constant (e.g. `EMPTY_TOKENS`) for selectors returning arrays or objects — never inline `?? {}` / `?? []`.
- Same rule applies to any selector returning an array or object.

### Patch contract (`patch.ts`)
- `applyPatchToCanvas(document, patch)` is pure — it returns a new document, never mutates the input.
- Every shape access MUST be null-safe: `document.shapes.find((s) => s.id === id)?.x ?? 0`. The LLM can reference shape IDs that no longer exist (e.g. after a `pen_clear`); the patch layer MUST not crash.
- Numeric coercion: all numeric fields from the LLM MUST be passed through `Number()` before use. The patch layer is the last defense against `s.x.toFixed is not a function`.
- Patches are append-only in the session store; the patch layer itself is stateless.
- **.pen tree model**: `doc.children` (a .pen `PenChild[]` object tree) is the SOURCE OF TRUTH. `doc.shapes` is a DERIVED render cache recomputed via `resolvePenTree()` after every mutation. Patch ops mutate the tree; the applier then calls `recomputeDerived()`.
- `toPenNodePartial()` maps legacy Shape fields (`radius`→`cornerRadius`, `text`→`content`, `autoLayout`→`layout`/`gap`/...) to .pen fields so existing tools keep working.
- `normalizeOverride()` (Phase 2) does the same field-name mapping for instance-override payloads — the agent tools accept Figma-style names (`text`, `textColor`, `strokeWidth`, `radius`) and the normalizer converts them to .pen names (`content`, `fill`, `strokeWeight`, `cornerRadius`) before storing on `ref.descendants[path]`.
- The full set of patch ops:
  - **Core ops**: `add`, `update`, `remove`, `clear`, `background`, `select`.
  - **Extended ops**: `bulk_add`, `update_many`, `duplicate`, `group`, `ungroup`, `align`, `tokens`.
  - **Phase 1+2+5 ops**: `zorder`, `reorder`, `viewport`, `undo`, `redo`.
  - **Structure ops**: `reparent` (move a node under a new parent, `keepAbsolutePosition` option), `set_constraints` (Figma-style horizontal/vertical constraints).
  - **.pen-aligned ops**: `set_theme_axis`, `set_node_theme`, `set_variable`, `mark_slot`.
  - **Figma ontology ops (Phase 1)**: `add_page`, `delete_page`, `rename_page`, `set_active_page`, `add_section`, `create_component`, `create_component_set`, `add_variant`, `set_component_property`, `set_instance_property`, `flatten_boolean`.
  - **Component-system ops (Phase 2 — Figma-aligned components & design systems)**:
    - `convert_to_component` — promote a frame/group/shape to a reusable `Component` node (sets `reusable=true`).
    - `place_instance` — create a `PenRef` (proper linked instance) pointing at a reusable Component.
    - `set_instance_override` — override a descendant property on a PenRef (text/fill/stroke/visibility); auto-normalizes legacy Shape field names to .pen field names.
    - `reset_instance` — clear ALL overrides on a PenRef, re-sync from main component.
    - `detach_instance` — convert a PenRef into a standalone `Component`/frame node (break the link, bake overrides in).
    - `combine_as_variants` — wrap multiple Component nodes into a ComponentSet (variants); axes auto-derived from "Property=Value" naming convention if not explicitly provided.
    - `swap_variant` — switch which variant of a ComponentSet an instance points to (changes `ref.ref`).
  - **REMOVED**: `heatmap` (dropped for .pen format purity — pen.dev has no analysis-overlay concept).
- `undo` and `redo` are client-side only — they pop the undo/redo stacks and do not produce server-side mutations.

### Types contract (`types.ts`)
- `Shape` extends the Prisma `Shape` model with additional fields used by the rendering and tool layers. The Prisma model is currently **stale** — it lacks the extended fields listed below. This is a known gap: when changing Shape fields, the Prisma schema should be updated to match, but currently it has not been.
- Extended Shape fields beyond the Prisma model:
  - `autoLayout?: AutoLayout | null` — auto-layout config for frame/group shapes (direction, padding, gap, alignment).
  - `tokenBinding?: TokenBinding | null` — design token binding (`fillToken`, `textToken`, `strokeToken`).
  - `componentId?: string | null` — marks shape as a component instance.
  - `points?: PathPoint[] | null` — for path shapes (canvas-space 2D points).
  - `closed?: boolean` — for path shapes (filled vs stroked).
  - `src?: string | null` — for image shapes (data URL or remote URL).
  - `radii?: CornerRadii | null` — per-corner border radii.
  - `gradient?: GradientFill | null` — linear/radial gradient fill.
  - `shadow?: ShadowEffect | null` — drop shadow effect.
  - `blur?: number` — Gaussian blur radius.
  - `maskId?: string | null` — clip mask reference.
- Supporting types:
  - `AutoLayout` — direction, padding, gap, horizontal/vertical alignment.
  - `TokenBinding` — `fillToken`, `textToken`, `strokeToken` references.
  - `PathPoint` — canvas-space 2D point (`x`, `y`).
  - `CornerRadii` — per-corner radii (`topLeft`, `topRight`, `bottomLeft`, `bottomRight`).
  - `GradientFill` — linear/radial gradient (`angle`, `stops`, `type`).
  - `ShadowEffect` — drop shadow (`color`, `offsetX`, `offsetY`, `blur`, `spread`).
  - `ColorToken` — design system color token (`name`, `value`, `hex`).
  - `TextStyleToken` — design system text style token (`name`, `fontSize`, `fontWeight`, `lineHeight`, `letterSpacing`).
  - `DesignTokens` — container for `colors` and `textStyles` arrays (derived from .pen `variables`).
- **REMOVED types**: `HeatmapPoint` and `HeatmapOverlay` — dropped for .pen format purity.
- `CanvasPatch` is the delta format the agent emits. It is NOT the same as the Prisma model — it carries `{ op, shapeId, updates }` style operations.
- `SyncEvent` is the Pi-compatible event union: `chat_delta`, `tool_call_start`, `tool_call_end`, `error`, `turn_end`, etc. Adding a new event kind requires updating the canvas store's `_onSync` handler.
- `CanvasToolContext` is the bag passed to `executeTool` — it carries the document, the patch sink, and the event emitter.
- **Pages abstraction**: `CanvasDocument.pages?: PenPage[]` + `activePageIndex` (Figma-style multi-page documents; see `../pen/AGENTS.md`). Patches `add_page` / `delete_page` / `rename_page` / `set_active_page` operate on it.
- `SyncEvent` includes the extended agent events (skill/plan/subagent/thinking/ask-user/todo/background-task/mcp) — see `../agent/AGENTS.md` for the full list.

### WebSocket service (`server.ts`)
- `server.ts` is a standalone Socket.IO service (NOT a Prisma document loader). It runs on port 3003 and broadcasts canvas patches + agent events to connected viewers.
- It maintains per-document state in memory (`Map<documentId, DocState>`).
- On `subscribe`: creates an empty document if not in the map.
- On `prompt`: calls the agent runner and fans out events to all subscribers.
- Patches are applied via `applyPatchToCanvas` from `patch.ts`.
- The API route (`/api/agent`) handles document loading directly via Prisma — there is no dedicated server-side loader module.

## Work Guidance

- When changing the `Shape` type: update `prisma/schema.prisma` (the `Shape` model), `types.ts`, `patch.ts` (default values), `tools.ts` (tool schemas), and `PropertiesPanel.tsx` (form fields). All five are coupled.
- When adding a new `SyncEvent` kind: add the type, add the `_onSync` case in `store.ts`, add the API route forwarding case in `app/api/agent/route.ts`, add the mini-service broadcast case in `mini-services/canvas-sync/index.ts`.
- When debugging "the canvas didn't update": check `window.__canvasStore.getState()` in the browser console — the store is the source of truth, not the DOM.
- When debugging infinite re-renders: check all Zustand selectors for `?? {}` / `?? []` patterns. Replace with stable constants.

## Verification

- `bunx tsc --noEmit` — typecheck.
- Manual: open the app, run a prompt, verify shapes appear on the canvas and the layers panel updates.
- Reload the page — the session store should restore the last session's canvas via the snapshot.
- `window.__canvasStore.getState().document.shapes.length` should match the visible shape count.

## Child DOX Index

No child AGENTS.md files in this folder.

*Siblings: `../agent/AGENTS.md` (Agent layer), `../sessions/AGENTS.md` (Session persistence).*
