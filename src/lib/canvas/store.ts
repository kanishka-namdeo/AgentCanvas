// Frontend store for the canvas. Single source of truth for the React UI:
//   - Holds the current `CanvasDocument`.
//   - Receives `SyncEvent`s from the WebSocket service and applies them.
//   - Bridges every prompt + event into the persistent session store
//     (`useSessionStore`) so chat history, tool calls, runs and snapshots
//     survive reloads and can be browsed / forked / restored.
//
// The store intentionally has no direct dependency on the Pi Agent SDK —
// the agent runs entirely on the server. The frontend only renders the
// result of tool calls (canvas patches) and the chat stream.

'use client';

import { create } from 'zustand';
import { io, type Socket } from 'socket.io-client';
import type { CanvasDocument, CanvasPatch, ClientEvent, Shape, SyncEvent } from '@/lib/canvas/types';
import { applyPatchToCanvas } from '@/lib/canvas/patch';
import { useSessionStore, hydrateSessionStore } from '@/lib/sessions';

/// A single chat turn — either the user's prompt or the agent's response.
/// This is the LIVE streaming buffer; the session store is the persistent
/// source of truth. On session switch we rebuild `turns` from the session
/// store's messages.
export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  /// Final text of the turn. Empty for user turns that only contain tool calls.
  text: string;
  /// Tool calls made during this turn (assistant only).
  toolCalls: AgentToolCallEntry[];
  /// Whether the turn is still streaming.
  streaming: boolean;
  /// Error message, if the turn failed.
  error?: string;
  /// Linked session-store Message id (for syncing).
  sessionId?: string;
  runId?: string;
  messageId?: string;
}

export interface AgentToolCallEntry {
  id: string;
  name: string;
  argsPreview: string;
  success?: boolean;
  summary?: string;
}

interface CanvasState {
  document: CanvasDocument;
  selectedIds: string[];
  /// Transient "agent-selected" ids — highlighted briefly when the agent
  /// uses the canvas_select_shape tool.
  agentHighlightIds: string[];
  socket: Socket | null;
  connected: boolean;
  viewerCount: number;
  turns: ChatTurn[];
  agentBusy: boolean;
  documentId: string;
  /// Active session id (mirrors sessionStore.activeSessionByDoc[documentId]).
  activeSessionId: string | null;

  // Actions ---------------------------------------------------------------
  init: (documentId: string) => () => void;
  sendPatch: (patch: CanvasPatch) => void;
  select: (ids: string[]) => void;
  promptAgent: (text: string) => void;
  setDocumentName: (name: string) => void;
  /// Switch the active session for this document. Rebuilds `turns` from
  /// the session store's messages and replaces the canvas with the
  /// session's latest snapshot.
  switchSession: (sessionId: string) => void;
  /// Create a new session for this document and activate it.
  newSession: () => string | null;
  /// Fork the active session from a specific message.
  forkActiveSession: (fromMessageId?: string | null) => string | null;

  // Internal — called by socket event handler
  _onSync: (event: SyncEvent) => void;
  /// Internal — rebuild `turns` from session store messages.
  _syncTurnsFromSession: () => void;
}

let highlightTimeout: any;

const EMPTY_DOC: CanvasDocument = {
  id: 'default',
  name: 'Untitled',
  background: '#f8fafc',
  viewport: { zoom: 1, panX: 0, panY: 0 },
  shapes: [],
  tokens: { colors: [], textStyles: [] },
  heatmap: null,
};

export const useCanvasStore = create<CanvasState>((set, get) => ({
  document: EMPTY_DOC,
  selectedIds: [],
  agentHighlightIds: [],
  socket: null,
  connected: false,
  viewerCount: 1,
  turns: [],
  agentBusy: false,
  documentId: 'default',
  activeSessionId: null,

  init: (documentId) => {
    // Hydrate the persisted session store from localStorage (client-only).
    // This is a no-op on the server.
    hydrateSessionStore();

    // Connect to the WebSocket mini-service on port 3003.
    // Per the gateway rules we MUST use the XTransformPort query param
    // and the path MUST be '/'.
    const socket = io('/?XTransformPort=3003', {
      transports: ['websocket', 'polling'],
      forceNew: true,
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      timeout: 10000,
    });

    set({ socket, documentId });

    // Hydrate from the session store: pick (or create) the active session
    // for this document, then load its latest snapshot (if any) into the
    // canvas and rebuild `turns`.
    const ss = useSessionStore.getState();
    let active = ss.getActiveSession(documentId);
    if (!active) {
      // Find any existing active (non-archived) session for this doc.
      const list = ss.listSessions({ documentId, status: 'active' });
      if (list.length > 0) {
        active = list[0];
        ss.setActiveSession(documentId, active.id);
      } else {
        // Create a fresh one.
        active = ss.createSession(documentId, {
          title: `Canvas · ${documentId}`,
        });
      }
    }
    set({ activeSessionId: active.id });
    // Load the snapshot if one exists.
    if (active.currentSnapshotId) {
      const snap = ss.getSnapshot(active.currentSnapshotId);
      if (snap) {
        set({ document: { ...snap.document, id: documentId } });
      }
    } else {
      // No snapshot — use the document name from the session title.
      set((s) => ({ document: { ...s.document, id: documentId, name: active!.title } }));
    }
    get()._syncTurnsFromSession();

    socket.on('connect', () => {
      set({ connected: true });
      socket.emit('client', { type: 'subscribe', documentId } satisfies ClientEvent);
    });
    socket.on('disconnect', () => set({ connected: false }));
    socket.on('sync', (event: SyncEvent) => {
      get()._onSync(event);
    });

    return () => {
      socket.disconnect();
    };
  },

  sendPatch: (patch) => {
    const { socket, connected } = get();
    if (socket && connected) {
      socket.emit('client', { type: 'canvas:patch', patch } satisfies ClientEvent);
    }
    // Apply locally too so the UI feels instant.
    set((s) => ({ document: applyPatchToCanvas(s.document, patch) }));
  },

  select: (ids) => set({ selectedIds: ids }),

  promptAgent: (text) => {
    const { socket, connected, documentId, activeSessionId, document } = get();

    // Ensure we have an active session.
    let sessionId = activeSessionId;
    if (!sessionId) {
      const sess = useSessionStore.getState().createSession(documentId, {
        title: text.slice(0, 48),
      });
      sessionId = sess.id;
      set({ activeSessionId: sessionId });
    }

    // Start a Run in the session store.
    const run = useSessionStore.getState().startRun(sessionId, text, 'user_message');
    // Auto-title if this is the first message.
    useSessionStore.getState().autoTitleFromPrompt(sessionId, text);
    // Append user message + assistant placeholder.
    const userMsg = useSessionStore.getState().appendUserMessage(sessionId, run.id, text);
    const assistantMsg = useSessionStore.getState().appendAssistantMessage(sessionId, run.id);

    // Mirror into the live `turns` buffer.
    const userTurn: ChatTurn = {
      id: userMsg.id,
      role: 'user',
      text,
      toolCalls: [],
      streaming: false,
      sessionId,
      runId: run.id,
      messageId: userMsg.id,
    };
    const assistantTurn: ChatTurn = {
      id: assistantMsg.id,
      role: 'assistant',
      text: '',
      toolCalls: [],
      streaming: true,
      sessionId,
      runId: run.id,
      messageId: assistantMsg.id,
    };
    set((s) => ({
      turns: [...s.turns, userTurn, assistantTurn],
      agentBusy: true,
    }));

    // If WebSocket is connected, route through it (live broadcast to all
    // viewers). Otherwise fall back to a direct HTTP call to /api/agent
    // so the app still works for a single viewer without the sync service.
    if (socket && connected) {
      socket.emit('client', {
        type: 'agent:prompt',
        documentId,
        prompt: text,
      } satisfies ClientEvent);
      return;
    }

    // Fallback: direct HTTP fetch to /api/agent. Apply patches + agent
    // events directly to local state. This is single-viewer only.
    (async () => {
      try {
        const res = await fetch('/api/agent', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ documentId, prompt: text, canvasState: get().document }),
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
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
                set((s) => ({ document: applyPatchToCanvas(s.document, evt.patch) }));
                get()._onSync({ type: 'canvas:patch', patch: evt.patch, toolCallId: evt.toolCallId });
              } else {
                get()._onSync(evt.event);
              }
            } catch { /* ignore malformed lines */ }
          }
        }
        get()._onSync({ type: 'agent:turn_end' });
      } catch (err: any) {
        get()._onSync({ type: 'agent:error', message: err?.message ?? 'unknown error' });
      }
    })();
  },

  setDocumentName: (name) =>
    set((s) => ({ document: { ...s.document, name } })),

  switchSession: (sessionId) => {
    const { documentId } = get();
    const ss = useSessionStore.getState();
    const session = ss.getSession(sessionId);
    if (!session || session.documentId !== documentId) return;
    ss.setActiveSession(documentId, sessionId);
    set({ activeSessionId: sessionId });
    // Load the session's current snapshot.
    if (session.currentSnapshotId) {
      const snap = ss.getSnapshot(session.currentSnapshotId);
      if (snap) {
        set({ document: { ...snap.document, id: documentId } });
      }
    } else {
      set({ document: { ...EMPTY_DOC, id: documentId, name: session.title } });
    }
    // Rebuild `turns` from session messages.
    get()._syncTurnsFromSession();
  },

  newSession: () => {
    const { documentId } = get();
    const ss = useSessionStore.getState();
    const session = ss.createSession(documentId, { title: 'New chat' });
    get().switchSession(session.id);
    return session.id;
  },

  forkActiveSession: (fromMessageId) => {
    const { activeSessionId, documentId } = get();
    if (!activeSessionId) return null;
    const ss = useSessionStore.getState();
    const fork = ss.forkSession(activeSessionId, fromMessageId ?? null);
    if (!fork) return null;
    get().switchSession(fork.id);
    return fork.id;
  },

  _syncTurnsFromSession: () => {
    const { activeSessionId } = get();
    if (!activeSessionId) {
      set({ turns: [] });
      return;
    }
    const ss = useSessionStore.getState();
    const messages = ss.listMessages(activeSessionId);
    const turns: ChatTurn[] = messages.map((m) => {
      // For assistant messages, join tool calls from the run (the session
      // store keeps tool calls normalized by runId, not embedded in messages).
      let toolCalls: Array<{ id: string; name: string; argsPreview: string; success?: boolean; summary?: string }> = [];
      if (m.role === 'assistant' && m.runId) {
        const runToolCalls = ss.listToolCalls(m.runId);
        toolCalls = runToolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          argsPreview: tc.argsPreview,
          success: tc.status === 'success' ? true : tc.status === 'error' ? false : undefined,
          summary: tc.summary ?? undefined,
        }));
      }
      return {
        id: m.id,
        role: m.role === 'user' ? 'user' : 'assistant',
        text: m.text,
        toolCalls,
        streaming: m.status === 'streaming',
        error: m.error,
        sessionId: m.sessionId,
        runId: m.runId ?? undefined,
        messageId: m.id,
      };
    });
    set({ turns });
  },

  _onSync: (event) => {
    const state = get();
    switch (event.type) {
      case 'canvas:full': {
        // Normalize — older server builds may omit tokens/heatmap.
        const doc = event.document;
        if (!doc.tokens) doc.tokens = { colors: [], textStyles: [] };
        if (doc.heatmap === undefined) doc.heatmap = null;
        set({ document: doc });
        break;
      }
      case 'canvas:patch': {
        set((s) => ({ document: applyPatchToCanvas(s.document, event.patch) }));
        // If this is a "select" patch from the agent, briefly highlight.
        if (event.patch.op === 'select' && event.patch.shapeIds) {
          set({ agentHighlightIds: event.patch.shapeIds });
          if (highlightTimeout) clearTimeout(highlightTimeout);
          highlightTimeout = setTimeout(() => set({ agentHighlightIds: [] }), 1500);
        }
        break;
      }
      case 'agent:message_start': {
        // Already created the placeholder assistant turn on promptAgent.
        break;
      }
      case 'agent:message_delta': {
        set((s) => {
          const turns = [...s.turns];
          const last = turns[turns.length - 1];
          if (last && last.role === 'assistant') {
            turns[turns.length - 1] = { ...last, text: last.text + event.text };
          }
          return { turns };
        });
        // Mirror to session store.
        const last = get().turns[get().turns.length - 1];
        if (last?.messageId) {
          useSessionStore.getState().appendAssistantText(last.messageId, event.text);
        }
        break;
      }
      case 'agent:message_end': {
        set((s) => {
          const turns = [...s.turns];
          const last = turns[turns.length - 1];
          if (last && last.role === 'assistant') {
            turns[turns.length - 1] = { ...last, streaming: false };
          }
          return { turns };
        });
        const last = get().turns[get().turns.length - 1];
        if (last?.messageId) {
          useSessionStore.getState().finalizeAssistantMessage(last.messageId, 'complete');
        }
        break;
      }
      case 'agent:tool_call_start': {
        set((s) => {
          const turns = [...s.turns];
          const last = turns[turns.length - 1];
          if (last && last.role === 'assistant') {
            turns[turns.length - 1] = {
              ...last,
              toolCalls: [
                ...last.toolCalls,
                {
                  id: event.toolCallId,
                  name: event.toolName,
                  argsPreview: event.argsPreview,
                },
              ],
            };
          }
          return { turns };
        });
        // Mirror to session store.
        const last = get().turns[get().turns.length - 1];
        if (last?.runId) {
          useSessionStore.getState().startToolCall(
            last.runId,
            event.toolCallId,
            event.toolName,
            event.argsPreview,
          );
        }
        break;
      }
      case 'agent:tool_call_end': {
        set((s) => {
          const turns = [...s.turns];
          const last = turns[turns.length - 1];
          if (last && last.role === 'assistant') {
            turns[turns.length - 1] = {
              ...last,
              toolCalls: last.toolCalls.map((tc) =>
                tc.id === event.toolCallId
                  ? { ...tc, success: event.success, summary: event.summary }
                  : tc,
              ),
            };
          }
          return { turns };
        });
        // Mirror to session store.
        useSessionStore.getState().endToolCall(
          event.toolCallId,
          event.success,
          event.summary,
          event.summary,
        );
        break;
      }
      case 'agent:turn_end': {
        set((s) => {
          const turns = [...s.turns];
          const last = turns[turns.length - 1];
          if (last && last.role === 'assistant') {
            turns[turns.length - 1] = { ...last, streaming: false };
          }
          return { turns, agentBusy: false };
        });
        // Capture a snapshot of the canvas at end of turn, and finalize the
        // run in the session store. Guard against duplicate turn_end events
        // (the runner emits one on normal exit AND one at generator end).
        const last = get().turns[get().turns.length - 1];
        if (last?.runId) {
          const run = useSessionStore.getState().getRun(last.runId);
          if (run && run.status === 'completed') {
            // Already finalized — skip duplicate snapshot.
            break;
          }
        }
        if (last?.sessionId) {
          useSessionStore.getState().captureSnapshot(
            last.sessionId,
            get().document,
            {
              source: 'turn_end',
              sourceRunId: last.runId ?? undefined,
              sourceMessageId: last.messageId ?? undefined,
              createdBy: 'agent',
            },
          );
          if (last.runId) {
            useSessionStore.getState().endRun(last.runId, 'completed');
          }
        }
        break;
      }
      case 'agent:error': {
        set((s) => {
          const turns = [...s.turns];
          const last = turns[turns.length - 1];
          if (last && last.role === 'assistant') {
            turns[turns.length - 1] = {
              ...last,
              streaming: false,
              error: event.message,
              text: (last.text ? last.text + '\n\n' : '') + `⚠️ ${event.message}`,
            };
          }
          return { turns, agentBusy: false };
        });
        const last = get().turns[get().turns.length - 1];
        if (last?.messageId) {
          useSessionStore.getState().finalizeAssistantMessage(
            last.messageId,
            'error',
            event.message,
          );
        }
        if (last?.runId) {
          useSessionStore.getState().endRun(last.runId, 'failed', event.message);
        }
        break;
      }
      case 'presence': {
        set({ viewerCount: event.viewerCount });
        break;
      }
      default: {
        // Ignore unknown event types.
      }
    }
  },
}));

/// Helper — find a shape by id.
export function findShape(doc: CanvasDocument, id: string): Shape | undefined {
  return doc.shapes.find((s) => s.id === id);
}

// Expose the store globally so the demo / browser console can drive the
// agent directly when the WebSocket sync is unavailable (e.g. when the
// dev server's HMR has put the socket in a bad state).
if (typeof window !== 'undefined') {
  (window as any).__canvasStore = useCanvasStore;
}
