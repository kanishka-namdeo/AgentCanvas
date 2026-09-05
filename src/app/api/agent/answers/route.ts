// POST /api/agent/answers
//
// Resolves a pending ask_user_question tool call. The frontend POSTs the
// user's answers here when they submit the questionnaire dialog.
//
// Body: { toolCallId: string, answers: string[][], cancelled: boolean }
//   - toolCallId: the id from the agent:ask_user_question event
//   - answers: outer array = questions, inner array = selected option labels
//       (multi-select questions may have multiple labels)
//   - cancelled: true if the user dismissed the dialog without answering

import { NextRequest } from 'next/server';
import { resolveAskUserQuestion, hasPendingQuestion } from '@/lib/agent/plugins/ask-user-question';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const toolCallId: string = body.toolCallId ?? '';
  const answers: string[][] = Array.isArray(body.answers) ? body.answers : [];
  const cancelled: boolean = body.cancelled === true;

  if (!toolCallId) {
    return new Response(JSON.stringify({ error: 'toolCallId is required' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  // D1 (2026-09-05 depth pass): an unknown toolCallId means the question
  // already resolved (timed out, answered by another viewer, or a stale
  // replay). 200-ok here was a silent no-op the user believed was delivered.
  if (!hasPendingQuestion(toolCallId)) {
    return new Response(
      JSON.stringify({ error: 'not_pending', toolCallId, note: 'The question already resolved (timed out or answered by another viewer).' }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    );
  }

  resolveAskUserQuestion(toolCallId, answers, cancelled);

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
