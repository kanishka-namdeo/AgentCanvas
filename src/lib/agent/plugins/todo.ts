// Plugin: todo
//
// A task list overlay the agent updates during a turn. Inspired by
// @juicesharp/rpiv-todo but re-implemented for the web (no TUI overlay).
//
// Tools:
//   todo_create  — start a new todo list (replaces any existing one)
//   todo_update  — BATCH-update todo statuses (auto-advance: marking a step
//                  in_progress auto-completes the previous in_progress step)
//   todo_add     — add a new todo to the list
//   todo_remove  — remove a todo by id
//   todo_list    — list all todos (for the agent to read)
//
// VLM-exercise finding (perf-pass tap analysis): 13-15 of 31 tool calls on
// some turns were todo bookkeeping — the model transitioned statuses ONE
// CALL AT A TIME (5-7 todo_updates in a row), each a full ~10s LLM round
// trip that produced zero canvas progress. The fix is structural, not
// prompt-only:
//   1. todo_update accepts a BATCH of transitions — "mark steps 1-3 done
//      and step 4 in_progress" is ONE call.
//   2. WIP=1 auto-advance — setting a step in_progress implicitly completes
//      every other in_progress step, so per step the model needs at most one
//      update, not two.
//   3. Every mutation returns the FULL list state — no todo_list read-backs.
//
// Each mutation emits an `agent:todo_update` SyncEvent so the frontend's
// AgentPanel can re-render the live list. The list persists across
// compaction (it's stored as a separate tool-call-side channel, not in the
// message history).

import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { emitEvent } from './event-bus';
import type { SyncEvent } from '../../canvas/types';

// ---- Per-session todo state -----------------------------------------------
//
// One todo list per session. The runner sets the sessionId at the start
// of each turn via `setActiveSession(sessionId)`.

interface TodoItem {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  note?: string;
}

const sessionTodos = new Map<string, TodoItem[]>();
let activeSessionId = 'default';

export function setActiveSession(sessionId: string): void {
  activeSessionId = sessionId;
}

export function getTodos(sessionId: string = activeSessionId): TodoItem[] {
  return sessionTodos.get(sessionId) ?? [];
}

/// Emit the current todo list as a SyncEvent — called after every mutation.
function emitTodoUpdate(): void {
  const todos = sessionTodos.get(activeSessionId) ?? [];
  emitEvent({
    type: 'agent:todo_update',
    todos: todos.map((t) => ({ id: t.id, text: t.text, status: t.status, note: t.note })),
  } satisfies SyncEvent);
}

/// Full list state — embedded in every mutation result so the model never
/// needs a todo_list read-back after writing.
function formatTodoList(todos: TodoItem[]): string {
  return todos
    .map((t, i) => `${i + 1}. [${t.status.padEnd(11)}] [${t.id}] ${t.text}${t.note ? ` — ${t.note}` : ''}`)
    .join('\n');
}

// ---- Tool definitions ------------------------------------------------------

const TodoStatusSchema = Type.Union([
  Type.Literal('pending'),
  Type.Literal('in_progress'),
  Type.Literal('completed'),
  Type.Literal('blocked'),
]);

const createTodoTool = defineTool({
  name: 'todo_create',
  label: 'Create Todo List',
  description:
    'Start a new todo list for the current turn. Replaces any existing list. ONLY for genuinely long tasks (5+ steps that will span 10+ tool calls) — a single pen_create_subtree request does NOT need a todo list. Each item should be a single, concrete action. Todo calls are bookkeeping: each costs a full round trip and produces no canvas progress — keep the whole turn under ~4 todo calls total.',
  promptSnippet: 'Create a todo list to track genuinely multi-step design tasks (5+ steps).',
  promptGuidelines: [
    'Call todo_create ONLY at the start of tasks with 5+ distinct steps spanning 10+ tool calls.',
    'SKIP the todo list entirely for single-subtree requests (one pen_create_subtree + a few tweaks).',
    'Each item should be a single, concrete action (e.g. "Create the header", "Apply color palette", "Add shadows to cards").',
    'After creating the list, advance it with BATCHED todo_update calls (auto-advance completes the previous step), never one call per transition.',
  ],
  parameters: Type.Object({
    items: Type.Array(
      Type.Object({
        text: Type.String({ description: 'The step description (imperative, e.g. "Create the header")' }),
        id: Type.Optional(Type.String({ description: 'Optional id (auto-generated if omitted)' })),
      }),
      { minItems: 1, maxItems: 20 },
    ),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const typed = params as { items: Array<{ text: string; id?: string }> };
    const todos: TodoItem[] = typed.items.map((item, i) => ({
      id: item.id ?? `todo-${Date.now()}-${i}`,
      text: item.text,
      status: 'pending' as const,
    }));
    sessionTodos.set(activeSessionId, todos);
    emitTodoUpdate();
    return {
      content: [{
        type: 'text',
        text:
          `Created ${todos.length}-item todo list:\n${formatTodoList(todos)}\n` +
          'Advance with ONE batched todo_update per step transition (auto-advance completes the previous in_progress step — you never need a separate "completed" call).',
      }],
      details: { todoIds: todos.map((t) => t.id) },
    };
  },
});

const updateTodoTool = defineTool({
  name: 'todo_update',
  label: 'Update Todo Status (batch)',
  description:
    'BATCH-update todo statuses — pass ALL pending transitions in ONE call (e.g. mark steps 1-2 completed and step 3 in_progress together). ' +
    'AUTO-ADVANCE: setting a step to in_progress automatically completes every other in_progress step (WIP=1), so you never need a separate "completed" call before moving on. ' +
    'NEVER call todo_update twice in a row — combine the transitions into one call. The result returns the full list state.',
  promptSnippet: 'Batch-update todo statuses; auto-advance completes the previous step.',
  promptGuidelines: [
    'Batch ALL status transitions into a single todo_update call — never one call per item.',
    'Marking a step in_progress auto-completes the previous in_progress step (WIP=1) — no separate "completed" call needed.',
    'Set status="blocked" with a note if you cannot complete a step.',
    'At most one todo call per step transition; todo calls should stay under a quarter of your total tool calls.',
  ],
  parameters: Type.Object({
    updates: Type.Array(
      Type.Object({
        id: Type.String({ description: 'The todo id (from todo_create / todo_add / the last todo result)' }),
        status: TodoStatusSchema,
        note: Type.Optional(Type.String({ description: 'Optional note (e.g. blocked reason)' })),
      }),
      { minItems: 1, maxItems: 20, description: 'ALL status transitions to apply in this one call.' },
    ),
    // Back-compat: the legacy single-item spelling {id, status, note} is
    // still accepted (normalized into a 1-element batch). The LLM sees the
    // batch schema above; the shim keeps old tests + stale transcripts
    // working.
    id: Type.Optional(Type.String({ description: 'Legacy single-item form — prefer updates[] instead.' })),
    status: Type.Optional(TodoStatusSchema),
    note: Type.Optional(Type.String({ description: 'Legacy single-item form note.' })),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const typed = params as {
      updates?: Array<{ id: string; status: TodoItem['status']; note?: string }>;
      id?: string;
      status?: TodoItem['status'];
      note?: string;
    };
    // Normalize legacy single-item form → batch.
    const batch: Array<{ id: string; status: TodoItem['status']; note?: string }> =
      Array.isArray(typed.updates) && typed.updates.length > 0
        ? typed.updates
        : typed.id && typed.status
          ? [{ id: typed.id, status: typed.status, note: typed.note }]
          : [];
    if (batch.length === 0) {
      return {
        content: [{ type: 'text', text: 'Error: pass updates: [{id, status, note?}] with at least one transition (or the legacy {id, status} pair).' }],
        details: { error: 'no_updates' },
      };
    }

    const todos = sessionTodos.get(activeSessionId) ?? [];
    if (todos.length === 0) {
      return {
        content: [{ type: 'text', text: 'Error: no todo list exists yet. Call todo_create first.' }],
        details: { error: 'no_list' },
      };
    }

    const errors: string[] = [];
    const explicitIds = new Set(batch.map((u) => u.id));
    const autoCompleted: string[] = [];

    // Pass 1: apply explicit updates.
    for (const u of batch) {
      const todo = todos.find((t) => t.id === u.id);
      if (!todo) {
        errors.push(`no todo with id "${u.id}"`);
        continue;
      }
      todo.status = u.status;
      if (u.note !== undefined) todo.note = u.note;
    }

    // Pass 2: WIP=1 auto-advance — any in_progress item NOT touched by this
    // batch is completed when the batch sets some OTHER item in_progress.
    const startsProgress = batch.some(
      (u) => u.status === 'in_progress' && todos.some((t) => t.id === u.id),
    );
    if (startsProgress) {
      for (const todo of todos) {
        if (todo.status === 'in_progress' && !explicitIds.has(todo.id)) {
          todo.status = 'completed';
          autoCompleted.push(todo.id);
        }
      }
    }

    emitTodoUpdate();

    const errNote = errors.length > 0 ? `\nERRORS: ${errors.join('; ')}. Valid ids are in the list below.` : '';
    const autoNote = autoCompleted.length > 0 ? `\n(auto-advance: completed ${autoCompleted.join(', ')} — they were still in_progress)` : '';
    return {
      content: [{ type: 'text', text: `Updated ${batch.length} todo(s). Current list:\n${formatTodoList(todos)}${autoNote}${errNote}` }],
      details: {
        applied: batch.length,
        autoCompleted,
        errors,
        todos: todos.map((t) => ({ id: t.id, status: t.status })),
      },
    };
  },
});

const addTodoTool = defineTool({
  name: 'todo_add',
  label: 'Add Todo',
  description: 'Append a new todo to the current list. Use when you discover an additional step mid-task. The result returns the full list state.',
  promptSnippet: 'Add a step to the todo list mid-task.',
  promptGuidelines: [
    'Call todo_add when you realize a step is needed that you did not plan for in todo_create.',
  ],
  parameters: Type.Object({
    text: Type.String({ description: 'The step description' }),
    id: Type.Optional(Type.String({ description: 'Optional id (auto-generated if omitted)' })),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const typed = params as { text: string; id?: string };
    const todos = sessionTodos.get(activeSessionId) ?? [];
    const newTodo: TodoItem = {
      id: typed.id ?? `todo-${Date.now()}`,
      text: typed.text,
      status: 'pending' as const,
    };
    todos.push(newTodo);
    sessionTodos.set(activeSessionId, todos);
    emitTodoUpdate();
    return {
      content: [{ type: 'text', text: `Added: [${newTodo.id}] ${newTodo.text}\nCurrent list:\n${formatTodoList(todos)}` }],
      details: { id: newTodo.id },
    };
  },
});

const removeTodoTool = defineTool({
  name: 'todo_remove',
  label: 'Remove Todo',
  description: 'Remove a todo by id. Use when a step is no longer relevant. The result returns the full list state.',
  promptSnippet: 'Remove a step from the todo list.',
  promptGuidelines: [
    'Call todo_remove when a step is no longer needed (e.g. the user cancelled that part of the request).',
  ],
  parameters: Type.Object({
    id: Type.String({ description: 'The todo id to remove' }),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const typed = params as { id: string };
    const todos = sessionTodos.get(activeSessionId) ?? [];
    const idx = todos.findIndex((t) => t.id === typed.id);
    if (idx === -1) {
      return {
        content: [{ type: 'text', text: `Error: no todo with id "${typed.id}".\nCurrent list:\n${formatTodoList(todos)}` }],
        details: { error: 'not_found' },
      };
    }
    const [removed] = todos.splice(idx, 1);
    emitTodoUpdate();
    return {
      content: [{ type: 'text', text: `Removed: [${removed.id}] ${removed.text}\nCurrent list:\n${formatTodoList(todos)}` }],
      details: { id: removed.id },
    };
  },
});

const listTodoTool = defineTool({
  name: 'todo_list',
  label: 'List Todos',
  description: 'List all todos in the current list with their statuses. Read-only. NOTE: todo_create / todo_update / todo_add results already include the full list state — you rarely need this tool.',
  promptSnippet: 'Read the current todo list (usually unnecessary — mutation results embed it).',
  promptGuidelines: [
    'todo_create / todo_update results already return the full list — do NOT call todo_list to re-read what you just wrote.',
  ],
  parameters: Type.Object({}),
  async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
    const todos = sessionTodos.get(activeSessionId) ?? [];
    if (todos.length === 0) {
      return {
        content: [{ type: 'text', text: 'No todos. Call todo_create to start a list.' }],
        details: { count: 0 },
      };
    }
    return {
      content: [{ type: 'text', text: formatTodoList(todos) }],
      details: { count: todos.length },
    };
  },
});

export const tools = [createTodoTool, updateTodoTool, addTodoTool, removeTodoTool, listTodoTool];
