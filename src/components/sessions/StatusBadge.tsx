'use client';

import { Loader2, CheckCircle2, XCircle, Circle, Pause, Ban, AlertTriangle, Clock } from 'lucide-react';
import type { RunStatus, ToolCallStatus, SessionStatus } from '@/lib/sessions';

interface StatusBadgeProps {
  status: RunStatus | ToolCallStatus | SessionStatus;
  size?: 'sm' | 'md';
  className?: string;
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

export function StatusBadge({ status, size = 'sm', className = '' }: StatusBadgeProps) {
  const cfg =
    status in RUN_STATUS_CONFIG
      ? RUN_STATUS_CONFIG[status as RunStatus]
      : status in TOOL_STATUS_CONFIG
        ? TOOL_STATUS_CONFIG[status as ToolCallStatus]
        : SESSION_STATUS_CONFIG[status as SessionStatus];

  if (!cfg) return null;
  const Icon = cfg.icon;
  const sizeCls = size === 'sm' ? 'text-[9px] h-3.5 px-1 py-0' : 'text-[10px] h-5 px-1.5';
  const iconCls = size === 'sm' ? 'h-2.5 w-2.5' : 'h-3 w-3';

  return (
    <span
      className={`inline-flex items-center gap-1 rounded border font-medium ${cfg.cls} ${sizeCls} ${className}`}
    >
      {Icon && <Icon className={`${iconCls} ${cfg.pulse ? 'animate-spin' : ''}`} />}
      {cfg.label}
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
