// Active agent-run registry (Phase B, R4) — the backing store for
// GET /api/documents/[documentId]/agent/status.
//
// The registry is written by the /api/agent route itself (the single choke
// point every run flows through — WS-driven via canvas-sync's fetch AND the
// client's direct HTTP fallback), NOT by server.ts's activeRuns abort map:
// that map is module-private to the socket service and imports it here would
// drag the port listener into the route bundle.
//
// Mounting the Map on globalThis (the src/lib/db.ts precedent) makes the
// instance shared across the dev-server's route bundles regardless of module
// resolution quirks (alias vs relative import paths).
//
// Semantics: one ACTIVE run per document (matches the relay's single
// activeRuns entry + the canvas's agentBusy model). register returns an
// identity token; unregister is identity-checked so a stale teardown from an
// aborted run never clobbers a newer run's entry.

export interface ActiveRunInfo {
  documentId: string;
  startedAt: number;
  sessionId?: string;
  runId?: string;
  promptPreview?: string;
}

interface RunRegistryGlobal {
  __agentCanvasRunRegistry?: Map<string, ActiveRunInfo>;
}

const g = globalThis as RunRegistryGlobal;
const registry: Map<string, ActiveRunInfo> =
  g.__agentCanvasRunRegistry ?? new Map<string, ActiveRunInfo>();
g.__agentCanvasRunRegistry = registry;

/// Register the document's active run. Returns the identity token the run's
/// teardown MUST pass back to unregister.
export function registerActiveRun(
  documentId: string,
  meta: { sessionId?: string; runId?: string; promptPreview?: string } = {},
): ActiveRunInfo {
  const info: ActiveRunInfo = {
    documentId,
    startedAt: Date.now(),
    ...meta,
  };
  registry.set(documentId, info);
  return info;
}

/// Identity-checked unregister: a token from an older run never removes a
/// newer run's entry (the same guard server.ts's activeRuns delete uses).
export function unregisterActiveRun(documentId: string, token: ActiveRunInfo): void {
  if (registry.get(documentId) === token) {
    registry.delete(documentId);
  }
}

/// The document's active run, or null. Pure read — the status route shapes it.
export function getActiveRun(documentId: string): ActiveRunInfo | null {
  return registry.get(documentId) ?? null;
}

/// Test hook — clear the registry (suite isolation).
export function __clearRunRegistryForTests(): void {
  registry.clear();
}
