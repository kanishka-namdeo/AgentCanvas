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
  icon: React.ComponentType<{ className?: string }> | null;
  pulse?: boolean;
}

const RUN_STATUS_CONFIG: Record<RunStatus, StatusConfig> = {
  queued:              { label: 'queued',      cls: 'text-slate-700 bg-slate-100 border-slate-300',         icon: Clock },
  in_progress:         { label: 'running',     cls: 'text-blue-700 bg-blue-50 border-blue-200',            icon: Loader2, pulse: true },
  awaiting_tool:       { label: 'tool',        cls: 'text-amber-700 bg-amber-50 border-amber-200',         icon: Loader2, pulse: true },
  cancelling:          { label: 'cancelling',  cls: 'text-orange-700 bg-orange-50 border-orange-200',      icon: Loader2, pulse: true },
  cancelled:           { label: 'cancelled',   cls: 'text-slate-600 bg-slate-100 border-slate-300',         icon: Ban },
  completed:           { label: 'completed',   cls: 'text-emerald-800 bg-emerald-100 border-emerald-300',  icon: CheckCircle2 },
  failed:              { label: 'failed',      cls: 'text-rose-700 bg-rose-50 border-rose-200',            icon: XCircle },
  incomplete:          { label: 'incomplete',  cls: 'text-amber-700 bg-amber-50 border-amber-200',         icon: AlertTriangle },
};

const TOOL_STATUS_CONFIG: Record<ToolCallStatus, StatusConfig> = {
  pending:   { label: 'pending',   cls: 'text-slate-600 bg-slate-100 border-slate-200', icon: Circle },
  running:   { label: 'running',   cls: 'text-blue-700 bg-blue-50 border-blue-200',    icon: Loader2, pulse: true },
  success:   { label: 'success',   cls: 'text-emerald-700 bg-emerald-50 border-emerald-200', icon: CheckCircle2 },
  error:     { label: 'error',     cls: 'text-rose-700 bg-rose-50 border-rose-200',    icon: XCircle },
  cancelled: { label: 'cancelled', cls: 'text-slate-500 bg-slate-50 border-slate-200', icon: Ban },
};

const SESSION_STATUS_CONFIG: Record<SessionStatus, StatusConfig> = {
  active:   { label: 'active',   cls: 'text-emerald-700 bg-emerald-50 border-emerald-200',   icon: null },
  archived: { label: 'archived', cls: 'text-slate-500 bg-slate-50 border-slate-200', icon: null },
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
    return <span className={`inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse ${className}`} />;
  }
  if (status === 'queued') {
    return <span className={`inline-block w-1.5 h-1.5 rounded-full bg-slate-400 ${className}`} />;
  }
  if (status === 'failed') {
    return <span className={`inline-block w-1.5 h-1.5 rounded-full bg-rose-500 ${className}`} />;
  }
  if (status === 'cancelled' || status === 'incomplete') {
    return <span className={`inline-block w-1.5 h-1.5 rounded-full bg-amber-500 ${className}`} />;
  }
  if (status === 'archived') {
    return <span className={`inline-block w-1.5 h-1.5 rounded-full bg-slate-300 ${className}`} />;
  }
  // completed / active
  return <span className={`inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 ${className}`} />;
}
