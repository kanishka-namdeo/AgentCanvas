// POST /api/sessions/[id]/messages — add a message to a session
// GET  /api/sessions/[id]/messages — list messages

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureSession } from '../../ensure-session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const messages = await db.sessionMessage.findMany({
      where: { sessionId: id },
      orderBy: { createdAt: 'asc' },
      // Attachments ride along — the client's cross-device hydration maps
      // them back into AttachedImage data URLs (server-sync.fetchServerMessages).
      include: { attachments: true },
    });
    return NextResponse.json({ messages });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown database error';
    return NextResponse.json({ error: `Failed to list messages: ${message}` }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const { role, content, status, error, runId, messageId, documentId, diffSummary } = body;

  try {
    // If messageId is provided, update the existing message (streaming →
    // complete) — or create it if the server never saw the initial create
    // (upsert semantics; previously threw P2025 as an unhandled 500).
    if (messageId) {
      const msg = await db.sessionMessage.upsert({
        where: { id: messageId },
        update: {
          ...(content !== undefined ? { content } : {}),
          ...(status !== undefined ? { status } : {}),
          ...(error !== undefined ? { error } : {}),
          ...(diffSummary !== undefined ? { diffSummary } : {}),
        },
        create: {
          id: messageId,
          sessionId: id,
          role: role || 'user',
          content: content || '',
          status: status || 'complete',
          error: error || null,
          runId: runId || null,
          ...(diffSummary !== undefined ? { diffSummary } : {}),
        },
      });
      return NextResponse.json({ message: msg });
    }

    // Auto-heal: pre-fix localStorage sessions have no server row.
    const ensured = await ensureSession(id, documentId, body.title);
    if (!ensured) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
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
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown database error';
    return NextResponse.json({ error: `Failed to sync message: ${message}` }, { status: 500 });
  }
}
