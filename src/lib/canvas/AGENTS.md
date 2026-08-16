# AGENTS.md — `src/lib/canvas/`

## Purpose

The canvas state layer: types, the Zustand store that is the single source of truth for the React UI, patch application logic, and the server-side canvas loader.

The store intentionally has no direct dependency on the Pi Agent SDK — the agent runs server-side; the frontend only renders the result of tool calls (canvas patches) and the chat stream.

## Ownership

- `types.ts` — `CanvasDocument`, `Shape`, `CanvasPatch`, `SyncEvent`, `ClientEvent`, `CanvasToolContext`. Owned by this folder; consumed by `agent/`, `sessions/`, `components/canvas/`, `app/api/`.
- `store.ts` — the Zustand store. Single source of truth for the React UI. Bridges every prompt + event into the persistent session store.
- `patch.ts` — `applyPatchToCanvas(document, patch)`. Pure function. Null-safe.
- `server.ts` — server-side canvas loader (Prisma queries). Used by the API route to hydrate the initial canvas before running the agent.

## Local Contracts

### Store contract (`store.ts`)
- The store holds: `document` (CanvasDocument), `connected` (WebSocket status), `turns` (live streaming chat buffer), `selectedId`, `prompting` (bool), plus actions.
- The store exposes a `window.__canvasStore` global in dev for debugging. Do not remove.
- The store has an HTTP fallback: if the WebSocket connection fails, `promptAgent` falls back to `fetch('/api/agent')` and parses the chunked SSE-style response. Do not remove the fallback — it is the primary path in the sandbox.
- The store bridges into `useSessionStore`: `promptAgent` starts a Run + appends Messages; `_onSync` mirrors every event (deltas, tool calls, errors) into the session store; `turn_end` captures a Snapshot.
- `_syncTurnsFromSession` rebuilds the live `turns` buffer from session-store messages when switching sessions. Tool calls are joined by `runId`.
- The store uses `skipHydration: true` on the session store + manual `hydrateSessionStore()` call in `init()` to avoid SSR hydration mismatches.

### React subscription safety
- Zustand selectors MUST return stable references. Never write `useCanvasStore((s) => s.document.tokens ?? { colors: [], textStyles: [] })` — the `?? {}` creates a new object every render and triggers an infinite loop.
- Use a module-level `EMPTY_TOKENS` constant (already defined in `store.ts`) for fallback values.
- Same rule applies to any selector returning an array or object.

### Patch contract (`patch.ts`)
- `applyPatchToCanvas(document, patch)` is pure — it returns a new document, never mutates the input.
- Every shape access MUST be null-safe: `document.shapes.find((s) => s.id === id)?.x ?? 0`. The LLM can reference shape IDs that no longer exist (e.g. after a `canvas_clear`); the patch layer MUST not crash.
- Numeric coercion: all numeric fields from the LLM MUST be passed through `Number()` before use. The patch layer is the last defense against `s.x.toFixed is not a function`.
- Patches are append-only in the session store; the patch layer itself is stateless.

### Types contract (`types.ts`)
- `Shape` mirrors the Prisma `Shape` model exactly (field names, types, defaults). If you change one, change the other.
- `CanvasPatch` is the delta format the agent emits. It is NOT the same as the Prisma model — it carries `{ op, shapeId, updates }` style operations.
- `SyncEvent` is the Pi-compatible event union: `chat_delta`, `tool_call_start`, `tool_call_end`, `error`, `turn_end`, etc. Adding a new event kind requires updating the canvas store's `_onSync` handler.
- `CanvasToolContext` is the bag passed to `executeTool` — it carries the document, the patch sink, and the event emitter.

### Server loader (`server.ts`)
- `getCanvasDocument(documentId)` loads a document + all its shapes from Prisma, returns a `CanvasDocument`.
- Used by `/api/agent` to hydrate the initial canvas before running the agent.
- Returns a stable empty document if the ID does not exist (do not throw — the agent can create shapes against a fresh document).

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

No child `AGENTS.md` files. This folder is flat: `types.ts`, `store.ts`, `patch.ts`, `server.ts`.
