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
export async function appendServerMessage(
  sessionId: string,
  message: { role: 'user' | 'assistant'; content: string; status?: string; error?: string; runId?: string; messageId?: string },
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
