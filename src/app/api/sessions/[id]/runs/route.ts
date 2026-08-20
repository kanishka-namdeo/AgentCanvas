// POST /api/sessions/[id]/runs — create a run
// PATCH /api/sessions/[id]/runs/[runId] — update run status

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const { prompt, status, runId } = body;

  // If runId is provided, update existing run.
  if (runId) {
    const run = await db.sessionRun.update({
      where: { id: runId },
      data: {
        ...(status !== undefined ? { status } : {}),
        ...(body.errorMessage !== undefined ? { errorMessage: body.errorMessage } : {}),
        ...(body.toolCallCount !== undefined ? { toolCallCount: body.toolCallCount } : {}),
        ...(body.toolCalls !== undefined ? { toolCalls: JSON.stringify(body.toolCalls) } : {}),
      },
    });
    return NextResponse.json({ run });
  }

  const run = await db.sessionRun.create({
    data: {
      sessionId: id,
      prompt: prompt || '',
      status: status || 'in_progress',
    },
  });

  // Increment the session's run count.
  await db.session.update({
    where: { id },
    data: { runCount: { increment: 1 }, lastOpenedAt: new Date().toISOString() },
  });

  return NextResponse.json({ run });
}
