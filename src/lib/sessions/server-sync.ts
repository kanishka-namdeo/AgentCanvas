// Server-side session sync — bridges the client's localStorage-based session
// store with the server-side Prisma persistence.
//
// The client calls these functions to sync sessions on key events:
//   - createSession → POST /api/sessions
//   - appendMessage → POST /api/sessions/[id]/messages
//   - startRun / endRun → POST /api/sessions/[id]/runs
//   - captureSnapshot → POST /api/sessions/[id]/snapshots
//
// The client's localStorage remains the fast cache for instant UI updates.
// The server is the source of truth for persistence.
//
// All functions are safe to call from the client (they use fetch).
// If the server is unreachable, they silently fail — the localStorage cache
// keeps working.

interface ServerSession {
  id: string;
  documentId: string;
  title: string;
  status: string;
  pinned: boolean;
  runCount: number;
  toolCallCount: number;
  snapshotCount: number;
  lastOpenedAt: string;
  parentSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  /// Relation counts returned by GET /api/sessions (Prisma `_count` include).
  /// Used by the client merge to skip empty session shells.
  _count?: { messages: number; runs: number; snapshots: number };
}

/// Fetch sessions from the server for a given document.
export async function fetchServerSessions(documentId: string): Promise<ServerSession[]> {
  try {
    const res = await fetch(`/api/sessions?documentId=${encodeURIComponent(documentId)}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.sessions ?? [];
  } catch {
    return [];
  }
}

/// Strict variant: returns `null` when the server is unreachable or errors,
/// and the (possibly empty) session array on success. Callers use this to
/// distinguish "server says this document has no sessions" (safe to reconcile
/// deletions) from "could not ask the server" (must keep the local cache).
export async function fetchServerSessionsStrict(documentId: string): Promise<ServerSession[] | null> {
  try {
    const res = await fetch(`/api/sessions?documentId=${encodeURIComponent(documentId)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.sessions ?? [];
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
}): Promise<ServerSession | null> {
  try {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: session.id,
        documentId: session.documentId,
        title: session.title,
        parentSessionId: session.parentId ?? undefined,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.session ?? null;
  } catch {
    return null;
  }
}

/// Update a session on the server (title, status, pinned, counts).
export async function updateServerSession(
  id: string,
  updates: Partial<Pick<ServerSession, 'title' | 'status' | 'pinned' | 'runCount' | 'toolCallCount' | 'snapshotCount' | 'lastOpenedAt'>>,
): Promise<void> {
  try {
    await fetch(`/api/sessions/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(updates),
    });
  } catch {
    // Silent fail — localStorage cache is still valid.
  }
}

/// Delete a session on the server.
export async function deleteServerSession(id: string): Promise<void> {
  try {
    await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
  } catch {
    // Silent fail.
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
  try {
    const res = await fetch(`/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...message, documentId }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.message?.id ?? null;
  } catch {
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
  run: { prompt: string; status?: string; runId?: string; errorMessage?: string; toolCallCount?: number; toolCalls?: any[]; documentId?: string },
): Promise<string | null> {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(run),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.run?.id ?? null;
  } catch {
    return null;
  }
}

/// Capture a snapshot on the server.
/// `documentId` lets the route auto-create a missing session shell.
export async function captureServerSnapshot(
  sessionId: string,
  document: unknown,
  source: string = 'turn_end',
  runId?: string,
  documentId?: string,
): Promise<string | null> {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/snapshots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ document, source, runId, documentId }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.snapshot?.id ?? null;
  } catch {
    return null;
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
