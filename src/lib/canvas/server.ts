// Canvas-sync WebSocket service — server-side module.
//
// Started by `instrumentation.ts` when the Next.js dev server boots.
// Listens on port 3003 and:
//   1. Maintains per-document canvas state in memory.
//   2. Broadcasts every canvas patch to every subscribed viewer.
//   3. Drives the agent by calling /api/agent and streaming the NDJSON
//      response back out as `sync` events.
//
// This is the same logic as `mini-services/canvas-sync/index.ts` but
// refactored as an importable module so it can run inside the Next.js
// process.

import { createServer } from 'http';
import { Server } from 'socket.io';
import type { ClientEvent, SyncEvent, CanvasDocument, CanvasPatch } from './types';
import { applyPatchToCanvas } from './patch';
import { setMeasuredBounds } from '../agent/client-roundtrip';

const PORT = 3003;

// In-memory document store.
interface DocState {
  document: CanvasDocument;
  subscribers: Set<string>;
}

const documents = new Map<string, DocState>();

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
    };
    documents.set(documentId, doc);
  }
  return doc;
}

function broadcast(state: DocState, event: SyncEvent, except?: string) {
  for (const sid of state.subscribers) {
    if (sid === except) continue;
    io?.to(sid).emit('sync', event);
  }
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

    socket.on('client', (event: ClientEvent) => {
      switch (event.type) {
        case 'subscribe': {
          const state = ensureDocument(event.documentId);
          state.subscribers.add(socket.id);
          socket.emit('sync', { type: 'canvas:full', document: state.document } satisfies SyncEvent);
          broadcast(state, { type: 'presence', viewerCount: state.subscribers.size });
          console.log(`[canvas-sync] ${socket.id} subscribed to ${event.documentId} (${state.subscribers.size} viewers)`);
          break;
        }
        case 'canvas:patch': {
          // Find which document this socket is subscribed to.
          for (const [, docState] of documents) {
            if (docState.subscribers.has(socket.id)) {
              docState.document = applyPatchToCanvas(docState.document, event.patch);
              broadcast(docState, { type: 'canvas:patch', patch: event.patch }, socket.id);
              break;
            }
          }
          break;
        }
        case 'canvas:request_full': {
          const state = ensureDocument(event.documentId);
          socket.emit('sync', { type: 'canvas:full', document: state.document } satisfies SyncEvent);
          break;
        }
        case 'agent:prompt': {
          console.log(`[canvas-sync] agent prompt on ${event.documentId}: ${event.prompt.slice(0, 80)}… (images: ${event.images?.length ?? 0})`);
          driveAgent(event.documentId, event.prompt, event.settings, event.images, event.selection).catch((err) => {
            console.error('[canvas-sync] agent drive failed:', err);
          });
          break;
        }
        case 'agent:steer': {
          // Steer: inject a user message into the running agent's context.
          // The agent will see this after its current tool batch, before the
          // next LLM call. We broadcast it as an agent:message_delta so the
          // UI shows the steer message.
          console.log(`[canvas-sync] steer on ${event.documentId}: ${event.text.slice(0, 80)}…`);
          const state = ensureDocument(event.documentId);
          broadcast(state, {
            type: 'agent:message_delta',
            text: `\n\n_[Steer: ${event.text}]_`,
          } satisfies SyncEvent);
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
        case 'canvas:screenshot_response': {
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
        if (state.subscribers.delete(socket.id)) {
          broadcast(state, { type: 'presence', viewerCount: state.subscribers.size });
        }
      }
    });

    socket.on('error', (error) => {
      console.error(`[canvas-sync] socket error (${socket.id}):`, error);
    });
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
) {
  const state = ensureDocument(documentId);

  const fanout = (event: SyncEvent) => {
    for (const sid of state.subscribers) {
      io?.to(sid).emit('sync', event);
    }
  };

  // Call the Next.js API route on port 3000. We use 127.0.0.1 directly
  // because we're in the same process as Next.js — no need to go through
  // the Caddy gateway.
  const url = `http://127.0.0.1:3000/api/agent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // `images` rides along in the body — compact data URLs produced by the
    // client's downscale pipeline (lib/agent/attachments.ts). `selection`
    // is the canvas-selection targeting context.
    body: JSON.stringify({ documentId, prompt, canvasState: state.document, settings, images, selection }),
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
          state.document = applyPatchToCanvas(state.document, evt.patch);
          fanout({ type: 'canvas:patch', patch: evt.patch, toolCallId: evt.toolCallId });
        } else if (evt.type === 'agent_event') {
          fanout(evt.event);
        }
      } catch (err) {
        console.error('[canvas-sync] failed to parse NDJSON line:', line, err);
      }
    }
  }
  fanout({ type: 'agent:turn_end' });
}
