// agent:alternatives_parked — consumer-side wiring (designer-workflow-parity
// spec §4.3, Task 5). Task 4 added the SyncEvent variant + emission from
// pen_generate_variants; this file owns the EVENT CONTRACT on the consuming
// side (no test pinned the emission payload — per the controller ruling the
// store-side tests own it):
//   1. _onSync attaches a sanitized AlternativesCardState to the last
//      assistant turn (labels coerced, scores numeric, oversized/non-string
//      thumbnails dropped).
//   2. Idempotent by toolCallId — a replayed delivery (live fan-out +
//      journal catch-up overlap) must NOT clobber a card the user already
//      interacted with (re-attaching would reset a promoting/promoted
//      status to idle).
//   3. Persistence: the card state mirrors to the session-store Message
//      (attachAlternatives — the patchOps extras pattern) and survives a
//      _syncTurnsFromSession rebuild (reload / session switch).
//   4. promoteAlternative: the restoreSnapshot-pattern store action — busy
//      guard, no-turn no-op, POST /api/documents/[id]/variants/promote,
//      document adoption + document:restore broadcast on ok, honest toast +
//      idle reset on failure.
//   5. Wiring invariants (audit-test style source scans): the journal
//      allow-list carries the kind (reconnecting clients replay the card)
//      and the AgentPanel renders the card.
//
// STRATEGY: store behavior driven through _onSync exactly like production
// (canvas-full-merge / ui-abuse test pattern); promotion through the store
// action with a stubbed global fetch; wiring via source scans (the
// modes-2026-08-30 audit precedent — vi.mock does NOT reliably intercept
// event-journal's dynamic db import).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { useCanvasStore } from '@/lib/canvas/store';
import { useSessionStore } from '@/lib/sessions';
import { journalAgentEvent, flushJournal } from '@/lib/agent/event-journal';
import {
  runJournalCatchUp,
  saveWatermark,
  type JournalRowWire,
} from '@/lib/canvas/journal-catchup';
import type { CanvasDocument, Shape, SyncEvent } from '@/lib/canvas/types';
import type { PenChild } from '@/lib/pen/types';

// Journal write capture (boot-recovery.test.ts vi.mock('@/lib/db') pattern —
// this DOES reliably intercept event-journal's dynamic import('../db'); see
// the TEST-STRATEGY WARNING in src/lib/canvas/AGENTS.md).
const { journalRows } = vi.hoisted(() => ({
  journalRows: [] as Array<Record<string, unknown>>,
}));
vi.mock('@/lib/db', () => ({
  db: {
    agentEvent: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        journalRows.push(data);
        return data;
      }),
    },
  },
}));

const ROOT = process.cwd();
const readSource = (rel: string) => readFileSync(join(ROOT, 'src', rel), 'utf-8');

// ---- shared fixtures ----------------------------------------------------------

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

function makeDoc(id: string, shapes: Shape[] = []): CanvasDocument {
  return {
    id,
    name: 'Doc',
    background: '#ffffff',
    version: '2.17',
    children: shapes as unknown as PenChild[],
    viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes,
    tokens: { colors: [], textStyles: [] },
  };
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

function resetStore(doc: CanvasDocument = makeDoc('demo')) {
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
    documentId: doc.id,
    activeSessionId: null,
    queuedPrompts: [],
    pendingApproval: null,
    pendingQuestion: null,
    todos: [],
    undoStack: [],
    redoStack: [],
    checkpoints: [],
    lastCheckpointSignature: null,
    measuredBounds: {},
    turnCounter: 0,
  });
}

/// Dispatch an event exactly like the socket 'sync' listener does.
function sync(ev: unknown) {
  useCanvasStore.getState()._onSync(ev as never);
}

const PARKED_EVENT = {
  type: 'agent:alternatives_parked',
  page: 'Explorations',
  pageId: 'page-abc-123',
  sections: ['sec-a', 'sec-b'],
  alternatives: [
    { id: 'sec-a', label: 'Variant B — 81', score: 81, thumbnail: 'data:image/png;base64,AAAA' },
    { id: 'sec-b', label: 'Variant C — 74', score: 74 },
  ],
  toolCallId: 'tc-park-1',
} as unknown as SyncEvent;

beforeEach(() => {
  localStorage.clear();
  resetStore();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

// ---- 1. attach + sanitize ------------------------------------------------------

describe('agent:alternatives_parked store case', () => {
  it('attaches a sanitized alternatives card to the last assistant turn', () => {
    useCanvasStore.setState({ turns: [streamingAssistantTurn()] });
    sync(PARKED_EVENT);
    const card = useCanvasStore.getState().turns[0].alternatives;
    expect(card).toBeDefined();
    expect(card!.page).toBe('Explorations');
    expect(card!.pageId).toBe('page-abc-123');
    expect(card!.status).toBe('idle');
    expect(card!.toolCallId).toBe('tc-park-1');
    expect(card!.alternatives).toHaveLength(2);
    expect(card!.alternatives[0]).toEqual({
      id: 'sec-a',
      label: 'Variant B — 81',
      score: 81,
      thumbnail: 'data:image/png;base64,AAAA',
    });
    expect(card!.alternatives[1]).toEqual({ id: 'sec-b', label: 'Variant C — 74', score: 74 });
  });

  it('never attaches when the last turn is not an assistant turn', () => {
    useCanvasStore.setState({
      turns: [
        { id: 'u1', role: 'user' as const, text: 'hi', toolCalls: [], streaming: false },
      ],
    });
    sync(PARKED_EVENT);
    expect(useCanvasStore.getState().turns[0].alternatives).toBeUndefined();
  });

  it('sanitizes hostile payloads (labels, scores, thumbnails, id-less rows)', () => {
    useCanvasStore.setState({ turns: [streamingAssistantTurn()] });
    sync({
      type: 'agent:alternatives_parked',
      page: 42,
      pageId: { evil: true },
      alternatives: [
        { id: 'sec-ok', label: 99, score: 'high', thumbnail: 12345 }, // coerce label/score, drop thumbnail
        { id: 'sec-big', label: 'too big', score: 50, thumbnail: 'data:image/png;base64,' + 'A'.repeat(200_001) }, // oversized → dropped
        { label: 'no id', score: 50 }, // id-less row → dropped
        null, // garbage row → dropped
        { id: 'sec-no-thumb', label: '', score: Number.NaN }, // empty label → honest default; NaN → 0
      ],
    } as unknown as SyncEvent);
    const card = useCanvasStore.getState().turns[0].alternatives;
    expect(card).toBeDefined();
    expect(card!.page).toBe(''); // non-string page coerced
    expect(card!.pageId).toBeUndefined(); // non-string pageId dropped
    expect(card!.alternatives).toHaveLength(3);
    const [first, second, third] = card!.alternatives;
    expect(first.label).toBe('Variant 1'); // honest default for the empty label
    expect(first.score).toBe(0);
    expect(first.thumbnail).toBeUndefined();
    expect(second.id).toBe('sec-big');
    expect(second.thumbnail).toBeUndefined(); // oversized thumbnail dropped, row kept
    expect(second.label).toBe('too big');
    expect(third.id).toBe('sec-no-thumb'); // id-less + null rows dropped, this one kept
    expect(third.label).toBe('Variant 5'); // positional fallback uses the ORIGINAL index
    expect(third.score).toBe(0); // NaN → 0
  });

  it('caps the alternatives list (array passthrough coercion)', () => {
    useCanvasStore.setState({ turns: [streamingAssistantTurn()] });
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, label: `V${i}`, score: i }));
    sync({ type: 'agent:alternatives_parked', page: 'Explorations', alternatives: rows } as unknown as SyncEvent);
    expect(useCanvasStore.getState().turns[0].alternatives!.alternatives.length).toBeLessThanOrEqual(12);
  });

  it('drops a payload with zero valid alternatives (no empty card)', () => {
    useCanvasStore.setState({ turns: [streamingAssistantTurn()] });
    sync({ type: 'agent:alternatives_parked', page: 'Explorations', alternatives: 'garbage' } as unknown as SyncEvent);
    expect(useCanvasStore.getState().turns[0].alternatives).toBeUndefined();
  });
});

// ---- 2. idempotence by toolCallId ----------------------------------------------

describe('agent:alternatives_parked idempotence', () => {
  it('a replayed event with the same toolCallId is a no-op (status not reset)', () => {
    useCanvasStore.setState({ turns: [streamingAssistantTurn()] });
    sync(PARKED_EVENT);
    // The user clicked "Use this" — the card is mid-flight.
    useCanvasStore.setState((s) => {
      const turns = [...s.turns];
      turns[0] = { ...turns[0], alternatives: { ...turns[0].alternatives!, status: 'promoting' as const } };
      return { turns };
    });
    sync(PARKED_EVENT); // live + journal replay overlap
    const card = useCanvasStore.getState().turns[0].alternatives!;
    expect(card.status).toBe('promoting'); // NOT clobbered back to idle
    expect(card.alternatives).toHaveLength(2);
  });

  it('a call-id-less re-delivery attaches once (critiqueSkipped guard pattern)', () => {
    useCanvasStore.setState({ turns: [streamingAssistantTurn()] });
    const noCallId = { ...PARKED_EVENT, toolCallId: undefined } as unknown as SyncEvent;
    sync(noCallId);
    useCanvasStore.setState((s) => {
      const turns = [...s.turns];
      turns[0] = { ...turns[0], alternatives: { ...turns[0].alternatives!, status: 'promoted' as const } };
      return { turns };
    });
    sync(noCallId);
    expect(useCanvasStore.getState().turns[0].alternatives!.status).toBe('promoted');
  });

  it('a NEW parking op (different toolCallId) replaces the card (latest wins)', () => {
    useCanvasStore.setState({ turns: [streamingAssistantTurn()] });
    sync(PARKED_EVENT);
    sync({ ...PARKED_EVENT, toolCallId: 'tc-park-2', alternatives: [{ id: 'sec-z', label: 'New', score: 99 }] } as unknown as SyncEvent);
    const card = useCanvasStore.getState().turns[0].alternatives!;
    expect(card.toolCallId).toBe('tc-park-2');
    expect(card.alternatives).toEqual([{ id: 'sec-z', label: 'New', score: 99 }]);
    expect(card.status).toBe('idle');
  });
});

// ---- 3. session persistence (the load-bearing part) ----------------------------

describe('alternatives card session persistence', () => {
  function seedSessionTurns(docId: string) {
    const ss = useSessionStore.getState();
    const session = ss.createSession(docId, { title: 'Alts' });
    const run = ss.startRun(session.id, 'make me variants');
    const user = ss.appendUserMessage(session.id, run.id, 'make me variants');
    const assistant = ss.appendAssistantMessage(session.id, run.id);
    useCanvasStore.setState({
      documentId: docId,
      activeSessionId: session.id,
      turns: [
        { id: 'u1', role: 'user' as const, text: 'make me variants', toolCalls: [], streaming: false, messageId: user.id, sessionId: session.id },
        streamingAssistantTurn({ messageId: assistant.id, sessionId: session.id }),
      ],
    });
    return { session, assistant };
  }

  it('mirrors the card to the session-store Message via attachAlternatives', () => {
    const { assistant } = seedSessionTurns('doc-alts-mirror');
    sync(PARKED_EVENT);
    const msg = useSessionStore.getState().messages[assistant.id];
    expect(msg.alternatives).toBeDefined();
    expect(msg.alternatives!.page).toBe('Explorations');
    expect(msg.alternatives!.alternatives.map((a) => a.id)).toEqual(['sec-a', 'sec-b']);
    expect(msg.alternatives!.status).toBe('idle');
  });

  it('the card survives a transcript rebuild (_syncTurnsFromSession round-trip)', () => {
    const docId = 'doc-alts-rebuild';
    const { assistant } = seedSessionTurns(docId);
    sync(PARKED_EVENT);
    // Session switch away + back → the live turns buffer is rebuilt from the
    // session store (reload does the same via hydration).
    useCanvasStore.setState({ turns: [] });
    useCanvasStore.getState()._syncTurnsFromSession();
    const turns = useCanvasStore.getState().turns;
    const rebuilt = turns.find((t) => t.messageId === assistant.id);
    expect(rebuilt).toBeDefined();
    expect(rebuilt!.alternatives).toBeDefined();
    expect(rebuilt!.alternatives!.page).toBe('Explorations');
    expect(rebuilt!.alternatives!.pageId).toBe('page-abc-123');
    expect(rebuilt!.alternatives!.toolCallId).toBe('tc-park-1');
    expect(rebuilt!.alternatives!.status).toBe('idle');
    expect(rebuilt!.alternatives!.alternatives[0].thumbnail).toBe('data:image/png;base64,AAAA');
  });

  it('a card persisted mid-promote rebuilds as idle (a stuck promoting state cannot survive reload)', () => {
    const docId = 'doc-alts-promoting';
    const { assistant } = seedSessionTurns(docId);
    sync(PARKED_EVENT);
    // The user clicked "Use this" and the page died mid-flight — the message
    // row froze at 'promoting'.
    useSessionStore.getState().attachAlternatives(assistant.id, {
      ...useSessionStore.getState().messages[assistant.id].alternatives!,
      status: 'promoting',
    });
    useCanvasStore.setState({ turns: [] });
    useCanvasStore.getState()._syncTurnsFromSession();
    const rebuilt = useCanvasStore.getState().turns.find((t) => t.messageId === assistant.id);
    expect(rebuilt!.alternatives!.status).toBe('idle'); // buttons usable again
  });
});

// ---- 4. promoteAlternative (restoreSnapshot pattern) ---------------------------

describe('promoteAlternative', () => {
  function seedCardTurn(status: 'idle' | 'promoting' | 'promoted' = 'idle') {
    useCanvasStore.setState({
      turns: [streamingAssistantTurn({
        streaming: false,
        alternatives: {
          page: 'Explorations',
          pageId: 'page-abc-123',
          alternatives: [
            { id: 'sec-a', label: 'Variant B — 81', score: 81 },
            { id: 'sec-b', label: 'Variant C — 74', score: 74 },
          ],
          status,
        },
      })],
    });
  }

  it('refuses while the agent is busy (restoreSnapshot busy rule) and never fetches', async () => {
    seedCardTurn();
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    useCanvasStore.setState({ agentBusy: true });
    const ok = await useCanvasStore.getState().promoteAlternative('sec-a');
    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().turns[0].alternatives!.status).toBe('idle');
  });

  it('is a no-op when no turn carries the sectionId', async () => {
    seedCardTurn();
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    const ok = await useCanvasStore.getState().promoteAlternative('sec-missing');
    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('marks promoting during the flight, then adopts the document + broadcasts document:restore', async () => {
    seedCardTurn();
    const emit = vi.fn();
    useCanvasStore.setState({ socket: { emit } as never, connected: true, documentId: 'doc-promo' });
    let resolveFetch!: (r: Response) => void;
    const fetchMock = vi.fn((_url: string, _init: RequestInit) => new Promise<Response>((res) => { resolveFetch = res; }));
    vi.stubGlobal('fetch', fetchMock);

    const pending = useCanvasStore.getState().promoteAlternative('sec-a');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/documents/doc-promo/variants/promote',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ sectionId: 'sec-a' });
    expect(useCanvasStore.getState().turns[0].alternatives!.status).toBe('promoting');

    const swapped = makeDoc('doc-promo', [makeShape('variant-root')]);
    resolveFetch(new Response(JSON.stringify({ ok: true, document: swapped }), { status: 200 }));
    const ok = await pending;
    expect(ok).toBe(true);

    const s = useCanvasStore.getState();
    expect(s.document.shapes.map((sh) => sh.id)).toEqual(['variant-root']); // swapped in
    expect(s.measuredBounds).toEqual({}); // restoreSnapshot reset semantics
    expect(s.checkpoints).toEqual([]);
    expect(emit).toHaveBeenCalledTimes(1);
    const [channel, payload] = emit.mock.calls[0];
    expect(channel).toBe('client');
    expect(payload.type).toBe('document:restore');
    expect(payload.documentId).toBe('doc-promo');
    expect(payload.document.id).toBe('doc-promo');
    expect(s.turns[0].alternatives!.status).toBe('promoted');
  });

  it('resets to idle + fails honestly on a 409 (run active)', async () => {
    seedCardTurn();
    useCanvasStore.setState({ documentId: 'doc-promo' });
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: 'a design run is active' }), { status: 409 })));
    const ok = await useCanvasStore.getState().promoteAlternative('sec-a');
    expect(ok).toBe(false);
    expect(useCanvasStore.getState().turns[0].alternatives!.status).toBe('idle');
    expect(useCanvasStore.getState().document.shapes).toHaveLength(0); // document untouched
  });

  it('resets to idle on other non-ok responses (promote route missing mid-series)', async () => {
    seedCardTurn();
    useCanvasStore.setState({ documentId: 'doc-promo' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    const ok = await useCanvasStore.getState().promoteAlternative('sec-b');
    expect(ok).toBe(false);
    expect(useCanvasStore.getState().turns[0].alternatives!.status).toBe('idle');
  });

  it('resets to idle when the network throws', async () => {
    seedCardTurn();
    useCanvasStore.setState({ documentId: 'doc-promo' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const ok = await useCanvasStore.getState().promoteAlternative('sec-a');
    expect(ok).toBe(false);
    expect(useCanvasStore.getState().turns[0].alternatives!.status).toBe('idle');
  });

  it('rejects an ok response carrying a malformed document', async () => {
    seedCardTurn();
    useCanvasStore.setState({ documentId: 'doc-promo' });
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, document: null }), { status: 200 })));
    const ok = await useCanvasStore.getState().promoteAlternative('sec-a');
    expect(ok).toBe(false);
    expect(useCanvasStore.getState().turns[0].alternatives!.status).toBe('idle');
  });
});

// ---- 5. wiring invariants (audit-test style source scans) ----------------------

describe('alternatives_parked wiring invariants', () => {
  it('the journal allow-list carries agent:alternatives_parked (reconnect replay)', () => {
    const src = readSource(join('lib', 'agent', 'event-journal.ts'));
    expect(src).toContain("'agent:alternatives_parked'");
  });

  it('the AgentPanel renders the AlternativesCard from the turn state', () => {
    const src = readSource(join('components', 'canvas', 'AgentPanel.tsx'));
    expect(src).toContain('function AlternativesCard');
    expect(src).toContain('turn.alternatives');
    // Components never emit socket events — promotion goes through the store action.
    expect(src).toContain('promoteAlternative(');
    expect(src).not.toMatch(/emit\('client'.*alternatives/i);
  });
});

// ---- 6. journal-side thumbnail strip (controller fix round 1) ------------------
//
// Thumbnails are cosmetic; the CARD is the contract. The 65K journal row cap
// would truncate a thumbnail-bearing payload into invalid JSON, which
// journal-catchup's replayRow skips — a reconnecting viewer would lose the
// whole card. The JOURNALED copy therefore drops thumbnails; the LIVE wire
// event keeps them.

describe('journal-side thumbnail strip (agent:alternatives_parked)', () => {
  const BIG_THUMB = 'data:image/png;base64,' + 'A'.repeat(200_000);

  beforeEach(() => {
    journalRows.length = 0;
  });

  it('the JOURNALED copy drops thumbnails, stays valid + under the 65K cap, keeps the card contract', async () => {
    const event = {
      type: 'agent:alternatives_parked',
      page: 'Explorations',
      pageId: 'page-abc-123',
      sections: ['sec-a', 'sec-b'],
      alternatives: [
        { id: 'sec-a', label: 'Variant B — 81', score: 81, thumbnail: BIG_THUMB },
        { id: 'sec-b', label: 'Variant C — 74', score: 74 },
      ],
      toolCallId: 'tc-park-1',
    };
    journalAgentEvent('doc-journal-strip', { kind: 'agent_event', event } as never);
    await flushJournal();
    expect(journalRows).toHaveLength(1);
    const row = journalRows[0];
    expect(row.type).toBe('agent:alternatives_parked');
    expect(row.toolCallId).toBe('tc-park-1');
    expect(typeof row.payload).toBe('string');
    expect((row.payload as string).length).toBeLessThan(65_536); // under the row cap
    expect(row.payload as string).not.toContain(BIG_THUMB);
    const payload = JSON.parse(row.payload as string); // parses — NOT truncated
    expect(payload.type).toBe('agent:alternatives_parked');
    expect(payload.page).toBe('Explorations');
    expect(payload.pageId).toBe('page-abc-123');
    expect(payload.sections).toEqual(['sec-a', 'sec-b']); // kept per the ruling
    expect(payload.toolCallId).toBe('tc-park-1');
    expect(payload.alternatives).toEqual([
      { id: 'sec-a', label: 'Variant B — 81', score: 81 }, // thumbnail stripped, rest intact
      { id: 'sec-b', label: 'Variant C — 74', score: 74 },
    ]);
    // The LIVE event object is untouched — the wire stream keeps thumbnails.
    expect((event.alternatives as Array<{ thumbnail?: string }>)[0].thumbnail).toBe(BIG_THUMB);
  });

  it('journaled rows without thumbnails pass through byte-identical (no needless clone)', async () => {
    const event = {
      type: 'agent:alternatives_parked',
      page: 'Explorations',
      alternatives: [{ id: 'sec-a', label: 'Variant B — 81', score: 81 }],
    };
    journalAgentEvent('doc-journal-strip', { kind: 'agent_event', event } as never);
    await flushJournal();
    expect(JSON.parse(journalRows[0].payload as string)).toEqual(event);
  });

  it('other journaled types pass through unchanged (the strip never leaks)', async () => {
    const event = { type: 'agent:plan_proposed', planId: 'p1', title: 'T', summary: 'S', steps: [] };
    journalAgentEvent('doc-journal-strip', { kind: 'agent_event', event } as never);
    await flushJournal();
    expect(journalRows[0].type).toBe('agent:plan_proposed');
    expect(JSON.parse(journalRows[0].payload as string)).toEqual(event);
  });

  it('journal-catchup replayRow dispatches the stripped row (a reconnecting viewer gets the card)', async () => {
    const DOC = 'doc-journal-replay';
    saveWatermark(DOC, 5);
    // The row exactly as the journal stores it (thumbnail already stripped).
    const row: JournalRowWire = {
      seq: 6,
      type: 'agent:alternatives_parked',
      toolCallId: 'tc-park-1',
      payload: {
        type: 'agent:alternatives_parked',
        page: 'Explorations',
        pageId: 'page-abc-123',
        sections: ['sec-a'],
        alternatives: [{ id: 'sec-a', label: 'Variant B — 81', score: 81 }],
        toolCallId: 'tc-park-1',
      },
      createdAt: new Date().toISOString(),
    };
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = new URL(String(input), 'http://localhost');
      const afterSeq = url.searchParams.get('afterSeq');
      if (afterSeq === String(Number.MAX_SAFE_INTEGER)) {
        return new Response(JSON.stringify({ events: [], lastSeq: 6, count: 0, truncated: false }), { status: 200 });
      }
      return new Response(JSON.stringify({ events: [row], lastSeq: 6, count: 1, truncated: false }), { status: 200 });
    }));
    const dispatch = vi.fn();
    await runJournalCatchUp(DOC, { dispatch });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const ev = dispatch.mock.calls[0][0] as {
      type: string;
      alternatives: Array<{ thumbnail?: string; label: string; score: number }>;
    };
    expect(ev.type).toBe('agent:alternatives_parked'); // row.type === payload.type → dispatched
    expect(ev.alternatives[0].thumbnail).toBeUndefined(); // the stripped card replays
    expect(ev.alternatives[0].label).toBe('Variant B — 81');
    expect(ev.alternatives[0].score).toBe(81);
  });
});
