# Research 6-d: Linear Sync Engine + Replicache Protocol → AgentCanvas mapping

Artifacts saved under /home/z/my-project/research-scan/ (gitignored):
- lin-delta.html / lin-delta-clean.txt — Linear "Rebuilding Linear's delta sync read path" (Peter Travers, Aug 18 2026), full text
- lin-sync.html — Linear "Scaling the Linear Sync Engine" (Tuomas Artman, Jun 29 2023) — video post, no article text
- reverse-linear-sync-engine/ — github.com/wzhudev/reverse-linear-sync-engine clone (README.md 1571 lines = full study; SUMMARY.md; code/Root.js + code/html.js = annotated deobfuscated Linear client bundle)
- marknotfound.txt — marknotfound.com "Reverse engineering Linear's sync magic" (Dec 20 2022)
- perfdev.txt — performance.dev "How's Linear so fast" (stack/sync facts)
- repl-docs/*.html|txt — doc.replicache.dev pages: concepts/how-it-works, reference/server-pull, reference/server-push, strategies/{overview,reset,global-version,per-space-version,row-version}, concepts/{offline,consistency,performance}, byob/poke, sitemap
- hn-*.json — HN Algolia threads (44123131 incl. Linear CTO artman endorsing the reverse-engineering study; 36519448; 48437960)
- rocicorp/replicache clone: repo is now issues-only (3 commits, README only — source removed after Replicache sunset; docs site still live and is the protocol source of truth)

## Key verified protocol facts

### Linear (LSE)
- Local IndexedDB per workspace; metadata = {lastSyncId, firstSyncId, subscribedSyncGroups, databaseVersion, __schemaHash}
- Bootstrap: GET /sync/bootstrap?type=full|partial&onlyModels=CSV → NDJSON stream of model rows + trailing `_metadata_={"method":"mongo"|"postgres","lastSyncId":N,"subscribedSyncGroups":[...],"databaseVersion":N,"returnedModelsCount":{...}}`; served from MongoDB snapshot cache; late-2024 split into cacheable sub-requests (splitToCacheableRequests); /sync/user_sync_groups pre-request
- Mutations: ordinary GraphQL POST; client-generated UUIDs in input; ONLY response field requested = lastSyncId; batching via microtask batchIndex + merged GraphQL doc with aliases + size cap
- TransactionQueue: createdTransactions → queuedTransactions (persisted to __transactions IndexedDB table BEFORE send) → executingTransactions → completedButUnsyncedTransactions; replay after restart via loadPersistedTransactions/confirmPersistedTransactions; NOT idempotent (documented rare double-apply on close-before-response)
- No server-tracked lastMutationID; exactly-once approximated by: mutation completion gated on receiving the delta packet whose syncId ≥ mutation's returned lastSyncId; CreationTransaction cancelled when delta arrives with same client UUID (modelUpserted)
- Realtime: WebSocket; server broadcasts delta packets `{cmd:"sync", sync:[SyncAction...], lastSyncId}` to ALL clients incl. the mutator; SyncAction = {id (global monotonic int), modelName, modelId, action: I/U/A/D/C/G/S/V, data (full row)}; ping every 20s (Ice = SECOND*20)
- Missed packets: on "hshk", client compares local lastSyncId vs server; if behind → `fetchDelta(l, d)` = GET /sync/delta?lastSyncId=X&toSyncId=Y → {syncActions:[...]} (code-verified); error path: reSyncRequired flag → delete DB + reload (full re-bootstrap); rate-limit → disconnect with bootstrap error
- Conflict resolution: Last-Writer-Wins via transaction rebasing (original value updated from delta, in-memory model re-set to pending value); OT-like total order from central server
- Client NEVER writes model tables until server delta confirms (local DB ⊂ server SSOT); in-memory optimistic immediately
- Ephemeral collab/presence = separate `cmd:"collab"` binary messages on same socket, never retried on reconnect (shouldRetrySendingOnceConnected returns false for collab only)
- 2026 delta read path: sync action log = app-level WAL on Postgres; CDC to turbopuffer (p50 ~1s); inverted-index posting lists for sync groups + subscriptions intersected with ID range; two-stage: metadata scan then late enrichment (payloads fetched from Postgres only for surviving IDs); Postgres serves authoritative head slice, overlap dedup by sync action ID; shadow-mode rollout; ~1M sync actions/day largest workspaces, 20TB retained
- perfdev: Redis (event bus + cache + sync cursors), Postgres issues table partitioned 300 ways

### Replicache
- Pull: POST {pullVersion:1, clientGroupID, cookie|null, profileID, schemaVersion} → {cookie (orderable), lastMutationIDChanges: Record<clientID,number>, patch: [put|del|clear]}; clear+puts = full reset when cookie unknown; ClientStateNotFound; VersionNotSupported
- Push: POST {pushVersion:1, clientGroupID, mutations:[{clientID, id (per-client seq int), name, args, timestamp}]} → response body ignored; client retries mutation until pull's lastMutationID ≥ id
- Server rules: ignore id ≤ lastMutationID (dup) and id > lastMutationID+1 (future); effects + lastMutationID bump must commit atomically; permanent error → still bump id; temporary → abort w/o bump
- Client: pending mutations persisted; on pull: discard id ≤ lastMutationID; rebase = rewind to last server state → apply patch → replay pending mutators on top → atomically reveal (git-like)
- Conflicts: mutators are app JS re-run on latest state (server on push, client on rebase); server authoritative, speculative replaced
- Offline: hours-to-days supported; pullInterval default 60s (dev only); realtime via poke = contentless hint (SSE/WebSocket/Pusher), one channel per doc
- Versioning strategies: reset (full view/pull) → global version (+lastModifiedVersion + soft delete tombstones, ~50 pushes/s cap) → per-space version (same + tombstones, 50/s/space) → row version (CVR per client group: key→version map; Postgres xmin usable as row version; NO tombstones — deletion = absence from CVR query; arbitrary per-user queries, read auth, partial sync)
- Consistency: Causal+ (Jepsen-consulted)

## G1–G7 mapping (short)
- G1 unbounded catch-up: Linear replay = fetchDelta(local,server) with no turn concept; drop stop-at-first-terminal once user patches are journaled+replayable
- G2 journal user edits: Replicache mutation records {clientID, id, name, args} + server lastMutationID; Linear alt: client-UUID dedup
- G3 server owns state: fold journal → server Document state; DocumentSnapshot becomes compaction artifact
- G5 compaction: Replicache cookie invalid → clear+put full refetch (snapshot+tail); Linear keeps full WAL + snapshot cache (Mongo) and scales the read path instead
- G6 offline outbox: Linear __transactions table + replay-on-reconnect + shouldRetryOnceConnected; Replicache pending replay-until-confirmed
- G4 presence: both keep awareness OUT of the replicated log (Linear "collab" cmds, never retried; Replicache poke carries no data)
- G7 LLM context: Linear sync subscriptions + lazy hydration + late enrichment → selector-based context from server-folded state

Full analysis in final report (Task 6-d).
