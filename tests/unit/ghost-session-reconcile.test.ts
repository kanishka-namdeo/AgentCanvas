// Tests for the ghost-session reconciliation in hydrateSessionStore()
// (src/lib/sessions/store.ts).
//
// Bug being guarded against: local sessions whose server rows were deleted
// (another device, or scripts/cleanup-orphan-sessions.ts) lingered in the
// sidebar forever, and interacting with them could re-create orphan server
// rows. hydrateSessionStore() now sweeps local EMPTY sessions that are
// missing from the server's authoritative list, while never touching:
//   - sessions with local content (possible unsynced offline work)
//   - the ACTIVE session (ensure-session re-creates its row on activity)
// And when the server is UNREACHABLE (fetch rejects / non-OK), the local
// cache must be left completely untouched.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useSessionStore, hydrateSessionStore } from '@/lib/sessions/store';
import type { Session } from '@/lib/sessions/types';

// ---- Fixtures ----------------------------------------------------------------

function baseSession(id: string, documentId: string, extra: Partial<Session> = {}): Session {
  const ts = new Date().toISOString();
  return {
    id,
    documentId,
    title: `Session ${id}`,
    status: 'active',
    pinned: false,
    starred: false,
    parentId: null,
    forkedFromMessageId: null,
    forkedFromSnapshotId: null,
    isRoot: true,
    currentSnapshotId: null,
    currentRunId: null,
    lastRunId: null,
    model: 'test-model',
    messageCount: 0,
    runCount: 0,
    toolCallCount: 0,
    messageIds: [],
    runIds: [],
    snapshotIds: [],
    createdAt: ts,
    updatedAt: ts,
    lastOpenedAt: ts,
    archivedAt: null,
    ...extra,
  };
}

const DOC = 'doc-ghost-test';

function seedStore() {
  useSessionStore.setState({
    sessions: {
      'sess-active': baseSession('sess-active', DOC),
      // Ghost shell: empty + missing from the server list → must be swept.
      'sess-ghost': baseSession('sess-ghost', DOC),
      // Content session missing from the server → offline work, must be KEPT.
      'sess-offline': baseSession('sess-offline', DOC, {
        messageIds: ['m1'],
        runIds: ['r1'],
        messageCount: 1,
        runCount: 1,
      }),
    },
    runs: {},
    messages: {},
    toolCalls: {},
    snapshots: {},
    activeSessionByDoc: { [DOC]: 'sess-active' },
  });
}

function flushAsync() {
  // The reconciliation chain is: dynamic import → fetch → setState. The
  // module load needs a real macrotask on the first call, so poll with real
  // timers instead of microtask ticks.
  return vi.waitFor(
    () => {
      if (!('sess-ghost' in useSessionStore.getState().sessions)) return;
      // For the unreachable-server cases the ghost stays — just yield enough
      // for any pending chain to settle; waitFor's timeout provides that.
      throw new Error('ghost still present — chain may still be running');
    },
    { timeout: 300, interval: 10 },
  ).catch(() => {
    // Swallow: tests that EXPECT the ghost to remain will hit the timeout.
    // Tests that expect removal succeed fast. A follow-up settle delay keeps
    // both deterministic.
    return new Promise((r) => setTimeout(r, 350));
  });
}

const serverListBody = (ids: string[]) => ({
  sessions: ids.map((id) => ({
    id,
    documentId: DOC,
    title: `Server ${id}`,
    status: 'active',
    pinned: false,
    runCount: 0,
    toolCallCount: 0,
    snapshotCount: 0,
    lastOpenedAt: new Date().toISOString(),
    parentSessionId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    _count: { messages: 0, runs: 0, snapshots: 0 },
  })),
});

describe('hydrateSessionStore ghost-session reconciliation', () => {
  beforeEach(() => {
    seedStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sweeps local empty sessions missing from the server list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify(serverListBody(['sess-active'])), { status: 200 }),
    ));
    hydrateSessionStore();
    await flushAsync();
    const s = useSessionStore.getState().sessions;
    expect(s['sess-ghost']).toBeUndefined();
    expect(s['sess-active']).toBeDefined();
  });

  it('keeps sessions with local content even when missing from the server', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify(serverListBody(['sess-active'])), { status: 200 }),
    ));
    hydrateSessionStore();
    await flushAsync();
    const s = useSessionStore.getState().sessions;
    expect(s['sess-offline']).toBeDefined();
  });

  it('keeps the ACTIVE session even when missing from the server', async () => {
    // Server list does NOT contain sess-active — but it is active, so keep.
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify(serverListBody(['sess-other'])), { status: 200 }),
    ));
    hydrateSessionStore();
    await flushAsync();
    const s = useSessionStore.getState().sessions;
    expect(s['sess-active']).toBeDefined();
    expect(s['sess-ghost']).toBeUndefined();
  });

  it('leaves the cache untouched when the server is unreachable (non-OK)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    hydrateSessionStore();
    await flushAsync();
    const s = useSessionStore.getState().sessions;
    expect(Object.keys(s).sort()).toEqual(['sess-active', 'sess-ghost', 'sess-offline']);
  });

  it('leaves the cache untouched when fetch rejects (offline)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network down'); }));
    hydrateSessionStore();
    await flushAsync();
    const s = useSessionStore.getState().sessions;
    expect(Object.keys(s).sort()).toEqual(['sess-active', 'sess-ghost', 'sess-offline']);
  });
});
