# AGENTS.md — `src/lib/canvas/`

## Purpose

The canvas state layer: types, the Zustand store that is the single source of truth for the React UI, patch application logic, and the Socket.IO canvas-sync service.

The store intentionally has no direct dependency on the Pi Agent SDK — the agent runs server-side; the frontend only renders the result of tool calls (canvas patches) and the chat stream.

## Ownership

- `types.ts` — `CanvasDocument`, `Shape`, `CanvasPatch`, `SyncEvent`, `ClientEvent`, `CanvasToolContext`. Owned by this folder; consumed by `agent/`, `sessions/`, `components/canvas/`, `app/api/`.
- `store.ts` — the Zustand store. Single source of truth for the React UI. Bridges every prompt + event into the persistent session store.
- `patch.ts` — `applyPatchToCanvas(document, patch)`. Pure function. Null-safe.
- `server.ts` — Socket.IO WebSocket service for live canvas broadcast. NOT a Prisma loader. (Note: the server-side canvas loading is currently handled inline in the API route, not via a dedicated loader module.)

## Local Contracts

### Store contract (`store.ts`)
- The store holds: `document` (CanvasDocument), `connected` (WebSocket status), `turns` (live streaming chat buffer), `selectedId`, `prompting` (bool), plus actions.
- The store exposes a `window.__canvasStore` global in dev for debugging. Do not remove.
- The store has an HTTP fallback: if the WebSocket connection fails, `promptAgent` falls back to `fetch('/api/agent')` and parses the chunked SSE-style response. Do not remove the fallback — it is the primary path in the sandbox.
- The store bridges into `useSessionStore`: `promptAgent` starts a Run + appends Messages; `_onSync` mirrors every event (deltas, tool calls, errors) into the session store; `turn_end` captures a Snapshot.
- `_syncTurnsFromSession` rebuilds the live `turns` buffer from session-store messages when switching sessions. Tool calls are joined by `runId`.
- The store bridges into `useSessionStore`, which uses `skipHydration: true` + a manual `hydrateSessionStore()` call in `init()` to avoid SSR hydration mismatches.

### React subscription safety
- Zustand selectors MUST return stable references. Never write `useCanvasStore((s) => s.document.tokens ?? { colors: [], textStyles: [] })` — the `?? {}` creates a new object every render and triggers an infinite loop.
- Use a stable module-level fallback constant (e.g. `EMPTY_TOKENS`) for selectors returning arrays or objects — never inline `?? {}` / `?? []`.
- Same rule applies to any selector returning an array or object.

### Patch contract (`patch.ts`)
- `applyPatchToCanvas(document, patch)` is pure — it returns a new document, never mutates the input.
- Every shape access MUST be null-safe: `document.shapes.find((s) => s.id === id)?.x ?? 0`. The LLM can reference shape IDs that no longer exist (e.g. after a `canvas_clear`); the patch layer MUST not crash.
- Numeric coercion: all numeric fields from the LLM MUST be passed through `Number()` before use. The patch layer is the last defense against `s.x.toFixed is not a function`.
- Patches are append-only in the session store; the patch layer itself is stateless.
- The full set of patch ops (14):
  - **Core ops**: `add`, `update`, `remove`, `clear`, `background`, `select`.
  - **Extended ops**: `bulk_add`, `update_many`, `duplicate`, `group`, `ungroup`, `align`, `tokens`, `heatmap`.
  - **Phase 1+2+5 ops**: `zorder`, `reorder`, `viewport`, `undo`, `redo`.
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
  - `DesignTokens` — container for `colors` and `textStyles` arrays.
  - `HeatmapPoint` — single heatmap data point (`x`, `y`, `intensity`).
  - `HeatmapOverlay` — heatmap overlay config (`points`, `radius`, `opacity`).
- `CanvasPatch` is the delta format the agent emits. It is NOT the same as the Prisma model — it carries `{ op, shapeId, updates }` style operations.
- `SyncEvent` is the Pi-compatible event union: `chat_delta`, `tool_call_start`, `tool_call_end`, `error`, `turn_end`, etc. Adding a new event kind requires updating the canvas store's `_onSync` handler.
- `CanvasToolContext` is the bag passed to `executeTool` — it carries the document, the patch sink, and the event emitter.

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
