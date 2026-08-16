// Canvas-sync WebSocket mini-service.
//
// Responsibilities:
//   1. Maintain per-document canvas state in memory (the source of truth
//      during a session — Prisma is used only for initial load + persistence
//      by the Next.js API routes, not by this service).
//   2. Broadcast every canvas patch to every subscribed viewer.
//   3. Accept agent-emitted events (tool_call_start/end, message deltas,
//      thinking deltas, turn_end) and fan them out to viewers.
//
// Port: 3003 (configured in Caddyfile, exposed via XTransformPort).
// Path: '/' (must NOT change — Caddy uses it for routing).

import { createServer } from 'http';
import { Server } from 'socket.io';
import type { ClientEvent, SyncEvent, CanvasDocument, CanvasPatch } from '../../src/lib/canvas/types.ts';
import { applyPatchToCanvas } from '../../src/lib/canvas/patch.ts';

const httpServer = createServer();
const io = new Server(httpServer, {
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ---- In-memory document store ------------------------------------------------
// Keyed by documentId. In a production system this would live in Redis or
// a real-time database; for the agent-canvas demo an in-process Map is enough.
interface DocState {
  document: CanvasDocument;
  subscribers: Set<string>; // socket ids
}

const documents = new Map<string, DocState>();

function ensureDocument(documentId: string): DocState {
  let doc = documents.get(documentId);
  if (!doc) {
    doc = {
      document: {
        id: documentId,
        name: 'Untitled',
        background: '#f8fafc',
        viewport: { zoom: 1, panX: 0, panY: 0 },
        shapes: [],
        tokens: { colors: [], textStyles: [] },
        heatmap: null,
      },
      subscribers: new Set(),
    };
    documents.set(documentId, doc);
  }
  return doc;
}

/// Apply a patch to a document state using the shared pure patch logic.
function applyPatch(state: DocState, patch: CanvasPatch): CanvasDocument {
  state.document = applyPatchToCanvas(state.document, patch);
  return state.document;
}

function broadcast(state: DocState, event: SyncEvent, except?: string) {
  for (const sid of state.subscribers) {
    if (sid === except) continue;
    io.to(sid).emit('sync', event);
  }
}

// ---- Connection handling -----------------------------------------------------

io.on('connection', (socket) => {
  console.log(`[canvas-sync] connected: ${socket.id}`);

  socket.on('client', (event: ClientEvent) => {
    switch (event.type) {
      case 'subscribe': {
        const state = ensureDocument(event.documentId);
        state.subscribers.add(socket.id);
        // Send current full state to the new subscriber.
        socket.emit('sync', { type: 'canvas:full', document: state.document } satisfies SyncEvent);
        // Notify everyone of new viewer count.
        broadcast(state, { type: 'presence', viewerCount: state.subscribers.size });
        console.log(`[canvas-sync] ${socket.id} subscribed to ${event.documentId} (${state.subscribers.size} viewers)`);
        break;
      }
      case 'canvas:patch': {
        const state = documents.get(event.patch.shapeId ? event.patch.shapeId : '');
        // The patch carries the documentId implicitly via the subscription.
        // We find the right document by checking which subscriptions this socket has.
        // For simplicity we look up by scanning — the demo only has a handful.
        for (const [docId, docState] of documents) {
          if (docState.subscribers.has(socket.id)) {
            applyPatch(docState, event.patch);
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
        // The frontend asks the WS service to drive the agent. We forward
        // this to the Next.js API route via fetch, then stream the API's
        // SSE response back out as `sync` events.
        console.log(`[canvas-sync] agent prompt on ${event.documentId}: ${event.prompt.slice(0, 80)}…`);
        driveAgent(event.documentId, event.prompt, socket.id).catch((err) => {
          console.error('[canvas-sync] agent drive failed:', err);
        });
        break;
      }
    }
  });

  socket.on('disconnect', () => {
    console.log(`[canvas-sync] disconnected: ${socket.id}`);
    for (const [docId, state] of documents) {
      if (state.subscribers.delete(socket.id)) {
        broadcast(state, { type: 'presence', viewerCount: state.subscribers.size });
        if (state.subscribers.size === 0) {
          // Optional: keep the doc in memory for a while for replay.
          // For the demo we just leave it.
        }
      }
    }
  });

  socket.on('error', (error) => {
    console.error(`[canvas-sync] socket error (${socket.id}):`, error);
  });
});

// ---- Agent driver ------------------------------------------------------------
//
// The agent itself runs in the Next.js API route (it needs Prisma + the Pi
// Agent SDK tool definitions). This service calls that route over HTTP and
// bridges the Server-Sent-Events stream back into socket.io `sync` events
// so every subscribed viewer sees the agent work in real time.

async function driveAgent(documentId: string, prompt: string, originatorSocketId: string) {
  const state = ensureDocument(documentId);

  // Helper that fans an event out to every viewer (including the originator).
  const fanout = (event: SyncEvent) => {
    for (const sid of state.subscribers) {
      io.to(sid).emit('sync', event);
    }
  };

  // Call the Next.js /api/agent route. We use the gateway's XTransformPort
  // mechanism: port 3000 is the Next.js dev server.
  const gatewayUrl = 'http://localhost:3000/api/agent?XTransformPort=3000';
  const res = await fetch(gatewayUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ documentId, prompt, canvasState: state.document }),
  });

  if (!res.ok || !res.body) {
    fanout({ type: 'agent:error', message: `Agent HTTP ${res.status}` });
    return;
  }

  // The API streams newline-delimited JSON events (NDJSON).
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
          // Apply + broadcast the canvas mutation.
          applyPatch(state, evt.patch);
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

const PORT = 3003;
httpServer.listen(PORT, () => {
  console.log(`[canvas-sync] WebSocket server listening on port ${PORT}`);
});

process.on('SIGTERM', () => {
  console.log('[canvas-sync] SIGTERM, shutting down…');
  httpServer.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  console.log('[canvas-sync] SIGINT, shutting down…');
  httpServer.close(() => process.exit(0));
});
