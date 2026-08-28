// Agent session management types.
//
// Models the agent-driven canvas workflow under the SHARED-CANVAS model:
// the canvas Document is the single shared artifact; every Session is a
// conversation context attached to it. A Session contains Runs; each Run is
// one user prompt → agent execution; each Run emits Messages and
// ToolCallRecords. Snapshots are DOCUMENT-scoped (the canvas timeline),
// carrying sessionId/runId/messageId provenance so the History panel can
// show which chat produced each entry.
//
// Design references (see research notes):
//   - OpenAI Assistants Run lifecycle (queued → in_progress → awaiting_tool
//     → completed/failed/cancelled)
//   - v0 chat fork model (parent_chat_id + forked_from_message_id + git_branch)
//   - Replit checkpoints (snapshot per agent step, restorable)
//   - Lovable version history (linear versions with restore + bookmark)
//   - bolt.diy ActionRunner (per-action status, args, output)
//
// Persistence: localStorage via Zustand `persist` middleware (single-key
// JSON blob under `agentcanvas.sessions.v1`). Swap to Prisma/Postgres later
// by replacing the storage adapter — the store API stays the same.

import type { CanvasDocument } from '@/lib/canvas/types';

// ---- Session ----------------------------------------------------------------

export type SessionStatus = 'active' | 'archived';

/** A single conversation scoped to one shared canvas document. */
export interface Session {
  id: string;
  /// Stable document id this conversation is attached to. Multiple sessions
  /// share one document (the canvas is the shared artifact — switching chats
  /// never swaps it).
  documentId: string;
  /// LLM-generated or user-edited title. Auto-set from the first user
  /// message; user can rename at any time.
  title: string;

  // Lifecycle
  status: SessionStatus;
  pinned: boolean;
  starred: boolean;

  // Branching (v0 fork model — conversation forks share the canvas)
  parentId: string | null;
  forkedFromMessageId: string | null;
  forkedFromSnapshotId: string | null;
  isRoot: boolean;

  // Active pointers
  currentRunId: string | null;
  lastRunId: string | null;

  // Model snapshot at creation time (informational)
  model: string;

  // Stats
  messageCount: number;
  runCount: number;
  toolCallCount: number;

  // Relations (denormalized ids; objects joined at read time)
  messageIds: string[];
  runIds: string[];

  // Timestamps (ISO strings)
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
  archivedAt: string | null;
}

// ---- Run --------------------------------------------------------------------

/**
 * Canonical Run state machine (OpenAI Assistants + canvas extensions).
 *
 *   queued → in_progress
 *   in_progress → awaiting_tool → in_progress (loop per tool)
 *   in_progress → completed | failed | incomplete | stuck | cancelling
 *   awaiting_tool → cancelling
 *   cancelling → cancelled
 *
 * 'stuck' (agent-durability change): the runner's stuck detector fired —
 * the same tool call failed identically 3× and the loop was stopped before
 * burning the whole iteration budget. Terminal, like failed/cancelled.
 */
export type RunStatus =
  | 'queued'
  | 'in_progress'
  | 'awaiting_tool'
  | 'cancelling'
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'stuck'
  | 'incomplete';

/// Terminal run statuses — once a run is in one of these, later closing
/// events (a trailing turn_end after a turn_cancelled, a duplicate turn_end
/// after agent:error) must NOT overwrite it. Shared by the canvas store's
/// event guards and endRun's own guard so the honest status survives.
export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'cancelled',
  'completed',
  'failed',
  'stuck',
  'incomplete',
]);

export type RunTrigger =
  | 'user_message'
  | 'resume'
  | 'retry'
  | 'fork'
  | 'restore';

export interface Run {
  id: string;
  sessionId: string;
  status: RunStatus;
  trigger: RunTrigger;

  /// The user prompt that triggered this run (mirrored for quick display).
  prompt: string;

  model: string;
  toolCallIds: string[];
  stepCount: number;

  errorMessage: string | null;
  resultMessageId: string | null;

  /// ISO strings. `durationMs` is computed on completion.
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  durationMs: number | null;
}

// ---- Message ----------------------------------------------------------------

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';
export type MessageStatus = 'streaming' | 'complete' | 'error' | 'cancelled';

export interface Message {
  id: string;
  sessionId: string;
  runId: string | null;
  role: MessageRole;
  /// Final text of the message (accumulated from deltas).
  text: string;
  /// Image attachments staged with this user message (paste / drop /
  /// paperclip). Compact data URLs — persisted via the localStorage cache
  /// AND synced to the server DB (SessionAttachment rows) so history
  /// survives browser clears / syncs across devices.
  images?: import('../agent/attachments').AttachedImage[];
  /// Canvas selection the user had active when sending this message — the
  /// agent receives it as targeting context ("these/those" in the prompt).
  selection?: { count: number; names: string[] };
  /// Compact records of the canvas mutations this (assistant) message's
  /// tools applied — [{ op, count, summary }, …]. Rolled up into the
  /// turn-diff summary card. Mirrored to the server message row's
  /// diffSummary column.
  patchOps?: import('../agent/turn-diff').PatchOpRecord[];
  /// Tool calls emitted by this message (assistant messages only).
  toolCalls: ToolCallRecord[];
  status: MessageStatus;
  error?: string;
  /// User feedback on an assistant message (Cursor thumbs up/down pattern).
  /// Optional + client-local: absent = not rated; toggling back to the same
  /// value clears it.
  feedback?: 'up' | 'down';
  /// Snapshot captured at the end of this message's turn (assistant only).
  snapshotId: string | null;

  createdAt: string;
  completedAt: string | null;
}

// ---- Tool call record -------------------------------------------------------

export type ToolCallStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'error'
  | 'cancelled';

export interface ToolCallRecord {
  id: string;
  runId: string;
  sessionId: string;
  messageId: string | null;
  stepIndex: number;
  name: string;
  /// Raw args preview (truncated JSON string) for UI display.
  argsPreview: string;
  status: ToolCallStatus;
  summary: string | null;
  /// Canvas patch emitted by this tool call (if any).
  patchSummary: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
}

// ---- Snapshot ---------------------------------------------------------------

export type SnapshotSource =
  | 'turn_end'
  | 'fork'
  | 'restore'
  | 'manual';

/**
 * A captured canvas state. DOCUMENT-scoped (shared canvas model): the
 * snapshot timeline belongs to the canvas, not to any one chat. Stored
 * inline (small enough for a demo; in production this would be a compressed
 * blob in object storage).
 */
export interface Snapshot {
  id: string;
  /// Owning document — all chats on this canvas share the timeline.
  documentId: string;
  /// Provenance: the chat whose turn produced this snapshot. Informational
  /// only — the session may since have been deleted. Null for system captures.
  sessionId: string | null;
  parentSnapshotId: string | null;
  source: SnapshotSource;
  sourceRunId: string | null;
  sourceMessageId: string | null;

  /// Deep copy of the canvas document at capture time.
  document: CanvasDocument;

  /// True when hydrated from the server LIST endpoint (which omits the heavy
  /// document JSON) — a metadata placeholder until fetchDocumentSnapshot
  /// fills it in on restore. Boot-time hydration skips remote entries.
  remote?: boolean;

  /// Number of shapes (for quick display in the snapshot list).
  nodeCount: number;

  /// Optional user/system label.
  label: string | null;
  bookmarked: boolean;

  createdAt: string;
  createdBy: 'agent' | 'user' | 'system';
}

// ---- Store-facing helpers ---------------------------------------------------

export interface SessionFilter {
  documentId?: string;
  status?: SessionStatus;
  pinnedOnly?: boolean;
  search?: string;
}

export interface SessionStats {
  totalSessions: number;
  activeSessions: number;
  archivedSessions: number;
  totalRuns: number;
  totalMessages: number;
  totalToolCalls: number;
  totalSnapshots: number;
}
