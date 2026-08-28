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

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_HITS_PER_QUERY = 30;
const MIN_QUERY_LENGTH = 2;

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

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim();
  const documentId = req.nextUrl.searchParams.get('documentId') ?? undefined;
  const sessionId = req.nextUrl.searchParams.get('sessionId') ?? undefined;
  const scope = req.nextUrl.searchParams.get('scope') ?? 'document';

  if (q.length < MIN_QUERY_LENGTH) {
    return NextResponse.json({ hits: [] as SearchHit[], q });
  }

  // Build the Prisma where clause.
  //   scope=all      → no documentId filter
  //   scope=document → documentId filter (default)
  //   scope=session  → documentId + sessionId filter
  const where: Record<string, unknown> = {};
  if (scope === 'document' && documentId) where.documentId = documentId;
  if (scope === 'session' && sessionId) where.id = sessionId;

  // Title match: case-insensitive contains.
  const titleMatches = await db.session.findMany({
    where: { ...where, title: { contains: q } },
    take: MAX_HITS_PER_QUERY,
    orderBy: { lastOpenedAt: 'desc' },
    include: { _count: { select: { messages: true, runs: true } } },
  });

  // Message body match.
  const messageMatches = await db.sessionMessage.findMany({
    where: { content: { contains: q }, session: where.id ? undefined : (where.documentId ? { documentId: where.documentId } : undefined) },
    take: MAX_HITS_PER_QUERY,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      sessionId: true,
      content: true,
      session: {
        select: {
          id: true,
          documentId: true,
          title: true,
          status: true,
          pinned: true,
          lastOpenedAt: true,
        },
      },
    },
  });

  // Tool-call args match. SQLite JSON columns are text — `contains` is fine.
  // The toolCalls column on SessionRun is JSON-stringified; the LIKE pattern
  // matches both keys and values.
  const toolCallMatches = await db.sessionRun.findMany({
    where: { toolCalls: { contains: q }, session: where.id ? undefined : (where.documentId ? { documentId: where.documentId } : undefined) },
    take: MAX_HITS_PER_QUERY,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      sessionId: true,
      prompt: true,
      session: {
        select: {
          id: true,
          documentId: true,
          title: true,
          status: true,
          pinned: true,
          lastOpenedAt: true,
        },
      },
    },
  });

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
    const sid = m.session.id;
    let hit = bySession.get(sid);
    if (!hit) {
      hit = {
        sessionId: sid,
        documentId: m.session.documentId,
        title: m.session.title,
        status: m.session.status,
        pinned: m.session.pinned,
        lastOpenedAt: m.session.lastOpenedAt,
        messageCount: 0,
        runCount: 0,
        matchIn: [],
        snippet: null,
      };
      bySession.set(sid, hit);
    }
    if (!hit.matchIn.includes('message')) hit.matchIn.push('message');
    if (!hit.snippet) {
      const lowerContent = m.content.toLowerCase();
      const idx = lowerContent.indexOf(lower);
      if (idx !== -1) {
        const start = Math.max(0, idx - 30);
        const end = Math.min(m.content.length, idx + q.length + 30);
        hit.snippet = (start > 0 ? '…' : '') + m.content.slice(start, end) + (end < m.content.length ? '…' : '');
      }
    }
  }

  for (const r of toolCallMatches) {
    const sid = r.session.id;
    let hit = bySession.get(sid);
    if (!hit) {
      hit = {
        sessionId: sid,
        documentId: r.session.documentId,
        title: r.session.title,
        status: r.session.status,
        pinned: r.session.pinned,
        lastOpenedAt: r.session.lastOpenedAt,
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
      const pp = r.prompt.toLowerCase();
      const idx = pp.indexOf(lower);
      if (idx !== -1) {
        const start = Math.max(0, idx - 30);
        const end = Math.min(r.prompt.length, idx + q.length + 30);
        hit.snippet = (start > 0 ? '…' : '') + r.prompt.slice(start, end) + (end < r.prompt.length ? '…' : '');
      }
    }
  }

  // Sort: pinned first, then lastOpenedAt desc.
  const hits = [...bySession.values()].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.lastOpenedAt.localeCompare(a.lastOpenedAt);
  });

  return NextResponse.json({ hits: hits.slice(0, MAX_HITS_PER_QUERY), q });
}
