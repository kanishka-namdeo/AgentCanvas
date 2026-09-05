// POST /api/agent/plans
//
// Resolves a pending PLAN-mode approval gate (see lib/agent/plan-gate.ts —
// the approval-gate pattern). The frontend POSTs the user's decision here
// when they click "Build it" / "Keep planning" on the PlanApprovalCard.
//
// Body: { planId: string, decision: 'build' | 'revise', feedback?: string }
//   - planId:    the id from the agent:plan_proposed event
//   - decision:  'build'  → approve: the runner swaps to a build-toolset
//                session and executes the plan verbatim.
//                'revise' → keep planning: the feedback returns to the agent
//                as the submit_plan tool result; it revises and re-submits.
//   - feedback:  revision notes (required for 'revise'; ignored for 'build').
//
// Mirrors /api/agent/approvals (the destructive-op gate resolver) — same
// module-level pending registry, same idempotent no-op for unknown ids
// (already resolved / timed out / from a stale reconnect replay).
//
// GET /api/agent/plans — diagnostics twin of GET /api/agent/pending:
// returns the currently-pending plan ids so a reconnecting client (or a
// debug session) can see whether a PlanApprovalCard is still awaiting a
// decision (e.g. the user closed the tab mid-review).

import { NextRequest } from 'next/server';
import { getPendingPlanProposals, resolvePlanProposal, hasPendingPlan } from '@/lib/agent/plan-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return new Response(JSON.stringify({ pending: getPendingPlanProposals() }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const planId: string = typeof body.planId === 'string' ? body.planId : '';
  const decision: 'build' | 'revise' | null =
    body.decision === 'build' ? 'build' : body.decision === 'revise' ? 'revise' : null;
  const feedback: string | undefined =
    typeof body.feedback === 'string' && body.feedback.trim() ? body.feedback.trim().slice(0, 4000) : undefined;

  if (!planId) {
    return new Response(JSON.stringify({ error: 'planId is required' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (!decision) {
    return new Response(JSON.stringify({ error: "decision must be 'build' or 'revise'" }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (decision === 'revise' && !feedback) {
    return new Response(JSON.stringify({ error: 'feedback is required when keeping the plan in revision' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  // D1 (2026-09-05 depth pass): an unknown planId means the gate already
  // resolved (timeout wrapped it up, another viewer decided, or a stale
  // replay). 200-ok made a post-timeout "Build it" silently no-op while the
  // runner moved on — 409 lets the client report it honestly.
  if (!hasPendingPlan(planId)) {
    return new Response(
      JSON.stringify({ error: 'not_pending', planId, note: 'The plan already resolved (timed out or decided by another viewer).' }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    );
  }

  resolvePlanProposal(planId, decision, feedback);

  return new Response(
    JSON.stringify({ ok: true, planId, decision }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}
