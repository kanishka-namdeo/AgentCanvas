// Integration tests — reconnect catch-up wired into the real store stack:
// journal rows fetched from the (mocked) events API are dispatched through
// the canvas store's _onSync — the exact dispatch path the socket 'connect'
// handler uses — and must unstrand a turn that was open when the client
// disconnected (agentBusy / streaming message / in_progress run).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useCanvasStore } from '@/lib/canvas/store';
import { useSessionStore } from '@/lib/sessions';
import { runJournalCatchUp, loadWatermark, __clearPendingWatermarkAdvances, type JournalRowWire } from '@/lib/canvas/journal-catchup';
import type { CanvasDocument, Shape, SyncEvent } from '@/lib/canvas/types';

const DOC_ID = 'doc-catchup-e2e';

function makeDoc(shapes: Shape[] = []): CanvasDocument {
  return {
    id: DOC_ID,
    name: 'Test',
    background: '#ffffff',
    version: '2.17',
    children: shapes as never,
    viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes,
    tokens: { colors: [], textStyles: [] },
  };
}

function resetStore() {
  useCanvasStore.setState({
    document: makeDoc([]),
    selectedIds: [],
    agentHighlightIds: [],
    socket: null,
    connected: false,
    viewerCount: 1,
    turns: [],
    agentBusy: false,
    documentId: DOC_ID,
    activeSessionId: null,
    undoStack: [],
    redoStack: [],
  });
  useSessionStore.setState({
    sessions: {},
    runs: {},
    messages: {},
    toolCalls: {},
    snapshots: {},
    activeSessionByDoc: {},
  });
}

function seedOpenTurn(prompt: string) {
  const ss = useSessionStore.getState();
  const session = ss.createSession(DOC_ID, { title: prompt.slice(0, 48) });
  useCanvasStore.setState({ activeSessionId: session.id });
  const run = ss.startRun(session.id, prompt, 'user_message');
  const userMsg = ss.appendUserMessage(session.id, run.id, prompt);
  const assistantMsg = ss.appendAssistantMessage(session.id, run.id);
  useCanvasStore.setState((s) => ({
    turns: [
      ...s.turns,
      { id: userMsg.id, role: 'user' as const, text: prompt, toolCalls: [], streaming: false, sessionId: session.id, runId: run.id, messageId: userMsg.id },
      { id: assistantMsg.id, role: 'assistant' as const, text: '', toolCalls: [], streaming: true, sessionId: session.id, runId: run.id, messageId: assistantMsg.id },
    ],
    agentBusy: true,
  }));
  return { sessionId: session.id, runId: run.id, assistantMessageId: assistantMsg.id };
}

function row(seq: number, type: string, payload: unknown, toolCallId: string | null = null): JournalRowWire {
  return { seq, type, toolCallId, payload, createdAt: new Date().toISOString() };
}

/// The adapter the socket 'connect' handler builds (mirrored here so the
/// test exercises the same isTurnOpen / dispatch contract).
function storeAdapter() {
  return {
    isTurnOpen: () => {
      const s = useCanvasStore.getState();
      if (s.agentBusy) return true;
      const last = s.turns[s.turns.length - 1];
      return last?.role === 'assistant' && last.streaming === true;
    },
    dispatch: (ev: SyncEvent) => useCanvasStore.getState()._onSync(ev),
  };
}

function mockEventsApi(responses: Record<number, { events: JournalRowWire[]; lastSeq: number; truncated?: boolean }>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = new URL(String(input), 'http://localhost');
      const afterSeq = Number(url.searchParams.get('afterSeq'));
      const canned = responses[afterSeq] ?? { events: [], lastSeq: 0, count: 0, truncated: false };
      return new Response(JSON.stringify({ ...canned, count: canned.events.length, truncated: canned.truncated ?? false }), { status: 200 });
    }),
  );
}

describe('reconnect catch-up through the real store stack', () => {
  beforeEach(() => {
    resetStore();
    localStorage.clear();
    __clearPendingWatermarkAdvances();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __clearPendingWatermarkAdvances();
  });

  it('unstrands a turn that was cancelled while the client was disconnected', async () => {
    const { runId, assistantMessageId } = seedOpenTurn('design a landing page');
    // Watermark persisted before the disconnect (end of the previous turn).
    localStorage.setItem('agentcanvas.journal-watermark.v1', JSON.stringify({ [DOC_ID]: 40 }));

    mockEventsApi({
      40: {
        events: [
          row(41, 'agent:message_start', { type: 'agent:message_start', role: 'assistant' }),
          row(42, 'agent:tool_call_start', { type: 'agent:tool_call_start', toolCallId: 'tc-gap', toolName: 'pen_create_shape', argsPreview: 'rect…' }, 'tc-gap'),
          row(43, 'agent:tool_call_end', { type: 'agent:tool_call_end', toolCallId: 'tc-gap', success: true, summary: 'created' }, 'tc-gap'),
          row(44, 'agent:turn_cancelled', { type: 'agent:turn_cancelled' }),
        ],
        lastSeq: 44,
      },
    });

    await runJournalCatchUp(DOC_ID, storeAdapter());

    // The stranded turn is finalized honestly — no 10-minute zombie wait.
    const s = useCanvasStore.getState();
    expect(s.agentBusy).toBe(false);
    expect(s.turns[1].streaming).toBe(false);
    expect(s.turns[1].toolCalls.map((tc) => tc.id)).toEqual(['tc-gap']);

    const ss = useSessionStore.getState();
    expect(ss.getMessage(assistantMessageId)?.status).toBe('cancelled');
    expect(ss.getRun(runId)?.status).toBe('cancelled');
    expect(loadWatermark(DOC_ID)).toBe(44);
  });

  it('unstrands a turn that ERRORED while the client was disconnected', async () => {
    const { runId, assistantMessageId } = seedOpenTurn('design a card');
    localStorage.setItem('agentcanvas.journal-watermark.v1', JSON.stringify({ [DOC_ID]: 10 }));

    mockEventsApi({
      10: {
        events: [
          row(11, 'agent:error', { type: 'agent:error', message: 'HTTP 502: Bad Gateway', code: 'server', retryable: true }),
        ],
        lastSeq: 11,
      },
    });

    await runJournalCatchUp(DOC_ID, storeAdapter());

    const ss = useSessionStore.getState();
    expect(ss.getMessage(assistantMessageId)?.status).toBe('error');
    expect(ss.getRun(runId)?.status).toBe('failed');
    expect(useCanvasStore.getState().agentBusy).toBe(false);
  });

  it('does not double-append a tool call that was in flight at disconnect (id-guard)', async () => {
    seedOpenTurn('design a badge');
    localStorage.setItem('agentcanvas.journal-watermark.v1', JSON.stringify({ [DOC_ID]: 20 }));

    mockEventsApi({
      20: {
        events: [
          // The same tool_call_start the client received live just before the
          // drop — it is ALSO in the journal window. Must not duplicate.
          row(21, 'agent:tool_call_start', { type: 'agent:tool_call_start', toolCallId: 'tc-inflight', toolName: 'pen_update_shape', argsPreview: 'x=10' }, 'tc-inflight'),
          row(22, 'agent:turn_end', { type: 'agent:turn_end' }),
        ],
        lastSeq: 22,
      },
    });

    await runJournalCatchUp(DOC_ID, storeAdapter());

    const toolCalls = useCanvasStore.getState().turns[1].toolCalls;
    expect(toolCalls.filter((tc) => tc.id === 'tc-inflight')).toHaveLength(1);
  });

  it('terminal events processed during replay schedule the watermark advance', async () => {
    vi.useFakeTimers();
    seedOpenTurn('design a hero');
    localStorage.setItem('agentcanvas.journal-watermark.v1', JSON.stringify({ [DOC_ID]: 30 }));

    let lastSeqProbes = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = new URL(String(input), 'http://localhost');
        const afterSeq = Number(url.searchParams.get('afterSeq'));
        if (afterSeq === Number.MAX_SAFE_INTEGER) {
          lastSeqProbes++;
          return new Response(JSON.stringify({ events: [], lastSeq: 33, count: 0, truncated: false }), { status: 200 });
        }
        // afterSeq=30 → one terminal row.
        return new Response(
          JSON.stringify({
            events: [row(31, 'agent:turn_end', { type: 'agent:turn_end' })],
            lastSeq: 31,
            count: 1,
            truncated: false,
          }),
          { status: 200 },
        );
      }),
    );

    await runJournalCatchUp(DOC_ID, storeAdapter());

    // The replayed terminal event routed through _onSync armed the debounced
    // advance (the _onSync hook fires for replayed events too).
    await vi.advanceTimersByTimeAsync(800);
    expect(lastSeqProbes).toBeGreaterThanOrEqual(1);
    // Monotonic guard: 31 (replay save) then 33 (probe save) — never lower.
    expect(loadWatermark(DOC_ID)).toBe(33);
    vi.useRealTimers();
  });
});
