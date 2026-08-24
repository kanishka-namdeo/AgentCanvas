// Plugin event bus — lets plugin tools emit SyncEvents during a turn.
//
// The runner's `runAgentNative()` sets a per-turn sink before calling
// `session.prompt()`. Plugin tools call `emitEvent(syncEvent)` to push
// events through the same AgentStreamEvent stream the rest of the runner
// uses. This avoids each plugin needing its own callback wiring.
//
// Why a module-level slot rather than passing a sink through `ctx`?
// The pi-coding-agent SDK passes `ExtensionContext` to tools, but we
// can't add custom fields to that interface. A module-level slot is
// the simplest decoupling — and since the runner is single-threaded
// per request (one agent turn at a time), there's no race.

import type { SyncEvent } from '../../canvas/types';

type EventSink = (event: SyncEvent) => void;

let currentSink: EventSink | null = null;

/// Install the per-turn event sink. Called by runAgentNative() at the
/// start of each turn. Returns a function that un-installs the sink
/// (restoring the previous one, typically null).
export function setEventSink(sink: EventSink | null): () => void {
  const previous = currentSink;
  currentSink = sink;
  return () => {
    currentSink = previous;
  };
}

/// Emit a SyncEvent to the current turn's sink. No-op if no sink is set
/// (e.g. when the tool is called outside an agent turn, which shouldn't
/// happen in practice but is defensive).
export function emitEvent(event: SyncEvent): void {
  if (currentSink) {
    currentSink(event);
  }
}

/// Whether an event sink is currently installed (i.e. we're inside an
/// agent turn). Plugin tools can check this to decide whether to emit
/// rich events or just return text.
export function hasSink(): boolean {
  return currentSink !== null;
}
