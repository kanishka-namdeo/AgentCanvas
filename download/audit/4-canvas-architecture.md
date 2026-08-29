# Audit 4 — Canvas Architecture, Functionality & Agent→Canvas Experience

**Repo:** /home/z/my-project (AgentCanvas @ 1bd21bb)
**Scope:** `src/lib/pen/*`, `src/lib/canvas/*`, `src/components/canvas/*` (incl. `dom/`), `src/lib/agent/client-roundtrip.ts`, `src/app/api/agent/route.ts` (patch leg), `docs/html-dom-renderer.md` + related specs, `tests/unit/{resolve,styleFor,patch}*`.
**Mode:** RESEARCH-ONLY. No source code modified.

---

## Architecture map (data flow)

```
USER PROMPT ──► store.promptAgent ──socket 'agent:prompt'──► canvas-sync server.ts driveAgent()
    │                                                            │  canvasDelta = changed node ids since last settled turn (R9a)
    │                                                            ▼
    │                                              POST /api/agent (NDJSON stream)
    │                                                            │
    │                                              runner-native.ts: tools emit patches
    │                                              (ctx.applyPatch → runner-local `canvas` closure
    │                                               = prompt-time snapshot + own patches)
    ▼                                                            ▼
route.ts: sanitizeAgentPatch(patch, liveCanvas)  ← liveCanvas ALSO = prompt-time snapshot + own patches
    │         (drop unknown op / missing target / duplicate id; clamp geometry)
    │         apply to liveCanvas; journal 'patch' row; NDJSON out
    ▼
canvas-sync driveAgent: patch-dedupe (toolCallId+FNV hash) → applyAndTrack()
    = trackPatchTombstones + applyPatchToCanvas(state.document)
      (normalizePatchPayload → pen/document.ts tree ops (path-copy, version++/nonce)
       → recomputeDerived → resolvePenTree) → 16ms-batched fanout
    ▼
Socket.IO 'sync' ──► every viewer's store._onSync
    ├─ canvas:patch → agent dedupe (toolCallId+hash, bounded 4096) → turn-diff record
    │                → rAF patch queue (Phase 4 §4.4; per-patch undo pre-states;
    │                   last-write-wins for LOCAL update ops per shapeId)
    │                → applyPatchToCanvas(local doc) → document.shapes (Layer[])
    ▼
DomCanvas (default layoutMode='parity': buildWorld(document.shapes) — absolute geometry
           from resolver; optional 'native': resolvePenTreeDetailed().tree → CSS flexbox
           + MeasuredBoundsPool → store.measuredBounds → resolver hints (§3.8 loop))
    ├─ DomNode (React.memo) × N — styleFor.ts → CSS; islands.tsx → inline SVG
    │  (path/star/polygon/icon/boolean/image); L4 content-visibility culling
    ├─ DomChrome — screen-space selection/8 resize handles/badges/measure overlay
    └─ world div: translate+scale transform (L1), --acv-* CSS vars (§3.6)

USER EDITS: UI → store.sendPatch → stamp clientId/clientMutationId → socket emit
    (or localStorage outbox while offline) → server user-patch-journal.ts
    (Replicache exactly-once MutationClock) → applyAndTrack + broadcast.
RECONNECT: canvas:full → reconcileDocuments (per-element version+nonce, tombstones)
    → outbox flush → journal-catchup.ts (identity-idempotent replay of missed turns).
UNDO/REDO: client-local ONLY — swaps document from undoStack (50 full-doc snapshots);
    op:'undo' patches are no-ops in the applier, interpreted per-client by the store.
```

**Positive summary:** the sync/durability layer (exactly-once user mutations, tombstones, journal-fold hydration, identity-idempotent reconnect replay, presence lane, server-side steer/abort, 16 ms wire batching, per-turn checkpoints, delta LLM context) is genuinely strong — several patterns (Replicache clocks, Excalidraw reconcile, Figma fresh-copy+reapply) are correctly ported. The audit findings below concentrate on the two weakest seams: **the resolver-predicted rendering path that is the default**, and **the local-only undo / agent-vs-user concurrent-state split**.

---

## Findings

### C1 — Parity mode is the default, so the resolver's heuristics (not the browser) define visual fidelity
- **Category:** RETHINK
- **Severity:** Critical
- **Evidence:** `src/components/canvas/Canvas.tsx:119` (`useSettings((s) => s.canvasLayoutMode) ?? 'parity'`), `src/lib/settings/types.ts:189-197` (default `'parity'`), `src/lib/pen/resolve.ts:378-390` (text-size estimate 0.62×fontSize), `resolve.ts:483-500` (100×100 `fit_content` placeholder), `src/components/canvas/dom/DomCanvas.tsx:275-283` (MeasuredBoundsPool only constructed `layoutMode === 'native'`), `docs/html-dom-renderer.md` Phase 2.
- **Finding:** The DOM renderer's headline capability — real CSS flexbox layout with measured-bounds readback (spec §3.4/§3.8) — is off by default. In parity mode every node is absolutely positioned from resolver-predicted geometry: text is sized by a glyph-advance heuristic that ignores *wrapping* (`estimateTextSize` counts only explicit `\n` lines — a fixed-width wrapped paragraph gets a one-line height), empty `fit_content` frames fall back to a 100×100 placeholder, and `measuredBounds` stays `{}` because the ResizeObserver pool only exists in native mode. Every downstream consumer of wrong geometry inherits the error: fit_content container heights, `container_overflow` warnings, L4 `contain-intrinsic-size`, export bounding boxes. The VLM exercise fixes (resolve.ts "VLM-exercise Fix 2/3") are patches on this heuristic path — the native path makes most of them unnecessary.
- **Recommendation:** Flip the default to `'native'` (keep parity as the debugging fallback; the settings migration already handles absent fields). Measure in parity mode too (the pool costs nothing) so `pen_get_computed`/snapshot enrichment and the resolver hints work everywhere. Gate the flip on the existing bench harness (`scripts/dom-renderer-bench`, nightly CI) + a parity-diff corpus.

### C2 — Undo/redo is client-local only: not durable, not multiplayer, not consistent for agent undo
- **Category:** RETHINK
- **Severity:** Critical
- **Evidence:** `src/lib/canvas/store.ts:1966-2020` (`undo()`/`redo()` swap local `document`; **no socket emit, no inverse patch**); `src/lib/canvas/patch.ts:662-666` (`case 'undo'/'redo'` — no-op, "Handled by the store"); `src/app/page.tsx:416-423` (⌘Z blocked while agent streams); `src/lib/agent/tools.ts:3441` (agent `undo` tool emits `op:'undo'`); `src/lib/canvas/server.ts` `applyAndTrack` (server doc never reverts); `src/lib/canvas/reconcile.ts:49-65` (higher version wins ⇒ server copy beats the undone local pre-state on reconnect).
- **Finding:** Undo pops a full-document snapshot from a local stack. The server document, the journal, the turn-end checkpoints, and every other viewer keep the undone state — so undo is silently reverted by reload/reconnect/reconcile, and a viewer who joins late executes the agent's broadcast `op:'undo'` against an empty stack (no-op ⇒ viewers diverge). This is the single biggest correctness hole in an otherwise carefully-built append-only pipeline: the one mutation type that bypasses the journal.
- **Recommendation:** Make undo a first-class journaled mutation: emit an *inverse patch* (or a `document:restore`-style snapshot event, which already has a journaled path — `journalDocumentRestore`) through `sendPatch`, so the server folds it, broadcasts it, and it survives restarts. Cap cost by keeping inverse patches per-op (the applier already knows each op's pre-state at queue-flush time — `store.ts:759-788` captures `preStates` and throws them away for redo).

### C3 — Concurrent user edits during an agent run are invisible to the agent and to the sanitizer
- **Category:** UPDATE
- **Severity:** High
- **Evidence:** `src/app/api/agent/route.ts:280` (`let liveCanvas = canvas` — the request-body snapshot), `route.ts:382-396` (sanitize + apply against `liveCanvas` only); `src/lib/agent/runner-native.ts:207-208` (`ctx.applyPatch` mutates the runner's own `canvas` closure); `src/lib/canvas/server.ts` `canvas:patch` case (user patches mutate `state.document` only).
- **Finding:** During a run there are **three** server-side document copies: the runner's closure canvas, the route's `liveCanvas`, and canvas-sync's `state.document` (plus each client's local copy). User edits land only in the last two. Consequences: (a) the sanitizer drops legitimate agent patches targeting nodes the user just added ("target not on canvas"), (b) agent reads (`pen_get_metadata`, canvasSnapshot) describe a stale world, (c) same-node conflicts resolve as silent last-write-wins with no warning to either party. Mid-run steering exists (text-level `session.steer`, server.ts `agent:steer`) but there is no canvas-level change feed into the loop.
- **Recommendation:** Single-source the server document: have the route subscribe to canvas-sync's applied-patch stream (or move sanitization into `applyAndTrack` against `state.document`) so `liveCanvas` and the runner's canvas receive journaled user patches as they land. At minimum, emit an `agent:external_change` event into the runner so the model learns "user moved node X" before its next tool batch.

### C4 — Boolean operations, masks, blend modes, background blur are schema-declared but not rendered
- **Category:** UPDATE
- **Severity:** High
- **Evidence:** `src/components/canvas/dom/islands.tsx:213-240` (`booleanContent` = dashed rect + op symbol; "True boolean geometry needs a polygon-clipping lib"); `src/lib/pen/resolve.ts:257-285` (`resolveEffects` collapses to ONE shadow + ONE blur; `background_blur` folded into layer blur); `src/components/canvas/dom/styleFor.ts:406-408` (`filter: blur()` — no `backdrop-filter`); grep confirms **no** `mixBlendMode`/`maskId` rendering anywhere in `src/components/canvas/`; `src/lib/pen/types.ts:322-336` (effects union), `types.ts:383` (`maskId`), `types.ts:233-237` (blend modes).
- **Finding:** The .pen schema (and the Figma v3 mirrors) promise DROP_SHADOW/INNER_SHADOW/LAYER_BLUR/BACKGROUND_BLUR, blend modes, and masks; the renderer delivers one shadow, one *layer* blur (wrong semantics for background blur — Figma's signature glass effect renders as the node blurring itself), zero blend modes, zero masks. Extra effects are silently dropped (resolver does emit an `effects_dropped` warning — good). Agent designs that stack two shadows or use `background_blur` render wrong with only a chat-side warning.
- **Recommendation:** styleFor is pure CSS work: `backdrop-filter: blur()` for `background_blur`, `mix-blend-mode` mapping (enum already Figma-aligned), comma-joined multi-shadow, CSS `mask-image` for the `maskId` lane. Real boolean geometry can stay deferred, but then say so in the tool descriptions so the agent stops generating `boolean_operation` nodes expecting Figma output.

### C5 — Rotation is rendered with a different origin AND sign convention on canvas vs export
- **Category:** UPDATE
- **Severity:** High
- **Evidence:** `.pen` spec comment `src/lib/pen/types.ts:371-372` ("Degrees CCW around top-left corner"); DOM: `src/components/canvas/dom/styleFor.ts:427-430` (`transform: rotate(${layer.rotation}deg)`, `transformOrigin: '0 0'` — CSS rotate is *clockwise*); export: `src/lib/canvas/export.ts:138-142` (`transform="rotate(${s.rotation} ${cx} ${cy})"` — *center* origin); server render: `render-to-png.ts` (same center-origin family). Also no rotation control exists in the Properties panel (`rg rotation PropertiesPanel.tsx` → 0 hits) — only the agent can set it.
- **Finding:** A rotated layer renders differently on canvas (clockwise, top-left origin) than in exported SVG/PNG (clockwise, center origin), and both differ from the documented CCW convention. Any design that uses rotation — badges, skewed heroes, rotated CTAs — silently changes shape between screen and export. Line nodes compose their own pill angle with rotation (styleFor.ts:417-426) making the divergence worse.
- **Recommendation:** Pick one convention (Figma: clockwise around top-left is fine), negate on input if the spec is honored, and share a single `rotationTransform(layer)` helper between styleFor/export/render-to-png + a cross-renderer golden test (the parity-harness precedent exists).

### C6 — flipX/flipY are user-settable but never rendered
- **Category:** UPDATE
- **Severity:** Medium
- **Evidence:** Schema `src/lib/pen/types.ts:366-367`; UI writers `src/components/canvas/PropertiesPanel.tsx:155-163, 386-391` (Flip H/V buttons) and `AppMenu.tsx:114-123`; **zero** readers — no `flipX` in `resolve.ts`, `styleFor.ts`, `islands.tsx`, `export.ts`, `render-to-png.ts`.
- **Finding:** The Properties panel has working-looking Flip buttons that write a flag with no visual effect. (AppMenu's comment even documents a prior "flip twice did nothing" fix — the *toggle* semantics were fixed, the render never existed.)
- **Recommendation:** Trivial fix: compose `scaleX(-1)/scaleY(-1)` into styleFor's transform (origin center for Figma parity) and mirror it in export. Or remove the buttons until supported.

### C7 — Clipboard copy/paste round-trips the resolved projection, not the model
- **Category:** UPDATE
- **Severity:** Medium
- **Evidence:** `src/hooks/use-clipboard.ts:86-108` (copy serializes `document.shapes` Layers; paste → `bulk_add` of offset Layers); `src/lib/canvas/clipboard.ts:38-60`; loss sites: `resolve.ts` emit (~line 1170: `autoLayout.padding` keeps only scalar padding — tuples collapse to 0), refs arrive pre-expanded (instances detach), `fit_content` sizes arrive baked to fixed numbers, `textGrowth` lost, resolved `theme` merged/baked. Contrast: `duplicate` op clones the .pen tree properly (`patch.ts:271-318`, `deepCloneNode`).
- **Finding:** Copy/paste loses per-side padding, detaches component instances, bakes hug/fill sizing to pixels, and depends on parent-first array order for re-nesting (works today only because emit is depth-first). Paste-into-frame also lands at root with absolute coords.
- **Recommendation:** Copy the selected .pen subtrees (`findNodeArray` + `deepCloneNode`), serialize `{kind:'pen-subtree'}`, paste through a new `paste_subtree` op (or reuse `add_subtree`) with offset applied in parent-relative space. Keep the legacy payload readable for one release.

### C8 — Dead/placeholder node types and LayerType branches (schema bloat)
- **Category:** REMOVE
- **Severity:** Medium
- **Evidence:** `script` maps to `'frame'` and never executes (`resolve.ts` mapNodeType ~1446; no `scriptUri` executor anywhere); `note`/`context`/`prompt` map to plain `text` with no differentiated rendering and are created by no tool (grep: 0 creators); `boolean_operation` renders a placeholder (C4); `'instance'` LayerType is **never produced** (mapNodeType has no instance case — refs expand to component clones carrying `componentId`), yet `styleFor.ts:350-357`, `LayersPanel` TYPE_ICON.instance, and `CULLABLE_CONTAINER_TYPES` all branch on it; `exportSettings` (incl. `pdf`) is carried through the model but consumed by no export path (grep: 0 uses in `export.ts`/`PenFileMenu.tsx`/`/api/pen/export`); `slice` nodes render but nothing honors their export settings either.
- **Finding:** Of the 20 .pen node types, ~6 are cargo (`script`, `note`, `context`, `prompt`, `slice`'s settings, `boolean_operation`'s geometry). The agent-facing ontology (docs + tools) advertises Figma parity the renderer does not deliver; the variant-generator's own `KNOWN_TYPES` (`subagents/variant-generator.ts:955`) is the honest list: frame/rectangle/ellipse/text/line/group/icon.
- **Recommendation:** Either implement or demote: mark the unrendered types clearly in the tool-schema descriptions (the agent currently believes it can create booleans/slices that "work"), delete the `instance` LayerType branches, and gate `exportSettings` behind real wiring or remove the field. Keep the .pen *file-format* types (import tolerance) but stop mirroring them into the resolved Layer model.

### C9 — Dual-carry v2.17+v3.0 schema has no sunset; every write pays the dual-projection tax
- **Category:** UPDATE
- **Severity:** Medium
- **Evidence:** `src/lib/pen/types.ts:18-34, 190-204, 313-352, 387-397` (every legacy field carries a v3 mirror); `src/lib/pen/resolve.ts:1390-1520` (`applyV3Mirrors` — ~130 lines emitting the second projection per node, in the hot path); `src/lib/pen/normalize.ts:234-365` (`normalizePenNode` recursion on every insert); `src/lib/pen/migrate.ts` (deterministic dual-carry migration, well-tested); `docs/html-dom-renderer.md` §9.3 ("during the Phase 6 dual-field window" — no end date).
- **Finding:** The migration machinery itself is high quality (idempotent, deterministic, total). But the "window" is now the steady state: `Layer` carries ~70 fields, roughly half of them mirrors nobody reads except tests; every emit computes both; every patch payload passes through `normalizePenNode`; and `KNOWN_OPS` in the sanitizer is a hand-maintained duplicate of the op union (`patch-sanitizer.ts:39-51` — "Keep in sync" comment).
- **Recommendation:** Declare part 2 of Phase 6 (read the canonical fields in resolver/styleFor/panels, write both during one release, then stop emitting mirrors). Generate `KNOWN_OPS` from the `CanvasPatch` type (a `satisfies` const) instead of a hand list.

### C10 — L4/L5 culling barely engages on agent-shaped documents
- **Category:** UPDATE
- **Severity:** Medium
- **Evidence:** `src/components/canvas/dom/styleFor.ts:499-510` + `DomNode.tsx:138-146`: culling is skipped for any non-clip container whose children overflow — the exact condition the resolver's own `container_overflow` warning says is endemic in agent output; L5 mounts/unmounts **top-level roots only** (`DomCanvas.tsx:461-482`, `CullingCoordinator.rootLayerRects`) — a single giant screen-frame (the common agent pattern) gets zero L5 benefit regardless of the 2,000-node budget; `CullingCoordinator.ts:79-83` (budget 2000, margins 2×/3×, hysteresis — the math itself is clean and well-tested).
- **Finding:** The ≥2k-node claim is backed by a real harness (`scripts/dom-renderer-bench` + nightly CI gate, `docs/html-dom-renderer.md` Appendix F), but the design concedes the two shapes agent output actually takes: overflowing non-clip frames (L4 off) and one huge root frame (L5 off). The bench corpus likely uses multi-frame synthetic docs that avoid both.
- **Recommendation:** (a) When children overflow, still emit `content-visibility:auto` but drop only `contain: paint` (keep layout+style containment, or clip with a warning); (b) extend L5 candidates to any *direct child frame of a root* below a size threshold; (c) add an "agent-built single-frame 5k nodes" corpus to the bench.

### C11 — Text editing is `window.prompt`; no inline canvas editor, no rotation/per-corner UI
- **Category:** UPDATE
- **Severity:** Medium (High for editor credibility vs Figma/Excalidraw)
- **Evidence:** `src/components/canvas/Canvas.tsx:354-377` (Enter on text → `window.prompt('Edit text:')`; "the DOM renderer has no in-place text content editor"); Properties panel = the long-form editor (textarea); `PropertiesPanel.tsx:833-836` (uniform radius slider only; no rotation, no per-corner radii, no `textAlignVertical`); no double-click-to-edit handler anywhere (`rg onDoubleClick` → 0).
- **Finding:** For a "Figma for AI agents" the human-editing loop is the weakest surface: native prompt dialogs, panel-only typography, no on-canvas rotation handle (8 resize handles only — `DomChrome.tsx:46`), no vector/path editing, no pen tool. Multiplayer text editing is impossible by construction (prompt is modal-local).
- **Recommendation:** Overlay a `contentEditable` div at the node's screen rect on double-click/Enter (the DomChrome overlay already solves screen-space math), committing `content` + `textGrowth` patches on blur. Add rotation handle + per-corner radius inputs to the existing panels. This is the highest-leverage *editor* (not agent) work available.

### C12 — Snapping is pixel-rounding only; guides exist but nothing snaps to them
- **Category:** UPDATE
- **Severity:** Medium
- **Evidence:** `src/components/canvas/Canvas.tsx:586,639,689` (`if (snapToPixel)` round) — no object-snap/guide-snap math in the drag path; guides: `store.ts:281-301`, `Rulers.tsx` drag-out, `Guides.tsx` render + right-click delete, localStorage persistence — read by nothing during drags; `measure-overlay.ts` provides gap math (Alt-hover) that could be reused for snap candidates.
- **Finding:** Figma/Excalidraw both ship alignment-snap (red guides + 4px magnetic snapping to siblings/frames/guides). AgentCanvas has the ruler/guide/measure infrastructure but the drag handler only rounds to integers. Agent-canvas users doing manual tidying have no assistance.
- **Recommendation:** Reuse `computeMeasureOverlay`'s sibling-gap geometry as a snap-candidate generator (8px threshold, snap lines drawn in DomChrome); snap to `guideLines` at the same time. Small, self-contained, high felt-quality.

### C13 — Client SVG export is lossy well beyond what's documented
- **Category:** UPDATE
- **Severity:** Medium
- **Evidence:** `src/lib/canvas/export.ts:194` (text: `font-size` + `fill` only — no fontWeight/letterSpacing/lineHeight/textAlign, hardcoded `Inter`, no `<tspan>` per line so `\n` collapses); `export.ts:201-210` (image `<image>` default `preserveAspectRatio` = meet vs DOM's `objectFit: cover` — `islands.tsx:196-210`); rotation origin divergence (C5); PNG path is good — DOM capture via html-to-image with SVG-projection fallback (`export.ts:268+`), and `render-to-png.ts` honors typography + measured bounds server-side.
- **Finding:** `pen_export_svg` / Export-as-SVG output diverges from the canvas in typography, multi-line text, images, and rotation. Since the agent *and* the VLM critic can consume these exports, the loss feeds back into design decisions (the repo already recorded this class of bug once: "Task 8-c" shadow-dropping critiques).
- **Recommendation:** Route SVG export through the same serializer family as `render-to-png.ts` (which already does typography/shadows correctly) or generate SVG from the live DOM (a `document:export` round-trip sibling of the screenshot request). One painter, three outputs.

### C14 — Resolver layout engine: documented limits vs CSS, plus one dead parameter
- **Category:** UPDATE
- **Severity:** Medium
- **Evidence:** No wrap / baseline / per-child align-self / grow-shrink anywhere in `resolve.ts layoutChildren` (574-668) or `PenLayout` (`types.ts:174-204`); `resolveValue` resolves `$var` one level — a variable whose value is another `$var` leaks the literal (`resolve.ts:178-191`, comment even claims "resolve nested $refs one level" but the code returns verbatim); `computeIntrinsicSize`'s `parentContentW/H` args are effectively always 0 (children are resolved — `resolve()` — *before* the parent's width is set at `resolve.ts` ~890-910; the real fill-sizing happens in the parent's Phase B loop) — misleading dead inputs; `collectComponents()` walks the full tree on *every* resolve (`resolve.ts:777`); positive: the R9c identity-preserving expansion/emit caches (`resolve.ts:700-760`, WeakMap + subtree/theme/vars stamps, 3 slots) are a genuinely good tldraw-style design with tests (`tests/unit/resolve-cache.test.ts`, 220 lines).
- **Finding:** The hand-rolled flexbox covers direction/gap/padding/justify/align/hug/fill/absolute/constraints and two-phase fill sizing — adequate for the agent's vocabulary, and its degradations now emit agent-visible `ResolverWarning`s (excellent). But every divergence from CSS costs the default parity mode doubly (C1), and the two latent bugs above are cheap wins.
- **Recommendation:** Fix the nested-`$var` resolution and delete/repurpose the dead `parentContentW/H` params; memoize `collectComponents` on the children-array identity (same path-copy discipline the caches rely on). Longer term, shrink the custom engine rather than growing it — each new feature should land in CSS (native mode) first.

### C15 — Fonts: single webfont, silent fallback, server/client divergence
- **Category:** UPDATE
- **Severity:** Medium
- **Evidence:** `styleFor.ts:449-451` (`${layer.fontFamily}, var(--font-inter), system-ui`); no font-loading infra (only Inter via the shell); `render-to-png.ts:54-65` (resvg with DejaVu/Noto, documented divergence, spec §4.6); design-system packs ship tokens.css colors only.
- **Finding:** When the agent (or a pack) specifies Roboto/Geist/etc., the canvas silently renders Inter while the export rasterizes DejaVu — three fonts for one declaration. Typography is ~50% of perceived design fidelity; this is a real ceiling on "design output fidelity".
- **Recommendation:** Add `next/font` registrations for the pack font stacks (or a small self-hosted set), make `pen_get_computed`/critique report the *effective* font (it already reads computed styles), and pass matching font files to resvg (`fontFiles` already accepts them).

### C16 — Checkpoint/version-history: two parallel systems, ephemeral client one skips no-op-detecting turns
- **Category:** UPDATE
- **Severity:** Low-Medium
- **Evidence:** `src/lib/canvas/version-history.ts:40-42` (`checkpointSignature` = children count + shapes count + variables length — a color-only turn yields an identical signature ⇒ no checkpoint despite "auto-captured at each agent turn end", `store.ts:2789-2792`); checkpoints are EPHEMERAL client state (store doc comment, `store.ts:332-356`) while server `DocumentSnapshot`s + session snapshots are the durable lane (`restoreSnapshot`, `document:restore` journaled path) — two UIs (VersionHistoryDialog vs RunHistory/History panel) over two stores.
- **Recommendation:** Include a cheap content stamp (e.g. the R9c subtree hash of the root children, already computed) in `checkpointSignature`; consolidate the two history surfaces or clearly scope them (client = fast undo-like jumps, server = durable restore).

### C17 — Minor pipeline sharp edges
- **Category:** UPDATE
- **Severity:** Low
- **Evidence & notes (bundled):**
  - `insertNode` silently drops a node whose `parentId` doesn't exist (`pen/document.ts: insertNode` maps and never inserts); the sanitizer validates target ids for update/remove but **not** `parentId` for add/bulk_add — an agent typo loses the node with only a server console line. Add a sanitizer check + a resolver warning.
  - Undo stack memory: 50 × full document snapshots (`store.ts:230-233`) plus 50 checkpoints — fine at demo scale, heavy at 5k nodes; structural sharing or per-op inverse records (C2) fixes both.
  - `dedupeLocalUpdates` last-write-wins is drag-only and well-tested (`store.ts:813-847`, `patch-coalesce-drag.test.ts`) — correct choice; keep.
  - The patch-op surface is huge (50 ops in `patch-sanitizer.ts` KNOWN_OPS) vs the ~7 node types agents actually use — candidate for the tool-vocabulary consolidation recommended in audit 1.
  - Positive: sanitizer, dedupe, sanitizer tests (`patch-sanitizer.test.ts`, `patch-dedupe.test.ts`), journal catch-up (`journal-catchup.test.ts` + bridge), reconcile, and coalescing all have real unit coverage; the overall test posture of this layer is the strongest in the repo (1462 passing per spec header).

### C18 — Agent→canvas experience: strong streaming spine, thin on-canvas affordances
- **Category:** UPDATE
- **Severity:** Medium
- **Evidence (what exists):** live patch streaming (rAF-coalesced client applies + 16 ms server wire batching, `server.ts` fanout + `store.ts` enqueuePatch); turn-diff cards (`patchToOpRecord` → "+12 −3 ~5", `agent-chat-trust/02-diff-card.png`); per-turn auto-checkpoints + never-destructive restore; turn-end "reveal" zoom only when content landed off-screen (`store.ts:2771-2781`, `viewport.ts contentOutsideViewport`); transient selection highlight 1.5 s (`agentHighlightIds`) + `aria-busy` per node; queue-while-busy, edit-and-resend, Stop (server-aborted), steer (real `session.steer`), approval gate for destructive ops, VLM critique loop on rendered output.
- **Finding (gaps):** (a) `agentHighlightIds` only fire when the agent *explicitly calls* the select tool — patches themselves don't pulse the nodes they touched, so mid-turn the user sees geometry morph with no pointer to *what* is changing; (b) no "follow agent work" camera option (reveal is end-of-turn only); (c) diff visualization is numbers in chat — no canvas-level before/after ghost overlay even though pre-states are captured per patch; (d) research round (worklog 2-e, Figma-agent pattern) recommends per-change undo affordances on canvas — per-patch undo entries exist but are blocked while streaming and invisible as a UI affordance.
- **Recommendation:** Derive a transient "recently-touched-by-agent" set from `canvas:patch` events (they already carry `toolCallId`), pulse those nodes in DomChrome for ~600 ms; add a "Follow agent changes" camera toggle (viewport lerp to each patch bbox, off by default); render the last turn's diff as a tinted overlay toggle fed by the existing `patchOps` records. All three are additive to existing event streams.

---

## Functionality gap table (vs Figma / Excalidraw)

| Capability | Figma | Excalidraw | AgentCanvas | Note |
|---|---|---|---|---|
| Infinite canvas, pan/zoom | ✅ | ✅ | ✅ | compositor-transform world (L1) |
| Auto-layout | ✅ full | ❌ | ◐ | custom engine + optional CSS mode; no wrap/baseline |
| Text editing on canvas | ✅ | ✅ | ❌ | window.prompt / panel textarea (C11) |
| Text wrapping / hug | ✅ | ✅ | ◐ | real only in non-default native mode (C1) |
| Components/instances/variants | ✅ | ❌ | ◐ | ops complete incl. SLOT; instances detach on copy (C7) |
| Boolean ops | ✅ | ❌ | ❌ | placeholder glyph only (C4) |
| Masks / blend modes | ✅ | ◐ blend | ❌ | carried in schema, unrendered (C4) |
| Constraints | ✅ | ❌ | ◐ | applied in layout:'none' only (Figma-correct), no viz |
| Guides + snapping | ✅ | ✅ | ◐ | guides yes; snap = pixel-round only (C12) |
| Rulers / measure / outline mode | ✅ | ◐ | ✅ | Alt-measure, ⌘⇧O, rulers — above par |
| Multiplayer | ✅ | ✅ | ◐ | presence+reconcile strong; undo not synced (C2) |
| Offline queue | ✐ | ❌ | ✅ | outbox + exactly-once clocks — above par |
| Export PNG | ✅ | ✅ | ✅ | DOM-capture primary path |
| Export SVG / PDF | ✅ | ✅/◐ | ◐ / ❌ | SVG lossy (C13); PDF in schema only (C8) |
| Vector/path editing | ✅ | ◐ | ❌ | M/L-only import; curves dropped w/ warning |
| Version history | ✅ | ◐ | ◐ | dual systems (C16) |
| Accessibility | ◐ | ❌ | ✅ | tab order, aria-busy, focus rings — above par |

---

## Top 10 prioritized changes
*(ranked by impact on design-output fidelity + agent interaction experience)*

1. **Flip the default layout mode to `native`** (C1) — real CSS layout + measured-bounds readback eliminates the heuristic text sizing, 100×100 placeholders, and wrong container heights that are the root cause of most "AI layout looks broken" symptoms; every other fidelity fix compounds on it.
2. **Make undo a journaled, broadcast mutation** (C2) — inverse patches or snapshot-restore events through the existing exactly-once pipeline; restores user trust in agent edits (today a reload silently redoes undone work) and makes agent-undo consistent across viewers.
3. **Feed concurrent user edits into the agent's world** (C3) — subscribe `liveCanvas`/runner canvas to the journaled user-patch stream; kills stale-target sanitizer drops and silent last-write-wins conflicts mid-run.
4. **Close the styleFor fidelity gaps** (C4/C5/C6) — `backdrop-filter` for background blur, blend modes, multi-shadow, image scale modes, unified rotation convention, flip transforms. Pure CSS, days of work, directly visible in every agent render.
5. **Inline canvas text editing** (C11) — contentEditable overlay + double-click; the single biggest editor-credibility gap vs Figma/Excalidraw.
6. **On-canvas agent affordances** (C18) — patch-touched node pulse, optional follow-camera, canvas diff overlay from existing `patchOps` records; makes 30-second agent turns legible instead of a morphing canvas.
7. **Make culling engage on real agent documents** (C10) — paint-containment relaxation for overflowing frames, L5 below root level, agent-shaped bench corpus; protects the 5k-node claim where it matters.
8. **Model-level clipboard** (C7) — copy/paste .pen subtrees (duplicate-op semantics) so instances, padding tuples, hug/fill sizing survive user copy operations.
9. **One painter, three outputs** (C13) — unify SVG/PNG/DOM-capture export typography + rotation + images via the render-to-png serializer or DOM round-trip; export is both a user feature and VLM-critic ground truth.
10. **Sunset the dual-carry window + prune dead ontology** (C8/C9) — read v3 fields directly, stop emitting mirrors, remove/flag `script`/`note`/`context`/`prompt`/`instance`/`exportSettings`, fix nested `$var` resolution (C14); shrinks the hot path and stops advertising capabilities the renderer doesn't have.

---

*Report written by the Explore audit agent (Task 2-d). Companion reports: `1-prompts-runner.md` (agent loop/prompts), `5-online-research.md` (external best practices).*
