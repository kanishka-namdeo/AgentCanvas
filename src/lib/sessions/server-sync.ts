// Server-side session sync — bridges the client's localStorage-based session
// store with the server-side Prisma persistence.
//
// The client calls these functions to sync on key events:
//   - createSession → POST /api/sessions
//   - appendMessage → POST /api/sessions/[id]/messages
//   - startRun / endRun → POST /api/sessions/[id]/runs
//   - captureSnapshot / restore → POST /api/documents/[documentId]/snapshots
//     (document-scoped, shared canvas model)
//
// The client's localStorage remains the fast cache for instant UI updates.
// The server is the source of truth for persistence.
//
// All functions are safe to call from the client (they use fetch).
// If the server is unreachable, they queue the request for retry via
// the persistent offline queue (sync-queue.ts) — the localStorage cache
// keeps working, and the queue flushes on reconnect.

import { enqueueSync } from './sync-queue';

interface ServerSession {
  id: string;
  documentId: string;
  title: string;
  status: string;
  pinned: boolean;
  runCount: number;
  toolCallCount: number;
  lastOpenedAt: string;
  parentSessionId: string | null;
  /// JSON-encoded string array of tags. Parsed defensively by the client merge
  /// in store.ts (bad JSON / non-array → []). See api/sessions POST/PATCH
  /// for the server-side serialization.
  tags?: string;
  createdAt: string;
  updatedAt: string;
  /// Relation counts returned by GET /api/sessions (Prisma `_count` include).
  /// Used by the client merge to skip empty session shells.
  _count?: { messages: number; runs: number };
}

/// A document-scoped canvas snapshot row (shared canvas model). The LIST
/// endpoint omits the heavy `document` JSON; the single-GET includes it.
export interface ServerDocSnapshot {
  id: string;
  documentId: string;
  sessionId: string | null;
  messageId: string | null;
  runId: string | null;
  source: string;
  nodeCount: number;
  label: string | null;
  bookmarked: boolean;
  createdAt: string;
  document?: unknown;
}

/// A server-side document row returned by GET /api/documents.
/// `viewport` and `background` are NOT returned by the list endpoint
/// (the switcher only needs id + name + timestamps). The former optional
/// `_count: { shapes, actions }` mirror was removed with the server-side
/// subselect — both tables have zero writers and no client read them.
export interface ServerDocument {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  viewport?: string;
  background?: string;
}

/// A search hit from GET /api/sessions/search — a session with at least one
/// match in title, message body, or tool-call args. `snippet` is a short
/// excerpt around the first match for the sidebar to highlight.
export interface ServerSessionSearchHit {
  sessionId: string;
  documentId: string;
  title: string;
  status: string;
  pinned: boolean;
  lastOpenedAt: string;
  messageCount: number;
  runCount: number;
  matchIn: Array<'title' | 'message' | 'tool_calls'>;
  snippet: string | null;
}

/// Tag suggestion returned by GET /api/sessions/[id]/tags — distinct tag
/// strings used across all sessions in the same document, with counts.
export interface ServerTagSuggestion {
  tag: string;
  count: number;
}

/// Fetch sessions from the server for a given document.
/// Supports cursor-based pagination: pass `cursor` (the `lastOpenedAt` of the
/// last item from the previous page) to fetch the next page. Returns the
/// sessions array and a `nextCursor` (null when no more pages).
export async function fetchServerSessions(
  documentId: string,
  cursor?: string | null,
): Promise<{ sessions: ServerSession[]; nextCursor: string | null }> {
  try {
    const params = new URLSearchParams({ documentId });
    if (cursor) params.set('cursor', cursor);
    const res = await fetch(`/api/sessions?${params.toString()}`);
    if (!res.ok) return { sessions: [], nextCursor: null };
    const data = await res.json();
    return {
      sessions: data.sessions ?? [],
      nextCursor: data.nextCursor ?? null,
    };
  } catch {
    return { sessions: [], nextCursor: null };
  }
}

/// Strict variant: returns `null` when the server is unreachable or errors,
/// and the (possibly empty) session array on success. Callers use this to
/// distinguish "server says this document has no sessions" (safe to reconcile
/// deletions) from "could not ask the server" (must keep the local cache).
export async function fetchServerSessionsStrict(
  documentId: string,
  cursor?: string | null,
): Promise<{ sessions: ServerSession[]; nextCursor: string | null } | null> {
  try {
    const params = new URLSearchParams({ documentId });
    if (cursor) params.set('cursor', cursor);
    const res = await fetch(`/api/sessions?${params.toString()}`);
    if (!res.ok) return null;
    const data = await res.json();
    return {
      sessions: data.sessions ?? [],
      nextCursor: data.nextCursor ?? null,
    };
  } catch {
    return null;
  }
}

/// Create a session on the server.
/// `id` is the client's localStorage session id — the server row is created
/// with the SAME id so subsequent child writes (runs/messages/snapshots)
/// never hit foreign-key violations. Idempotent: if the id already exists
/// server-side, the existing session is returned.
export async function createServerSession(session: {
  id: string;
  documentId: string;
  title: string;
  parentId?: string | null;
  tags?: string[];
}): Promise<ServerSession | null> {
  const payload = {
    id: session.id,
    documentId: session.documentId,
    title: session.title,
    parentSessionId: session.parentId ?? undefined,
    tags: session.tags,
  };
  try {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      // Queue for retry on non-OK response.
      enqueueSync({ endpoint: '/api/sessions', method: 'POST', body: JSON.stringify(payload) });
      return null;
    }
    const data = await res.json();
    return data.session ?? null;
  } catch {
    // Queue for retry on network failure.
    enqueueSync({ endpoint: '/api/sessions', method: 'POST', body: JSON.stringify(payload) });
    return null;
  }
}

/// Update a session on the server (title, status, pinned, tags, counts).
export async function updateServerSession(
  id: string,
  updates: Partial<Pick<ServerSession, 'title' | 'status' | 'pinned' | 'runCount' | 'toolCallCount' | 'lastOpenedAt'>> & { tags?: string[] },
): Promise<void> {
  const endpoint = `/api/sessions/${id}`;
  const body = JSON.stringify(updates);
  try {
    const res = await fetch(endpoint, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body,
    });
    if (!res.ok) {
      // Queue for retry on non-OK response.
      enqueueSync({ endpoint, method: 'PATCH', body });
    }
  } catch {
    // Queue for retry on network failure.
    enqueueSync({ endpoint, method: 'PATCH', body });
  }
}

/// Delete a session on the server.
export async function deleteServerSession(id: string): Promise<void> {
  const endpoint = `/api/sessions/${id}`;
  try {
    const res = await fetch(endpoint, { method: 'DELETE' });
    if (!res.ok) {
      // Queue for retry on non-OK response.
      enqueueSync({ endpoint, method: 'DELETE', body: null });
    }
  } catch {
    // Queue for retry on network failure.
    enqueueSync({ endpoint, method: 'DELETE', body: null });
  }
}

/// Append a message to a session on the server.
/// `documentId` lets the route auto-create a missing session shell
/// (pre-fix localStorage sessions) instead of failing with an FK error.
/// `messageId` upserts under the CLIENT's message id — this keeps server
/// rows id-linked to localStorage messages, which the attachment sync and
/// cross-device hydration rely on.
export async function appendServerMessage(
  sessionId: string,
  message: { role: 'user' | 'assistant'; content: string; status?: string; error?: string; runId?: string; messageId?: string; diffSummary?: string },
  documentId?: string,
): Promise<string | null> {
  const endpoint = `/api/sessions/${sessionId}/messages`;
  const payload = { ...message, documentId };
  const body = JSON.stringify(payload);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    if (!res.ok) {
      // Queue for retry on non-OK response.
      enqueueSync({ endpoint, method: 'POST', body });
      return null;
    }
    const data = await res.json();
    return data.message?.id ?? null;
  } catch {
    // Queue for retry on network failure.
    enqueueSync({ endpoint, method: 'POST', body });
    return null;
  }
}

/// Persist a user message's image attachments to the server DB
/// (SessionAttachment rows — the "alongside localStorage" copy). Fire-and-
/// forget: the localStorage cache stays authoritative for the live UI when
/// the server is unreachable. Idempotent — rows are keyed by the client's
/// attachment id (img_…), so retries never duplicate.
export async function syncServerAttachments(
  sessionId: string,
  messageId: string,
  images: Array<{ id: string; name: string; dataUrl: string }>,
): Promise<number> {
  if (!images || images.length === 0) return 0;
  try {
    const res = await fetch(`/api/sessions/${sessionId}/attachments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId, attachments: images }),
    });
    if (!res.ok) return 0;
    const data = await res.json().catch(() => ({}));
    return data.saved ?? 0;
  } catch {
    return 0; // silent — localStorage cache still holds the images.
  }
}

/// Fetch a session's messages (with attachments + diff summaries) from the
/// server, mapped back into the client Message shape. Used for cross-device
/// hydration: a fresh browser gets full history INCLUDING image thumbnails
/// and turn-diff records. Returns [] when the server is unreachable.
export async function fetchServerMessages(sessionId: string): Promise<Array<{
  id: string; role: string; text: string; status: string; error: string | null;
  runId: string | null; createdAt: string;
  images?: Array<{ id: string; name: string; dataUrl: string }>;
  patchOps?: Array<{ op: string; count: number; summary: string }>;
}>> {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/messages`);
    if (!res.ok) return [];
    const data = await res.json();
    const messages = data.messages ?? [];
    return messages.map((m: any) => ({
      id: m.id,
      role: m.role,
      text: m.content,
      status: m.status,
      error: m.error ?? null,
      runId: m.runId ?? null,
      createdAt: m.createdAt,
      ...(Array.isArray(m.attachments) && m.attachments.length > 0
        ? {
            images: m.attachments.map((a: any) => ({
              id: a.id,
              name: a.name,
              dataUrl: `data:${a.mimeType};base64,${a.data}`,
            })),
          }
        : {}),
      ...(m.diffSummary
        ? { patchOps: safeParsePatchOps(m.diffSummary) }
        : {}),
    }));
  } catch {
    return [];
  }
}

function safeParsePatchOps(raw: string): Array<{ op: string; count: number; summary: string }> {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r: any) => r && typeof r.op === 'string' && typeof r.count === 'number' && typeof r.summary === 'string',
    );
  } catch {
    return [];
  }
}

/// Create/update a run on the server.
/// `documentId` lets the route auto-create a missing session shell.
export async function syncServerRun(
  sessionId: string,
  run: { prompt: string; status?: string; runId?: string; errorMessage?: string; toolCallCount?: number; toolCalls?: any[]; documentId?: string; inputTokens?: number; outputTokens?: number; costUsd?: number },
): Promise<string | null> {
  const endpoint = `/api/sessions/${sessionId}/runs`;
  const body = JSON.stringify(run);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    if (!res.ok) {
      // Queue for retry on non-OK response.
      enqueueSync({ endpoint, method: 'POST', body });
      return null;
    }
    const data = await res.json();
    return data.run?.id ?? null;
  } catch {
    // Queue for retry on network failure.
    enqueueSync({ endpoint, method: 'POST', body });
    return null;
  }
}

/// Capture a document-scoped snapshot on the server (shared canvas model).
/// Idempotent: keyed by the client-supplied `id` (same contract as
/// createServerSession — the server row shares the client id so future
/// bookmark/label/delete syncs target the same row).
export async function captureDocumentSnapshot(payload: {
  id: string;
  documentId: string;
  sessionId?: string | null;
  document: unknown;
  source?: string;
  runId?: string | null;
  messageId?: string | null;
  nodeCount?: number;
  label?: string | null;
}): Promise<boolean> {
  const endpoint = `/api/documents/${encodeURIComponent(payload.documentId)}/snapshots`;
  const body = JSON.stringify({
    id: payload.id,
    sessionId: payload.sessionId ?? undefined,
    document: payload.document,
    source: payload.source,
    runId: payload.runId ?? undefined,
    messageId: payload.messageId ?? undefined,
    nodeCount: payload.nodeCount,
    label: payload.label ?? undefined,
  });
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    if (!res.ok) {
      // Queue for retry on non-OK response.
      enqueueSync({ endpoint, method: 'POST', body });
      return false;
    }
    return true;
  } catch {
    // Queue for retry on network failure.
    enqueueSync({ endpoint, method: 'POST', body });
    return false;
  }
}

/// List a document's snapshots (metadata only — no document JSON).
/// Returns null when the server is unreachable (caller keeps the local cache).
export async function fetchDocumentSnapshots(documentId: string): Promise<ServerDocSnapshot[] | null> {
  try {
    const res = await fetch(`/api/documents/${encodeURIComponent(documentId)}/snapshots`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.snapshots ?? null;
  } catch {
    return null;
  }
}

/// Fetch ONE snapshot including the full document JSON (restore path for
/// remote metadata-only entries).
export async function fetchDocumentSnapshot(
  documentId: string,
  id: string,
): Promise<ServerDocSnapshot | null> {
  try {
    const res = await fetch(
      `/api/documents/${encodeURIComponent(documentId)}/snapshots/${encodeURIComponent(id)}`,
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.snapshot ?? null;
  } catch {
    return null;
  }
}

/// Update a snapshot's label / bookmark flag on the server.
export async function updateDocumentSnapshot(
  documentId: string,
  id: string,
  updates: { label?: string | null; bookmarked?: boolean },
): Promise<boolean> {
  try {
    const res = await fetch(
      `/api/documents/${encodeURIComponent(documentId)}/snapshots/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(updates),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

/// Delete a snapshot on the server.
export async function deleteDocumentSnapshot(documentId: string, id: string): Promise<boolean> {
  try {
    const res = await fetch(
      `/api/documents/${encodeURIComponent(documentId)}/snapshots/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
    return res.ok;
  } catch {
    return false;
  }
}

/// Export a session as a JSONL conversation (compatible with the pi-agent SDK's
/// serializeConversation format). Calls the server to get the full session.
export async function exportSessionJSONL(sessionId: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/sessions/${sessionId}`);
    if (!res.ok) return null;
    const data = await res.json();
    const session = data.session;
    if (!session) return null;

    // Build a JSONL string (one JSON object per line).
    const lines: string[] = [];
    lines.push(JSON.stringify({
      type: 'session_header',
      id: session.id,
      title: session.title,
      documentId: session.documentId,
      createdAt: session.createdAt,
    }));
    for (const msg of session.messages ?? []) {
      lines.push(JSON.stringify({
        type: 'message',
        id: msg.id,
        role: msg.role,
        content: msg.content,
        status: msg.status,
        runId: msg.runId,
        createdAt: msg.createdAt,
      }));
    }
    return lines.join('\n');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Multi-document CRUD (P3-1) — the page used to hard-code `documentId='demo'`;
// these functions power the document switcher in SessionHeader.
// ---------------------------------------------------------------------------

/// List all documents (most recent first). Returns [] when the server is
/// unreachable so the client can fall back to its localStorage document list.
export async function fetchServerDocuments(): Promise<ServerDocument[]> {
  try {
    const res = await fetch('/api/documents');
    if (!res.ok) return [];
    const data = await res.json();
    return data.documents ?? [];
  } catch {
    return [];
  }
}

/// Create a new document. Idempotent by `id` (returns the existing row if
/// already present). `id` is validated server-side against `^[A-Za-z0-9_-]{1,64}$`.
/// (2026-09-07 UI hardening, 12-c#12) returns `{ document, error }` — `error`
/// surfaces the server's JSON error body (e.g. the 100-char name cap) so the
/// UI can show the REAL reason instead of always guessing "id may already
/// exist". `error` is null on network failure (the caller's generic fallback
/// covers that case).
export async function createServerDocument(payload: {
  id?: string;
  name?: string;
  background?: string;
}): Promise<{ document: ServerDocument | null; error: string | null }> {
  try {
    const res = await fetch('/api/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: unknown } | null;
      return {
        document: null,
        error: typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`,
      };
    }
    const data = await res.json();
    return { document: data.document ?? null, error: null };
  } catch {
    return { document: null, error: null };
  }
}

/// Update a document (rename / viewport / background).
export async function updateServerDocument(
  id: string,
  updates: { name?: string; viewport?: unknown; background?: string },
): Promise<ServerDocument | null> {
  try {
    const res = await fetch(`/api/documents/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.document ?? null;
  } catch {
    return null;
  }
}

/// Delete a document (cascade: shapes, actions, sessions, snapshots, events).
export async function deleteServerDocument(id: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/documents/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Content search (P3-2) — title-only search closed; this hits message body
// + tool-call args too. Mirrors v0 / ChatGPT / Claude consensus.
// ---------------------------------------------------------------------------

/// Search sessions by content (title + message body + tool-call args).
/// Returns null if the server is unreachable so the caller can fall back
/// to the in-memory title filter.
export async function searchServerSessions(payload: {
  q: string;
  documentId?: string;
  sessionId?: string;
  scope?: 'all' | 'document' | 'session';
}): Promise<ServerSessionSearchHit[] | null> {
  try {
    const params = new URLSearchParams({ q: payload.q });
    if (payload.scope) params.set('scope', payload.scope);
    if (payload.documentId) params.set('documentId', payload.documentId);
    if (payload.sessionId) params.set('sessionId', payload.sessionId);
    const res = await fetch(`/api/sessions/search?${params.toString()}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.hits ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tag suggestions (P3-3) — aggregated tag list for a session's document.
// ---------------------------------------------------------------------------

/// List distinct tags used across every session in the same document as
/// `sessionId`, with counts. Used by the sidebar's tag-combobox to offer
/// already-used tag strings. Returns [] when the server is unreachable.
export async function fetchServerTagSuggestions(sessionId: string): Promise<ServerTagSuggestion[]> {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/tags`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.tags ?? [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Emergency sync (quota failure recovery) — called when localStorage quota
// is exceeded. Attempts to sync the active session to the server before
// the user loses their data. Fire-and-forget.
// ---------------------------------------------------------------------------

/// Emergency sync: push each document's active session metadata to the server.
/// Called by the quota-aware persist handler when localStorage writes fail.
/// This is a best-effort attempt to preserve data before the tab is closed.
export function syncActiveSessionToServer(): void {
  // Dynamic import to avoid circular dependency (store.ts imports this file).
  import('./store').then(({ useSessionStore }) => {
    const state = useSessionStore.getState();

    // Sync every document's active session (activeSessionByDoc maps
    // documentId → sessionId).
    for (const sessionId of Object.values(state.activeSessionByDoc)) {
      const session = state.sessions[sessionId];
      if (!session) continue;

      // Fire-and-forget: create or update the session on the server.
      // If this fails, the toast already told the user storage is full.
      createServerSession({
        id: session.id,
        documentId: session.documentId,
        title: session.title,
        parentId: session.parentId,
        tags: session.tags,
      }).then(() => {
        // Sync counts if the session was created successfully.
        updateServerSession(session.id, {
          runCount: session.runCount,
          toolCallCount: session.toolCallCount,
          lastOpenedAt: new Date().toISOString(),
        });
      }).catch(() => {
        // Silent fail — the toast already warned the user.
      });
    }
  }).catch(() => {
    // Silent fail — store import failed (shouldn't happen in practice).
  });
}

// ---------------------------------------------------------------------------
// Markdown export (P2-37) — chat transcript as Markdown, replacing the
// long-standing P2-37 stub in SessionSidebar and RunHistoryPanel.
// ---------------------------------------------------------------------------

/// Render a server session (with messages + runs) as a Markdown transcript.
/// Each message is an `## role` heading; tool-call records (if present on
/// runs) are folded under the assistant message that produced them as a
/// bulleted timeline. The header carries session id, document id, created
/// date, and tag list. Mirrors the Markdown export pattern in Cursor's
/// composer and Devin's "Copy Thread" feature.
export function renderSessionMarkdown(payload: {
  id: string;
  documentId: string;
  title: string;
  createdAt: string;
  tags?: string[];
  messages: Array<{
    id: string;
    role: string;
    content: string;
    status?: string;
    error?: string | null;
    runId?: string | null;
    createdAt: string;
    diffSummary?: string | null;
  }>;
  runs?: Array<{
    id: string;
    prompt: string;
    status: string;
    toolCallCount?: number;
    toolCalls?: string;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  }>;
}): string {
  const lines: string[] = [];
  const title = payload.title || 'Untitled chat';
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`> **Session ID:** \`${payload.id}\`  `);
  lines.push(`> **Document:** \`${payload.documentId}\`  `);
  lines.push(`> **Created:** ${new Date(payload.createdAt).toLocaleString()}  `);
  if (payload.tags && payload.tags.length > 0) {
    lines.push(`> **Tags:** ${payload.tags.map((t) => `\`${t}\``).join(' ')}  `);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // Index runs by id for tool-call timeline lookup.
  const runsById = new Map<string, NonNullable<typeof payload.runs>[number]>();
  for (const r of payload.runs ?? []) runsById.set(r.id, r);

  for (const msg of payload.messages) {
    const role = msg.role === 'user' ? '🧑 User' : msg.role === 'assistant' ? '🤖 Assistant' : msg.role;
    lines.push(`## ${role}`);
    lines.push('');
    if (msg.content) {
      lines.push(msg.content);
      lines.push('');
    }
    if (msg.error) {
      lines.push(`> ⚠️ **Error:** ${msg.error}`);
      lines.push('');
    }
    if (msg.status === 'cancelled') {
      lines.push('_Cancelled._');
      lines.push('');
    }
    // Tool-call timeline for assistant messages that belong to a run.
    if (msg.runId) {
      const run = runsById.get(msg.runId);
      if (run) {
        let toolCalls: Array<{ name?: string; args?: unknown; success?: boolean; durationMs?: number }> = [];
        try {
          const parsed = JSON.parse(run.toolCalls || '[]');
          if (Array.isArray(parsed)) toolCalls = parsed;
        } catch {
          // Bad JSON — leave the timeline empty.
        }
        if (toolCalls.length > 0) {
          lines.push(`<details><summary>Tool calls (${toolCalls.length})</summary>`);
          lines.push('');
          for (const tc of toolCalls) {
            const mark = tc.success === false ? '✗' : '✓';
            const dur = typeof tc.durationMs === 'number' ? ` · ${tc.durationMs}ms` : '';
            lines.push(`- ${mark} \`${tc.name ?? 'unknown'}\`${dur}`);
          }
          lines.push('');
          lines.push('</details>');
          lines.push('');
        }
        // Cost line — show tokens + USD when non-zero.
        if ((run.inputTokens ?? 0) > 0 || (run.outputTokens ?? 0) > 0) {
          const cost = (run.costUsd ?? 0) > 0 ? ` · $${(run.costUsd ?? 0).toFixed(4)}` : '';
          lines.push(`_tokens: ${run.inputTokens ?? 0} in / ${run.outputTokens ?? 0} out${cost}_`);
          lines.push('');
        }
      }
    }
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

/// Export a session as Markdown by fetching its full record from the server.
/// Returns null when the server is unreachable (caller falls back to the
/// local-only JSON export path that already existed).
export async function exportSessionMarkdown(sessionId: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/sessions/${sessionId}`);
    if (!res.ok) return null;
    const data = await res.json();
    const session = data.session;
    if (!session) return null;
    // Parse tags defensively (server stores JSON; bad column → empty array).
    let tags: string[] = [];
    try {
      const parsed = JSON.parse(session.tags ?? '[]');
      if (Array.isArray(parsed)) tags = parsed.filter((t: unknown) => typeof t === 'string');
    } catch {
      // fall through
    }
    return renderSessionMarkdown({
      id: session.id,
      documentId: session.documentId,
      title: session.title,
      createdAt: session.createdAt,
      tags,
      messages: session.messages ?? [],
      runs: session.runs ?? [],
    });
  } catch {
    return null;
  }
}

/// Export a SINGLE run as Markdown — used by the RunHistoryPanel context menu.
/// Includes the run's prompt, status, tool-call timeline, cost, and the
/// assistant message that this run produced.
export async function exportRunMarkdown(sessionId: string, runId: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/sessions/${sessionId}`);
    if (!res.ok) return null;
    const data = await res.json();
    const session = data.session;
    if (!session) return null;
    const run = (session.runs ?? []).find((r: { id: string }) => r.id === runId);
    if (!run) return null;
    // Filter messages to those attached to this run (typically a user prompt
    // + one assistant reply).
    const runMessages = (session.messages ?? []).filter(
      (m: { runId?: string | null }) => m.runId === runId,
    );
    const lines: string[] = [];
    lines.push(`# Run · ${run.prompt.slice(0, 60)}${run.prompt.length > 60 ? '…' : ''}`);
    lines.push('');
    lines.push(`> **Run ID:** \`${run.id}\`  `);
    lines.push(`> **Session:** \`${sessionId}\`  `);
    lines.push(`> **Status:** ${run.status}  `);
    if (run.errorMessage) lines.push(`> **Error:** ${run.errorMessage}  `);
    lines.push('');
    lines.push('---');
    lines.push('');
    for (const msg of runMessages) {
      const role = msg.role === 'user' ? '🧑 User' : msg.role === 'assistant' ? '🤖 Assistant' : msg.role;
      lines.push(`## ${role}`);
      lines.push('');
      if (msg.content) {
        lines.push(msg.content);
        lines.push('');
      }
      lines.push('---');
      lines.push('');
    }
    // Tool-call timeline.
    let toolCalls: Array<{ name?: string; args?: unknown; success?: boolean; durationMs?: number }> = [];
    try {
      const parsed = JSON.parse(run.toolCalls || '[]');
      if (Array.isArray(parsed)) toolCalls = parsed;
    } catch {
      // ignore
    }
    if (toolCalls.length > 0) {
      lines.push(`## Tool calls (${toolCalls.length})`);
      lines.push('');
      for (const tc of toolCalls) {
        const mark = tc.success === false ? '✗' : '✓';
        const dur = typeof tc.durationMs === 'number' ? ` · ${tc.durationMs}ms` : '';
        lines.push(`- ${mark} \`${tc.name ?? 'unknown'}\`${dur}`);
      }
      lines.push('');
    }
    if ((run.inputTokens ?? 0) > 0 || (run.outputTokens ?? 0) > 0) {
      const cost = (run.costUsd ?? 0) > 0 ? ` · $${(run.costUsd ?? 0).toFixed(4)}` : '';
      lines.push(`_tokens: ${run.inputTokens ?? 0} in / ${run.outputTokens ?? 0} out${cost}_`);
      lines.push('');
    }
    return lines.join('\n');
  } catch {
    return null;
  }
}
