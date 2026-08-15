// Frontend store for the canvas. Single source of truth for the React UI:
//   - Holds the current `CanvasDocument`.
//   - Receives `SyncEvent`s from the WebSocket service and applies them.
//   - Exposes actions for local (human) edits — these also emit patches
//     back through the WebSocket so other viewers (and the agent) see them.
//
// The store intentionally has no direct dependency on the Pi Agent SDK —
// the agent runs entirely on the server. The frontend only renders the
// result of tool calls (canvas patches) and the chat stream.

'use client';

import { create } from 'zustand';
import { io, type Socket } from 'socket.io-client';
import type { CanvasDocument, CanvasPatch, ClientEvent, Shape, SyncEvent } from '@/lib/canvas/types';
import { applyPatchToCanvas } from '@/lib/canvas/patch';

/// A single chat turn — either the user's prompt or the agent's response.
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

  // Actions ---------------------------------------------------------------
  init: (documentId: string) => () => void;
  sendPatch: (patch: CanvasPatch) => void;
  select: (ids: string[]) => void;
  promptAgent: (text: string) => void;
  setDocumentName: (name: string) => void;

  // Internal — called by socket event handler
  _onSync: (event: SyncEvent) => void;
}

let highlightTimeout: any;

export const useCanvasStore = create<CanvasState>((set, get) => ({
  document: {
    id: 'default',
    name: 'Untitled',
    background: '#f8fafc',
    viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes: [],
    tokens: { colors: [], textStyles: [] },
    heatmap: null,
  },
  selectedIds: [],
  agentHighlightIds: [],
  socket: null,
  connected: false,
  viewerCount: 1,
  turns: [],
  agentBusy: false,
  documentId: 'default',

  init: (documentId) => {
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
    const { socket, connected, documentId, turns } = get();
    if (!socket || !connected) return;

    // Append a user turn + a placeholder assistant turn that will be filled
    // in as events stream back.
    const userTurn: ChatTurn = {
      id: `u-${Date.now()}`,
      role: 'user',
      text,
      toolCalls: [],
      streaming: false,
    };
    const assistantTurn: ChatTurn = {
      id: `a-${Date.now()}`,
      role: 'assistant',
      text: '',
      toolCalls: [],
      streaming: true,
    };
    set({ turns: [...turns, userTurn, assistantTurn], agentBusy: true });

    socket.emit('client', { type: 'agent:prompt', documentId, prompt: text } satisfies ClientEvent);
  },

  setDocumentName: (name) =>
    set((s) => ({ document: { ...s.document, name } })),

  _onSync: (event) => {
    const state = get();
    switch (event.type) {
      case 'canvas:full': {
        set({ document: event.document });
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
