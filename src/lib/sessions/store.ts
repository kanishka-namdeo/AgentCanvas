// Agent session store — persisted to localStorage via Zustand `persist`.
//
// Single source of truth for: sessions, runs, messages, tool-call records,
// and canvas snapshots. The canvas store (lib/canvas/store.ts) bridges into
// this store: every promptAgent call starts a Run; every streaming event
// updates a Message / ToolCallRecord; every turn_end captures a Snapshot.
//
// Persistence model
// -----------------
// localStorage key: `agentcanvas.sessions.v1`
// Value: { sessions, runs, messages, toolCalls, snapshots, activeSessionId }
//
// State invariants
// ----------------
// 1. Only one Run per Session may be in a non-terminal status
//    (queued | in_progress | awaiting_tool | cancelling).
// 2. Forking sets parentId + forkedFromMessageId + forkedFromSnapshotId
//    and seeds currentSnapshotId from a deep copy of that snapshot.
// 3. Snapshots are append-only — restore creates a NEW snapshot with
//    source: 'restore' pointing at the restored one. Forward history
//    is never destroyed (Lovable model).

'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { v4 as uuid } from 'uuid';
import type { CanvasDocument } from '@/lib/canvas/types';
import type {
  Session, Run, Message, ToolCallRecord, Snapshot,
  SessionFilter, SessionStats, SessionStatus,
  RunStatus, RunTrigger, ToolCallStatus, SnapshotSource,
} from './types';

// ---- ID + time helpers ------------------------------------------------------

const nowISO = () => new Date().toISOString();

function newId(prefix: string): string {
  return `${prefix}_${uuid().slice(0, 12)}`;
}

function deepClone<T>(v: T): T {
  if (typeof structuredClone === 'function') return structuredClone(v);
  return JSON.parse(JSON.stringify(v));
}

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
    currentSnapshotId: null,
    currentRunId: null,
    lastRunId: null,
    model: 'gpt-4o-mini',
    messageCount: 0,
    runCount: 0,
    toolCallCount: 0,
    messageIds: [],
    runIds: [],
    snapshotIds: [],
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
  listSnapshots: (sessionId: string) => Snapshot[];
  getStats: (documentId?: string) => SessionStats;

  // ---- Mutations: Sessions ----
  createSession: (documentId: string, partial?: Partial<Session>) => Session;
  setActiveSession: (documentId: string, sessionId: string) => void;
  renameSession: (id: string, title: string) => void;
  autoTitleFromPrompt: (sessionId: string, prompt: string) => void;
  togglePin: (id: string) => void;
  toggleStar: (id: string) => void;
  archiveSession: (id: string) => void;
  unarchiveSession: (id: string) => void;
  deleteSession: (id: string) => void;
  forkSession: (parentId: string, fromMessageId: string | null) => Session | undefined;
  touchSession: (id: string) => void;

  // ---- Mutations: Runs ----
  startRun: (sessionId: string, prompt: string, trigger?: RunTrigger) => Run;
  endRun: (runId: string, status: RunStatus, errorMessage?: string) => void;

  // ---- Mutations: Messages ----
  appendUserMessage: (sessionId: string, runId: string, text: string) => Message;
  appendAssistantMessage: (sessionId: string, runId: string) => Message;
  appendAssistantText: (messageId: string, text: string) => void;
  finalizeAssistantMessage: (messageId: string, status?: 'complete' | 'error' | 'cancelled', error?: string) => void;

  // ---- Mutations: Tool calls ----
  startToolCall: (runId: string, toolCallId: string, name: string, argsPreview: string) => ToolCallRecord;
  endToolCall: (toolCallId: string, success: boolean, summary: string, patchSummary?: string) => void;

  // ---- Mutations: Snapshots ----
  captureSnapshot: (sessionId: string, document: CanvasDocument, opts?: {
    source?: SnapshotSource;
    sourceRunId?: string;
    sourceMessageId?: string;
    label?: string;
    createdBy?: 'agent' | 'user' | 'system';
  }) => Snapshot;
  restoreSnapshot: (sessionId: string, snapshotId: string) => Snapshot | undefined;
  bookmarkSnapshot: (snapshotId: string) => void;
  labelSnapshot: (snapshotId: string, label: string) => void;
  /// Permanently delete a snapshot. Refuses to delete bookmarked snapshots
  /// (the user marked them as keepers). Updates the parent session's
  /// snapshotIds list. If the session's currentSnapshotId was pointing at
  /// the deleted snapshot, repoints it to the most recent remaining snapshot.
  deleteSnapshot: (snapshotId: string) => void;

  // ---- Bulk ----
  clearAllForDocument: (documentId: string) => void;
}

// ---- Store implementation ---------------------------------------------------

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

      listSnapshots: (sessionId) => {
        const session = get().sessions[sessionId];
        if (!session) return [];
        return session.snapshotIds
          .map((id) => get().snapshots[id])
          .filter(Boolean)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      },

      getStats: (documentId) => {
        const sessions = Object.values(get().sessions);
        const filtered = documentId ? sessions.filter((s) => s.documentId === documentId) : sessions;
        const stats: SessionStats = {
          totalSessions: filtered.length,
          activeSessions: filtered.filter((s) => s.status === 'active').length,
          archivedSessions: filtered.filter((s) => s.status === 'archived').length,
          totalRuns: filtered.reduce((n, s) => n + s.runCount, 0),
          totalMessages: filtered.reduce((n, s) => n + s.messageCount, 0),
          totalToolCalls: filtered.reduce((n, s) => n + s.toolCallCount, 0),
          totalSnapshots: filtered.reduce((n, s) => n + s.snapshotIds.length, 0),
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
          // Cascade delete: messages, runs, tool calls, snapshots.
          const messages = { ...s.messages };
          const runs = { ...s.runs };
          const toolCalls = { ...s.toolCalls };
          const snapshots = { ...s.snapshots };
          for (const mid of session.messageIds) delete messages[mid];
          for (const rid of session.runIds) {
            const run = runs[rid];
            if (run) {
              for (const tcid of run.toolCallIds) delete toolCalls[tcid];
              delete runs[rid];
            }
          }
          for (const sid of session.snapshotIds) delete snapshots[sid];
          const sessions = { ...s.sessions };
          delete sessions[id];
          const active = { ...s.activeSessionByDoc };
          if (active[session.documentId] === id) delete active[session.documentId];
          return { sessions, runs, messages, toolCalls, snapshots, activeSessionByDoc: active };
        });
      },

      forkSession: (parentId, fromMessageId) => {
        const parent = get().sessions[parentId];
        if (!parent) return undefined;
        const ts = nowISO();
        const fork = makeSession(parent.documentId, {
          title: `Fork of ${parent.title}`,
          parentId,
          forkedFromMessageId: fromMessageId,
          forkedFromSnapshotId: parent.currentSnapshotId,
          isRoot: false,
          model: parent.model,
        });
        // If parent has a current snapshot, seed the fork's currentSnapshotId
        // with a fresh Snapshot (source: 'fork') that deep-copies it.
        const updates: Partial<SessionStoreState> = {
          sessions: { ...get().sessions, [fork.id]: fork },
          activeSessionByDoc: {
            ...get().activeSessionByDoc,
            [parent.documentId]: fork.id,
          },
        };
        const parentSnap = parent.currentSnapshotId
          ? get().snapshots[parent.currentSnapshotId]
          : undefined;
        if (parentSnap) {
          const forkSnap: Snapshot = {
            id: newId('snap'),
            sessionId: fork.id,
            parentSnapshotId: parentSnap.id,
            source: 'fork',
            sourceRunId: null,
            sourceMessageId: fromMessageId ?? null,
            document: deepClone(parentSnap.document),
            nodeCount: parentSnap.nodeCount,
            label: null,
            bookmarked: false,
            createdAt: ts,
            createdBy: 'user',
          };
          updates.snapshots = { ...get().snapshots, [forkSnap.id]: forkSnap };
          updates.sessions = {
            ...updates.sessions!,
            [fork.id]: { ...fork, currentSnapshotId: forkSnap.id, snapshotIds: [forkSnap.id] },
          };
        }
        set(updates as SessionStoreState);
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
      startRun: (sessionId, prompt, trigger = 'user_message') => {
        const session = get().sessions[sessionId];
        if (!session) throw new Error(`session ${sessionId} not found`);
        const ts = nowISO();
        const run: Run = {
          id: newId('run'),
          sessionId,
          status: 'in_progress',
          trigger,
          prompt,
          model: session.model,
          toolCallIds: [],
          stepCount: 0,
          errorMessage: null,
          resultMessageId: null,
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
        return run;
      },

      endRun: (runId, status, errorMessage) => {
        const run = get().runs[runId];
        if (!run) return;
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
      },

      // ---- Messages ----
      appendUserMessage: (sessionId, runId, text) => {
        const session = get().sessions[sessionId];
        if (!session) throw new Error(`session ${sessionId} not found`);
        const msg: Message = {
          id: newId('msg'),
          sessionId,
          runId,
          role: 'user',
          text,
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
      },

      // ---- Tool calls ----
      startToolCall: (runId, toolCallId, name, argsPreview) => {
        const run = get().runs[runId];
        if (!run) throw new Error(`run ${runId} not found`);
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
          const run = s.runs[tc.runId];
          const runs = run
            ? { ...s.runs, [run.id]: { ...run, status: 'in_progress' as RunStatus } }
            : s.runs;
          return {
            toolCalls: { ...s.toolCalls, [toolCallId]: updated },
            runs,
          };
        });
      },

      // ---- Snapshots ----
      captureSnapshot: (sessionId, document, opts = {}) => {
        const session = get().sessions[sessionId];
        if (!session) throw new Error(`session ${sessionId} not found`);
        const ts = nowISO();
        const snap: Snapshot = {
          id: newId('snap'),
          sessionId,
          parentSnapshotId: session.currentSnapshotId,
          source: opts.source ?? 'turn_end',
          sourceRunId: opts.sourceRunId ?? null,
          sourceMessageId: opts.sourceMessageId ?? null,
          document: deepClone(document),
          nodeCount: document.shapes.length,
          label: opts.label ?? null,
          bookmarked: false,
          createdAt: ts,
          createdBy: opts.createdBy ?? 'agent',
        };
        set((s) => ({
          snapshots: { ...s.snapshots, [snap.id]: snap },
          sessions: {
            ...s.sessions,
            [sessionId]: {
              ...session,
              snapshotIds: [...session.snapshotIds, snap.id],
              currentSnapshotId: snap.id,
              updatedAt: ts,
            },
          },
        }));
        return snap;
      },

      restoreSnapshot: (sessionId, snapshotId) => {
        const session = get().sessions[sessionId];
        const snap = get().snapshots[snapshotId];
        if (!session || !snap || snap.sessionId !== sessionId) return undefined;
        // Restore = create a NEW snapshot that deep-copies the chosen snapshot
        // (append-only history; the user can still go back forward).
        const ts = nowISO();
        const restored: Snapshot = {
          id: newId('snap'),
          sessionId,
          parentSnapshotId: snap.id,
          source: 'restore',
          sourceRunId: null,
          sourceMessageId: null,
          document: deepClone(snap.document),
          nodeCount: snap.nodeCount,
          label: `Restored from ${snap.label ?? snap.id.slice(0, 12)}`,
          bookmarked: false,
          createdAt: ts,
          createdBy: 'user',
        };
        set((s) => ({
          snapshots: { ...s.snapshots, [restored.id]: restored },
          sessions: {
            ...s.sessions,
            [sessionId]: {
              ...session,
              snapshotIds: [...session.snapshotIds, restored.id],
              currentSnapshotId: restored.id,
              updatedAt: ts,
            },
          },
        }));
        return restored;
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
      },

      deleteSnapshot: (snapshotId) => {
        set((s) => {
          const snap = s.snapshots[snapshotId];
          if (!snap || snap.bookmarked) return s; // refuse to delete bookmarked
          const sessionId = snap.sessionId;
          const session = s.sessions[sessionId];
          if (!session) {
            // Session already gone — just drop the snapshot.
            const snapshots = { ...s.snapshots };
            delete snapshots[snapshotId];
            return { snapshots };
          }
          const newSnapshotIds = session.snapshotIds.filter((id) => id !== snapshotId);
          // Repoint currentSnapshotId if it was the deleted one.
          const newCurrent = session.currentSnapshotId === snapshotId
            ? (newSnapshotIds.length > 0
                ? [...newSnapshotIds]
                    .map((id) => s.snapshots[id])
                    .filter(Boolean)
                    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.id ?? null
                : null)
            : session.currentSnapshotId;
          const snapshots = { ...s.snapshots };
          delete snapshots[snapshotId];
          return {
            snapshots,
            sessions: {
              ...s.sessions,
              [sessionId]: {
                ...session,
                snapshotIds: newSnapshotIds,
                currentSnapshotId: newCurrent,
                updatedAt: nowISO(),
              },
            },
          };
        });
      },

      // ---- Bulk ----
      clearAllForDocument: (documentId) => {
        const sessions = Object.values(get().sessions).filter(
          (s) => s.documentId === documentId,
        );
        for (const s of sessions) {
          get().deleteSession(s.id);
        }
      },
    }),
    {
      name: 'agentcanvas.sessions.v1',
      storage: createJSONStorage(() => {
        if (typeof window === 'undefined') {
          // SSR-safe no-op storage (returns a stub).
          return {
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {},
          };
        }
        return window.localStorage;
      }),
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
      version: 1,
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
  if (navigator.storage?.estimate) {
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
