// Chat-parity tests — the Cursor-class chat behaviors from docs/chat-parity.md
// and the pi-agent turn surfaces (thinking / plan / critique / queueing).
//
// Three layers:
//   1. Pure mention engine (chat-mentions.ts) — token detection, fuzzy match,
//      apply, and submit-time @Name → layer-id resolution.
//   2. Draft persistence (draft-store.ts) — save/load/clear round-trips.
//   3. Canvas store reducer — the NEW SyncEvent cases that used to be dropped
//      (agent:thinking_delta, agent:critique), thinking-phase close-out on
//      message_delta/tool_call_start, tool-call durations, error surfacing
//      (no more text pollution), and Cursor-style queueing + edit & resend +
//      feedback actions.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useCanvasStore } from '@/lib/canvas/store';
import { useSessionStore } from '@/lib/sessions';
import type { CanvasDocument, Shape, SyncEvent } from '@/lib/canvas/types';
import type { PenChild } from '@/lib/pen/types';
import {
  activeMentionToken,
  matchMentions,
  applyMention,
  extractMentionedLayerIds,
  mentionableLayers,
} from '@/lib/agent/chat-mentions';
import { saveDraft, loadDraft, clearDraft } from '@/lib/agent/draft-store';

// ---- Fixtures ----------------------------------------------------------------

function makeShape(id: string, name: string, type = 'rectangle'): Shape {
  return {
    id,
    type,
    name,
    x: 0, y: 0, width: 100, height: 100,
    rotation: 0, opacity: 1,
    fill: '#ccc', stroke: '#000', strokeWidth: 0,
    radius: 0, fontSize: 16, textColor: '#000',
    parentId: null, zIndex: 0,
    locked: false, visible: true,
    autoLayout: null, tokenBinding: null, componentId: null,
    points: null, closed: false, src: null, radii: null,
    gradient: null, shadow: null, blur: 0, maskId: null,
    constraints: null,
  } as unknown as Shape;
}

function makeDoc(shapes: Shape[] = []): CanvasDocument {
  return {
    id: 'test-doc',
    name: 'Test',
    background: '#ffffff',
    version: '2.17',
    children: shapes as unknown as PenChild[],
    viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes,
    tokens: { colors: [], textStyles: [] },
  };
}

/// Seed a live assistant turn the way promptAgent does, without touching the
/// network (socket null → but we call the reducer directly, so no fetch path
/// is armed). This mirrors the reducer's expectations: last turn = assistant.
function seedAssistantTurn() {
  useCanvasStore.setState((s) => ({
    turns: [
      ...s.turns,
      { id: 'u1', role: 'user', text: 'design a login screen', toolCalls: [], streaming: false },
      { id: 'a1', role: 'assistant', text: '', toolCalls: [], streaming: true, startedAt: Date.now() },
    ],
    agentBusy: true,
  }));
}

function lastTurn() {
  return useCanvasStore.getState().turns[useCanvasStore.getState().turns.length - 1];
}

function resetStore(doc: CanvasDocument = makeDoc([])) {
  useCanvasStore.setState({
    document: doc,
    selectedIds: [],
    agentHighlightIds: [],
    socket: null,
    connected: false,
    viewerCount: 1,
    turns: [],
    agentBusy: false,
    queuedPrompts: [],
    documentId: 'test-doc',
    activeSessionId: null,
    undoStack: [],
    redoStack: [],
    guideLines: [],
    guideUndoStack: [],
    guideRedoStack: [],
    checkpoints: [],
    lastCheckpointSignature: null,
    turnCounter: 0,
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

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  resetStore();
});

// ---- 1. @-mention engine -------------------------------------------------------

describe('chat-mentions: activeMentionToken', () => {
  it('detects a trailing @token while it is being typed', () => {
    expect(activeMentionToken('make @Head')).toBe('Head');
    expect(activeMentionToken('@Head')).toBe('Head');
  });

  it('returns null once a space closes the mention (menu closes)', () => {
    expect(activeMentionToken('make @Head blue')).toBeNull();
  });

  it('returns null for a bare @ with no token', () => {
    expect(activeMentionToken('email me at @')).toBe('');
  });

  it('returns null when @ is mid-word (not a mention)', () => {
    expect(activeMentionToken('user@example.com')).toBeNull();
  });

  it('returns null once a space closes the mention', () => {
    expect(activeMentionToken('make @Header sticky now')).toBeNull();
  });

  it('tracks the caret position (mid-string tokens)', () => {
    expect(activeMentionToken('make @He red and big', 8)).toBe('He');
    // Caret AFTER the closing space → the mention is no longer active there.
    expect(activeMentionToken('make @He red and big', 9)).toBeNull();
  });
});

describe('chat-mentions: matchMentions', () => {
  const layers = mentionableLayers([
    makeShape('s1', 'Header', 'frame'),
    makeShape('s2', 'Hero Section', 'group'),
    makeShape('s3', 'Button', 'rectangle'),
  ]);

  it('bare @ lists containers first, then document order', () => {
    const out = matchMentions('', layers);
    expect(out[0].name).toBe('Header'); // frame/group surface first
    expect(out.map((m) => m.name)).toContain('Button');
  });

  it('prefix match outranks substring match', () => {
    const out = matchMentions('But', layers);
    expect(out[0].name).toBe('Button');
  });

  it('fuzzy acronym match resolves multi-word names', () => {
    const out = matchMentions('hs', layers);
    expect(out.map((m) => m.name)).toContain('Hero Section');
  });

  it('exact normalized match scores highest', () => {
    const out = matchMentions('hero section', layers);
    expect(out[0].name).toBe('Hero Section');
  });

  it('returns [] when nothing matches', () => {
    expect(matchMentions('zzz', layers)).toEqual([]);
  });

  it('skips invisible + unnamed shapes in mentionableLayers', () => {
    const filtered = mentionableLayers([
      makeShape('a', 'Visible'),
      { ...makeShape('b', 'Hidden'), visible: false },
      { ...makeShape('c', ''), name: '' },
    ]);
    expect(filtered.map((m) => m.name)).toEqual(['Visible']);
  });
});

describe('chat-mentions: applyMention + extractMentionedLayerIds', () => {
  const shapes = [makeShape('s1', 'Header'), makeShape('s2', 'Hero Section')];

  it('applyMention replaces the token with @Name + trailing space', () => {
    expect(applyMention('recolor @He', { id: 's1', name: 'Header', type: 'frame' })).toBe(
      'recolor @Header ',
    );
  });

  it('extractMentionedLayerIds resolves @Name tokens to ids (space-safe)', () => {
    expect(extractMentionedLayerIds('recolor @Header and @Hero Section', shapes)).toEqual(['s1', 's2']);
  });

  it('multi-word mentions beat shorter same-prefix names (longest-first)', () => {
    const both = [makeShape('long', 'Hero Section'), makeShape('short', 'Hero')];
    expect(extractMentionedLayerIds('fix @Hero Section only', both)).toEqual(['long']);
    expect(extractMentionedLayerIds('fix @Hero only', both)).toEqual(['short']);
  });

  it('tolerates trailing punctuation on mentions', () => {
    expect(extractMentionedLayerIds('fix @Header, make it blue', shapes)).toEqual(['s1']);
  });

  it('unknown names are skipped silently (the LLM still reads them)', () => {
    expect(extractMentionedLayerIds('fix @NoSuchLayer', shapes)).toEqual([]);
  });

  it('applyMention is a no-op without an active token', () => {
    expect(applyMention('no token here', { id: 's1', name: 'Header', type: 'frame' })).toBe(
      'no token here',
    );
  });
});

// ---- 2. Draft persistence -----------------------------------------------------

describe('draft-store: per-document draft persistence', () => {
  it('save → load round-trips a draft', () => {
    saveDraft('doc-1', 'finish the pricing page with');
    expect(loadDraft('doc-1')).toBe('finish the pricing page with');
  });

  it('drafts are isolated per document', () => {
    saveDraft('doc-1', 'draft one');
    saveDraft('doc-2', 'draft two');
    expect(loadDraft('doc-1')).toBe('draft one');
    expect(loadDraft('doc-2')).toBe('draft two');
  });

  it('clearDraft removes the draft (empty string after clear)', () => {
    saveDraft('doc-1', 'to be cleared');
    clearDraft('doc-1');
    expect(loadDraft('doc-1')).toBe('');
  });

  it('saving an empty string removes the key (no empty-draft litter)', () => {
    saveDraft('doc-1', 'x');
    saveDraft('doc-1', '');
    expect(loadDraft('doc-1')).toBe('');
    expect(window.localStorage.getItem('agentcanvas.draft.v1:doc-1')).toBeNull();
  });
});

// ---- 3. Store reducer — pi-agent turn surfaces ---------------------------------

describe('store: agent:thinking_delta (reasoning stream)', () => {
  it('accumulates thinking text and stamps thinkingStartedAt on the first delta', () => {
    seedAssistantTurn();
    const t0 = Date.now();
    useCanvasStore.getState()._onSync({ type: 'agent:thinking_delta', text: 'The user wants ' } as SyncEvent);
    useCanvasStore.getState()._onSync({ type: 'agent:thinking_delta', text: 'a login screen.' } as SyncEvent);
    const turn = lastTurn();
    expect(turn.thinking).toBe('The user wants a login screen.');
    expect(turn.thinkingStartedAt).toBeGreaterThanOrEqual(t0);
    expect(turn.thinkingEndedAt).toBeUndefined();
  });

  it('closes the thinking phase when the answer text starts (message_delta)', () => {
    seedAssistantTurn();
    useCanvasStore.getState()._onSync({ type: 'agent:thinking_delta', text: 'reasoning…' } as SyncEvent);
    useCanvasStore.getState()._onSync({ type: 'agent:message_delta', text: 'Here is ' } as SyncEvent);
    const turn = lastTurn();
    expect(turn.thinkingEndedAt).toBeDefined();
    expect(turn.thinking!.length).toBeGreaterThan(0);
    expect(turn.text).toBe('Here is ');
    // thinkingMs is derived in the UI from the two stamps — both present.
    expect(turn.thinkingStartedAt!).toBeLessThanOrEqual(turn.thinkingEndedAt!);
  });

  it('closes the thinking phase when a tool call starts (think → act order)', () => {
    seedAssistantTurn();
    useCanvasStore.getState()._onSync({ type: 'agent:thinking_delta', text: 'plan first' } as SyncEvent);
    useCanvasStore.getState()._onSync({
      type: 'agent:tool_call_start',
      toolCallId: 'tc1',
      toolName: 'pen_create_node',
      argsPreview: '{"type":"frame"}',
    } as SyncEvent);
    expect(lastTurn().thinkingEndedAt).toBeDefined();
  });

  it('does NOT stamp thinkingEndedAt when no thinking ever streamed', () => {
    seedAssistantTurn();
    useCanvasStore.getState()._onSync({ type: 'agent:message_delta', text: 'plain answer' } as SyncEvent);
    expect(lastTurn().thinkingEndedAt).toBeUndefined();
  });
});

describe('store: agent:critique (self-review loop)', () => {
  it('stores the critique payload on the streaming assistant turn', () => {
    seedAssistantTurn();
    useCanvasStore.getState()._onSync({
      type: 'agent:critique',
      iteration: 2,
      defects: ['text contrast too low on CTA', 'cards lack shadow'],
      validation: {
        totalShapes: 12, textShapes: 5, cardShapes: 3, textShapesWithWeight: 4,
        cardShapesWithShadow: 2, autoLayoutContainers: 1,
      },
      textSeverity: 'medium',
      vlmSeverity: 'low',
      vlmScore: 8.1,
    } as unknown as SyncEvent);
    const turn = lastTurn();
    expect(turn.critique).toMatchObject({
      iteration: 2,
      defects: ['text contrast too low on CTA', 'cards lack shadow'],
      vlmScore: 8.1,
    });
  });

  it('later critique iterations overwrite earlier ones (last critique gates output)', () => {
    seedAssistantTurn();
    const base: Record<string, unknown> = {
      type: 'agent:critique',
      defects: [],
      validation: {},
      textSeverity: 'low',
      vlmSeverity: 'low',
    };
    useCanvasStore.getState()._onSync({ ...base, iteration: 1, vlmScore: 6.4 } as unknown as SyncEvent);
    useCanvasStore.getState()._onSync({ ...base, iteration: 2, vlmScore: 8.9 } as unknown as SyncEvent);
    expect(lastTurn().critique?.vlmScore).toBe(8.9);
  });
});

describe('store: tool call durations', () => {
  it('tool_call_start stamps startedAt; tool_call_end stamps endedAt', async () => {
    seedAssistantTurn();
    useCanvasStore.getState()._onSync({
      type: 'agent:tool_call_start',
      toolCallId: 'tc1',
      toolName: 'pen_create_node',
      argsPreview: '{"type":"rectangle"}',
    } as SyncEvent);
    const started = lastTurn().toolCalls[0].startedAt;
    expect(started).toBeDefined();
    await new Promise((r) => setTimeout(r, 5));
    useCanvasStore.getState()._onSync({
      type: 'agent:tool_call_end',
      toolCallId: 'tc1',
      success: true,
      summary: 'Created rectangle',
    } as SyncEvent);
    const tc = lastTurn().toolCalls[0];
    expect(tc.endedAt!).toBeGreaterThan(started!);
    expect(tc.success).toBe(true);
  });
});

describe('store: agent:error no longer pollutes the markdown text', () => {
  it('sets turn.error WITHOUT splicing ⚠️ text into the answer', () => {
    seedAssistantTurn();
    useCanvasStore.getState()._onSync({ type: 'agent:message_delta', text: 'Here is your design.' } as SyncEvent);
    useCanvasStore.getState()._onSync({ type: 'agent:error', message: 'upstream rate limited' } as SyncEvent);
    const turn = lastTurn();
    expect(turn.error).toBe('upstream rate limited');
    expect(turn.text).toBe('Here is your design.'); // untouched — copy stays clean
    expect(turn.streaming).toBe(false);
    expect(useCanvasStore.getState().agentBusy).toBe(false);
  });
});

// ---- 4. Store actions — queue / edit / feedback --------------------------------

describe('store: Cursor-style prompt queueing', () => {
  it('queuePrompt appends while busy; flush order is FIFO', () => {
    seedAssistantTurn();
    const s = useCanvasStore.getState();
    s.queuePrompt('second task');
    s.queuePrompt('third task');
    expect(useCanvasStore.getState().queuedPrompts.map((q) => q.text)).toEqual(['second task', 'third task']);
  });

  it('queuePrompt is a no-op while idle (send directly instead)', () => {
    useCanvasStore.getState().queuePrompt('should not queue');
    expect(useCanvasStore.getState().queuedPrompts).toEqual([]);
  });

  it('removeQueuedPrompt drops a queued message', () => {
    seedAssistantTurn();
    useCanvasStore.getState().queuePrompt('task a');
    useCanvasStore.getState().queuePrompt('task b');
    const id = useCanvasStore.getState().queuedPrompts[0].id;
    useCanvasStore.getState().removeQueuedPrompt(id);
    expect(useCanvasStore.getState().queuedPrompts.map((q) => q.text)).toEqual(['task b']);
  });
});

describe('store: setTurnFeedback (thumbs up/down)', () => {
  it('sets, toggles to the other side, and clears on repeat', () => {
    useCanvasStore.setState({
      turns: [{ id: 'a1', role: 'assistant', text: 'hi', toolCalls: [], streaming: false }],
    });
    const s = useCanvasStore.getState();
    s.setTurnFeedback('a1', 'up');
    expect(useCanvasStore.getState().turns[0].feedback).toBe('up');
    s.setTurnFeedback('a1', 'down');
    expect(useCanvasStore.getState().turns[0].feedback).toBe('down');
    s.setTurnFeedback('a1', 'down');
    expect(useCanvasStore.getState().turns[0].feedback).toBeUndefined();
  });
});

describe('store: editUserTurn (Cursor edit semantics)', () => {
  it('refuses while the agent is busy (no mid-run truncation)', () => {
    useCanvasStore.setState({
      agentBusy: true,
      turns: [
        { id: 'u1', role: 'user', text: 'original', toolCalls: [], streaming: false },
        { id: 'a1', role: 'assistant', text: 'answer', toolCalls: [], streaming: true },
      ],
    });
    useCanvasStore.getState().editUserTurn('u1', 'edited');
    expect(useCanvasStore.getState().turns).toHaveLength(2); // untouched
  });

  it('refuses for unknown ids and non-user turns', () => {
    useCanvasStore.setState({
      turns: [{ id: 'a1', role: 'assistant', text: 'x', toolCalls: [], streaming: false }],
    });
    useCanvasStore.getState().editUserTurn('nope', 'edited');
    useCanvasStore.getState().editUserTurn('a1', 'edited');
    expect(useCanvasStore.getState().turns[0].text).toBe('x');
  });
});
