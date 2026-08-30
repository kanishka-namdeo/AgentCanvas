// plan-gate.ts — plan-mode approval gate (Claude Code ExitPlanMode / Cursor
// Plan-mode "Build" button adaptation).
//
// In PLAN mode the agent researches the canvas, optionally asks clarifying
// questions, then calls `submit_plan` with a structured plan. This module is
// the server-side half of the approval handshake (the approval-gate pattern,
// plugins/approval-gate.ts — same pending-map + resolve route + timeout):
//
//   1. `submitPlanProposal()` emits `agent:plan_proposed` (the frontend
//      renders the PlanApprovalCard with the approval triad) and BLOCKS until
//      the user decides via POST /api/agent/plans.
//   2. decision 'build'  → the runner swaps to a build-toolset session and
//      executes the approved plan verbatim.
//   3. decision 'revise' → the feedback returns as the submit_plan tool
//      result; the SAME session continues and revises (multi-round works —
//      the model simply calls submit_plan again with a new planId).
//   4. timeout (10 min)  → resolves as 'timeout' — the tool result tells the
//      model to wrap up with its best plan as text.
//
// While blocked, the tool's onUpdate heartbeat feeds the route's stream
// watchdog (same defense as pen_generate_variants) so an unattended gate
// never looks like a hung stream.

import { emitEvent } from './plugins/event-bus';

export interface PlanStep {
  step: number;
  description: string;
}

export interface PlanProposalInput {
  /// Unique id for this proposal (the submit_plan toolCallId).
  planId: string;
  title: string;
  summary: string;
  steps: PlanStep[];
  /// Open questions the agent resolved with stated assumptions.
  openQuestions?: string[];
}

export interface PlanDecision {
  decision: 'build' | 'revise' | 'timeout';
  /// User feedback when decision === 'revise' ("keep planning" with notes).
  feedback?: string;
}

interface PendingPlan {
  resolve: (d: PlanDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingPlans = new Map<string, PendingPlan>();

/// Generous window: plan review is a human-in-the-loop read (the user may be
/// reading a 6-step plan carefully). The submit_plan tool's heartbeat keeps
/// the stream watchdog fed for the whole window.
export const PLAN_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

/// Emit the proposal event and block until the user decides (or timeout).
/// Timeout resolves as 'timeout' — the caller translates that into a
/// "wrap up as text" tool result (never a hang).
export function submitPlanProposal(proposal: PlanProposalInput): Promise<PlanDecision> {
  return new Promise((resolve) => {
    emitEvent({
      type: 'agent:plan_proposed',
      planId: proposal.planId,
      title: proposal.title,
      summary: proposal.summary,
      steps: proposal.steps,
      ...(proposal.openQuestions && proposal.openQuestions.length > 0
        ? { openQuestions: proposal.openQuestions }
        : {}),
    });
    const timer = setTimeout(() => {
      pendingPlans.delete(proposal.planId);
      resolve({ decision: 'timeout' });
    }, PLAN_APPROVAL_TIMEOUT_MS);
    pendingPlans.set(proposal.planId, { resolve, timer });
  });
}

/// Resolve (or time out) a pending plan. Safe for unknown ids (no-op).
/// Called by POST /api/agent/plans. Also emits the fan-out event so OTHER
/// viewers' cards settle (same pattern as agent:approval_resolved).
export function resolvePlanProposal(planId: string, decision: 'build' | 'revise', feedback?: string): void {
  const p = pendingPlans.get(planId);
  if (!p) return;
  clearTimeout(p.timer);
  pendingPlans.delete(planId);
  p.resolve({ decision, feedback });
  emitEvent({ type: 'agent:plan_resolved', planId, decision, ...(feedback ? { feedback } : {}) });
}

/// Pending plan ids (diagnostics / polling).
export function getPendingPlanProposals(): string[] {
  return Array.from(pendingPlans.keys());
}

// ---- Approved-plan handoff (runner consumption) ------------------------------
//
// The submit_plan TOOL sees the decision, but the RUNNER (a different stack
// frame) must learn "the user approved — run the execution phase". Rather
// than process-global listeners (clobber risk under concurrent runs), the
// tool records the approved plan with a timestamp; the runner consumes any
// approval NEWER than its own run start (stale approvals from previous runs
// are ignored) and clears the slot.

let lastApprovedPlan: { plan: PlanProposalInput; resolvedAt: number } | null = null;

/// Called by the submit_plan tool when the user clicks "Build it".
export function recordApprovedPlan(plan: PlanProposalInput): void {
  lastApprovedPlan = { plan, resolvedAt: Date.now() };
}

/// Called by the runner after the planning session drains. Returns (and
/// clears) the approved plan IF it was approved after `runStartedAt`;
/// otherwise null. Single-shot: a consumed plan can't re-trigger.
export function consumeApprovedPlan(runStartedAt: number): PlanProposalInput | null {
  if (lastApprovedPlan && lastApprovedPlan.resolvedAt >= runStartedAt) {
    const plan = lastApprovedPlan.plan;
    lastApprovedPlan = null;
    return plan;
  }
  return null;
}

/// Test helper — clear all pending plans + their timers + the approval slot.
export function resetPlanGate(): void {
  for (const p of pendingPlans.values()) clearTimeout(p.timer);
  pendingPlans.clear();
  lastApprovedPlan = null;
}
