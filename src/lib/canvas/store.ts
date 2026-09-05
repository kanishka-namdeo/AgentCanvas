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
import { reconcileDocuments } from '@/lib/canvas/reconcile';
import type { PresenceParticipant } from '@/lib/canvas/types';
import { patchDedupeKey, createBoundedDedupSet } from '@/lib/canvas/patch-dedupe';
import { classifyAgentError, agentErrorClassForCode } from '@/lib/agent-error';
import { runJournalCatchUp, scheduleWatermarkAdvance, loadWatermark, saveWatermark, type CatchUpAdapter } from '@/lib/canvas/journal-catchup';
import {
  getClientId,
  nextMutationId,
  persistMutationClock,
  anchorMutationCounter,
  resetMutationCounter,
  enqueueOutboxPatch,
  outboxEntries,
  outboxSize,
  pruneOutboxUpTo,
  clearOutbox,
  isMutationBearingPatch,
} from '@/lib/canvas/client-mutations';
import { checkpointSignature, newCheckpointId, MAX_CHECKPOINTS, type Checkpoint } from '@/lib/canvas/version-history';
import { resolvePenTree } from '@/lib/pen/resolve';
import { useSessionStore, hydrateSessionStore } from '@/lib/sessions';
import { TERMINAL_RUN_STATUSES } from '@/lib/sessions/types';
import { useSettings } from '@/lib/settings/store';
import { agentRunSettings } from '@/lib/settings/types';
import { patchToOpRecord } from '@/lib/agent/turn-diff';
import { getActivePack } from '@/hooks/use-design-systems';
import { phaseFields, runStatusToPhase, type RunPhase } from '@/lib/canvas/run-phase';

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
  /// Compact records of the canvas mutations this (assistant) turn applied
  /// — the roll-up input for the turn-diff summary card ("+12 −3 ~5").
  /// Mirrored to the session-store Message (localStorage) and the server
  /// message row's diffSummary column.
  patchOps?: import('../agent/turn-diff').PatchOpRecord[];
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
    /// Stable per-dispatch identity (multitask dispatches N parallel
    /// workers that share `type` — results match rows by this id).
    dispatchId?: string;
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
  /// Self-critique findings from the runner's critique loop
  /// (pi-agent `agent:critique`). Rendered as a "self-review" row on the
  /// turn so users can see WHY the agent iterated.
  critique?: {
    iteration: number;
    defects: string[];
    textSeverity: 'low' | 'medium' | 'high';
    vlmSeverity: 'low' | 'medium' | 'high';
    vlmScore?: number;
  };
  /// PLAN mode: the plan the agent submitted for approval (agent:plan_proposed)
  /// + its resolution state. Rendered as the PlanApprovalCard with the
  /// approval triad (Build it / Keep planning).
  planProposal?: {
    planId: string;
    title: string;
    summary: string;
    steps: Array<{ step: number; description: string }>;
    openQuestions?: string[];
    status: 'pending' | 'approved' | 'revising' | 'timeout';
    feedback?: string;
  };
  /// Adaptive critique gating: the runner skipped the LLM critics on this
  /// turn (small/clean — deterministic validation only). Rendered as a muted
  /// "self-review skipped" row with the saved-call estimate.
  critiqueSkipped?: { reason: string; savedLlmCalls: number };
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
  /// Latest agent:tool_progress text from a long-running tool (variant
  /// explorer, design audit) — rendered live on the pending tool card so a
  /// 1-3 minute dispatch no longer looks hung. Cleared visually once the
  /// call ends (terminal cards show summary instead).
  progress?: string;
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
  /// Presence lane (R7): OTHER viewers' volatile state — cursors, selection
  /// outlines, idle flags — keyed by their client-generated participantId.
  /// Never persisted, never journaled; rebuilt from `presence:roster` on
  /// every (re)connect.
  remotePresence: Record<string, PresenceParticipant>;
  /// This tab's presence identity (stable per page load; regenerated on
  /// reload — good enough for a demo, avoids localStorage juggling).
  localParticipant: { participantId: string; name: string; color: string };
  turns: ChatTurn[];
  agentBusy: boolean;
  /// Canonical run phase (2026-09-05 UI-consistency contract) — the single
  /// source of truth every busy-state control derives from. `agentBusy` is
  /// kept as a lockstep mirror (live phase ⇔ true) written together via
  /// phaseFields() so the two can never disagree. See run-phase.ts.
  runPhase: RunPhase;
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
  /// Pending destructive-op approval — set when the agent emits
  /// `agent:approval_request` (the approval gate wrapped a clear/delete
  /// tool). The AgentPanel renders an Allow/Deny dialog from this. Cleared
  /// when the user decides (POST /api/agent/approvals).
  pendingApproval: {
    toolCallId: string;
    toolName: string;
    description: string;
    details: string[];
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
  /// Push this viewer's volatile presence state (cursor / selection / idle)
  /// to the server's presence lane (R7). Throttled internally — callers
  /// (Canvas mousemove, selection changes) fire freely.
  sendPresence: (patch: Partial<Pick<PresenceParticipant, 'cursor' | 'selection' | 'idle'>>) => void;
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
  /// Resolve a pending destructive-op approval (POST /api/agent/approvals).
  /// `approved` true → the gated tool executes; false → the agent gets a
  /// denial result and adapts without the destructive step.
  /// `alwaysAllow` true (only valid with `approved: true`) → the server
  /// adds the tool to its in-memory always-allow set AND the client
  /// persists the tool in settings.alwaysAllowTools so the preference
  /// survives across server restarts.
  submitApproval: (toolCallId: string, approved: boolean, alwaysAllow?: boolean) => Promise<void>;
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

/// 2026-09-05 consistency-contract module state (all reset per-run / per-switch):
/// - `abandonAbortEvents`: set when a DOCUMENT SWITCH aborts the in-flight
///   HTTP-fallback run — the AbortError handler must NOT emit its synthetic
///   terminal events (they would finalize a turn in the NEW document's
///   transcript; the old run's rows are reconciled by the zombie sweep).
let abandonAbortEvents = false;
/// - `agentDrivenUndoRedo`: the agent's own undo/redo arrives as canvas:patch
///   sync events (op 'undo'/'redo') — the user-facing undo/redo busy guard
///   must not block the agent's own operations.
let agentDrivenUndoRedo = false;
/// - `blockedCanvasEditToastShown`: once-per-run feedback for the first
///   user mutation blocked by the busy guard (subsequent blocked attempts
///   stay silent — a mid-run drag fires dozens of sendPatch calls).
let blockedCanvasEditToastShown = false;

/// Reset the once-per-run blocked-edit toast flag — called at every phase
/// arm/clear so a fresh run gets fresh feedback.
function resetBlockedEditToast() {
  blockedCanvasEditToastShown = false;
}

/// Toast shown when a user-initiated mutation is blocked by the busy guard.
function noteBlockedCanvasEdit() {
  if (blockedCanvasEditToastShown) return;
  blockedCanvasEditToastShown = true;
  try {
    toast.info('Canvas editing is paused', {
      description:
        'The agent is working — direct edits would race its changes. Send a prompt to steer it, or press Stop to edit directly.',
    });
  } catch {
    // sonner unavailable in this environment — stay silent.
  }
}

/// Toast for structure operations refused while a run is live (new chat /
/// fork / switch / restore) — the “why” the disabled affordance also carries.
function toastBusyStructure(action: string) {
  try {
    toast.warning('Agent is running', {
      description: `Stop the agent before ${action}.`,
    });
  } catch {
    // sonner unavailable.
  }
}

/// Idempotent agent-patch application (client side of the C1 dedup): every
/// agent patch is keyed by toolCallId + content hash; a verbatim duplicate
/// delivery (socket.io at-least-once redelivery, NDJSON replay) is skipped.
/// User edits (no toolCallId) are never deduped. Module-scoped like the other
/// per-connection singletons — resets on reload/HMR, which matches socket
/// connection semantics.
const processedAgentPatches = createBoundedDedupSet();

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

/// True when an agent turn added shapes to the canvas (add/bulk_add patches
/// since the last turn end). Drives the turn-end "reveal": zoom-to-fit when
/// the turn's content landed outside the visible rect (multi-screen designs
/// grow rightward — without the reveal the user never sees screen 3+).
let agentAddedShapesThisTurn = false;

// ---- Presence lane (R7) -------------------------------------------------------
//
// This tab's collaboration identity + the outbound presence throttle.
// Identity: participantId is random per page load (stable across socket
// reconnects within the session — the server keys the roster by it, so a
// reconnecting tab keeps its cursor instead of duplicating). Color comes
// from a fixed readable palette; the name is a short stable suffix so the
// cursor label stays recognizable between reconnects.
const PRESENCE_COLORS = [
  '#f97316', '#8b5cf6', '#06b6d4', '#84cc16', '#ec4899', '#14b8a6', '#f59e0b', '#6366f1',
];
function makeLocalParticipant(): { participantId: string; name: string; color: string } {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return {
    participantId: `p-${rand}`,
    name: `Guest ${rand.slice(0, 4).toUpperCase()}`,
    color: PRESENCE_COLORS[Math.floor(Math.random() * PRESENCE_COLORS.length)],
  };
}
let localParticipantIdentity = makeLocalParticipant();

/// Outbound presence state (last sent) + the throttle. Cursor moves are
/// throttled to one wire event per PRESENCE_CURSOR_INTERVAL (33ms —
/// Excalidraw's volatile-cursor cadence); selection/idle changes bypass the
/// throttle (they're rare and users notice their lag). A trailing flush
/// guarantees the LAST cursor position always reaches the wire.
const PRESENCE_CURSOR_INTERVAL = 33;
let presenceLastSentAt = 0;
let presenceTimer: ReturnType<typeof setTimeout> | null = null;
let presencePending: {
  cursor?: { x: number; y: number } | null;
  selection?: string[];
  idle?: boolean;
} | null = null;
let presenceLastSent: {
  cursor?: { x: number; y: number } | null;
  selection?: string[];
  idle?: boolean;
} = {};

/// Test hook: reset the presence throttle + identity between tests.
export function __resetPresenceForTests(): void {
  presenceLastSentAt = 0;
  if (presenceTimer) {
    clearTimeout(presenceTimer);
    presenceTimer = null;
  }
  presencePending = null;
  presenceLastSent = {};
  localParticipantIdentity = makeLocalParticipant();
}

// ---- Streaming delta batching (R9b) -------------------------------------------
//
// `agent:message_delta` fires once per token chunk — dozens per second. The
// old handler ran TWO set() calls per delta (canvas turns + session-store
// message), each triggering: a `turns` array copy (AgentPanel re-render +
// ReactMarkdown re-parse of the ENTIRE accumulated text — O(text) per token)
// and a zustand-persist serialization of the WHOLE sessions dataset. The
// server already batches the WIRE at 16ms; this is the client-side mirror:
// deltas accumulate in a module buffer and land as ONE set() per flush
// window (~32ms — two frames; imperceptible next to token latency).
//
// Ordering safety: the buffer is flushed synchronously at the start of every
// non-delta `_onSync` event, at promptAgent start, and at turn terminal
// events — a terminal (message_end / turn_end / error) can never run before
// the text it terminates, and buffered text can never attach to a newer
// turn. Under NODE_ENV==='test' the flush is synchronous (the
// enqueuePatch precedent) so existing store tests keep their
// dispatch-then-assert contract.
let pendingAssistantDeltas = '';
let assistantDeltaTimer: ReturnType<typeof setTimeout> | null = null;
const ASSISTANT_DELTA_FLUSH_MS = 32;

function flushAssistantDeltas() {
  if (assistantDeltaTimer) {
    clearTimeout(assistantDeltaTimer);
    assistantDeltaTimer = null;
  }
  if (!pendingAssistantDeltas) return;
  const text = pendingAssistantDeltas;
  pendingAssistantDeltas = '';
  useCanvasStore.setState((s) => {
    const turns = [...s.turns];
    const last = turns[turns.length - 1];
    if (last && last.role === 'assistant') {
      turns[turns.length - 1] = {
        ...last,
        text: last.text + text,
        // First answer text after thinking → close the thinking phase
        // (the UI collapses "Thinking…" into "Thought for Ns").
        ...(last.thinking && !last.thinkingEndedAt
          ? { thinkingEndedAt: Date.now() }
          : {}),
      };
    }
    return { turns };
  });
  // Mirror to session store — ONE append per flush instead of one per token.
  const last = useCanvasStore.getState().turns[useCanvasStore.getState().turns.length - 1];
  if (last?.messageId) {
    useSessionStore.getState().appendAssistantText(last.messageId, text);
  }
}

function scheduleAssistantDeltaFlush() {
  if (assistantDeltaTimer) return;
  assistantDeltaTimer = setTimeout(flushAssistantDeltas, ASSISTANT_DELTA_FLUSH_MS);
}

/// Test hook: synchronously land any buffered streaming text.
export function __flushAssistantDeltasForTests(): void {
  flushAssistantDeltas();
}

// ---- Offline outbox flush (R5: Figma's fresh-copy + reapply contract) --------
//
// While the socket is down, sendPatch queues wire-bound mutations in
// localStorage (the optimistic local apply always runs). The flush happens
// ONLY after the reconnected client has taken the server's state — i.e. at
// the END of a non-restore `canvas:full` (the subscribe reply, whose merge
// keeps unsynced local edits alive via version+nonce reconcile). Emits are
// a SYNCHRONOUS loop in ascending clientMutationId order so socket.io's
// per-connection ordering holds (an await between emits could interleave a
// fresh drag patch ahead of older queued ones → a server-side gap).
//
// Entries are pruned ONLY by mutation:ack / catch-up clocks (never by the
// flush itself — an ack can be lost); a re-flush therefore re-sends unacked
// entries, which the server's MutationClock answers `duplicate` — the
// exactly-once rule makes re-sending free. When an ack lands and newer
// entries arrived meanwhile (sendPatch enqueues while the queue is non-empty
// to preserve order), the ack handler re-flushes them — the chain drains.
function flushOutboxNow(get: () => CanvasState): void {
  const { socket, connected, documentId } = get();
  if (!socket || !connected) return;
  const entries = outboxEntries(documentId);
  if (entries.length === 0) return;
  const clientId = getClientId();
  for (const entry of entries) {
    socket.emit('client', {
      type: 'canvas:patch',
      documentId,
      patch: entry.patch,
      clientId,
      clientMutationId: entry.clientMutationId,
    } satisfies ClientEvent);
  }
}

/// Test hook — flush the outbox as if a canvas:full had just landed (the
/// socket 'connect' + canvas:full wiring lives inside init(), which tests
/// never execute).
export function __flushOutboxForTests(): void {
  flushOutboxNow(useCanvasStore.getState);
}

/// visibilitychange listener for the mutation-clock flush (R5) — shared
/// reference so init's cleanup can remove it.
function onVisibilityForClock(): void {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    persistMutationClock();
  }
}

/// Flush the pending outbound presence state to the wire (merged over the
/// last sent snapshot — presence updates are cumulative, not deltas).
/// No-ops when disconnected or when there is nothing new to say.
function emitPendingPresence(get: () => CanvasState) {
  const pending = presencePending;
  presencePending = null;
  if (!pending) return;
  const merged = { ...presenceLastSent, ...pending };
  presenceLastSent = merged;
  presenceLastSentAt = Date.now();
  const { socket, connected, documentId } = get();
  if (!socket || !connected) return;
  const participant: PresenceParticipant = {
    participantId: localParticipantIdentity.participantId,
    name: localParticipantIdentity.name,
    color: localParticipantIdentity.color,
    ...merged,
  };
  socket.emit('client', { type: 'presence:update', documentId, participant } satisfies ClientEvent);
}

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

  // ---- Audit 4 C18: agent-touched node pulse ---------------------------------
  //
  // agentHighlightIds used to fire ONLY when the agent explicitly called the
  // select tool — patches themselves never pulsed the nodes they touched, so
  // mid-turn the user saw geometry morph with no pointer to WHAT changed.
  // Derive a transient "recently-touched-by-agent" set from this frame's
  // AGENT patches (non-local) — the ids each patch targets — and merge it
  // into the same highlight pipeline (1.5s pulse ring in DomChrome).
  if (newHighlightIds === null) {
    const touched = new Set<string>();
    for (const q of queued) {
      if (q.local) continue; // user's own edits don't pulse.
      const p: any = q.patch;
      if (p.shapeId && typeof p.shapeId === 'string') touched.add(p.shapeId);
      if (Array.isArray(p.shapeIds)) {
        for (const id of p.shapeIds) {
          if (typeof id === 'string') touched.add(id);
        }
      }
      if (Array.isArray(p.updates)) {
        for (const u of p.updates) {
          if (u && typeof u.id === 'string') touched.add(u.id);
        }
      }
      if (p.shape && typeof p.shape.id === 'string') touched.add(p.shape.id);
      if (Array.isArray(p.shapes)) {
        for (const s of p.shapes) {
          if (s && typeof s.id === 'string') touched.add(s.id);
        }
      }
    }
    // Cap the pulse set so a whole-canvas op (palette/clear) can't light up
    // hundreds of rings at once — a 30-node pulse is plenty of signal.
    if (touched.size > 0 && touched.size <= 30) {
      newHighlightIds = [...touched];
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
  remotePresence: {},
  localParticipant: localParticipantIdentity,
  turns: [],
  agentBusy: false,
  runPhase: 'idle',
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
  pendingApproval: null,
  todos: [],
  backgroundTasks: [],
  mcpServers: [],

  init: (documentId) => {
    // Document-switch detection (2026-09-05 multi-shot hygiene fix): captured
    // BEFORE the set() below re-keys the store. When init() swaps to a
    // DIFFERENT document that has no local snapshot, the canvas must reset
    // to empty — the old code kept the previous document's frames and
    // re-keyed the id, so a freshly created document inherited the prior
    // doc's screens (its first turn_end snapshot then captured the stale
    // frames, and the client's view disagreed with the server journal-fold
    // forever). Same-id re-init (reconnect / HMR / name change) keeps the
    // live document exactly as before.
    const previousDocumentId = get().documentId;
    const isDocumentSwitch = previousDocumentId !== documentId;

    // Hydrate the persisted session store from localStorage (client-only).
    // This is a no-op on the server.
    hydrateSessionStore();

    // Zombie sweep (durability fix): a page crash / browser kill mid-run
    // leaves runs at 'in_progress' and messages at 'streaming' in the
    // localStorage cache forever — the UI shows an eternal spinner after
    // reload. Runs/messages older than 10 minutes with no live activity are
    // finalized honestly; anything younger is left alone because a live
    // server-side run (page reloaded mid-turn, socket reconnected) still
    // delivers its closing events and finalizes normally.
    try {
      useSessionStore.getState().reconcileStaleActivity();
    } catch {
      // Non-fatal — a reconcile failure must never block boot.
    }

    // Connect to the WebSocket mini-service on port 3003.
    // Per the gateway rules we MUST use the XTransformPort query param
    // and the path MUST be '/'.
    const socket = io('/?XTransformPort=3003', {
      transports: ['websocket', 'polling'],
      forceNew: true,
      reconnection: true,
      // Reliability micro-adopts (research R8/roadmap): never give up
      // (the old 10-attempt cap left `connected:false` forever after ~1min
      // of outage — every sendPatch silently dropped), cap the backoff at
      // 30s (OpenHands' ceiling; the 5s default hammers a struggling
      // server), and pin socket.io's default 0.5 jitter explicitly so the
      // intent is documented rather than implicit.
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
      randomizationFactor: 0.5,
      timeout: 10000,
      // REST-first hydration (R4): the socket attaches only AFTER the
      // status/anchor fetch below settles (or times out) — the OpenHands
      // mount flow (REST tail first, WebSocket second). A dead REST layer
      // never blocks the socket: the fetch is bounded by STATUS_FETCH_MS.
      autoConnect: false,
    });

    set({ socket, documentId });

    // Hydrate persisted guide lines from localStorage (Phase 7 §H.1 / §H.2).
    // Same shape as the session-snapshot document hydration below: load on
    // init, save on mutation. Single slot shared across sessions (guides are
    // per-canvas chrome state, not per-session content).
    //
    // C4 (2026-09-05 consistency contract): switching documents mid-run used
    // to STRAND the busy state — the old run's terminal event never arrives
    // on the new subscription, leaving Stop / BusyRow / mutation-gating stuck
    // ON forever (a later Stop even finalized the NEW document's turn as
    // cancelled). Reset the live phase + queue here. The old document's run
    // keeps running server-side; switching back re-arms via the status
    // endpoint + journal catch-up below. The queue is cleared because its
    // prompts belonged to the old document's conversation flow.
    if (isDocumentSwitch) {
      if (agentAbort) {
        // Detach the in-flight HTTP-fallback run (it belongs to the OLD
        // document) WITHOUT the synthetic terminal events — see
        // abandonAbortEvents above.
        abandonAbortEvents = true;
        agentAbort.abort();
        agentAbort = null;
      }
      resetBlockedEditToast();
      set({ agentBusy: false, runPhase: 'idle', queuedPrompts: [] });
    }
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
    } else if (isDocumentSwitch) {
      // Genuinely NEW document with no snapshot history: clean canvas, not
      // the previous document's content. Per-shape chrome that references
      // the old ids (selection, highlights, measured bounds, turn
      // checkpoints) is cleared with it — same reset semantics as a snapshot
      // restore.
      set({
        document: createEmptyCanvasDocument(documentId, 'Untitled'),
        selectedIds: [],
        agentHighlightIds: [],
        measuredBounds: {},
        checkpoints: [],
        lastCheckpointSignature: null,
      });
    } else {
      // No usable snapshot on the SAME document — keep the current document,
      // just re-key its id.
      set((s) => ({ document: { ...s.document, id: documentId } }));
    }
    get()._syncTurnsFromSession();

    // ---- REST-first hydration (R4) + mutation-clock anchor (R1) --------------
    //
    // Fetch the agent status BEFORE the socket attaches (autoConnect:false
    // above): (a) the mutation counter is anchored from the server's durable
    // clock, so a crash that lost the un-persisted counter tail can never
    // reuse an accepted id (which the server would silently drop as a
    // duplicate = a lost edit); (b) a live server-side run (page reloaded
    // mid-turn) replays the journal tail NOW, so the open turn materializes
    // before the first socket event; (c) a missing watermark baselines from
    // lastSeq. The fetch is bounded — offline/failed starts fall through to
    // the plain socket path (whose own catch-up covers everything else).
    const makeCatchUpAdapter = (): CatchUpAdapter => ({
      dispatch: (ev) => get()._onSync(ev),
      onMutationClock: (changes) => {
        const mine = changes[getClientId()];
        if (mine !== undefined) {
          pruneOutboxUpTo(documentId, mine);
        }
      },
    });
    void (async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3500);
        try {
          const res = await fetch(
            `/api/documents/${encodeURIComponent(documentId)}/agent/status`,
            { signal: controller.signal, cache: 'no-store', headers: { accept: 'application/json' } },
          );
          if (res.ok) {
            const status = (await res.json()) as {
              active?: unknown;
              lastSeq?: number;
              lastMutationIDChanges?: Record<string, number>;
            };
            anchorMutationCounter(status?.lastMutationIDChanges?.[getClientId()]);
            if (status?.active) {
              // A run is live server-side — replay the journal tail through
              // the same identity-idempotent path the reconnect uses.
              await runJournalCatchUp(documentId, makeCatchUpAdapter());
            } else if (typeof status?.lastSeq === 'number' && loadWatermark(documentId) === 0) {
              saveWatermark(documentId, status.lastSeq);
            }
          }
        } finally {
          clearTimeout(timer);
        }
      } catch {
        // Offline start / status route unavailable — the socket path's own
        // catch-up + canvas:full handle everything; only the counter anchor
        // is deferred (it re-anchors on the first ack).
      }
      socket.connect();
    })();

    socket.on('connect', () => {
      set({ connected: true });
      socket.emit('client', { type: 'subscribe', documentId } satisfies ClientEvent);
      // Presence lane: (re)announce this tab's identity on every connect —
      // the server keys the roster by participantId, so a reconnecting tab
      // reclaims its entry instead of duplicating. The state snapshot is
      // reset so name/color/idle re-land even after a long sleep.
      presenceLastSent = {};
      emitPendingPresence(get);
      // Reconnect catch-up (journal consumer): pull everything journaled
      // since our watermark and replay the missed agent events — turn
      // closures for the open turn, whole missed turns with content via
      // user_message/turn_final rows (R3). Without this, a disconnect during
      // a turn strands the client (agentBusy + streaming message +
      // in_progress run) until the 10-minute zombie sweep. canvas:full (sent
      // by the server right after subscribe) covers canvas state + triggers
      // the outbox flush (R5); the journal covers agent state. socket.io
      // fires 'connect' on every REconnect, which is exactly when a gap
      // exists. Idempotent with the REST-first replay above (the advanced
      // watermark empties the window).
      void runJournalCatchUp(documentId, makeCatchUpAdapter());
    });
    socket.on('disconnect', () => {
      // Presence lane: while offline we know nothing about other viewers —
      // drop their cursors instead of rendering stale ghosts (the roster
      // re-lands from the server on the next connect).
      if (presenceTimer) {
        clearTimeout(presenceTimer);
        presenceTimer = null;
      }
      presencePending = null;
      set({ connected: false, remotePresence: {} });
    });
    // Observability (micro-adopt): log transport-level failures so a dead
    // gateway is visible in the console instead of a silent spinner.
    socket.on('connect_error', (err: Error) => {
      console.warn(`[canvas-sync] connect error: ${err.message}`);
    });
    // Tab-wake nudge: laptop sleep pauses reconnect timers; an explicit
    // connect() on 'online' shortens the gap after the network returns.
    // Also flush the mutation counter on pagehide/hidden (R5): the counter
    // persists on outbox enqueues, but an ONLINE editing session with an
    // empty outbox would otherwise lose its tail to a crash — persistMutationClock
    // is a single tiny key write, safe at pagehide frequency.
    let onOnline: (() => void) | null = null;
    let onPersistClock: (() => void) | null = null;
    if (typeof window !== 'undefined') {
      onOnline = () => {
        if (!socket.connected) socket.connect();
      };
      window.addEventListener('online', onOnline);
      onPersistClock = () => persistMutationClock();
      window.addEventListener('pagehide', onPersistClock);
      window.addEventListener('beforeunload', onPersistClock);
      document.addEventListener('visibilitychange', onVisibilityForClock);
    }
    socket.on('sync', (event: SyncEvent) => {
      get()._onSync(event);
    });

    return () => {
      socket.disconnect();
      if (onOnline) window.removeEventListener('online', onOnline);
      if (onPersistClock) {
        window.removeEventListener('pagehide', onPersistClock);
        window.removeEventListener('beforeunload', onPersistClock);
        document.removeEventListener('visibilitychange', onVisibilityForClock);
      }
      persistMutationClock();
    };
  },

  sendPatch: (patch) => {
    const { socket, connected, documentId, agentBusy } = get();
    // Busy-guard (2026-09-05 contract, audit C1): user-initiated document
    // mutations are PAUSED while the agent runs. The toolbar buttons and ⌘Z
    // were already gated for exactly this reason (“undoing under the agent
    // corrupts its working document”) — but the SAME mutations flowed
    // unguarded through keyboard chords, panels, gestures and menus.
    // Enforcing the rule at this one choke point makes every surface agree
    // without per-callback guards. Agent patches ride canvas:patch sync
    // events and never pass through sendPatch; `select` ops are UI state
    // (never mutation-bearing) and stay live — Figma parity: viewport,
    // selection and inspection remain fully interactive during a run.
    if (agentBusy && isMutationBearingPatch(patch)) {
      noteBlockedCanvasEdit();
      return;
    }
    // Mutation identity (R1): every canvas-MUTATING patch is stamped with the
    // stable clientId + a contiguous clientMutationId so the server journals
    // it exactly-once. `select` ops are UI state (presence-like) — never
    // stamped, never journaled, never queued (a stamped select would burn an
    // id the server's clock never sees and manufacture a gap).
    const stamped = isMutationBearingPatch(patch);
    const clientId = stamped ? getClientId() : undefined;
    const clientMutationId = stamped ? nextMutationId() : undefined;
    // Outbox ordering gate (R5): while entries are still queued (offline, or
    // in flight awaiting acks), NEW mutations enqueue behind them — emitting
    // direct would overtake the queue and create a server-side gap.
    const queueBusy = stamped && outboxSize(documentId) > 0;
    if (socket && connected && !queueBusy) {
      // `documentId` rides the envelope (R8a) so the server routes the patch
      // directly instead of scanning subscriber sets first-match (which
      // misroutes sockets subscribed to several documents).
      socket.emit('client', {
        type: 'canvas:patch',
        documentId,
        patch,
        ...(clientId ? { clientId } : {}),
        ...(clientMutationId !== undefined ? { clientMutationId } : {}),
      } satisfies ClientEvent);
    } else if (stamped) {
      // Offline (or draining): queue the wire-bound mutation. The optimistic
      // local apply below still runs — the canvas NEVER blocks on the wire.
      enqueueOutboxPatch(documentId, clientMutationId!, patch);
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

  sendPresence: (patch) => {
    // Merge the patch into the pending outbound presence, then decide whether
    // to emit now or defer to the trailing throttle window. Selection/idle
    // changes are rare and lag-sensitive → always immediate; cursor moves
    // ride the 33ms throttle.
    presencePending = { ...(presencePending ?? {}), ...patch };
    const hasCursorOnly =
      Object.keys(patch).length === 1 && 'cursor' in patch;
    const now = Date.now();
    const due = now - presenceLastSentAt >= PRESENCE_CURSOR_INTERVAL;
    if (!hasCursorOnly || due) {
      if (presenceTimer) {
        clearTimeout(presenceTimer);
        presenceTimer = null;
      }
      emitPendingPresence(get);
      return;
    }
    if (!presenceTimer) {
      const wait = Math.max(0, PRESENCE_CURSOR_INTERVAL - (now - presenceLastSentAt));
      presenceTimer = setTimeout(() => {
        presenceTimer = null;
        emitPendingPresence(get);
      }, wait);
    }
  },

  select: (ids) => set({ selectedIds: ids }),

  promptAgent: (text, images, selection) => {
    // Busy-guard (2026-09-05 contract, audit C2): a direct promptAgent call
    // while a run is live would start a SECOND concurrent run (the "Re-run
    // from here" path used to reach here ungated, overwriting the server's
    // run registry). Every legitimate entry either calls queuePrompt while
    // busy (composer / chips / palette — the queue doctrine) or flushes the
    // queue AFTER the terminal event cleared the busy flag, so arriving here
    // busy means an ungated UI entry: route it into the queue instead.
    if (get().agentBusy) {
      get().queuePrompt(text, images, selection);
      return;
    }
    // Delta-batching ordering guard (R9b): land any text still buffered from
    // the previous turn BEFORE the new user turn is appended — otherwise the
    // flush would find a user turn as `last` and drop the tail.
    flushAssistantDeltas();
    resetBlockedEditToast();
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
      ...phaseFields('thinking'),
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
        // Turn identity (R3): the server journals id-linked user_message /
        // turn_final rows so reconnect catch-up replay adopts them by id.
        sessionId,
        runId: run.id,
        userMessageId: userMsg.id,
        assistantMessageId: assistantMsg.id,
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
            // Turn identity (R3) — same rows the WS path threads.
            sessionId,
            runId: run.id,
            userMessageId: userMsg.id,
            assistantMessageId: assistantMsg.id,
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
          if (abandonAbortEvents) {
            // Document-switch detachment (see init): swallow the synthetic
            // terminal events — they belong to the OLD document's transcript.
            abandonAbortEvents = false;
            return;
          }
          // User clicked Stop — finalize as CANCELLED (not completed: the old
          // synthetic turn_end here marked stopped runs 'completed' in the
          // session store). The server side also aborts (the request signal
          // propagates into the runner), so no further events will arrive.
          get()._onSync({ type: 'agent:turn_cancelled' });
        } else {
          const message = err?.message ?? 'unknown error';
          const cls = classifyAgentError(message);
          get()._onSync({ type: 'agent:error', message, code: cls.code, retryable: cls.retryable });
        }
      } finally {
        agentAbort = null;
      }
    })();
  },

  stopAgent: () => {
    const { agentBusy, documentId, socket, connected } = get();
    if (!agentBusy) return;
    // Phase → 'cancelling' (contract: intermediate stop state). The Stop
    // controls flip to "Stopping…" until the server-side turn_cancelled
    // confirms; the local fallback below and the event handler both settle
    // on 'cancelled'. Also mark the session-store run 'cancelling' so the
    // StatusBadge's existing config finally goes live.
    resetBlockedEditToast();
    set(phaseFields('cancelling'));
    {
      const lastRun = get().turns[get().turns.length - 1];
      if (lastRun?.runId) {
        useSessionStore.getState().setRunStatus(lastRun.runId, 'cancelling');
      }
    }
    // Stop ≠ turn end for the QUEUE: don't auto-send the next queued prompt
    // when the synthetic turn_cancelled lands (see suppressQueueFlush above).
    suppressQueueFlush = true;
    // Server-visible Stop: tell the canvas-sync service to abort the run so
    // the runner's pi session is aborted SERVER-side (token spend stops, all
    // viewers get agent:turn_cancelled). Previously the server kept running
    // to completion and its late patches kept applying after "Stop".
    if (socket && connected) {
      socket.emit('client', { type: 'agent:stop', documentId } satisfies ClientEvent);
    }
    // Abort the in-flight HTTP fetch (if any) — its request signal propagates
    // the stop into the runner server-side; the AbortError branch of
    // promptAgent's fetch loop synthesizes the local turn_cancelled.
    if (agentAbort) {
      agentAbort.abort();
      agentAbort = null;
      return;
    }
    // Local finalization (WS path belt-and-braces — if the server-side
    // turn_cancelled is delayed or the socket dropped, the UI still unblocks
    // immediately; the handler + endRun's terminal guard make the eventual
    // duplicate finalization a no-op).
    {
      const last = get().turns[get().turns.length - 1];
      if (last?.messageId) {
        useSessionStore.getState().finalizeAssistantMessage(last.messageId, 'cancelled');
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
        return { turns, ...phaseFields('cancelled') };
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
    // R8c: the server now routes the steer into the RUNNING pi session
    // (session.steer) — the model sees the text after its current tool
    // batch. When no run is live the server replies agent:steer_rejected
    // (toast), so the optimistic "Steer sent" below is only informational.
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
    if (get().agentBusy && !agentDrivenUndoRedo) {
      // User-initiated undo is refused mid-run (same rule as the toolbar's
      // disabled Undo): the agent's journal patches assume an untouched
      // baseline. The agent's own pen_undo tool arrives as canvas:patch sync
      // events and bypasses this guard via agentDrivenUndoRedo.
      noteBlockedCanvasEdit();
      return;
    }
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
    if (get().agentBusy && !agentDrivenUndoRedo) {
      noteBlockedCanvasEdit();
      return;
    }
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
    // Cross-device hydration: when this browser's localStorage cache has no
    // (or partial) messages for the session, pull the server copy — INCLUDING
    // image attachments (SessionAttachment rows) and turn-diff records —
    // before building the turns. Fire-and-forget is not enough here: the
    // turns rebuild below must see the imported messages, so we kick off the
    // async fetch and rebuild again when it lands.
    if (typeof window !== 'undefined' && session.messageIds.length === 0) {
      import('@/lib/sessions/server-sync').then(({ fetchServerMessages }) =>
        fetchServerMessages(sessionId).then((messages) => {
          if (messages.length === 0) return;
          const imported = useSessionStore.getState().importServerMessages(sessionId, messages);
          if (imported > 0) {
            get()._syncTurnsFromSession();
            try {
              import('sonner').then(({ toast }) => {
                toast.message(`Restored ${imported} messages from server`, {
                  description: 'History (with attachments) synced from the database.',
                });
              });
            } catch { /* sonner unavailable */ }
          }
        }),
      );
    }
    // SHARED-CANVAS MODEL: the document is NOT swapped — every chat on this
    // canvas mutates the same live document. Only the transcript changes.
    // (Measured bounds + checkpoints stay valid: the document is untouched.)
    // Rebuild `turns` from session messages.
    get()._syncTurnsFromSession();
  },

  newSession: () => {
    const { documentId, agentBusy } = get();
    // Guard BEFORE create (audit C5): creating first and letting
    // switchSession's guard block the switch used to strand an empty ORPHAN
    // session row + a warning toast on every "new chat" entry during a run.
    if (agentBusy) {
      toastBusyStructure('starting a new chat');
      return null;
    }
    const ss = useSessionStore.getState();
    const session = ss.createSession(documentId, { title: 'New chat' });
    // switchSession no longer swaps the canvas — the new chat simply
    // continues on the CURRENT shared document state with an empty
    // transcript.
    get().switchSession(session.id);
    return session.id;
  },

  forkActiveSession: (fromMessageId) => {
    const { activeSessionId, agentBusy } = get();
    if (!activeSessionId) return null;
    // Guard BEFORE create (audit C5) — same orphan-session rationale as
    // newSession above.
    if (agentBusy) {
      toastBusyStructure('forking this chat');
      return null;
    }
    // Conversation fork (shared canvas): the fork gets a copy of the parent's
    // message prefix and shares the live document. No snapshot lookup — the
    // canvas timeline is document-scoped and never forked.
    const fork = useSessionStore.getState().forkSession(activeSessionId, fromMessageId ?? null);
    if (!fork) return null;
    get().switchSession(fork.id);
    return fork.id;
  },

  restoreSnapshot: async (snapshotId) => {
    const { documentId, socket, connected, agentBusy } = get();
    // Busy-guard (audit C8 — three restore paths, one rule): VersionHistory
    // gated, RunHistory + this action unguarded. Restoring mid-run would
    // yank the document out from under the agent's in-flight patches.
    if (agentBusy) {
      toastBusyStructure('restoring a snapshot');
      return;
    }
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
        // Turn-diff records persist on the message too — rehydrate so the
        // "+12 −3 ~5" card survives reloads / session switches.
        ...(m.patchOps && m.patchOps.length > 0 ? { patchOps: m.patchOps } : {}),
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
    // Delta-batching ordering guard (R9b): every non-delta event first lands
    // any buffered streaming text — terminal events (message_end /
    // turn_end / error) must never run ahead of the text they terminate, and
    // a new turn must never receive the previous turn's buffered tail. In
    // test mode the buffer is always empty (synchronous flush), so this is a
    // cheap string check.
    if (event.type !== 'agent:message_delta') {
      flushAssistantDeltas();
    }
    // Live-terminal watermark advance (journal catch-up bookkeeping): when
    // the client processes a turn-closing event LIVE it has, by definition,
    // seen every journal row up to the journal's head — advance the persisted
    // watermark (debounced probe) so the NEXT reconnect's replay window
    // starts at this turn's boundary instead of re-replaying turns onto a
    // different open turn (the position-based handler hazard).
    if (
      event.type === 'agent:turn_end' ||
      event.type === 'agent:turn_cancelled' ||
      event.type === 'agent:error' ||
      event.type === 'agent:stuck' ||
      event.type === 'agent:turn_final'
    ) {
      scheduleWatermarkAdvance(state.documentId);
    }
    switch (event.type) {
      case 'canvas:full': {
        // Normalize — older server builds may omit the derived caches.
        const doc = event.document;
        if (!doc.children) doc.children = [];
        if (!doc.shapes) doc.shapes = resolvePenTree(doc);
        if (!doc.tokens) doc.tokens = { colors: [], textStyles: [] };
        if (!doc.viewport) doc.viewport = { zoom: 1, panX: 120, panY: 80 };
        const local = get().document;
        const incomingEmpty = doc.children.length === 0 && doc.shapes.length === 0;
        const localEmpty = (local.children?.length ?? 0) === 0 && local.shapes.length === 0;
        // Authoritative snapshot swap (document:restore): the user asked to
        // roll the shared canvas back — REPLACE wholesale (deletions must
        // land; a merge would resurrect post-snapshot edits).
        if (event.reason === 'restore') {
          set({ document: doc, measuredBounds: {}, checkpoints: [], lastCheckpointSignature: null });
          // The outbox's queued edits were made against the PRE-restore
          // document — re-applying them would silently undo the restore.
          // Figma's reconnect contract explicitly re-orders intent around a
          // fresh copy; a restore is the user's explicit re-order.
          clearOutbox(get().documentId);
          break;
        }
        // Empty-incoming guard (shared canvas): a restarted WS service can
        // reply to `subscribe` with a fresh empty in-memory document while
        // this client just hydrated real content from the document's latest
        // snapshot — clobbering it would silently destroy the user's canvas.
        // Skip empty replaces when local content exists and no agent turn is
        // in flight. (The in-process service seeds itself from the DB latest
        // DocumentSnapshot, so a healthy path never trips this guard.)
        if (incomingEmpty && !localEmpty && !get().agentBusy) {
          // Server state taken (trivially) — the reconnect contract's
          // "fresh copy first" half is satisfied; re-apply queued edits.
          flushOutboxNow(get);
          break;
        }
        // Empty server doc DURING an agent turn: the agent cleared the
        // canvas server-side (pen_clear) and is rebuilding — follow the
        // rebuild from a clean slate (its re-adds arrive as patches).
        if (incomingEmpty && !localEmpty) {
          set({ document: doc, measuredBounds: {}, checkpoints: [], lastCheckpointSignature: null });
          flushOutboxNow(get);
          break;
        }
        if (localEmpty) {
          // Nothing local to protect — adopt the server document directly.
          set({ document: doc, measuredBounds: {}, checkpoints: [], lastCheckpointSignature: null });
          flushOutboxNow(get);
          break;
        }
        // Sync merge (R6): a non-empty full sync (subscribe reply /
        // request_full) MERGES per element — version+nonce rules — so
        // unsynced local edits (offline blip, server restart, reconnect
        // race) survive instead of being clobbered by the replace that used
        // to live here. Server-only elements arrive, local-only elements
        // stay, conflicts resolve deterministically. measuredBounds are
        // kept as derivation hints (they re-measure on the next flush).
        // Tombstones (Phase C R2): the server's deletedIds ride every
        // canvas:full — local-only ids in that set were deleted server-side
        // while we were away and are dropped instead of resurrecting.
        set({
          document: reconcileDocuments(local, doc, get().measuredBounds, event.deletedIds),
          checkpoints: [],
          lastCheckpointSignature: null,
        });
        // Figma reconnect contract (R5): the fresh copy has landed (merged) —
        // NOW re-apply the offline outbox. Ordering vs journal catch-up is
        // safe: catch-up skips patches (canvas state is ours), and our own
        // journaled user_patch rows echo back as duplicate-verdict acks.
        flushOutboxNow(get);
        break;
      }
      case 'canvas:patch': {
        // Intercept undo/redo — these require access to the undo/redo stacks
        // directly (not the document). They run IMMEDIATELY, not through the
        // coalescer queue, so a queued undo stays well-formed against the
        // current document state.
        if (event.patch.op === 'undo') {
          // Agent-driven undo (the pen_undo tool rides a canvas:patch sync
          // event): bypass the user-facing busy guard.
          agentDrivenUndoRedo = true;
          try {
            get().undo();
          } finally {
            agentDrivenUndoRedo = false;
          }
          break;
        }
        if (event.patch.op === 'redo') {
          agentDrivenUndoRedo = true;
          try {
            get().redo();
          } finally {
            agentDrivenUndoRedo = false;
          }
          break;
        }
        // Idempotent agent-patch application (C1): skip a verbatim duplicate
        // delivery of a patch we already applied (same toolCallId + content).
        // User edits carry no toolCallId and are never deduped. A duplicate
        // `add` would create a second node with the same id — append-only
        // canvas state can never undo that noiselessly.
        if (event.toolCallId) {
          const dedupeKey = patchDedupeKey(event.toolCallId, event.patch);
          if (dedupeKey) {
            if (processedAgentPatches.has(dedupeKey)) {
              break;
            }
            processedAgentPatches.add(dedupeKey);
          }
        }
        // All other patches go through the rAF coalescer (Phase 4 §4.4).
        // Multiple patches in the same tick collapse into ONE React commit;
        // per-patch pre-states are captured at flush time for the undo stack,
        // preserving unbatched undo semantics exactly.
        if (event.patch.op === 'add' || event.patch.op === 'bulk_add' || event.patch.op === 'add_subtree') {
          agentAddedShapesThisTurn = true;
        }
        // Turn-diff tracking: patches that carry a toolCallId were applied by
        // the AGENT (the runner tags every tool-emitted patch; user-initiated
        // patches via sendPatch never carry one). Attribute them to the last
        // assistant turn — the "+12 −3 ~5" diff summary card rolls these up.
        //
        // Attribution rule (deliberately NOT agentBusy-gated): the pi SDK
        // emits `message_end` for the assistant message that CARRIES the
        // tool-call requests BEFORE the tools execute, and the mandatory
        // critique loop emits a mid-run `agent:turn_end` before its fix-turn
        // patches — both flip streaming/agentBusy false while the turn's
        // patches are still arriving. The "last turn is an assistant turn"
        // check is the stable boundary: once the user sends the next prompt,
        // the last turn is a USER turn and late patches stop being attributed.
        if (event.toolCallId) {
          const record = patchToOpRecord(event.patch);
          if (record) {
            const live = get().turns[get().turns.length - 1];
            if (live && live.role === 'assistant') {
              set((s) => {
                const turns = [...s.turns];
                const last = turns[turns.length - 1];
                if (last && last.role === 'assistant') {
                  turns[turns.length - 1] = {
                    ...last,
                    patchOps: [...(last.patchOps ?? []), record],
                  };
                }
                return { turns };
              });
              if (live.messageId) {
                useSessionStore.getState().appendPatchOp(live.messageId, record);
              }
            }
          }
        }
        // Batched flush: collapse multiple patches in the same tick into
        // one React commit for the canvas document (origin/main's batching
        // model — preserves HEAD's per-patch diff attribution which happens
        // BEFORE the batch flush, so both are honored).
        enqueuePatch(event.patch);
        break;
      }
      case 'mutation:ack': {
        // Exactly-once verdict for one of OUR mutations (R1/R5). Accepted or
        // duplicate → the effect is durably server-side: prune every queued
        // entry with id <= lastMutationId (the Replicache rule) and, if newer
        // entries queued themselves while these were in flight, re-flush them
        // (the drain chain — see flushOutboxNow).
        if (event.status === 'accepted' || event.status === 'duplicate') {
          pruneOutboxUpTo(get().documentId, event.lastMutationId);
          if (outboxSize(get().documentId) > 0) {
            flushOutboxNow(get);
          }
          break;
        }
        // Rejected (gap / invalid id): the counter desynced from the server
        // clock (crash without a counter persist, both writes lost). The
        // queued entries are unappliable in order — Permanently drop them
        // with a VISIBLE toast (never a silent loss — the Replicache
        // permanent-error rule) and RESET the counter to server truth so
        // subsequent edits sync cleanly (nothing is in flight after the
        // drop, so restarting at lastMutationId is safe — a max()-only
        // anchor would leave the counter ahead forever and every later id
        // would gap-reject).
        resetMutationCounter(event.lastMutationId);
        const dropped = clearOutbox(get().documentId);
        if (dropped > 0) {
          toast.error('Offline canvas edits could not be synced', {
            description:
              `${dropped} queued edit${dropped === 1 ? '' : 's'} arrived out of order and ` +
              'were dropped to keep the canvas consistent.',
          });
        }
        break;
      }
      case 'agent:user_message': {
        // Turn's user half with identity (R3). The PROMPTING client created
        // the row locally at promptAgent — the messageId check makes its own
        // broadcast a no-op (idempotent). OTHER viewers and catch-up replay
        // of missed turns adopt it here: turn always (the shared transcript
        // is document-scoped), session-store row only when the session is
        // known locally (foreign viewers' transcripts are turns-only).
        if (event.messageId) {
          const known =
            get().turns.some((t) => t.messageId === event.messageId) ||
            !!useSessionStore.getState().messages[event.messageId];
          if (known) break;
        }
        const userTurn: ChatTurn = {
          id: event.messageId ?? `replay-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: 'user',
          text: event.text,
          toolCalls: [],
          streaming: false,
          ...(event.sessionId ? { sessionId: event.sessionId } : {}),
          ...(event.runId ? { runId: event.runId } : {}),
          ...(event.messageId ? { messageId: event.messageId } : {}),
          startedAt: Date.now(),
        };
        set((s) => ({ turns: [...s.turns, userTurn] }));
        if (event.sessionId && event.messageId) {
          useSessionStore.getState().adoptUserMessage(event.sessionId, {
            messageId: event.messageId,
            runId: event.runId,
            text: event.text,
          });
        }
        break;
      }
      case 'agent:turn_final': {
        // Turn's assistant half with FULL final content + honest status (R3).
        // Sent live at run teardown AND replayed by catch-up. The text
        // REPLACES the turn's accumulated text — a live viewer heals a
        // dropped-delta gap, a reconnecting client that saw a partial stream
        // heals to the complete text, and a fully-missed turn is filled from
        // empty. Idempotent: target by messageId first; the placeholder the
        // replayed message_start created (empty text) is the fallback; only
        // when neither exists does a fresh turn appear.
        const turns = get().turns;
        let targetIdx = -1;
        if (event.messageId) {
          for (let i = turns.length - 1; i >= 0; i--) {
            if (turns[i].messageId === event.messageId && turns[i].role === 'assistant') {
              targetIdx = i;
              break;
            }
          }
        }
        if (targetIdx === -1) {
          const last = turns[turns.length - 1];
          if (last && last.role === 'assistant' && (!last.endedAt || last.text === '')) {
            targetIdx = turns.length - 1;
          }
        }
        const messageStatus =
          event.status === 'error' || event.status === 'stuck'
            ? 'error'
            : event.status === 'cancelled'
              ? 'cancelled'
              : 'complete';
        const runStatus =
          event.status === 'stuck' ? 'stuck' : event.status === 'error' ? 'failed' : event.status === 'cancelled' ? 'cancelled' : 'completed';
        const isLastTurn = targetIdx === turns.length - 1;
        if (targetIdx === -1) {
          const fresh: ChatTurn = {
            id: event.messageId ?? `replay-final-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            role: 'assistant',
            text: event.text,
            toolCalls: [],
            streaming: false,
            endedAt: Date.now(),
            ...(event.status === 'error' || event.status === 'stuck'
              ? { error: event.error ?? 'Run failed' }
              : {}),
            ...(event.sessionId ? { sessionId: event.sessionId } : {}),
            ...(event.runId ? { runId: event.runId } : {}),
            ...(event.messageId ? { messageId: event.messageId } : {}),
            startedAt: Date.now(),
          };
          set((s) => ({ turns: [...s.turns, fresh] }));
        } else {
          set((s) => {
            const next = [...s.turns];
            const t = next[targetIdx];
            next[targetIdx] = {
              ...t,
              text: event.text,
              streaming: false,
              endedAt: Date.now(),
              ...(event.status === 'error' || event.status === 'stuck'
                ? { error: event.error ?? t.error ?? 'Run failed' }
                : {}),
              ...(event.messageId ? { messageId: event.messageId } : {}),
              ...(event.runId ? { runId: event.runId } : {}),
              ...(event.sessionId ? { sessionId: event.sessionId } : {}),
            };
            return { turns: next };
          });
        }
        // Session-store adoption (originating client / any client that knows
        // the ids): replace text + flip the honest terminal status. The
        // upsert inside also heals the SERVER row when the originating
        // client vanished before its finalize POST (LibreChat terminal
        // reconciliation).
        if (event.messageId) {
          useSessionStore.getState().adoptAssistantFinal(
            event.messageId,
            event.text,
            messageStatus,
            event.status === 'error' || event.status === 'stuck' ? (event.error ?? 'Run failed') : undefined,
          );
        }
        // Run finalization for locally-known runs (foreign runs have no row —
        // endRun no-ops). endRun's terminal-state guard absorbs duplicates.
        if (event.runId) {
          useSessionStore.getState().endRun(event.runId, runStatus);
        }
        // agentBusy only clears when the finalized turn is the LAST turn —
        // a foreign viewer replaying old turns must not unbusy its own state.
        if (isLastTurn) {
          set((s) =>
            s.agentBusy
              ? phaseFields(runStatusToPhase(event.status))
              : s,
          );
          resetBlockedEditToast();
        }
        break;
      }
      case 'agent:message_start': {
        // Placeholder creation (R3): the PROMPTING client created the
        // assistant turn at promptAgent (last turn is already assistant —
        // no-op for it). But OTHER viewers, and reconnect catch-up replay of
        // a fully-missed turn, arrive here with the user turn as `last` and
        // no assistant turn to stream into — without a placeholder their
        // deltas/tool calls had nowhere to land (text appended onto a stale
        // unrelated turn, or dropped). Create the streaming placeholder
        // exactly when the last turn is NOT an assistant turn. Per-LLM-
        // iteration message_start events no-op: the placeholder from the
        // first iteration is still the last turn (message_end flips
        // `streaming` but never appends a turn).
        const lastStart = get().turns[get().turns.length - 1];
        if (!lastStart || lastStart.role !== 'assistant') {
          const placeholder: ChatTurn = {
            id: `replay-turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            role: 'assistant',
            text: '',
            toolCalls: [],
            streaming: true,
            startedAt: Date.now(),
          };
          set((s) => ({ turns: [...s.turns, placeholder] }));
        }
        // C3 re-arm (2026-09-05 contract): foreign viewers and reload /
        // reconnect catch-up never ran promptAgent, so their `agentBusy`
        // used to stay false while the server was mid-run — no Stop button,
        // mutation guards open, double-prompt trivial. message_start is
        // journaled and replayed, so arming here heals every viewer. Also
        // re-arms after the critique loop's mid-run turn_end (busy flipped
        // false; the fix turn's message_start flips it back). Idempotent
        // when already armed (per-LLM-iteration message_start events land
        // while busy).
        if (!get().agentBusy) {
          resetBlockedEditToast();
          set(phaseFields('thinking'));
        }
        break;
      }
      case 'agent:message_delta': {
        // Phase: first streamed text after reasoning → 'finalizing' (the
        // BusyRow / status surfaces share the canonical vocabulary).
        if (get().runPhase === 'thinking') {
          set({ runPhase: 'finalizing' });
        }
        // Batched (R9b): accumulate the chunk and land it in ONE set() per
        // ~32ms window (see the module-level buffer docs). In test mode the
        // flush is synchronous, preserving the dispatch-then-assert
        // contract used across the store/bridge suites.
        pendingAssistantDeltas += event.text;
        if (process.env.NODE_ENV === 'test') {
          flushAssistantDeltas();
        } else {
          scheduleAssistantDeltaFlush();
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
      case 'agent:plan_proposed': {
        // PLAN mode: the agent submitted a plan and is blocked on approval.
        // Phase → 'awaiting_input' (busy-but-interactive: the approval triad
        // stays live, everything else stays gated).
        if (get().agentBusy) set({ runPhase: 'awaiting_input' });
        // Attach the proposal to the streaming assistant turn — the
        // PlanApprovalCard renders the triad (Build it / Keep planning).
        set((s) => {
          const turns = [...s.turns];
          const last = turns[turns.length - 1];
          if (last && last.role === 'assistant') {
            turns[turns.length - 1] = {
              ...last,
              planProposal: {
                planId: event.planId,
                title: event.title,
                summary: event.summary,
                steps: event.steps.map((st) => ({ step: st.step, description: st.description })),
                ...(event.openQuestions && event.openQuestions.length > 0
                  ? { openQuestions: event.openQuestions }
                  : {}),
                status: 'pending',
              },
            };
          }
          return { turns };
        });
        break;
      }
      case 'agent:plan_resolved': {
        // The plan gate closed (decision client POSTs; every viewer gets
        // the fan-out). Phase: resume 'thinking' (the agent continues).
        if (get().runPhase === 'awaiting_input') set({ runPhase: 'thinking' });
        // Update the card state so buttons disable and the
        // outcome (approved → building / revising with feedback) shows.
        set((s) => {
          const turns = [...s.turns];
          const last = turns[turns.length - 1];
          if (last?.planProposal && last.planProposal.planId === event.planId) {
            turns[turns.length - 1] = {
              ...last,
              planProposal: {
                ...last.planProposal,
                status: event.decision === 'build' ? 'approved' : event.decision === 'revise' ? 'revising' : 'timeout',
                ...(event.feedback ? { feedback: event.feedback } : {}),
              },
            };
          }
          return { turns };
        });
        break;
      }
      case 'agent:critique_skipped': {
        // Adaptive critique gating: deterministic validation only ran on
        // this turn (small/clean) — surface the saving instead of silence.
        set((s) => {
          const turns = [...s.turns];
          const last = turns[turns.length - 1];
          if (last && last.role === 'assistant' && !last.critiqueSkipped) {
            turns[turns.length - 1] = {
              ...last,
              critiqueSkipped: { reason: event.reason, savedLlmCalls: event.savedLlmCalls },
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
            // Id-guard: skip a tool call entry the turn already has. A
            // socket.io event in flight at disconnect time can be received
            // AND land in the journal-catchup replay window — without the
            // guard the entry duplicates in the toolCalls list.
            if (last.toolCalls.some((tc) => tc.id === event.toolCallId)) {
              return { turns };
            }
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
        // Phase: 'tool' (drives the BusyRow / status vocabulary). Deliberately
        // OUTSIDE the session-store mirror below — foreign/replayed runs have
        // no local Run row, but every viewer still sees the phase.
        if (get().agentBusy && get().runPhase !== 'awaiting_input') {
          set({ runPhase: 'tool' });
        }
        // Mirror to session store. Foreign/replayed runs have no local Run
        // row (turn_final stamps the runId onto a replayed turn) — the
        // mirror is a BEST-EFFORT record for the run's ToolCall timeline,
        // so a missing run skips it instead of throwing out of _onSync.
        const last = get().turns[get().turns.length - 1];
        if (last?.runId && useSessionStore.getState().runs[last.runId]) {
          useSessionStore.getState().startToolCall(
            last.runId,
            event.toolCallId,
            event.toolName,
            event.argsPreview,
          );
          // The session run's StatusBadge goes 'awaiting_tool' (its config
          // existed but was never assigned — dead until now).
          useSessionStore.getState().setRunStatus(last.runId, 'awaiting_tool');
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
        // Phase: back from 'tool' to 'thinking' (more reasoning / streaming
        // may follow); the session run's StatusBadge returns to 'running'.
        if (get().runPhase === 'tool') {
          set({ runPhase: 'thinking' });
        }
        {
          const lastT = get().turns[get().turns.length - 1];
          if (lastT?.runId && useSessionStore.getState().runs[lastT.runId]) {
            useSessionStore.getState().setRunStatus(lastT.runId, 'in_progress');
          }
        }
        break;
      }
      case 'agent:tool_progress': {
        // Live progress from a long-running tool (variant explorer, design
        // audit). Update the matching tool-call entry's progress text — the
        // pending tool card renders it so the user sees the tool working
        // instead of a silent spinner for minutes.
        set((s) => {
          const turns = [...s.turns];
          const last = turns[turns.length - 1];
          if (last && last.role === 'assistant') {
            const entry = last.toolCalls.find((tc) => tc.id === event.toolCallId);
            if (!entry || entry.progress === event.text) return { turns };
            turns[turns.length - 1] = {
              ...last,
              toolCalls: last.toolCalls.map((tc) =>
                tc.id === event.toolCallId ? { ...tc, progress: event.text } : tc,
              ),
            };
          }
          return { turns };
        });
        break;
      }
      case 'agent:turn_end': {
        const { documentId } = get();
        resetBlockedEditToast();
        set((s) => {
          const turns = [...s.turns];
          const last = turns[turns.length - 1];
          if (last && last.role === 'assistant') {
            turns[turns.length - 1] = { ...last, streaming: false, endedAt: Date.now() };
          }
          return { turns, ...phaseFields('completed') };
        });
        // Capture a snapshot of the canvas at end of turn, and finalize the
        // run in the session store. Guard against duplicate turn_end events
        // (the runner emits one on normal exit AND one at generator end) AND
        // against terminal states set by earlier events (turn_cancelled →
        // 'cancelled', agent:error → 'failed', agent:stuck → 'stuck'): a
        // trailing turn_end after those used to overwrite the honest status
        // back to 'completed' and double-capture a snapshot.
        const last = get().turns[get().turns.length - 1];
        if (last?.runId) {
          const run = useSessionStore.getState().getRun(last.runId);
          if (run && TERMINAL_RUN_STATUSES.has(run.status)) {
            // Already finalized — but the critique loop may have appended
            // more patches since the LAST closing event: re-sync the diff
            // records (idempotent upsert) before skipping.
            if (last.messageId) {
              useSessionStore.getState().resyncMessageDiff(last.messageId);
            }
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

        // Turn-end reveal (multi-screen stress-test fix): when this turn
        // added canvas content, ask the Canvas shell to make it visible. The
        // shell's 'reveal' zoom action is a no-op unless content lies
        // OUTSIDE the visible rect — the user's zoom/pan is never yanked for
        // in-view work. Dispatched via the same CustomEvent channel the menu
        // uses ('ac:canvas-zoom'); the shell owns the pixel size, we own the
        // turn lifecycle.
        if (agentAddedShapesThisTurn && typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('ac:canvas-zoom', { detail: { kind: 'reveal' } }));
        }
        agentAddedShapesThisTurn = false;
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
          // Turn fully done — ship the accumulated diff records to the
          // server (the finalize-time sync predates tool execution; this
          // is the one that carries the full patchOps roll-up).
          if (last.messageId) {
            useSessionStore.getState().resyncMessageDiff(last.messageId);
          }
        }
        // Cursor-style message queue flush: send the NEXT queued prompt
        // (if any) now that the turn is closed out. Runs after the snapshot
        // logic above so the queued turn starts from the finished state; the
        // duplicate-turn_end guard earlier in this case prevents a double
        // flush. promptAgent re-arms agentBusy, so exactly one queued
        // message is sent per completion. Suppressed after an explicit Stop
        // (the queue survives for manual send).
        //
        // Mid-run-turn_end guard (2026-09-05): the critique loop emits a
        // turn_end BEFORE its fix-turn — flushing same-tick would double-run
        // the agent. DEFER by 350ms and re-check: the fix turn's first event
        // (message_start / tool_call_start) re-arms busy within the window
        // and cancels the flush (the chip re-queues at the head, order kept).
        if (suppressQueueFlush) {
          suppressQueueFlush = false;
        } else {
          const next = get().queuedPrompts[0];
          if (next) {
            set((s) => ({ queuedPrompts: s.queuedPrompts.slice(1) }));
            setTimeout(() => {
              if (get().agentBusy) {
                // The run is live again (fix-turn / concurrent entry) — put
                // the prompt back at the head; the REAL turn_end flushes it.
                set((s) => ({ queuedPrompts: [next, ...s.queuedPrompts] }));
                return;
              }
              get().promptAgent(next.text, next.images, next.selection);
            }, 350);
          }
        }
        break;
      }
      case 'agent:turn_cancelled': {
        // Server-side Stop landed (agent:stop → canvas-sync aborts the run →
        // runner emits turn_cancelled). Finalize the turn + run as CANCELLED
        // for every viewer. Idempotent: endRun's terminal guard + the
        // turn_end terminal guard make a trailing turn_end / a duplicate
        // turn_cancelled a no-op.
        set((s) => {
          const turns = [...s.turns];
          const last = turns[turns.length - 1];
          if (last && last.role === 'assistant') {
            turns[turns.length - 1] = { ...last, streaming: false, endedAt: Date.now() };
          }
          return { turns, ...phaseFields('cancelled') };
        });
        const last = get().turns[get().turns.length - 1];
        if (last?.messageId) {
          useSessionStore.getState().finalizeAssistantMessage(last.messageId, 'cancelled');
        }
        if (last?.runId) {
          const ss = useSessionStore.getState();
          const run = ss.getRun(last.runId);
          if (run && !TERMINAL_RUN_STATUSES.has(run.status)) {
            ss.endRun(last.runId, 'cancelled');
          }
        }
        if (last?.sessionId) {
          useSessionStore.getState().captureSnapshot(
            get().documentId,
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
        // Consume the queue-flush suppression armed by stopAgent (the queue
        // survives a stop for manual send — same semantics as turn_end).
        suppressQueueFlush = false;
        break;
      }
      case 'agent:stuck': {
        // Stuck detector (C4): the same tool call failed identically N times
        // and the runner stopped the loop. Mark the message/run honestly —
        // 'stuck' is a distinct terminal status so history shows WHY the turn
        // produced what it did. Do NOT auto-flush queued prompts: the next
        // prompt would likely hit the same wall and needs a human look.
        set((s) => {
          const turns = [...s.turns];
          const last = turns[turns.length - 1];
          if (last && last.role === 'assistant') {
            turns[turns.length - 1] = {
              ...last,
              streaming: false,
              error: event.message,
              endedAt: Date.now(),
            };
          }
          return { turns, ...phaseFields('stuck') };
        });
        const last = get().turns[get().turns.length - 1];
        if (last?.messageId) {
          useSessionStore.getState().finalizeAssistantMessage(last.messageId, 'error', event.message);
        }
        if (last?.runId) {
          const ss = useSessionStore.getState();
          const run = ss.getRun(last.runId);
          if (run && !TERMINAL_RUN_STATUSES.has(run.status)) {
            ss.endRun(last.runId, 'stuck', event.message);
          }
        }
        toast.warning('Agent stuck', {
          description: event.message?.slice(0, 200) ?? 'Repeated identical tool failures.',
        });
        suppressQueueFlush = false;
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
          resetBlockedEditToast();
          return { turns, ...phaseFields('failed') };
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
        // Classified error surfacing (D4): the server attaches code/retryable
        // when it can (typed error envelope); the client classifier covers
        // raw HTTP failures where only the message exists. Distinct toast per
        // class so auth vs rate-limit vs network failures are distinguishable
        // at a glance instead of everything reading "Agent error".
        const errClass = classifyAgentError(event.message);
        const wireClass = agentErrorClassForCode(event.code);
        const effectiveClass =
          event.code && event.code !== 'unknown'
            ? { code: wireClass.code, retryable: event.retryable ?? wireClass.retryable, title: wireClass.title, hint: wireClass.hint }
            : errClass;
        toast.error(effectiveClass.title, {
          description:
            (event.message?.slice(0, 180) ?? 'Unknown error') +
            (effectiveClass.retryable ? ' — you can retry.' : ''),
        });
        // A failed turn still frees the agent — flush the next queued
        // prompt (Cursor queues survive a failed turn and retry in order).
        // Deferred + busy re-checked (same guard as the turn_end flush — see
        // the mid-run-turn_end comment there).
        if (!suppressQueueFlush) {
          const next = get().queuedPrompts[0];
          if (next) {
            set((s) => ({ queuedPrompts: s.queuedPrompts.slice(1) }));
            // Let the error state settle into the thread before the new run
            // appends its placeholder turns (avoids a same-tick mutation race
            // with the error reducer above).
            setTimeout(() => {
              if (get().agentBusy) {
                set((s) => ({ queuedPrompts: [next, ...s.queuedPrompts] }));
                return;
              }
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
      case 'presence:roster': {
        // Full roster snapshot (subscribe reply / participant leave): replace
        // the whole remote-presence map — idempotent, churn-proof.
        const next: Record<string, PresenceParticipant> = {};
        for (const p of event.roster) next[p.participantId] = p;
        set({ remotePresence: next });
        break;
      }
      case 'presence:update': {
        // One participant's volatile state (cursor/selection/idle).
        const p = event.participant;
        set((s) => ({ remotePresence: { ...s.remotePresence, [p.participantId]: p } }));
        break;
      }
      case 'agent:steer_rejected': {
        // Real-steer feedback (R8c): no live agent run accepted the message.
        // Ephemeral toast only — turn/run state must stay untouched.
        toast.warning(event.reason || 'Steer was not delivered — no agent run is active.');
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
        // Show the sub-agent dispatch in the chat. dispatchId keys the row
        // when the emitter provides one (parallel multitask workers share
        // subAgentType — without it the first result resolved EVERY row).
        set((s) => {
          const turns = [...s.turns];
          const last = turns[turns.length - 1];
          if (last && last.role === 'assistant') {
            const subAgents = [...(last.subAgents || []), {
              type: event.subAgentType,
              task: event.task,
              status: 'running' as const,
              ...(event.dispatchId ? { dispatchId: event.dispatchId } : {}),
            }];
            turns[turns.length - 1] = { ...last, subAgents };
          }
          return { turns };
        });
        break;
      }
      case 'agent:subagent_result': {
        // Update the sub-agent result. Match by dispatchId when present
        // (exact per-dispatch resolution); fall back to the legacy
        // type+running match for emitters that predate the field.
        set((s) => {
          const turns = [...s.turns];
          const last = turns[turns.length - 1];
          if (last?.subAgents) {
            const matches = (sa: NonNullable<ChatTurn['subAgents']>[number]) =>
              event.dispatchId
                ? sa.dispatchId === event.dispatchId
                : sa.type === event.subAgentType && sa.status === 'running';
            const subAgents = last.subAgents.map((sa) =>
              matches(sa)
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
        //
        // Per-run accumulation (P3-6): mirror the same delta into the
        // active Run row so the RunHistoryPanel can show "in/out/$" per
        // run, not just at the session level. The Run lives in the
        // SESSION store (not the canvas store), so we update it via
        // useSessionStore.getState() — same pattern as forkActiveSession.
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
        // Per-run accumulation: push the delta into the active Run row
        // (which lives in the session store). Fire-and-forget server sync
        // follows so the new totals persist server-side on SessionRun.
        if (usage) {
          const { activeSessionId } = get();
          if (activeSessionId) {
            const sessStore = useSessionStore.getState();
            const activeSession = sessStore.sessions[activeSessionId];
            const currentRunId = activeSession?.currentRunId;
            const activeRun = currentRunId ? sessStore.runs[currentRunId] : undefined;
            if (activeRun) {
              sessStore.updateRun(currentRunId!, {
                inputTokens: activeRun.inputTokens + usage.input,
                outputTokens: activeRun.outputTokens + usage.output,
                costUsd: activeRun.costUsd + usage.cost,
              });
              // Server sync — fire-and-forget; the localStorage cache is
              // authoritative for the live UI when the server is unreachable.
              if (typeof window !== 'undefined') {
                import('@/lib/sessions/server-sync').then(({ syncServerRun }) => {
                  syncServerRun(activeSessionId, {
                    runId: activeRun.id,
                    prompt: activeRun.prompt,
                    inputTokens: activeRun.inputTokens + usage.input,
                    outputTokens: activeRun.outputTokens + usage.output,
                    costUsd: activeRun.costUsd + usage.cost,
                    documentId: activeSession.documentId,
                  });
                });
              }
            }
          }
        }
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
      case 'agent:approval_request': {
        // The approval gate wrapped a destructive tool — the agent is BLOCKED
        // mid-turn until the user Allows or Denies (POST /api/agent/approvals
        // resolves the server-side promise).
        set({
          pendingApproval: {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            description: event.description,
            details: event.details,
          },
        });
        break;
      }
      case 'agent:approval_resolved': {
        // The deciding client posted its decision — close the dialog for
        // every OTHER viewer too (fan-out event).
        set((s) =>
          s.pendingApproval?.toolCallId === event.toolCallId
            ? { pendingApproval: null }
            : {},
        );
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

  submitApproval: async (toolCallId, approved, alwaysAllow) => {
    set({ pendingApproval: null });
    try {
      const res = await fetch('/api/agent/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolCallId, approved, alwaysAllow: alwaysAllow === true && approved }),
      });
      if (res.ok) {
        // Persist the always-allow preference locally so it survives
        // server restarts and is seeded into the next run's gate.
        const data = await res.json().catch(() => ({}));
        if (data.addedTool) {
          try {
            const { useSettings } = await import('../settings/store');
            const cur = useSettings.getState().alwaysAllowTools ?? [];
            if (!cur.includes(data.addedTool)) {
              useSettings.getState().set('alwaysAllowTools', [...cur, data.addedTool]);
            }
          } catch {
            // settings store not available (SSR) — the server-side
            // in-memory set is still updated; localStorage will catch
            // up on the next approval.
          }
        }
        import('sonner').then(({ toast }) => {
          if (approved) {
            const desc = data.addedTool
              ? `The agent will run ${data.addedTool} without asking again.`
              : 'The agent will run the operation.';
            toast.success('Approved', { description: desc });
          } else {
            toast.message('Denied', { description: 'The agent was told to skip this operation.' });
          }
        }).catch(() => {});
      }
    } catch (err) {
      console.error('Failed to submit approval:', err);
      import('sonner').then(({ toast }) => {
        toast.error('Could not deliver the decision', {
          description: 'The gate will time out as denied in 5 minutes.',
        });
      }).catch(() => {});
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
