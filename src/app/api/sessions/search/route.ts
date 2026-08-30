// GET /api/sessions/search?q=...&documentId=...&scope=all|document|session
//
// Search sessions by:
//   - title substring (always)
//   - message body substring (any SessionMessage.content for that session)
//   - tool-call args substring (any SessionRun.toolCalls JSON for that session)
//
// This closes the title-only search gap flagged in the audit (the existing
// GET /api/sessions?documentId=... returns metadata only — no body search).
//
// Returns a list of session hits with the matched-snippet location for the
// sidebar to highlight. The list is capped at MAX_HITS_PER_QUERY so a wide
// wildcard doesn't overflow the sidebar.
//
// Security / correctness (Task 4c bug-fixes — Fix 1 + Fix 5):
//   - LIKE wildcards (`%`, `_`) in the user query are ESCAPED via the
//     `escapeLikePattern` helper before being passed to SQLite. The escape
//     char is `\` and the ESCAPE clause is bound as a parameter so SQLite
//     treats it correctly. Without escaping, a user typing `100%` would
//     get unintended wildcard matches (and `_` would match any single
//     char). The previous `contains:` Prisma filter compiled to
//     `LIKE '%q%'` with no ESCAPE clause, so a literal `\%` would never
//     have matched — we switched to raw SQL with `LIKE ? ESCAPE ?` so
//     the escape clause is honored.
//   - Query length is capped at MAX_QUERY_LENGTH to prevent DoS — a 50KB
//     query would otherwise linear-scan every SessionMessage.content row
//     in SQLite, blocking the event loop for seconds.
//   - Snippet length is capped at MAX_SNIPPET_LENGTH.

import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_HITS_PER_QUERY = 30;
const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 200;
const MAX_SNIPPET_LENGTH = 200;
/// The escape char used in the `LIKE ? ESCAPE ?` SQL clause. Doubled in the
/// pattern via `escapeLikePattern` (e.g. `\` → `\\`) and bound as a parameter
/// to the ESCAPE clause.
const LIKE_ESCAPE_CHAR = '\\';

type SearchHit = {
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
};

/// Row shape returned by the raw SQL `LIKE ? ESCAPE ?` queries below.
type TitleIdRow = { id: string };
type MessageRow = {
  id: string;
  sessionId: string;
  content: string;
  documentId: string;
  title: string;
  status: string;
  pinned: number; // SQLite BOOLEAN is stored as 0/1 in raw rows.
  lastOpenedAt: string;
};
type RunRow = {
  id: string;
  sessionId: string;
  prompt: string;
  documentId: string;
  title: string;
  status: string;
  pinned: number;
  lastOpenedAt: string;
};

/**
 * Escape a user-supplied LIKE pattern so that `%`, `_`, and the escape char
 * itself (`\`) are matched literally, NOT as wildcards. The escape semantics
 * are activated by appending `ESCAPE '\'` (or `ESCAPE ?` with `\` as the
 * bound param) to the LIKE clause in the SQL — without that clause, SQLite
 * treats the `\` as a literal char and the pattern won't match.
 *
 * Returns the input string with:
 *   - `\` → `\\` (escape the escape char FIRST — order matters)
 *   - `%` → `\%` (matches a literal percent)
 *   - `_` → `\_` (matches a literal underscore)
 *
 * Exported for unit testing.
 */
export function escapeLikePattern(s: string): string {
  // Order matters: backslash must be escaped first, otherwise the backslash
  // we insert for `%`/`_` would itself be re-escaped on a second pass.
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/// Build the snippet around the first match of `q` (case-insensitive) in
/// `content`. Capped at MAX_SNIPPET_LENGTH chars total (including ellipsis).
/// Returns null when `q` isn't found in `content` (case-insensitive).
function buildSnippet(content: string, lowerQ: string): string | null {
  if (!content) return null;
  const lowerContent = content.toLowerCase();
  const idx = lowerContent.indexOf(lowerQ);
  if (idx === -1) return null;
  // Pad symmetrically, but ensure the total slice (q.length + 2*pad) ≤ MAX.
  const pad = Math.max(
    0,
    Math.min(30, Math.floor((MAX_SNIPPET_LENGTH - lowerQ.length) / 2)),
  );
  const start = Math.max(0, idx - pad);
  const end = Math.min(content.length, idx + lowerQ.length + pad);
  let snippet =
    (start > 0 ? '…' : '') + content.slice(start, end) + (end < content.length ? '…' : '');
  if (snippet.length > MAX_SNIPPET_LENGTH) {
    snippet = snippet.slice(0, MAX_SNIPPET_LENGTH);
  }
  return snippet;
}

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim();
  const documentId = req.nextUrl.searchParams.get('documentId') ?? undefined;
  const sessionId = req.nextUrl.searchParams.get('sessionId') ?? undefined;
  const scope = req.nextUrl.searchParams.get('scope') ?? 'document';

  if (q.length < MIN_QUERY_LENGTH) {
    return NextResponse.json({ hits: [] as SearchHit[], q });
  }
  if (q.length > MAX_QUERY_LENGTH) {
    return NextResponse.json(
      {
        error: `Query must be ≤ ${MAX_QUERY_LENGTH} characters (received ${q.length}).`,
        queryTooLong: true,
        hits: [] as SearchHit[],
        q,
      },
      { status: 400 },
    );
  }

  // Build the Prisma where clause.
  //   scope=all      → no documentId filter
  //   scope=document → documentId filter (default)
  //   scope=session  → documentId + sessionId filter
  // Also build optional WHERE fragments for the raw SQL queries (Fix 1).
  const scopeFilterDoc =
    scope === 'document' && documentId
      ? Prisma.sql`AND s.documentId = ${documentId}`
      : Prisma.empty;
  const scopeFilterSession =
    scope === 'session' && sessionId
      ? Prisma.sql`AND s.id = ${sessionId}`
      : Prisma.empty;
  const scopeFilter = Prisma.join([scopeFilterDoc, scopeFilterSession], ' ');

  // Build the LIKE pattern: %escaped_q% with all metachars escaped. The
  // ESCAPE char itself is bound as a separate parameter so SQLite honors
  // the ESCAPE clause correctly (passing `ESCAPE '\'` inline in the SQL
  // string via the template tag misparses — the `\` gets consumed by the
  // template's own escape handling, surfacing as a syntax error).
  const escapedQ = escapeLikePattern(q);
  const likePattern = `%${escapedQ}%`;
  const escapeParam = LIKE_ESCAPE_CHAR;

  // Title match: case-insensitive LIKE on Session.title. SQLite's LIKE is
  // ASCII-case-insensitive by default; for case-folded languages beyond
  // ASCII (Turkish İ, German ß) the snippet builder still works because it
  // uses JS toLowerCase on the same query.
  let titleRows: TitleIdRow[] = [];
  try {
    titleRows = await db.$queryRaw<TitleIdRow[]>(Prisma.sql`
      SELECT s.id FROM Session s
      WHERE s.title LIKE ${likePattern} ESCAPE ${escapeParam}
      ${scopeFilter}
      ORDER BY s.lastOpenedAt DESC
      LIMIT ${MAX_HITS_PER_QUERY}
    `);
  } catch {
    // Fall back to no title matches — the message/tool-call queries still run.
    titleRows = [];
  }

  // Re-hydrate the matching Session rows via Prisma so we get the `_count`
  // aggregation for messages + runs (denormalized for the sidebar chip).
  // The IDs from the raw SQL query are passed through Prisma's `in` filter
  // — no user input ever reaches the SQL string itself.
  const titleIds = titleRows.map((r) => r.id);
  const titleSessions =
    titleIds.length > 0
      ? await db.session.findMany({
          where: { id: { in: titleIds } },
          include: { _count: { select: { messages: true, runs: true } } },
        })
      : [];
  // Preserve the raw-SQL ordering (lastOpenedAt DESC) — findMany doesn't
  // guarantee the `in`-list order.
  const titleById = new Map(titleSessions.map((s) => [s.id, s]));
  const titleMatches = titleIds
    .map((id) => titleById.get(id))
    .filter((s): s is NonNullable<typeof s> => Boolean(s));

  // Message body match: raw SQL LIKE ? ESCAPE ? on SessionMessage.content
  // joined to Session for the sidebar metadata fields.
  let messageMatches: MessageRow[] = [];
  try {
    messageMatches = await db.$queryRaw<MessageRow[]>(Prisma.sql`
      SELECT
        m.id         AS id,
        m.sessionId  AS sessionId,
        m.content    AS content,
        s.documentId AS documentId,
        s.title      AS title,
        s.status     AS status,
        s.pinned     AS pinned,
        s.lastOpenedAt AS lastOpenedAt
      FROM SessionMessage m
      JOIN Session s ON s.id = m.sessionId
      WHERE m.content LIKE ${likePattern} ESCAPE ${escapeParam}
      ${scopeFilter}
      ORDER BY m.createdAt DESC
      LIMIT ${MAX_HITS_PER_QUERY}
    `);
  } catch {
    messageMatches = [];
  }

  // Tool-call args match: raw SQL LIKE ? ESCAPE ? on SessionRun.toolCalls
  // (JSON-stringified server-side — the LIKE pattern matches both keys
  // and values). Joined to Session for sidebar metadata.
  let toolCallMatches: RunRow[] = [];
  try {
    toolCallMatches = await db.$queryRaw<RunRow[]>(Prisma.sql`
      SELECT
        r.id         AS id,
        r.sessionId  AS sessionId,
        r.prompt     AS prompt,
        s.documentId AS documentId,
        s.title      AS title,
        s.status     AS status,
        s.pinned     AS pinned,
        s.lastOpenedAt AS lastOpenedAt
      FROM SessionRun r
      JOIN Session s ON s.id = r.sessionId
      WHERE r.toolCalls LIKE ${likePattern} ESCAPE ${escapeParam}
      ${scopeFilter}
      ORDER BY r.createdAt DESC
      LIMIT ${MAX_HITS_PER_QUERY}
    `);
  } catch {
    toolCallMatches = [];
  }

  // Build a hit-by-session map (dedupe across the three sources).
  const bySession = new Map<string, SearchHit>();
  const lower = q.toLowerCase();

  for (const s of titleMatches) {
    const hit: SearchHit = {
      sessionId: s.id,
      documentId: s.documentId,
      title: s.title,
      status: s.status,
      pinned: s.pinned,
      lastOpenedAt: s.lastOpenedAt,
      messageCount: s._count?.messages ?? 0,
      runCount: s._count?.runs ?? 0,
      matchIn: ['title'],
      snippet: null,
    };
    bySession.set(s.id, hit);
  }

  for (const m of messageMatches) {
    const sid = m.sessionId;
    let hit = bySession.get(sid);
    if (!hit) {
      hit = {
        sessionId: sid,
        documentId: m.documentId,
        title: m.title,
        status: m.status,
        pinned: Boolean(m.pinned),
        lastOpenedAt: m.lastOpenedAt,
        messageCount: 0,
        runCount: 0,
        matchIn: [],
        snippet: null,
      };
      bySession.set(sid, hit);
    }
    if (!hit.matchIn.includes('message')) hit.matchIn.push('message');
    if (!hit.snippet) {
      const snip = buildSnippet(m.content, lower);
      if (snip) hit.snippet = snip;
    }
  }

  for (const r of toolCallMatches) {
    const sid = r.sessionId;
    let hit = bySession.get(sid);
    if (!hit) {
      hit = {
        sessionId: sid,
        documentId: r.documentId,
        title: r.title,
        status: r.status,
        pinned: Boolean(r.pinned),
        lastOpenedAt: r.lastOpenedAt,
        messageCount: 0,
        runCount: 0,
        matchIn: [],
        snippet: null,
      };
      bySession.set(sid, hit);
    }
    if (!hit.matchIn.includes('tool_calls')) hit.matchIn.push('tool_calls');
    if (!hit.snippet) {
      // Use the run prompt as the snippet if no message snippet has been set.
      const snip = buildSnippet(r.prompt, lower);
      if (snip) hit.snippet = snip;
    }
  }

  // Sort: pinned first, then lastOpenedAt desc.
  const hits = [...bySession.values()].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.lastOpenedAt.localeCompare(a.lastOpenedAt);
  });

  return NextResponse.json({ hits: hits.slice(0, MAX_HITS_PER_QUERY), q });
}
