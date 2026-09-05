// Agent session store — persisted to localStorage via Zustand `persist`.
//
// Single source of truth for: sessions (conversation contexts), runs,
// messages, tool-call records, and DOCUMENT-scoped canvas snapshots. The
// canvas store (lib/canvas/store.ts) bridges into this store: every
// promptAgent call starts a Run; every streaming event updates a Message /
// ToolCallRecord; every turn_end captures a Snapshot on the shared canvas.
//
// SHARED-CANVAS MODEL: the Document is the shared artifact. Multiple
// sessions attach to one documentId and mutate ONE canvas. Snapshots belong
// to the document (with sessionId/runId/messageId provenance), never to a
// chat — deleting a chat preserves the canvas timeline.
//
// Persistence model
// -----------------
// localStorage key: `agentcanvas.sessions.v1` (version 2 — see migrate)
// Value: { sessions, runs, messages, toolCalls, snapshots, activeSessionByDoc }
//
// State invariants
// ----------------
// 1. Only one Run per Session may be in a non-terminal status
//    (queued | in_progress | awaiting_tool | cancelling).
// 2. Forking sets parentId + forkedFromMessageId on the new session and
//    copies the parent's message prefix (conversation fork). Runs, tool
//    calls, and snapshots are NOT copied — the canvas is shared.
// 3. Snapshots are append-only — restore creates a NEW snapshot with
//    source: 'restore' pointing at the restored one. Forward history
//    is never destroyed (Lovable model).
// 4. Snapshot entries hydrated from the server list endpoint carry
//    remote: true (metadata placeholder, no document JSON) until
//    fetchDocumentSnapshot fills them in on restore.

'use client';

import { create } from 'zustand';
import { persist, type PersistStorage } from 'zustand/middleware';
import { v4 as uuid } from 'uuid';
import type { CanvasDocument } from '@/lib/canvas/types';
import type {
  Session, Run, Message, ToolCallRecord, Snapshot,
  SessionFilter, SessionStats, SessionStatus,
  RunStatus, RunTrigger, ToolCallStatus, SnapshotSource,
} from './types';
import { TERMINAL_RUN_STATUSES } from './types';

// ---- ID + time helpers ------------------------------------------------------

const nowISO = () => new Date().toISOString();

function newId(prefix: string): string {
  return `${prefix}_${uuid().slice(0, 12)}`;
}

function deepClone<T>(v: T): T {
  if (typeof structuredClone === 'function') return structuredClone(v);
  return JSON.parse(JSON.stringify(v));
}

/// Placeholder document for remote (metadata-only) snapshot entries — the
/// server LIST endpoint omits the heavy document JSON; restore fetches the
/// real payload before use. Never rendered or restored as-is.
const EMPTY_PLACEHOLDER_DOC: CanvasDocument = {
  id: 'remote-placeholder',
  name: 'Remote snapshot',
  version: '2.17',
  children: [],
  variables: undefined,
  themes: undefined,
  background: '#f8fafc',
  viewport: { zoom: 1, panX: 0, panY: 0 },
  shapes: [],
  tokens: { colors: [], textStyles: [] },
};

// ---- Default factory --------------------------------------------------------

function makeSession(documentId: string, partial?: Partial<Session>): Session {
  const ts = nowISO();
  return {
    id: newId('sess'),
    documentId,
    title: 'New chat',
    status: 'active',
    pinned: false,
    starred: false,
    parentId: null,
    forkedFromMessageId: null,
    forkedFromSnapshotId: null,
    isRoot: true,
    currentRunId: null,
    lastRunId: null,
    model: 'unresolved',
    messageCount: 0,
    runCount: 0,
    toolCallCount: 0,
    tags: [] as string[],
    messageIds: [],
    runIds: [],
    createdAt: ts,
    updatedAt: ts,
    lastOpenedAt: ts,
    archivedAt: null,
    ...partial,
  };
}

// ---- Store interface --------------------------------------------------------

interface SessionStoreState {
  // Indices
  sessions: Record<string, Session>;
  runs: Record<string, Run>;
  messages: Record<string, Message>;
  toolCalls: Record<string, ToolCallRecord>;
  snapshots: Record<string, Snapshot>;

  // Active session per document (documentId → sessionId)
  activeSessionByDoc: Record<string, string>;

  // ---- Reads ----
  listSessions: (filter?: SessionFilter) => Session[];
  getSession: (id: string) => Session | undefined;
  getActiveSession: (documentId: string) => Session | undefined;
  getRun: (id: string) => Run | undefined;
  listRuns: (sessionId: string) => Run[];
  getMessage: (id: string) => Message | undefined;
  listMessages: (sessionId: string) => Message[];
  getToolCall: (id: string) => ToolCallRecord | undefined;
  listToolCalls: (runId: string) => ToolCallRecord[];
  getSnapshot: (id: string) => Snapshot | undefined;
  /// Document-scoped snapshot listing (shared canvas model) — newest first.
  listSnapshots: (documentId: string) => Snapshot[];
  getStats: (documentId?: string) => SessionStats;

  // ---- Mutations: Sessions ----
  createSession: (documentId: string, partial?: Partial<Session>) => Session;
  /// Record the RESOLVED model on a session (from agent:model_info events).
  /// Sessions seed with 'unresolved' — the canvas store calls this when the
  /// runner reports the actual model (which can differ from the configured
  /// one due to resolver fallbacks).
  setSessionModel: (id: string, model: string) => void;
  setActiveSession: (documentId: string, sessionId: string) => void;
  renameSession: (id: string, title: string) => void;
  autoTitleFromPrompt: (sessionId: string, prompt: string) => void;
  togglePin: (id: string) => void;
  toggleStar: (id: string) => void;
  /// Replace the session's `tags` array (full replacement — the PATCH API
  /// sends the whole array, not a delta). Syncs to server fire-and-forget.
  setSessionTags: (id: string, tags: string[]) => void;
  archiveSession: (id: string) => void;
  unarchiveSession: (id: string) => void;
  deleteSession: (id: string) => void;
  forkSession: (parentId: string, fromMessageId: string | null) => Session | undefined;
  touchSession: (id: string) => void;

  // ---- Mutations: Runs ----
  startRun: (sessionId: string, prompt: string, trigger?: RunTrigger, model?: string) => Run;
  endRun: (runId: string, status: RunStatus, errorMessage?: string) => void;
  /// Non-terminal status transition for a LIVE run ('awaiting_tool' /
  /// 'cancelling' / 'in_progress') — drives the StatusBadge phases. Terminal
  /// runs ignore it; see the implementation for the full rationale.
  setRunStatus: (runId: string, status: RunStatus) => void;
  /// Patch arbitrary Run fields (cost, tokens, model). Used by the canvas
  /// store's per-run cost accumulator (agent:context_update handler). Only
  /// touches the supplied fields — never rewrites status/error/dates.
  updateRun: (runId: string, patch: Partial<Pick<Run, 'inputTokens' | 'outputTokens' | 'costUsd' | 'model'>>) => void;
  /// Delete a single run + its tool-call records + drop it from the parent
  /// session's runIds. Does NOT cascade to messages (the run's user/assistant
  /// messages remain in the transcript as historical context). The server row
  /// is also deleted via DELETE /api/sessions/[id]/runs/[runId] if it exists.
  deleteRun: (runId: string) => void;
  /// Boot-time zombie sweep (durability fix): finalize runs/messages that a
  /// crash or reload left in a live-looking state ('in_progress' /
  /// 'streaming'). Only touches records older than `maxAgeMs` so a run that
  /// is genuinely still streaming server-side (page reloaded mid-run, socket
  /// reconnected, remaining events will arrive and finalize normally) is
  /// never touched. Called once from the canvas store's init().
  reconcileStaleActivity: (maxAgeMs?: number) => { runs: number; messages: number };

  // ---- Mutations: Messages ----
  appendUserMessage: (
    sessionId: string,
    runId: string,
    text: string,
    images?: import('../agent/attachments').AttachedImage[],
    selection?: { count: number; names: string[] },
  ) => Message;
  appendAssistantMessage: (sessionId: string, runId: string) => Message;
  appendAssistantText: (messageId: string, text: string) => void;
  finalizeAssistantMessage: (messageId: string, status?: 'complete' | 'error' | 'cancelled', error?: string) => void;
  /// Record one canvas mutation against the assistant message whose turn
  /// applied it (roll-up input for the turn-diff summary card).
  appendPatchOp: (messageId: string, record: import('../agent/turn-diff').PatchOpRecord) => void;
  /// Re-sync a finalized message to the server with its CURRENT diff
  /// records. Needed because the pi SDK emits `message_end` BEFORE the
  /// tools execute (and the critique loop appends more patches after the
  /// mid-run `turn_end`), so the finalize-time sync would ship an empty
  /// diffSummary. Idempotent upsert — safe on every turn_end.
  resyncMessageDiff: (messageId: string) => void;
  /// Import messages fetched from the server (cross-device hydration).
  /// Only fills GAPS — messages already known locally (by id) are kept as-is.
  importServerMessages: (sessionId: string, messages: Array<{
    id: string; role: string; text: string; status?: string; error?: string | null;
    runId?: string | null; createdAt?: string;
    images?: import('../agent/attachments').AttachedImage[];
    patchOps?: import('../agent/turn-diff').PatchOpRecord[];
  }>) => number;
  /// Journal-replay adoption (Phase B R3): create a USER message row under
  /// an id the JOURNAL carried (id-adopting, no server POST — the row came
  /// FROM the server). Used by catch-up replay of `agent:user_message` for
  /// a turn this client never saw locally. No-ops when the session is
  /// unknown locally (a foreign viewer's transcript is turns-array only) or
  /// the message id already exists.
  adoptUserMessage: (sessionId: string, msg: {
    messageId: string; runId?: string; text: string;
  }) => void;
  /// Journal-replay adoption (Phase B R3): set an assistant message's FINAL
  /// text + honest terminal status, id-adopted from `agent:turn_final`.
  /// REPLACES the text (turn_final carries the full final text — a partial
  /// stream accumulated before a disconnect heals to the complete one).
  /// Unlike the local finalize path, the server row sync still fires: the
  /// originating client may have gone offline before ITS finalize POST, and
  /// the upsert-by-messageId is idempotent — the LibreChat terminal
  /// reconciliation pattern.
  adoptAssistantFinal: (messageId: string, text: string, status: 'complete' | 'error' | 'cancelled', error?: string) => void;
  /// Remove every message AFTER `afterMessageId` (exclusive) in the session.
  /// Used by the chat's inline edit-and-resend (Cursor semantics: editing a
  /// user message discards the branch that followed it in the live thread).
  /// Returns the number of messages removed. Idempotent when the message is
  /// last or unknown.
  truncateMessagesAfter: (sessionId: string, afterMessageId: string) => number;
  /// Set / toggle user feedback (thumbs up/down) on a message. Passing the
  /// value the message already carries CLEARS it (toggle semantics).
  setMessageFeedback: (messageId: string, feedback: 'up' | 'down') => void;

  // ---- Mutations: Tool calls ----
  startToolCall: (runId: string, toolCallId: string, name: string, argsPreview: string) => ToolCallRecord;
  endToolCall: (toolCallId: string, success: boolean, summary: string, patchSummary?: string) => void;

  // ---- Mutations: Snapshots (document-scoped, shared canvas model) ----
  captureSnapshot: (documentId: string, document: CanvasDocument, opts?: {
    sessionId?: string | null;
    source?: SnapshotSource;
    sourceRunId?: string;
    sourceMessageId?: string;
    label?: string;
    createdBy?: 'agent' | 'user' | 'system';
  }) => Snapshot;
  restoreSnapshot: (documentId: string, snapshotId: string) => Snapshot | undefined;
  /// Upsert a server-side snapshot into the local registry (adopting the
  /// server id). Entries without a `document` payload are stored as
  /// metadata-only placeholders (remote: true) — the History panel lists
  /// them and restore fetches the full document on demand.
  ingestServerSnapshot: (snap: {
    id: string;
    documentId: string;
    sessionId?: string | null;
    messageId?: string | null;
    runId?: string | null;
    source?: string;
    nodeCount?: number;
    label?: string | null;
    bookmarked?: boolean;
    createdAt?: string;
    document?: unknown;
  }) => Snapshot | undefined;
  bookmarkSnapshot: (snapshotId: string) => void;
  labelSnapshot: (snapshotId: string, label: string) => void;
  /// Permanently delete a document snapshot. Refuses to delete bookmarked
  /// snapshots (the user marked them as keepers). Document-scoped — no
  /// session bookkeeping (snapshots outlive chats on the shared canvas).
  deleteSnapshot: (snapshotId: string) => void;

  // ---- Bulk ----
  /// Delete every session AND every snapshot of a document (full canvas
  /// wipe — used by Settings → "Clear all chats").
  clearAllForDocument: (documentId: string) => void;
}

// ---- Store implementation ---------------------------------------------------

// ---- Throttled persist storage (R9b) -------------------------------------------
//
// Zustand v5 persist has NO write throttle: every setState (including the
// per-token-chunk `appendAssistantText` during streaming) runs
// partialize → JSON.stringify(ENTIRE dataset: sessions + runs + messages +
// toolCalls + snapshots — routinely multi-MB) → localStorage.setItem,
// synchronously. That is O(dataset) main-thread work dozens of times per
// second (research round-2 gap 9).
//
// This PersistStorage coalesces writes: the first write after an idle gap
// lands immediately (fresh disk early), writes inside a 300ms window merge
// into one trailing flush (last-wins — the state object already IS the
// latest). Excalidraw's 300ms debounce number. pagehide / visibilitychange
// / beforeunload force a flush so closing the tab can't lose the window's
// writes. getItem stays a plain disk read (rehydrate runs once at boot,
// before any write exists).
//
// The partialize slice is deliberately unchanged (full dataset, no
// streaming-text blanking): the dominant cost was the WRITE RATE, and
// blanking in-flight text would trade away mid-stream crash recovery of
// partial answers (deltas are not journaled) for a size win that doesn't
// exist — snapshots dominate the payload, not the streaming text.
const PERSIST_WRITE_INTERVAL_MS = 300;

interface ThrottledWrite {
  name: string;
  value: unknown;
}
let throttledPending: ThrottledWrite | null = null;
let throttledTimer: ReturnType<typeof setTimeout> | null = null;
let throttledLastWriteAt = 0;

function throttledFlush(): void {
  if (throttledTimer) {
    clearTimeout(throttledTimer);
    throttledTimer = null;
  }
  const pending = throttledPending;
  throttledPending = null;
  if (!pending || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(pending.name, JSON.stringify(pending.value));
    throttledLastWriteAt = Date.now();
  } catch {
    // Quota / privacy-mode failures were silently swallowed by the previous
    // createJSONStorage path too — persisting must never break the app.
  }
}

/// Test hook: synchronously land any pending throttled write.
export function __flushThrottledSessionPersist(): void {
  throttledFlush();
}

if (typeof window !== 'undefined') {
  // The "tab close loses the last 300ms" hole: flush on pagehide (covers
  // mobile tab swipe), beforeunload (desktop close), and visibilitychange
  // hidden (backgrounding — may never come back).
  window.addEventListener('pagehide', throttledFlush);
  window.addEventListener('beforeunload', throttledFlush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') throttledFlush();
  });
}

function createThrottledJSONStorage(): PersistStorage<unknown> {
  if (typeof window === 'undefined') {
    // SSR-safe no-op storage (same stub createJSONStorage produced).
    return {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    };
  }
  return {
    getItem: (name: string) => {
      // Plain disk read (same semantics as the createJSONStorage path).
      // Deliberately NOT shadowed by a pending throttled write: rehydrate
      // runs once at boot before any writes exist, and tests that stage a
      // fixture through localStorage expect to read their own bytes back.
      try {
        const raw = window.localStorage.getItem(name);
        return raw ? (JSON.parse(raw) as { state: unknown; version?: number }) : null;
      } catch {
        return null;
      }
    },
    setItem: (name: string, value: unknown) => {
      throttledPending = { name, value };
      const elapsed = Date.now() - throttledLastWriteAt;
      if (elapsed >= PERSIST_WRITE_INTERVAL_MS) {
        // Leading edge: write now, which also resets the window.
        throttledFlush();
        return;
      }
      if (!throttledTimer) {
        throttledTimer = setTimeout(throttledFlush, PERSIST_WRITE_INTERVAL_MS - elapsed);
      }
    },
    removeItem: (name: string) => {
      throttledPending = null;
      if (throttledTimer) {
        clearTimeout(throttledTimer);
        throttledTimer = null;
      }
      try {
        window.localStorage.removeItem(name);
      } catch {
        // ignore
      }
    },
  };
}

export const useSessionStore = create<SessionStoreState>()(
  persist(
    (set, get) => ({
      sessions: {},
      runs: {},
      messages: {},
      toolCalls: {},
      snapshots: {},
      activeSessionByDoc: {},

      // ---- Reads ----
      listSessions: (filter) => {
        const all = Object.values(get().sessions);
        let list = all;
        if (filter?.documentId) list = list.filter((s) => s.documentId === filter.documentId);
        if (filter?.status) list = list.filter((s) => s.status === filter.status);
        if (filter?.pinnedOnly) list = list.filter((s) => s.pinned);
        if (filter?.search) {
          const q = filter.search.toLowerCase();
          list = list.filter((s) => s.title.toLowerCase().includes(q));
        }
        // Sort: pinned first, then lastOpenedAt desc.
        return [...list].sort((a, b) => {
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
          return b.lastOpenedAt.localeCompare(a.lastOpenedAt);
        });
      },

      getSession: (id) => get().sessions[id],

      getActiveSession: (documentId) => {
        const id = get().activeSessionByDoc[documentId];
        if (!id) return undefined;
        return get().sessions[id];
      },

      getRun: (id) => get().runs[id],

      listRuns: (sessionId) => {
        const session = get().sessions[sessionId];
        if (!session) return [];
        return session.runIds
          .map((id) => get().runs[id])
          .filter(Boolean)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      },

      getMessage: (id) => get().messages[id],

      listMessages: (sessionId) => {
        const session = get().sessions[sessionId];
        if (!session) return [];
        return session.messageIds
          .map((id) => get().messages[id])
          .filter(Boolean)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      },

      getToolCall: (id) => get().toolCalls[id],

      listToolCalls: (runId) => {
        const run = get().runs[runId];
        if (!run) return [];
        return run.toolCallIds
          .map((id) => get().toolCalls[id])
          .filter(Boolean)
          .sort((a, b) => a.stepIndex - b.stepIndex);
      },

      getSnapshot: (id) => get().snapshots[id],

      listSnapshots: (documentId) => {
        // Document-scoped (shared canvas model): the timeline belongs to the
        // canvas, aggregated across every chat that produced entries.
        return Object.values(get().snapshots)
          .filter((snap) => snap.documentId === documentId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      },

      getStats: (documentId) => {
        const sessions = Object.values(get().sessions);
        const filtered = documentId ? sessions.filter((s) => s.documentId === documentId) : sessions;
        const snapshots = Object.values(get().snapshots);
        const filteredSnaps = documentId
          ? snapshots.filter((snap) => snap.documentId === documentId)
          : snapshots;
        const stats: SessionStats = {
          totalSessions: filtered.length,
          activeSessions: filtered.filter((s) => s.status === 'active').length,
          archivedSessions: filtered.filter((s) => s.status === 'archived').length,
          totalRuns: filtered.reduce((n, s) => n + s.runCount, 0),
          totalMessages: filtered.reduce((n, s) => n + s.messageCount, 0),
          totalToolCalls: filtered.reduce((n, s) => n + s.toolCallCount, 0),
          totalSnapshots: filteredSnaps.length,
        };
        return stats;
      },

      // ---- Sessions ----
      createSession: (documentId, partial) => {
        const session = makeSession(documentId, partial);
        set((s) => ({
          sessions: { ...s.sessions, [session.id]: session },
          activeSessionByDoc: { ...s.activeSessionByDoc, [documentId]: session.id },
        }));
        // Sync to server (Phase 3: server-side persistence).
        // Fire-and-forget — localStorage is the fast cache, server is the source of truth.
        // The client session id is passed so the server row shares the SAME id
        // (previously the server generated its own cuid, so every subsequent
        // run/message/snapshot sync failed with a foreign-key violation).
        if (typeof window !== 'undefined') {
          import('./server-sync').then(({ createServerSession }) => {
            createServerSession({
              id: session.id,
              documentId: session.documentId,
              title: session.title,
              parentId: session.parentId,
              tags: session.tags,
            });
          });
        }
        return session;
      },

      setActiveSession: (documentId, sessionId) => {
        const session = get().sessions[sessionId];
        if (!session || session.documentId !== documentId) return;
        set((s) => ({
          activeSessionByDoc: { ...s.activeSessionByDoc, [documentId]: sessionId },
          sessions: {
            ...s.sessions,
            [sessionId]: { ...session, lastOpenedAt: nowISO() },
          },
        }));
      },

      renameSession: (id, title) => {
        const trimmed = title.trim();
        if (!trimmed) return;
        set((s) => {
          const session = s.sessions[id];
          if (!session) return s;
          return {
            sessions: {
              ...s.sessions,
              [id]: { ...session, title: trimmed, updatedAt: nowISO() },
            },
          };
        });
        // Sync to server.
        if (typeof window !== 'undefined') {
          import('./server-sync').then(({ updateServerSession }) => {
            updateServerSession(id, { title: trimmed });
          });
        }
      },

      setSessionModel: (id, model) => {
        const trimmed = model.trim();
        if (!trimmed) return;
        set((s) => {
          const session = s.sessions[id];
          // No-op when unchanged (model_info fires per turn — don't spam
          // the persist middleware with identical writes).
          if (!session || session.model === trimmed) return s;
          return {
            sessions: {
              ...s.sessions,
              [id]: { ...session, model: trimmed, updatedAt: nowISO() },
            },
          };
        });
      },

      autoTitleFromPrompt: (sessionId, prompt) => {
        const session = get().sessions[sessionId];
        if (!session) return;
        // Only auto-title if still on the default placeholder, OR if this
        // is the first message (messageCount <= 1).
        if (session.title !== 'New chat' && session.messageCount > 1) return;
        const trimmed = prompt.trim();
        if (!trimmed) return;
        const title = trimmed.length > 48 ? trimmed.slice(0, 48).trimEnd() + '…' : trimmed;
        set((s) => ({
          sessions: {
            ...s.sessions,
            [sessionId]: { ...session, title, updatedAt: nowISO() },
          },
        }));
      },

      togglePin: (id) => {
        set((s) => {
          const session = s.sessions[id];
          if (!session) return s;
          return {
            sessions: {
              ...s.sessions,
              [id]: { ...session, pinned: !session.pinned, updatedAt: nowISO() },
            },
          };
        });
      },

      toggleStar: (id) => {
        set((s) => {
          const session = s.sessions[id];
          if (!session) return s;
          return {
            sessions: {
              ...s.sessions,
              [id]: { ...session, starred: !session.starred, updatedAt: nowISO() },
            },
          };
        });
      },

      setSessionTags: (id, tags) => {
        // Normalize: dedupe, trim, drop empties, cap at 20 tags / 30 chars each.
        const seen = new Set<string>();
        const normalized: string[] = [];
        for (const t of tags) {
          const trimmed = (t ?? '').trim().slice(0, 30);
          if (!trimmed || seen.has(trimmed) || normalized.length >= 20) continue;
          seen.add(trimmed);
          normalized.push(trimmed);
        }
        set((s) => {
          const session = s.sessions[id];
          if (!session) return s;
          return {
            sessions: {
              ...s.sessions,
              [id]: { ...session, tags: normalized, updatedAt: nowISO() },
            },
          };
        });
        // Sync to server (full replacement — PATCH sends the whole array).
        if (typeof window !== 'undefined') {
          import('./server-sync').then(({ updateServerSession }) => {
            updateServerSession(id, { tags: normalized });
          });
        }
      },

      archiveSession: (id) => {
        set((s) => {
          const session = s.sessions[id];
          if (!session) return s;
          const ts = nowISO();
          // If archiving the active session, clear the active pointer.
          const active = { ...s.activeSessionByDoc };
          if (active[session.documentId] === id) delete active[session.documentId];
          return {
            sessions: {
              ...s.sessions,
              [id]: { ...session, status: 'archived', archivedAt: ts, updatedAt: ts },
            },
            activeSessionByDoc: active,
          };
        });
      },

      unarchiveSession: (id) => {
        set((s) => {
          const session = s.sessions[id];
          if (!session) return s;
          const ts = nowISO();
          return {
            sessions: {
              ...s.sessions,
              [id]: { ...session, status: 'active', archivedAt: null, updatedAt: ts },
            },
          };
        });
      },

      deleteSession: (id) => {
        set((s) => {
          const session = s.sessions[id];
          if (!session) return s;
          // Cascade delete: messages, runs, tool calls. Snapshots are
          // DOCUMENT-scoped (shared canvas) — they outlive the chat and stay
          // in the canvas timeline with their sessionId provenance intact.
          const messages = { ...s.messages };
          const runs = { ...s.runs };
          const toolCalls = { ...s.toolCalls };
          for (const mid of session.messageIds) delete messages[mid];
          for (const rid of session.runIds) {
            const run = runs[rid];
            if (run) {
              for (const tcid of run.toolCallIds) delete toolCalls[tcid];
              delete runs[rid];
            }
          }
          const sessions = { ...s.sessions };
          delete sessions[id];
          const active = { ...s.activeSessionByDoc };
          if (active[session.documentId] === id) delete active[session.documentId];
          return { sessions, runs, messages, toolCalls, activeSessionByDoc: active };
        });
      },

      forkSession: (parentId, fromMessageId) => {
        // SHARED-CANVAS MODEL: forking forks the CONVERSATION, not the canvas.
        // The new chat gets a copy of the parent's message prefix (all of it,
        // or up to & including fromMessageId) so it has the context to
        // diverge; runs / tool-call records / snapshots are NOT copied (they
        // stay with the parent) and the canvas is untouched — both chats
        // continue mutating the same shared document.
        const parent = get().sessions[parentId];
        if (!parent) return undefined;
        const fork = makeSession(parent.documentId, {
          title: `Fork of ${parent.title}`,
          parentId,
          forkedFromMessageId: fromMessageId,
          forkedFromSnapshotId: null,
          isRoot: false,
          model: parent.model,
          // Carry tags over so the fork stays grouped under the same
          // filter chips as the parent (matches v0 "Connections preserved
          // when forking a chat" pattern).
          tags: [...parent.tags],
        });
        // Copy the conversation prefix.
        const msgs = get().listMessages(parentId);
        let prefix = msgs;
        if (fromMessageId) {
          const idx = msgs.findIndex((m) => m.id === fromMessageId);
          if (idx >= 0) prefix = msgs.slice(0, idx + 1);
        }
        const messages = { ...get().messages };
        const forkMessageIds: string[] = [];
        for (const m of prefix) {
          const copy: Message = {
            ...m,
            id: newId('msg'),
            sessionId: fork.id,
            // Runs and their tool-call records belong to the parent — the
            // fork keeps the readable transcript only.
            runId: null,
            toolCalls: [],
            snapshotId: null,
            feedback: undefined,
            status: m.status === 'streaming' ? 'complete' : m.status,
            createdAt: m.createdAt,
            completedAt: m.completedAt,
          };
          messages[copy.id] = copy;
          forkMessageIds.push(copy.id);
        }
        set({
          sessions: {
            ...get().sessions,
            [fork.id]: {
              ...fork,
              messageIds: forkMessageIds,
              messageCount: forkMessageIds.length,
            },
          },
          messages,
          activeSessionByDoc: {
            ...get().activeSessionByDoc,
            [parent.documentId]: fork.id,
          },
        });
        return get().sessions[fork.id];
      },

      touchSession: (id) => {
        set((s) => {
          const session = s.sessions[id];
          if (!session) return s;
          return {
            sessions: {
              ...s.sessions,
              [id]: { ...session, lastOpenedAt: nowISO(), updatedAt: nowISO() },
            },
          };
        });
      },

      // ---- Runs ----
      startRun: (sessionId, prompt, trigger = 'user_message', model) => {
        const session = get().sessions[sessionId];
        if (!session) throw new Error(`session ${sessionId} not found`);
        const ts = nowISO();
        const run: Run = {
          id: newId('run'),
          sessionId,
          status: 'in_progress',
          trigger,
          prompt,
          model: model ?? session.model,
          toolCallIds: [],
          stepCount: 0,
          errorMessage: null,
          resultMessageId: null,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          createdAt: ts,
          startedAt: ts,
          completedAt: null,
          cancelledAt: null,
          durationMs: null,
        };
        set((s) => ({
          runs: { ...s.runs, [run.id]: run },
          sessions: {
            ...s.sessions,
            [sessionId]: {
              ...session,
              runIds: [...session.runIds, run.id],
              runCount: session.runCount + 1,
              currentRunId: run.id,
              lastRunId: run.id,
              updatedAt: ts,
            },
          },
        }));
        // Sync run to server (documentId enables server-side auto-heal of a
        // missing session shell — see api/sessions/ensure-session.ts).
        // runId is REQUIRED here: without it the server generates its own
        // cuid, and the later updateRun/endRun syncs (which DO pass run.id)
        // upsert a SECOND row — the client's run_ id never maps to the
        // server's cuid shell, which then stays 'in_progress' forever
        // (zombie rows + inflated runCount; found via live debugging).
        if (typeof window !== 'undefined') {
          import('./server-sync').then(({ syncServerRun }) => {
            const s = get().sessions[sessionId];
            syncServerRun(sessionId, {
              runId: run.id,
              prompt,
              status: 'in_progress',
              documentId: s?.documentId,
            });
          });
        }
        return run;
      },

      // Non-terminal status transition for a LIVE run (2026-09-05
      // consistency contract): 'awaiting_tool' when a tool call starts,
      // 'cancelling' the instant the user hits Stop, 'in_progress' when a
      // tool batch ends. Terminal statuses are endRun's job — a terminal run
      // ignores this, and non-terminal status values are rejected so the
      // honest history can never be rewritten here. Deliberately NOT synced
      // to the server: these are ephemeral UI states; endRun persists the
      // final status (server rows stay on the persisted enum).
      setRunStatus: (runId, status) => {
        const run = get().runs[runId];
        if (!run) return;
        if (TERMINAL_RUN_STATUSES.has(run.status)) return;
        if (status !== 'awaiting_tool' && status !== 'cancelling' && status !== 'in_progress') return;
        if (run.status === status) return;
        set((s) => ({
          runs: { ...s.runs, [runId]: { ...s.runs[runId], status } },
        }));
      },

      endRun: (runId, status, errorMessage) => {
        const run = get().runs[runId];
        if (!run) return;
        // Terminal-state guard (durability fix): once a run reached a
        // terminal status ('cancelled' via turn_cancelled, 'failed' via
        // agent:error, 'stuck', 'completed', 'incomplete'), later closing
        // events must not rewrite history — a trailing turn_end after a
        // Stop used to flip 'cancelled' runs to 'completed' in both the
        // local cache and the server DB. Re-finalizing with the SAME status
        // (e.g. a duplicate turn_end after 'completed') stays allowed so the
        // existing idempotent-resync flows keep working.
        if (TERMINAL_RUN_STATUSES.has(run.status) && run.status !== status) {
          return;
        }
        const ts = nowISO();
        const durationMs = run.startedAt
          ? new Date(ts).getTime() - new Date(run.startedAt).getTime()
          : null;
        const updated: Run = {
          ...run,
          status,
          errorMessage: errorMessage ?? null,
          completedAt: status === 'completed' || status === 'failed' || status === 'incomplete' ? ts : run.completedAt,
          cancelledAt: status === 'cancelled' ? ts : run.cancelledAt,
          durationMs,
        };
        set((s) => {
          const session = s.sessions[run.sessionId];
          if (!session) return { runs: { ...s.runs, [runId]: updated } };
          return {
            runs: { ...s.runs, [runId]: updated },
            sessions: {
              ...s.sessions,
              [run.sessionId]: {
                ...session,
                currentRunId: session.currentRunId === runId ? null : session.currentRunId,
                updatedAt: ts,
              },
            },
          };
        });
        // Sync run status to server (upsert — runId creates the row if the
        // initial create call was lost).
        if (typeof window !== 'undefined') {
          import('./server-sync').then(({ syncServerRun }) => {
            const s = get().sessions[run.sessionId];
            syncServerRun(run.sessionId, {
              prompt: run.prompt,
              status,
              runId,
              errorMessage,
              toolCallCount: run.toolCallIds.length,
              documentId: s?.documentId,
            });
          });
        }
      },

      // Patch a run with arbitrary updates (used by per-run cost accumulation
      // from agent:context_update events). ONLY touches the supplied fields —
      // never rewrites status/error/dates. Syncs to server fire-and-forget.
      updateRun: (runId, patch) => {
        const run = get().runs[runId];
        if (!run) return;
        const updated: Run = {
          ...run,
          ...patch,
        };
        set((s) => ({
          runs: { ...s.runs, [runId]: updated },
        }));
        // Sync cost fields (if patched) to the server.
        if (typeof window !== 'undefined' && (patch.inputTokens !== undefined || patch.outputTokens !== undefined || patch.costUsd !== undefined)) {
          import('./server-sync').then(({ syncServerRun }) => {
            const s = get().sessions[run.sessionId];
            syncServerRun(run.sessionId, {
              runId,
              prompt: updated.prompt,
              inputTokens: updated.inputTokens,
              outputTokens: updated.outputTokens,
              costUsd: updated.costUsd,
              documentId: s?.documentId,
            });
          });
        }
      },

      // Delete a single run + its tool-call records + drop from parent
      // session's runIds. Messages stay (the transcript is still readable;
      // the run reference on each message becomes orphaned but the message
      // text is preserved). Server row is deleted via DELETE on the runs
      // route (the route itself doesn't exist yet — silently 404s, which
      // the call treats as success since the local cache is authoritative).
      deleteRun: (runId) => {
        const run = get().runs[runId];
        if (!run) return;
        // Collect tool-call ids to remove from the toolCalls map.
        const tcIds = [...run.toolCallIds];
        set((s) => {
          const session = s.sessions[run.sessionId];
          if (!session) {
            // No parent — just drop the run + its tool calls.
            const runs = { ...s.runs };
            delete runs[runId];
            const toolCalls = { ...s.toolCalls };
            for (const id of tcIds) delete toolCalls[id];
            return { runs, toolCalls };
          }
          const runs = { ...s.runs };
          delete runs[runId];
          const toolCalls = { ...s.toolCalls };
          for (const id of tcIds) delete toolCalls[id];
          return {
            runs,
            toolCalls,
            sessions: {
              ...s.sessions,
              [run.sessionId]: {
                ...session,
                runIds: session.runIds.filter((id) => id !== runId),
                runCount: Math.max(0, session.runCount - 1),
                // Re-point lastRunId if we just deleted it (null = no last run).
                lastRunId: session.lastRunId === runId ? null : session.lastRunId,
                // Re-point currentRunId if the agent is mid-run (shouldn't be —
                // deleteRun is user-initiated, not mid-flight, but defensive).
                currentRunId: session.currentRunId === runId ? null : session.currentRunId,
                updatedAt: nowISO(),
              },
            },
          };
        });
        // Server sync — fire-and-forget; the route may not exist (silently
        // 404s, treated as success).
        if (typeof window !== 'undefined') {
          fetch(`/api/sessions/${run.sessionId}/runs/${runId}`, { method: 'DELETE' }).catch(() => {});
        }
      },
      reconcileStaleActivity: (maxAgeMs = 10 * 60 * 1000) => {
        const cutoff = Date.now() - maxAgeMs;
        const report = { runs: 0, messages: 0 };
        const state = get();
        // Runs stuck in a live-looking state whose last activity predates
        // the cutoff → 'incomplete' (resumable, honest).
        for (const run of Object.values(state.runs)) {
          if (
            (run.status === 'in_progress' || run.status === 'awaiting_tool' ||
             run.status === 'queued' || run.status === 'cancelling') &&
            new Date(run.createdAt).getTime() < cutoff
          ) {
            get().endRun(run.id, 'incomplete', 'Interrupted — no agent activity for 10+ minutes');
            report.runs++;
          }
        }
        // Assistant messages stuck 'streaming' past the cutoff → 'error'
        // with a note (the eternal-spinner fix: _syncTurnsFromSession maps
        // 'streaming' back to a spinner forever otherwise).
        for (const message of Object.values(get().messages)) {
          if (
            message.role === 'assistant' &&
            message.status === 'streaming' &&
            new Date(message.createdAt).getTime() < cutoff
          ) {
            get().finalizeAssistantMessage(message.id, 'error', 'Interrupted — stream ended unexpectedly');
            report.messages++;
          }
        }
        if (report.runs > 0 || report.messages > 0) {
          console.log(
            `[sessions] reconciled ${report.runs} stale run(s) + ${report.messages} stale streaming message(s)`,
          );
        }
        return report;
      },

      appendUserMessage: (sessionId, runId, text, images, selection) => {
        const session = get().sessions[sessionId];
        if (!session) throw new Error(`session ${sessionId} not found`);
        const msg: Message = {
          id: newId('msg'),
          sessionId,
          runId,
          role: 'user',
          text,
          // Attachments persist with the message (localStorage cache) so
          // history keeps its thumbnails; the server copy is text-only.
          ...(images && images.length > 0 ? { images } : {}),
          ...(selection ? { selection } : {}),
          toolCalls: [],
          status: 'complete',
          snapshotId: null,
          createdAt: nowISO(),
          completedAt: nowISO(),
        };
        set((s) => ({
          messages: { ...s.messages, [msg.id]: msg },
          sessions: {
            ...s.sessions,
            [sessionId]: {
              ...session,
              messageIds: [...session.messageIds, msg.id],
              messageCount: session.messageCount + 1,
              updatedAt: msg.createdAt,
            },
          },
        }));
        // Sync user message to server.
        if (typeof window !== 'undefined') {
          const s = get().sessions[sessionId];
          import('./server-sync').then(({ appendServerMessage }) => {
            appendServerMessage(
              sessionId,
              { role: 'user', content: text, status: 'complete', runId, messageId: msg.id },
              s?.documentId,
            );
          });
          // Persist image attachments to the server DB (fire-and-forget,
          // alongside the localStorage copy). Idempotent by attachment id.
          if (images && images.length > 0) {
            import('./server-sync').then(({ syncServerAttachments }) => {
              syncServerAttachments(sessionId, msg.id, images);
            });
          }
        }
        return msg;
      },

      appendAssistantMessage: (sessionId, runId) => {
        const session = get().sessions[sessionId];
        if (!session) throw new Error(`session ${sessionId} not found`);
        const msg: Message = {
          id: newId('msg'),
          sessionId,
          runId,
          role: 'assistant',
          text: '',
          toolCalls: [],
          status: 'streaming',
          snapshotId: null,
          createdAt: nowISO(),
          completedAt: null,
        };
        set((s) => ({
          messages: { ...s.messages, [msg.id]: msg },
          runs: s.runs[runId]
            ? { ...s.runs, [runId]: { ...s.runs[runId], resultMessageId: msg.id } }
            : s.runs,
          sessions: {
            ...s.sessions,
            [sessionId]: {
              ...session,
              messageIds: [...session.messageIds, msg.id],
              messageCount: session.messageCount + 1,
              updatedAt: msg.createdAt,
            },
          },
        }));
        return msg;
      },

      appendAssistantText: (messageId, text) => {
        set((s) => {
          const msg = s.messages[messageId];
          if (!msg) return s;
          return {
            messages: {
              ...s.messages,
              [messageId]: { ...msg, text: msg.text + text },
            },
          };
        });
      },

      finalizeAssistantMessage: (messageId, status = 'complete', error) => {
        set((s) => {
          const msg = s.messages[messageId];
          if (!msg) return s;
          return {
            messages: {
              ...s.messages,
              [messageId]: {
                ...msg,
                status,
                error,
                completedAt: nowISO(),
              },
            },
          };
        });
        // Sync assistant message to server (including the turn's diff
        // summary records — the "+N −M" card is rebuilt server-side).
        if (typeof window !== 'undefined') {
          const msg = get().messages[messageId];
          if (msg) {
            const s = get().sessions[msg.sessionId];
            import('./server-sync').then(({ appendServerMessage }) => {
              appendServerMessage(
                msg.sessionId,
                {
                  role: 'assistant',
                  content: msg.text,
                  status,
                  error,
                  runId: msg.runId ?? undefined,
                  messageId: msg.id,
                  diffSummary:
                    msg.patchOps && msg.patchOps.length > 0
                      ? JSON.stringify(msg.patchOps)
                      : undefined,
                },
                s?.documentId,
              );
            });
          }
        }
      },

      appendPatchOp: (messageId, record) => {
        set((s) => {
          const msg = s.messages[messageId];
          if (!msg) return s;
          return {
            messages: {
              ...s.messages,
              [messageId]: { ...msg, patchOps: [...(msg.patchOps ?? []), record] },
            },
          };
        });
      },

      resyncMessageDiff: (messageId) => {
        const msg = get().messages[messageId];
        if (!msg || typeof window === 'undefined') return;
        const s = get().sessions[msg.sessionId];
        import('./server-sync').then(({ appendServerMessage }) => {
          appendServerMessage(
            msg.sessionId,
            {
              role: 'assistant',
              content: msg.text,
              status: msg.status === 'streaming' ? 'complete' : msg.status,
              error: msg.error,
              runId: msg.runId ?? undefined,
              messageId: msg.id,
              diffSummary:
                msg.patchOps && msg.patchOps.length > 0
                  ? JSON.stringify(msg.patchOps)
                  : undefined,
            },
            s?.documentId,
          );
        });
      },

      importServerMessages: (sessionId, incoming) => {
        const session = get().sessions[sessionId];
        if (!session || incoming.length === 0) return 0;
        let imported = 0;
        set((s) => {
          const messages = { ...s.messages };
          const messageIds = [...session.messageIds];
          for (const m of incoming) {
            // Gap-fill only: never overwrite a locally-known message (the
            // local copy is authoritative for in-flight streaming state).
            if (messages[m.id]) continue;
            messages[m.id] = {
              id: m.id,
              sessionId,
              runId: m.runId ?? null,
              role: m.role === 'user' ? 'user' : 'assistant',
              text: m.text,
              ...(m.images && m.images.length > 0 ? { images: m.images } : {}),
              ...(m.patchOps && m.patchOps.length > 0 ? { patchOps: m.patchOps } : {}),
              toolCalls: [],
              status: m.status === 'streaming' ? 'streaming' : m.status === 'error' ? 'error' : 'complete',
              error: m.error ?? undefined,
              snapshotId: null,
              createdAt: m.createdAt ?? nowISO(),
              completedAt: m.createdAt ?? nowISO(),
            };
            messageIds.push(m.id);
            imported++;
          }
          if (imported === 0) return s;
          // Keep chronological order (createdAt may interleave with local ids).
          messageIds.sort((a, b) =>
            (messages[a]?.createdAt ?? '').localeCompare(messages[b]?.createdAt ?? ''),
          );
          return {
            messages,
            sessions: {
              ...s.sessions,
              [sessionId]: {
                ...session,
                messageIds,
                messageCount: messageIds.length,
                updatedAt: nowISO(),
              },
            },
          };
        });
        return imported;
      },

      adoptUserMessage: (sessionId, msg) => {
        const session = get().sessions[sessionId];
        if (!session) return; // foreign session — turns-array only
        if (get().messages[msg.messageId]) return; // already adopted
        const m: Message = {
          id: msg.messageId,
          sessionId,
          runId: msg.runId ?? null,
          role: 'user',
          text: msg.text,
          toolCalls: [],
          status: 'complete',
          snapshotId: null,
          createdAt: nowISO(),
          completedAt: nowISO(),
        };
        set((s) => ({
          messages: { ...s.messages, [m.id]: m },
          sessions: {
            ...s.sessions,
            [sessionId]: {
              ...session,
              messageIds: [...session.messageIds, m.id],
              messageCount: session.messageCount + 1,
              updatedAt: m.createdAt,
            },
          },
        }));
      },

      adoptAssistantFinal: (messageId, text, status, error) => {
        set((s) => {
          const msg = s.messages[messageId];
          if (!msg) return s; // foreign message — turns-array only
          return {
            messages: {
              ...s.messages,
              [messageId]: {
                ...msg,
                // REPLACES: turn_final carries the full final text, healing a
                // partial stream accumulated before a disconnect.
                text,
                status,
                error,
                completedAt: msg.completedAt ?? nowISO(),
              },
            },
          };
        });
        // Terminal reconciliation (LibreChat): the server's message row may
        // still be 'streaming' if the originating client vanished before its
        // finalize POST — the idempotent upsert heals it from here.
        if (typeof window !== 'undefined') {
          const msg = get().messages[messageId];
          if (msg) {
            import('./server-sync').then(({ appendServerMessage }) => {
              appendServerMessage(
                msg.sessionId,
                {
                  role: 'assistant',
                  content: msg.text,
                  status,
                  error,
                  runId: msg.runId ?? undefined,
                  messageId: msg.id,
                },
                get().sessions[msg.sessionId]?.documentId,
              );
            }).catch(() => {
              // fire-and-forget by contract
            });
          }
        }
      },

      truncateMessagesAfter: (sessionId, afterMessageId) => {
        const session = get().sessions[sessionId];
        if (!session) return 0;
        const idx = session.messageIds.indexOf(afterMessageId);
        if (idx === -1 || idx === session.messageIds.length - 1) return 0;
        const removed = session.messageIds.slice(idx + 1);
        set((s) => {
          const messages = { ...s.messages };
          for (const id of removed) delete messages[id];
          const sess = s.sessions[sessionId];
          return {
            messages,
            sessions: {
              ...s.sessions,
              [sessionId]: {
                ...sess,
                messageIds: sess.messageIds.slice(0, idx + 1),
                messageCount: Math.max(0, sess.messageCount - removed.length),
                updatedAt: nowISO(),
              },
            },
          };
        });
        return removed.length;
      },

      setMessageFeedback: (messageId, feedback) => {
        set((s) => {
          const msg = s.messages[messageId];
          if (!msg) return s;
          // Toggle: rating the same value again clears the feedback.
          const next = msg.feedback === feedback ? undefined : feedback;
          return {
            messages: {
              ...s.messages,
              [messageId]: next ? { ...msg, feedback: next } : { ...msg, feedback: undefined },
            },
          };
        });
      },

      // ---- Tool calls ----
      startToolCall: (runId, toolCallId, name, argsPreview) => {
        const run = get().runs[runId];
        if (!run) throw new Error(`run ${runId} not found`);
        // Idempotency guard — the same toolCallId can arrive twice (a socket.io
        // event in flight at disconnect time AND the journal-catchup replay
        // both delivering agent:tool_call_start). Appending twice duplicated
        // the id in run.toolCallIds → React "two children with the same key"
        // in the run timeline + inflated toolCallCount. Return the existing
        // record instead (the canvas-store turn guard mirrors this).
        const existing = run.toolCallIds.includes(toolCallId) ? get().toolCalls[toolCallId] : undefined;
        if (existing) return existing;
        const ts = nowISO();
        const tc: ToolCallRecord = {
          id: toolCallId,
          runId,
          sessionId: run.sessionId,
          messageId: run.resultMessageId,
          stepIndex: run.toolCallIds.length,
          name,
          argsPreview,
          status: 'running',
          summary: null,
          patchSummary: null,
          startedAt: ts,
          endedAt: null,
          durationMs: null,
        };
        set((s) => {
          const session = s.sessions[run.sessionId];
          return {
            toolCalls: { ...s.toolCalls, [tc.id]: tc },
            runs: {
              ...s.runs,
              [runId]: {
                ...run,
                toolCallIds: [...run.toolCallIds, tc.id],
                stepCount: run.toolCallIds.length + 1,
                status: 'awaiting_tool' as RunStatus,
              },
            },
            sessions: session
              ? {
                  ...s.sessions,
                  [run.sessionId]: {
                    ...session,
                    toolCallCount: session.toolCallCount + 1,
                    updatedAt: ts,
                  },
                }
              : s.sessions,
          };
        });
        return tc;
      },

      endToolCall: (toolCallId, success, summary, patchSummary) => {
        set((s) => {
          const tc = s.toolCalls[toolCallId];
          if (!tc) return s;
          const ts = nowISO();
          const durationMs = tc.startedAt
            ? new Date(ts).getTime() - new Date(tc.startedAt).getTime()
            : null;
          const updated: ToolCallRecord = {
            ...tc,
            status: success ? 'success' : 'error',
            summary,
            patchSummary: patchSummary ?? null,
            endedAt: ts,
            durationMs,
          };
          // Flip run back to in_progress (tool call done, agent may continue).
          // Terminal-state guard (tool-calling reliability fix): a late
          // tool_call_end that arrives AFTER the run reached a terminal
          // status (watchdog 'failed' / Stop 'cancelled' / 'completed' /
          // 'incomplete') must NOT resurrect it to in_progress — that
          // resurrection defeated endRun's terminal guard (later turn_final
          // with the SAME status re-ran, but a DIFFERENT honest status was
          // absorbed) and left the run stuck in_progress in the DB until
          // the 10-minute stale sweep. In-flight guards: an 'awaiting_tool'
          // run is exactly the mid-tool-call state; only non-terminal runs
          // may flip back.
          const run = s.runs[tc.runId];
          const runs =
            run && !TERMINAL_RUN_STATUSES.has(run.status)
              ? { ...s.runs, [run.id]: { ...run, status: 'in_progress' as RunStatus } }
              : s.runs;
          return {
            toolCalls: { ...s.toolCalls, [toolCallId]: updated },
            runs,
          };
        });
      },

      // ---- Snapshots (document-scoped, shared canvas model) ----
      captureSnapshot: (documentId, document, opts = {}) => {
        // Append-only capture on the DOCUMENT timeline. `sessionId` (when
        // provided) is provenance only — which chat's turn produced this.
        const ts = nowISO();
        const parent = get().listSnapshots(documentId)[0] ?? null;
        const snap: Snapshot = {
          id: newId('snap'),
          documentId,
          sessionId: opts.sessionId ?? null,
          parentSnapshotId: parent?.id ?? null,
          source: opts.source ?? 'turn_end',
          sourceRunId: opts.sourceRunId ?? null,
          sourceMessageId: opts.sourceMessageId ?? null,
          document: deepClone(document),
          nodeCount: document.shapes.length,
          label: opts.label ?? null,
          bookmarked: false,
          remote: false,
          createdAt: ts,
          createdBy: opts.createdBy ?? 'agent',
        };
        set((s) => ({
          snapshots: { ...s.snapshots, [snap.id]: snap },
        }));
        // Sync snapshot to server (document-scoped endpoint).
        if (typeof window !== 'undefined') {
          import('./server-sync').then(({ captureDocumentSnapshot }) => {
            captureDocumentSnapshot({
              id: snap.id,
              documentId,
              sessionId: snap.sessionId,
              document,
              source: snap.source,
              runId: snap.sourceRunId,
              messageId: snap.sourceMessageId,
              nodeCount: snap.nodeCount,
              label: snap.label,
            });
          });
        }
        return snap;
      },

      restoreSnapshot: (documentId, snapshotId) => {
        // Restore the SHARED document = create a NEW snapshot that deep-copies
        // the chosen one (append-only history; the user can still go forward).
        const snap = get().snapshots[snapshotId];
        if (!snap || snap.documentId !== documentId) return undefined;
        // Remote (metadata-only) entries must be filled in by the caller
        // (canvas store's restoreSnapshot action fetches the full document
        // first) — refuse rather than restore an empty placeholder.
        if (snap.remote) return undefined;
        const ts = nowISO();
        const parent = get().listSnapshots(documentId)[0] ?? null;
        const restored: Snapshot = {
          id: newId('snap'),
          documentId,
          sessionId: snap.sessionId,
          parentSnapshotId: parent?.id ?? null,
          source: 'restore',
          sourceRunId: null,
          sourceMessageId: null,
          document: deepClone(snap.document),
          nodeCount: snap.nodeCount,
          label: `Restored from ${snap.label ?? snap.id.slice(0, 12)}`,
          bookmarked: false,
          remote: false,
          createdAt: ts,
          createdBy: 'user',
        };
        set((s) => ({
          snapshots: { ...s.snapshots, [restored.id]: restored },
        }));
        // Persist the restore entry server-side too (the restored state is
        // now the document's latest).
        if (typeof window !== 'undefined') {
          import('./server-sync').then(({ captureDocumentSnapshot }) => {
            captureDocumentSnapshot({
              id: restored.id,
              documentId,
              sessionId: restored.sessionId,
              document: restored.document,
              source: 'restore',
              nodeCount: restored.nodeCount,
              label: restored.label,
            });
          });
        }
        return restored;
      },

      ingestServerSnapshot: (srv) => {
        // Upsert a server-side snapshot row into the local registry, adopting
        // the SERVER id (same contract as session adoption — future syncs
        // never FK-fail / duplicate). Entries without a document payload are
        // metadata-only placeholders (remote: true).
        const existing = get().snapshots[srv.id];
        if (existing && !existing.remote) return existing;
        const doc = srv.document as CanvasDocument | undefined;
        const snap: Snapshot = {
          id: srv.id,
          documentId: srv.documentId,
          sessionId: srv.sessionId ?? null,
          parentSnapshotId: existing?.parentSnapshotId ?? null,
          source: (srv.source as SnapshotSource) ?? 'turn_end',
          sourceRunId: srv.runId ?? null,
          sourceMessageId: srv.messageId ?? null,
          document: doc ?? existing?.document ?? EMPTY_PLACEHOLDER_DOC,
          nodeCount: srv.nodeCount ?? 0,
          label: srv.label ?? null,
          bookmarked: srv.bookmarked ?? false,
          remote: !doc,
          createdAt: srv.createdAt ?? nowISO(),
          createdBy: 'agent',
        };
        set((s) => ({ snapshots: { ...s.snapshots, [snap.id]: snap } }));
        return snap;
      },

      bookmarkSnapshot: (snapshotId) => {
        set((s) => {
          const snap = s.snapshots[snapshotId];
          if (!snap) return s;
          return {
            snapshots: {
              ...s.snapshots,
              [snapshotId]: { ...snap, bookmarked: !snap.bookmarked },
            },
          };
        });
        // Sync the bookmark flag server-side (fire-and-forget).
        if (typeof window !== 'undefined') {
          const snap = get().snapshots[snapshotId];
          if (snap) {
            import('./server-sync').then(({ updateDocumentSnapshot }) => {
              updateDocumentSnapshot(snap.documentId, snap.id, { bookmarked: snap.bookmarked });
            });
          }
        }
      },

      labelSnapshot: (snapshotId, label) => {
        set((s) => {
          const snap = s.snapshots[snapshotId];
          if (!snap) return s;
          return {
            snapshots: {
              ...s.snapshots,
              [snapshotId]: { ...snap, label },
            },
          };
        });
        // Sync the label server-side (fire-and-forget).
        if (typeof window !== 'undefined') {
          const snap = get().snapshots[snapshotId];
          if (snap) {
            import('./server-sync').then(({ updateDocumentSnapshot }) => {
              updateDocumentSnapshot(snap.documentId, snap.id, { label: snap.label });
            });
          }
        }
      },

      deleteSnapshot: (snapshotId) => {
        const snap = get().snapshots[snapshotId];
        if (!snap || snap.bookmarked) return; // refuse to delete bookmarked
        set((s) => {
          const snapshots = { ...s.snapshots };
          delete snapshots[snapshotId];
          return { snapshots };
        });
        // Sync the delete server-side (fire-and-forget).
        if (typeof window !== 'undefined') {
          import('./server-sync').then(({ deleteDocumentSnapshot }) => {
            deleteDocumentSnapshot(snap.documentId, snapshotId);
          });
        }
      },

      // ---- Bulk ----
      clearAllForDocument: (documentId) => {
        const sessions = Object.values(get().sessions).filter(
          (s) => s.documentId === documentId,
        );
        for (const s of sessions) {
          get().deleteSession(s.id);
        }
        // Full canvas wipe also clears the document-scoped snapshot timeline
        // (bookmark protection applies per-snapshot via deleteSnapshot, but a
        // deliberate "clear everything" removes all entries).
        set((s) => {
          const snapshots = { ...s.snapshots };
          for (const snap of Object.values(snapshots)) {
            if (snap.documentId === documentId) delete snapshots[snap.id];
          }
          return { snapshots };
        });
      },
    }),
    {
      name: 'agentcanvas.sessions.v1',
      // Throttled localStorage adapter (R9b — see the module docs above the
      // store): coalesces the per-token-chunk persist writes into one per
      // 300ms window with pagehide/beforeunload/visibilitychange flushes.
      storage: createThrottledJSONStorage(),
      // Persist everything; this is a small dataset (snapshots may grow but
      // for a demo this is fine — a real app would shard snapshots to a
      // separate key or move them to IndexedDB).
      partialize: (s) => ({
        sessions: s.sessions,
        runs: s.runs,
        messages: s.messages,
        toolCalls: s.toolCalls,
        snapshots: s.snapshots,
        activeSessionByDoc: s.activeSessionByDoc,
      }),
      version: 2,
      // v1 → v2 (shared-canvas model): snapshots moved from session-owned
      // (session.snapshotIds / session.currentSnapshotId, snapshot.sessionId
      // as the owning key) to DOCUMENT-owned (snapshot.documentId, sessionId
      // kept as provenance). Migration re-keys every snapshot by its owner
      // session's documentId and strips the removed session fields.
      migrate: (persisted, _version) => {
        const s = (persisted ?? {}) as {
          sessions?: Record<string, Session & { currentSnapshotId?: string | null; snapshotIds?: string[] }>;
          snapshots?: Record<string, Snapshot & { sessionId: string | null; documentId?: string }>;
          runs?: Record<string, Run>;
          messages?: Record<string, Message>;
          toolCalls?: Record<string, ToolCallRecord>;
          activeSessionByDoc?: Record<string, string>;
        };
        const sessions = { ...(s.sessions ?? {}) };
        const snapshots = { ...(s.snapshots ?? {}) };
        for (const snap of Object.values(snapshots)) {
          if (!snap.documentId) {
            const owner = snap.sessionId ? sessions[snap.sessionId] : undefined;
            snap.documentId = owner?.documentId ?? 'demo';
          }
          snap.remote = false;
        }
        for (const sess of Object.values(sessions)) {
          delete (sess as Partial<Session> & { currentSnapshotId?: string | null }).currentSnapshotId;
          delete (sess as Partial<Session> & { snapshotIds?: string[] }).snapshotIds;
        }
        return {
          sessions,
          snapshots,
          runs: s.runs ?? {},
          messages: s.messages ?? {},
          toolCalls: s.toolCalls ?? {},
          activeSessionByDoc: s.activeSessionByDoc ?? {},
        };
      },
      // Next.js SSR safety: skip auto-hydration on the server. The client
      // hydrates manually in a useEffect (see hydrateSessionStore() below).
      skipHydration: true,
    },
  ),
);

// Manually hydrate the persisted store on the client. Called from a
// top-level useEffect in the canvas page (or anywhere that runs once
// on the client). Safe to call multiple times.
export function hydrateSessionStore() {
  if (typeof window === 'undefined') return;
  // persist.onFinishHydration is available; rehydrate is idempotent.
  const persistApi = (useSessionStore as any).persist;
  if (persistApi?.rehydrate) {
    persistApi.rehydrate();
  }
  // Also fetch sessions + document snapshots from the server (Phase 3:
  // server-side persistence). This merges server-side sessions with the
  // localStorage cache so sessions survive browser clears and can sync
  // across devices. Fire-and-forget — the localStorage cache is used for
  // instant UI, the server fetch updates the list in the background.
  import('./server-sync').then(({ fetchServerSessionsStrict, fetchDocumentSnapshots }) => {
    // Fetch for all known documents.
    const store = useSessionStore.getState();
    const docIds = new Set(Object.values(store.sessions).map((s) => s.documentId));
    for (const docId of docIds) {
      // ---- Session merge ----
      // STRICT fetch: null = server unreachable (keep cache as-is), array =
      // authoritative server state for this document (safe to reconcile).
      fetchServerSessionsStrict(docId).then((serverSessions) => {
        if (serverSessions === null) return;
        // Merge: add server sessions that don't exist in localStorage.
        //
        // IMPORTANT (bug fix): we insert the server session DIRECTLY into the
        // store using the SERVER's id — we must NOT call createSession() here.
        // createSession() generates a new local id AND fire-and-forgets another
        // server-side create, so every reload multiplied the session rows
        // (this was the source of thousands of empty "Canvas · demo" rows).
        //
        // We also skip empty server shells (no messages/runs) — they carry
        // nothing worth adopting; the client creates a fresh session on
        // demand when it needs one. (Snapshots no longer count toward
        // hasContent — they are document-scoped, not session-scoped.)
        const incoming: Session[] = [];
        const localSessions = useSessionStore.getState().sessions;
        for (const ss of serverSessions) {
          if (localSessions[ss.id]) continue;
          const counts = ss._count as { messages?: number; runs?: number } | undefined;
          const hasContent = (counts?.messages ?? 0) > 0 || (counts?.runs ?? 0) > 0;
          if (!hasContent) continue;
          const ts = nowISO();
          // Parse the server's tags JSON (defensive — bad JSON or empty array
          // both yield [] so the client cache shape stays consistent).
          let serverTags: string[] = [];
          try {
            const parsed = JSON.parse((ss as { tags?: string }).tags ?? '[]');
            if (Array.isArray(parsed)) {
              serverTags = parsed.filter((t: unknown) => typeof t === 'string');
            }
          } catch {
            // Corrupt JSON column — fall back to empty; the PATCH will repair
            // it on the next tag mutation.
          }
          incoming.push({
            ...makeSession(ss.documentId, {
              title: ss.title,
              status: ss.status as 'active' | 'archived',
              pinned: ss.pinned,
              tags: serverTags,
            }),
            // Adopt the SERVER id so future child syncs reference a row that
            // exists — no FK violations, no duplicate adoption on next reload.
            id: ss.id,
            lastOpenedAt: ss.lastOpenedAt || ts,
          });
        }
        // Reconcile (bug fix): remove local GHOST SHELLS of this document —
        // sessions that are missing from the server's authoritative list AND
        // have no content locally (no messages/runs). These come from rows
        // deleted server-side (another device, or the orphan cleanup script);
        // before this sweep they lingered in the sidebar forever, and clicking
        // one could re-create an orphan server row (the exact "orphan flood"
        // regression this store guards against). Sessions with local content
        // are NEVER swept here — they may be unsynced offline work. The
        // ACTIVE session is also kept (ensure-session re-creates its server
        // row on next activity — idempotent).
        const serverIds = new Set(serverSessions.map((ss) => ss.id));
        const activeId = useSessionStore.getState().activeSessionByDoc[docId];
        const ghostIds: string[] = [];
        for (const [id, sess] of Object.entries(useSessionStore.getState().sessions)) {
          if (sess.documentId !== docId) continue;
          if (serverIds.has(id)) continue;
          if (id === activeId) continue;
          const empty =
            (sess.messageIds?.length ?? 0) === 0 &&
            (sess.runIds?.length ?? 0) === 0;
          if (empty) ghostIds.push(id);
        }
        if (incoming.length > 0 || ghostIds.length > 0) {
          useSessionStore.setState((s) => {
            const sessions = { ...s.sessions };
            for (const sess of incoming) sessions[sess.id] = sess;
            for (const gid of ghostIds) delete sessions[gid];
            // No child cascade needed: the sweep only removes EMPTY sessions
            // (messageIds/runIds both empty by construction — snapshots are
            // document-scoped and never cascade from session deletion).
            return { sessions };
          });
        }
      });

      // ---- Document snapshot merge (shared canvas model) ----
      // Adopt server-side canvas snapshots missing from the local registry.
      // Entries arrive WITHOUT the heavy document JSON (metadata-only,
      // remote: true placeholders) — the History panel lists them and restore
      // fetches the full payload on demand. Local snapshots are NEVER swept:
      // the server list is not authoritative for captures that failed to
      // sync (offline), and stale-local ghosts are bounded by the per-document
      // snapshot cap instead.
      fetchDocumentSnapshots(docId).then((serverSnaps) => {
        if (!serverSnaps) return;
        const local = useSessionStore.getState().snapshots;
        for (const srv of serverSnaps) {
          if (local[srv.id]) continue;
          useSessionStore.getState().ingestServerSnapshot(srv);
        }
      });
    }
  }).catch(() => {
    // Server unreachable — localStorage cache is still valid.
  });
}

/// Sweep idle sessions: archive any active session whose `lastOpenedAt` is
/// older than the given threshold. Called from page.tsx on app mount, using
/// the `autoArchiveIdleAfter` setting ('never' = no-op).
/// Returns the number of sessions archived.
export function sweepIdleSessions(threshold: 'never' | '7d' | '30d'): number {
  if (threshold === 'never') return 0;
  const days = threshold === '7d' ? 7 : 30;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const store = useSessionStore.getState();
  const idle = Object.values(store.sessions).filter((s) => {
    if (s.status !== 'active') return false;
    const last = new Date(s.lastOpenedAt).getTime();
    return Number.isFinite(last) && last < cutoff;
  });
  for (const s of idle) {
    store.archiveSession(s.id);
  }
  return idle.length;
}

/// Enforce the max-sessions-retained cap: if the number of ACTIVE sessions
/// exceeds `maxRetained`, archive the oldest non-pinned, non-starred active
/// sessions until under the cap. Pinned + starred sessions are protected
/// (the user explicitly marked them as keepers). Returns the count archived.
export function enforceSessionCap(maxRetained: number): number {
  if (maxRetained <= 0) return 0;
  const store = useSessionStore.getState();
  const active = Object.values(store.sessions)
    .filter((s) => s.status === 'active')
    .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt)); // newest first
  if (active.length <= maxRetained) return 0;
  // Protect pinned + starred sessions from auto-archive.
  const candidates = active.filter((s) => !s.pinned && !s.starred);
  // Archive from the END (oldest) of the candidates list.
  const toArchive = candidates.slice(maxRetained - active.length > 0 ? 0 : 0);
  // Simpler: archive the oldest candidates until we're under the cap.
  // active.length - maxRetained = how many we need to remove.
  const excess = active.length - maxRetained;
  let archived = 0;
  // Candidates are sorted newest-first; archive from the end (oldest).
  for (let i = candidates.length - 1; i >= 0 && archived < excess; i--) {
    store.archiveSession(candidates[i].id);
    archived++;
  }
  return archived;
}

/// Approximate localStorage usage in bytes, attributed to the known
/// AgentCanvas keys. Used by the Settings dialog's "Storage usage" display.
export function estimateLocalStorageUsage(): {
  sessions: number;
  settings: number;
  theme: number;
  total: number;
  percentageOfQuota: number | null;
} {
  if (typeof window === 'undefined') {
    return { sessions: 0, settings: 0, theme: 0, total: 0, percentageOfQuota: null };
  }
  const byteLen = (s: string | null) => (s ? new Blob([s]).size : 0);
  const sessions = byteLen(localStorage.getItem('agentcanvas.sessions.v1'));
  const settings = byteLen(localStorage.getItem('agentcanvas.settings.v1'));
  const theme = byteLen(localStorage.getItem('agentcanvas-theme'));
  const total = sessions + settings + theme;
  // navigator.storage.estimate() returns { usage, quota } if available.
  // We can use it to show the % of the browser's quota consumed.
  let percentageOfQuota: number | null = null;
  if (typeof navigator !== 'undefined' && typeof navigator.storage?.estimate === 'function') {
    // Fire-and-forget — we can't await here without making the caller async.
    // The Settings UI can call navigator.storage.estimate() directly if it
    // wants a fresh number; this is a best-effort cache.
  }
  return { sessions, settings, theme, total, percentageOfQuota };
}

// Expose globally so the demo / console can drive sessions if needed.
if (typeof window !== 'undefined') {
  (window as any).__sessionStore = useSessionStore;
}
