// Plugin: background-tasks
//
// Durable background task execution. Inspired by pi-background-tasks but
// re-implemented natively (no child Pi processes — uses Node.js workers).
//
// Use case: "Generate 50 variations of this dashboard overnight" or
// "Audit every screen in the file." The agent enqueues a task; the task
// runs in the background (in a Node.js worker); the result is stored and
// surfaced to the user when complete.
//
// Tools:
//   background_enqueue   — enqueue a task (returns a task id immediately)
//   background_status    — check a task's status (pending / running / complete / failed)
//   background_result    — fetch a completed task's result
//   background_cancel    — cancel a pending or running task
//   background_list      — list all background tasks for the session

import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { emitEvent } from './event-bus';
import type { SyncEvent } from '../../canvas/types';

// ---- Task registry --------------------------------------------------------

interface BackgroundTask {
  id: string;
  taskType: string;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  enqueuedAt: number;
  completedAt?: number;
  result?: unknown;
  error?: string;
}

const sessionTasks = new Map<string, BackgroundTask[]>();
let activeSessionId = 'default';

export function setActiveSession(sessionId: string): void {
  activeSessionId = sessionId;
}

/// Get the status of a background task by id (for the /api/agent/background/[id]
/// route — the frontend polls this).
export function getBackgroundTaskStatus(taskId: string): BackgroundTask | null {
  // Search across all sessions (the frontend doesn't know the sessionId).
  for (const tasks of sessionTasks.values()) {
    const task = tasks.find((t) => t.id === taskId);
    if (task) return task;
  }
  return null;
}

function emitTaskStarted(task: BackgroundTask): void {
  emitEvent({
    type: 'agent:background_task_started',
    taskId: task.id,
    taskType: task.taskType,
    description: task.description,
  } satisfies SyncEvent);
}

function emitTaskComplete(task: BackgroundTask): void {
  emitEvent({
    type: 'agent:background_task_complete',
    taskId: task.id,
    success: task.status === 'completed',
    summary: task.status === 'completed' ? 'Task completed' : (task.error ?? 'Task failed'),
    result: task.result,
  } satisfies SyncEvent);
}

// ---- Task execution -------------------------------------------------------
//
// We don't actually spawn a Node.js worker here — the actual execution is
// performed by the /api/agent/background route (which can use whichever
// runtime the deployment supports — in-process, worker_threads, child_process,
// or an external queue like BullMQ). This plugin is the AGENT-FACING API;
// the route is the EXECUTOR.
//
// The agent calls background_enqueue → we emit a "task_started" event and
// return the task id. The frontend polls /api/agent/background/<id> for
// status. When the task completes, the executor calls our registerTaskComplete()
// to update the registry and emit a "task_complete" event.

export function registerTaskComplete(taskId: string, success: boolean, result: unknown, error?: string): void {
  const tasks = sessionTasks.get(activeSessionId) ?? [];
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return;
  task.status = success ? 'completed' : 'failed';
  task.completedAt = Date.now();
  task.result = result;
  task.error = error;
  emitTaskComplete(task);
}

// ---- Tools ----------------------------------------------------------------

const backgroundEnqueueTool = defineTool({
  name: 'background_enqueue',
  label: 'Enqueue Background Task',
  description:
    'Enqueue a task to run in the background. Returns immediately with a task id; the task runs asynchronously. Use for long-running jobs (e.g. "generate 50 variations", "audit every screen"). The frontend polls for status; you can call background_status to check progress.',
  promptSnippet: 'Enqueue a long-running task to run in the background.',
  promptGuidelines: [
    'Use background_enqueue for jobs that will take more than ~30 seconds.',
    'Pass a clear taskType (e.g. "generate_variations", "audit_screens") and description.',
    'The payload is a JSON object that the background executor will use to run the task.',
    'After enqueuing, you can continue with other work — poll background_status periodically to check progress.',
  ],
  parameters: Type.Object({
    taskType: Type.String({ description: 'A short task type identifier (e.g. "generate_variations", "audit_screens")' }),
    description: Type.String({ description: 'Human-readable description of the task' }),
    payload: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: 'Task-specific arguments as a JSON object' })),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const typed = params as { taskType: string; description: string; payload?: Record<string, unknown> };
    // D8 (2026-09-05 depth pass) — HONEST FAILURE at the source. This
    // deployment has no background executor (registerTaskComplete has no
    // production caller, /api/agent/background/[id] is status-only), so an
    // enqueued task can never leave 'pending': the pre-D8 tool result
    // claimed "the frontend will start the executor", the model told the
    // user the task was running, and the task list rendered a spinner
    // forever. Registering + failing immediately keeps the bookkeeping
    // honest (the attempt is visible, terminally) while the tool result
    // tells the model to do the work inline with the regular design tools.
    const task: BackgroundTask = {
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      taskType: typed.taskType,
      description: typed.description,
      status: 'pending',
      enqueuedAt: Date.now(),
    };
    const tasks = sessionTasks.get(activeSessionId) ?? [];
    tasks.push(task);
    sessionTasks.set(activeSessionId, tasks);
    emitTaskStarted(task);
    task.status = 'failed';
    task.error = 'No background executor is configured in this deployment.';
    task.completedAt = Date.now();
    emitTaskComplete(task);
    return {
      content: [{
        type: 'text',
        text:
          `No background executor is configured in this deployment, so "${typed.description}" was NOT started. ` +
          'Do the work inline with the regular design tools instead — it is fine to spread it across multiple tool calls. Do not retry background_enqueue.',
      }],
      details: { taskId: task.id, taskType: task.taskType, started: false, reason: 'no_executor' },
      isError: true,
    };
  },
});

const backgroundStatusTool = defineTool({
  name: 'background_status',
  label: 'Check Background Task Status',
  description: 'Check the status of a background task. Returns pending / running / completed / failed / cancelled.',
  promptSnippet: 'Check the status of a background task.',
  promptGuidelines: ['Poll background_status periodically after enqueuing a task.'],
  parameters: Type.Object({
    taskId: Type.String(),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const typed = params as { taskId: string };
    const tasks = sessionTasks.get(activeSessionId) ?? [];
    const task = tasks.find((t) => t.id === typed.taskId);
    if (!task) {
      return { content: [{ type: 'text', text: `Error: no task with id "${typed.taskId}".` }], details: { error: 'not_found' } };
    }
    const elapsed = task.completedAt ? task.completedAt - task.enqueuedAt : Date.now() - task.enqueuedAt;
    return {
      content: [{ type: 'text', text: `Task "${task.description}" [${task.id}]: ${task.status.toUpperCase()} (${(elapsed / 1000).toFixed(1)}s elapsed)` }],
      details: { status: task.status, elapsedMs: elapsed },
    };
  },
});

const backgroundResultTool = defineTool({
  name: 'background_result',
  label: 'Get Background Task Result',
  description: 'Fetch the result of a completed background task. Returns an error if the task is not yet complete.',
  promptSnippet: 'Get the result of a completed background task.',
  promptGuidelines: [
    'Call background_result only after background_status returns "completed".',
    'The result is a JSON object — task-type-specific.',
  ],
  parameters: Type.Object({
    taskId: Type.String(),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const typed = params as { taskId: string };
    const tasks = sessionTasks.get(activeSessionId) ?? [];
    const task = tasks.find((t) => t.id === typed.taskId);
    if (!task) {
      return { content: [{ type: 'text', text: `Error: no task with id "${typed.taskId}".` }], details: { error: 'not_found' } };
    }
    if (task.status !== 'completed' && task.status !== 'failed') {
      return { content: [{ type: 'text', text: `Error: task is still ${task.status}. Call background_status to check.` }], details: { status: task.status } };
    }
    const resultStr = task.result !== undefined ? JSON.stringify(task.result, null, 2).slice(0, 5000) : '(no result)';
    return {
      content: [{ type: 'text', text: `Result of "${task.description}":\n${resultStr}${task.error ? `\n\nError: ${task.error}` : ''}` }],
      details: { status: task.status, result: task.result, error: task.error },
    };
  },
});

const backgroundCancelTool = defineTool({
  name: 'background_cancel',
  label: 'Cancel Background Task',
  description: 'Cancel a pending or running background task.',
  promptSnippet: 'Cancel a background task.',
  promptGuidelines: ['Call background_cancel to stop a task that\'s no longer needed.'],
  parameters: Type.Object({
    taskId: Type.String(),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const typed = params as { taskId: string };
    const tasks = sessionTasks.get(activeSessionId) ?? [];
    const task = tasks.find((t) => t.id === typed.taskId);
    if (!task) {
      return { content: [{ type: 'text', text: `Error: no task with id "${typed.taskId}".` }], details: { error: 'not_found' } };
    }
    if (task.status === 'completed' || task.status === 'failed') {
      return { content: [{ type: 'text', text: `Task already ${task.status} — cannot cancel.` }], details: { status: task.status } };
    }
    task.status = 'cancelled';
    task.completedAt = Date.now();
    emitTaskComplete(task);
    return { content: [{ type: 'text', text: `Task "${task.description}" cancelled.` }], details: { status: task.status } };
  },
});

const backgroundListTool = defineTool({
  name: 'background_list',
  label: 'List Background Tasks',
  description: 'List all background tasks for the current session with their statuses.',
  promptSnippet: 'List all background tasks.',
  promptGuidelines: ['Call background_list to see all tasks.'],
  parameters: Type.Object({}),
  async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
    const tasks = sessionTasks.get(activeSessionId) ?? [];
    if (tasks.length === 0) {
      return { content: [{ type: 'text', text: 'No background tasks.' }], details: { count: 0 } };
    }
    const lines = tasks.map((t) => {
      const elapsed = t.completedAt ? t.completedAt - t.enqueuedAt : Date.now() - t.enqueuedAt;
      return `${t.status.padEnd(10)} [${t.id}] ${t.description} (${(elapsed / 1000).toFixed(1)}s)`;
    });
    return { content: [{ type: 'text', text: lines.join('\n') }], details: { count: tasks.length } };
  },
});

export const tools = [backgroundEnqueueTool, backgroundStatusTool, backgroundResultTool, backgroundCancelTool, backgroundListTool];
