// GET /api/sessions?documentId=xxx — list sessions (most recent first, capped)
// POST /api/sessions             — create a new session (idempotent by id)
//
// Server-side session persistence (Phase 3). The client's localStorage remains
// as a fast cache; this API is the source of truth.
//
// POST accepts an optional client-supplied `id` (the client's localStorage
// session id). When provided, the server row is created with THAT id so child
// writes (runs/messages/snapshots) reference a session that exists — this is
// the fix for the ForeignKeyConstraintViolation spam (see ensure-session.ts).

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Cap the list response. Without this, a corrupted/legacy DB with thousands of
// empty session shells floods the client merge on every load.
const MAX_SESSIONS_RETURNED = 50;

export async function GET(req: NextRequest) {
  const documentId = req.nextUrl.searchParams.get('documentId');
  const status = req.nextUrl.searchParams.get('status') ?? 'active';

  try {
    const sessions = await db.session.findMany({
      where: {
        ...(documentId ? { documentId } : {}),
        status,
      },
      orderBy: { lastOpenedAt: 'desc' },
      take: MAX_SESSIONS_RETURNED,
      include: {
        _count: { select: { messages: true, runs: true, snapshots: true } },
      },
    });

    return NextResponse.json({ sessions });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown database error';
    return NextResponse.json({ error: `Failed to list sessions: ${message}` }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { documentId, title, parentSessionId, id } = body;

  if (!documentId) {
    return NextResponse.json({ error: 'documentId is required' }, { status: 400 });
  }

  try {
    // Idempotency: if the client-supplied id already exists, return the
    // existing row instead of failing on the unique primary-key constraint.
    // (The client fire-and-forgets creates, so duplicate requests happen.)
    if (id) {
      const existing = await db.session.findUnique({ where: { id } });
      if (existing) {
        return NextResponse.json({ session: existing });
      }
    }

    const session = await db.session.create({
      data: {
        // Client-supplied id (client localStorage id) — keeps client and
        // server rows aligned so child writes never FK-fail. Falls back to
        // the Prisma cuid default when absent.
        ...(id ? { id } : {}),
        documentId,
        title: title || 'Untitled',
        parentSessionId: parentSessionId || null,
        lastOpenedAt: new Date().toISOString(),
      },
    });

    return NextResponse.json({ session });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown database error';
    return NextResponse.json({ error: `Failed to create session: ${message}` }, { status: 500 });
  }
}
