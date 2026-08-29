'use client';

import { Loader2, CheckCircle2, XCircle, Circle, Pause, Ban, AlertTriangle, Clock } from 'lucide-react';
import type { RunStatus, ToolCallStatus, SessionStatus } from '@/lib/sessions';

interface StatusBadgeProps {
  status: RunStatus | ToolCallStatus | SessionStatus;
  size?: 'sm' | 'md';
  className?: string;
  /// Task 4d — optional screen-reader-only description appended after the
  /// status label in the aria-live region. Use for richer context the bare
  /// label can't carry (e.g. "running, 3 of 5 tool calls complete"). When
  /// omitted, the badge announces just the label ("running", "completed",
  /// etc.) — still useful, just less specific.
  description?: string;
}

interface StatusConfig {
  label: string;
  cls: string;
  dotCls: string;
  icon: React.ComponentType<{ className?: string }> | null;
  pulse?: boolean;
}

// All status colors now flow through the --ac-status-* token system defined
// in globals.css. Each entry carries:
//   cls     — the badge background/text/border classes (bg + fg + border)
//   dotCls  — the solid dot color (just the fill)
// Both adapt to light/dark mode automatically via the underlying CSS vars.
const RUN_STATUS_CONFIG: Record<RunStatus, StatusConfig> = {
  queued:        { label: 'queued',      cls: 'ac-status-neutral',  dotCls: 'ac-dot-neutral',  icon: Clock },
  in_progress:   { label: 'running',      cls: 'ac-status-info',     dotCls: 'ac-dot-info',     icon: Loader2, pulse: true },
  awaiting_tool: { label: 'tool',         cls: 'ac-status-warning',  dotCls: 'ac-dot-warning',  icon: Loader2, pulse: true },
  cancelling:    { label: 'cancelling',   cls: 'ac-status-warning',  dotCls: 'ac-dot-warning',  icon: Loader2, pulse: true },
  cancelled:     { label: 'cancelled',     cls: 'ac-status-neutral',  dotCls: 'ac-dot-neutral',  icon: Ban },
  completed:     { label: 'completed',    cls: 'ac-status-success',  dotCls: 'ac-dot-success',  icon: CheckCircle2 },
  failed:        { label: 'failed',        cls: 'ac-status-danger',   dotCls: 'ac-dot-danger',   icon: XCircle },
  // Stuck-detector terminal status: the agent repeated the same failing tool
  // call and the loop was stopped before burning the iteration budget.
  stuck:         { label: 'stuck',        cls: 'ac-status-warning',  dotCls: 'ac-dot-warning',  icon: AlertTriangle },
  incomplete:    { label: 'incomplete',    cls: 'ac-status-warning',  dotCls: 'ac-dot-warning',  icon: AlertTriangle },
};

const TOOL_STATUS_CONFIG: Record<ToolCallStatus, StatusConfig> = {
  pending:   { label: 'pending',   cls: 'ac-status-neutral',  dotCls: 'ac-dot-neutral',  icon: Circle },
  running:   { label: 'running',   cls: 'ac-status-info',     dotCls: 'ac-dot-info',     icon: Loader2, pulse: true },
  success:   { label: 'success',   cls: 'ac-status-success',  dotCls: 'ac-dot-success',  icon: CheckCircle2 },
  error:     { label: 'error',     cls: 'ac-status-danger',   dotCls: 'ac-dot-danger',   icon: XCircle },
  cancelled: { label: 'cancelled', cls: 'ac-status-neutral',  dotCls: 'ac-dot-neutral',  icon: Ban },
};

const SESSION_STATUS_CONFIG: Record<SessionStatus, StatusConfig> = {
  active:   { label: 'active',    cls: 'ac-status-success',  dotCls: 'ac-dot-success',  icon: null },
  archived: { label: 'archived',  cls: 'ac-status-neutral',  dotCls: 'ac-dot-neutral',  icon: null },
};

export function StatusBadge({ status, size = 'sm', className = '', description }: StatusBadgeProps) {
  const cfg =
    status in RUN_STATUS_CONFIG
      ? RUN_STATUS_CONFIG[status as RunStatus]
      : status in TOOL_STATUS_CONFIG
        ? TOOL_STATUS_CONFIG[status as ToolCallStatus]
        : SESSION_STATUS_CONFIG[status as SessionStatus];

  if (!cfg) return null;
  const Icon = cfg.icon;
  const sizeCls = size === 'sm' ? 'text-[10px] h-4 px-1 py-0.5' : 'text-[11px] h-5 px-1.5';
  const iconCls = size === 'sm' ? 'h-2.5 w-2.5' : 'h-3 w-3';

  // Task 4d — compose the screen-reader announcement. The visible badge
  // already shows cfg.label, but screen readers wouldn't announce the
  // change when the status flips (e.g. queued → running → completed) because
  // the badge's <span> isn't an aria-live region. Wrapping the badge in an
  // aria-live="polite" span + a sr-only text node makes NVDA / VoiceOver /
  // JAWS announce every status change (e.g. "running" then "completed")
  // without interrupting the user. The optional `description` prop appends
  // richer context after the label — pass e.g. "3 of 5 tool calls complete"
  // for the run panel, or omit for the bare label.
  // Task 4d — compose the screen-reader announcement. The badge's visible
  // text is aria-hidden so the aria-live region announces the sr-only node
  // ONLY — previously both the visible label and the sr-only announcement
  // lived inside the live region, so screen readers heard every status
  // doubled ("completedcompleted").
  const announcement = description
    ? `${cfg.label}, ${description}`
    : cfg.label;

  return (
    <span aria-live="polite" aria-atomic="true" className="inline-flex">
      <span
        aria-hidden="true"
        className={`inline-flex items-center gap-1 rounded border font-medium ${cfg.cls} ${sizeCls} ${className}`}
      >
        {Icon && <Icon className={`${iconCls} ${cfg.pulse ? 'animate-spin' : ''}`} />}
        {cfg.label}
      </span>
      <span className="sr-only">{announcement}</span>
    </span>
  );
}

// Small dot variant for sidebar rows where a full badge is too heavy.
export function StatusDot({ status, className = '' }: { status: RunStatus | SessionStatus; className?: string }) {
  if (status === 'in_progress' || status === 'awaiting_tool' || status === 'cancelling') {
    return <span className={`inline-block w-1.5 h-1.5 rounded-full ac-dot-info animate-pulse ${className}`} />;
  }
  if (status === 'queued') {
    return <span className={`inline-block w-1.5 h-1.5 rounded-full ac-dot-neutral ${className}`} />;
  }
  if (status === 'failed') {
    return <span className={`inline-block w-1.5 h-1.5 rounded-full ac-dot-danger ${className}`} />;
  }
  if (status === 'cancelled' || status === 'incomplete') {
    return <span className={`inline-block w-1.5 h-1.5 rounded-full ac-dot-warning ${className}`} />;
  }
  if (status === 'archived') {
    return <span className={`inline-block w-1.5 h-1.5 rounded-full ac-dot-neutral ${className}`} />;
  }
  // completed / active
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ac-dot-success ${className}`} />;
}
