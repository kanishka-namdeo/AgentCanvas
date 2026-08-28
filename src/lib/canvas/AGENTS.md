# AGENTS.md — `src/lib/canvas/`

## Purpose

The canvas state layer: types, the Zustand store that is the single source of truth for the React UI, patch application logic, and the Socket.IO canvas-sync service.

The canvas Document is THE shared artifact (Figma/Cursor model): multiple chat sessions attach to one `documentId` and mutate this ONE canvas state — switching chats never swaps the document.

The store intentionally has no direct dependency on the Pi Agent SDK — the agent runs server-side; the frontend only renders the result of tool calls (canvas patches) and the chat stream.

## Ownership

- `types.ts` — `CanvasDocument`, `Shape`/`Layer`, `CanvasPatch`, `SyncEvent`, `ClientEvent`, `Constraints`, design-token types. Owned by this folder; consumed by `agent/`, `sessions/`, `components/canvas/`, `app/api/`. Phase 6 part 1: `Layer` carries the v3 MIRRORS (`layoutMode`, `itemSpacing`, `paddingLeft/Right/Top/Bottom`, `primaryAxisAlignItems`, `counterAxisAlignItems`, `layoutSizingHorizontal/Vertical`, `layoutPositioning`, `characters`, `textAutoResize`, `rectangleCornerRadii`, `fills: FigmaPaint[]`, `effects: FigmaEffect[]`) populated by `resolvePenTree` ALONGSIDE unchanged legacy fields (dual-field window — spec §9.3 #3); `CanvasPatch.alignKind` accepts BOTH spellings (legacy + canonical `LEFT/RIGHT/HCENTER/TOP/BOTTOM/VCENTER/DISTRIBUTE_H/DISTRIBUTE_V/TIDY`); `Constraints` union carries both casings; `variableType` accepts canonical `COLOR/FLOAT/STRING/BOOLEAN`. ICON NODES: `LayerType` includes `'icon'` — a Lucide library glyph; the Layer carries ONLY the symbolic identity (`iconName`, `iconLibrary`), geometry resolves at render time from `src/lib/icons` (docs/lucide-icons.md) so icons stay small, portable, and updatable by name.
- `store.ts` — the Zustand store. Single source of truth for the React UI. Bridges every prompt + event into the persistent session store.
- `patch.ts` — `applyPatchToCanvas(document, patch)`. Pure function. Null-safe. Tree-aware (.pen aligned). PHASE 6 PART 1: every patch runs through `normalizePatchPayload` AT ENTRY (pen/normalize.ts — op + payload field names FROZEN per §5.1, only enum VALUES normalize: `alignKind` canonicalized, `constraints`/`variableType` accept canonical spellings but store legacy); the `align` op handles BOTH alignKind spellings + `TIDY` (v1 = DISTRIBUTE_H math; real grid semantics land with Phase 7); `toPenNodePartial` passes v3 field names through (imported .pen trees survive patch round-trips) and bridges the icon spellings (`iconName`/`iconLibrary` on Shape-shaped partials → `icon`/`library` on the .pen PenIcon node, so pen_create_node / pen_update_node / generators all round-trip icon identity — docs/lucide-icons.md) and `normalizeToNode` runs `normalizePenNode` so ADDED nodes dual-carry from creation. COORDINATE CONTRACT: stored node x/y are RELATIVE to the parent; ops that move nodes across parents (`group`, `duplicate`, `reparent`, `ungroup`, `align`) must remap between coordinate systems via `getAbsolutePosition` / `getAncestorOffset` so absolute positions are preserved. `group` nests under the targets' common parent (Figma semantics) and remaps children into group space; `duplicate` keeps the clone in the original's parent (via `findNodeArray` — .pen nodes do NOT store parentId) offset +24 in absolute space; `align` converts the computed absolute positions back to relative before writing. PAGES WRITE-BACK (D1 fix): after every tree mutation the applier writes the mutated tree back to `pages[activePageIndex].children` (immutably — new pages array + new page object) so `doc.children` and the active page never desync; skipped when `pages` is absent or `activePageIndex` is out of range. `bulk_add`/`add` shapes[] entries may carry NESTED `children` arrays (the applier inserts the whole subtree — used by `pen_insert_html`); `normalizeToNode`'s `sizeValue()` preserves .pen sizing-behavior STRINGS (`fit_content`, `fill_container`, `fit_content(100)`) that `num()` used to clobber to the 100 default. `add_subtree` (the `pen_create_subtree` batch op): the `shape` payload carries the ROOT of a nested tree and `normalizeSubtree` recursively applies `toPenNodePartial` + `normalizeToNode` + id assignment to EVERY descendant (bulk_add only normalizes roots — descendants are inserted verbatim and must be pre-id'd), with DETERMINISTIC derived ids (`rootId-<index>`) so patch replay is idempotent; one patch = one undo step + one broadcast. Op-name consumers outside the applier switch that must know new CREATE ops: `store.ts` `agentAddedShapesThisTurn` reveal flag, `turn-diff.ts` `CREATE_OPS`, `AgentPanel.tsx` diff-chip tone — a missed case degrades SILENTLY (the applier switch has no `default`).
- `server.ts` — Socket.IO WebSocket service for live canvas broadcast (port 3003, in-process twin of `mini-services/canvas-sync`). Seeds its in-memory document state from the DB's newest `DocumentSnapshot` on first subscribe and handles the `document:restore` client event (see WebSocket service below).
- `clipboard.ts` — Pure clipboard helpers: `serializeShapes`, `deserializeShapes`, `offsetShapes`, `ClipboardPayload` type, `detectPayloadKind`. Browser-safe, unit-testable. Wrapped by `useClipboard` hook.
- `export.ts` — client-side export utilities (`exportSvg`, `exportSvgWithSize`, `exportPngDataUrl` (async — Phase 5 §5.4 contract: PRIMARY path captures the live DOM-rendered `[data-ac-world]` element via `html-to-image` so exports match the agent's `agent:screenshot_request` view; falls back to SVG-projection rasterization when no DOM world is mounted / `html-to-image` unavailable / tainted canvas. Accepts `opts.worldElement` + `opts.backgroundColor` + `opts.frameId` — for frame exports the DOM-capture path locates the frame's subtree via `[data-node-id]` and captures that), `exportJson`, `exportCode` (v2: DELEGATES to `serializeNodes` in `serialize.ts` so client export and the agent tools emit identical code), `downloadFile`, `downloadDataUrl`, `copyToClipboard`) mirroring the export tools without an LLM round-trip. SVG output carries gradients (<linearGradient>/<radialGradient> in <defs>), drop shadows (feDropShadow, 8-digit hex → rgba), opacity, rotation, star/polygon nodes, and Lucide icon nodes (stroke-painted `<g translate+scale>` from the registry, color falling back stroke → textColor → fill). `frameId` filtering is tree-based (frame + descendants) with a bbox fallback for childless frames.
- `html-import.ts` — sanitized HTML fragment → .pen subtree (spec Phase 3, `pen_insert_html` pipeline). SERVER-SAFE hand-rolled recursive-descent tokenizer (NO DOMParser — Node has none; no new deps). SECURITY CONTRACT: tag whitelist (unknown tags unwrap — tag dropped, children hoisted); script/style/iframe/object/embed dropped WITH contents (name-stack drop mode, `<embed>` is void); attribute whitelist (style/src/alt/width/height/href/type/placeholder/value + class/viewBox/stroke for the Lucide round-trip — everything else incl. on*/id/data-*/srcset dropped); URL scheme whitelist (http/https, //, /, ./, ../, #, data:image/ — javascript:/vbscript:/data:text/ and other schemes dropped); entities decoded; comments/doctypes dropped; malformed markup auto-closes, never throws. `htmlToPenTree(Detailed)` maps: containers→frame (flex style→layout/gap/padding/justify/align; ul/ol→vertical gap 8; li→frame or text), h1-h6/p/span/strong/em/label/a/button/textarea→text (headings 32/24/20/18/16/14 + 600/600/600/600/400/400; strong→700; em→italic; color→fill — .pen text nodes store color in fill), img→image-fill node, input→rectangle (radius 6, h 36), hr→line, br→newline, Lucide inline svgs (class="lucide lucide-<name>") → NATIVE icon nodes (name validated + canonicalized against the registry; color from the inline `color:`/`stroke=`; width/height honored), other svg/path skipped+counted. v1 limits (documented in the module header): margins ignored, class CSS not parsed (except the lucide detection), gradients dropped, text sizes estimated.
- `serialize.ts` — one serializer, three frameworks (spec §5.3, copy-as-code v2). `serializeNodes(tree | layers, { framework: 'html'|'react'|'tailwind', rootName })` accepts EITHER the resolver's `ResolvedTreeNode[]` (preferred — carries the .pen layout vocabulary) or a flat `Shape[]` (client path — parent/child map rebuilt from parentId). Auto-layout containers emit REAL nested flexbox; layout:'none' containers emit relative containers with absolutely-positioned children; every element carries `data-name`/`data-node-id`; token-bound fills emit `var(--acv-<key>, <resolved>)`. Tailwind path maps common values to scale classes (gap-3, p-4, rounded-xl, bg-sky-500 …) with arbitrary-value fallbacks (`w-[347px]`, `bg-[color:var(--acv-…)]`). ICON NODES emit idiomatic lucide-style inline `<svg stroke="currentColor">` markup in all three frameworks (React gets camelCase stroke attrs; the `color` style/class carries the resolved paint so tokens still work). Consumed by `pen_copy_as_code` v2, `pen_get_design_context`, and `exportCode`.
- `render-to-png.ts` — server-side SVG→PNG rasterization (resvg) of resolved layers; the §5.4 D8 fallback when no client responds to the `agent:screenshot_request` round-trip (used by `pen_get_screenshot`, `pen_get_design_context`, `pen_export_png`, and the VLM critic — all agent-facing surfaces prefer client DOM capture first, resvg is the no-client fallback). Icon layers render as registry `<g translate+scale>` strokes (resvg-safe, no nested svg).
- `use-canvas-gestures.ts` — React hook unifying mouse/trackpad/touch input: cursor-anchored wheel zoom, pinch-zoom, 2-finger pan, space+drag pan, touch momentum. Exports the shared zoom clamp `clampZoom` + `MIN_ZOOM` (0.1) / `MAX_ZOOM` (8) — the single canonical zoom range for EVERY zoom control (gestures, Canvas zoom buttons, context-menu zoom items; D6 fix).

## Local Contracts

### Store contract (`store.ts`)
- The store holds: `document` (CanvasDocument), `connected` (WebSocket status), `turns` (live streaming chat buffer), `selectedIds`, `agentHighlightIds` (transient agent-selected shape highlights), `viewerCount`, `activeSessionId`, `agentBusy`, `toolMode` ('select' | 'pan'), `undoStack`, `redoStack`, plus actions.
- **toolMode**: controls canvas interaction mode. `'select'` (default) = click-to-select shapes. `'pan'` = click-drag pans the canvas. Toggled by the Toolbar's Select/Pan buttons + V/H keyboard shortcuts. Space-held temporarily overrides to pan.
- **Undo/redo**: `undo()` and `redo()` pop/push the stacks (capped at 50). Wired to `⌘Z` / `⌘⇧Z` keyboard shortcuts in `page.tsx`. `sendPatch` pushes to `undoStack` for mutating ops (was previously only pushed when patches arrived over WS — now works for offline edits too).
- **Session management (shared canvas — Figma/Cursor model)**: sessions are conversation contexts attached to ONE shared document. `init()` loads the DOCUMENT's newest local snapshot (remote placeholders skipped). `switchSession(sessionId)` rebuilds ONLY the transcript (`_syncTurnsFromSession`) — it NEVER swaps `document`. `newSession()` creates a fresh chat that CONTINUES on the current shared canvas (no reset). `forkActiveSession(fromMessageId?)` is a conversation fork (message-prefix copy via `forkSession`; runs/toolCalls not copied; canvas untouched).
- **Restore action**: NEW `restoreSnapshot(snapshotId)` (async) — resolves the snapshot (remote placeholders fetch their `document` JSON on demand via `fetchDocumentSnapshot`; toast + return on failure), appends an append-only `'restore'` snapshot through the session store's `restoreSnapshot(documentId, id)`, swaps the live `document` (clearing `measuredBounds`/`checkpoints`), and broadcasts a `document:restore` ClientEvent over the socket so ALL viewers follow.
- **Agent control**: `stopAgent()` aborts the in-flight HTTP fetch (if any) and finalizes the turn as cancelled, triggering snapshot capture and run closeout. `steer(text)` sends an `agent:steer` event mid-run to redirect the agent without aborting.
- The store exposes a `window.__canvasStore` global in dev for debugging. Do not remove.
- **Settings injection**: `promptAgent` calls `agentRunSettings(useSettings.getState())` and injects the result into both the WebSocket emit path (`socket.emit('client', { type: 'agent:prompt', ..., settings })`) and the HTTP fallback path (`fetch('/api/agent', { body: { ..., settings } })`). This ensures the server-side runner respects user-configured temperature, maxIterations, planFirst, defaultPalette, skillSelectionMode, and LLM provider config.
- The store has an HTTP fallback: if the WebSocket connection fails, `promptAgent` falls back to `fetch('/api/agent')` and parses the chunked NDJSON response. Do not remove the fallback — it is the primary path in the sandbox. In the fallback path `_onSync` is the SINGLE patch applier (D5 fix: the former inline pre-apply double-applied every patch; the renderer's id-dedupe stays as defense-in-depth).
- **`canvas:full` empty-incoming guard**: `_onSync` skips a `canvas:full` replace when the incoming document is EMPTY (no `children` AND `shapes.length === 0`) while the local document is non-empty and the agent is idle — protects snapshot-hydrated canvas content from being clobbered by a restarted (empty) WS service.
- The store bridges into `useSessionStore`: `promptAgent` starts a Run + appends Messages; `_onSync` mirrors every event (deltas, tool calls, errors) into the session store; `turn_end` (and `stopAgent`) capture a DOCUMENT-scoped Snapshot with `sessionId` provenance (respecting the `snapshotCadence` setting + the per-document `maxSnapshotsPerCanvas` cap).
- **Snapshot cadence**: `turn_end` handler reads `useSettings.getState().snapshotCadence` ('every-turn' / 'every-3-turns' / 'every-5-turns' / 'manual'). 'manual' skips auto-capture; the user must use the History panel's "Capture current state" button. When the per-document `maxSnapshotsPerCanvas` cap is exceeded (counting the document's snapshots, remote placeholders excluded), the oldest non-bookmarked snapshots are auto-deleted.
- `_syncTurnsFromSession` rebuilds the live `turns` buffer from session-store messages when switching sessions. Tool calls are joined by `runId`.
- The store bridges into `useSessionStore`, which uses `skipHydration: true` + a manual `hydrateSessionStore()` call in `init()` to avoid SSR hydration mismatches.
- **forkActiveSession(fromMessageId)**: conversation fork — calls `forkSession(activeSessionId, fromMessageId ?? null)` (copies the parent's message prefix; runs/toolCalls NOT copied) and switches to the fork. No snapshot lookup, no canvas change — the fork shares the parent's document.
- **Client round-trips (M2-c, spec §5.2/§5.4)**: `_onSync` handles `agent:computed_request` (querySelector `[data-node-id]` → getComputedStyle + getBoundingClientRect, canvas-space rect divided out of the world transform, POST to `/api/agent/client-responses`) and `agent:screenshot_request` (dynamic `import('html-to-image')` → `toPng(worldElement, { pixelRatio, backgroundColor })`; no world element registered → POST `error: 'no-dom-renderer'`). `worldElement` is an EPHEMERAL store field registered by DomCanvas on mount (both layout modes), cleared on unmount. `pushMeasuredBounds()` emits the `canvas:measured_bounds` ClientEvent over the socket AND POSTs a copy so the server-side map (spec §3.8) stays fresh; DomCanvas throttles it (800ms trailing, native mode only).

### React subscription safety
- Zustand selectors MUST return stable references. Never write `useCanvasStore((s) => s.document.tokens ?? { colors: [], textStyles: [] })` — the `?? {}` creates a new object every render and triggers an infinite loop.
- Use a stable module-level fallback constant (e.g. `EMPTY_TOKENS`) for selectors returning arrays or objects — never inline `?? {}` / `?? []`.
- Same rule applies to any selector returning an array or object.

### Patch contract (`patch.ts`)
- `applyPatchToCanvas(document, patch)` is pure — it returns a new document, never mutates the input.
- Every shape access MUST be null-safe: `document.shapes.find((s) => s.id === id)?.x ?? 0`. The LLM can reference shape IDs that no longer exist (e.g. after a `pen_clear`); the patch layer MUST not crash.
- Numeric coercion: all numeric fields from the LLM MUST be passed through `Number()` before use. The patch layer is the last defense against `s.x.toFixed is not a function`.
- Patches are append-only in the session store; the patch layer itself is stateless.
- **.pen tree model**: `doc.children` (a .pen `PenChild[]` object tree) is the SOURCE OF TRUTH. `doc.shapes` is a DERIVED render cache recomputed via `resolvePenTree()` after every mutation. Patch ops mutate the tree; the applier then calls `recomputeDerived()`. Tree mutations are written back to the active page (see the D1 pages write-back note under Ownership above).
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
- `server.ts` is the in-process Socket.IO service. It runs on port 3003 and broadcasts canvas patches + agent events to connected viewers. (The old standalone `mini-services/canvas-sync` twin was deleted — it could never win the port race and silently dropped `agent:steer` / DB seeding.)
- It maintains per-document state in memory (`Map<documentId, DocState>`).
- On `subscribe`: when the map has NO entry for the documentId, it SEEDS the document from the DB before replying — dynamic `import('@/lib/db')` → `db.documentSnapshot.findFirst({ where: { documentId }, orderBy: { createdAt: 'desc' } })` → `JSON.parse(row.document)` (falls back to the current empty doc on any error) — then emits `canvas:full` with the seeded doc. The handler is async.
- NEW `document:restore` client-event case: `ensureDocument(event.documentId)`; set `state.document = event.document`; broadcast `canvas:full` (reason `restore`) to ALL subscribers of that document.
- On `prompt`: calls the agent runner and fans out events to all subscribers.
- Patches are applied via `applyPatchToCanvas` from `patch.ts`.
- The API route (`/api/agent`) uses the request's `canvasState` field directly — no DB lookup; server-side document seeding lives in `server.ts`'s subscribe handler.
- Client round-trips (M2-c): `canvas:measured_bounds` from a client refreshes the SERVER-side measured-bounds map (`setMeasuredBounds` from `agent/client-roundtrip.ts` — same process as the tools when running in-process). `canvas:computed_response` / `canvas:screenshot_response` socket copies are accepted but resolve via the HTTP route (`POST /api/agent/client-responses`) — the authoritative pending map lives in the Next.js process. Server→client round-trip REQUEST events (`agent:computed_request` / `agent:screenshot_request`) ride the EXISTING SyncEvent fan-out (NDJSON → driveAgent → `io.emit('sync')`) — no per-type wiring needed.

## Work Guidance

- When changing the `Shape` type: update `prisma/schema.prisma` (the `Shape` model), `types.ts`, `patch.ts` (default values), `tools.ts` (tool schemas), and `PropertiesPanel.tsx` (form fields). All five are coupled.
- When adding a new `SyncEvent` kind: add the type, add the `_onSync` case in `store.ts`, and add the API route forwarding case in `app/api/agent/route.ts`. (Exception: server→client round-trip REQUEST events need no route wiring — every SyncEvent passes through the NDJSON stream + fan-out unfiltered.)
- When debugging "the canvas didn't update": check `window.__canvasStore.getState()` in the browser console — the store is the source of truth, not the DOM.
- When debugging infinite re-renders: check all Zustand selectors for `?? {}` / `?? []` patterns. Replace with stable constants.

## Verification

- `bunx tsc --noEmit` — typecheck.
- Manual: open the app, run a prompt, verify shapes appear on the canvas and the layers panel updates.
- Reload the page — the document's newest local snapshot should restore the shared canvas (remote placeholders are skipped at boot).
- `window.__canvasStore.getState().document.shapes.length` should match the visible shape count.

## Child DOX Index

No child AGENTS.md files in this folder.

*Siblings: `../agent/AGENTS.md` (Agent layer), `../sessions/AGENTS.md` (Session persistence).*
