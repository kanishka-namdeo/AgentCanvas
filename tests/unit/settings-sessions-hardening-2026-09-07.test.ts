// Settings/sessions UI hardening (2026-09-07, Task 12-c → 12-e) — regression
// tests.
//
// Each block pins one 12-c finding:
//   1. settings store (12-c#3): sanitizePersistedSettings + the custom
//      persist merge — a poisoned `agentcanvas.settings.v1` (string/null
//      temperature, NaN maxIterations) rehydrates to safe values instead of
//      crashing SettingsDialog's `temperature.toFixed(1)` (white screen —
//      there is no error boundary anywhere in src/). v5 migration semantics
//      stay intact (the v4 → v5 old-defaults rewrite still runs).
//   2. sessions store migrate (12-c#9): primitive rows (`snapshots: "abc"`
//      spreads to {'0':'a',…}) no longer throw a strict-mode TypeError —
//      which zustand's toThenable catch swallowed, silently dropping the
//      ENTIRE persisted dataset to defaults.
//   3. sessions store merge (12-c#11): malformed session rows (missing
//      string documentId/id) are dropped before they can reach the sidebar
//      sort; compareByLastOpenedDesc tolerates missing/non-string
//      lastOpenedAt (sorts LAST) instead of crashing localeCompare.
//   4. deleteSession (12-c#4): the delete now fires the server-side DELETE
//      (was local-only — deleted chats resurrected on reload via
//      hydrateSessionStore's merge); archive/unarchive mirror status.
//   5. SessionSidebar search (12-c#10): request-sequence token — only the
//      latest query's response may land in setHits.
//   6. useModelCatalog (12-c#6): request-sequence token — a response
//      superseded by a settings-change invalidate is discarded (no
//      stale-response-over-newer-selection), and the spinner never sticks.
//   7. SettingsDialog export (12-c#7/#8): apiKey redacted by default; a
//      corrupted sessions blob fails with an honest toast instead of a
//      silent click-handler death.
//
// Patterns reused from the existing suites: vi.stubGlobal('fetch', …) +
// new Response(…) (ghost-session-reconcile.test.ts), RTL render/fireEvent
// (interaction-consistency-2026-09-05.test.tsx), source scans
// (multiturn-abuse-2026-09-07.test.ts).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup, renderHook } from '@testing-library/react';
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toast } from 'sonner';
import { useSettings, sanitizePersistedSettings } from '@/lib/settings/store';
import { DEFAULT_SETTINGS } from '@/lib/settings/types';
import {
  useSessionStore,
  compareByLastOpenedDesc,
  __flushThrottledSessionPersist,
} from '@/lib/sessions/store';
import type { Session } from '@/lib/sessions/types';
import { SessionSidebar } from '@/components/sessions/SessionSidebar';
import { SettingsDialog } from '@/components/settings/SettingsDialog';
import { useModelCatalog } from '@/hooks/use-model-catalog';

// sonner toasts are mocked — assertions inspect the calls, not the Toaster.
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

const ROOT = process.cwd();
const readSrc = (rel: string) => readFileSync(join(ROOT, 'src', rel), 'utf-8');

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
    currentRunId: null,
    lastRunId: null,
    model: 'test-model',
    messageCount: 0,
    runCount: 0,
    toolCallCount: 0,
    messageIds: [],
    runIds: [],
    tags: [],
    createdAt: ts,
    updatedAt: ts,
    lastOpenedAt: ts,
    archivedAt: null,
    ...extra,
  };
}

function emptyDataset() {
  return {
    sessions: {},
    runs: {},
    messages: {},
    toolCalls: {},
    snapshots: {},
    activeSessionByDoc: {},
  };
}

/// Seed the sessions localStorage fixture (flushing any pending throttled
/// write from a previous test first so it can't clobber the fixture).
function seedSessionsLocalStorage(state: unknown, version: number) {
  __flushThrottledSessionPersist();
  localStorage.setItem('agentcanvas.sessions.v1', JSON.stringify({ state, version }));
}

async function rehydrateSessions() {
  await (useSessionStore as unknown as { persist: { rehydrate: () => Promise<void> | void } })
    .persist.rehydrate();
}

async function blobText(b: Blob): Promise<string> {
  if (typeof b.text === 'function') return b.text();
  // jsdom Blob fallback — undici Response accepts any Blob-like.
  return new Response(b).text();
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
  localStorage.clear();
});

// ---- 1. Settings store: rehydrate sanitize (12-c#3) --------------------------

describe('settings store: sanitizePersistedSettings (12-c#3)', () => {
  it('string/null temperature → 0.6; NaN maxIterations → 24; clamps applied', () => {
    expect(sanitizePersistedSettings({ temperature: '0.6' })).toEqual({ temperature: 0.6 });
    expect(sanitizePersistedSettings({ temperature: null })).toEqual({ temperature: 0.6 });
    expect(sanitizePersistedSettings({ temperature: 'garbage' })).toEqual({ temperature: 0.6 });
    expect(sanitizePersistedSettings({ maxIterations: NaN })).toEqual({ maxIterations: 24 });
    expect(sanitizePersistedSettings({ maxIterations: 'many' })).toEqual({ maxIterations: 24 });
    // Clamps: temperature [0,2], maxIterations [1,50] (rounded to int).
    expect(sanitizePersistedSettings({ temperature: 99 })).toEqual({ temperature: 2 });
    expect(sanitizePersistedSettings({ temperature: -5 })).toEqual({ temperature: 0 });
    expect(sanitizePersistedSettings({ maxIterations: 999 })).toEqual({ maxIterations: 50 });
    expect(sanitizePersistedSettings({ maxIterations: 0 })).toEqual({ maxIterations: 1 });
    expect(sanitizePersistedSettings({ maxIterations: 12.7 })).toEqual({ maxIterations: 13 });
    // Valid values pass through untouched.
    expect(sanitizePersistedSettings({ temperature: 0.7, maxIterations: 30 }))
      .toEqual({ temperature: 0.7, maxIterations: 30 });
  });

  it('string fields coerce non-strings to "", booleans to Boolean(x)', () => {
    expect(
      sanitizePersistedSettings({ apiKey: 42, llmProvider: null, modelName: {}, apiBaseUrl: true }),
    ).toEqual({ apiKey: '', llmProvider: '', modelName: '', apiBaseUrl: '' });
    expect(sanitizePersistedSettings({ planFirst: 'yes' })).toEqual({ planFirst: true });
    expect(sanitizePersistedSettings({ domCulling: 0 })).toEqual({ domCulling: false });
    // Non-object blob emits nothing (defaults survive via the merge spread).
    expect(sanitizePersistedSettings('garbage')).toEqual({});
    expect(sanitizePersistedSettings(null)).toEqual({});
  });

  it('absent fields are not emitted — defaults survive', () => {
    expect(sanitizePersistedSettings({ temperature: 0.7 })).toEqual({ temperature: 0.7 });
    expect(sanitizePersistedSettings({})).toEqual({});
    expect(Object.keys(sanitizePersistedSettings({ temperature: 0.7 }))).toEqual(['temperature']);
  });
});

describe('settings store: poisoned localStorage rehydrates safely (12-c#3)', () => {
  it('persist.rehydrate() sanitizes a poisoned v5 blob and .toFixed no longer throws', async () => {
    localStorage.setItem('agentcanvas.settings.v1', JSON.stringify({
      state: {
        temperature: '0.6',
        maxIterations: null,
        apiKey: 123,
        llmProvider: 'custom',
        modelName: 'qwen3.7-plus',
        apiBaseUrl: 'https://irhnglwoxe.a.pinggy.link/v1',
      },
      version: 5,
    }));
    await act(async () => {
      await (useSettings as unknown as { persist: { rehydrate: () => Promise<void> | void } })
        .persist.rehydrate();
    });
    const s = useSettings.getState();
    expect(s.temperature).toBe(0.6);
    expect(typeof s.temperature).toBe('number');
    // The exact crash the finding describes (SettingsDialog:225):
    expect(() => s.temperature.toFixed(1)).not.toThrow();
    expect(s.maxIterations).toBe(24);
    expect(s.apiKey).toBe('');
    // Unknown fields still flow through the merge (default-merge semantics
    // preserved for everything outside the sanitize list).
    expect(s.modelName).toBe('qwen3.7-plus');
    expect(s.apiBaseUrl).toBe('https://irhnglwoxe.a.pinggy.link/v1');
  });

  it('v5 migration semantics stay intact: v4 old-defaults rewrite still runs', async () => {
    localStorage.setItem('agentcanvas.settings.v1', JSON.stringify({
      state: {
        // The kimi-k2-5 / pinggy / '123456' old-defaults shape → rewritten to
        // the CURRENT DEFAULT_SETTINGS (qwen3.7-plus BETA endpoint) by the
        // v4 → v5 migrate, while the poisoned temperature is sanitized in
        // the merge afterwards.
        llmProvider: 'custom',
        modelName: 'kimi-k2-5',
        apiKey: '123456',
        apiBaseUrl: 'https://irhnglwoxe.a.pinggy.link/v1',
        temperature: 'bogus',
      },
      version: 4,
    }));
    await act(async () => {
      await (useSettings as unknown as { persist: { rehydrate: () => Promise<void> | void } })
        .persist.rehydrate();
    });
    const s = useSettings.getState();
    expect(s.modelName).toBe(DEFAULT_SETTINGS.modelName);
    expect(s.llmProvider).toBe(DEFAULT_SETTINGS.llmProvider);
    expect(s.temperature).toBe(0.6);
  });
});

// ---- 2. Sessions store: migrate guards (12-c#9) -------------------------------

describe('sessions store: migrate guards (12-c#9)', () => {
  it('migrate() does not throw on primitive snapshots (direct invocation)', () => {
    const migrate = (useSessionStore as unknown as {
      persist: { getOptions: () => { migrate?: (p: unknown, v: number) => unknown } };
    }).persist.getOptions().migrate;
    expect(migrate).toBeTypeOf('function');
    const run = migrate as (p: unknown, v: number) => unknown;
    // Pre-fix this threw a strict-mode TypeError assigning `.documentId` on
    // a primitive ('a'), which zustand swallowed → whole dataset dropped.
    expect(() => run({ sessions: {}, snapshots: 'abc' }, 1)).not.toThrow();
    expect(() => run({ sessions: 'xyz', snapshots: {} }, 1)).not.toThrow();
  });

  it('primitive snapshots rehydrate without dropping the rest of the dataset', async () => {
    seedSessionsLocalStorage({
      ...emptyDataset(),
      sessions: { 'sess-keep': baseSession('sess-keep', 'demo') },
      snapshots: 'abc', // poisoned — spreads to {'0':'a','1':'b','2':'c'}
    }, 1);
    await rehydrateSessions();
    const s = useSessionStore.getState();
    expect(s.sessions['sess-keep']).toBeDefined();
    expect(Object.keys(s.snapshots)).toEqual([]);
  });

  it('primitive session rows are skipped, not adopted', async () => {
    seedSessionsLocalStorage({
      ...emptyDataset(),
      sessions: {
        'sess-keep': baseSession('sess-keep', 'demo'),
        'sess-string': 'garbage',
        'sess-number': 42,
      },
    }, 1);
    await rehydrateSessions();
    const s = useSessionStore.getState();
    expect(s.sessions['sess-keep']).toBeDefined();
    expect(s.sessions['sess-string']).toBeUndefined();
    expect(s.sessions['sess-number']).toBeUndefined();
  });
});

// ---- 3. Sessions store: merge sanitize + safe sort (12-c#11) -------------------

describe('sessions store: rehydrate merge drops malformed rows (12-c#11)', () => {
  it('drops session rows missing a string documentId/id', async () => {
    seedSessionsLocalStorage({
      ...emptyDataset(),
      sessions: {
        'sess-good': baseSession('sess-good', 'demo'),
        'sess-no-doc': { ...baseSession('sess-no-doc', 'demo'), documentId: 42 },
        'sess-no-id': { title: 'no id' },
      },
      activeSessionByDoc: { demo: 'sess-good', 'nope': 7 },
    }, 2);
    await rehydrateSessions();
    const s = useSessionStore.getState();
    expect(s.sessions['sess-good']).toBeDefined();
    expect(s.sessions['sess-no-doc']).toBeUndefined();
    expect(s.sessions['sess-no-id']).toBeUndefined();
    expect(s.activeSessionByDoc).toEqual({ demo: 'sess-good' });
  });

  it('malformed-but-plausible session rows no longer crash listSessions sort', async () => {
    seedSessionsLocalStorage({
      ...emptyDataset(),
      sessions: {
        'sess-ok': baseSession('sess-ok', 'demo', { lastOpenedAt: '2026-09-01T00:00:00.000Z' }),
        // documentId + status present (passes the drop filter) but
        // lastOpenedAt is missing — the exact pre-fix sidebar-sort crash.
        'sess-malformed': {
          ...baseSession('sess-malformed', 'demo'),
          lastOpenedAt: undefined,
        },
      },
    }, 2);
    await rehydrateSessions();
    expect(() => useSessionStore.getState().listSessions({ documentId: 'demo' })).not.toThrow();
    const list = useSessionStore.getState().listSessions({ documentId: 'demo' });
    expect(list.map((x) => x.id)).toEqual(['sess-ok', 'sess-malformed']);
  });
});

describe('compareByLastOpenedDesc (12-c#11)', () => {
  it('sorts newest-first for valid ISO strings', () => {
    const rows = [
      { lastOpenedAt: '2026-01-01T00:00:00.000Z' },
      { lastOpenedAt: '2026-06-01T00:00:00.000Z' },
      { lastOpenedAt: '2025-01-01T00:00:00.000Z' },
    ];
    expect([...rows].sort(compareByLastOpenedDesc).map((r) => r.lastOpenedAt)).toEqual([
      '2026-06-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      '2025-01-01T00:00:00.000Z',
    ]);
  });

  it('the old comparator crashed on a missing lastOpenedAt — the new one sorts it LAST', () => {
    // Pin the pre-fix failure mode so the guard can't silently regress: the
    // old inline comparator called `.localeCompare` on the other row's
    // (possibly undefined) lastOpenedAt — a TypeError when invoked.
    const oldComparator = (a: unknown, b: unknown) =>
      (b as { lastOpenedAt?: string }).lastOpenedAt!.localeCompare(
        (a as { lastOpenedAt?: string }).lastOpenedAt!,
      );
    expect(() => oldComparator({ lastOpenedAt: 'x' }, {})).toThrow();
    // New comparator: no throw, malformed rows trail the valid one.
    const rows = [
      { lastOpenedAt: undefined },
      { lastOpenedAt: '2026-06-01T00:00:00.000Z' },
      {},
      { lastOpenedAt: 42 },
    ];
    const sorted = [...rows].sort(compareByLastOpenedDesc);
    expect(sorted[0].lastOpenedAt).toBe('2026-06-01T00:00:00.000Z');
    expect(sorted.slice(1).every((r) => r.lastOpenedAt !== '2026-06-01T00:00:00.000Z')).toBe(true);
  });
});

// ---- 4. deleteSession / archive / unarchive server sync (12-c#4) ---------------

describe('deleteSession / archiveSession server sync (12-c#4)', () => {
  function seedOne(id: string) {
    useSessionStore.setState({
      ...emptyDataset(),
      sessions: { [id]: baseSession(id, 'demo') },
      activeSessionByDoc: { demo: id },
    });
  }

  it('deleteSession fires the server DELETE and deletes locally at once', async () => {
    seedOne('sess-del');
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    useSessionStore.getState().deleteSession('sess-del');
    // Local delete is immediate — the UI never waits on the network.
    expect(useSessionStore.getState().sessions['sess-del']).toBeUndefined();
    // The server DELETE lands via the dynamic-import chain (was ZERO call
    // sites — deleted chats resurrected on reload).
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/sessions/sess-del', { method: 'DELETE' });
    });
  });

  it('deleteSession tolerates a rejecting fetch (fire-and-forget)', async () => {
    seedOne('sess-del-offline');
    const fetchMock = vi.fn(async () => { throw new TypeError('network down'); });
    vi.stubGlobal('fetch', fetchMock);
    expect(() => useSessionStore.getState().deleteSession('sess-del-offline')).not.toThrow();
    expect(useSessionStore.getState().sessions['sess-del-offline']).toBeUndefined();
    await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalled(); });
  });

  it('archiveSession / unarchiveSession mirror the status server-side', async () => {
    seedOne('sess-arch');
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    useSessionStore.getState().archiveSession('sess-arch');
    expect(useSessionStore.getState().sessions['sess-arch']?.status).toBe('archived');
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/sessions/sess-arch',
        expect.objectContaining({ method: 'PATCH' }),
      );
    });
    const bodies = () =>
      fetchMock.mock.calls
        .filter(([url]) => url.includes('/api/sessions/sess-arch'))
        .map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies()).toContainEqual({ status: 'archived' });

    useSessionStore.getState().unarchiveSession('sess-arch');
    expect(useSessionStore.getState().sessions['sess-arch']?.status).toBe('active');
    await vi.waitFor(() => {
      expect(bodies()).toContainEqual({ status: 'active' });
    });
  });
});

// ---- 5. SessionSidebar search: stale-response discard (12-c#10) ----------------

describe('SessionSidebar debounced search: stale-response guard (12-c#10)', () => {
  /// Deferred-search fetch stub: each /api/sessions/search call parks in
  /// `pending` until the test resolves it — controlling response ORDER.
  let pending: Array<{ q: string; resolve: (hits: unknown) => void }> = [];

  function stubDeferredSearchFetch() {
    pending = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/api/sessions/search')) {
        const q = new URL(u, 'http://localhost').searchParams.get('q') ?? '';
        return new Promise<Response>((resolve) => {
          pending.push({ q, resolve: (hits: unknown) => resolve(new Response(JSON.stringify({ hits }), { status: 200 })) });
        });
      }
      return new Response('{}', { status: 200 });
    }));
  }

  function hitFor(sessionId: string) {
    return {
      sessionId,
      documentId: 'default',
      title: `Session ${sessionId}`,
      status: 'active',
      pinned: false,
      lastOpenedAt: new Date().toISOString(),
      messageCount: 1,
      runCount: 1,
      matchIn: ['title' as const],
      snippet: null,
    };
  }

  it('a slow response for an older query cannot overwrite the newer query\'s hits', async () => {
    vi.useFakeTimers();
    stubDeferredSearchFetch();
    // Two local sessions on the canvas store's default document ('default').
    useSessionStore.setState({
      ...emptyDataset(),
      sessions: {
        'sess-a': baseSession('sess-a', 'default'),
        'sess-b': baseSession('sess-b', 'default'),
      },
    });
    render(createElement(SessionSidebar));
    const input = screen.getByPlaceholderText('Search chats…') as HTMLInputElement;

    // Type "ab" → debounce fires → fetch for 'ab' parks.
    fireEvent.change(input, { target: { value: 'ab' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(pending.map((p) => p.q)).toEqual(['ab']);

    // Keep typing to "abc" → newer fetch parks.
    fireEvent.change(input, { target: { value: 'abc' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(pending.map((p) => p.q)).toEqual(['ab', 'abc']);

    // The NEWER query resolves FIRST with hit sess-b …
    await act(async () => {
      pending[1].resolve([hitFor('sess-b')]);
      await Promise.resolve();
    });
    expect(screen.getByText('Session sess-b')).toBeInTheDocument();

    // … then the older, slower 'ab' response arrives with hit sess-a and
    // must be DISCARDED (pre-fix it overwrote the newer hits).
    await act(async () => {
      pending[0].resolve([hitFor('sess-a')]);
      await Promise.resolve();
    });
    expect(screen.getByText('Session sess-b')).toBeInTheDocument();
    expect(screen.queryByText('Session sess-a')).not.toBeInTheDocument();
  });
});

// ---- 6. useModelCatalog: stale-response discard (12-c#6) ------------------------

describe('useModelCatalog: request-sequence token (12-c#6)', () => {
  it('discards a response superseded by a settings-change invalidate; spinner never sticks', async () => {
    // Deferred /api/models responses — one per fetch call.
    const deferreds: Array<(body: unknown) => void> = [];
    vi.stubGlobal('fetch', vi.fn(async () => new Promise<Response>((resolve) => {
      deferreds.push((body: unknown) => resolve(new Response(JSON.stringify(body), { status: 200 })));
    })));

    const { result } = renderHook(() => useModelCatalog({ invalidateOnSettingsChange: true }));

    // First fetch resolves — the cache holds the OLD endpoint's listing.
    act(() => { void result.current.refresh(); });
    expect(result.current.loading).toBe(true);
    await act(async () => {
      deferreds[0]({
        provider: {
          provider: 'custom', label: 'OLD', source: 'endpoint', ready: true,
          models: [{ id: 'old-model', name: 'Old', contextWindow: 1, maxTokens: 1, reasoning: false, input: ['text'] }],
        },
        zaiSandbox: null,
      });
      await Promise.resolve();
    });
    expect(result.current.data?.provider.models[0]?.id).toBe('old-model');
    expect(result.current.loading).toBe(false);

    // Second fetch starts (user clicked "Live") …
    act(() => { void result.current.refresh(); });
    expect(result.current.loading).toBe(true);

    // … and mid-flight the user applies a different endpoint preset —
    // invalidate clears the cache AND marks the in-flight response stale.
    act(() => { useSettings.setState({ llmProvider: 'zai' }); });
    expect(result.current.data).toBeNull();

    // The OLD-endpoint response finally resolves — must be DISCARDED (the
    // pre-fix bug re-populated the just-cleared cache with stale models).
    await act(async () => {
      deferreds[1]({
        provider: {
          provider: 'custom', label: 'OLD', source: 'endpoint', ready: true,
          models: [{ id: 'old-model', name: 'Old', contextWindow: 1, maxTokens: 1, reasoning: false, input: ['text'] }],
        },
        zaiSandbox: null,
      });
      await Promise.resolve();
    });
    expect(result.current.data).toBeNull();
    // The discarded response must not leave the loading flag stuck.
    expect(result.current.loading).toBe(false);
  });
});

// ---- 7. SettingsDialog export: redaction + corrupted blob (12-c#7/#8) ----------

describe('SettingsDialog "Export all data" (12-c#7/#8)', () => {
  const captures: Blob[] = [];

  beforeEach(() => {
    captures.length = 0;
    // jsdom has no URL.createObjectURL — stub it and capture the blob.
    (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn((blob: Blob) => {
      captures.push(blob);
      return 'blob:test';
    });
    (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
  });

  function openDataSection() {
    render(createElement(SettingsDialog, { open: true, onOpenChange: () => {} }));
    // The nav button's title carries the section label ('Data').
    fireEvent.click(screen.getByTitle('Data'));
  }

  it('redacts apiKey by default and keeps the export working', async () => {
    localStorage.setItem('agentcanvas.sessions.v1', JSON.stringify({ state: emptyDataset(), version: 2 }));
    act(() => { useSettings.setState({ apiKey: 'sk-super-secret' }); });
    openDataSection();
    fireEvent.click(screen.getByText('Export all data (JSON)'));
    expect(captures.length).toBe(1);
    const payload = JSON.parse(await blobText(captures[0]));
    expect(payload.settings.apiKey).toBe('');
    expect(payload.version).toBe(1);
    // The sessions section is the raw persisted wrapper (parsed verbatim).
    expect(payload.sessions).toEqual({ state: emptyDataset(), version: 2 });
    expect(toast.success).toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('survives a corrupted sessions blob — honest toast, no download', () => {
    localStorage.setItem('agentcanvas.sessions.v1', 'not-json{{{');
    openDataSection();
    expect(() => fireEvent.click(screen.getByText('Export all data (JSON)'))).not.toThrow();
    expect(captures.length).toBe(0);
    expect(toast.error).toHaveBeenCalledWith(
      'Export failed',
      expect.objectContaining({ description: expect.stringContaining('corrupted') }),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });
});

// ---- 8. Wiring source scans (12-c#2 / 12-c#6 / 12-c#12) ------------------------
//
// Component-level drivers for these would need the full canvas/socket stack;
// the repo's established pattern for wiring-level invariants is a source scan
// (see multiturn-abuse-2026-09-07.test.ts).

describe('wiring source scans', () => {
  it('DocumentSwitcher checks the server-side active-run status before delete (12-c#2)', () => {
    const src = readSrc('components/sessions/DocumentSwitcher.tsx');
    expect(src).toContain('/agent/status');
    expect(src).toContain('A run is live on this document');
    // The D5 local guard is kept alongside the server-side one.
    expect(src).toContain('agentBusy');
  });

  it('ModelSwitcher passes invalidateOnSettingsChange and re-arms fetch-on-open (12-c#6)', () => {
    const src = readSrc('components/canvas/ModelSwitcher.tsx');
    expect(src).toContain('invalidateOnSettingsChange: true');
    expect(src).toContain('fetchedOnce.current = false');
  });

  it('create-failure toast surfaces the server error body (12-c#12)', () => {
    const src = readSrc('components/sessions/DocumentSwitcher.tsx');
    expect(src).toContain('createError ??');
  });
});
