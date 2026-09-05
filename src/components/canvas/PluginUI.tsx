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
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { useCanvasStore } from '@/lib/canvas/store';
import {
  CheckCircle2, Circle, Loader2, AlertCircle, ListTodo, X, Plus, ShieldAlert,
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
                            ? 'border-[var(--ac-accent)] bg-[var(--ac-accent-soft)]'
                            : 'ac-border-subtle ac-surface-1 hover:ac-surface-2'
                        }`}
                      >
                        <div className="flex items-start gap-2">
                          <div className={`mt-0.5 flex-shrink-0 h-4 w-4 rounded-full border ${
                            selected ? 'border-[var(--ac-accent)] bg-[var(--ac-accent)]' : 'ac-border-default'
                          }`}>
                            {selected && <div className="h-2 w-2 rounded-full bg-white m-auto" style={{ marginTop: 2, marginLeft: 2 }} />}
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

// ── ApprovalDialog ─────────────────────────────────────────────────────────
//
// Renders the destructive-op approval gate (see lib/agent/plugins/approval-gate.ts).
// The agent is BLOCKED mid-turn until the user picks Allow / Deny — the
// decision POSTs to /api/agent/approvals, which resolves the server-side
// pending promise and the gated tool proceeds (or returns a denial result
// the model adapts to).
//
// Copy + layout pattern from Cursor's "Run command?" / Cline's Approve card:
// what will happen (description), what exactly is affected (details), and
// the destructive action visually distinct (red Allow is deliberately NOT
// used — Allow is the primary brand action, Deny is the safe one).

function ApprovalDialog() {
  const pending = useCanvasStore((s) => s.pendingApproval);
  const submit = useCanvasStore((s) => s.submitApproval);
  const agentBusy = useCanvasStore((s) => s.agentBusy);
  // Local decision guard — the POST is async; disable both buttons until the
  // dialog closes so a double-click can't flip the decision.
  const [decided, setDecided] = useState(false);
  // "Always allow this tool" — when checked + Allow, the server adds the
  // tool to its always-allow set and the client persists it in settings so
  // the preference survives reloads. Resets whenever a NEW approval request
  // arrives (each gate is its own decision).
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  // Track the previous toolCallId so we can reset state when it changes
  // (React-recommended pattern for "reset state when prop changes" — avoids
  // a useEffect + setState cascade, which lint correctly flags).
  // See: https://react.dev/learn/you-might-not-need-an-effect
  const [prevToolCallId, setPrevToolCallId] = useState<string | undefined>(pending?.toolCallId);
  if (pending?.toolCallId !== prevToolCallId) {
    setPrevToolCallId(pending?.toolCallId);
    setDecided(false);
    setAlwaysAllow(false);
  }

  if (!pending) {
    return null;
  }

  const decide = (approved: boolean) => {
    if (decided) return;
    setDecided(true);
    // alwaysAllow only applies when approving — denying + always-allow
    // is a contradiction (you wouldn't permanently allow something you're
    // about to deny). The server-side endpoint also guards against this.
    void submit(pending.toolCallId, approved, alwaysAllow && approved);
  };

  return (
    <Dialog open={!!pending} onOpenChange={(open) => { if (!open) decide(false); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4" style={{ color: 'var(--ac-danger)' }} />
            Approve destructive operation
          </DialogTitle>
          <DialogDescription>
            The agent wants to run an operation that deletes content. It is paused
            until you decide.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-md border ac-border-subtle ac-surface-1 p-3">
            <div className="flex items-center gap-2">
              <code className="text-[11px] font-mono px-1.5 py-0.5 rounded ac-surface-2 ac-text-2 flex-shrink-0">
                {pending.toolName}
              </code>
              {agentBusy && (
                <span className="flex items-center gap-1 text-[10px] ac-text-4">
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                  Waiting for your approval
                </span>
              )}
            </div>
            <div className="mt-2 text-[13px] font-medium ac-text-1">{pending.description}</div>
            {pending.details.length > 0 && (
              <ul className="mt-2 space-y-1">
                {pending.details.map((d, i) => (
                  <li key={i} className="text-[11px] ac-text-3 flex gap-1.5">
                    <span className="ac-text-4 flex-shrink-0">•</span>
                    <span className="min-w-0 break-words">{d}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {/* "Always allow this tool" — mirrors Cline's "Always allow" /
              Claude Code's "Always" permission option. Persists across the
              session AND in settings (so reloads preserve it). Only
              meaningful with Allow; disabled when Deny is the action. */}
          <label
            className="flex items-start gap-2 px-1 py-1 cursor-pointer select-none"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <Checkbox
              checked={alwaysAllow}
              onCheckedChange={(v) => setAlwaysAllow(v === true)}
              className="mt-0.5"
              id="approval-always-allow"
            />
            <span className="flex-1 min-w-0">
              <span className="block text-[11px] font-medium ac-text-1">
                Always allow <code className="font-mono text-[10px] ac-text-2">{pending.toolName}</code>
              </span>
              <span className="block text-[10px] ac-text-4 mt-0.5">
                Skip this prompt for future calls to the same tool. Manage the list in Settings → Agent behavior.
              </span>
            </span>
          </label>
          <p className="text-[10px] ac-text-4">
            Unattended gates auto-deny after 5 minutes. You can turn the gate off
            in Settings → Agent behavior.
          </p>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => decide(false)} disabled={decided} className="h-8 text-[12px]">
            Deny
          </Button>
          <Button
            onClick={() => decide(true)}
            disabled={decided}
            className="h-8 text-[12px]"
            title={alwaysAllow ? `Allow this and future ${pending.toolName} calls` : 'Allow this operation to run'}
          >
            {alwaysAllow ? 'Always allow' : 'Allow'}
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
  pending: 'ac-text-neutral',
  in_progress: 'ac-text-info',
  completed: 'ac-text-success',
  blocked: 'ac-text-danger',
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
          const color = STATUS_COLOR[t.status] ?? 'ac-text-neutral';
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
              <Loader2 className="h-3 w-3 mt-0.5 flex-shrink-0 ac-text-info animate-spin" />
            ) : t.success ? (
              <CheckCircle2 className="h-3 w-3 mt-0.5 flex-shrink-0 ac-text-success" />
            ) : (
              <AlertCircle className="h-3 w-3 mt-0.5 flex-shrink-0 ac-text-danger" />
            )}
            <div className="flex-1 min-w-0">
              <div className="text-[11px] ac-text-2 truncate">{t.description}</div>
              <div className="text-[10px] ac-text-4 mt-0.5">
                {t.status === 'started' ? 'Running…' : t.summary ?? 'Done'}
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
      <ApprovalDialog />
      <TodoOverlay />
      <BackgroundTaskList />
    </>
  );
}
