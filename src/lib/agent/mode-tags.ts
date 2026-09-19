// mode-tags.ts — Cline-style mode-tagged user messages + switch notices.
//
// RESEARCH BASIS (competitor-research round 3, Cline pattern 5.5):
//   - When the user flips between agent modes (build / ask / plan) mid-
//     conversation, Cline wraps each user message as
//     `<user_input mode="build|ask|plan">…</user_input>` and prepends a
//     `<mode_notice>The user switched from build to ask mode…</mode_notice>`
//     marker to the FIRST post-switch message. The model gets a transcript-
//     visible signal of constraint changes — otherwise the runtime narrows
//     the tool surface but the model keeps the prior mode's behavioral
//     expectations (e.g. still attempts mutating calls it can no longer
//     see, or still answers in build-mode brevity when the user explicitly
//     switched to ask for an explanation).
//   - Round-trips (build→ask→build BEFORE the next prompt is sent) CANCEL
//     the notice — the user changed their mind before the constraint ever
//     bound the model. The tracker below implements this cancellation by
//     storing only the LAST `to` mode and treating a `record(to, to)`-style
//     follow-up (or a `record(to)` matching the pending `to`) as a clear.
//
// WIRING:
//   - The runner imports the singleton `modeSwitchTracker` and, before pushing
//     the user message, calls `modeSwitchTracker.consume()`. If a pending
//     notice exists, it's prepended to the wrapped prompt. The wrapping is
//     `formatUserInputBlock(prompt, currentMode)`.
//   - The UI (AgentPanel.tsx mode picker + the /build /ask /plan slash
//     commands) calls `modeSwitchTracker.record(from, to)` on every mode
//     change. The tracker is a module singleton so a server-side runner and
//     a separate UI path can both reach it (the runner is the consumer; the
//     UI is the producer — there is no cross-process race because the runner
//     only `consume()`s at prompt-send time, after any UI changes have
//     landed).
//
// This module is PURE with respect to its helpers (no runner imports). The
// singleton is mutable by design — it is the cross-call handoff channel.

import type { AgentMode } from './modes';

/// Wrap a user prompt as a Cline-style mode-tagged block:
///   `<user_input mode="build">…</user_input>`
/// The wrapper is a transparent passthrough for the model — the tags are
/// advisory context, not strict XML. Empty input still wraps (an empty
/// `<user_input mode="build"></user_input>` is valid and rare but valid).
export function formatUserInputBlock(input: string, mode: AgentMode): string {
  return `<user_input mode="${mode}">${input}</user_input>`;
}

/// Format the mode-switch notice prepended to the first post-switch user
/// message. Verbatim form (the contract the model sees):
///   `<mode_notice>The user switched from build mode to ask mode before
///    sending this message. Adjust your behavior accordingly.</mode_notice>`
export function formatModeSwitchNotice(from: AgentMode, to: AgentMode): string {
  return (
    `<mode_notice>The user switched from ${from} mode to ${to} mode ` +
    `before sending this message. Adjust your behavior accordingly.</mode_notice>`
  );
}

/// A mode-switch notice tracker. Owns ONE pending notice at a time:
///   - `record(from, to)` — note that the user flipped `from → to`. If a
///     notice was already pending for the same `to` (i.e. a round-trip
///     `from → x → from` happened before consume), the pending notice is
///     CLEARED — the user changed their mind before the constraint bound
///     the model. Recording a same-mode transition (`from === to`) is a
///     no-op (still clears any pending notice, defensively).
///   - `consume()` — return the pending notice string (the formatted
///     `<mode_notice>` block) and clear it, OR return null when no
///     notice is pending. Called by the runner at prompt-send time.
export interface ModeSwitchNoticeTracker {
  record(from: AgentMode, to: AgentMode): void;
  consume(): string | null;
  /// Test/debug helper — true when a notice is pending. Not used by the
  /// runner; exported for unit tests + dev assertions.
  hasPending(): boolean;
}

/// Factory — used both for the module singleton below and for tests that
/// want an isolated tracker. The tracker is intentionally tiny (one
/// `pendingFrom`/`pendingTo` pair) so the cancel-on-round-trip rule is
/// a single equality check.
export function createModeSwitchNoticeTracker(): ModeSwitchNoticeTracker {
  let pendingFrom: AgentMode | null = null;
  let pendingTo: AgentMode | null = null;

  return {
    record(from, to) {
      // A same-mode "switch" is a no-op — defensively clear any pending
      // notice so a stray setSetting('agentMode', sameValue) call from the
      // UI doesn't synthesize a phantom notice.
      if (from === to) {
        pendingFrom = null;
        pendingTo = null;
        return;
      }
      // Round-trip cancellation: a pending notice already exists for the
      // SAME `to` (i.e. the user flipped back to where they started
      // before sending). The constraint never bound the model — clear.
      // Concretely: pending (build→ask) then record(ask→build) → the user
      // is back to build, the ask leg never reached the model, cancel.
      if (pendingTo !== null && pendingTo === from && pendingFrom === to) {
        pendingFrom = null;
        pendingTo = null;
        return;
      }
      // Stacking cancellation: pending (build→ask) then record(ask→plan)
      // — the ask leg never reached the model, the LATEST transition is
      // what the model should see. Replace rather than chain.
      pendingFrom = from;
      pendingTo = to;
    },
    consume() {
      if (pendingFrom === null || pendingTo === null) return null;
      const notice = formatModeSwitchNotice(pendingFrom, pendingTo);
      pendingFrom = null;
      pendingTo = null;
      return notice;
    },
    hasPending() {
      return pendingFrom !== null && pendingTo !== null;
    },
  };
}

/// Module singleton — the cross-call handoff channel between the UI
/// (producer: calls `record()` on mode change) and the runner (consumer:
/// calls `consume()` at prompt-send time). One per process; safe because
/// the runner only consumes at the prompt-send boundary, after any UI
/// changes have landed. Tests that need isolation should call
/// `createModeSwitchNoticeTracker()` for a fresh instance.
export const modeSwitchTracker: ModeSwitchNoticeTracker = createModeSwitchNoticeTracker();
