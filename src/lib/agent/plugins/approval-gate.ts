// Plugin: approval-gate
//
// A human-in-the-loop gate for DESTRUCTIVE agent operations. Mirrors the
// approval UX established by coding agents (researched patterns):
//
//   - Cursor: the agent proposes a terminal command; the user sees the exact
//     command and clicks Run / Reject (with an auto-run toggle per session).
//   - Cline: every file write / command shows an Approve button with
//     "Always allow" — nothing destructive lands without a click.
//   - Claude Code: permission prompts per tool ("Allow once / Always / No"),
//     with --dangerously-skip-permissions as the explicit opt-out.
//   - Devin / Copilot Workspace: a "pending approval" card the user resolves
//     from the chat stream.
//
// Mechanism — identical plumbing to ask-user-question (proven to work over
// both the Socket.IO fan-out and the direct-HTTP NDJSON fallback):
//
//   1. The runner wraps destructive tools (see runner-native.ts). Before the
//      wrapped tool executes, it calls `requestApproval()` with a human
//      description of what is about to be destroyed.
//   2. requestApproval() emits an `agent:approval_request` SyncEvent (the
//      frontend renders an Allow/Deny dialog from it) and BLOCKS on a
//      promise registered under the toolCallId.
//   3. The user's decision POSTs to /api/agent/approvals, which calls
//      `resolveApproval()` and settles the promise.
//   4. The wrapper proceeds (approved) or returns an isError result telling
//      the model the user declined (so it adapts instead of crashing).
//
// Safe defaults: a 5-minute timeout resolves as DENIED — an unattended gate
// never wipes the canvas.

import { emitEvent } from './event-bus';

// ---- Destructive tool registry ----------------------------------------------
//
// Tools whose effects destroy user content that cannot be recreated from the
// prompt alone. Restructuring ops (ungroup, detach) are deliberately NOT
// gated — they are reversible transformations, not data loss.

export const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set([
  /// Wipes every shape from the canvas.
  'pen_clear',
  /// Deletes shapes by id (including bulk deletes).
  'pen_delete_shape',
  /// Deletes an entire page and everything on it.
  'figma_delete_page',
  /// Wipes the learned pattern-memory store.
  'pen_clear_pattern_memory',
]);

/// Threshold above which a bulk delete is called out as "large" in the
/// dialog copy (purely presentational — every delete is gated either way).
export const LARGE_DELETE_THRESHOLD = 5;

/// What the gate is asking permission for, as shown in the dialog.
export interface ApprovalRequest {
  toolCallId: string;
  toolName: string;
  /// One-line human description ("Delete 3 layers from the canvas").
  description: string;
  /// Bullet detail lines (target names, scope, reversibility note).
  details: string[];
}

/// The decision returned to the wrapped tool.
export interface ApprovalDecision {
  approved: boolean;
  /// True when the gate timed out (counts as denied, but the message the
  /// model receives explains the user was away).
  timedOut: boolean;
}

// ---- Pending approval tracking ----------------------------------------------
//
// Map of toolCallId → { resolve, timer, toolName }. Mirrors ask-user-question's
// pendingQuestions registry. Single agent turn at a time per document, and
// the SDK executes tool calls sequentially, so a plain map is race-free.

interface PendingApproval {
  resolve: (d: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
  /// Tool name (kept so /api/agent/approvals can add it to the always-allow
  /// set when the user checks "Always allow this tool" + Allow).
  toolName: string;
}

const pendingApprovals = new Map<string, PendingApproval>();

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ---- Always-allow set -------------------------------------------------------
//
// Tools the user has permanently allowed via the "Always allow this tool"
// checkbox. Seeded from `settings.alwaysAllowTools` at the start of every
// agent run (see runner-native.ts); appended to by /api/agent/approvals when
// the user opts in. The set is process-scoped — it survives across requests
// on the same dev sandbox, and is reset on server restart (the localStorage
// copy in settings is the durable source of truth).

const alwaysAllowSet = new Set<string>();

/// Seed the always-allow set from settings. Called once per agent run start
/// (the runner does this in runAgentNative()). Idempotent — duplicates are
/// deduped by the Set. Empty input is fine (just clears nothing).
/// NOTE: does NOT clear the set first — settings might be a subset of what's
/// been added during this server lifetime (e.g. user added a tool in session
/// A, then started session B). To reset, call `resetAlwaysAllowSet()`.
export function seedAlwaysAllow(tools: string[] | undefined | null): void {
  if (!tools) return;
  for (const t of tools) {
    if (typeof t === 'string' && t.length > 0) alwaysAllowSet.add(t);
  }
}

/// Reset the always-allow set to empty. Used by tests; production code
/// typically doesn't need this — the set is per-process and tools added
/// during a run are a feature, not a bug.
export function resetAlwaysAllowSet(): void {
  alwaysAllowSet.clear();
}

/// Add a tool to the always-allow set. Called by /api/agent/approvals when
/// the user checks "Always allow this tool" + Allow. Future requestApproval()
/// calls for this tool will short-circuit as approved without emitting the
/// event (so no UI shows up).
export function addAlwaysAllow(toolName: string): void {
  if (typeof toolName === 'string' && toolName.length > 0) {
    alwaysAllowSet.add(toolName);
  }
}

/// True when the user has permanently allowed this tool. The approval wrapper
/// checks this BEFORE calling requestApproval to skip the gate entirely.
export function isAlwaysAllowed(toolName: string): boolean {
  return alwaysAllowSet.has(toolName);
}

/// Snapshot of the always-allow set (for diagnostics / settings sync).
export function getAlwaysAllowSet(): string[] {
  return Array.from(alwaysAllowSet).sort();
}

/// Resolve (or time out) a pending approval. Safe to call for unknown ids
/// (already resolved / never registered) — it's a no-op.
export function resolveApproval(toolCallId: string, approved: boolean): void {
  const p = pendingApprovals.get(toolCallId);
  if (!p) return;
  clearTimeout(p.timer);
  pendingApprovals.delete(toolCallId);
  p.resolve({ approved, timedOut: false });
}

/// Currently-pending approval toolCallIds (for diagnostics / polling routes).
export function getPendingApprovals(): string[] {
  return Array.from(pendingApprovals.keys());
}

/// Emit the request event and block until the user decides (or timeout).
/// Timeout resolves as DENIED — an unattended gate never wipes the canvas.
/// (Tests drive this directly via resolveApproval; the runner wrapper is the
/// only production caller.)
///
/// If the tool is in the always-allow set, short-circuits as approved
/// WITHOUT emitting the event (no UI is shown for the gate). The caller still
/// gets a settled decision so its tool runs normally.
export function requestApproval(req: ApprovalRequest): Promise<ApprovalDecision> {
  // Short-circuit: user has permanently allowed this tool. No event, no
  // pending entry, no UI. The tool just runs.
  if (alwaysAllowSet.has(req.toolName)) {
    return Promise.resolve({ approved: true, timedOut: false });
  }
  return new Promise((resolve) => {
    emitEvent({
      type: 'agent:approval_request',
      toolCallId: req.toolCallId,
      toolName: req.toolName,
      description: req.description,
      details: req.details,
    });
    const timer = setTimeout(() => {
      pendingApprovals.delete(req.toolCallId);
      resolve({ approved: false, timedOut: true });
    }, APPROVAL_TIMEOUT_MS);
    pendingApprovals.set(req.toolCallId, { resolve, timer, toolName: req.toolName });
  });
}

/// Look up the toolName for a pending approval (used by /api/agent/approvals
/// when `alwaysAllow: true` is sent so the endpoint can add the right tool
/// to the always-allow set). Returns undefined for unknown / resolved ids.
export function getPendingToolName(toolCallId: string): string | undefined {
  return pendingApprovals.get(toolCallId)?.toolName;
}

// ---- Description builder ----------------------------------------------------
//
// Builds the human-facing dialog copy from the tool name + args. The runner
// wrapper passes the CURRENT canvas shapes so names resolve to something the
// user recognizes ("Card 3", not "shape_cuid123").

export interface ShapeNameLookup {
  id: string;
  name: string;
  type?: string;
}

/// Build the ApprovalRequest for a gated tool call. Returns null when the
/// tool+args combination doesn't actually need gating (e.g. delete with no
/// resolvable ids → the tool itself will error; no need to ask).
export function buildApprovalRequest(
  toolCallId: string,
  toolName: string,
  params: unknown,
  shapes: ShapeNameLookup[],
): ApprovalRequest | null {
  const p = (params ?? {}) as Record<string, unknown>;

  if (toolName === 'pen_clear') {
    return {
      toolCallId,
      toolName,
      description: `Clear the entire canvas (${shapes.length} layer${shapes.length === 1 ? '' : 's'} would be deleted)`,
      details: [
        `All ${shapes.length} layers will be removed.`,
        'The canvas background and variables are kept.',
        shapes.length > 0
          ? `Layers: ${shapes.slice(0, 8).map((s) => s.name).join(', ')}${shapes.length > 8 ? ` … +${shapes.length - 8} more` : ''}`
          : 'The canvas is already empty.',
      ],
    };
  }

  if (toolName === 'pen_delete_shape') {
    const ids: string[] = Array.isArray(p.shapeIds)
      ? p.shapeIds.filter((v): v is string => typeof v === 'string')
      : typeof p.shapeId === 'string' ? [p.shapeId] : [];
    const targets = shapes.filter((s) => ids.includes(s.id));
    if (ids.length === 0) return null; // tool will error — let it
    const large = targets.length >= LARGE_DELETE_THRESHOLD;
    return {
      toolCallId,
      toolName,
      description: `Delete ${targets.length > 0 ? targets.length : ids.length} layer${(targets.length || ids.length) === 1 ? '' : 's'}${large ? ' (bulk delete)' : ''}`,
      details: [
        targets.length > 0
          ? `Layers to delete: ${targets.slice(0, 8).map((s) => s.name).join(', ')}${targets.length > 8 ? ` … +${targets.length - 8} more` : ''}`
          : `Ids: ${ids.slice(0, 8).join(', ')}${ids.length > 8 ? ` … +${ids.length - 8} more` : ''}`,
        'Deletion is undoable via /undo until several more edits land.',
      ],
    };
  }

  if (toolName === 'figma_delete_page') {
    const pageName = typeof p.name === 'string' ? p.name : typeof p.pageId === 'string' ? p.pageId : 'the page';
    return {
      toolCallId,
      toolName,
      description: `Delete the page "${pageName}" and everything on it`,
      details: [
        `Page: ${pageName}`,
        'All layers on that page are deleted with it.',
      ],
    };
  }

  if (toolName === 'pen_clear_pattern_memory') {
    return {
      toolCallId,
      toolName,
      description: 'Wipe the pattern memory store',
      details: [
        'All learned design patterns (from previous turns) will be erased.',
        'The canvas itself is not affected.',
      ],
    };
  }

  // Unknown destructive tool (registry drift) — generic copy.
  return {
    toolCallId,
    toolName,
    description: `Run the destructive tool ${toolName}`,
    details: [JSON.stringify(params).slice(0, 300)],
  };
}

/// The tool-result payload the wrapped tool returns when the user DENIES.
/// Written as guidance to the model: acknowledge, don't retry, adapt.
export function deniedToolResult(toolName: string, timedOut: boolean): {
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, unknown>;
  isError: boolean;
} {
  const text = timedOut
    ? `The user did not respond to the approval prompt for ${toolName} within 5 minutes, so the operation was cancelled for safety. Do NOT retry it. Continue with the rest of the task without this step, and mention that the action was skipped.`
    : `The user DENIED the ${toolName} operation. Do NOT retry it and do NOT attempt equivalent destructive workarounds (e.g. deleting shapes one by one). Continue with the rest of the task without this step, and acknowledge the user's choice in your reply.`;
  return {
    content: [{ type: 'text', text }],
    details: { error: 'user_denied', toolName, timedOut },
    isError: true,
  };
}
