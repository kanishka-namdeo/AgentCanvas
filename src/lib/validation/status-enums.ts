// Status enum validation for API routes — prevents invalid status strings
// from being written to the database. These enums mirror the TypeScript types
// in src/lib/sessions/types.ts but are enforced at the API boundary.
//
// Without this validation, a buggy client could POST `status: 'banana'` and
// the server would write it to the database, causing UI crashes when the
// client tries to render an unknown status.

export const VALID_SESSION_STATUSES = ['active', 'archived'] as const;
export type SessionStatusEnum = typeof VALID_SESSION_STATUSES[number];

export const VALID_MESSAGE_STATUSES = ['streaming', 'complete', 'error', 'cancelled'] as const;
export type MessageStatusEnum = typeof VALID_MESSAGE_STATUSES[number];

export const VALID_RUN_STATUSES = [
  'queued',
  'in_progress',
  'awaiting_tool',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
  'stuck',
  'incomplete',
] as const;
export type RunStatusEnum = typeof VALID_RUN_STATUSES[number];

export const VALID_TOOL_CALL_STATUSES = ['pending', 'running', 'success', 'error', 'cancelled'] as const;
export type ToolCallStatusEnum = typeof VALID_TOOL_CALL_STATUSES[number];

/// Type guard: is `v` a valid session status?
export function isValidSessionStatus(v: unknown): v is SessionStatusEnum {
  return typeof v === 'string' && VALID_SESSION_STATUSES.includes(v as SessionStatusEnum);
}

/// Type guard: is `v` a valid message status?
export function isValidMessageStatus(v: unknown): v is MessageStatusEnum {
  return typeof v === 'string' && VALID_MESSAGE_STATUSES.includes(v as MessageStatusEnum);
}

/// Type guard: is `v` a valid run status?
export function isValidRunStatus(v: unknown): v is RunStatusEnum {
  return typeof v === 'string' && VALID_RUN_STATUSES.includes(v as RunStatusEnum);
}

/// Type guard: is `v` a valid tool call status?
export function isValidToolCallStatus(v: unknown): v is ToolCallStatusEnum {
  return typeof v === 'string' && VALID_TOOL_CALL_STATUSES.includes(v as ToolCallStatusEnum);
}
