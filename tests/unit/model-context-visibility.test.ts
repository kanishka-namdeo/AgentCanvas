// Unit tests for the model + context-usage visibility feature.
//
// Coverage:
//   Translator:
//   - message_end WITH a usage payload → emits agent:context_update carrying
//     tokenCount (context fill), the state's contextWindow, and the usage
//     breakdown (input/output/cacheRead/cacheWrite/cost).
//   - message_end WITHOUT usage → no context_update (legacy path unchanged).
//   - contextWindow comes from TranslatorState (resolved model), not the
//     old hardcoded 128K.
//   - totalTokens is preferred when > 0; otherwise the four fields sum.
//   - compaction_end uses the state's contextWindow too.
//
//   Store (_onSync):
//   - agent:model_info sets activeModel and syncs session.model.
//   - agent:context_update with usage accumulates usageTotals (llmCalls++).
//   - Per-turn tokenUsage accumulates on the LAST assistant turn.
//   - agent:context_update without usage (compaction path) doesn't touch totals.
//   - Sessions store: setSessionModel updates + no-ops on identical values.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  translateAgentSessionEvent,
  createTranslatorState,
} from '@/lib/agent/agent-session-translator';
import { NATIVE_COMPACTION_SETTINGS, parseEnvTokens } from '@/lib/agent/runner-native';
import { useCanvasStore } from '@/lib/canvas/store';
import { useSessionStore } from '@/lib/sessions';

const agentEventsOf = (events: ReturnType<typeof translateAgentSessionEvent>) =>
  events.filter((e) => e.kind === 'agent_event').map((e) => (e as any).event as Record<string, any>);

// ---- Translator ---------------------------------------------------------------

describe('translator: usage extraction from message_end', () => {
  it('emits agent:context_update with the usage payload and model', () => {
    const state = createTranslatorState(262_144); // resolved model window: 256K
    translateAgentSessionEvent({ type: 'message_start' } as any, state); // open the message first
    const out = agentEventsOf(
      translateAgentSessionEvent(
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            model: 'kimi-k2-5',
            provider: 'custom',
            usage: {
              input: 10_000,
              output: 2_000,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 12_000,
              cost: { total: 0.05 },
            },
          },
        } as any,
        state,
      ),
    );
    const ctx = out.find((e) => e.type === 'agent:context_update');
    expect(ctx).toBeDefined();
    expect(ctx!.tokenCount).toBe(12_000); // prefers totalTokens
    expect(ctx!.contextWindow).toBe(262_144); // from state — NOT hardcoded 128K
    expect(ctx!.usage).toEqual({ input: 10_000, output: 2_000, cacheRead: 0, cacheWrite: 0, cost: 0.05 });
    expect(ctx!.model).toBe('kimi-k2-5');
    // The message_end itself still fires (suppression logic unaffected).
    expect(out.some((e) => e.type === 'agent:message_end')).toBe(true);
  });

  it('sums the four token fields when totalTokens is absent', () => {
    const state = createTranslatorState();
    translateAgentSessionEvent({ type: 'message_start' } as any, state); // open the message first
    const out = agentEventsOf(
      translateAgentSessionEvent(
        {
          type: 'message_end',
          message: {
            usage: { input: 100, output: 50, cacheRead: 25, cacheWrite: 25 },
          },
        } as any,
        state,
      ),
    );
    const ctx = out.find((e) => e.type === 'agent:context_update');
    expect(ctx!.tokenCount).toBe(200);
  });

  it('does not emit context_update when the SDK reports no usage', () => {
    const state = createTranslatorState();
    translateAgentSessionEvent({ type: 'message_start' } as any, state); // open the message first
    const out = agentEventsOf(
      translateAgentSessionEvent({ type: 'message_end' } as any, state),
    );
    expect(out.find((e) => e.type === 'agent:context_update')).toBeUndefined();
    expect(out).toEqual([{ type: 'agent:message_end' }]);
  });

  it('compaction_end reports the state contextWindow and compacted=true', () => {
    const state = createTranslatorState(200_000);
    const out = agentEventsOf(
      translateAgentSessionEvent(
        { type: 'compaction_end', result: { tokensBefore: 190_000, estimatedTokensAfter: 20_000 } } as any,
        state,
      ),
    );
    const ctx = out.find((e) => e.type === 'agent:context_update');
    expect(ctx!.contextWindow).toBe(200_000);
    expect(ctx!.tokenCount).toBe(20_000);
    expect(ctx!.compacted).toBe(true);
    expect(ctx!.usage).toBeUndefined();
  });

  // ---- SDK auto-compaction enablement (2026-09-05 flip) --------------------
  // The native runner now runs compaction: { enabled: true } — these lock the
  // translator's honest-UI contract for the compaction window.
  it('compaction_start raises a status_note so the 10-30s summarization call is not dead air', () => {
    const state = createTranslatorState(131_072);
    const out = agentEventsOf(
      translateAgentSessionEvent({ type: 'compaction_start' } as any, state),
    );
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('agent:status_note');
    expect((out[0] as any).text).toMatch(/compacting/i);
  });

  it('compaction_end clears the status note deterministically (empty note first), then reports savings', () => {
    const state = createTranslatorState(131_072);
    const out = agentEventsOf(
      translateAgentSessionEvent(
        { type: 'compaction_end', result: { tokensBefore: 120_000, estimatedTokensAfter: 30_000 } } as any,
        state,
      ),
    );
    // Order contract: clear-note → context_update → chat notice.
    expect(out[0]).toEqual({ type: 'agent:status_note', text: '' });
    const ctx = out.find((e) => e.type === 'agent:context_update');
    expect(ctx!.tokenCount).toBe(30_000);
    expect(ctx!.compacted).toBe(true);
    const delta = out.find((e) => e.type === 'agent:message_delta') as any;
    expect(delta?.text).toContain('~90000 tokens saved');
  });

  it('compaction_end with no token savings still clears the note and skips the chat notice', () => {
    const state = createTranslatorState(131_072);
    const out = agentEventsOf(
      translateAgentSessionEvent(
        { type: 'compaction_end', result: { tokensBefore: 50_000, estimatedTokensAfter: 50_000 } } as any,
        state,
      ),
    );
    expect(out[0]).toEqual({ type: 'agent:status_note', text: '' });
    expect(out.find((e) => e.type === 'agent:message_delta')).toBeUndefined();
  });

  it('NATIVE_COMPACTION_SETTINGS: enabled, tuned above SDK defaults, fires within a 128K window', () => {
    // The flip contract: production sessions get SDK compaction with
    // thresholds raised for tool-heavy design turns. (Env overrides unset in
    // tests → the compiled defaults are what these assertions see.)
    expect(NATIVE_COMPACTION_SETTINGS.enabled).toBe(true);
    expect(NATIVE_COMPACTION_SETTINGS.reserveTokens).toBeGreaterThan(16_384); // above SDK default
    expect(NATIVE_COMPACTION_SETTINGS.keepRecentTokens).toBeGreaterThan(20_000); // above SDK default
    // Trigger mirrors SDK shouldCompact: tokens > window - reserve.
    const fireAt = 131_072 - NATIVE_COMPACTION_SETTINGS.reserveTokens;
    expect(fireAt).toBeGreaterThan(90_000); // fires before ~98K on 128K
    // Post-compaction context ≈ keepRecentTokens — must sit far BELOW the
    // trigger threshold so the session never compact-loops.
    expect(NATIVE_COMPACTION_SETTINGS.keepRecentTokens + 20_000).toBeLessThan(fireAt);
  });

  it('parseEnvTokens: override knob accepts valid values, rejects garbage and sub-1000 floors', () => {
    const env = { AGENT_COMPACTION_RESERVE_TOKENS: '2000' };
    const saved = process.env.AGENT_COMPACTION_RESERVE_TOKENS;
    try {
      process.env.AGENT_COMPACTION_RESERVE_TOKENS = env.AGENT_COMPACTION_RESERVE_TOKENS;
      expect(parseEnvTokens('AGENT_COMPACTION_RESERVE_TOKENS', 32_768)).toBe(2_000);
      process.env.AGENT_COMPACTION_RESERVE_TOKENS = 'not-a-number';
      expect(parseEnvTokens('AGENT_COMPACTION_RESERVE_TOKENS', 32_768)).toBe(32_768);
      process.env.AGENT_COMPACTION_RESERVE_TOKENS = '500'; // below the 1000 floor
      expect(parseEnvTokens('AGENT_COMPACTION_RESERVE_TOKENS', 32_768)).toBe(32_768);
      delete process.env.AGENT_COMPACTION_RESERVE_TOKENS;
      expect(parseEnvTokens('AGENT_COMPACTION_RESERVE_TOKENS', 32_768)).toBe(32_768);
    } finally {
      if (saved === undefined) delete process.env.AGENT_COMPACTION_RESERVE_TOKENS;
      else process.env.AGENT_COMPACTION_RESERVE_TOKENS = saved;
    }
  });
});

// ---- Store: agent:model_info ---------------------------------------------------

function resetStores() {
  useCanvasStore.setState({
    turns: [],
    agentBusy: false,
    documentId: 'test-doc',
    activeSessionId: null,
    activeModel: null,
    contextTokens: 0,
    contextWindow: 128_000,
    lastCompacted: false,
    usageTotals: {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      cacheWriteTokens: 0, cost: 0, llmCalls: 0,
    },
  });
  useSessionStore.setState({
    sessions: {}, runs: {}, messages: {}, toolCalls: {},
    snapshots: {}, activeSessionByDoc: {},
  });
}

describe('store: agent:model_info handling', () => {
  beforeEach(() => resetStores());

  it('sets activeModel and syncs the session model', () => {
    const ss = useSessionStore.getState();
    const session = ss.createSession('test-doc', { title: 'T' });
    useCanvasStore.setState({ activeSessionId: session.id });

    useCanvasStore.getState()._onSync({
      type: 'agent:model_info',
      provider: 'custom',
      modelId: 'kimi-k2-5',
      label: 'custom/kimi-k2-5',
      contextWindow: 131_072,
      maxTokens: 32_768,
      usedFallback: false,
    });

    const s = useCanvasStore.getState();
    expect(s.activeModel).toMatchObject({
      provider: 'custom', modelId: 'kimi-k2-5', contextWindow: 131_072,
      maxTokens: 32_768, usedFallback: false,
    });
    expect(useSessionStore.getState().sessions[session.id].model).toBe('kimi-k2-5');
  });

  it('tolerates a missing active session without throwing', () => {
    useCanvasStore.getState()._onSync({
      type: 'agent:model_info',
      provider: 'zai', modelId: 'glm-5.3', label: 'zai/glm-5.3',
      contextWindow: 131_072, maxTokens: 8192, usedFallback: true,
    });
    expect(useCanvasStore.getState().activeModel?.modelId).toBe('glm-5.3');
  });
});

// ---- Store: agent:context_update with usage ------------------------------------

describe('store: context_update usage accumulation', () => {
  beforeEach(() => resetStores());

  it('accumulates usageTotals and per-turn tokenUsage across LLM calls', () => {
    const assistantTurn = {
      id: 'a1', role: 'assistant' as const, text: '', toolCalls: [],
      streaming: true, startedAt: Date.now(),
    };
    useCanvasStore.setState({ turns: [{ id: 'u1', role: 'user' as const, text: 'hi', toolCalls: [], streaming: false }, assistantTurn] });

    const onSync = useCanvasStore.getState()._onSync;
    onSync({
      type: 'agent:context_update', tokenCount: 5_000, contextWindow: 131_072,
      usage: { input: 4_000, output: 1_000, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
    });
    onSync({
      type: 'agent:context_update', tokenCount: 9_000, contextWindow: 131_072,
      usage: { input: 7_000, output: 2_000, cacheRead: 0, cacheWrite: 0, cost: 0.02 },
    });

    const s = useCanvasStore.getState();
    expect(s.contextTokens).toBe(9_000); // last call's context fill
    expect(s.usageTotals.llmCalls).toBe(2);
    expect(s.usageTotals.inputTokens).toBe(11_000);
    expect(s.usageTotals.outputTokens).toBe(3_000);
    expect(s.usageTotals.cost).toBeCloseTo(0.03);
    const last = s.turns[s.turns.length - 1];
    expect(last.tokenUsage).toEqual({ input: 11_000, output: 3_000 });
  });

  it('usage-less context_update (compaction) leaves totals untouched', () => {
    useCanvasStore.setState({
      usageTotals: {
        inputTokens: 100, outputTokens: 50, cacheReadTokens: 0,
        cacheWriteTokens: 0, cost: 0.01, llmCalls: 1,
      },
    });
    useCanvasStore.getState()._onSync({
      type: 'agent:context_update', tokenCount: 1_000, contextWindow: 128_000, compacted: true,
    });
    const s = useCanvasStore.getState();
    expect(s.usageTotals.llmCalls).toBe(1);
    expect(s.lastCompacted).toBe(true);
    expect(s.contextTokens).toBe(1_000);
  });
});

// ---- Sessions store: setSessionModel --------------------------------------------

describe('sessions store: setSessionModel', () => {
  beforeEach(() => resetStores());

  it('updates the model once and no-ops on repeats', () => {
    const ss = useSessionStore.getState();
    const session = ss.createSession('test-doc', {});
    expect(session.model).toBe('unresolved'); // no fake seed

    ss.setSessionModel(session.id, 'glm-5.3');
    expect(useSessionStore.getState().sessions[session.id].model).toBe('glm-5.3');

    // Repeated identical writes are a no-op (same object reference back).
    const before = useSessionStore.getState().sessions[session.id];
    ss.setSessionModel(session.id, 'glm-5.3');
    expect(useSessionStore.getState().sessions[session.id]).toBe(before);
  });
});
