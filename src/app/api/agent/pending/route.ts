// GET /api/agent/pending
//
// Returns the list of currently-pending ask_user_question toolCallIds.
// The frontend polls this on reconnect to see if there are any unanswered
// questions waiting (e.g. if the user closed the tab during a turn).

import { getPendingQuestions } from '@/lib/agent/plugins/ask-user-question';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return new Response(JSON.stringify({ pending: getPendingQuestions() }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
