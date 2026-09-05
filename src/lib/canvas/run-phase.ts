// Canonical agent run-phase model (2026-09-05 UI-consistency contract).
//
// THE PROBLEM THIS MODULE SOLVES
// ------------------------------
// Before this contract, "the agent is running" was represented by at least
// three parallel vocabularies (canvas-store `agentBusy` boolean, session-store
// `RunStatus`, component-local busy flags) and rendered through a zoo of
// affordances (opacity-30/40/50/60 disabled styles, ping dots, pulse dots,
// spinners, "Running…" / "Running..." / "Thinking…" / "agent is working…"
// strings). Two sources of truth could disagree (a live server-side run with
// a client that never re-armed `agentBusy`), and equivalent controls behaved
// differently (toolbar shape buttons disabled while the same mutations via
// keyboard/panels went straight through).
//
// THE CONTRACT
// ------------
// 1. ONE canonical phase, owned by the canvas store (`runPhase`). The legacy
//    `agentBusy` boolean is kept as a lockstep mirror (live phase ⇔ true) so
//    existing selectors keep working — the two are written together through
//    `phaseFields()` and can never disagree.
// 2. ONE busy-control rule set (what disables, what stays live) — enforced at
//    the store choke points (`sendPatch` / `undo` / `redo` /
//    `restoreSnapshot` / `promptAgent`) so every surface (toolbar, keyboard,
//    panels, menus, palette, gestures) converges without per-callback guards.
// 3. ONE visual language: `Loader2 animate-spin` for controls, a single
//    pulsing dot for compact rows, the `.ac-busy` class for every disabled
//    affordance (native `disabled` or `aria-disabled`).
// 4. ONE vocabulary — the labels below are the only user-visible busy-state
//    strings (no "agent paused", no "Running...", no "working…").
//
// Phase transitions (owner: store.ts reducers + actions):
//   promptAgent / message_start  → thinking   (arms busy for EVERY viewer)
//   tool_call_start              → tool
//   tool_call_end                → thinking
//   message_delta (from thinking)→ finalizing
//   plan_proposed / ask_user     → awaiting_input
//   stopAgent                    → cancelling
//   turn_end / turn_final        → completed  (busy cleared)
//   turn_cancelled               → cancelled  (busy cleared)
//   error                        → failed     (busy cleared)
//   stuck                        → stuck      (busy cleared)

export type RunPhase =
  /// No run in flight. Every control is fully live.
  | 'idle'
  /// Model is reasoning (armed at promptAgent for the prompting client, at
  /// message_start for every other viewer and reconnect/reload catch-up).
  | 'thinking'
  /// A tool call is executing (canvas mutations are in flight).
  | 'tool'
  /// The agent is blocked waiting for the user (plan approval, ask-user
  /// question). Busy-but-interactive: the approval UI stays live.
  | 'awaiting_input'
  /// Assistant text is streaming after the tools ran.
  | 'finalizing'
  /// Stop was requested; waiting for the server-side abort to confirm.
  | 'cancelling'
  // ---- Terminal phases (busy = false) --------------------------------
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'stuck';

/// Phases during which a run is LIVE (the `agentBusy` mirror is true).
/// Gated controls derive their disabled state from exactly this set.
export const LIVE_RUN_PHASES: ReadonlySet<RunPhase> = new Set<RunPhase>([
  'thinking',
  'tool',
  'awaiting_input',
  'finalizing',
  'cancelling',
]);

export const isLiveRunPhase = (phase: RunPhase): boolean => LIVE_RUN_PHASES.has(phase);

/// The single user-visible label per phase. Terminal phases read as past
/// tense; live phases are verb-first with an ellipsis (NN/g progress-copy
/// convention). Every busy-state surface (StatusBadge inputs, BusyRow,
/// RunStopButton, ARIA announcements) sources its text from here.
export const RUN_PHASE_LABEL: Readonly<Record<RunPhase, string>> = {
  idle: 'Idle',
  thinking: 'Thinking…',
  tool: 'Running tools…',
  awaiting_input: 'Waiting for you…',
  finalizing: 'Writing response…',
  cancelling: 'Stopping…',
  completed: 'Completed',
  cancelled: 'Stopped',
  failed: 'Run failed',
  stuck: 'Stuck',
};

/// Standard tooltip suffix for every control gated by a live phase — the
/// disabled affordance always explains WHY it is inactive (Nielsen: inactive
/// controls need an explanation, never a dead gray button).
export const BUSY_LOCK_HINT = 'Stop the agent first';

/// Map a session-store terminal RunStatus onto the canonical phase (used by
/// the journal-replay path, where terminal state arrives as a RunStatus).
export function runStatusToPhase(status: string): RunPhase {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'stuck':
    case 'incomplete':
      return 'stuck';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'completed';
  }
}

/// State patch that keeps `runPhase` and the legacy `agentBusy` mirror in
/// lockstep. The ONLY sanctioned way to change the phase inside a `set()`.
export function phaseFields(phase: RunPhase): { runPhase: RunPhase; agentBusy: boolean } {
  return { runPhase: phase, agentBusy: isLiveRunPhase(phase) };
}
