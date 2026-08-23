// Unit tests for the agent-eval hardening fixes:
//   1. Translator duplicate-event suppression (message_end / turn_end)
//   2. (Runner empty-turn guard is exercised in agent-eval scenarios; the
//      translator-level guarantees it depends on are covered here.)
//
// See scripts/agent-eval/ for the scenario-based evaluator that caught these.

import { describe, it, expect } from 'vitest';
import {
  translateAgentSessionEvent,
  createTranslatorState,
} from '../../src/lib/agent/agent-session-translator';
import { applyLofiFidelity } from '../../src/lib/agent/tools';

const typesOf = (events: ReturnType<typeof translateAgentSessionEvent>) =>
  events.filter((e) => e.kind === 'agent_event').map((e) => (e as any).event.type as string);

describe('translator duplicate-event suppression', () => {
  it('a normal turn emits exactly one message_end and one turn_end', () => {
    const state = createTranslatorState();
    const seq = [
      { type: 'message_start' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi' } },
      { type: 'message_end' },
      { type: 'agent_end' },
    ];
    const all: string[] = [];
    for (const ev of seq as any[]) all.push(...typesOf(translateAgentSessionEvent(ev, state)));
    expect(all.filter((t) => t === 'agent:message_end')).toHaveLength(1);
    expect(all.filter((t) => t === 'agent:turn_end')).toHaveLength(1);
  });

  it('suppresses the duplicate message_end that agent_end used to add on every turn', () => {
    // Without state, message_end + agent_end produced TWO message_end events.
    // With state, exactly one survives.
    const state = createTranslatorState();
    translateAgentSessionEvent({ type: 'message_start' } as any, state);
    translateAgentSessionEvent({ type: 'message_end' } as any, state);
    const tail = typesOf(translateAgentSessionEvent({ type: 'agent_end' } as any, state));
    expect(tail).toEqual(['agent:turn_end']); // no extra message_end
  });

  it('a retry loop (multiple message_start/end pairs, then agent_end) yields ONE turn_end', () => {
    const state = createTranslatorState();
    const events: string[] = [];
    const retrySeq: any[] = [
      { type: 'message_start' },
      { type: 'message_end' },
      { type: 'message_start' },
      { type: 'message_end' },
      { type: 'message_start' },
      { type: 'message_end' },
      { type: 'agent_end' },
      { type: 'agent_end' }, // defensive SDK behavior: can re-fire
    ];
    for (const ev of retrySeq) events.push(...typesOf(translateAgentSessionEvent(ev, state)));
    expect(events.filter((t) => t === 'agent:turn_end')).toHaveLength(1);
    // every start got exactly one matching end
    expect(events.filter((t) => t === 'agent:message_start')).toHaveLength(3);
    expect(events.filter((t) => t === 'agent:message_end')).toHaveLength(3);
  });

  it('closes a dangling open message before a new message_start', () => {
    const state = createTranslatorState();
    translateAgentSessionEvent({ type: 'message_start' } as any, state);
    const out = typesOf(translateAgentSessionEvent({ type: 'message_start' } as any, state));
    expect(out[0]).toBe('agent:message_end'); // auto-close
    expect(out[1]).toBe('agent:message_start');
  });

  it('emits message_end from agent_end when the stream died mid-message', () => {
    const state = createTranslatorState();
    translateAgentSessionEvent({ type: 'message_start' } as any, state);
    const out = typesOf(translateAgentSessionEvent({ type: 'agent_end' } as any, state));
    expect(out).toEqual(['agent:message_end', 'agent:turn_end']);
  });

  it('without state, keeps legacy behavior (no crash, events pass through)', () => {
    const out = typesOf(translateAgentSessionEvent({ type: 'agent_end' } as any));
    expect(out).toEqual(['agent:message_end', 'agent:turn_end']);
  });
});

describe('applyLofiFidelity (generator lo-fi downgrade)', () => {
  it('strips shadows and gradients and grayscales fills', () => {
    const shapes: Array<Record<string, unknown>> = [
      { fill: '#0ea5e9', shadow: { x: 0, y: 4, blur: 6, color: '#0000001a' }, textColor: '#ffffff' },
      { fill: '#ef4444', gradient: { type: 'linear', angle: 135, stops: [{ offset: 0, color: '#fff' }, { offset: 1, color: '#000' }] } },
      { fill: 'transparent' },
    ];
    applyLofiFidelity(shapes as any);
    // saturated blue → grayscale (r=g=b byte repeated 3x)
    expect(shapes[0].fill).toMatch(/^#([0-9a-f]{2})\1\1$/i);
    expect(shapes[0].shadow).toBeUndefined();
    // white text would become unreadable light-gray → forced near-black
    expect(shapes[0].textColor).toBe('#111827');
    expect(shapes[1].gradient).toBeUndefined();
    expect(shapes[1].fill).toMatch(/^#([0-9a-f]{2})\1\1$/i);
    // transparent stays untouched
    expect(shapes[2].fill).toBe('transparent');
  });

  it('keeps text readable: dark text on light fills stays dark', () => {
    const shapes: Array<Record<string, unknown>> = [{ fill: '#f1f5f9', textColor: '#0f172a' }];
    applyLofiFidelity(shapes as any);
    // snapped to the near-black ramp value (#111111) — dark, readable
    expect(shapes[0].textColor).toBe('#111111');
  });
});
