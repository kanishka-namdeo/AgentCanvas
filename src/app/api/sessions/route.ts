// GET /api/sessions?documentId=xxx
// POST /api/sessions  — create a new session
//
// Server-side session persistence (Phase 3). The client's localStorage remains
// as a fast cache; this API is the source of truth.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const documentId = req.nextUrl.searchParams.get('documentId');
  const status = req.nextUrl.searchParams.get('status') ?? 'active';

  const sessions = await db.session.findMany({
    where: {
      ...(documentId ? { documentId } : {}),
      status,
    },
    orderBy: { lastOpenedAt: 'desc' },
    include: {
      _count: { select: { messages: true, runs: true, snapshots: true } },
    },
  });

  return NextResponse.json({ sessions });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { documentId, title, parentSessionId } = body;

  if (!documentId) {
    return NextResponse.json({ error: 'documentId is required' }, { status: 400 });
  }

  const session = await db.session.create({
    data: {
      documentId,
      title: title || 'Untitled',
      parentSessionId: parentSessionId || null,
      lastOpenedAt: new Date().toISOString(),
    },
  });

  return NextResponse.json({ session });
}
