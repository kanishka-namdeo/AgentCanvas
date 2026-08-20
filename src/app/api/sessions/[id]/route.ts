// GET    /api/sessions/[id]          — get a session with messages + runs + snapshots
// PATCH  /api/sessions/[id]          — update session (title, status, pinned)
// DELETE /api/sessions/[id]          — delete a session (cascade)

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await db.session.findUnique({
    where: { id },
    include: {
      messages: { orderBy: { createdAt: 'asc' } },
      runs: { orderBy: { createdAt: 'asc' } },
      snapshots: { orderBy: { createdAt: 'desc' } },
    },
  });

  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  return NextResponse.json({ session });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const { title, status, pinned, runCount, toolCallCount, snapshotCount, lastOpenedAt } = body;

  const session = await db.session.update({
    where: { id },
    data: {
      ...(title !== undefined ? { title } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(pinned !== undefined ? { pinned } : {}),
      ...(runCount !== undefined ? { runCount } : {}),
      ...(toolCallCount !== undefined ? { toolCallCount } : {}),
      ...(snapshotCount !== undefined ? { snapshotCount } : {}),
      ...(lastOpenedAt !== undefined ? { lastOpenedAt } : {}),
    },
  });

  return NextResponse.json({ session });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  await db.session.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
