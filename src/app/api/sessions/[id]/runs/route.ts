// POST /api/sessions/[id]/runs — create a run (or update when runId is passed)

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureSession } from '../../ensure-session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const { prompt, status, runId, documentId } = body;

  try {
    // If runId is provided, update the existing run — or create it if the
    // server never saw the create call (upsert semantics; previously this
    // threw P2025 "record not found" as an unhandled 500).
    if (runId) {
      const run = await db.sessionRun.upsert({
        where: { id: runId },
        update: {
          ...(status !== undefined ? { status } : {}),
          ...(body.errorMessage !== undefined ? { errorMessage: body.errorMessage } : {}),
          ...(body.toolCallCount !== undefined ? { toolCallCount: body.toolCallCount } : {}),
          ...(body.toolCalls !== undefined ? { toolCalls: JSON.stringify(body.toolCalls) } : {}),
        },
        create: {
          id: runId,
          sessionId: id,
          prompt: prompt || '',
          status: status || 'in_progress',
          ...(body.errorMessage !== undefined ? { errorMessage: body.errorMessage } : {}),
          ...(body.toolCallCount !== undefined ? { toolCallCount: body.toolCallCount } : {}),
          ...(body.toolCalls !== undefined ? { toolCalls: JSON.stringify(body.toolCalls) } : {}),
        },
      });
      return NextResponse.json({ run });
    }

    // Auto-heal: pre-fix localStorage sessions have no server row. If the
    // client tells us which document this belongs to, create the shell.
    const ensured = await ensureSession(id, documentId, body.title);
    if (!ensured) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    const run = await db.sessionRun.create({
      data: {
        sessionId: id,
        prompt: prompt || '',
        status: status || 'in_progress',
      },
    });

    // Increment the session's run count (updateMany: no-op if the shell row
    // was just created concurrently rather than the increment racing).
    await db.session.update({
      where: { id },
      data: { runCount: { increment: 1 }, lastOpenedAt: new Date().toISOString() },
    });

    return NextResponse.json({ run });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown database error';
    return NextResponse.json({ error: `Failed to sync run: ${message}` }, { status: 500 });
  }
}
