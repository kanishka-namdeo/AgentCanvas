// GET    /api/sessions/[id]          — get a session with messages + runs
// PATCH  /api/sessions/[id]          — update session (title, status, pinned)
// DELETE /api/sessions/[id]          — delete a session (cascade)
//
// NOTE (shared-canvas model): snapshots are DOCUMENT-scoped — they live at
// /api/documents/[documentId]/snapshots and are no longer included here.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const session = await db.session.findUnique({
      where: { id },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
        runs: { orderBy: { createdAt: 'asc' } },
      },
    });

    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    return NextResponse.json({ session });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown database error';
    return NextResponse.json({ error: `Failed to fetch session: ${message}` }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const { title, status, pinned, runCount, toolCallCount, lastOpenedAt } = body;

  try {
    const session = await db.session.update({
      where: { id },
      data: {
        ...(title !== undefined ? { title } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(pinned !== undefined ? { pinned } : {}),
        ...(runCount !== undefined ? { runCount } : {}),
        ...(toolCallCount !== undefined ? { toolCallCount } : {}),
        ...(lastOpenedAt !== undefined ? { lastOpenedAt } : {}),
      },
    });

    return NextResponse.json({ session });
  } catch (err) {
    // P2025: record not found — the client may be syncing a session the
    // server never created (pre-fix localStorage session). Report 404, not 500.
    const isNotFound = (err as { code?: string })?.code === 'P2025';
    if (isNotFound) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }
    const message = err instanceof Error ? err.message : 'Unknown database error';
    return NextResponse.json({ error: `Failed to update session: ${message}` }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    await db.session.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (err) {
    const isNotFound = (err as { code?: string })?.code === 'P2025';
    if (isNotFound) {
      // Already gone — treat as success (idempotent delete).
      return NextResponse.json({ success: true });
    }
    const message = err instanceof Error ? err.message : 'Unknown database error';
    return NextResponse.json({ error: `Failed to delete session: ${message}` }, { status: 500 });
  }
}
