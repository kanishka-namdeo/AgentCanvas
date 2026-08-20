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
import { toast } from 'sonner';
import type { CanvasDocument, CanvasPatch, ClientEvent, Shape, SyncEvent } from '@/lib/canvas/types';
import { createEmptyCanvasDocument } from '@/lib/canvas/types';
import { applyPatchToCanvas } from '@/lib/canvas/patch';
import { resolvePenTree } from '@/lib/pen/resolve';
import { useSessionStore, hydrateSessionStore } from '@/lib/sessions';
import { useSettings } from '@/lib/settings/store';
import { agentRunSettings } from '@/lib/settings/types';

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
  /// Skill selected by the intent classifier for this turn (Tier 1).
  skillInfo?: {
    category: string;
    confidence: number;
    method: string;
    toolCount: number;
  };
  /// Execution plan for multi-step tasks (Tier 2).
  plan?: Array<{
    step: number;
    description: string;
    skill: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
  }>;
  /// Sub-agents dispatched during this turn (Tier 2).
  subAgents?: Array<{
    type: string;
    task: string;
    status: 'running' | 'completed' | 'failed';
    summary?: string;
    toolCalls?: number;
  }>;
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
  /// Context token tracking (Phase 1: context management).
  contextTokens: number;
  contextWindow: number;
  lastCompacted: boolean;
  documentId: string;
  /// Active session id (mirrors sessionStore.activeSessionByDoc[documentId]).
  activeSessionId: string | null;
  /// Undo/redo stacks (client-side). Capped at 50 entries to bound memory.
  /// Pushed before every mutating patch; popped on undo/redo.
  undoStack: CanvasDocument[];
  redoStack: CanvasDocument[];
  /// Active canvas interaction tool. 'select' = click-to-select (default).
  /// 'pan' = click-and-drag pans the canvas (sticky pan mode). The Space-held
  /// shortcut in Canvas.tsx overrides this temporarily.
  toolMode: 'select' | 'pan';

  // Actions ---------------------------------------------------------------
  init: (documentId: string) => () => void;
  sendPatch: (patch: CanvasPatch) => void;
  select: (ids: string[]) => void;
  promptAgent: (text: string) => void;
  /// Queue a steering message to be delivered to the agent mid-turn.
  /// The agent will receive this after its current tool batch, before the
  /// next LLM call — letting the user redirect without waiting for the
  /// full turn to complete.
  steerAgent: (text: string) => void;
  /// Stop the in-flight agent turn. Aborts the HTTP fetch (when in fallback
  /// mode), finalizes the last assistant message + run as `cancelled`, and
  /// emits a synthetic `agent:turn_end` so the rest of the pipeline (snapshot
  /// capture, run closeout) runs as if the agent had finished normally.
  stopAgent: () => void;
  /// Undo the last canvas change. Pops the undo stack.
  undo: () => void;
  /// Redo a previously undone change. Pops the redo stack.
  redo: () => void;
  /// Set the active canvas tool mode ('select' or 'pan').
  setToolMode: (mode: 'select' | 'pan') => void;
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
/// AbortController for the in-flight agent HTTP request (fallback path).
/// Null when no request is in flight, or when the agent is running over the
/// WebSocket (which doesn't currently support cancellation — stopAgent will
/// still finalize the local turn, but the server will keep running to
/// completion and its events will arrive afterwards; they're a no-op because
/// `agentBusy` is already false).
let agentAbort: AbortController | null = null;

const EMPTY_DOC: CanvasDocument = createEmptyCanvasDocument('default', 'Untitled');

export const useCanvasStore = create<CanvasState>((set, get) => ({
  document: EMPTY_DOC,
  selectedIds: [],
  agentHighlightIds: [],
  socket: null,
  connected: false,
  viewerCount: 1,
  turns: [],
  agentBusy: false,
  contextTokens: 0,
  contextWindow: 128_000,
  lastCompacted: false,
  documentId: 'default',
  activeSessionId: null,
  undoStack: [],
  redoStack: [],
  toolMode: 'select',

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
    // Push to undo stack for mutating ops (matches the _onSync behavior).
    // Non-mutating ops (select) don't push. This ensures undo works for
    // manual edits made while disconnected from the WS service.
    const isMutating = patch.op !== 'select';
    if (isMutating) {
      set((s) => ({
        undoStack: [...s.undoStack, s.document].slice(-50),
        redoStack: [], // clear redo on new mutation
        document: applyPatchToCanvas(s.document, patch),
      }));
    } else {
      set((s) => ({ document: applyPatchToCanvas(s.document, patch) }));
    }
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
    //
    // Both paths inject the user's agent-run settings (temperature,
    // maxIterations, planFirst, defaultPalette, skillSelectionMode,
    // LLM provider config) from the settings store.
    const settings = agentRunSettings(useSettings.getState());
    if (socket && connected) {
      socket.emit('client', {
        type: 'agent:prompt',
        documentId,
        prompt: text,
        settings,
      } satisfies ClientEvent);
      return;
    }

    // Fallback: direct HTTP fetch to /api/agent. Apply patches + agent
    // events directly to local state. This is single-viewer only.
    agentAbort = new AbortController();
    const signal = agentAbort.signal;
    (async () => {
      try {
        const res = await fetch('/api/agent', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ documentId, prompt: text, canvasState: get().document, settings }),
          signal,
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
        if (err?.name === 'AbortError') {
          // User clicked Stop — finalize as cancelled. Don't surface an error.
          get()._onSync({ type: 'agent:turn_end' });
        } else {
          get()._onSync({ type: 'agent:error', message: err?.message ?? 'unknown error' });
        }
      } finally {
        agentAbort = null;
      }
    })();
  },

  stopAgent: () => {
    const { agentBusy } = get();
    if (!agentBusy) return;
    // Abort the in-flight HTTP fetch (if any).
    if (agentAbort) {
      agentAbort.abort();
      agentAbort = null;
    } else {
      // WebSocket path — server will keep running but we finalize locally.
      // The synthetic turn_end below mirrors the closeout that _onSync does
      // for the natural-completion path.
      const last = get().turns[get().turns.length - 1];
      if (last?.messageId) {
        useSessionStore.getState().finalizeAssistantMessage(last.messageId, 'complete');
      }
      if (last?.runId) {
        const ss = useSessionStore.getState();
        const run = ss.getRun(last.runId);
        if (run && run.status !== 'completed' && run.status !== 'failed') {
          ss.endRun(last.runId, 'cancelled');
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
            createdBy: 'user',
          },
        );
      }
      set((s) => {
        const turns = [...s.turns];
        const li = turns[turns.length - 1];
        if (li && li.role === 'assistant') {
          turns[turns.length - 1] = { ...li, streaming: false };
        }
        return { turns, agentBusy: false };
      });
    }
  },

  steerAgent: (text) => {
    const { agentBusy, socket, connected, documentId } = get();
    if (!agentBusy || !text.trim()) return;
    // If WebSocket is connected, send the steer via the socket.
    // The server-side canvas-sync service will inject it into the running agent.
    if (socket && connected) {
      socket.emit('client', {
        type: 'agent:steer',
        documentId,
        text,
      } as any);
      return;
    }
    // Fallback: for the HTTP path, we can't truly steer mid-stream (the
    // fetch is already in flight). Instead, we queue the message as a
    // follow-up that will be sent after the current turn ends.
    // For now, just show a toast — true steer requires the SDK's session.steer().
    // This is a Phase 2 placeholder; full steer support requires migrating
    // to createAgentSession().
  },

  undo: () => {
    const { undoStack, document, redoStack } = get();
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1];
    set({
      document: prev,
      undoStack: undoStack.slice(0, -1),
      redoStack: [...redoStack, document].slice(-50),
    });
  },

  redo: () => {
    const { redoStack, document, undoStack } = get();
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    set({
      document: next,
      redoStack: redoStack.slice(0, -1),
      undoStack: [...undoStack, document].slice(-50),
    });
  },

  setToolMode: (mode) => set({ toolMode: mode }),

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
    // If fromMessageId is provided, try to fork from the snapshot captured at
    // the end of that message's turn (not the parent's currentSnapshotId).
    // This makes "Fork from this message" actually seed the fork from that
    // point in history.
    if (fromMessageId) {
      // Find the snapshot whose sourceMessageId === fromMessageId.
      // If not found, fall back to the closest earlier snapshot.
      const session = ss.sessions[activeSessionId];
      if (session) {
        const allSnaps = session.snapshotIds
          .map((id) => ss.snapshots[id])
          .filter(Boolean)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const exact = allSnaps.find((s) => s.sourceMessageId === fromMessageId);
        // Or: the most recent snapshot at or before the message's turn.
        // For simplicity, use exact match if found; otherwise fall through to default forkSession.
        if (exact) {
          const fork = ss.forkSessionFromSnapshot(activeSessionId, exact.id);
          if (fork) {
            get().switchSession(fork.id);
            return fork.id;
          }
        }
      }
    }
    // Default: fork from the parent's currentSnapshotId (latest state).
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
        // Normalize — older server builds may omit the derived caches.
        const doc = event.document;
        if (!doc.children) doc.children = [];
        if (!doc.shapes) doc.shapes = resolvePenTree(doc);
        if (!doc.tokens) doc.tokens = { colors: [], textStyles: [] };
        if (!doc.viewport) doc.viewport = { zoom: 1, panX: 120, panY: 80 };
        set({ document: doc });
        break;
      }
      case 'canvas:patch': {
        // Intercept undo/redo — these require access to the undo/redo stacks.
        if (event.patch.op === 'undo') {
          get().undo();
          break;
        }
        if (event.patch.op === 'redo') {
          get().redo();
          break;
        }
        // For all other mutating ops, push the current document to the undo
        // stack before applying. Non-mutating ops (select) don't push.
        const isMutating = event.patch.op !== 'select';
        if (isMutating) {
          set((s) => ({
            undoStack: [...s.undoStack, s.document].slice(-50),
            redoStack: [], // clear redo on new mutation
            document: applyPatchToCanvas(s.document, event.patch),
          }));
        } else {
          set((s) => ({ document: applyPatchToCanvas(s.document, event.patch) }));
        }
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
          // Snapshot cadence — respect the user's settings. Default is
          // 'every-turn'. 'every-N-turns' captures only on every Nth turn
          // (using the session's runCount as the counter). 'manual' skips
          // auto-capture entirely; the user must use the History panel's
          // "Capture current state" button.
          const cadence = useSettings.getState().snapshotCadence;
          const maxSnaps = useSettings.getState().maxSnapshotsPerSession;
          const sess = useSessionStore.getState().sessions[last.sessionId];
          const turnNumber = sess?.runCount ?? 0;
          const shouldCapture =
            cadence === 'every-turn' ||
            (cadence === 'every-3-turns' && turnNumber % 3 === 0) ||
            (cadence === 'every-5-turns' && turnNumber % 5 === 0);
          // cadence === 'manual' → shouldCapture stays false

          if (shouldCapture) {
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
            // Enforce max snapshots per session — trim oldest, but never
            // delete bookmarked snapshots (the user marked them as keepers).
            if (sess && sess.snapshotIds.length >= maxSnaps) {
              const allSnaps = useSessionStore.getState().snapshots;
              const candidates = sess.snapshotIds
                .map((id) => allSnaps[id])
                .filter((s) => s && !s.bookmarked)
                .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
              const excess = (sess.snapshotIds.length + 1) - maxSnaps;
              for (let i = 0; i < excess && i < candidates.length; i++) {
                useSessionStore.getState().deleteSnapshot?.(candidates[i].id);
              }
            }
          }
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
        // Surface a toast so users who aren't watching the chat panel notice the failure.
        toast.error('Agent error', {
          description: event.message?.slice(0, 200) ?? 'Unknown error',
        });
        break;
      }
      case 'presence': {
        set({ viewerCount: event.viewerCount });
        break;
      }
      case 'agent:skill_selected': {
        // Store the selected skill for UI display. Don't disrupt the turn.
        set((s) => {
          const turns = [...s.turns];
          const last = turns[turns.length - 1];
          if (last && last.role === 'assistant') {
            turns[turns.length - 1] = {
              ...last,
              skillInfo: {
                category: event.category,
                confidence: event.confidence,
                method: event.method,
                toolCount: event.toolCount,
              },
            };
          }
          return { turns };
        });
        break;
      }
      case 'agent:plan': {
        // Store the plan for UI display.
        set((s) => {
          const turns = [...s.turns];
          const last = turns[turns.length - 1];
          if (last && last.role === 'assistant') {
            turns[turns.length - 1] = {
              ...last,
              plan: event.steps.map((st) => ({
                step: st.step,
                description: st.description,
                skill: st.skill as any,
                status: st.status as any,
              })),
            };
          }
          return { turns };
        });
        break;
      }
      case 'agent:plan_step_update': {
        // Update a plan step's status.
        set((s) => {
          const turns = [...s.turns];
          const last = turns[turns.length - 1];
          if (last?.plan) {
            turns[turns.length - 1] = {
              ...last,
              plan: last.plan.map((ps) =>
                ps.step === event.step
                  ? { ...ps, status: event.status as any }
                  : ps,
              ),
            };
          }
          return { turns };
        });
        break;
      }
      case 'agent:subagent_dispatch': {
        // Show the sub-agent dispatch in the chat.
        set((s) => {
          const turns = [...s.turns];
          const last = turns[turns.length - 1];
          if (last && last.role === 'assistant') {
            const subAgents = [...(last.subAgents || []), {
              type: event.subAgentType,
              task: event.task,
              status: 'running' as const,
            }];
            turns[turns.length - 1] = { ...last, subAgents };
          }
          return { turns };
        });
        break;
      }
      case 'agent:subagent_result': {
        // Update the sub-agent result.
        set((s) => {
          const turns = [...s.turns];
          const last = turns[turns.length - 1];
          if (last?.subAgents) {
            const subAgents = last.subAgents.map((sa) =>
              sa.type === event.subAgentType && sa.status === 'running'
                ? {
                    ...sa,
                    status: event.success ? ('completed' as const) : ('failed' as const),
                    summary: event.summary,
                    toolCalls: event.toolCalls,
                  }
                : sa,
            );
            turns[turns.length - 1] = { ...last, subAgents };
          }
          return { turns };
        });
        break;
      }
      case 'agent:context_update': {
        // Track token usage for the UI (Phase 1: context management).
        set({
          contextTokens: event.tokenCount,
          contextWindow: event.contextWindow,
          lastCompacted: event.compacted ?? false,
        });
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
