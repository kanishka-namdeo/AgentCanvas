// Plugin: todo
//
// A task list overlay the agent updates during a turn. Inspired by
// @juicesharp/rpiv-todo but re-implemented for the web (no TUI overlay).
//
// Tools:
//   todo_create  — start a new todo list (replaces any existing one)
//   todo_update  — update a single todo's status
//   todo_add     — add a new todo to the list
//   todo_remove  — remove a todo by id
//   todo_list     — list all todos (for the agent to read)
//
// Each mutation emits an `agent:todo_update` SyncEvent so the frontend's
// AgentPanel can re-render the live list. The list persists across
// compaction (it's stored as a separate tool-call-side channel, not in
// the message history).

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
    'Start a new todo list for the current turn. Replaces any existing list. Use this at the start of a multi-step task to break it into trackable steps. Each item should be a single, concrete action.',
  promptSnippet: 'Create a todo list to track multi-step design tasks.',
  promptGuidelines: [
    'Call todo_create at the start of any task with 2+ distinct steps.',
    'Each item should be a single, concrete action (e.g. "Create the header", "Apply color palette", "Add shadows to cards").',
    'After completing each step, call todo_update to mark it completed before moving to the next.',
    'If you discover additional steps mid-task, call todo_add to append them.',
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
      content: [{ type: 'text', text: `Created ${todos.length}-item todo list:\n${todos.map((t, i) => `${i + 1}. [${t.id}] ${t.text}`).join('\n')}` }],
      details: { todoIds: todos.map((t) => t.id) },
    };
  },
});

const updateTodoTool = defineTool({
  name: 'todo_update',
  label: 'Update Todo Status',
  description:
    "Update a single todo's status. Mark as in_progress when you start a step, completed when done, blocked if you can't proceed.",
  promptSnippet: 'Update todo status as you work through each step.',
  promptGuidelines: [
    'Call todo_update with status="in_progress" right before starting a step.',
    'Call todo_update with status="completed" as soon as the step is done.',
    'Set status="blocked" if you cannot complete a step (and explain why in the note).',
  ],
  parameters: Type.Object({
    id: Type.String({ description: 'The todo id (from todo_create or todo_add)' }),
    status: TodoStatusSchema,
    note: Type.Optional(Type.String({ description: 'Optional note (e.g. blocked reason or completion summary)' })),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const typed = params as { id: string; status: TodoItem['status']; note?: string };
    const todos = sessionTodos.get(activeSessionId) ?? [];
    const todo = todos.find((t) => t.id === typed.id);
    if (!todo) {
      return {
        content: [{ type: 'text', text: `Error: no todo with id "${typed.id}". Call todo_list to see all todos.` }],
        details: { error: 'not_found' },
      };
    }
    todo.status = typed.status;
    if (typed.note !== undefined) todo.note = typed.note;
    emitTodoUpdate();
    return {
      content: [{ type: 'text', text: `Updated "${todo.text}" → ${typed.status}${typed.note ? ` (${typed.note})` : ''}` }],
      details: { id: todo.id, status: todo.status },
    };
  },
});

const addTodoTool = defineTool({
  name: 'todo_add',
  label: 'Add Todo',
  description: 'Append a new todo to the current list. Use when you discover an additional step mid-task.',
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
      content: [{ type: 'text', text: `Added: [${newTodo.id}] ${newTodo.text}` }],
      details: { id: newTodo.id },
    };
  },
});

const removeTodoTool = defineTool({
  name: 'todo_remove',
  label: 'Remove Todo',
  description: 'Remove a todo by id. Use when a step is no longer relevant.',
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
        content: [{ type: 'text', text: `Error: no todo with id "${typed.id}".` }],
        details: { error: 'not_found' },
      };
    }
    const [removed] = todos.splice(idx, 1);
    emitTodoUpdate();
    return {
      content: [{ type: 'text', text: `Removed: [${removed.id}] ${removed.text}` }],
      details: { id: removed.id },
    };
  },
});

const listTodoTool = defineTool({
  name: 'todo_list',
  label: 'List Todos',
  description: 'List all todos in the current list with their statuses. Read-only.',
  promptSnippet: 'Read the current todo list.',
  promptGuidelines: [
    'Call todo_list at any time to see the current state of the task list.',
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
    const lines = todos.map((t, i) => `${i + 1}. [${t.status.padEnd(11)}] [${t.id}] ${t.text}${t.note ? ` — ${t.note}` : ''}`);
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      details: { count: todos.length },
    };
  },
});

export const tools = [createTodoTool, updateTodoTool, addTodoTool, removeTodoTool, listTodoTool];
