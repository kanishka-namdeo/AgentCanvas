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

const PORT = 3003;

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
    };
    documents.set(documentId, doc);
  }
  return doc;
}

/// Shared-canvas cold-start seed: when the FIRST subscriber arrives for a
/// document this process has no in-memory state for, load the newest
/// DocumentSnapshot from the server DB so a service restart does not reset
/// every viewer's canvas to empty (the client's `canvas:full` empty-guard is
/// the backstop; this makes the healthy path seamless). Any failure (db
/// unavailable, corrupt JSON, missing model) falls back to the empty default.
async function seedDocumentFromDb(documentId: string): Promise<CanvasDocument | null> {
  try {
    const { db } = await import('../db');
    const row = await db.documentSnapshot.findFirst({
      where: { documentId },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) return null;
    const parsed = JSON.parse(row.document) as CanvasDocument;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return { ...parsed, id: documentId };
  } catch {
    return null;
  }
}

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
          // Cold-start seed: before creating an empty in-memory doc, try the
          // DB's newest snapshot for this document (shared-canvas model).
          let state = documents.get(event.documentId);
          if (!state) {
            const seeded = await seedDocumentFromDb(event.documentId);
            state = ensureDocument(event.documentId);
            if (seeded) {
              state.document = seeded;
              console.log(`[canvas-sync] seeded ${event.documentId} from latest DocumentSnapshot`);
            }
          }
          state.subscribers.add(socket.id);
          socket.emit('sync', { type: 'canvas:full', document: state.document, reason: 'sync' } satisfies SyncEvent);
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
          state.document = applyPatchToCanvas(state.document, event.patch);
          broadcast(state, { type: 'canvas:patch', patch: event.patch }, socket.id);
          break;
        }
        case 'canvas:request_full': {
          const state = ensureDocument(event.documentId);
          socket.emit('sync', { type: 'canvas:full', document: state.document, reason: 'sync' } satisfies SyncEvent);
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
            state.document = applyPatchToCanvas(state.document, evt.patch);
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
  }
}
