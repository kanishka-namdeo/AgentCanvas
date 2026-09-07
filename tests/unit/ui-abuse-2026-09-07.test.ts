// UI abuse hardening (2026-09-07, Task 12) — regression tests.
//
// ABUSE MODEL (from the 4-way UI workflow evaluation — worklog Task 12-a..12-d):
//   1. MALFORMED INGEST — the WS client / journal catch-up / HTTP fallback all
//      fed _onSync with ZERO payload validation: one garbage canvas:full /
//      presence roster / plan steps / message field threw out of the socket
//      handler (socket.io-client does not catch handler errors; no error
//      boundary existed) = white screen. Guards now coerce or drop.
//   2. SOCKET LIFECYCLE — init() leaked the previous document's socket on every
//      switch (the switcher discards the disposer) → old room's events bled
//      into the NEW document; N switches = N live sockets. Fixed with a
//      disconnect + generation token.
//   3. MUTATION:ACK — an unknown ack status fell into the REJECT branch and
//      dropped the whole offline outbox; a real reject left the optimistic
//      edit applied (permanent desync). Unknown → no-op; reject → resync.
//   4. QUEUE / WATCHDOG — Enter-spam grew the queue unboundedly; a lost WS
//      emit left the client busy forever. Cap 20 + Clear all + 45s arm
//      watchdog.
//   5. JOURNAL CATCH-UP — concurrent catch-ups double-replayed; a
//      persistently-truncated window saved the journal HEAD (transcript loss
//      for rows beyond the 20-page cap). In-flight guard + resume-from-last-
//      replayed-row.
//   6. COMPOSER — oversized prompts cleared the input before the server
//      rejected them; Retry re-sent the identical rejected prompt forever.
//
// STRATEGY: store behavior driven through _onSync exactly like production
// (canvas-full-merge.test.ts pattern); journal-catchup through its own
// fetch-mocked harness (journal-catchup.test.ts pattern); wiring that drags
// socket.io/React transports in via source scans (multiturn-abuse precedent).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, 'src', rel), 'utf-8');

import { useCanvasStore } from '@/lib/canvas/store';
import { useSessionStore } from '@/lib/sessions';
import {
  runJournalCatchUp,
  loadWatermark,
  saveWatermark,
  type JournalRowWire,
  type CatchUpAdapter,
} from '@/lib/canvas/journal-catchup';
import { isValidationRejection } from '@/components/canvas/AgentPanel';
import type { CanvasDocument, Shape } from '@/lib/canvas/types';
import type { PenChild } from '@/lib/pen/types';

// ---- shared fixtures ----------------------------------------------------------

function makeDoc(shapes: Shape[] = []): CanvasDocument {
  return {
    id: 'demo',
    name: 'Doc',
    background: '#ffffff',
    version: '2.17',
    children: shapes as unknown as PenChild[],
    viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes,
    tokens: { colors: [], textStyles: [] },
  };
}

function makeShape(id: string): Shape {
  return {
    id,
    type: 'rectangle',
    name: id,
    x: 0, y: 0, width: 100, height: 100,
    rotation: 0, opacity: 1,
    fill: '#cccccc', stroke: '#000', strokeWidth: 0,
    radius: 0, fontSize: 16, textColor: '#000',
    parentId: null, zIndex: 0,
    locked: false, visible: true,
    autoLayout: null, tokenBinding: null, componentId: null,
    points: null, closed: false, src: null, radii: null,
    gradient: null, shadow: null, blur: 0, maskId: null,
    constraints: null,
  } as Shape;
}

function streamingAssistantTurn(overrides: Record<string, unknown> = {}) {
  return {
    id: `a_${Math.random().toString(36).slice(2, 8)}`,
    role: 'assistant' as const,
    text: '',
    toolCalls: [],
    streaming: true,
    startedAt: Date.now(),
    ...overrides,
  };
}

function resetStore(doc: CanvasDocument = makeDoc([])) {
  useCanvasStore.setState({
    document: doc,
    selectedIds: [],
    socket: null,
    connected: false,
    viewerCount: 1,
    remotePresence: {},
    turns: [],
    agentBusy: false,
    runPhase: 'idle' as const,
    documentId: 'demo',
    activeSessionId: null,
    queuedPrompts: [],
    pendingApproval: null,
    pendingQuestion: null,
    todos: [],
    undoStack: [],
    redoStack: [],
    checkpoints: [],
    lastCheckpointSignature: null,
    turnCounter: 0,
  });
}

/// Dispatch an event exactly like the socket 'sync' listener does.
function sync(ev: unknown) {
  useCanvasStore.getState()._onSync(ev as never);
}

beforeEach(() => {
  resetStore();
});

// ---- 1. malformed ingest battery ----------------------------------------------

describe('UI hardening: malformed _onSync ingest never throws', () => {
  it.each([
    ['canvas:full with null document', { type: 'canvas:full', document: null }],
    ['canvas:full with non-array children', { type: 'canvas:full', document: { id: 'd', children: 'nope' } }],
    ['canvas:full with garbage shapes/tokens', { type: 'canvas:full', document: { id: 'd', children: [], shapes: 'x', tokens: 42, viewport: 'y' } }],
    ['canvas:patch with null patch', { type: 'canvas:patch', patch: null }],
    ['canvas:patch with non-string op', { type: 'canvas:patch', patch: { op: 42 } }],
    ['presence:roster with non-iterable', { type: 'presence:roster', roster: 'garbage' }],
    ['presence:roster with null entries', { type: 'presence:roster', roster: [null, { participantId: 'p1' }, 7] }],
    ['presence:update with null participant', { type: 'presence:update', participant: null }],
    ['agent:plan_proposed without steps', { type: 'agent:plan_proposed', planId: 'p1' }],
    ['agent:plan without steps', { type: 'agent:plan', steps: null }],
    ['agent:critique with garbage fields', { type: 'agent:critique', defects: undefined, textSeverity: 42, vlmSeverity: { x: 1 } }],
    ['agent:message_delta with non-string text', { type: 'agent:message_delta', text: undefined }],
    ['agent:thinking_delta with non-string text', { type: 'agent:thinking_delta', text: {} }],
    ['agent:todo_update with non-array todos', { type: 'agent:todo_update', todos: 'x' }],
    ['agent:ask_user_question without questions', { type: 'agent:ask_user_question', toolCallId: 't1' }],
    ['agent:approval_request with garbage details', { type: 'agent:approval_request', toolCallId: 't1', details: 'zzz', toolName: 7 }],
    ['agent:error with non-string message', { type: 'agent:error', message: 42 }],
    ['agent:error with empty message', { type: 'agent:error', message: '' }],
    ['agent:stuck with non-string message', { type: 'agent:stuck', message: { deep: true } }],
    ['agent:prompt_rejected with non-string reason', { type: 'agent:prompt_rejected', reason: 13 }],
  ])('drops %s without throwing', (_name, ev) => {
    // A streaming assistant turn exists so the "last turn" reducer paths run.
    useCanvasStore.setState({ turns: [streamingAssistantTurn()] });
    expect(() => sync(ev)).not.toThrow();
  });

  it('drops null/undefined/typeless events at the entry guard', () => {
    expect(() => sync(null)).not.toThrow();
    expect(() => sync(undefined)).not.toThrow();
    expect(() => sync({})).not.toThrow();
    expect(() => sync({ type: 42 })).not.toThrow();
  });

  it('a malformed canvas:full leaves the local document intact', () => {
    const doc = makeDoc([makeShape('keep-me')]);
    resetStore(doc);
    sync({ type: 'canvas:full', document: null, reason: 'restore' });
    expect(useCanvasStore.getState().document.shapes.map((s) => s.id)).toEqual(['keep-me']);
  });

  it('non-string message text never renders literal "undefined" into the transcript', () => {
    useCanvasStore.setState({ turns: [streamingAssistantTurn()] });
    sync({ type: 'agent:message_delta', text: undefined });
    sync({ type: 'agent:thinking_delta', text: {} });
    const last = useCanvasStore.getState().turns[0];
    expect(last.text).toBe('');
    expect(last.thinking ?? '').toBe('');
  });

  it('empty agent:error message gets an honest default (no silent empty turn)', () => {
    useCanvasStore.setState({ turns: [streamingAssistantTurn()] });
    sync({ type: 'agent:error', message: '' });
    const last = useCanvasStore.getState().turns[0];
    expect(last.error).toBe('Run failed');
    expect(last.streaming).toBe(false);
  });

  it('gate arrays are coerced (PluginUI render-tree crash fix)', () => {
    sync({ type: 'agent:ask_user_question', toolCallId: 't1' });
    expect(useCanvasStore.getState().pendingQuestion?.questions).toEqual([]);
    sync({ type: 'agent:approval_request', toolCallId: 't2' });
    const approval = useCanvasStore.getState().pendingApproval;
    expect(approval?.details).toEqual([]);
    expect(approval?.toolName).toBe('unknown_tool');
    sync({ type: 'agent:todo_update', todos: 'x' });
    expect(useCanvasStore.getState().todos).toEqual([]);
  });

  it('presence roster drops garbage entries and survives a flood', () => {
    sync({ type: 'presence:roster', roster: [null, 7, { participantId: 'p1' }] });
    expect(Object.keys(useCanvasStore.getState().remotePresence)).toEqual(['p1']);
    // Test mode applies presence updates synchronously (dispatch-then-assert).
    for (let i = 0; i < 500; i++) {
      sync({ type: 'presence:update', participant: { participantId: 'p1', x: i, y: i } });
    }
    expect(useCanvasStore.getState().remotePresence.p1).toBeDefined();
    expect(() => sync({ type: 'presence:update', participant: null })).not.toThrow();
  });

  it('plan steps with garbage entries coerce to positional steps', () => {
    useCanvasStore.setState({ turns: [streamingAssistantTurn()] });
    sync({ type: 'agent:plan_proposed', planId: 'p1', steps: [null, { description: 'second' }, 7] });
    const last = useCanvasStore.getState().turns[0];
    expect(last.planProposal?.steps).toEqual([
      { step: 1, description: '' },
      { step: 2, description: 'second' },
      { step: 3, description: '' },
    ]);
  });
});

// ---- 2. mutation:ack verdict handling -----------------------------------------

describe('UI hardening: mutation:ack verdicts', () => {
  it('an UNKNOWN ack status is a no-op (no outbox drop, no resync)', () => {
    const emit = vi.fn();
    useCanvasStore.setState({ socket: { emit } as never, connected: true });
    expect(() => sync({ type: 'mutation:ack', status: 'garbled-relay-garbage', lastMutationId: 7, clientId: 'c', clientMutationId: 5 })).not.toThrow();
    // No reject-branch work: no resync request was emitted.
    expect(emit).not.toHaveBeenCalled();
  });

  it('a REJECTED ack requests a full canvas resync (desync repair)', () => {
    const emit = vi.fn();
    useCanvasStore.setState({ socket: { emit } as never, connected: true });
    sync({ type: 'mutation:ack', status: 'rejected', lastMutationId: 7, clientId: 'c', clientMutationId: 5 });
    expect(emit).toHaveBeenCalledWith('client', expect.objectContaining({ type: 'canvas:request_full', documentId: 'demo' }));
  });
});

// ---- 3. thinking batching ------------------------------------------------------

describe('UI hardening: thinking deltas ride the R9b batch buffer', () => {
  it('accumulates thinking chunks onto the turn (test-mode sync flush)', () => {
    useCanvasStore.setState({ turns: [streamingAssistantTurn()] });
    sync({ type: 'agent:thinking_delta', text: 'Hmm, ' });
    sync({ type: 'agent:thinking_delta', text: 'considering…' });
    const last = useCanvasStore.getState().turns[0];
    expect(last.thinking).toBe('Hmm, considering…');
    expect(last.thinkingStartedAt).toBeTypeOf('number');
  });

  it('answer text after thinking closes the thinking phase', () => {
    useCanvasStore.setState({ turns: [streamingAssistantTurn()] });
    sync({ type: 'agent:thinking_delta', text: 'reason' });
    sync({ type: 'agent:message_delta', text: 'Answer!' });
    const last = useCanvasStore.getState().turns[0];
    expect(last.thinking).toBe('reason');
    expect(last.text).toBe('Answer!');
    expect(last.thinkingEndedAt).toBeTypeOf('number');
  });
});

// ---- 4. queue cap + clear-all --------------------------------------------------

describe('UI hardening: prompt queue caps', () => {
  it('caps the queue at 20 entries (Enter-spam bound)', () => {
    useCanvasStore.setState({ agentBusy: true });
    for (let i = 0; i < 25; i++) {
      useCanvasStore.getState().queuePrompt(`prompt #${i}`);
    }
    expect(useCanvasStore.getState().queuedPrompts.length).toBe(20);
    expect(useCanvasStore.getState().queuedPrompts[0].text).toBe('prompt #0');
    expect(useCanvasStore.getState().queuedPrompts[19].text).toBe('prompt #19');
  });

  it('clearQueuedPrompts empties the queue (Clear-all affordance)', () => {
    useCanvasStore.setState({ agentBusy: true });
    useCanvasStore.getState().queuePrompt('a');
    useCanvasStore.getState().queuePrompt('b');
    useCanvasStore.getState().clearQueuedPrompts();
    expect(useCanvasStore.getState().queuedPrompts).toEqual([]);
  });
});

// ---- 5. restoreCheckpoint busy guard ------------------------------------------

describe('UI hardening: restoreCheckpoint store-level guard', () => {
  it('refuses to restore while the agent is busy', () => {
    const doc = makeDoc([makeShape('current')]);
    resetStore(doc);
    // Seed a checkpoint whose document differs from the live one.
    useCanvasStore.setState({
      checkpoints: [
        { id: 'cp1', label: 'old', createdAt: Date.now(), auto: false, document: makeDoc([makeShape('old-state')]) },
      ] as never,
    });
    useCanvasStore.setState({ agentBusy: true });
    expect(useCanvasStore.getState().restoreCheckpoint('cp1')).toBe(false);
    expect(useCanvasStore.getState().document.shapes.map((s) => s.id)).toEqual(['current']);
  });
});

// ---- 6. prompt_rejected queue doctrine ----------------------------------------

describe('UI hardening: prompt_rejected auto-flush doctrine', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a BUSY rejection (foreign run live) KEEPS the queue — no machine-gun', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    useCanvasStore.setState({
      agentBusy: true,
      turns: [streamingAssistantTurn()],
      queuedPrompts: [{ id: 'q1', text: 'queued prompt', queuedAt: Date.now() }] as never,
    });
    sync({ type: 'agent:prompt_rejected', reason: 'a turn is already running on this canvas — stop it or wait for it to finish' });
    await new Promise((r) => setTimeout(r, 10));
    // The queue survived for manual send; no new prompt was sent.
    expect(useCanvasStore.getState().queuedPrompts.length).toBe(1);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('a VALIDATION rejection still flushes the queue (queue doctrine intact)', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    useCanvasStore.setState({
      agentBusy: true,
      turns: [streamingAssistantTurn()],
      queuedPrompts: [{ id: 'q1', text: 'queued prompt', queuedAt: Date.now() }] as never,
    });
    sync({ type: 'agent:prompt_rejected', reason: 'prompt exceeds the 20,000-character limit (got 25000); trim it and resend' });
    await new Promise((r) => setTimeout(r, 10));
    expect(useCanvasStore.getState().queuedPrompts.length).toBe(0);
    expect(fetchMock).toHaveBeenCalled(); // the queued prompt was re-sent
  });

  it('finalizes the pending streaming turn honestly', () => {
    useCanvasStore.setState({
      agentBusy: true,
      turns: [streamingAssistantTurn()],
    });
    sync({ type: 'agent:prompt_rejected', reason: 'prompt is required' });
    const last = useCanvasStore.getState().turns[0];
    expect(last.streaming).toBe(false);
    expect(last.error).toBe('prompt is required');
    expect(useCanvasStore.getState().agentBusy).toBe(false);
    expect(useCanvasStore.getState().runPhase).toBe('failed');
  });
});

// ---- 7. run-arm watchdog -------------------------------------------------------

describe('UI hardening: run-arm watchdog (lost WS emit rescue)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('finalizes a run that never started as failed', () => {
    const emit = vi.fn();
    useCanvasStore.setState({
      socket: { emit } as never,
      connected: true,
      documentId: 'watchdog-doc',
      activeSessionId: null,
    });
    useCanvasStore.getState().promptAgent('watchdog me');
    expect(useCanvasStore.getState().agentBusy).toBe(true);
    expect(emit).toHaveBeenCalled(); // the WS prompt went out

    // No agent event ever arrives — the emit was lost.
    vi.advanceTimersByTime(45_001);
    const s = useCanvasStore.getState();
    expect(s.agentBusy).toBe(false);
    expect(s.runPhase).toBe('failed');
    const last = s.turns[s.turns.length - 1];
    expect(last.role).toBe('assistant');
    expect(last.error).toMatch(/never started/i);
    expect(last.streaming).toBe(false);
  });

  it('stands down once any agent event lands (slow first token is fine)', () => {
    useCanvasStore.setState({
      socket: { emit: vi.fn() } as never,
      connected: true,
      documentId: 'watchdog-doc2',
      activeSessionId: null,
    });
    useCanvasStore.getState().promptAgent('watchdog me too');
    // A thinking delta arrives before the window closes.
    vi.advanceTimersByTime(1_000);
    useCanvasStore.getState()._onSync({ type: 'agent:thinking_delta', text: 'warming up' } as never);
    vi.advanceTimersByTime(45_001);
    // The watchdog stood down — busy is still armed (the run is live).
    expect(useCanvasStore.getState().agentBusy).toBe(true);
    const last = useCanvasStore.getState().turns[useCanvasStore.getState().turns.length - 1];
    expect(last.error).toBeUndefined();
  });
});

// ---- 8. journal catch-up: in-flight guard + truncated watermark ---------------

describe('UI hardening: journal catch-up concurrency + truncation', () => {
  const DOC = 'doc-ui-abuse';

  function row(seq: number, type: string, payload: unknown): JournalRowWire {
    return { seq, type, toolCallId: null, payload, createdAt: new Date().toISOString() };
  }

  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('a second concurrent catch-up for the same document returns without re-fetching', async () => {
    saveWatermark(DOC, 5);
    let resolveFirst!: (r: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((res) => { resolveFirst = res; }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter: CatchUpAdapter = { dispatch: vi.fn() };

    const first = runJournalCatchUp(DOC, adapter);
    const second = runJournalCatchUp(DOC, adapter);
    await second; // returns immediately — the first run owns the document
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFirst(new Response(JSON.stringify({ events: [], lastSeq: 5, count: 0, truncated: false, lastMutationIDChanges: {}, oldestSeq: null, snapshotSeq: null }), { status: 200 }));
    await first;
    expect(fetchMock).toHaveBeenCalledTimes(1); // still one fetch total
  });

  it('a persistently-truncated window persists the LAST REPLAYED row, not the journal head', async () => {
    saveWatermark(DOC, 5);
    // Every page returns 200 rows starting after the requested watermark,
    // still truncated, with the journal head at 100_000 (far beyond the
    // 20-page cap).
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(String(input), 'http://localhost');
      const afterSeq = Number(url.searchParams.get('afterSeq'));
      const events = Array.from({ length: 200 }, (_, i) =>
        row(afterSeq + 1 + i, 'agent:message_delta', { type: 'agent:message_delta', text: 'x' }),
      );
      return new Response(
        JSON.stringify({ events, lastSeq: 100_000, count: 200, truncated: true, lastMutationIDChanges: {}, oldestSeq: afterSeq + 1, snapshotSeq: null }),
        { status: 200 },
      );
    }));
    const dispatch = vi.fn();
    await runJournalCatchUp(DOC, { dispatch });

    // 20 pages × 200 rows = 4000 replayed rows (seq 6..4005).
    expect(dispatch).toHaveBeenCalledTimes(4000);
    // The watermark resumes at the last REPLAYED row — NOT the head (100_000),
    // which would have skipped rows 4006.. forever (transcript loss).
    expect(loadWatermark(DOC)).toBe(4005);
  });

  it('a fully-fetched window still advances to the journal head (no regression)', async () => {
    saveWatermark(DOC, 5);
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(String(input), 'http://localhost');
      const afterSeq = Number(url.searchParams.get('afterSeq'));
      if (afterSeq !== 5) {
        return new Response(JSON.stringify({ events: [], lastSeq: 8, count: 0, truncated: false, lastMutationIDChanges: {}, oldestSeq: null, snapshotSeq: null }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          events: [
            row(6, 'agent:message_delta', { type: 'agent:message_delta', text: 'a' }),
            row(7, 'agent:message_delta', { type: 'agent:message_delta', text: 'b' }),
            row(8, 'agent:message_delta', { type: 'agent:message_delta', text: 'c' }),
          ],
          lastSeq: 8, count: 3, truncated: false, lastMutationIDChanges: {}, oldestSeq: 6, snapshotSeq: null,
        }),
        { status: 200 },
      );
    }));
    const dispatch = vi.fn();
    await runJournalCatchUp(DOC, { dispatch });
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(loadWatermark(DOC)).toBe(8);
  });
});

// ---- 9. composer validation-class rejection -----------------------------------

describe('UI hardening: composer validation-class rejection (Retry dead-loop fix)', () => {
  it('isValidationRejection matches the cap + empty-prompt rejections', () => {
    expect(isValidationRejection('prompt exceeds the 20,000-character limit (got 25000); trim it and resend')).toBe(true);
    expect(isValidationRejection('prompt is required')).toBe(true);
    expect(isValidationRejection('LLM provider rate limited')).toBe(false);
    expect(isValidationRejection(undefined)).toBe(false);
    expect(isValidationRejection('')).toBe(false);
  });
});

// ---- 10. wiring source scans (socket lifecycle + server door + boundary) -------

describe('UI hardening: wiring source scans', () => {
  it('store.ts — socket lifecycle generation token + guarded sync listener', () => {
    const src = read('lib/canvas/store.ts');
    expect(src).toContain('++initGeneration');
    // The generation guard appears in the sync listener, the catch-up adapter
    // dispatch AND the mutation-clock hook.
    expect(src.match(/generation !== initGeneration/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    // The superseded socket is disconnected at init().
    expect(src).toContain('supersededSocket.disconnect()');
    // The sync listener never lets a malformed event throw out of the handler.
    expect(src).toContain('dropped malformed ${event.type} event');
    // Watchdog + queue + presence caps exist.
    expect(src).toContain('ARM_WATCHDOG_MS = 45_000');
    expect(src).toContain('QUEUE_MAX = 20');
    expect(src).toContain('MAX_REMOTE_PRESENCE = 64');
    expect(src).toContain('PRESENCE_APPLY_MS = 50');
    // Doc-switch reset drops the OLD document's streaming buffers.
    expect(src).toContain('pendingThinkingDeltas = \'\';');
  });

  it('store.ts — promptAgent arms the watchdog; stopAgent clears it', () => {
    const src = read('lib/canvas/store.ts');
    expect(src).toContain('armRunWatchdog();');
    expect(src).toMatch(/clearArmWatchdog\(\);/);
  });

  it('server.ts — WS writer door (caps + restore validation + relay throttle)', () => {
    const src = read('lib/canvas/server.ts');
    expect(src).toContain('MAX_PATCH_JSON_CHARS = 512 * 1024');
    expect(src).toContain('MAX_PATCH_BULK_SHAPES = 2000');
    expect(src).toContain('dropped malformed document:restore');
    expect(src).toContain('PRESENCE_RELAY_MIN_MS = 40');
    // The per-socket relay throttle state is released on disconnect.
    expect(src).toContain('presenceRelayAt.delete(socket.id)');
  });

  it('AgentPanel.tsx — client prompt cap + Retry gating + Clear-all', () => {
    const src = read('components/canvas/AgentPanel.tsx');
    expect(src).toContain('MAX_PROMPT_CHARS = 20_000');
    // The cap fires BEFORE the composer clears (no lost text) — search for
    // the reset that FOLLOWS the cap check (an earlier setInput('') exists
    // in the slash-command path).
    const capIdx = src.indexOf('promptText.length > MAX_PROMPT_CHARS');
    const clearIdx = src.indexOf("setInput('')", capIdx);
    expect(capIdx).toBeGreaterThan(-1);
    expect(clearIdx).toBeGreaterThan(capIdx);
    expect(src).toContain('!isValidationRejection(turn.error)');
    expect(src).toContain('Clear all');
  });

  it('page.tsx — app-level ErrorBoundary wraps the app', () => {
    const src = read('app/page.tsx');
    expect(src).toContain('<ErrorBoundary>');
    expect(src).toContain('</ErrorBoundary>');
    // Copy/cut use O(1) Map lookups (selection-bomb fix).
    expect(src.match(/new Map\(state\.document\.shapes/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('ErrorBoundary component exists with a reload affordance', () => {
    const src = read('components/ErrorBoundary.tsx');
    expect(src).toContain('getDerivedStateFromError');
    expect(src).toContain('window.location.reload()');
  });

  it('journal-catchup.ts — in-flight guard + truncated-window resume', () => {
    const src = read('lib/canvas/journal-catchup.ts');
    expect(src).toContain('catchUpInFlight');
    expect(src).toContain('stillTruncated');
    expect(src).toContain('runJournalCatchUpInner');
  });

  it('mutation:ack consume-the-suppression contract (agent:error + prompt_rejected)', () => {
    const src = read('lib/canvas/store.ts');
    // Both terminal paths reset the flag so a stale Stop suppression can
    // never skip the NEXT turn's auto-flush.
    const errorIdx = src.indexOf("case 'agent:error'");
    const errorReset = src.indexOf('suppressQueueFlush = false;', errorIdx);
    expect(errorReset).toBeGreaterThan(errorIdx);
    const rejectedIdx = src.indexOf("case 'agent:prompt_rejected'");
    const rejectedReset = src.indexOf('suppressQueueFlush = false;', rejectedIdx);
    expect(rejectedReset).toBeGreaterThan(rejectedIdx);
  });
});

// Session-store side effects of the watchdog test (createSession etc.) must
// not leak into other suites — reset the sessions store's working set.
afterEach(() => {
  try {
    useSessionStore.setState({ sessions: {}, messages: {}, runs: {}, activeByDocument: {}, snapshots: {} } as never);
  } catch {
    // best-effort isolation
  }
});
