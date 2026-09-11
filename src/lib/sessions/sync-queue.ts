// Persistent offline queue for server sync — bridges the gap when the server
// is temporarily unreachable. Modeled after the canvas outbox pattern
// (src/lib/canvas/client-mutations.ts) which uses localStorage with a cap.
//
// When a server sync fails (network error, server down, etc.), the request
// is queued here. On reconnect (online event), the queue is drained in order.
// Each entry has exponential backoff (1s, 4s, 16s, 64s, 256s) up to 5 attempts.
//
// localStorage key: `agentcanvas.sync-queue.v1`
// Cap: 200 entries (drop-oldest when exceeded)

const SYNC_QUEUE_KEY = 'agentcanvas.sync-queue.v1';
const SYNC_QUEUE_CAP = 200;
const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 1000; // 1 second

export interface SyncQueueEntry {
  id: string;
  endpoint: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body: string | null;
  attempts: number;
  createdAt: number;
  lastAttemptAt: number;
  nextRetryAt: number;
}

/// Read the queue from localStorage. Returns [] on parse failure.
function readQueue(): SyncQueueEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(SYNC_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/// Write the queue to localStorage. Silently fails on quota exceeded.
function writeQueue(queue: SyncQueueEntry[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SYNC_QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // Quota exceeded — the queue is lost, but the app keeps working.
    // The quota-aware toast (Task 1) already warned the user.
  }
}

/// Enqueue a failed sync request. Drops the oldest entry if the cap is exceeded.
export function enqueueSync(entry: Omit<SyncQueueEntry, 'id' | 'attempts' | 'createdAt' | 'lastAttemptAt' | 'nextRetryAt'>): void {
  const queue = readQueue();
  const now = Date.now();
  const newEntry: SyncQueueEntry = {
    ...entry,
    id: `sync_${now}_${Math.random().toString(36).slice(2, 9)}`,
    attempts: 0,
    createdAt: now,
    lastAttemptAt: 0,
    nextRetryAt: now, // Retry immediately on first attempt.
  };
  queue.push(newEntry);

  // Drop-oldest cap enforcement.
  if (queue.length > SYNC_QUEUE_CAP) {
    const dropped = queue.length - SYNC_QUEUE_CAP;
    queue.splice(0, dropped);
  }

  writeQueue(queue);

  // Attempt immediately.
  void processEntry(newEntry);
}

/// Read-modify-write helper. MUST be used for every post-await mutation:
/// concurrent processEntry calls each suspend at `await fetch`, so writing
/// back a queue snapshot captured before the await would clobber sibling
/// entries' concurrently-written state (stale-snapshot race).
function mutateQueue(fn: (queue: SyncQueueEntry[]) => void): void {
  const queue = readQueue();
  fn(queue);
  writeQueue(queue);
}

/// Process a single queue entry: attempt the fetch, re-queue on failure.
async function processEntry(entry: SyncQueueEntry): Promise<void> {
  const now = Date.now();

  // Respect backoff timing.
  if (now < entry.nextRetryAt) {
    return;
  }

  if (readQueue().findIndex((e) => e.id === entry.id) === -1) return; // Already removed.

  // Update attempt tracking.
  entry.attempts++;
  entry.lastAttemptAt = now;

  try {
    const res = await fetch(entry.endpoint, {
      method: entry.method,
      headers: entry.body ? { 'content-type': 'application/json' } : undefined,
      body: entry.body,
    });

    if (res.ok) {
      // Success — remove from queue (fresh read: siblings may have mutated
      // while we were awaiting).
      mutateQueue((queue) => {
        const idx = queue.findIndex((e) => e.id === entry.id);
        if (idx !== -1) queue.splice(idx, 1);
      });
      return;
    }

    // Non-OK response — treat as failure.
    throw new Error(`HTTP ${res.status}`);
  } catch {
    // Failure — update retry timing or drop if max attempts exceeded.
    if (entry.attempts >= MAX_ATTEMPTS) {
      // Max attempts reached — drop the entry.
      mutateQueue((queue) => {
        const idx = queue.findIndex((e) => e.id === entry.id);
        if (idx !== -1) queue.splice(idx, 1);
      });
      return;
    }

    // Exponential backoff: 1s, 4s, 16s, 64s, 256s.
    const backoffMs = BACKOFF_BASE_MS * Math.pow(4, entry.attempts - 1);
    entry.nextRetryAt = Date.now() + backoffMs;
    mutateQueue((queue) => {
      const idx = queue.findIndex((e) => e.id === entry.id);
      if (idx !== -1) queue[idx] = entry;
    });

    // Schedule retry.
    setTimeout(() => {
      void processEntry(entry);
    }, backoffMs);
  }
}

/// Flush the entire queue (called on `online` event).
/// Processes entries in order, respecting their backoff timing.
export function flushQueue(): void {
  const queue = readQueue();
  const now = Date.now();

  // Filter to entries that are ready to retry.
  const ready = queue.filter((e) => now >= e.nextRetryAt);

  for (const entry of ready) {
    void processEntry(entry);
  }
}

/// Get the current queue size (for UI badge / debugging).
export function getQueueSize(): number {
  return readQueue().length;
}

/// Clear the entire queue (for testing / manual reset).
export function clearQueue(): void {
  writeQueue([]);
}

/// Initialize the queue: set up the `online` event listener to flush on reconnect.
/// Call this once at app startup (e.g., in the session store init).
export function initSyncQueue(): () => void {
  if (typeof window === 'undefined') return () => {};

  const onOnline = () => {
    flushQueue();
  };

  window.addEventListener('online', onOnline);

  // Return cleanup function.
  return () => {
    window.removeEventListener('online', onOnline);
  };
}
