// Canvas-sync WebSocket service — server-side module.
//
// Started by `instrumentation.ts` when the Next.js dev server boots.
// Listens on port 3003 and:
//   1. Maintains per-document canvas state in memory.
//   2. Broadcasts every canvas patch to every subscribed viewer.
//   3. Drives the agent by calling /api/agent and streaming the NDJSON
//      response back out as `sync` events.
//   4. Relays the volatile presence lane (roster / cursors / selection / idle)
//      — never journaled, never replayed.
//
// This used to have a standalone twin (mini-services/canvas-sync) that raced
// for the port and lost on purpose; it was deleted — see docs/zai-sandbox-setup.md #8.

import { createServer } from 'http';
import { Server } from 'socket.io';
import type { ClientEvent, SyncEvent, CanvasDocument, CanvasPatch, PresenceParticipant } from './types';
import { applyPatchToCanvas } from './patch';
import { patchDedupeKey, createBoundedDedupSet, type BoundedDedupSet } from './patch-dedupe';
import { setMeasuredBounds } from '../agent/client-roundtrip';
import { steerActiveSession } from '../agent/active-sessions';
import { acceptUserMutation } from './user-patch-journal';
import {
  hydrateDocumentFromJournal,
  writeServerCheckpoint,
  journalDocumentRestore,
  trackPatchTombstones,
  computeChangedNodeIdsSince,
} from './journal-fold';

const PORT = 3003;

// How often the dirty-checkpoint tick runs (Figma writes checkpoints every
// 30-60s; agent turns checkpoint at their own boundary).
const CHECKPOINT_TICK_MS = 30_000;

// In-memory document store.
interface DocState {
  document: CanvasDocument;
  subscribers: Set<string>;
  /// toolCallId+content dedup set for agent patches (idempotent apply —
  /// a replayed/double-delivered patch is skipped instead of double-applied;
  /// the canvas is append-only so a double-apply could never be undone).
  appliedPatches: BoundedDedupSet;
  /// Presence lane (R7): the document's known participants, keyed by the
  /// client-generated participantId (stable across socket reconnects, unlike
  /// socket.id). Entries are REMOVED when their owning socket disconnects.
  participants: Map<string, PresenceParticipant & { socketId: string }>;
  /// Phase C (R2): node ids deleted server-side (and not re-added). Rides
  /// every canvas:full as `deletedIds` so client reconcile drops them instead
  /// of resurrecting them as "local-only adds". Seeded by the journal fold,
  /// maintained by applyAndTrack, persisted inside checkpoints.
  tombstones: Set<string>;
  /// True when the in-memory document has mutations not yet covered by a
  /// server checkpoint — the interval tick checkpoints dirty docs.
  dirty: boolean;
  /// Per-turn canvas watermark (R9a): the journal seq this document's state
  /// was last "settled" at (post-hydration / post-checkpoint). The NEXT
  /// agent turn's prompt delta is computed from here.
  lastTurnSeq: number;
}

const documents = new Map<string, DocState>();

/// In-flight agent runs, keyed by documentId — the handle behind the
/// server-visible Stop (`agent:stop` client event). Aborting the fetch also
/// aborts the /api/agent request server-side, whose request signal
/// propagates into the runner (session.abort()) — Stop now actually stops
/// token spend instead of just hiding the output.
const activeRuns = new Map<string, AbortController>();

function ensureDocument(documentId: string): DocState {
  let doc = documents.get(documentId);
  if (!doc) {
    doc = {
      document: {
        id: documentId,
        name: 'Untitled',
        version: '2.17',
        children: [],
        variables: undefined,
        themes: undefined,
        background: '#f8fafc',
        viewport: { zoom: 1, panX: 0, panY: 0 },
        shapes: [],
        tokens: { colors: [], textStyles: [] },
      },
      subscribers: new Set(),
      appliedPatches: createBoundedDedupSet(),
      participants: new Map(),
      tombstones: new Set(),
      dirty: false,
      lastTurnSeq: 0,
    };
    documents.set(documentId, doc);
  }
  return doc;
}

/// Apply a patch to the in-memory document while maintaining the tombstone
/// lane + dirty flag (Phase C R2). Every apply site in this file goes through
/// here so live state and fold state can never diverge on tombstones.
function applyAndTrack(state: DocState, patch: CanvasPatch): void {
  trackPatchTombstones(state.document, patch, state.tombstones);
  state.document = applyPatchToCanvas(state.document, patch);
  state.dirty = true;
}

/// Tombstone payload for canvas:full events (bounded — the set itself is
/// FIFO-capped at TOMBSTONE_CAP).
function deletedIdsFor(state: DocState): { deletedIds: string[] } {
  return { deletedIds: [...state.tombstones] };
}

/// Server-authoritative cold-start hydration (Phase C, R2): fold the newest
/// server checkpoint + journal tail instead of seeding from the newest
/// client-POSTed snapshot. This is what makes user edits + agent patches
/// survive a service restart END-TO-END (they were journaled in Phase A/B;
/// before this they only survived into a NEW checkpoint if a client POSTed
/// a snapshot). Falls back internally to the legacy newest-snapshot base
/// for pre-Phase-C documents, then bootstraps a real checkpoint.
async function hydrateDocumentState(documentId: string): Promise<DocState> {
  const state = ensureDocument(documentId);
  try {
    const hydration = await hydrateDocumentFromJournal(documentId);
    state.document = hydration.document;
    state.tombstones = hydration.tombstones;
    state.lastTurnSeq = hydration.foldedThroughSeq;
    state.dirty = false;
  } catch {
    // Fold failure — keep the empty default; canvas:full empty-guard +
    // client snapshots remain the backstop (same as the old seed failure).
  }
  return state;
}

/// Shared-canvas cold-start seed: SUPERSEDED in Phase C by
/// hydrateDocumentState (journal fold). Kept ONLY as the documented history
/// of what changed — the old newest-DocumentSnapshot seed lost every
/// journaled mutation above the snapshot on restart.

function broadcast(state: DocState, event: SyncEvent, except?: string) {
  for (const sid of state.subscribers) {
    if (sid === except) continue;
    io?.to(sid).emit('sync', event);
  }
}

/// Full roster snapshot of a document's presence lane (minus the socket's
/// own entry — a client never needs its own cursor echoed back).
function rosterFor(state: DocState, exceptSocketId?: string): PresenceParticipant[] {
  const roster: PresenceParticipant[] = [];
  for (const p of state.participants.values()) {
    if (exceptSocketId && p.socketId === exceptSocketId) continue;
    const { socketId: _drop, ...participant } = p;
    roster.push(participant);
  }
  return roster;
}

let io: Server | null = null;

export function startCanvasSyncService() {
  if (io) return; // Already started.

  const httpServer = createServer();
  io = new Server(httpServer, {
    path: '/',
    cors: { origin: '*', methods: ['GET', 'POST'] },
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  io.on('connection', (socket) => {
    console.log(`[canvas-sync] connected: ${socket.id}`);

    socket.on('client', async (event: ClientEvent) => {
      switch (event.type) {
        case 'subscribe': {
          // Cold-start hydration (Phase C R2): fold checkpoint + journal tail
          // so a restart does not roll the canvas back to the last client
          // POSTed snapshot (user edits + agent patches live in the journal).
          let state = documents.get(event.documentId);
          if (!state) {
            state = await hydrateDocumentState(event.documentId);
            console.log(`[canvas-sync] hydrated ${event.documentId} from journal fold (seq ≤ ${state.lastTurnSeq}, ${state.tombstones.size} tombstones)`);
          }
          state.subscribers.add(socket.id);
          socket.emit('sync', {
            type: 'canvas:full',
            document: state.document,
            reason: 'sync',
            ...deletedIdsFor(state),
          } satisfies SyncEvent);
          broadcast(state, { type: 'presence', viewerCount: state.subscribers.size });
          // Late joiner gets the current roster (other viewers' cursors) so
          // presence works immediately; the newcomer announces itself with
          // its first presence:update.
          socket.emit('sync', { type: 'presence:roster', roster: rosterFor(state, socket.id) } satisfies SyncEvent);
          console.log(`[canvas-sync] ${socket.id} subscribed to ${event.documentId} (${state.subscribers.size} viewers)`);
          break;
        }
        case 'canvas:patch': {
          // Route by documentId when the client provides it (R8a). The legacy
          // first-match subscriber scan remains as a fallback for old clients
          // — under it, a socket subscribed to several documents had ALL its
          // patches land in whichever doc was created first.
          let docId = event.documentId;
          let state = docId ? documents.get(docId) : undefined;
          if (!state) {
            for (const [id, docState] of documents) {
              if (docState.subscribers.has(socket.id)) {
                docId = id;
                state = docState;
                break;
              }
            }
          }
          if (!state || !docId) break;

          // R1 exactly-once path: mutations carrying identity are journaled
          // (`user_patch` row + MutationClock bump) before apply/broadcast,
          // and the sender gets a per-mutation ack. `select` ops are UI
          // state — apply + broadcast with NO journaling and NO ack (stamping
          // them would burn a clientMutationId the clock never sees and
          // manufacture a gap). Legacy clients (no identity) keep the old
          // fire-and-relay semantics.
          if (
            event.clientId &&
            typeof event.clientMutationId === 'number' &&
            event.patch?.op !== 'select'
          ) {
            const decision = await acceptUserMutation(
              docId,
              event.clientId,
              event.clientMutationId,
              event.patch,
            );
            socket.emit('sync', {
              type: 'mutation:ack',
              clientId: event.clientId,
              clientMutationId: event.clientMutationId,
              status: decision.status,
              lastMutationId: decision.lastMutationId,
            } satisfies SyncEvent);
            if (decision.status !== 'accepted') {
              // duplicate: the effect is already server-side (a retried outbox
              // entry — no re-apply, no re-broadcast). rejected: a gap — the
              // client re-anchors and surfaces from the ack payload.
              break;
            }
          }
          applyAndTrack(state, event.patch);
          broadcast(state, { type: 'canvas:patch', patch: event.patch }, socket.id);
          break;
        }
        case 'canvas:request_full': {
          const state = ensureDocument(event.documentId);
          socket.emit('sync', {
            type: 'canvas:full',
            document: state.document,
            reason: 'sync',
            ...deletedIdsFor(state),
          } satisfies SyncEvent);
          break;
        }
        case 'presence:update': {
          // Presence lane relay (R7): record the participant, rebroadcast to
          // the document's OTHER subscribers. Volatile by design — never
          // journaled, never replayed by the journal catch-up, never fanned
          // to the agent. A participant whose socket disconnects is evicted
          // by the disconnect handler below.
          const state = documents.get(event.documentId);
          const p = event.participant;
          if (!state || !p || typeof p.participantId !== 'string') break;
          const { socketId: _drop, ...participant } = p as PresenceParticipant & { socketId?: string };
          state.participants.set(participant.participantId, { ...participant, socketId: socket.id });
          broadcast(state, { type: 'presence:update', participant }, socket.id);
          break;
        }
        case 'document:restore': {
          // Shared-canvas restore: a viewer swapped the document back to a
          // snapshot. Replace the in-memory state and rebroadcast the full
          // document to EVERY subscriber (including the sender — the replace
          // is idempotent) so all viewers + the WS doc stay in sync.
          const state = ensureDocument(event.documentId);
          state.document = event.document;
          // A restore voids prior deletions (the restored snapshot may bring
          // deleted nodes back) — reset the tombstone lane rather than
          // resurrect-suppressing the restore itself.
          state.tombstones.clear();
          state.dirty = true;
          // Journal the restore (Phase C R2): snapshot row + document_restore
          // event, so the fold replays it after a restart instead of seeding
          // from "newest snapshot" (which a restore never created).
          await journalDocumentRestore(event.documentId, event.document);
          // Next agent turn gets a FULL canvas snapshot — everything changed.
          state.lastTurnSeq = 0;
          broadcast(state, { type: 'canvas:full', document: state.document, reason: 'restore' } satisfies SyncEvent);
          console.log(`[canvas-sync] document:restore on ${event.documentId} broadcast to ${state.subscribers.size} viewers`);
          break;
        }
        case 'agent:prompt': {
          console.log(`[canvas-sync] agent prompt on ${event.documentId}: ${event.prompt.slice(0, 80)}… (images: ${event.images?.length ?? 0})`);
          driveAgent(
            event.documentId,
            event.prompt,
            event.settings,
            event.images,
            event.selection,
            { sessionId: event.sessionId, runId: event.runId, userMessageId: event.userMessageId, assistantMessageId: event.assistantMessageId },
          ).catch((err) => {
            console.error('[canvas-sync] agent drive failed:', err);
          });
          break;
        }
        case 'agent:stop': {
          // Server-visible Stop (durability fix): abort the document's
          // in-flight run. driveAgent's fetch aborts → the /api/agent route
          // sees its request signal fire → the runner aborts the pi session
          // → the stream closes → driveAgent fans agent:turn_cancelled to
          // every viewer. Previously the server kept running to completion
          // and late patches kept mutating the canvas after "Stop".
          const controller = activeRuns.get(event.documentId);
          if (controller) {
            console.log(`[canvas-sync] agent stop on ${event.documentId} — aborting in-flight run`);
            controller.abort();
            // The map entry is removed by driveAgent's finally (identity-
            // checked, so aborting an old run never unregisters a newer one).
          } else {
            console.log(`[canvas-sync] agent stop on ${event.documentId} — no in-flight run`);
          }
          break;
        }
        case 'agent:steer': {
          // REAL steer (R8c): inject the user's message into the running
          // agent session via the pi SDK's native session.steer() — the model
          // sees it after the current tool batch, before the next LLM call,
          // and its response streams through the normal event fan-out so
          // every viewer sees it. Previously this broadcast a fake
          // "[Steer: …]" delta while NOTHING reached the model.
          console.log(`[canvas-sync] steer on ${event.documentId}: ${event.text.slice(0, 80)}…`);
          const steered = await steerActiveSession(event.documentId, event.text);
          if (!steered) {
            // No live run — tell just the sender. Ephemeral feedback event,
            // deliberately NOT agent:error (that would finalize the streaming
            // turn / run on every viewer).
            socket.emit('sync', { type: 'agent:steer_rejected', reason: 'No agent run is active on this canvas.' } satisfies SyncEvent);
          }
          break;
        }
        case 'canvas:measured_bounds': {
          // Measured-bounds digest push from a DOM renderer (spec §3.8):
          // refresh the SERVER-side runtime cache consumed by canvasSnapshot
          // enrichment (§5.5) + pen_bake_layout. Client→server only — NOT
          // rebroadcast (every viewer measures its own local copy).
          setMeasuredBounds(event.documentId, event.bounds);
          break;
        }
        case 'canvas:computed_response':
        case 'canvas:screenshot_response':
        case 'canvas:extract_html_response': {
          // Round-trip answers normally arrive via POST /api/agent/answers'
          // sibling route (/api/agent/client-responses) — the HTTP path is
          // authoritative because it resolves the pending map in the SAME
          // process as the agent tools. The socket copies are accepted but
          // intentionally ignored here (no broadcast, no state change).
          break;
        }
      }
    });

    socket.on('disconnect', () => {
      console.log(`[canvas-sync] disconnected: ${socket.id}`);
      for (const [, state] of documents) {
        let touched = state.subscribers.delete(socket.id);
        if (touched) {
          broadcast(state, { type: 'presence', viewerCount: state.subscribers.size });
        }
        // Presence lane cleanup: evict every participant owned by this
        // socket (normally one; a buggy client could register several) and
        // broadcast the shrunk roster. The roster is sent PER RECIPIENT with
        // that recipient's own entries excluded — a shared broadcast would
        // echo everyone their own cursor (live-verified bug).
        let removed = false;
        for (const [participantId, p] of state.participants) {
          if (p.socketId === socket.id) {
            state.participants.delete(participantId);
            removed = true;
          }
        }
        if (removed || touched) {
          for (const sid of state.subscribers) {
            io?.to(sid).emit('sync', {
              type: 'presence:roster',
              roster: rosterFor(state, sid),
            } satisfies SyncEvent);
          }
        }
      }
    });

    socket.on('error', (error) => {
      console.error(`[canvas-sync] socket error (${socket.id}):`, error);
    });
  });

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    // Reverse-race guard: if something else already owns :3003 (e.g. a
    // manually-launched relay), a raw EADDRINUSE here would take down the
    // WHOLE Next.js process. Log and keep serving HTTP instead.
    if (err.code === 'EADDRINUSE') {
      console.error(`[canvas-sync] port ${PORT} already in use — in-process relay NOT started (another service owns it). Live canvas sync will use that service's semantics.`);
    } else {
      console.error('[canvas-sync] http server error:', err);
    }
  });
  httpServer.listen(PORT, () => {
    console.log(`[canvas-sync] WebSocket server listening on port ${PORT}`);
  });

  // ---- Dirty-checkpoint tick (Phase C, R2) ---------------------------------
  //
  // Turn boundaries checkpoint agent runs, but USER edits (drag/move/edit
  // patches) arrive outside turns. This tick folds any document whose state
  // changed since its last checkpoint into a server checkpoint every 30s
  // (Figma writes checkpoints every 30-60s). Documents with a live agent run
  // are skipped — the run's own turn-boundary checkpoint covers them, and a
  // moving journal head would only burn the quiescence budget.
  setInterval(() => {
    for (const [documentId, state] of documents) {
      if (!state.dirty) continue;
      if (activeRuns.has(documentId)) continue;
      void writeServerCheckpoint(documentId, state.document, state.tombstones)
        .then((res) => {
          if (res) {
            state.lastTurnSeq = res.lastSeq;
            state.dirty = false;
          }
        })
        .catch(() => {});
    }
  }, CHECKPOINT_TICK_MS).unref?.();
}

// ---- Agent driver -----------------------------------------------------------
//
// Calls the Next.js /api/agent route over HTTP and bridges the NDJSON
// stream back out as socket.io `sync` events.

async function driveAgent(
  documentId: string,
  prompt: string,
  settings?: import('../settings/types').AgentRunSettings,
  images?: Array<{ id?: string; name?: string; dataUrl: string }>,
  selection?: { count: number; names: string[] },
  identity?: {
    sessionId?: string;
    runId?: string;
    userMessageId?: string;
    assistantMessageId?: string;
  },
) {
  const state = ensureDocument(documentId);

  const directFanout = (event: SyncEvent) => {
    for (const sid of state.subscribers) {
      io?.to(sid).emit('sync', event);
    }
  };
  // Turn identity on the wire (R3): broadcast the user's prompt message to
  // every viewer BEFORE the run's first event. The prompting client created
  // the row locally at promptAgent and skips it by messageId (idempotent);
  // OTHER viewers previously saw the assistant stream with NO user turn —
  // now the shared transcript converges, and reconnecting catch-up replay
  // rebuilds the same event from the journal. (The ROUTE journals the durable
  // copy; this is the live fanout only — no double journal write.)
  directFanout({
    type: 'agent:user_message',
    text: prompt,
    ...(identity?.sessionId ? { sessionId: identity.sessionId } : {}),
    ...(identity?.runId ? { runId: identity.runId } : {}),
    ...(identity?.userMessageId ? { messageId: identity.userMessageId } : {}),
  });

  // ---- Server-side patch-event batching (efficiency fix) ----------------
  //
  // The agent emits one socket event per NDJSON line; a bulk_add burst means
  // N socket.io frames + N client handler invocations within a few ms. The
  // client renderer already coalesces applies to one rAF — the WIRE should
  // too. Events buffer for ≤16ms and flush as a burst; terminal events
  // (turn_end / turn_cancelled / error / full / presence) flush immediately
  // so turn lifecycle timing is never delayed.
  const IMMEDIATE_EVENT_TYPES = new Set([
    'agent:turn_end',
    'agent:turn_cancelled',
    'agent:error',
    'canvas:full',
    'presence',
  ]);
  let pendingFanout: SyncEvent[] = [];
  let fanoutTimer: ReturnType<typeof setTimeout> | null = null;
  const flushFanout = () => {
    fanoutTimer = null;
    if (pendingFanout.length === 0) return;
    const batch = pendingFanout;
    pendingFanout = [];
    for (const event of batch) directFanout(event);
  };
  const fanout = (event: SyncEvent) => {
    if (IMMEDIATE_EVENT_TYPES.has(event.type)) {
      if (fanoutTimer) {
        clearTimeout(fanoutTimer);
        fanoutTimer = null;
      }
      flushFanout();
      directFanout(event);
      return;
    }
    pendingFanout.push(event);
    if (!fanoutTimer) fanoutTimer = setTimeout(flushFanout, 16);
  };

  // Register this run as the document's active one (see agent:stop).
  const abortController = new AbortController();
  activeRuns.set(documentId, abortController);

  // ---- Delta LLM context (Phase C, R9a) ---------------------------------
  //
  // Per-turn canvas watermark: instead of serializing the WHOLE canvas into
  // the prompt every turn, tell the runner which nodes changed since the
  // last settled turn (folded journal state — R2). The runner's
  // canvasSnapshot emits a compact digest + the changed nodes' details;
  // pen_get_metadata hydrates anything else on demand (tldraw
  // getChangesSince + Linear late-enrichment). null = full snapshot (first
  // turn after boot, restore, or any global op since the last turn).
  let canvasDelta: { sinceSeq: number; nodeIds: string[] | null } | undefined;
  if (state.lastTurnSeq > 0) {
    const delta = await computeChangedNodeIdsSince(documentId, state.lastTurnSeq);
    canvasDelta = { sinceSeq: state.lastTurnSeq, nodeIds: delta.nodeIds };
  }

  // Call the Next.js API route on port 3000. We use 127.0.0.1 directly
  // because we're in the same process as Next.js — no need to go through
  // the Caddy gateway.
  const url = `http://127.0.0.1:3000/api/agent`;
  let aborted = false;
  let sawTurnEnd = false;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // The signal is the server-visible Stop handle: agent:stop aborts this
      // fetch, the route's request signal fires, and the runner aborts the
      // pi session server-side.
      signal: abortController.signal,
      // `images` rides along in the body — compact data URLs produced by the
      // client's downscale pipeline (lib/agent/attachments.ts). `selection`
      // is the canvas-selection targeting context. Turn identity (R3) rides
      // along so the route can journal id-linked user_message / turn_final
      // rows for reconnect catch-up replay.
      body: JSON.stringify({
        documentId,
        prompt,
        canvasState: state.document,
        ...(canvasDelta ? { canvasDelta } : {}),
        settings,
        images,
        selection,
        ...(identity?.sessionId ? { sessionId: identity.sessionId } : {}),
        ...(identity?.runId ? { runId: identity.runId } : {}),
        ...(identity?.userMessageId ? { userMessageId: identity.userMessageId } : {}),
        ...(identity?.assistantMessageId ? { assistantMessageId: identity.assistantMessageId } : {}),
      }),
    });

    if (!res.ok || !res.body) {
      fanout({ type: 'agent:error', message: `Agent HTTP ${res.status}` });
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const evt = JSON.parse(line) as
            | { type: 'patch'; patch: CanvasPatch; toolCallId?: string }
            | { type: 'agent_event'; event: SyncEvent };
          if (evt.type === 'patch') {
            // Idempotent apply: skip a verbatim duplicate delivery of a patch
            // we already applied (same toolCallId + same content). One tool
            // call MAY legitimately emit several different patches — those
            // have different content hashes and still apply.
            const dedupeKey = patchDedupeKey(evt.toolCallId, evt.patch);
            if (dedupeKey && state.appliedPatches.has(dedupeKey)) {
              continue;
            }
            if (dedupeKey) state.appliedPatches.add(dedupeKey);
            applyAndTrack(state, evt.patch);
            fanout({ type: 'canvas:patch', patch: evt.patch, toolCallId: evt.toolCallId });
          } else if (evt.type === 'agent_event') {
            if (evt.event?.type === 'agent:turn_end') sawTurnEnd = true;
            fanout(evt.event);
          }
        } catch (err) {
          console.error('[canvas-sync] failed to parse NDJSON line:', line, err);
        }
      }
    }
  } catch (err: any) {
    if (err?.name === 'AbortError' || abortController.signal.aborted) {
      aborted = true;
    } else {
      fanout({ type: 'agent:error', message: `Agent stream failed: ${err?.message ?? String(err)}` });
    }
  } finally {
    // Flush any batched events FIRST so ordering is preserved (terminal
    // event fans out after everything that preceded it).
    if (fanoutTimer) {
      clearTimeout(fanoutTimer);
      fanoutTimer = null;
    }
    flushFanout();
    if (aborted) {
      // The run was stopped server-side: every viewer finalizes the turn as
      // cancelled (a trailing turn_cancelled replaces the turn_end).
      directFanout({ type: 'agent:turn_cancelled' });
    } else if (!sawTurnEnd) {
      // The stream already carried an authoritative turn_end from the runner
      // — only synthesize one when none arrived (stream died mid-turn).
      directFanout({ type: 'agent:turn_end' });
    }
    if (activeRuns.get(documentId) === abortController) {
      activeRuns.delete(documentId);
    }
    // ---- Turn-boundary checkpoint (Phase C, R2) ---------------------------
    //
    // The run's mutations are journaled (route bundle) and applied live
    // (here). Persist the folded state as a server checkpoint so (a) a
    // restart rehydrates from checkpoint + tail instead of a stale client
    // snapshot, and (b) compaction can prune the covered journal rows.
    // Quiescence happens INSIDE writeServerCheckpoint (the route bundle's
    // writeChain isn't awaitable from this module instance — the head is
    // probed until stable). Fire-and-forget: a failure never affects the
    // completed turn; the 30s dirty tick retries.
    void writeServerCheckpoint(documentId, state.document, state.tombstones)
      .then((res) => {
        if (res) {
          state.lastTurnSeq = res.lastSeq;
          state.dirty = false;
        }
      })
      .catch(() => {});
  }
}
