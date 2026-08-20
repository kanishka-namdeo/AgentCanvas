// POST /api/sessions/[id]/messages — add a message to a session
// GET  /api/sessions/[id]/messages — list messages

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const messages = await db.sessionMessage.findMany({
    where: { sessionId: id },
    orderBy: { createdAt: 'asc' },
  });
  return NextResponse.json({ messages });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const { role, content, status, error, runId, messageId } = body;

  // If messageId is provided, update existing message (for streaming → complete).
  if (messageId) {
    const msg = await db.sessionMessage.update({
      where: { id: messageId },
      data: {
        ...(content !== undefined ? { content } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(error !== undefined ? { error } : {}),
      },
    });
    return NextResponse.json({ message: msg });
  }

  const msg = await db.sessionMessage.create({
    data: {
      sessionId: id,
      role: role || 'user',
      content: content || '',
      status: status || 'complete',
      error: error || null,
      runId: runId || null,
    },
  });
  return NextResponse.json({ message: msg });
}
