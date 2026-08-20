// POST /api/sessions/[id]/snapshots — create a snapshot
// GET  /api/sessions/[id]/snapshots — list snapshots

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const snapshots = await db.sessionSnapshot.findMany({
    where: { sessionId: id },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      source: true,
      runId: true,
      createdAt: true,
      // Don't select the full document JSON for list view — too large.
    },
  });
  return NextResponse.json({ snapshots });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const { document, source, runId } = body;

  const snapshot = await db.sessionSnapshot.create({
    data: {
      sessionId: id,
      document: JSON.stringify(document),
      source: source || 'turn_end',
      runId: runId || null,
    },
  });

  // Increment the session's snapshot count.
  await db.session.update({
    where: { id },
    data: { snapshotCount: { increment: 1 } },
  });

  return NextResponse.json({ snapshot });
}
