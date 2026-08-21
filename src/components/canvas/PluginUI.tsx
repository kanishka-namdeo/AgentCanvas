'use client';

// Plugin UI components — renders the interactive UI for each plugin:
//
//   - AskUserQuestionDialog: a modal dialog the agent triggers mid-turn
//     to ask structured clarifying questions.
//   - TodoOverlay: a live task list overlay the agent updates.
//   - BackgroundTaskList: a list of background tasks with statuses.
//
// All components are driven by the canvas store's plugin state. They're
// rendered together by PluginUI (below), which is mounted in the AgentPanel.

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { useCanvasStore } from '@/lib/canvas/store';
import {
  CheckCircle2, Circle, Loader2, AlertCircle, ListTodo, X, Plus,
} from 'lucide-react';
import { toast } from 'sonner';

// ── AskUserQuestionDialog ──────────────────────────────────────────────────

function AskUserQuestionDialog() {
  const pending = useCanvasStore((s) => s.pendingQuestion);
  const submit = useCanvasStore((s) => s.submitQuestionAnswers);
  // Track selected options per question.
  // answers[i] = array of selected option labels.
  const [answers, setAnswers] = useState<string[][]>([]);

  if (!pending) return null;

  // Initialize answers array when the question changes.
  if (answers.length !== pending.questions.length) {
    setAnswers(pending.questions.map(() => []));
  }

  const toggleOption = (qIdx: number, label: string, multiSelect: boolean) => {
    setAnswers((prev) => {
      const next = [...prev];
      const cur = next[qIdx] ?? [];
      if (multiSelect) {
        next[qIdx] = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label];
      } else {
        next[qIdx] = [label];
      }
      return next;
    });
  };

  const handleSubmit = async () => {
    await submit(pending.toolCallId, answers, false);
    setAnswers([]);
  };

  const handleCancel = async () => {
    await submit(pending.toolCallId, [], true);
    setAnswers([]);
  };

  return (
    <Dialog open={!!pending} onOpenChange={(open) => { if (!open) handleCancel(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Agent needs clarification</DialogTitle>
          <DialogDescription>
            The agent has a few questions before it can proceed. Pick the best option for each.
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[60vh]">
          <div className="space-y-5 p-1">
            {pending.questions.map((q, qIdx) => (
              <div key={qIdx}>
                <div className="flex items-center gap-2 mb-2">
                  {q.header && (
                    <span className="text-[10px] font-medium ac-text-3 px-1.5 py-0.5 rounded ac-surface-2 uppercase tracking-wide">
                      {q.header}
                    </span>
                  )}
                  <span className="text-[13px] font-medium ac-text-1">{q.question}</span>
                  {q.multiSelect && (
                    <span className="text-[10px] ac-text-4">(pick multiple)</span>
                  )}
                </div>
                <div className="space-y-1.5">
                  {q.options.map((opt) => {
                    const selected = (answers[qIdx] ?? []).includes(opt.label);
                    return (
                      <button
                        key={opt.label}
                        onClick={() => toggleOption(qIdx, opt.label, q.multiSelect ?? false)}
                        className={`w-full text-left p-2.5 rounded-md border ac-transition ac-focus-ring ${
                          selected
                            ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30'
                            : 'ac-border-subtle ac-surface-1 hover:ac-surface-2'
                        }`}
                      >
                        <div className="flex items-start gap-2">
                          <div className={`mt-0.5 flex-shrink-0 h-4 w-4 rounded-full border ${
                            selected ? 'border-blue-500 bg-blue-500' : 'ac-border-default'
                          }`}>
                            {selected && <div className="h-2 w-2 rounded-full bg-white m-auto mt-1/4" style={{ marginTop: 2, marginLeft: 2 }} />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-[12px] font-medium ac-text-1">{opt.label}</div>
                            {opt.description && (
                              <div className="text-[11px] ac-text-3 mt-0.5">{opt.description}</div>
                            )}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={handleCancel} className="h-8 text-[12px]">
            Cancel
          </Button>
          <Button onClick={handleSubmit} className="h-8 text-[12px]">
            Submit answers
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── TodoOverlay ────────────────────────────────────────────────────────────

const STATUS_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  pending: Circle,
  in_progress: Loader2,
  completed: CheckCircle2,
  blocked: AlertCircle,
};

const STATUS_COLOR: Record<string, string> = {
  pending: 'text-slate-400',
  in_progress: 'text-blue-500',
  completed: 'text-emerald-600',
  blocked: 'text-red-500',
};

function TodoOverlay() {
  const todos = useCanvasStore((s) => s.todos);
  const clear = useCanvasStore((s) => s.clearTodos);
  if (todos.length === 0) return null;
  return (
    <div className="border ac-border-subtle ac-surface-1 rounded-md p-2.5 mb-2">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5">
          <ListTodo className="h-3.5 w-3.5 ac-text-2" />
          <span className="text-[11px] font-medium ac-text-2">Task list</span>
          <span className="text-[10px] ac-text-4">({todos.filter((t) => t.status === 'completed').length}/{todos.length})</span>
        </div>
        <button onClick={clear} className="text-[10px] ac-text-4 hover:ac-text-2 ac-transition">
          clear
        </button>
      </div>
      <div className="space-y-1">
        {todos.map((t) => {
          const Icon = STATUS_ICON[t.status] ?? Circle;
          const color = STATUS_COLOR[t.status] ?? 'text-slate-400';
          const spin = t.status === 'in_progress';
          return (
            <div key={t.id} className="flex items-start gap-2">
              <Icon className={`h-3 w-3 mt-0.5 flex-shrink-0 ${color} ${spin ? 'animate-spin' : ''}`} />
              <div className="flex-1 min-w-0">
                <div className={`text-[11px] ${t.status === 'completed' ? 'line-through ac-text-4' : 'ac-text-2'}`}>
                  {t.text}
                </div>
                {t.note && <div className="text-[10px] ac-text-4 mt-0.5">{t.note}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── BackgroundTaskList ──────────────────────────────────────────────────────

function BackgroundTaskList() {
  const tasks = useCanvasStore((s) => s.backgroundTasks);
  if (tasks.length === 0) return null;
  return (
    <div className="border ac-border-subtle ac-surface-1 rounded-md p-2.5 mb-2">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Loader2 className="h-3.5 w-3.5 ac-text-2" />
        <span className="text-[11px] font-medium ac-text-2">Background tasks</span>
      </div>
      <div className="space-y-1">
        {tasks.map((t) => (
          <div key={t.taskId} className="flex items-start gap-2">
            {t.status === 'started' ? (
              <Loader2 className="h-3 w-3 mt-0.5 flex-shrink-0 text-blue-500 animate-spin" />
            ) : t.success ? (
              <CheckCircle2 className="h-3 w-3 mt-0.5 flex-shrink-0 text-emerald-600" />
            ) : (
              <AlertCircle className="h-3 w-3 mt-0.5 flex-shrink-0 text-red-500" />
            )}
            <div className="flex-1 min-w-0">
              <div className="text-[11px] ac-text-2 truncate">{t.description}</div>
              <div className="text-[10px] ac-text-4 mt-0.5">
                {t.status === 'started' ? 'Running...' : t.summary ?? 'Done'}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── PluginUI (the combined export) ──────────────────────────────────────────

export function PluginUI() {
  return (
    <>
      <AskUserQuestionDialog />
      <TodoOverlay />
      <BackgroundTaskList />
    </>
  );
}
