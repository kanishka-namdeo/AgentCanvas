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
  /// Image attachments staged with this user turn (paste / drop /
  /// paperclip). Stored as compact data URLs — see attachments.ts.
  images?: import('../agent/attachments').AttachedImage[];
  /// Canvas selection the user had active when sending this turn — the agent
  /// receives it as targeting context ("these/those" in the prompt).
  selection?: { count: number; names: string[] };
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
  /// Turn timing (epoch ms). Set when the assistant turn is created and
  /// finalized — powers the "N tools · Xs" footer on each turn.
  startedAt?: number;
  endedAt?: number;
  /// Cumulative tokens consumed by THIS turn's LLM calls (input + output,
  /// summed across tool-call iterations). Powers the "· 12.3K tok" footer.
  tokenUsage?: { input: number; output: number };
}

export interface AgentToolCallEntry {
  id: string;
  name: string;
  argsPreview: string;
  success?: boolean;
  summary?: string;
}

/// A real browser-measured node size (spec §3.8 measured-bounds readback).
/// Written by the DOM renderer's ResizeObserver pool in NATIVE layout mode;
/// consumed as an intrinsic-size hint by the resolver (`fit_content` nodes)
/// and (future) `pen_get_computed` / snapshot enrichment.
export interface MeasuredBounds {
  width: number;
  height: number;
}

/// The model the runner actually RESOLVED for the current turn — emitted by
/// the server as `agent:model_info` right after the LLM session is created.
/// Can differ from the configured model (settings store) when the resolver
/// applies a legacy-id mapping, first-available fallback, or the z.ai sandbox
/// fallback. Powers the model badge in the AgentPanel header.
export interface ActiveModelInfo {
  provider: string;
  modelId: string;
  label: string;
  contextWindow: number;
  maxTokens: number;
  usedFallback: boolean;
}

/// Cumulative LLM usage for the live app session (aggregated from every
/// `agent:context_update` that carries a usage payload — one per LLM call).
/// Displayed in the AgentPanel's model/context tooltip (Claude Code
/// `/context`-style breakdown) and the per-turn footers.
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  llmCalls: number;
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
  /// The RESOLVED model for the current/last turn (from agent:model_info).
  /// Null until the first turn completes resolution — the AgentPanel falls
  /// back to the CONFIGURED model from the settings store meanwhile.
  activeModel: ActiveModelInfo | null;
  /// Cumulative usage across all LLM calls this app session.
  usageTotals: UsageTotals;
  documentId: string;
  /// Active session id (mirrors sessionStore.activeSessionByDoc[documentId]).
  activeSessionId: string | null;
  /// Undo/redo stacks (client-side). Capped at 50 entries to bound memory.
  /// Pushed before every mutating patch; popped on undo/redo.
  undoStack: CanvasDocument[];
  redoStack: CanvasDocument[];
  /// Active canvas interaction tool. 'select' = click-to-select (default).
  /// 'pan' = click-and-drag pans the canvas (sticky pan mode). 'scale' =
  /// Figma's K tool — resize handles scale the layer proportionally
  /// (width/height/fontSize/strokeWidth, spec Phase 7). The Space-held
  /// shortcut in Canvas.tsx overrides this temporarily.
  toolMode: 'select' | 'pan' | 'scale';

  // ---- View flags (spec Phase 7 — Appendix H view options) ------------------
  /// EPHEMERAL shell-level view state (follows the measuredBounds pattern:
  /// NOT part of undo snapshots, NOT persisted — they are viewer-chrome
  /// concerns, not document content).
  /// ⌘' pixel grid backdrop visibility (default on — preserves pre-Phase-7
  /// behavior where the grid always rendered).
  pixelGridVisible: boolean;
  /// ⌘⇧' snap-to-pixel: drag/resize results are rounded to integer canvas
  /// coordinates before the patch is emitted (default off).
  snapToPixel: boolean;
  /// ⌘⇧O outline mode: fills stripped to transparent + 1px outlines (DOM
  /// renderer only — see globals.css [data-ac-outline]; default off).
  outlineMode: boolean;
  setViewFlag: (flag: 'pixelGridVisible' | 'snapToPixel' | 'outlineMode', value: boolean) => void;
  toggleViewFlag: (flag: 'pixelGridVisible' | 'snapToPixel' | 'outlineMode') => void;

  // ---- Measured-bounds readback (spec §3.8) --------------------------------
  /// REAL browser-measured node sizes keyed by node id (native DOM layout
  /// mode only). EPHEMERAL runtime state — follows the agentHighlightIds
  /// pattern exactly: NOT part of undo snapshots (undo/redo restore
  /// `document` only), NOT persisted (the canvas store has no persist
  /// middleware), and writing it NEVER recomputes `document`. It is a
  /// one-way readback cache: model → DOM → measure → cache; the cache only
  /// re-enters as a HINT on the NEXT document mutation (recomputeDerived),
  /// so there is no layout feedback loop.
  measuredBounds: Record<string, MeasuredBounds>;
  /// Merge one measured bound (from the ResizeObserver pool's rAF flush).
  setMeasuredBounds: (id: string, bounds: MeasuredBounds) => void;
  /// Merge many measured bounds at once (batch variant).
  setMeasuredBoundsMany: (entries: Record<string, MeasuredBounds> | Array<[string, MeasuredBounds]>) => void;
  /// Push the current measured-bounds digest to the server (socket event +
  /// POST) so the SERVER-side map stays fresh for canvasSnapshot enrichment
  /// (spec §5.5) and pen_bake_layout. Throttled by DomCanvas (800ms trailing).
  pushMeasuredBounds: () => void;

  // ---- Client round-trip state (spec §5.2 / Phase 3, M2-c) -----------------
  /// The DOM renderer's world element ([data-ac-world]) — registered by
  /// DomCanvas on mount (BOTH layout modes; parity rects stay valid), cleared
  /// on unmount. EPHEMERAL runtime field like measuredBounds: not persisted,
  /// not part of undo snapshots. The round-trip handlers read live DOM
  /// geometry relative to this element (screen→canvas-space conversion).
  worldElement: HTMLElement | null;
  /// Register/unregister the world element (DomCanvas useEffect).
  setWorldElement: (el: HTMLElement | null) => void;

  // ---- Plugin state (Phase 5) ---------------------------------------------
  /// Pending ask_user_question — set when the agent emits
  /// `agent:ask_user_question`. The AgentPanel renders a dialog from this.
  /// Cleared when the user submits answers (POST /api/agent/answers).
  pendingQuestion: {
    toolCallId: string;
    questions: Array<{
      question: string;
      header?: string;
      multiSelect?: boolean;
      options: Array<{ label: string; description?: string }>;
    }>;
  } | null;
  /// Live todo list — updated by `agent:todo_update` events from the
  /// todo plugin. Rendered as an overlay in the AgentPanel.
  todos: Array<{
    id: string;
    text: string;
    status: 'pending' | 'in_progress' | 'completed' | 'blocked';
    note?: string;
  }>;
  /// Background tasks — tracked here for the AgentPanel's task list.
  backgroundTasks: Array<{
    taskId: string;
    taskType: string;
    description: string;
    status: 'started' | 'complete';
    success?: boolean;
    summary?: string;
  }>;
  /// MCP server statuses — tracked here for the Settings → MCP Servers panel.
  mcpServers: Array<{
    serverId: string;
    status: 'connected' | 'disconnected' | 'error';
    message?: string;
    toolCount?: number;
  }>;

  // Actions ---------------------------------------------------------------
  init: (documentId: string) => () => void;
  sendPatch: (patch: CanvasPatch) => void;
  select: (ids: string[]) => void;
  promptAgent: (
    text: string,
    images?: import('../agent/attachments').AttachedImage[],
    selection?: { count: number; names: string[] },
  ) => void;
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
  /// Set the active canvas tool mode ('select', 'pan' or 'scale').
  setToolMode: (mode: 'select' | 'pan' | 'scale') => void;
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

  // ---- Plugin actions (Phase 5) -------------------------------------------
  /// Submit answers (or cancel) a pending ask_user_question. POSTs to
  /// /api/agent/answers, which resolves the pending tool call on the server.
  submitQuestionAnswers: (toolCallId: string, answers: string[][], cancelled: boolean) => Promise<void>;
  /// Clear the todo list (client-side — does NOT affect the server's todo state).
  clearTodos: () => void;
}

let highlightTimeout: any;
/// AbortController for the in-flight agent HTTP request (fallback path).
/// Null when no request is in flight, or when the agent is running over the
/// WebSocket (which doesn't currently support cancellation — stopAgent will
/// still finalize the local turn, but the server will keep running to
/// completion and its events will arrive afterwards; they're a no-op because
/// `agentBusy` is already false).
let agentAbort: AbortController | null = null;

// ---- Client round-trip helpers (spec §5.2/§5.4, Phase 3 — M2-c) ------------
//
// The server-side tools (pen_get_computed / pen_get_screenshot / the VLM
// critic) emit `agent:computed_request` / `agent:screenshot_request`
// SyncEvents; the handlers below read the LIVE DOM and POST the answer to
// /api/agent/client-responses, which resolves the tool's pending promise.
// The server never waits forever: it falls back to resolver data after its
// own timeout, so a failed POST here is harmless.

/// Curated computed-style subset (spec §5.2 "~20-prop subset"). Keys are the
/// camelCase names the agent sees; values are the CSS property names for
/// getComputedStyle.getPropertyValue.
const COMPUTED_PROPERTIES: Array<[string, string]> = [
  ['display', 'display'],
  ['position', 'position'],
  ['width', 'width'],
  ['height', 'height'],
  ['backgroundColor', 'background-color'],
  ['color', 'color'],
  ['fontFamily', 'font-family'],
  ['fontSize', 'font-size'],
  ['fontWeight', 'font-weight'],
  ['lineHeight', 'line-height'],
  ['letterSpacing', 'letter-spacing'],
  ['textAlign', 'text-align'],
  ['borderRadius', 'border-radius'],
  ['boxShadow', 'box-shadow'],
  ['opacity', 'opacity'],
  ['transform', 'transform'],
  ['zIndex', 'z-index'],
  ['overflow', 'overflow'],
  ['flexDirection', 'flex-direction'],
  ['gap', 'gap'],
  ['paddingTop', 'padding-top'],
  ['paddingRight', 'padding-right'],
  ['paddingBottom', 'padding-bottom'],
  ['paddingLeft', 'padding-left'],
  ['marginTop', 'margin-top'],
  ['marginBottom', 'margin-bottom'],
  ['marginLeft', 'margin-left'],
  ['marginRight', 'margin-right'],
  ['flex', 'flex'],
  ['alignItems', 'align-items'],
  ['justifyContent', 'justify-content'],
  ['cursor', 'cursor'],
  ['visibility', 'visibility'],
];

function escapeAttrValue(v: string): string {
  return v.replace(/["\\]/g, '\\$&');
}

async function postClientResponse(payload: Record<string, unknown>): Promise<void> {
  try {
    await fetch('/api/agent/client-responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // Network failure — the server's pending round-trip times out on its
    // own and falls back; nothing to surface to the user.
    console.error('[client-roundtrip] response POST failed:', err);
  }
}

/// Collect getComputedStyle + getBoundingClientRect for one node id.
/// Screen-space rect comes straight from the DOM; canvasRect divides out
/// the world transform (zoom + pan) so the agent sees canvas coordinates.
function readComputedForNode(
  id: string,
  worldRect: { x: number; y: number } | null,
  zoom: number,
  properties?: string[],
): { id: string; missing: true } | {
  id: string;
  rect: { x: number; y: number; width: number; height: number };
  canvasRect?: { x: number; y: number; width: number; height: number };
  computed: Record<string, string>;
} {
  if (typeof document === 'undefined') return { id, missing: true };
  const el = document.querySelector(`[data-node-id="${escapeAttrValue(id)}"]`);
  if (!el) return { id, missing: true };
  const r = el.getBoundingClientRect();
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
  const computed: Record<string, string> = {};
  if (cs) {
    const wanted = properties && properties.length > 0
      ? COMPUTED_PROPERTIES.filter(([camel]) => properties.includes(camel))
      : COMPUTED_PROPERTIES;
    for (const [camel, css] of wanted) {
      computed[camel] = cs.getPropertyValue(css);
    }
  }
  const z = zoom > 0 ? zoom : 1;
  return {
    id,
    rect: {
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height),
    },
    canvasRect: worldRect
      ? {
          x: Math.round((r.x - worldRect.x) / z),
          y: Math.round((r.y - worldRect.y) / z),
          width: Math.round(r.width / z),
          height: Math.round(r.height / z),
        }
      : undefined,
    computed,
  };
}

/// agent:computed_request handler — read live DOM, POST results.
function handleComputedRequest(event: Extract<SyncEvent, { type: 'agent:computed_request' }>): void {
  const { worldElement, document } = useCanvasStore.getState();
  const worldRect = worldElement ? worldElement.getBoundingClientRect() : null;
  const zoom = document.viewport?.zoom ?? 1;
  const results = event.nodeIds.map((id) => readComputedForNode(id, worldRect ? { x: worldRect.x, y: worldRect.y } : null, zoom, event.properties));
  // Missing nodes (SVG renderer / unmounted) are simply omitted — the tool
  // falls back to resolver data per node.
  const found = results.filter((r): r is Exclude<typeof r, { missing: true }> => !('missing' in r));
  void postClientResponse({ kind: 'computed', toolCallId: event.toolCallId, results: found });
}

/// agent:screenshot_request handler — capture the real world element via
/// html-to-image and POST the data URL. Dynamic import keeps the ~10kB lib
/// out of the initial bundle (only loads when the agent asks for a shot).
async function handleScreenshotRequest(event: Extract<SyncEvent, { type: 'agent:screenshot_request' }>): Promise<void> {
  const { worldElement, document } = useCanvasStore.getState();
  if (!worldElement) {
    // SVG renderer (or nothing) mounted — no DOM renderer to capture.
    await postClientResponse({ kind: 'screenshot', toolCallId: event.toolCallId, error: 'no-dom-renderer' });
    return;
  }
  try {
    const { toPng } = await import('html-to-image');
    const dataUrl = await toPng(worldElement, {
      pixelRatio: typeof event.scale === 'number' && event.scale > 0 ? event.scale : 2,
      backgroundColor: document.background,
    });
    await postClientResponse({ kind: 'screenshot', toolCallId: event.toolCallId, dataUrl });
  } catch (err) {
    await postClientResponse({
      kind: 'screenshot',
      toolCallId: event.toolCallId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

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
  activeModel: null,
  usageTotals: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    llmCalls: 0,
  },
  documentId: 'default',
  activeSessionId: null,
  undoStack: [],
  redoStack: [],
  toolMode: 'select',
  pixelGridVisible: true,
  snapToPixel: false,
  outlineMode: false,
  measuredBounds: {},
  worldElement: null,

  setViewFlag: (flag, value) => set({ [flag]: value } as Partial<CanvasState>),
  toggleViewFlag: (flag) =>
    set((s) => ({ [flag]: !s[flag] } as Partial<CanvasState>)),

  setWorldElement: (el) => {
    // Only clear when the SAME element is still registered (a remount may
    // have already registered its replacement — don't clobber it).
    if (el === null && get().worldElement) {
      set({ worldElement: null });
      return;
    }
    if (el) set({ worldElement: el });
  },

  pushMeasuredBounds: () => {
    const { measuredBounds, documentId, socket, connected } = get();
    const ids = Object.keys(measuredBounds);
    if (ids.length === 0) return; // nothing measured (parity mode / jsdom)
    if (socket && connected) {
      // Same send path as every other ClientEvent (canvas:patch etc.).
      socket.emit('client', {
        type: 'canvas:measured_bounds',
        documentId,
        bounds: measuredBounds,
      } satisfies ClientEvent);
    }
    // POST copy — keeps the Next.js process's server-side map fresh even
    // when the socket path is the standalone mini-service process.
    fetch('/api/agent/client-responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'measured_bounds', documentId, bounds: measuredBounds }),
    }).catch(() => {
      /* fire-and-forget — the next throttle tick retries */
    });
  },

  setMeasuredBounds: (id, bounds) =>
    set((s) => ({
      measuredBounds: { ...s.measuredBounds, [id]: bounds },
    })),

  setMeasuredBoundsMany: (entries) =>
    set((s) => {
      const next = { ...s.measuredBounds };
      if (Array.isArray(entries)) {
        for (const [id, bounds] of entries) next[id] = bounds;
      } else {
        Object.assign(next, entries);
      }
      return { measuredBounds: next };
    }),

  // Plugin state (Phase 5)
  pendingQuestion: null,
  todos: [],
  backgroundTasks: [],
  mcpServers: [],

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
        document: applyPatchToCanvas(s.document, patch, { measuredBounds: s.measuredBounds }),
      }));
    } else {
      set((s) => ({ document: applyPatchToCanvas(s.document, patch, { measuredBounds: s.measuredBounds }) }));
    }
  },

  select: (ids) => set({ selectedIds: ids }),

  promptAgent: (text, images, selection) => {
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
    // Prefer the RESOLVED model from the previous turn (agent:model_info)
    // so run records carry the real model, not the 'unresolved' seed.
    const resolvedModel = get().activeModel?.modelId;
    const run = useSessionStore
      .getState()
      .startRun(sessionId, text, 'user_message', resolvedModel);
    // Auto-title if this is the first message.
    useSessionStore.getState().autoTitleFromPrompt(sessionId, text);
    // Append user message + assistant placeholder.
    const userMsg = useSessionStore.getState().appendUserMessage(sessionId, run.id, text, images, selection);
    const assistantMsg = useSessionStore.getState().appendAssistantMessage(sessionId, run.id);

    // Mirror into the live `turns` buffer.
    const userTurn: ChatTurn = {
      id: userMsg.id,
      role: 'user',
      text,
      startedAt: Date.now(),
      // Attachments travel with the turn so every viewer (and the session
      // history) can render the thumbnails.
      ...(images && images.length > 0 ? { images } : {}),
      ...(selection ? { selection } : {}),
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
      startedAt: Date.now(),
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
        // Image attachments — the sync server forwards them to /api/agent,
        // which hands them to the runner → session.prompt({ images }).
        ...(images && images.length > 0 ? { images } : {}),
        // Canvas selection — targeting context for "these/those" prompts.
        ...(selection ? { selection } : {}),
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
          body: JSON.stringify({
            documentId,
            prompt: text,
            canvasState: get().document,
            settings,
            ...(images && images.length > 0 ? { images } : {}),
            ...(selection ? { selection } : {}),
          }),
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
                // D5: `_onSync` is the SINGLE applier in the fallback path —
                // it applies the patch and pushes the pre-mutation document to
                // the undo stack. (An early apply here used to double-apply
                // every patch — e.g. an `add` produced two nodes with the same
                // id — masked only by the renderer's render-time id dedupe.)
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
          turns[turns.length - 1] = { ...li, streaming: false, endedAt: Date.now() };
        }
        return { turns, agentBusy: false };
      });
    }
  },

  steerAgent: (text) => {
    const { agentBusy, socket, connected, documentId } = get();
    if (!agentBusy || !text.trim()) return;
    // Steer ONLY works over the live WebSocket path — the HTTP fallback
    // request is already in flight and can't be amended. Previously this
    // toasted "Steer sent" even when the socket was down (silent drop + a
    // lying toast). Now the fallback mode says so.
    if (socket && connected) {
      socket.emit('client', {
        type: 'agent:steer',
        documentId,
        text,
      } satisfies ClientEvent);
      try {
        import('sonner').then(({ toast }) => {
          toast.info('Steer sent', { description: text.slice(0, 100) });
        });
      } catch {
        // sonner not available — skip.
      }
      return;
    }
    try {
      import('sonner').then(({ toast }) => {
        toast.warning('Steering needs a live connection', {
          description: 'The agent is running over the direct-HTTP fallback, which cannot be steered mid-turn. Use Stop and resend instead.',
        });
      });
    } catch {
      // sonner not available — skip.
    }
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
    const { documentId, agentBusy } = get();
    // Guard: switching sessions mid-turn would replace `document` while the
    // streaming agent keeps patching the old one (incoming patches would land
    // on the NEW session's canvas, and `_onSync` would append to `turns`
    // rebuilt for the new session — corrupting both). The user must stop the
    // agent first. (The SessionSidebar buttons should also be disabled —
    // this is the store-level backstop.)
    if (agentBusy) {
      try {
        import('sonner').then(({ toast }) => {
          toast.warning('Agent is running', { description: 'Stop the agent before switching chats.' });
        });
      } catch { /* sonner unavailable */ }
      return;
    }
    const ss = useSessionStore.getState();
    const session = ss.getSession(sessionId);
    if (!session || session.documentId !== documentId) return;
    ss.setActiveSession(documentId, sessionId);
    set({ activeSessionId: sessionId });
    // Load the session's current snapshot. Measured bounds from the previous
    // document are stale (ids don't carry over) — clear the readback cache.
    if (session.currentSnapshotId) {
      const snap = ss.getSnapshot(session.currentSnapshotId);
      if (snap) {
        set({ document: { ...snap.document, id: documentId }, measuredBounds: {} });
      }
    } else {
      set({ document: { ...EMPTY_DOC, id: documentId, name: session.title }, measuredBounds: {} });
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
        // Attachments persist on the session-store message (localStorage)
        // — rehydrate them into the live turn so history keeps its thumbnails.
        ...(m.images && m.images.length > 0 ? { images: m.images } : {}),
        ...(m.selection ? { selection: m.selection } : {}),
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
        set({ document: doc, measuredBounds: {} });
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
            document: applyPatchToCanvas(s.document, event.patch, { measuredBounds: s.measuredBounds }),
          }));
        } else {
          set((s) => ({ document: applyPatchToCanvas(s.document, event.patch, { measuredBounds: s.measuredBounds }) }));
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
            turns[turns.length - 1] = { ...last, streaming: false, endedAt: Date.now() };
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
      case 'agent:model_info': {
        // The runner resolved a model (may differ from the configured one —
        // e.g. the z.ai sandbox fallback). Store it for the AgentPanel badge
        // and sync the session-store's model so SessionHeader shows the REAL
        // model instead of the stale seed value. Also adopt the model's true
        // context window immediately so the usage bar + tooltip are correct
        // even before the first LLM call reports usage.
        set({
          activeModel: {
            provider: event.provider,
            modelId: event.modelId,
            label: event.label,
            contextWindow: event.contextWindow,
            maxTokens: event.maxTokens,
            usedFallback: event.usedFallback ?? false,
          },
          contextWindow: event.contextWindow,
        });
        const sid = get().activeSessionId;
        if (sid) {
          try {
            useSessionStore.getState().setSessionModel(sid, event.modelId);
          } catch { /* session may have been deleted mid-turn — non-fatal */ }
        }
        break;
      }
      case 'agent:context_update': {
        // Track token usage for the UI (Phase 1: context management).
        // Extended (model+context feature): when the event carries a usage
        // payload (one per LLM call, emitted from the translator's
        // message_end), also accumulate session-wide totals and the
        // per-turn token footer, and store the last call's breakdown for
        // the tooltip.
        const prevTotals = get().usageTotals;
        const usage = event.usage;
        const nextTotals = usage
          ? {
              inputTokens: prevTotals.inputTokens + usage.input,
              outputTokens: prevTotals.outputTokens + usage.output,
              cacheReadTokens: prevTotals.cacheReadTokens + usage.cacheRead,
              cacheWriteTokens: prevTotals.cacheWriteTokens + usage.cacheWrite,
              cost: prevTotals.cost + usage.cost,
              llmCalls: prevTotals.llmCalls + 1,
            }
          : prevTotals;
        set((s) => ({
          contextTokens: event.tokenCount,
          contextWindow: event.contextWindow,
          lastCompacted: event.compacted ?? false,
          usageTotals: nextTotals,
          turns: usage
            ? s.turns.map((t, i) =>
                i === s.turns.length - 1 && t.role === 'assistant'
                  ? {
                      ...t,
                      tokenUsage: {
                        input: (t.tokenUsage?.input ?? 0) + usage.input,
                        output: (t.tokenUsage?.output ?? 0) + usage.output,
                      },
                    }
                  : t,
              )
            : s.turns,
        }));
        break;
      }
      // ---- Plugin events (Phase 5) ------------------------------------------
      // ---- Client round-trip requests (Phase 3, M2-c) ----------------------
      case 'agent:computed_request': {
        // Read the live DOM and POST the computed-style results. Fire and
        // forget — the tool's server-side timeout bounds the wait.
        handleComputedRequest(event);
        break;
      }
      case 'agent:screenshot_request': {
        void handleScreenshotRequest(event);
        break;
      }
      case 'agent:ask_user_question': {
        // The agent is asking the user a structured question. Store it;
        // the AgentPanel renders a dialog. Cleared when the user submits
        // answers via submitQuestionAnswers().
        set({ pendingQuestion: { toolCallId: event.toolCallId, questions: event.questions } });
        break;
      }
      case 'agent:ask_user_answered': {
        // The user submitted answers (or cancelled). Clear the pending question.
        set({ pendingQuestion: null });
        break;
      }
      case 'agent:todo_update': {
        set({ todos: event.todos });
        break;
      }
      case 'agent:background_task_started': {
        set((s) => ({
          backgroundTasks: [
            ...s.backgroundTasks.filter((t) => t.taskId !== event.taskId),
            { taskId: event.taskId, taskType: event.taskType, description: event.description, status: 'started' as const },
          ],
        }));
        break;
      }
      case 'agent:background_task_complete': {
        set((s) => ({
          backgroundTasks: [
            ...s.backgroundTasks.filter((t) => t.taskId !== event.taskId),
            {
              taskId: event.taskId,
              taskType: s.backgroundTasks.find((t) => t.taskId === event.taskId)?.taskType ?? 'unknown',
              description: s.backgroundTasks.find((t) => t.taskId === event.taskId)?.description ?? '',
              status: 'complete' as const,
              success: event.success,
              summary: event.summary,
            },
          ],
        }));
        break;
      }
      case 'agent:mcp_server_status': {
        set((s) => ({
          mcpServers: [
            ...s.mcpServers.filter((m) => m.serverId !== event.serverId),
            { serverId: event.serverId, status: event.status, message: event.message, toolCount: event.toolCount },
          ],
        }));
        break;
      }
      default: {
        // Ignore unknown event types.
      }
    }
  },

  // ---- Plugin actions (Phase 5) -------------------------------------------
  submitQuestionAnswers: async (toolCallId, answers, cancelled) => {
    set({ pendingQuestion: null });
    try {
      await fetch('/api/agent/answers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolCallId, answers, cancelled }),
      });
    } catch (err) {
      // Network error — the server's pending question will time out after 5 min.
      console.error('Failed to submit question answers:', err);
    }
  },

  clearTodos: () => set({ todos: [] }),
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
