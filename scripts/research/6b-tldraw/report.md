# Task 6-b — tldraw sync architecture research

Sources: tldraw/tldraw @ commit `cbbcf3575879ddd63c342436228e2707c0ddf830` (Aug 28 2026), packages/sync-core 5.3.2, packages/sync 5.3.2, packages/store, packages/editor; docs at tldraw.dev/docs/sync + /docs/persistence + blog/announcing-tldraw-sync (fetched copies in this dir).

## Q1. Editor store model

- `Store<R>` = `AtomMap<IdOf<R>, R>` (id → **immutable record**) + `history: Atom<number, RecordsDiff<R>>` ring buffer (historyLength 1000) + `historyAccumulator` flushed by a **historyReactor** (async batch flush). [packages/store/src/lib/Store.ts:353-405]
- `RecordsDiff` = `{added: {id→rec}, updated: {id→[from,to]}, removed: {id→rec}}` — **reversible**, holds record refs (structural sharing, no deep clones). [packages/store/src/lib/RecordsDiff.ts:29]
- `squashRecordDiffs` folds consecutive diffs (drag frames collapse to one diff); docs note squash mutates `[from,to]` tuples safely because records are immutable. [RecordsDiff.ts:163]
- Listeners filtered by `{source: 'user'|'remote', scope: 'document'|'session'|'presence'}` — remote changes don't trigger user listeners or undo history (`mergeRemoteChanges`). [Store.ts:390, TLSyncClient.ts:572-579]
- Derived state: `store.query` (StoreQueries, reactive indexes), `createComputedCache` — memoized per-record derived data invalidated by history atom. [Store.ts:131-157, 383]
- Undo/redo: `HistoryManager` intercepts **user-source history entries only**, squashes into `pendingDiff`, exposes `mark()`, undo/redo stacks; undo = `reverseRecordsDiff` re-applied. [packages/editor/src/lib/editor/managers/HistoryManager/HistoryManager.ts:33-61]

## Q2. Local persistence

- `persistenceKey` prop → `TLLocalSyncClient` + `LocalIndexedDb` (idb lib; object stores: `records`, `schema`, `session_state`, `assets`; DB name `TLDRAW_DOCUMENT_v2<persistenceKey>` v4). [packages/editor/src/lib/utils/sync/LocalIndexedDb.ts:8-51]
- **Diff-based writes**: store.listen(user,document) pushes RecordsDiff to `diffQueue` → `schedulePersist` throttled **PERSIST_THROTTLE_MS = 350ms** (retry throttle 10s after write error) → `db.storeChanges` writes **per-record puts/deletes in one IDB transaction**. Occasional full snapshot writes (`shouldDoFullDBWrite` on init/error/schema-skew). [TLLocalSyncClient.ts:16-18, 121-135, 305-417; LocalIndexedDb.ts:195-237]
- **Flush on exit**: `pagehide` + `visibilitychange→hidden` flush so the throttled tail isn't lost. [TLLocalSyncClient.ts:147-167]
- Cross-tab: `BroadcastChannel('tldraw-tab-sync-<key>')` broadcasts diffs + schema announce; older-schema tab reloads the page. [TLLocalSyncClient.ts:228-271]
- Load: `db.load()` → `store.schema.migrateStoreSnapshot({store, schema})` (full migration pipeline incl. per-shape props migrations) → `mergeRemoteChanges(put(records,'initialize'))`. [TLLocalSyncClient.ts:194-219]
- Migrations: schema serialized into every snapshot + IndexedDB `schema` store; per-shape `migrations` arrays with up/down steps; server also migrates client records up on push and diffs down to older sessions (`migratePersistedRecord` / `migrateDiffOrRejectSession`). [TLSyncRoom.ts:1040-1113, 1192]

## Q3. tldraw sync protocol (protocol v8) [packages/sync-core/src/lib/protocol.ts]

Client→server: `connect {connectRequestId, lastServerClock, protocolVersion, schema}`, `push {clientClock, diff?: NetworkDiff, presence?}`, `ping`.
Server→client: `connect {hydrationType:'wipe_all'|'wipe_presence', connectRequestId, protocolVersion, schema, diff, serverClock, isReadonly, objectAccess?}`, `data {data: patch|push_result[]}` (batched), legacy single `patch`/`push_result`, `pong`, `custom`, `incompatibility_error`.

Lifecycle & catch-up:
- Handshake: session states `AwaitingConnectMessage → Connected → AwaitingRemoval`. Connect must arrive within **SESSION_START_WAIT_TIME = 10s**; idle timeout **SESSION_IDLE_TIMEOUT = 20s** (ping-driven); removal grace **5s**. [RoomSession.ts:45-65; TLSyncRoom.ts:220-258]
- **Bootstrap = state-diff, not event replay**: `txn.getChangesSince(lastServerClock)` returns every record with `lastChangedClock > since` as full puts + tombstone deletes with clock > since. Client clock = -1/0 or older than `tombstoneHistoryStartsAtClock` → `wipeAll=true` → full snapshot + `hydrationType:'wipe_all'`. Client clock in the future → treated as -1 (full wipe). [InMemorySyncStorage.ts:425-453; TLSyncRoom.ts:1078-1125]
- Own presence excluded from hydration (server never echoes a session's own updates); peers' presence sent as puts. [TLSyncRoom.ts:1086-1096]
- Client reconnect rebase: stash speculativeChanges → (if not wipe_all) reverse them → apply server diff → re-apply speculative as a new push. `lastServerClock` is **memory-only** (-1 at boot) → page reload = full hydration; socket blip = incremental. [TLSyncClient.ts:737-816, 374]
- Reconnect manager: exp backoff **1.5^attempt**, active-tab delays 500ms–2s, hidden-tab 1s–5min, ATTEMPT_TIMEOUT 1s; ping every **5s**, PONG_TIMEOUT 10s (unanswered-ping rule so throttled hidden tabs don't false-positive). [ClientWebSocketAdapter.ts:370-420; TLSyncClient.ts:287-294, 609-662]
- Wire format `NetworkDiff`: `{[id]: ['put',rec] | ['patch', ObjectDiff] | ['remove']}`; ObjectDiff values: put/patch/append(with offset — string streaming)/delete. [diff.ts:10-46, 106-141]
- Ordering: single monotonic **documentClock** per room (incremented per changed transaction); clientClock = FIFO push sequence matched against push_results. [SQLiteSyncStorage.ts:452-488; TLSyncClient.ts:982-986]
- Compaction: **no op log** — "history" is only tombstones; `MAX_TOMBSTONES=5000`, prune oldest 1000+overflow when exceeded (throttled 1s), advancing `tombstoneHistoryStartsAtClock`; clients older than that get wipe_all. Room snapshot = documents+lastChangedClock+tombstones+schema. [InMemorySyncStorage.ts:25-85, 254; SQLiteSyncStorage.ts:514-533]
- Hibernation: `onSessionSnapshot` after **5s** message inactivity → serialize session snapshot to WS attachment → `handleSocketResume` restores straight to Connected. [TLSocketRoom.ts:395-425; docs/sync]
- Presence separation: presence records live in a separate in-memory `PresenceStore` (**never persisted**, wiped+re-hydrated on every connect), ride the same `push` message but as a dedicated `presence` field. [TLSyncRoom.ts:265, 1298-1324; TLSyncClient.ts:713-720]
- Object-store lane (comments): record types partitioned into separate persistence lane, gated by `objectAccess` not `isReadonly`. [protocol.ts:28-36; TLSyncRoom.ts:1325-1331]

## Q4. Conflicts

- Server is authoritative & sequenced: pushes applied inside a storage transaction against **current server state**; patches merge per-property onto whatever the server has (LWW at property granularity, server-ordered); patch-to-deleted and delete-of-deleted are no-ops. [TLSyncRoom.ts:1233-1287, 1460-1498]
- Server replies `push_result.action`: **'commit'** (applied verbatim), **'discard'** (nothing applied — client keeps server state), **'rebaseWithDiff'** (actual applied diff — validation/authorizer/readonly transformed it; client reconciles to server truth). [TLSyncRoom.ts:1510-1553]
- Client-side OT: `rebase()` = undo speculative → apply incoming patches + push_results in order → re-apply pending pushes/unsent diff. [TLSyncClient.ts:958-1024]
- Validation/authorization server-side: `diffAndValidateRecord`, per-type `TLRecordAuthorizer` (veto/stamp; veto → skipped op, client self-corrects via resulting diff). [TLSyncRoom.ts:156-185, 1205-1209]
- Version skew: client schema older → server migrates up; server can't migrate down → `CLIENT_TOO_OLD` socket close. [TLSyncRoom.ts:1040-1057]

## Q5. Efficiency patterns

- Diffs squashed & throttled: client sends pushes at **30fps collaborative / 1fps solo** (FpsScheduler); server batches outgoing data msgs: first message immediate, rest debounced **1000/60 ms** into one `data` array. [TLSyncClient.ts:47-50, 508-554; TLSyncRoom.ts:87, 466-524]
- Message chunking for Cloudflare 1MB WS limit (256K chars/chunk, prefix `N_`). [chunk.ts:5-40]
- `applyNetworkDiff` uses deep `isEqual` so no-op patches don't touch store listeners. [TLSyncClient.ts:921-955]
- Per-record `lastChangedClock` + SQL index = catch-up query is an index scan, not a log replay. [SQLiteSyncStorage.ts:117-120, 333]
- String `append` value-op with offset for streaming text growth. [diff.ts:126-141]
- History ring buffer (1000) + squashing keeps listener fan-out bounded; immutable records make diff sharing zero-copy.

## Mapping to AgentCanvas gaps

- **G1 multi-turn catch-up**: tldraw's bootstrap is *state-since-clock* (getChangesSince), not turn-event replay — reconstructs any gap length. Translate: journal consumer should also fetch server's current authoritative canvas state per changed node since watermark (or full resync) instead of only replaying one turn's closure events.
- **G2 user edits not journaled**: tldraw journals *every* client push through one authoritative room (commit/discard/rebase per push). Translate: route user canvas edits through canvas-sync as `user:*` journal events (or adopt server-owned room state).
- **G3 server not authoritative**: TLSocketRoom + SQLiteSyncStorage is exactly the reference: server owns records + clock + tombstones, persists in transactions, clients are cache. Replace client fire-and-forget snapshot POSTs.
- **G4 presence**: separate ephemeral presence channel (never persisted, wiped on reconnect) riding the same socket as a distinct field/namespace; 5s idle session snapshots for hibernation.
- **G5 unbounded journal**: tldraw stores *current state + lastChangedClock + tombstones ≤5000* instead of an ever-growing log; "compaction" = tombstone pruning advancing tombstoneHistoryStartsAtClock; older clients get full snapshot. Translate: snapshot+tail model with a tombstoneHistoryStartsAtClock-equivalent floor watermark.
- **G6 offline queue**: client speculativeChanges + squash + rebase-on-reconnect re-applies offline edits as a fresh push after hydration (30fps flush, ping/pong health with unanswered-ping rule).
- **G7 full snapshot to LLM**: dual lesson — (a) per-property ObjectDiff wire format makes "changed since clock" cheap; (b) AppendOp+offset pattern for streaming text. Translate: send the LLM a changed-nodes delta vs last-seen watermark + elide unchanged nodes, incremental context rather than full canvas.

## Top 5 adopt-in-AgentCanvas

1. **Server-authoritative room state with per-document documentClock** (G2+G3+G1, M-L): Prisma table storing per-node current state + lastChangedClock (+ tombstone table), all writes (user & agent) through canvas-sync transactions; catch-up = `WHERE lastChangedClock > ?` state diff.
2. **Snapshot+tail journal compaction** (G5, S-M): keep AgentEvent tail bounded (e.g. last N or since floor clock); write periodic DocumentSnapshot rows; clients older than floor get wipe_all full resync. Direct analogue: MAX_TOMBSTONES=5000 / prune 1000.
3. **Presence lane** (G4, S): ephemeral per-socket presence records in canvas-sync rooms, excluded from journal/persistence, broadcast-only, wiped on reconnect.
4. **Client offline queue + rebase** (G6, M): queue user patches in localStorage while disconnected; on reconnect hydrate server state first, then re-apply squashed local diff as one push; idempotency already shipped helps.
5. **Delta LLM context** (G7, S-M): maintain per-turn "canvas watermark"; build prompt from nodes with lastChangedClock > watermark (full records only for changed nodes, elide rest), mirroring getChangesSince + append-with-offset for streaming artifacts.
