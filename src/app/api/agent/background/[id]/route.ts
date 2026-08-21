// GET /api/agent/background/[id]
//
// Returns the status of a background task. The frontend polls this to update
// the task list UI.

import { NextRequest } from 'next/server';
import { getBackgroundTaskStatus } from '@/lib/agent/plugins/background-tasks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const status = getBackgroundTaskStatus(id);
  if (!status) {
    return new Response(JSON.stringify({ error: 'task not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(JSON.stringify(status), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
