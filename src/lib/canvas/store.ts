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
import type { CanvasDocument, CanvasPatch, ClientEvent, Shape, SyncEvent, GuideLine } from '@/lib/canvas/types';
import { createEmptyCanvasDocument } from '@/lib/canvas/types';
import { applyPatchToCanvas, applyPatchesToCanvas } from '@/lib/canvas/patch';
import { checkpointSignature, newCheckpointId, MAX_CHECKPOINTS, type Checkpoint } from '@/lib/canvas/version-history';
import { resolvePenTree } from '@/lib/pen/resolve';
import { useSessionStore, hydrateSessionStore } from '@/lib/sessions';
import { useSettings } from '@/lib/settings/store';
import { agentRunSettings } from '@/lib/settings/types';
import { getActivePack } from '@/hooks/use-design-systems';

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
  /// User feedback on an assistant turn (Cursor thumbs up/down). Mirrored
  /// to the session-store Message of the same id.
  feedback?: 'up' | 'down';
  /// Live reasoning stream (pi-agent `agent:thinking_delta`). Displayed as a
  /// collapsible "Thinking… / Thought for Ns" block above the answer
  /// (Cursor thought-bubble / Claude thinking pattern). Live-buffer only —
  /// not mirrored to the session store; reasoning is transient context.
  thinking?: string;
  /// Epoch-ms timestamps bounding the thinking phase. `thinkingEndedAt` is
  /// stamped by the first message_delta / tool_call_start AFTER thinking
  /// began — that's the moment the UI collapses the block.
  thinkingStartedAt?: number;
  thinkingEndedAt?: number;
  /// Self-critique findings from the runner's mandatory critique loop
  /// (pi-agent `agent:critique`). Rendered as a "self-review" row on the
  /// turn so users can see WHY the agent iterated.
  critique?: {
    iteration: number;
    defects: string[];
    textSeverity: 'low' | 'medium' | 'high';
    vlmSeverity: 'low' | 'medium' | 'high';
    vlmScore?: number;
  };
}

/// A prompt the user submitted WHILE the agent was busy (Cursor 3's default
/// queueing behavior — see docs/chat-parity.md). Flushed automatically,
/// one at a time, when the running turn ends (or errors).
export interface QueuedPrompt {
  id: string;
  text: string;
  images?: import('../agent/attachments').AttachedImage[];
  selection?: { count: number; names: string[] };
  queuedAt: number;
}

export interface AgentToolCallEntry {
  id: string;
  name: string;
  argsPreview: string;
  success?: boolean;
  summary?: string;
  /// Epoch-ms timestamps for the per-call duration chip ("1.2s") on the
  /// tool card — Cursor/Cline render elapsed time per terminal command.
  startedAt?: number;
  endedAt?: number;
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
  /// Prompts submitted while the agent was busy — sent automatically, one
  /// per turn end, in submission order (Cursor-style message queueing).
  queuedPrompts: QueuedPrompt[];
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
  /// Phase 7 §H.1 / §H.2 guide lines — separate undo/redo stacks. Guides
  /// are NOT part of the .pen document (chrome state) so they need their
  /// own stacks; the main `undo()`/`redo()` actions fall through to these
  /// when the document stack is empty so a single ⌘Z gesture can walk back
  /// either kind of mutation. Same cap (50) + clear-redo-on-mutation
  /// semantics as the document stacks.
  guideUndoStack: GuideLine[][];
  guideRedoStack: GuideLine[][];
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
  /// Phase 7 §H.2 rulers (spec): top + left pixel rulers showing
  /// canvas-space coordinates with adaptive tick marks. Default OFF;
  /// toggled via the View menu (Figma ⌘R is rename so we don't steal
  /// the chord — View menu only). DOM-renderer-only (the SVG renderer
  /// would need its own ruler implementation).
  rulersVisible: boolean;
  /// Phase 7 §H.2 measure distances (⌥+hover): when true (set transiently
  /// while Alt/Option is held), the canvas shows distance lines + labels
  /// from the hovered shape to its 2-3 nearest sibling shapes + the
  /// active frame edges. Not user-toggled — driven by the Alt-hold gesture.
  /// The renderer reads this state to know when to paint the overlay.
  measureMode: boolean;
  setViewFlag: (flag: 'pixelGridVisible' | 'snapToPixel' | 'outlineMode' | 'rulersVisible', value: boolean) => void;
  toggleViewFlag: (flag: 'pixelGridVisible' | 'snapToPixel' | 'outlineMode' | 'rulersVisible') => void;
  /// Phase 7 §H.2 measure mode setter — set transiently by the Alt-hold
  /// gesture (Canvas.tsx keydown/keyup handlers). Not in setViewFlag
  /// because it's not a user-toggleable View menu item.
  setMeasureMode: (value: boolean) => void;

  // ---- Guide lines (spec Phase 7 §H.1 / §H.2 — drag-out guides) -------------
  /// User-authored horizontal/vertical guide lines. Chrome state (NOT part
  /// of the .pen document) — they live in the screen-space overlay above
  /// the world tree. PERSISTED across session reloads via a dedicated
  /// localStorage key (`agentcanvas.guides.v1`) — see saveGuidesToStorage /
  /// loadGuidesFromStorage helpers below. The persistence layer is a
  /// single localStorage slot shared across all sessions (guides are a
  /// per-canvas viewer-chrome concern, not per-session content). The
  /// `addGuide`/`removeGuide`/`clearGuides` actions write to localStorage
  /// after each mutation; `init()` loads the saved guides on startup.
  guideLines: GuideLine[];
  /// Add a new guide. Pushes the prior guideLines array onto guideUndoStack,
  /// clears guideRedoStack, persists to localStorage.
  addGuide: (guide: GuideLine) => void;
  /// Remove a guide by id. Same undo/persist semantics as addGuide.
  removeGuide: (id: string) => void;
  /// Remove ALL guides. Same undo/persist semantics as addGuide.
  clearGuides: () => void;
  /// Load guides from localStorage into the store (called by init(); also
  /// exposed for tests + future "reset to defaults" flows).
  loadGuides: () => void;

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

  // ---- Version-history checkpoints (spec Phase 7 group C — D14) -------------
  /// Named document snapshots (newest first), auto-captured at each agent
  /// turn end (Figma Make's recoverable-writes model) or saved manually via
  /// ⌘⌥S. EPHEMERAL state — follows the measuredBounds pattern exactly: NOT
  /// part of undo snapshots (undo/redo restore `document` only), NOT
  /// persisted, and writing them never recomputes `document`.
  checkpoints: Checkpoint[];
  /// Signature of the document captured by the most recent checkpoint —
  /// lets addCheckpoint skip redundant captures of an unchanged document.
  lastCheckpointSignature: string | null;
  /// Monotone counter of completed agent turns — labels auto-checkpoints
  /// ("Turn N"). Lives in the slice so it survives store resets cleanly.
  turnCounter: number;
  /// Capture a named checkpoint of the CURRENT document. Returns false (and
  /// does nothing) when the document is unchanged since the last checkpoint
  /// (signature match). Capped at MAX_CHECKPOINTS (oldest dropped; index 0
  /// = newest always kept).
  addCheckpoint: (label: string, auto: boolean) => boolean;
  /// Restore a checkpoint by id. NEVER destructive: first captures a
  /// "Before restore" checkpoint of the current state, then pushes the
  /// current document onto the undo stack (same push sendPatch makes), then
  /// swaps `document` in. Returns false when the id is unknown.
  restoreCheckpoint: (id: string) => boolean;
  /// Drop every checkpoint (File → Version history → Clear).
  clearCheckpoints: () => void;

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
  /// Queue a prompt to send AFTER the running turn finishes (Cursor 3
  /// default: the input stays usable while the agent works; new messages
  /// queue instead of being blocked). Ignored when the agent is idle —
  /// route straight to promptAgent instead.
  queuePrompt: (
    text: string,
    images?: import('../agent/attachments').AttachedImage[],
    selection?: { count: number; names: string[] },
  ) => void;
  /// Remove a queued prompt (the × on a queued chip).
  removeQueuedPrompt: (id: string) => void;
  /// Send ONE queued prompt immediately (the ▶ on a queued chip). Only
  /// meaningful while the agent is idle — e.g. after the user stopped the
  /// previous turn and the queue survived.
  sendQueuedPromptNow: (id: string) => void;
  /// Edit a user turn in place and re-send it (Cursor's edit-and-resend):
  /// truncates every turn AFTER the edited user message (live buffer AND
  /// the session store's messages) and starts a fresh run with the edited
  /// text + the original attachments/selection. Refused while busy.
  editUserTurn: (turnId: string, newText: string) => void;
  /// Rate an assistant turn (thumbs up/down). Toggle: rating the value the
  /// turn already has clears it. Mirrored to the session-store Message.
  setTurnFeedback: (turnId: string, feedback: 'up' | 'down') => void;
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
  /// Switch the active conversation for this document. SHARED-CANVAS MODEL:
  /// rebuilds `turns` from the session store's messages but NEVER touches the
  /// document — all chats on a canvas share one live document.
  switchSession: (sessionId: string) => void;
  /// Create a new conversation for this document and activate it. The canvas
  /// is NOT reset — the new chat continues from the current shared state.
  newSession: () => string | null;
  /// Fork the active conversation from a specific message (copies the
  /// message prefix into a new chat). The canvas is shared and untouched.
  forkActiveSession: (fromMessageId?: string | null) => string | null;
  /// Restore the shared canvas to a document snapshot: appends a 'restore'
  /// snapshot (append-only), swaps the live document, and broadcasts a
  /// `document:restore` so every viewer follows. Remote (metadata-only)
  /// snapshots are fetched from the server first.
  restoreSnapshot: (snapshotId: string) => Promise<void>;

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
/// Set when the user explicitly stops the agent. The synthetic turn_end
/// emitted by the aborted HTTP fallback would otherwise FLUSH the queued
/// prompts — but stopping means "halt everything", so the queue must
/// survive untouched (the chips stay visible with a Send button). Consumed
/// by the queue-flush sites in _onSync.
let suppressQueueFlush = false;

// ---- Phase 4 patch coalescing (spec §4.4) -----------------------------------
//
// Agent `bulk_add` / rapid multi-patch sequences arrive as one `canvas:patch`
// event per patch over the WebSocket. Applying each immediately means N
// `set()` calls → N React reconciliations + N DOM mutations for what is
// logically a single conceptual change. The coalescer queues incoming
// patches for ≤ 1 animation frame and applies the whole sequence in ONE
// `set()` call.
//
// Undo semantics are preserved per-patch: at flush time we replay the
// queued patches serially, capturing the pre-state of each patch (the
// running document state right before that patch is applied). Each
// mutating patch pushes its pre-state to the undo stack — matching the
// unbatched behavior exactly (one undo step per patch). Non-mutating ops
// (select) don't push undo.
//
// Drag-side patches (sendPatch) ALSO route through this queue (Phase 4 §4.4
// item 3) with last-write-wins per shapeId for `update` ops: when a drag
// fires multiple `update` patches for the same shapeId within one frame,
// only the LATEST one survives to flush time. The dropped earlier patches
// also drop their undo entries — so ⌘Z walks back an entire drag gesture
// as a single undo step (one per frame per shapeId), not 60+ per second of
// dragging. Socket emit stays immediate (in sendPatch) — only the local
// apply + undo push are coalesced.
export interface QueuedPatch {
  patch: CanvasPatch;
  /// True for sendPatch-driven (local user edits). Used at flush time to
  /// apply last-write-wins dedup for `update` ops with the same shapeId
  /// within a single frame. False for _onSync-driven (agent) patches,
  /// which preserve full per-patch undo semantics (one step per patch).
  local?: boolean;
}
let patchQueue: QueuedPatch[] = [];
let patchQueueRaf: number | null = null;
let patchQueueFlushTimer: ReturnType<typeof setTimeout> | null = null;

/// Drain the patch queue: replay all queued patches serially against the
/// current document, capturing each patch's pre-state for the undo stack.
/// One `set()` call commits the final document + the per-patch undo
/// entries. Idempotent (no-op when the queue is empty).
function flushPatchQueue() {
  patchQueueRaf = null;
  patchQueueFlushTimer = null;
  if (patchQueue.length === 0) return;
  let queued = patchQueue;
  patchQueue = [];

  const state = useCanvasStore.getState();
  const opts = { measuredBounds: state.measuredBounds };

  // Drag-side last-write-wins per shapeId (Phase 4 §4.4 item 3). Pure
  // function — extracted as `dedupeLocalUpdates` for unit testing.
  queued = dedupeLocalUpdates(queued);

  // Replay serially, capturing pre-states for the undo stack.
  // Per-patch O(N) for the inner recomputeDerived — the win is collapsing
  // N React commits into 1, NOT skipping the per-patch resolvePenTree.
  let running = state.document;
  const preStates: CanvasDocument[] = [];
  for (const q of queued) {
    preStates.push(running);
    running = applyPatchToCanvas(running, q.patch, opts);
  }
  const finalDoc = running;

  // Undo: push one entry per MUTATING patch (select doesn't push), using
  // the per-patch pre-state captured above. This preserves the unbatched
  // behavior (one undo step per patch).
  const mutatingPreStates: CanvasDocument[] = [];
  for (let i = 0; i < queued.length; i++) {
    if (queued[i].patch.op !== 'select') {
      mutatingPreStates.push(preStates[i]);
    }
  }

  // Select-highlight: emit the highlight IDs from the LAST select patch in
  // the batch (if any) — matches the existing _onSync behavior of
  // "highlight whatever the agent just selected".
  let newHighlightIds: string[] | null = null;
  for (let i = queued.length - 1; i >= 0; i--) {
    const p = queued[i].patch;
    if (p.op === 'select' && (p as any).shapeIds) {
      newHighlightIds = (p as any).shapeIds as string[];
      break;
    }
  }

  useCanvasStore.setState((s) => ({
    document: finalDoc,
    undoStack: mutatingPreStates.length > 0
      ? [...s.undoStack, ...mutatingPreStates].slice(-50)
      : s.undoStack,
    redoStack: mutatingPreStates.length > 0 ? [] : s.redoStack,
    agentHighlightIds: newHighlightIds ?? s.agentHighlightIds,
  }));

  if (newHighlightIds) {
    if (highlightTimeout) clearTimeout(highlightTimeout);
    highlightTimeout = setTimeout(() => useCanvasStore.setState({ agentHighlightIds: [] }), 1500);
  }
}

/**
 * Drag-side last-write-wins per shapeId (Phase 4 §4.4 item 3). Pure
 * function — exported for unit testing. Walk the queue from END to START;
 * for each LOCAL `update` op with a shapeId, keep only the LATEST entry per
 * shapeId — drop earlier ones from the queue (their pre-states won't reach
 * the undo stack, so a drag gesture collapses to one undo step per frame
 * per shapeId, not one per mousemove).
 *
 * _onSync-driven (agent) patches are NEVER deduped — their full per-patch
 * undo semantics are preserved. Non-update ops (add/remove/select/...)
 * are NEVER deduped either — only `update` ops with the `local` flag set
 * AND a `shapeId` field participate in the LWW.
 *
 * Order is preserved for surviving patches (the unshift keeps the queue in
 * the original order).
 */
export function dedupeLocalUpdates(queued: QueuedPatch[]): QueuedPatch[] {
  if (!queued.some((q) => q.local && q.patch.op === 'update')) return queued;
  const seen = new Set<string>();
  const deduped: QueuedPatch[] = [];
  for (let i = queued.length - 1; i >= 0; i--) {
    const q = queued[i];
    if (q.local && q.patch.op === 'update' && q.patch.shapeId) {
      if (seen.has(q.patch.shapeId)) continue; // drop — newer one survives
      seen.add(q.patch.shapeId);
    }
    deduped.unshift(q);
  }
  return deduped;
}

/// Enqueue a patch for batched application. Schedules a flush on the next
/// rAF tick (plus a 4ms trailing setTimeout fallback for when rAF is
/// throttled by tab backgrounding). Multiple enqueues in the same frame
/// collapse into one drain.
///
/// TEST ENVIRONMENT: flush synchronously so the existing test contract
/// ("call _onSync, assert state immediately") holds. The coalescing still
/// happens — multiple patches in the same call still collapse into ONE
/// `setState()` call (the queue accumulates across the test's call sequence
/// only if multiple patches arrive before the next synchronous flush; in
/// practice each _onSync call enqueues + flushes immediately, so the
/// behavior matches the unbatched path exactly in tests). Production
/// behavior is the rAF-batched path.
function enqueuePatch(patch: CanvasPatch, local = false) {
  patchQueue.push({ patch, local });
  // Test envs: drain synchronously. jsdom's rAF is polyfilled and unreliable;
  // vitest's fake timers interact awkwardly with rAF + setTimeout; and the
  // existing test contract (call _onSync, assert state immediately) breaks
  // if patches are deferred to the next tick. Production behavior unaffected.
  if (process.env.NODE_ENV === 'test') {
    flushPatchQueue();
    return;
  }
  if (patchQueueRaf == null && typeof requestAnimationFrame === 'function') {
    patchQueueRaf = requestAnimationFrame(flushPatchQueue);
  }
  if (patchQueueFlushTimer == null) {
    // 4ms trailing fallback — covers the case where rAF doesn't fire
    // (tab backgrounded, browser throttling). Keeps the queue from growing
    // unbounded during agent fire-and-forget sequences.
    patchQueueFlushTimer = setTimeout(flushPatchQueue, 4);
  }
}

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
  // The world element is a transform container with no explicit width/height
  // (its children are absolutely positioned, so they don't contribute to its
  // content box). html-to-image captures the element's own box, so a 0x0
  // world produces an empty image. Fall back to the world's PARENT (the
  // visible canvas surface — has `right:0; bottom:0` so it fills the canvas
  // viewport). The agent sees exactly what's visible on the user's screen —
  // which is the spec §5.4 "ground truth" contract.
  let captureTarget: HTMLElement = worldElement;
  const worldRect = worldElement.getBoundingClientRect();
  if ((worldRect.width === 0 || worldRect.height === 0) && worldElement.parentElement) {
    captureTarget = worldElement.parentElement;
  }
  try {
    const { toPng } = await import('html-to-image');
    const dataUrl = await toPng(captureTarget, {
      pixelRatio: typeof event.scale === 'number' && event.scale > 0 ? event.scale : 2,
      backgroundColor: document.background,
      // Skip the ruler/guides/measure chrome overlays — they're screen-space,
      // not part of the canvas content. Same filter as export.ts:exportPngDataUrl
      // so the agent sees the same picture the user exports.
      filter: (node) => {
        if (!(node instanceof HTMLElement)) return true;
        if (node.dataset?.acChrome !== undefined) return false;
        if (node.dataset?.acRulers !== undefined) return false;
        if (node.dataset?.acGuides !== undefined) return false;
        if (node.dataset?.acMeasure !== undefined) return false;
        if (node.dataset?.acDropTarget !== undefined) return false;
        return true;
      },
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

/// agent:extract_html_request handler (Phase 3 v2 — pen_insert_html mode='v2').
/// Mounts a hidden sandboxed iframe, writes the HTML, walks the parsed DOM
/// via `extractHtmlViaIframe` (allow-same-origin only, NO allow-scripts —
/// XSS scripts in the imported HTML cannot execute), and POSTs the
/// extracted .pen tree back to the agent. Browser-only — the dynamic import
/// keeps `html-import-mounted.ts` out of the SSR bundle and the iframe
/// machinery only loads when the agent actually asks. Falls back to an
/// `extract_failed` error response when no client can mount (headless runs,
/// SSR / SSR-like environments) — the tool then falls back to v1.
async function handleExtractHtmlRequest(event: Extract<SyncEvent, { type: 'agent:extract_html_request' }>): Promise<void> {
  try {
    const { extractHtmlViaIframe } = await import('./html-import-mounted');
    // Tighter timeout than the agent-side budget — leaves slack for the
    // POST round-trip before the tool's 4s awaitClientResponse budget elapses.
    const result = await extractHtmlViaIframe(event.html, { timeout: 3500 });
    await postClientResponse({
      kind: 'extract_html',
      toolCallId: event.toolCallId,
      children: result.children as Array<Record<string, unknown>>,
      warnings: result.warnings,
    });
  } catch (err) {
    await postClientResponse({
      kind: 'extract_html',
      toolCallId: event.toolCallId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

const EMPTY_DOC: CanvasDocument = createEmptyCanvasDocument('default', 'Untitled');

// ---- Guide lines persistence (spec Phase 7 §H.1 / §H.2) ----------------------
//
// The canvas store has no persist middleware (unlike settings/sessions which
// each wrap their own zustand `persist`). Guide lines are chrome state —
// per-canvas, not per-session — so a SINGLE localStorage slot is the right
// shape (vs. per-session snapshots the document takes). We follow the same
// "load on init / save on mutation" pattern the document takes via the
// session-store snapshot mechanism, just with a leaner dedicated slot.
//
// Defensive: localStorage is unavailable in SSR + can throw (private mode,
// quota). All access is guarded; failures degrade to in-memory-only (the
// guides still work for the session, just don't survive reload).
const GUIDES_STORAGE_KEY = 'agentcanvas.guides.v1';

/// Persist the current guideLines array to localStorage. No-op + silent
/// on failure (private mode, quota exceeded, SSR). Called by
/// addGuide/removeGuide/clearGuides after each mutation.
export function saveGuidesToStorage(guides: GuideLine[]): void {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(GUIDES_STORAGE_KEY, JSON.stringify(guides));
  } catch {
    // Quota exceeded / private mode — degrade to in-memory only. The user
    // still gets guides for this session; they just won't survive a reload.
  }
}

/// Load the persisted guideLines array from localStorage. Returns `[]`
/// when the slot is empty or parsing fails (corrupted entry). Called by
/// init() on startup; also exposed via the `loadGuides` action for tests.
export function loadGuidesFromStorage(): GuideLine[] {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(GUIDES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive: filter to well-formed GuideLine entries only — a
    // corrupted slot shouldn't crash the canvas on startup.
    return parsed.filter((g): g is GuideLine =>
      typeof g === 'object' && g !== null &&
      typeof g.id === 'string' &&
      (g.axis === 'horizontal' || g.axis === 'vertical') &&
      typeof g.position === 'number',
    );
  } catch {
    return [];
  }
}

/// New guide id. crypto.randomUUID when available, fallback elsewhere
/// (older jsdom builds). Mirrors newCheckpointId.
export function newGuideId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `g-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export const useCanvasStore = create<CanvasState>((set, get) => ({
  document: EMPTY_DOC,
  selectedIds: [],
  agentHighlightIds: [],
  socket: null,
  connected: false,
  viewerCount: 1,
  turns: [],
  agentBusy: false,
  queuedPrompts: [],
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
  guideUndoStack: [],
  guideRedoStack: [],
  toolMode: 'select',
  pixelGridVisible: true,
  snapToPixel: false,
  outlineMode: false,
  rulersVisible: false,
  measureMode: false,
  guideLines: [],
  measuredBounds: {},
  worldElement: null,

  // Version-history checkpoints (Phase 7 group C — ephemeral, like above).
  checkpoints: [],
  lastCheckpointSignature: null,
  turnCounter: 0,

  addCheckpoint: (label, auto) => {
    const s = get();
    const sig = checkpointSignature(s.document);
    // Skip redundant captures — the document is unchanged since the last
    // checkpoint (e.g. two turn_ends with no writes in between).
    if (sig === s.lastCheckpointSignature) return false;
    set({
      checkpoints: [
        { id: newCheckpointId(), label, createdAt: Date.now(), auto, document: s.document },
        ...s.checkpoints,
      ].slice(0, MAX_CHECKPOINTS),
      lastCheckpointSignature: sig,
    });
    return true;
  },

  restoreCheckpoint: (id) => {
    const target = get().checkpoints.find((c) => c.id === id);
    if (!target) return false;
    // 1. Capture the CURRENT state first — restoring is never destructive.
    //    (Skipped automatically when the current doc is unchanged.)
    get().addCheckpoint('Before restore', false);
    // 2. Same undo push sendPatch makes, so ⌘Z walks back out of a restore.
    const cur = get();
    set({
      undoStack: [...cur.undoStack, cur.document].slice(-50),
      redoStack: [],
      document: target.document,
      // The restored doc IS already checkpointed (the target itself) — keep
      // the skip-unchanged invariant coherent for the next auto-checkpoint.
      lastCheckpointSignature: checkpointSignature(target.document),
    });
    return true;
  },

  clearCheckpoints: () => set({ checkpoints: [], lastCheckpointSignature: null }),

  setViewFlag: (flag, value) => set({ [flag]: value } as Partial<CanvasState>),
  toggleViewFlag: (flag) =>
    set((s) => ({ [flag]: !s[flag] } as Partial<CanvasState>)),

  setMeasureMode: (value) => set({ measureMode: value }),

  // ---- Guide lines actions (spec Phase 7 §H.1 / §H.2) ----------------------
  // Same undo pattern as applyPatch: push the prior state, clear redo,
  // cap at 50. The "prior state" here is the guideLines array (NOT the
  // document — guides are chrome state with their own stacks). The main
  // undo()/redo() actions fall through to these stacks when the document
  // stack is empty, so a single ⌘Z gesture can walk back guide mutations.
  addGuide: (guide) => {
    const s = get();
    const next = [...s.guideLines, guide];
    set({
      guideLines: next,
      guideUndoStack: [...s.guideUndoStack, s.guideLines].slice(-50),
      guideRedoStack: [],
    });
    saveGuidesToStorage(next);
  },

  removeGuide: (id) => {
    const s = get();
    // No-op when the id isn't present (still pushes nothing to undo —
    // matches Figma's silent-no-op behavior for right-click on a missing
    // guide).
    if (!s.guideLines.some((g) => g.id === id)) return;
    const next = s.guideLines.filter((g) => g.id !== id);
    set({
      guideLines: next,
      guideUndoStack: [...s.guideUndoStack, s.guideLines].slice(-50),
      guideRedoStack: [],
    });
    saveGuidesToStorage(next);
  },

  clearGuides: () => {
    const s = get();
    // No-op when there are no guides — don't push a no-op undo entry
    // (matches the document's empty-stack behavior).
    if (s.guideLines.length === 0) return;
    set({
      guideLines: [],
      guideUndoStack: [...s.guideUndoStack, s.guideLines].slice(-50),
      guideRedoStack: [],
    });
    saveGuidesToStorage([]);
  },

  loadGuides: () => {
    const stored = loadGuidesFromStorage();
    set({ guideLines: stored });
  },

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

    // Hydrate persisted guide lines from localStorage (Phase 7 §H.1 / §H.2).
    // Same shape as the session-snapshot document hydration below: load on
    // init, save on mutation. Single slot shared across sessions (guides are
    // per-canvas chrome state, not per-session content).
    get().loadGuides();

    // Hydrate from the session store: pick (or create) the active session
    // for this document, then load the DOCUMENT's latest snapshot (if any)
    // into the canvas — the timeline is shared across every chat on this
    // canvas (newest entry wins, regardless of which session produced it).
    // Remote (metadata-only) entries are skipped: they carry no document
    // payload, and boot stays synchronous.
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
    // Load the document's newest local snapshot (shared canvas model).
    const latest = ss.listSnapshots(documentId)[0];
    if (latest && !latest.remote) {
      set({ document: { ...latest.document, id: documentId } });
    } else {
      // No usable snapshot — keep the current document, just re-key its id.
      set((s) => ({ document: { ...s.document, id: documentId } }));
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
    // Phase 4 §4.4 item 3: route the local apply through the same rAF queue
    // as _onSync-driven patches. Drag-side `update` ops get last-write-wins
    // per shapeId within a frame — N mousemove patches for the same shapeId
    // collapse to ONE patch (and ONE undo entry) per frame per shapeId.
    // Other ops (add/remove/select/...) preserve full per-patch undo semantics
    // (one undo step per patch) because the LWW dedup only applies to `update`.
    // Socket emit ABOVE stays immediate — only the local apply + undo push
    // are coalesced, so multiplayer collaboration sees no extra latency.
    enqueuePatch(patch, true);
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
    // Inject the active design-system pack (if any) from localStorage.
    // The runner reads `settings.pack` to (a) append the design-system
    // system-prompt fragment and (b) tell the agent which CSS variables
    // to reference (`var(--color-accent)` etc. — the Canvas component
    // injects the pack's tokens.css on the world root, so the variables
    // resolve to the pack's actual values at render time).
    const activePack = getActivePack();
    if (activePack) {
      (settings as { pack?: string }).pack = activePack;
    }
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
    const { agentBusy, documentId } = get();
    if (!agentBusy) return;
    // Stop ≠ turn end for the QUEUE: don't auto-send the next queued prompt
    // when the synthetic turn_end lands (see suppressQueueFlush above).
    suppressQueueFlush = true;
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
          documentId,
          get().document,
          {
            sessionId: last.sessionId,
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

  queuePrompt: (text, images, selection) => {
    const { agentBusy } = get();
    // Queueing is a busy-state concept. When the agent is idle the UI calls
    // promptAgent directly — but keep this safe if invoked programmatically.
    if (!agentBusy || !text.trim()) return;
    const q: QueuedPrompt = {
      id: `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      text: text.trim(),
      queuedAt: Date.now(),
      ...(images && images.length > 0 ? { images } : {}),
      ...(selection ? { selection } : {}),
    };
    set((s) => ({ queuedPrompts: [...s.queuedPrompts, q] }));
  },

  removeQueuedPrompt: (id) => {
    set((s) => ({ queuedPrompts: s.queuedPrompts.filter((q) => q.id !== id) }));
  },

  sendQueuedPromptNow: (id) => {
    const { agentBusy, queuedPrompts } = get();
    if (agentBusy) return;
    const q = queuedPrompts.find((item) => item.id === id);
    if (!q) return;
    set((s) => ({ queuedPrompts: s.queuedPrompts.filter((item) => item.id !== id) }));
    get().promptAgent(q.text, q.images, q.selection);
  },

  editUserTurn: (turnId, newText) => {
    const { agentBusy, turns, document } = get();
    const text = newText.trim();
    if (agentBusy || !text) return;
    const idx = turns.findIndex((t) => t.id === turnId);
    if (idx === -1 || turns[idx].role !== 'user') return;
    const edited = turns[idx];
    // Cursor edit semantics: the branch AFTER the edited message is
    // discarded. Truncate the live buffer…
    set({ turns: turns.slice(0, idx + 1) });
    // …and the persisted session messages (same ids — user turns carry
    // messageId === turn.id).
    if (edited.sessionId && edited.messageId) {
      useSessionStore.getState().truncateMessagesAfter(edited.sessionId, edited.messageId);
    }
    // Re-send with the edited text + the original attachments/selection.
    get().promptAgent(
      text,
      edited.images && edited.images.length > 0 ? edited.images : undefined,
      edited.selection,
    );
    // The canvas may have advanced past the truncated branch; that's the
    // accepted trade-off of edit-resend on a mutable document (Cursor has
    // the same behavior for non-checkpointed files — the canvas equivalent
    // of a checkpoint is the version-history snapshot, which is untouched).
    void document;
  },

  setTurnFeedback: (turnId, feedback) => {
    set((s) => {
      const turns = s.turns.map((t) => {
        if (t.id !== turnId) return t;
        const next = t.feedback === feedback ? undefined : feedback;
        return next ? { ...t, feedback: next } : { ...t, feedback: undefined };
      });
      return { turns };
    });
    // Mirror to the session-store message (id-stable).
    const turn = get().turns.find((t) => t.id === turnId);
    if (turn?.messageId) {
      useSessionStore.getState().setMessageFeedback(turn.messageId, feedback);
    }
  },

  undo: () => {
    const { undoStack, document, redoStack, guideUndoStack, guideRedoStack, guideLines } = get();
    // Document mutations take precedence — preserve chronology within the
    // document stack. Only when the document stack is empty do we fall
    // through to the guide stack, so a single ⌘Z gesture can still walk
    // back guide-only mutations (e.g. add guide → undo).
    if (undoStack.length > 0) {
      const prev = undoStack[undoStack.length - 1];
      set({
        document: prev,
        undoStack: undoStack.slice(0, -1),
        redoStack: [...redoStack, document].slice(-50),
      });
      return;
    }
    if (guideUndoStack.length > 0) {
      const prevGuides = guideUndoStack[guideUndoStack.length - 1];
      set({
        guideLines: prevGuides,
        guideUndoStack: guideUndoStack.slice(0, -1),
        guideRedoStack: [...guideRedoStack, guideLines].slice(-50),
      });
      saveGuidesToStorage(prevGuides);
    }
  },

  redo: () => {
    const { redoStack, document, undoStack, guideRedoStack, guideUndoStack, guideLines } = get();
    // Mirror of undo: document redo stack takes precedence; fall through to
    // the guide redo stack only when the document stack is empty.
    if (redoStack.length > 0) {
      const next = redoStack[redoStack.length - 1];
      set({
        document: next,
        redoStack: redoStack.slice(0, -1),
        undoStack: [...undoStack, document].slice(-50),
      });
      return;
    }
    if (guideRedoStack.length > 0) {
      const nextGuides = guideRedoStack[guideRedoStack.length - 1];
      set({
        guideLines: nextGuides,
        guideRedoStack: guideRedoStack.slice(0, -1),
        guideUndoStack: [...guideUndoStack, guideLines].slice(-50),
      });
      saveGuidesToStorage(nextGuides);
    }
  },

  setToolMode: (mode) => set({ toolMode: mode }),

  setDocumentName: (name) =>
    set((s) => ({ document: { ...s.document, name } })),

  switchSession: (sessionId) => {
    const { documentId, agentBusy } = get();
    // Guard: switching chats mid-turn would interleave the streaming agent's
    // deltas + tool calls into the NEW session's turns buffer (both chats
    // share the canvas, but the transcript recording is per-chat). The user
    // must stop the agent first. (The SessionSidebar buttons should also be
    // disabled — this is the store-level backstop.)
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
    // Switching chats abandons the queue — queued prompts belonged to the
    // PREVIOUS conversation's flow (Cursor drops queued messages when you
    // switch to a different chat pane too).
    set({ activeSessionId: sessionId, queuedPrompts: [] });
    // SHARED-CANVAS MODEL: the document is NOT swapped — every chat on this
    // canvas mutates the same live document. Only the transcript changes.
    // (Measured bounds + checkpoints stay valid: the document is untouched.)
    get()._syncTurnsFromSession();
  },

  newSession: () => {
    const { documentId } = get();
    const ss = useSessionStore.getState();
    const session = ss.createSession(documentId, { title: 'New chat' });
    // switchSession no longer swaps the canvas — the new chat simply
    // continues on the CURRENT shared document state with an empty
    // transcript.
    get().switchSession(session.id);
    return session.id;
  },

  forkActiveSession: (fromMessageId) => {
    const { activeSessionId } = get();
    if (!activeSessionId) return null;
    // Conversation fork (shared canvas): the fork gets a copy of the parent's
    // message prefix and shares the live document. No snapshot lookup — the
    // canvas timeline is document-scoped and never forked.
    const fork = useSessionStore.getState().forkSession(activeSessionId, fromMessageId ?? null);
    if (!fork) return null;
    get().switchSession(fork.id);
    return fork.id;
  },

  restoreSnapshot: async (snapshotId) => {
    const { documentId, socket, connected } = get();
    const ss = useSessionStore.getState();
    const snap = ss.getSnapshot(snapshotId);
    if (!snap || snap.documentId !== documentId) return;
    // Resolve the target document. Remote (metadata-only) entries must be
    // fetched from the server first — the local placeholder is empty.
    let resolved: CanvasDocument | null = snap.remote ? null : snap.document;
    if (snap.remote) {
      try {
        const { fetchDocumentSnapshot } = await import('@/lib/sessions/server-sync');
        const full = await fetchDocumentSnapshot(documentId, snap.id);
        if (full?.document) {
          resolved = full.document as CanvasDocument;
          // Fill in the local registry entry so future restores are local.
          useSessionStore.getState().ingestServerSnapshot({
            ...full,
            document: resolved,
          });
        }
      } catch {
        // fetch module failures surface through the null below.
      }
      if (!resolved) {
        try {
          import('sonner').then(({ toast }) => {
            toast.error('Restore failed', { description: 'Could not fetch the snapshot from the server.' });
          });
        } catch { /* sonner unavailable */ }
        return;
      }
    }
    // Type-level guard: both branches above guarantee a resolved document
    // (remote entries return early on fetch failure).
    if (!resolved) return;
    // Append-only restore on the document timeline (creates a new 'restore'
    // snapshot + server-syncs it).
    const restored = useSessionStore.getState().restoreSnapshot(documentId, snapshotId);
    if (!restored) return;
    // Swap the shared document. Measured bounds + checkpoints reference the
    // previous content's ids — clear them (undo/redo stacks stay: undo can
    // still step back over the restore).
    set({
      document: { ...resolved, id: documentId },
      measuredBounds: {},
      checkpoints: [],
      lastCheckpointSignature: null,
    });
    // Broadcast the restored state so other viewers + the in-memory WS doc
    // follow (the server rebroadcasts it as canvas:full to all subscribers,
    // including us — an idempotent replace).
    if (socket && connected) {
      socket.emit('client', {
        type: 'document:restore',
        documentId,
        document: get().document,
      } satisfies ClientEvent);
    }
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
        ...(m.feedback ? { feedback: m.feedback } : {}),
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
        // Empty-incoming guard (shared canvas): a restarted WS service can
        // reply to `subscribe` with a fresh empty in-memory document while
        // this client just hydrated real content from the document's latest
        // snapshot — clobbering it would silently destroy the user's canvas.
        // Skip empty replaces when local content exists and no agent turn is
        // in flight. (The in-process service seeds itself from the DB latest
        // DocumentSnapshot, so a healthy path never trips this guard.)
        const incomingEmpty = doc.children.length === 0 && doc.shapes.length === 0;
        const local = get().document;
        const localEmpty = (local.children?.length ?? 0) === 0 && local.shapes.length === 0;
        if (incomingEmpty && !localEmpty && !get().agentBusy) {
          break;
        }
        set({ document: doc, measuredBounds: {}, checkpoints: [], lastCheckpointSignature: null });
        break;
      }
      case 'canvas:patch': {
        // Intercept undo/redo — these require access to the undo/redo stacks
        // directly (not the document). They run IMMEDIATELY, not through the
        // coalescer queue, so a queued undo stays well-formed against the
        // current document state.
        if (event.patch.op === 'undo') {
          get().undo();
          break;
        }
        if (event.patch.op === 'redo') {
          get().redo();
          break;
        }
        // All other patches go through the rAF coalescer (Phase 4 §4.4).
        // Multiple patches in the same tick collapse into ONE React commit;
        // per-patch pre-states are captured at flush time for the undo stack,
        // preserving unbatched undo semantics exactly.
        enqueuePatch(event.patch);
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
            turns[turns.length - 1] = {
              ...last,
              text: last.text + event.text,
              // First answer text after thinking → close the thinking phase
              // (the UI collapses "Thinking…" into "Thought for Ns").
              ...(last.thinking && !last.thinkingEndedAt
                ? { thinkingEndedAt: Date.now() }
                : {}),
            };
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
      case 'agent:thinking_delta': {
        // Live reasoning stream — pi-agent emits these when the model has a
        // thinking/reasoning phase. Accumulated into the turn's `thinking`
        // buffer and rendered as a collapsible dimmed block above the answer
        // (Cursor "thought bubble" / Claude thinking pattern). Previously
        // this event had no reducer case and the tokens were dropped.
        set((s) => {
          const turns = [...s.turns];
          const last = turns[turns.length - 1];
          if (last && last.role === 'assistant') {
            turns[turns.length - 1] = {
              ...last,
              thinking: (last.thinking ?? '') + event.text,
              ...(last.thinkingStartedAt === undefined
                ? { thinkingStartedAt: Date.now() }
                : {}),
            };
          }
          return { turns };
        });
        break;
      }
      case 'agent:critique': {
        // Self-critique findings from the runner's mandatory critique loop.
        // Stored on the turn for the "self-review" row — one entry per
        // iteration (later iterations overwrite earlier ones; the LAST
        // critique is the one that gated the final output).
        set((s) => {
          const turns = [...s.turns];
          const last = turns[turns.length - 1];
          if (last && last.role === 'assistant') {
            turns[turns.length - 1] = {
              ...last,
              critique: {
                iteration: event.iteration,
                defects: event.defects,
                textSeverity: event.textSeverity,
                vlmSeverity: event.vlmSeverity,
                ...(event.vlmScore !== undefined ? { vlmScore: event.vlmScore } : {}),
              },
            };
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
              // A tool call also closes the thinking phase (models think →
              // act; the answer text may only arrive after the tools ran).
              ...(last.thinking && !last.thinkingEndedAt
                ? { thinkingEndedAt: Date.now() }
                : {}),
              toolCalls: [
                ...last.toolCalls,
                {
                  id: event.toolCallId,
                  name: event.toolName,
                  argsPreview: event.argsPreview,
                  startedAt: Date.now(),
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
                  ? { ...tc, success: event.success, summary: event.summary, endedAt: Date.now() }
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
        const { documentId } = get();
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
        // Version-history auto-checkpoint (spec Phase 7 group C — D14):
        // every completed agent turn is a restorable checkpoint (Figma
        // Make's model). Runs after the duplicate guard above so the turn
        // counter increments exactly once per real turn; addCheckpoint
        // itself skips when the turn produced no writes.
        set((s) => ({ turnCounter: s.turnCounter + 1 }));
        get().addCheckpoint(`Turn ${get().turnCounter}`, true);
        if (last?.sessionId) {
          // Snapshot cadence — respect the user's settings. Default is
          // 'every-turn'. 'every-N-turns' captures only on every Nth turn
          // (using the session's runCount as the counter). 'manual' skips
          // auto-capture entirely; the user must use the History panel's
          // "Capture current state" button.
          const cadence = useSettings.getState().snapshotCadence;
          const maxSnaps = useSettings.getState().maxSnapshotsPerCanvas;
          const sess = useSessionStore.getState().sessions[last.sessionId];
          const turnNumber = sess?.runCount ?? 0;
          const shouldCapture =
            cadence === 'every-turn' ||
            (cadence === 'every-3-turns' && turnNumber % 3 === 0) ||
            (cadence === 'every-5-turns' && turnNumber % 5 === 0);
          // cadence === 'manual' → shouldCapture stays false

          if (shouldCapture) {
            // SHARED-CANVAS MODEL: the snapshot lands on the DOCUMENT
            // timeline (keyed by documentId) with the chat's sessionId as
            // provenance — every chat on this canvas contributes to the same
            // version history.
            useSessionStore.getState().captureSnapshot(
              documentId,
              get().document,
              {
                sessionId: last.sessionId,
                source: 'turn_end',
                sourceRunId: last.runId ?? undefined,
                sourceMessageId: last.messageId ?? undefined,
                createdBy: 'agent',
              },
            );
            // Enforce max snapshots per DOCUMENT — trim oldest, but never
            // delete bookmarked snapshots (the user marked them as keepers).
            // Remote (metadata-only) entries are server-owned; local trims
            // only apply to local captures.
            const docSnaps = useSessionStore.getState()
              .listSnapshots(documentId)
              .filter((sn) => !sn.remote);
            if (docSnaps.length >= maxSnaps) {
              const candidates = docSnaps
                .filter((sn) => !sn.bookmarked)
                .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
              const excess = (docSnaps.length + 1) - maxSnaps;
              for (let i = 0; i < excess && i < candidates.length; i++) {
                useSessionStore.getState().deleteSnapshot?.(candidates[i].id);
              }
            }
          }
          if (last.runId) {
            useSessionStore.getState().endRun(last.runId, 'completed');
          }
        }
        // Cursor-style message queue flush: send the NEXT queued prompt
        // (if any) now that the turn is closed out. Runs after the snapshot
        // logic above so the queued turn starts from the finished state; the
        // duplicate-turn_end guard earlier in this case prevents a double
        // flush. promptAgent re-arms agentBusy, so exactly one queued
        // message is sent per completion. Suppressed after an explicit Stop
        // (the queue survives for manual send).
        if (suppressQueueFlush) {
          suppressQueueFlush = false;
        } else {
          const next = get().queuedPrompts[0];
          if (next) {
            set((s) => ({ queuedPrompts: s.queuedPrompts.slice(1) }));
            get().promptAgent(next.text, next.images, next.selection);
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
              // The error is surfaced by the turn's dedicated error row —
              // NOT spliced into the markdown text (polluting the answer
              // made partial responses unreadable and uncopyable).
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
        // A failed turn still frees the agent — flush the next queued
        // prompt (Cursor queues survive a failed turn and retry in order).
        if (!suppressQueueFlush) {
          const next = get().queuedPrompts[0];
          if (next) {
            set((s) => ({ queuedPrompts: s.queuedPrompts.slice(1) }));
            // Let the error state settle into the thread before the new run
            // appends its placeholder turns (avoids a same-tick mutation race
            // with the error reducer above).
            setTimeout(() => {
              get().promptAgent(next.text, next.images, next.selection);
            }, 0);
          }
        }
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
      case 'agent:extract_html_request': {
        // Mount the sandboxed iframe, walk the DOM, POST the extracted
        // .pen tree back. Fire and forget — the tool's server-side timeout
        // bounds the wait; on timeout/null the tool falls back to v1.
        void handleExtractHtmlRequest(event);
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
