// POST /api/agent/approvals
//
// Resolves a pending destructive-operation approval gate (see
// lib/agent/plugins/approval-gate.ts). The frontend POSTs the user's
// decision here when they click Allow / Deny in the approval dialog.
//
// Body: { toolCallId: string, approved: boolean }
//   - toolCallId: the id from the agent:approval_request event
//   - approved:   true → run the gated tool; false → return a denial result
//
// Mirrors /api/agent/answers (the ask_user_question resolver) — same
// module-level pending registry, same idempotent no-op for unknown ids.

import { NextRequest } from 'next/server';
import { resolveApproval } from '@/lib/agent/plugins/approval-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const toolCallId: string = body.toolCallId ?? '';
  const approved: boolean = body.approved === true;

  if (!toolCallId) {
    return new Response(JSON.stringify({ error: 'toolCallId is required' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  resolveApproval(toolCallId, approved);

  return new Response(JSON.stringify({ ok: true, toolCallId, approved }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
