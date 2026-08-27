// POST /api/agent/approvals
//
// Resolves a pending destructive-operation approval gate (see
// lib/agent/plugins/approval-gate.ts). The frontend POSTs the user's
// decision here when they click Allow / Deny in the approval dialog.
//
// Body: { toolCallId: string, approved: boolean, alwaysAllow?: boolean }
//   - toolCallId:  the id from the agent:approval_request event
//   - approved:    true → run the gated tool; false → return a denial result
//   - alwaysAllow: when true AND approved is true, the tool is added to the
//     server-side always-allow set (the runner's gate short-circuits future
//     calls for this tool without showing the dialog). The frontend persists
//     the same tool name in settings.alwaysAllowTools so the preference
//     survives server restart.
//
// Mirrors /api/agent/answers (the ask_user_question resolver) — same
// module-level pending registry, same idempotent no-op for unknown ids.

import { NextRequest } from 'next/server';
import {
  resolveApproval,
  addAlwaysAllow,
  getPendingToolName,
} from '@/lib/agent/plugins/approval-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const toolCallId: string = body.toolCallId ?? '';
  const approved: boolean = body.approved === true;
  const alwaysAllow: boolean = body.alwaysAllow === true;

  if (!toolCallId) {
    return new Response(JSON.stringify({ error: 'toolCallId is required' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Resolve the pending approval FIRST so the runner can proceed. Then, if
  // the user opted into "always allow", look up the toolName (still in the
  // pending entry up until resolveApproval clears it... wait, it clears
  // first). Lookup BEFORE resolving.
  const toolName = alwaysAllow ? getPendingToolName(toolCallId) : undefined;

  resolveApproval(toolCallId, approved);

  // Persist to the in-memory allow-set so future requestApproval calls for
  // this tool short-circuit. Only meaningful when approved is true (denying
  // + always-allow would be a contradiction; we silently ignore it).
  let addedTool: string | undefined;
  if (alwaysAllow && approved && toolName) {
    addAlwaysAllow(toolName);
    addedTool = toolName;
  }

  return new Response(
    JSON.stringify({ ok: true, toolCallId, approved, addedTool }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}
