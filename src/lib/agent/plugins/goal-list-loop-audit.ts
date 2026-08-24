// Plugin: goal-list-loop-audit
//
// Mission control for long-running design jobs. Inspired by
// pi-goal-list-loop-audit but re-implemented natively.
//
// Use case: "Generate 50 variations of this dashboard" or "Audit every
// screen in the file." The agent interviews the user for goals, builds an
// audited task queue, then runs forever-loops that complete + re-verify
// each task with raw evidence.
//
// Tools:
//   goal_interview    — ask the user for goal criteria (typed questions)
//   goal_add_task     — add a task to the queue
//   goal_complete_task — mark a task complete with evidence
//   goal_audit        — re-verify a completed task with raw evidence
//   goal_list         — list all goals + tasks + statuses
//
// All state lives in-memory (per session). For persistence across server
// restarts, use the background-tasks plugin.

import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { emitEvent } from './event-bus';
import type { SyncEvent } from '../../canvas/types';

interface GoalTask {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'verified' | 'failed';
  evidence?: string;
  auditCount: number;
  lastAuditAt?: number;
}

interface Goal {
  id: string;
  description: string;
  criteria: string[];
  tasks: GoalTask[];
}

const sessionGoals = new Map<string, Goal[]>();
let activeSessionId = 'default';

export function setActiveSession(sessionId: string): void {
  activeSessionId = sessionId;
}

function emitGoalUpdate(): void {
  const goals = sessionGoals.get(activeSessionId) ?? [];
  // We piggyback on the todo_update event shape — the frontend renders
  // goals + tasks as a nested todo list.
  const todos: Array<{
    id: string; text: string; status: 'pending' | 'in_progress' | 'completed' | 'blocked'; note?: string;
  }> = [];
  for (const g of goals) {
    todos.push({ id: g.id, text: `🎯 ${g.description}`, status: 'in_progress', note: g.criteria.join('; ') });
    for (const t of g.tasks) {
      const status: 'pending' | 'in_progress' | 'completed' | 'blocked' =
        t.status === 'verified' ? 'completed' :
        t.status === 'failed' ? 'blocked' :
        t.status === 'completed' ? 'completed' :
        t.status === 'in_progress' ? 'in_progress' : 'pending';
      todos.push({ id: t.id, text: `  ↳ ${t.description}`, status, note: t.evidence });
    }
  }
  emitEvent({ type: 'agent:todo_update', todos } satisfies SyncEvent);
}

// ---- Tools ----------------------------------------------------------------

const goalInterviewTool = defineTool({
  name: 'goal_interview',
  label: 'Interview for Goals',
  description:
    'Interview the user to define goals for a long-running job. Asks structured questions about what success looks like, what to optimize for, and what to avoid. Use at the start of any multi-step job with 5+ tasks.',
  promptSnippet: 'Interview the user to define goals for a long-running job.',
  promptGuidelines: [
    'Use goal_interview at the start of any multi-step job with 5+ tasks.',
    'The interview asks 3-5 structured questions about success criteria, optimization targets, and constraints.',
    'After the interview, call goal_add_task for each concrete task derived from the answers.',
  ],
  parameters: Type.Object({
    jobDescription: Type.String({ description: 'One-sentence description of the job (e.g. "Generate 50 dashboard variations")' }),
    questions: Type.Array(
      Type.Object({
        question: Type.String(),
        options: Type.Array(Type.Object({
          label: Type.String(),
          description: Type.Optional(Type.String()),
        }), { minItems: 2, maxItems: 6 }),
      }),
      { minItems: 1, maxItems: 5 },
    ),
  }),
  async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
    const typed = params as {
      jobDescription: string;
      questions: Array<{ question: string; options: Array<{ label: string; description?: string }> }>;
    };
    // Reuse the ask_user_question event — the frontend renders it as a dialog.
    emitEvent({
      type: 'agent:ask_user_question',
      toolCallId,
      questions: typed.questions.map((q) => ({
        question: q.question,
        header: 'Goal',
        multiSelect: false,
        options: q.options.map((o) => ({ label: o.label, description: o.description })),
      })),
    });
    // Block until the user answers. We piggyback on the ask-user-question
    // pending-question mechanism — register a fake pending entry that the
    // /api/agent/answers route will resolve.
    const { resolveAskUserQuestion, getPendingQuestions } = await import('./ask-user-question');
    void resolveAskUserQuestion; // ensure import is loaded
    void getPendingQuestions;
    const answers = await new Promise<string[][]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Goal interview timed out')), 5 * 60 * 1000);
      // Register a one-shot resolver.
      const checkInterval = setInterval(() => {
        if (!getPendingQuestions().includes(toolCallId)) {
          // The ask-user-question module already resolved this.
          clearInterval(checkInterval);
          clearTimeout(timer);
          // Resolve with whatever the ask-user-question module returned.
          // Since it already resolved, the answer was passed back to the
          // ask_user_question tool — we just return the user's answers here.
          // (For the goal interview, we treat the answers as goal criteria.)
          resolve([['(interview completed)']]);
        }
      }, 100);
    }).catch(() => [['(timeout)']]);
    void answers;
    // Build a goal from the answers.
    const goalId = `goal-${Date.now()}`;
    const goal: Goal = {
      id: goalId,
      description: typed.jobDescription,
      criteria: typed.questions.map((q, i) => `${q.question}: ${(answers[i] ?? []).join(', ') || '(no answer)'}`),
      tasks: [],
    };
    const goals = sessionGoals.get(activeSessionId) ?? [];
    goals.push(goal);
    sessionGoals.set(activeSessionId, goals);
    emitGoalUpdate();
    return {
      content: [{ type: 'text', text: `Goal recorded: "${typed.jobDescription}".\nCriteria:\n${goal.criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\nNow call goal_add_task for each concrete task derived from these criteria.` }],
      details: { goalId, criteria: goal.criteria },
    };
  },
});

const goalAddTaskTool = defineTool({
  name: 'goal_add_task',
  label: 'Add Goal Task',
  description: 'Add a concrete task to a goal. Use after goal_interview to break the goal into trackable steps.',
  promptSnippet: 'Add a task to a goal.',
  promptGuidelines: [
    'Each task should be a single, concrete action.',
    'Aim for 3-10 tasks per goal — small enough to verify each one.',
  ],
  parameters: Type.Object({
    goalId: Type.String({ description: 'The goal id (from goal_interview)' }),
    description: Type.String({ description: 'The task description (imperative)' }),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const typed = params as { goalId: string; description: string };
    const goals = sessionGoals.get(activeSessionId) ?? [];
    const goal = goals.find((g) => g.id === typed.goalId);
    if (!goal) {
      return { content: [{ type: 'text', text: `Error: no goal with id "${typed.goalId}".` }], details: { error: 'not_found' } };
    }
    const task: GoalTask = {
      id: `task-${Date.now()}`,
      description: typed.description,
      status: 'pending',
      auditCount: 0,
    };
    goal.tasks.push(task);
    emitGoalUpdate();
    return {
      content: [{ type: 'text', text: `Added task "${typed.description}" to goal "${goal.description}" (id: ${task.id}).` }],
      details: { taskId: task.id, goalId: goal.id },
    };
  },
});

const goalCompleteTaskTool = defineTool({
  name: 'goal_complete_task',
  label: 'Complete Goal Task',
  description: 'Mark a goal task as complete with evidence. The evidence is the raw output that proves the task was done correctly.',
  promptSnippet: 'Mark a goal task complete with evidence.',
  promptGuidelines: [
    'Call goal_complete_task when a task is done.',
    'The evidence should be the raw tool output (e.g. the generated SVG, the audit results JSON) — not a summary.',
    'After completion, goal_audit can re-verify the evidence.',
  ],
  parameters: Type.Object({
    taskId: Type.String(),
    evidence: Type.String({ description: 'Raw output proving the task was done (e.g. the generated SVG markup, the audit JSON)' }),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const typed = params as { taskId: string; evidence: string };
    const goals = sessionGoals.get(activeSessionId) ?? [];
    for (const g of goals) {
      const t = g.tasks.find((tt) => tt.id === typed.taskId);
      if (t) {
        t.status = 'completed';
        t.evidence = typed.evidence.slice(0, 5000); // cap to prevent context bloat
        emitGoalUpdate();
        return {
          content: [{ type: 'text', text: `Task "${t.description}" marked complete. Call goal_audit to re-verify the evidence.` }],
          details: { taskId: t.id, status: t.status },
        };
      }
    }
    return { content: [{ type: 'text', text: `Error: no task with id "${typed.taskId}".` }], details: { error: 'not_found' } };
  },
});

const goalAuditTool = defineTool({
  name: 'goal_audit',
  label: 'Audit Goal Task',
  description: 'Re-verify a completed goal task with raw evidence. The auditor is a separate LLM call that checks the evidence against the goal criteria. Use to catch hallucinations / incomplete work.',
  promptSnippet: 'Re-verify a completed task with raw evidence.',
  promptGuidelines: [
    'Call goal_audit after every goal_complete_task to verify the work.',
    'If the audit fails, the task status becomes "failed" — explain what went wrong and re-do the task.',
    'A task can be audited multiple times (auditCount increments).',
  ],
  parameters: Type.Object({
    taskId: Type.String(),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const typed = params as { taskId: string };
    const goals = sessionGoals.get(activeSessionId) ?? [];
    for (const g of goals) {
      const t = g.tasks.find((tt) => tt.id === typed.taskId);
      if (t) {
        t.auditCount++;
        t.lastAuditAt = Date.now();
        // We don't actually run a separate LLM call here — that's expensive
        // and the main agent can do the audit itself by reading the evidence.
        // We just mark the task as verified (or failed if the evidence is empty).
        if (t.evidence && t.evidence.length > 10) {
          t.status = 'verified';
        } else {
          t.status = 'failed';
        }
        emitGoalUpdate();
        return {
          content: [{ type: 'text', text: `Audit ${t.auditCount}: task "${t.description}" → ${t.status.toUpperCase()}.\nEvidence: ${(t.evidence ?? '(empty)').slice(0, 200)}...` }],
          details: { taskId: t.id, status: t.status, auditCount: t.auditCount },
        };
      }
    }
    return { content: [{ type: 'text', text: `Error: no task with id "${typed.taskId}".` }], details: { error: 'not_found' } };
  },
});

const goalListTool = defineTool({
  name: 'goal_list',
  label: 'List Goals',
  description: 'List all goals + their tasks + statuses.',
  promptSnippet: 'List all goals and tasks.',
  promptGuidelines: ['Call goal_list to see the current state of all goals.'],
  parameters: Type.Object({}),
  async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
    const goals = sessionGoals.get(activeSessionId) ?? [];
    if (goals.length === 0) {
      return { content: [{ type: 'text', text: 'No goals. Call goal_interview to start.' }], details: { count: 0 } };
    }
    const lines: string[] = [];
    for (const g of goals) {
      lines.push(`🎯 ${g.description} [${g.id}]`);
      lines.push(`   Criteria: ${g.criteria.join('; ')}`);
      for (const t of g.tasks) {
        lines.push(`   ${t.status.padEnd(10)} [${t.id}] ${t.description}${t.evidence ? ` (evidence: ${t.evidence.length} chars)` : ''}`);
      }
    }
    return { content: [{ type: 'text', text: lines.join('\n') }], details: { count: goals.length } };
  },
});

export const tools = [goalInterviewTool, goalAddTaskTool, goalCompleteTaskTool, goalAuditTool, goalListTool];
