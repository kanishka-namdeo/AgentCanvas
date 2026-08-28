# Canvas & Agent Durability Research — Round 2

**Lessons from tldraw, Excalidraw, Figma, Linear, Replicache, OpenHands & LibreChat**

**Date:** 2026-08-28
**Method:** 5 parallel agents — (1) full audit of AgentCanvas's canvas data pipeline (the user-edit path, relay, persistence, catch-up — the agent LLM internals were round 1), plus deep-dives into (2) tldraw @ `cbbcf35` (sparse clone, sync-core 5.3.2 + tldraw.dev docs), (3) Excalidraw @ `e1bb9ff` (sparse clone) + Figma engineering posts (2019/2018/2022 via mirror), (4) Linear's sync engine (Aug-2026 delta-sync post + CTO-endorsed reverse-engineering study, code-verified) + Replicache spec (doc.replicache.dev), (5) OpenHands @ `main` (verified clone) + LibreChat (targeted raw fetches).
**Relation to round 1:** `download/agent-durability-research.md` covered agent behaviour (bolt.diy, v0, AI SDK, Lovable, make-real, OpenHands-sdk). Its D1–D4/C1/C4 items shipped in commits `a05ce28` + `6403a15`. This round adds the **canvas/multiplayer/sync dimension** those commits did not touch.

**Goal:** make AgentCanvas's agent behaviour **and canvas** more **durable** (survives failures), **consistent** (converges, no silent loss/clobber), and **efficient** (wire, storage, render, tokens).

---

## 1. Executive summary — top 10 recommendations (impact-ordered)

| # | Recommendation | Learned from | Effort |
|---|---|---|---|
| 1 | **Complete the journal into a true replication log** — journal user canvas patches *and* user messages with `{clientId, clientMutationId}`; server assigns seq; exactly-once via a Replicache-style `lastMutationID` | Figma journal-all + OpenHands events-are-the-transcript + Replicache push/pull | M |
| 2 | **Per-element version + nonce reconcile** — port Excalidraw's `reconcileElements` (~60 lines): remote-wins default, local wins if newer / lower-nonce / in-progress | Excalidraw + Figma property-LWW + tldraw rebase | S-M |
| 3 | **Unbounded multi-turn catch-up + `turn.final` content events** — replay the whole gap window (not just first closure); journal each turn's final assistant text so missed turns reconstruct *with content* | OpenHands + Linear `fetchDelta` + LibreChat `sync` | M |
| 4 | **Offline outbox + Figma reconnect contract** — queue user patches while disconnected; on reconnect hydrate server state first, then re-apply queued ops, then reconcile | Figma "fresh copy + reapply" + Linear `__transactions` + tldraw speculative | M |
| 5 | **REST-first hydration on mount + agent status endpoint** — fetch journal tail page *then* attach socket (watermark becomes an optimization, not the correctness path); `GET …/agent/status` | OpenHands `use-conversation-history` + LibreChat `useResumeOnLoad` | S-M |
| 6 | **Server-owned canvas state: journal fold + snapshot-with-seq + tail compaction** — server folds events into Document state; snapshots become server-written checkpoints tagged `lastSeq`; journal prunable below checkpoint | Figma checkpoints (30-60s + DynamoDB journal) + Replicache Reset + tldraw tombstone cap | L |
| 7 | **Presence lane** — roster + volatile throttled cursors/selection/idle on existing rooms; never journaled | Excalidraw 33ms volatile + tldraw PresenceStore + Linear collab-never-retried | S |
| 8 | **Streaming persist throttle** — today every token delta serializes the *entire* sessions store to localStorage; throttle + partialize | Excalidraw 300ms debounce + tldraw history squashing | S |
| 9 | **Sync-service plumbing debts** — documentId on the wire (kill subscriber-scan routing), unify the two drifting canvas-sync twins, make steer real or remove it | our audit | S |
| 10 | **Delta LLM context via change watermark** — prompt carries only nodes changed since the last turn + compact digest, not the full canvas | tldraw `getChangesSince` + Linear late-enrichment (round-1 E1 confirmed) | M |

---

## 2. Where AgentCanvas stands today (round-2 audit)

The agent path is now solid (journal, boot recovery, idempotency, catch-up — Tasks 4-5). The round-2 audit found the residual risk concentrated in the **user-edit path**, which touches durable storage almost nowhere:

```
USER EDIT:   local mutation → socket 'canvas:patch' → in-memory relay doc → broadcast
             ✗ no journal row ✗ no DB write — durable ONLY when a client later
             POSTs a whole-document snapshot at a turn boundary (fire-and-forget)
AGENT PATCH: /api/agent route → sanitize → journal ('patch', toolCallId) → NDJSON +
             relay fanout (16ms batches) → client dedupe (toolCallId+hash)
CATCH-UP:    socket reconnect → GET events?afterSeq=watermark → replay agent:* rows
             (patches skipped by design; stop at FIRST terminal; only works when the
             client holds an OPEN last turn)
```

**Gap list (evidence in audit report, worklog 6-a):**

1. **User edits have zero server-side persistence at edit time** — `canvas:patch` mutates only the in-memory relay doc (`server.ts:131-141`); a tab crash before the next snapshot POST loses edits from every durable surface.
2. **Offline edits are silently clobbered** — `sendPatch` applies locally without emitting when disconnected (`store.ts:1222-1234`); on reconnect `canvas:full` *unconditionally replaces* a non-empty local document (`store.ts:1838`, empty-incoming guard only). No outbox exists.
3. **Server restart rolls clients back** to the last `DocumentSnapshot` (cold-start re-seed, `server.ts:72-86`) — unsnapshotted user AND agent edits are lost to every reconnecting client.
4. **Two drifting canvas-sync implementations** — the standalone twin has no DB seed and silently drops `agent:steer` (`mini-services/canvas-sync/index.ts:162-168`); whichever wins the EADDRINUSE race on :3003 silently selects semantics.
5. **Patch routing carries no documentId** and resolves by first-match subscriber scan (`server.ts:131-139`) — misroutes multi-doc sockets; blocks scale-out.
6. **Undo/redo is local-only** — wire-level `undo`/`redo` handlers exist but nothing ever emits them (`store.ts:1846-1853` dead surface).
7. **Presence is viewerCount-only** — no cursors/selection/awareness; selection reaches only the agent, per-prompt.
8. **Session/run/message persistence is client fire-and-forget** — no server-side writer during a run; zombie sweep is client-side 10-min; a run whose originating client never returns stays `in_progress` server-side indefinitely (observed live in Task 5).
9. **Per-delta full-store localStorage write** — every `message_delta` triggers `JSON.stringify` of the *entire* persisted store (messages + snapshots) + an `AgentPanel` re-render per delta (`sessions/store.ts:1299-1306`) — O(dataset) per token chunk.
10. **Unbounded per-turn LLM snapshot + O(canvas) resolve per flush** — `canvasSnapshot` prints every node with no cap each turn; `DomCanvas` re-runs full-tree resolve on every rAF flush.
11. **Steer is cosmetic end-to-end** — the relay only broadcasts a fake `"[Steer: …]"` delta; no consumer injects it into the running session.
12. **The journal cannot reconstruct document state** — user patches never journaled (single writer: the agent route); catch-up deliberately skips patch replay; a disconnect spanning multiple turns reconstructs only the first closure (documented limitation, `journal-catchup.ts:48-51`).

---

## 3. What each app teaches (evidence)

### 3.1 tldraw — state-based sync, tombstone caps, presence lane
Repo: `research-scan/tldraw` @ `cbbcf35` (sync-core 5.3.2); docs tldraw.dev/docs/sync (fetched).

| Mechanism | What it does | Evidence |
|---|---|---|
| Records store + squashed diffs | `AtomMap<id, frozen record>` + history ring buffer (1000); `RecordsDiff {added,updated,removed}` holds record *references* (structural sharing); `squashRecordDiffs` folds bursts so listeners fire once | `packages/store/src/lib/Store.ts:353-405`, `RecordsDiff.ts:29,163` |
| Local persistence | IndexedDB, **diff-based per-record puts in one transaction, throttled 350ms**; `pagehide`/`visibilitychange→hidden` flush so the last 350ms isn't lost; cross-tab BroadcastChannel; schema migrations in both directions | `TLLocalSyncClient.ts:16-18,305-417,147-167` |
| Sync protocol v8 | C→S `connect{lastServerClock, schema}` → S→C `connect{hydrationType: wipe_all\|wipe_presence, diff, serverClock}`; `push{clientClock, diff, presence}`; `data` messages batched with 1000/60ms debounce | `packages/sync-core/src/lib/protocol.ts`, `TLSyncRoom.ts:87,466-524` |
| Catch-up | **State-based, not event replay**: `getChangesSince(lastServerClock)` returns every record with `lastChangedClock > clock` (full puts + tombstone deletes); presence wiped and fully re-sent every connect | `InMemorySyncStorage.ts:425-453`, `TLSyncRoom.ts:1078-1125` |
| Compaction | No op-log at all: current records + **tombstones capped at 5000** (prune 1000+overflow, throttled 1s) with a `tombstoneHistoryStartsAtClock` floor; client older than floor → `wipe_all` full snapshot | `InMemorySyncStorage.ts:25-85` |
| Conflicts | Server-authoritative, property-granular, applied in a storage txn; per-push verdict `commit`/`discard`/`rebaseWithDiff`; client-side OT rebase at 30fps (undo speculative → apply server → re-apply pending) | `TLSyncRoom.ts:1233-1287,1510-1553`, `TLSyncClient.ts:958-1024` |
| Presence | Separate in-memory `PresenceStore`, **never persisted**, re-hydrated on every connect, rides `push` as a dedicated field | `TLSyncRoom.ts:265,1298-1324` |
| Efficiency | Push throttle 30fps collab / 1fps solo; `ObjectDiff` value-ops incl. **append-with-offset** (string growth without resending); deep-equal no-op suppression; reconnect backoff ×1.5 (500ms-2s active, 1s-5min hidden); ping 5s / pong timeout 10s | `diff.ts:106-141`, `ClientWebSocketAdapter.ts:370-420` |

### 3.2 Excalidraw — the reconcile algorithm + periodic resync
Repo: `research-scan/excalidraw` @ `e1bb9ff`.

- **Wire**: stateless socket.io relay + Firestore durable scene (E2E-encrypted). `SCENE_INIT` (full) on join; `SCENE_UPDATE` sends only elements with `version > broadcastedElementVersions.get(id)`; **periodic FULL-scene rebroadcast every 20s** — "periodically we'll resync the whole thing to make sure no one diverges due to a dropped message" (`Portal.tsx:151-153`).
- **`reconcileElements`** (`packages/excalidraw/data/reconcile.ts`) — the crown jewel, ~60 lines of pure logic. Elements are immutable with `id`, monotonic `version`, random `versionNonce` per bump:
  - discard remote if local is newer (`local.version > remote.version`), or equal-version with **lower nonce** (deterministic tiebreak), or local is mid-interaction (being edited/resized/created);
  - remote wins by default; local-only ids appended; fractional-index ordering repaired at the end;
  - **the same algorithm runs inside the Firestore save transaction** (`firebase.ts:187-244`) — conflict resolution reused at the durability layer.
- **Reconnect**: no explicit handler at all — convergence relies on socket.io emit buffering + the 20s periodic resync + idempotent version-based reconcile. Joining an existing room RESETS the scene (offline edits across a full rejoin are *not* preserved — the counter-example to copy from Figma instead).
- **Persistence**: localStorage debounced 300ms (paused during collab); Firestore throttled 20s via `runTransaction`-reconcile; `beforeunload` flush; deleted elements GC'd after 24h tombstone timeout.
- **Presence**: roster (`room-user-change`), volatile `MOUSE_LOCATION` throttled **33ms**, idle states, follow-mode with viewport bounds.

### 3.3 Figma — server authority + checkpoint/journal compaction + the offline contract
Posts: "How Figma's multiplayer technology works" (2019), "Rust in production" (2018), "Making multiplayer more reliable" (2022) — full text mirrored in `scripts/research/6c-excalidraw-figma/`.

- **Server-authoritative, no OT, no true CRDT**: "Multiplayer is authoritative and handles validation, ordering, and conflict resolution." Property-level last-write-wins — the server tracks the latest value per property per object; conflicts exist only when two clients touch the *same property of the same object*; "we don't need a timestamp because the server can define the order of events."
- **Client prediction**: apply local edits immediately; **discard incoming server changes that conflict with unacknowledged local edits** (no flicker).
- **The offline contract** (the exact model for our gap 2): "Figma lets you go offline for an arbitrary amount of time and continue editing. When you come back online, the client downloads a **fresh copy** of the document, **reapplies any offline edits** on top of this latest state, and then continues syncing over a new WebSocket. This means connecting and reconnecting are very simple."
- **Durability (2022)**: in-memory authoritative state + **checkpoints every 30-60s** (full file → binary → compressed → S3), each tagged with the per-file monotonic sequence number it covers + a **DynamoDB journal of incremental changes** with seq ranges; crash recovery = load checkpoint + replay higher-seq entries (goal <1s data loss; 95% of edits persisted ~600ms). Journal writes are **batched** (clients send every 33ms). Split-brain prevented with a DynamoDB lock + conditional writes. The journal also powers fast loads ("client presents its local seq → downloads only the journal tail"), version history, and webhooks — validated by re-deriving checkpoints byte-for-byte from checkpoint+entries.
- **GC**: the server stores *no* properties of deleted objects (delete data lives in the deleting client's undo buffer).

### 3.4 Linear + Replicache — versioned pull, exactly-once, outbox, compaction strategies
Sources: linear.app/now/rebuilding-delta-sync-read-path (Aug 2026); `wzhudev/reverse-linear-sync-engine` (CTO-endorsed on HN: "correct and more complete than what Linear publishes internally"), code-verified against the deobfuscated client bundle; doc.replicache.dev specs.

- **Linear protocol**: per-workspace IndexedDB cache holding `{lastSyncId, firstSyncId}`; bootstrap = full NDJSON dump (`/sync/bootstrap?type=full`) from a MongoDB snapshot cache; **mutations are ordinary GraphQL calls with client-generated UUIDs, requesting only `lastSyncId` back**; pending transactions are **persisted before sending** (`__transactions` table) and replayed on restart; a mutation is "complete" only when a delta with `syncId ≥` its `lastSyncId` arrives; on WS handshake the client compares clocks and calls **`GET /sync/delta?lastSyncId=X&toSyncId=Y`** (a stream of SyncActions — full-row snapshots); conflicts = LWW-with-rebase on update transactions; hard failure = **delete local DB and re-bootstrap**; `collab` (presence) messages are explicitly **never retried**.
- **Linear scale**: ~1M sync actions/day for the largest workspaces, >20TB total; they keep the full WAL and built a serving index instead of compacting (CDC → turbopuffer, two-stage metadata-scan→late-enrichment pipeline) — *not* applicable at our scale, but the snapshot-cache-for-bootstraps and late-enrichment ideas are.
- **Replicache**: `pull {cookie}` → `{cookie, lastMutationIDChanges, patch[put/del/clear]}`; **a bad/too-old cookie is answered with `clear` + `put`s — a full refetch, never an error**. `push {mutations:[{clientID, id (per-client sequential), name, args}]}` with server rules: ignore `id ≤ lastMutationID` (dedup), ignore `id > lastMutationID+1` (no gaps), bump `lastMutationID` transactionally with the effects, **permanent errors still bump** (else the client deadlocks). Client applies server state by rewind → patch → replay-pending → atomic reveal. Realtime = contentless "poke". Four backend versioning strategies incl. row-version CVR (deletion detected by absence — no tombstones needed).

### 3.5 OpenHands + LibreChat — REST-first hydration, events-as-transcript, resumable streams
Sources: OpenHands @ `main` (verified clone), LibreChat @ `main` (raw fetches); copies in `scripts/research/6e-openhands-librechat/`.

- **OpenHands delivery**: `GET /api/conversations/{id}/events/search` with **keyset pagination** (`page_id`, limit ≤100, timestamp filters); `GET …/agent_final_response` ("text of the last agent finish message"); live WebSocket `/api/sockets/events/{id}` with **`resend_mode=all|since` + `after_timestamp`** — docstring: "Enables efficient bi-directional loading where REST fetches historical events and WebSocket handles events after a specific point."
- **OpenHands frontend mount flow** (the pattern to copy verbatim): React Query fetches the **tail page** (`TIMESTAMP_DESC, limit=50`, reversed) with `refetchOnMount:"always"`, `staleTime:0`, `retry:1`; **the WS attach is gated on the REST page landing**; `refetchOnReconnect:false` because "events missed while offline arrive over the WebSocket `since` replay on reconnect anyway"; reconnect backoff 1s→30s **+ 30% jitter**.
- **Events are the transcript**: the journal persists user *and* agent MessageEvents — a client that missed N turns rebuilds them from the journal itself; runs continue server-side on refresh; no persisted client cursor (the REST tail is the anchor; at-least-once replay + O(1) id-dedup set gives correctness). No log compaction exists (their condenser compresses LLM context, not delivery).
- **LibreChat**: user message saved **up-front**; response saved at end via a terminal CAS; **abort saves the partial message** (`finish_reason:'incomplete'`). Agents v2: generation (POST → `streamId`) is separated from subscription (GET EventSource) — "navigation away does NOT abort the generation"; a Redis durable chunk log + resume snapshot frontier + **30s terminal-pending reconciliation window** ("a crashed owner leaves the durable pending bit behind; the next read promotes it to conservative reconciliation"); on (re)subscribe the server sends a `sync` event carrying `aggregatedContent` (snapshot, not delta replay); `useResumeOnLoad` polls active jobs every 5s and **subscribes to the existing stream** instead of starting a new generation. Message history hydration = server-owned canonical list.

---

## 4. The converged architecture

All five research streams converge on the same skeleton (differing only in state-diff vs event-log flavor):

1. **Server-authoritative document state** — validation, ordering, conflict resolution happen server-side (Figma/tldraw/Linear/Replicache all).
2. **A complete replication log** — every accepted change, monotonic seq per document (Figma DynamoDB journal; OpenHands event log; Linear sync actions; tldraw is the exception: state+`lastChangedClock` instead of a log).
3. **Versioned catch-up** — client watermark/cookie → delta or tail replay, any window size (Linear `fetchDelta(from,to)`; Replicache pull-with-cookie; Figma journal tail; OpenHands `since` replay).
4. **Snapshot + bounded tail** — checkpoints tagged with the seq they cover; too-old clients get a full resync, never an error (Figma 30-60s checkpoints; Replicache `clear`+`put`; tldraw `wipe_all` + tombstone cap).
5. **Client outbox + optimistic prediction** — offline queue replayed after server-state hydration; never block the UI; never silently drop on permanent rejection (Figma fresh-copy+reapply; Linear `__transactions`; Replicache pending replay).
6. **Ephemeral lane** — presence/collab excluded from the durable log and never retried/replayed (tldraw PresenceStore; Linear collab commands; Excalidraw volatile events).
7. **Delivery pattern: REST-first, live-second** — hydrate from the canonical tail on mount, then subscribe live with a since-cursor (OpenHands; LibreChat).

**Design decision for us:** our `AgentEvent` journal + `afterSeq` API is already event-flavored → complete it Figma-style (journal *all* accepted changes, snapshot+tail compaction) rather than re-shaping into tldraw's state-diff. Excalidraw's version/nonce reconcile supplies the idempotent-conflict semantics that make replay safe.

---

## 5. The playbook — mapped to our codebase

**R1. Complete the journal into a true replication log.** The `canvas:patch` handler in canvas-sync becomes a journaling writer: sanitize → `journalAgentEvent('patch', {origin:'user', clientId, clientMutationId, patch})` → apply to in-memory doc → broadcast. Journal the user's prompt message (`source:'user'`) at run start. Events API response gains `lastMutationIDChanges` (per-clientId) so replayed/retried client mutations dedupe by Replicache's `id ≤ lastMutationID` rule. Puts `documentId` on the wire (fixing routing at the same time). *Files: `src/lib/canvas/server.ts`, `mini-services/canvas-sync/index.ts`, `src/lib/agent/event-journal.ts`, events route, `store.ts` emit path.* Closes gaps 1, 5, 12; prerequisite for R3/R4/R5.

**R2. Server-owned canvas state: fold + snapshot-with-seq + tail compaction.** Server folds journaled patches into Document state; writes `DocumentSnapshot {document, lastSeq}` server-side on interval + turn boundaries (client snapshot POSTs demoted to hints, then removed); events API returns `snapshotSeq`; client watermark < snapshotSeq → existing `canvas:full` full resync; journal rows ≤ snapshotSeq prunable (keep a safety tail; tombstone/GC semantics from tldraw/Figma). *Files: `server.ts`, `event-journal.ts`, snapshots route, `prisma/schema.prisma` (+`lastSeq`).* Closes gaps 3, 12; unlocks R9a.

**R3. Unbounded multi-turn catch-up + `turn.final` content events.** (a) Journal one `agent:turn_final` event per turn carrying the final assistant text + canvas-effects summary (OpenHands "events are the transcript" + `agent_final_response`; LibreChat `aggregatedContent`). (b) Once patches replay idempotently (toolCallId for agent patches — shipped; clientMutationId for user patches — R1), remove `stop-at-first-terminal` from `journal-catchup.ts` and replay the entire gap window; reconstruct missed turns' chat rows from the journal. *Files: `journal-catchup.ts`, `route.ts` (journal turn_final), `store.ts` `_onSync`, sessions store.* Closes gap 12's catch-up half.

**R4. REST-first hydration on mount + agent status endpoint.** On document open: fetch the journal tail page (newest, ~50 events) + `GET /api/documents/[id]/agent/status` `{activeRun, lastTerminal, finalResponse}`; attach the socket with watermark = fetched seq. Watermark becomes an optimization, not the correctness path — kills the reload/rejoin bug class. Status endpoint doubles as terminal reconciliation (LibreChat's 30s durable-pending promotion for runs whose client vanished). *Files: new status route, `journal-catchup.ts`/new hydrate module, `store.ts` init.* Closes gaps 8-partial, 12-reload-class.

**R5. Offline outbox + Figma reconnect contract.** Queue outgoing user patches in localStorage while the socket is down (optimistic local apply stays); on reconnect: hydrate server state FIRST, then flush the queue with clientMutationIds (dedupe via R1), reconcile via R6; on permanent server rejection, drop + surface an error (Replicache deadlock rule). Replaces the current clobber-on-`canvas:full`. *Files: `store.ts` `sendPatch`/`_onSync`, new outbox module.* Closes gap 2.

**R6. Per-element version + nonce reconcile.** Add `version`/`versionNonce` to shapes (bump on mutation); apply Excalidraw's rules on every incoming remote patch AND on `canvas:full` merge (replacing the unconditional replace): remote wins by default; local wins if strictly newer, equal-version-lower-nonce, or mid-interaction. ~60 lines of pure logic + tests; makes every resync/replay idempotent with deterministic conflict outcomes (user-vs-user and agent-vs-user). *Files: `store.ts`, shape types.* Closes conflict-correctness under gaps 1/2/5; prerequisite for replay guarantees.

**R7. Presence lane.** Volatile socket.io events on existing per-document rooms: roster on join/leave, throttled (33ms) cursor + selection, idle status; never journaled, never replayed. Agent-run status can ride presence ("who's watching / agent busy"). *Files: `server.ts`, `store.ts`, cursor UI layer.* Closes gap 7.

**R8. Sync-service plumbing debts.** `documentId` in the client envelope (kill first-match subscriber scan); make the standalone canvas-sync twin share the in-process module (or delete it — today the EADDRINUSE winner silently picks semantics: no DB seed, steer dropped); wire steer into the running session or remove the surface. *Files: `mini-services/canvas-sync/index.ts`, `server.ts`.* Closes gaps 4, 5, 11.

**R9. Efficiency pack.**
(a) **Delta LLM context** — per-turn canvas watermark; prompt carries changed-nodes-since-last-turn + compact digest + selection + off-viewport cluster summaries; `pen_read_node` hydrates on demand (tldraw `getChangesSince` + Linear late-enrichment + round-1 E1). *Files: `runner-native.ts`/`runner-legacy.ts` `canvasSnapshot`; needs R2's folded state.* Closes gap 10-LLM.
(b) **Streaming persist throttle** — throttle the sessions-store persist (Excalidraw's 300ms), partialize streaming text out of the persisted slice, batch deltas before `set()` (tldraw history-squash pattern). *Files: `sessions/store.ts` persist config.* Closes gap 9.
(c) **Incremental resolve** — per-shape memoization / dirty-set instead of full-tree `resolvePenTreeDetailed` per flush (tldraw structural sharing + `createComputedCache` pattern). *Files: `DomCanvas.tsx`.* Closes gap 10-render.

---

## 6. Prioritized roadmap

**Phase A — quick wins (≤1 day each, no schema changes):**
R6 version/nonce reconcile · R7 presence lane · R8 plumbing debts (documentId routing, twin unification, steer real-or-removed) · R9b persist throttle · micro-adopts: reconnect backoff 1s→30s + jitter, `retry:1` semantics on hydration, first-message socket auth.

**Phase B — complete the log + catch-up (3-7 days):**
R1 journal user patches + user messages with exactly-once ids · R4 REST-first hydration + status endpoint · R3 unbounded catch-up + `turn.final` events · R5 offline outbox + reconnect contract.

**Phase C — server ownership + efficiency (1-2 weeks):**
R2 journal fold + server-written snapshot checkpoints + tail compaction · R9a delta LLM context · R9c incremental resolve.

**What NOT to copy:** Linear's keep-the-full-WAL-and-index-it scale strategy (20TB, turbopuffer) — our scale wants Figma-style snapshot+tail; Excalidraw's reset-scene-on-join (offline-edit loss) — Figma's fresh-copy+reapply is strictly better for us; E2E encryption of relay payloads (not our threat model today); CRDTs/OT (all four sources explicitly avoided them — a central server makes them unnecessary).

---

## 7. Sources

- tldraw @ `cbbcf35` — sparse clone `research-scan/tldraw` (packages/store, editor, sync-core); tldraw.dev/docs/sync (fetched to `scripts/research/6b-tldraw/`)
- Excalidraw @ `e1bb9ff` — sparse clone `research-scan/excalidraw` (excalidraw-app/collab, packages/excalidraw/data/reconcile.ts, LocalData.ts, firebase.ts)
- Figma engineering posts (2019, 2018, 2022) — mirrored text in `scripts/research/6c-excalidraw-figma/` (figma.com blocks direct curl)
- Linear — linear.app/now/rebuilding-delta-sync-read-path (Aug 2026); `wzhudev/reverse-linear-sync-engine` clone `research-scan/` (CTO-endorsed, code-verified); performance.dev breakdown
- Replicache — doc.replicache.dev reference + concepts (fetched); archived repo is README-only
- OpenHands @ `main` — clone `research-scan/openhands` (frontend hooks/contexts/stores; agent-server event_router.py, sockets.py, event_service.py)
- LibreChat @ `main` — targeted raw fetches (abortMiddleware.js, BaseClient.js, GenerationJobManager.ts, useResumableSSE.ts, useResumeOnLoad.ts) in `scripts/research/6e-openhands-librechat/`
- AgentCanvas canvas-pipeline audit — Task 6-a subagent report (worklog.md)
