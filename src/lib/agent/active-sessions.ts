// Active agent-session registry (R8c — real steer).
//
// The pi SDK's AgentSession supports `steer(text)` — queue a user message into
// the RUNNING turn (the model sees it after the current tool batch, before the
// next LLM call). But the session lives as a local variable inside
// runner-native's generator, while the steer request arrives on the
// canvas-sync socket — different call stacks, same Next.js process.
//
// This module is the tiny bridge: the runner registers its session (keyed by
// documentId) when it starts a turn and unregisters it on dispose (identity-
// checked, so a stale unregister never evicts a newer run — the same pattern
// as `activeRuns` in canvas/server.ts). The socket handler calls
// `steerActiveSession(documentId, text)`.
//
// If the document has no registered session the steer is rejected (returns
// false) — the caller surfaces that instead of silently dropping the message,
// which was the old fake-broadcast behavior's worst property: the UI claimed
// "Steer sent" while nothing ever reached the model.

/// Minimal structural type — avoids importing the SDK type into this module
/// (keeps it unit-testable without the SDK's runtime).
export interface SteerableSession {
  steer(text: string, images?: unknown[]): Promise<void> | void;
}

const activeSessions = new Map<string, SteerableSession>();

/**
 * Register `session` as the document's active steerable session.
 * Returns an unregister function — safe to call multiple times; only the
 * registration that still matches `session` is removed.
 */
export function registerActiveSession(documentId: string, session: SteerableSession): () => void {
  activeSessions.set(documentId, session);
  return () => {
    // Identity check: a retried/fallback run replaces the map entry; the OLD
    // attempt's cleanup must not evict the NEW session.
    if (activeSessions.get(documentId) === session) {
      activeSessions.delete(documentId);
    }
  };
}

/**
 * Queue a steering message into the document's running agent turn.
 * Returns true when a live session accepted it; false when there is no
 * active run to steer (caller should surface the rejection).
 */
export async function steerActiveSession(documentId: string, text: string): Promise<boolean> {
  const session = activeSessions.get(documentId);
  if (!session || typeof session.steer !== 'function') return false;
  try {
    await session.steer(text);
    return true;
  } catch {
    // A disposed/errored session can still be registered (dispose and
    // unregister race). Drop it so the next steer doesn't hit a corpse.
    if (activeSessions.get(documentId) === session) {
      activeSessions.delete(documentId);
    }
    return false;
  }
}

/** Test/inspection hook: is a session currently registered for the doc? */
export function hasActiveSession(documentId: string): boolean {
  return activeSessions.has(documentId);
}

/** Test hook: clear every registration (tests must not leak sessions). */
export function __clearActiveSessions(): void {
  activeSessions.clear();
}
