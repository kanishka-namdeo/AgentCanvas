// Unit tests for the chat-UX feature modules added in the research-driven
// feature pass:
//   - src/lib/agent/followups.ts     (contextual follow-up suggestions)
//   - src/lib/agent/chat-commands.ts (slash-command registry + matching)
//   - src/lib/agent/prompt-history.ts (terminal-style prompt recall)

import { describe, it, expect, beforeEach } from 'vitest';
import { suggestFollowUps, type FollowUpContext } from '../../src/lib/agent/followups';
import { matchCommands, resolveCommand, CHAT_COMMANDS } from '../../src/lib/agent/chat-commands';
import {
  pushPromptHistory,
  getPromptHistory,
  navigateHistory,
  _resetPromptHistoryForTests,
} from '../../src/lib/agent/prompt-history';
import type { Shape } from '../../src/lib/canvas/types';

// ---- fixtures ---------------------------------------------------------------

function ctx(partial: Partial<FollowUpContext> = {}): FollowUpContext {
  return {
    tools: [],
    assistantText: '',
    userPrompt: '',
    shapes: [],
    hasColorVariables: false,
    ...partial,
  };
}

function shape(p: Partial<Shape>): Shape {
  return {
    id: 'x', type: 'rectangle', name: 'x', x: 0, y: 0, width: 10, height: 10,
    rotation: 0, opacity: 1, fill: '#fff', stroke: '#000', strokeWidth: 0, radius: 0,
    fontSize: 14, textColor: '#000', parentId: null, zIndex: 0, locked: false, visible: true,
    ...p,
  };
}

// ---- followups ---------------------------------------------------------------

describe('suggestFollowUps', () => {
  it('suggests a hi-fi upgrade after an explicit wireframe request', () => {
    const out = suggestFollowUps(ctx({
      userPrompt: 'draw a low-fidelity wireframe of a blog',
      tools: [{ name: 'pen_generate_wireframe', success: true }],
    }));
    expect(out[0]).toMatch(/high-fidelity/i);
    expect(out.length).toBeGreaterThanOrEqual(3);
    expect(out.length).toBeLessThanOrEqual(4);
  });

  it('suggests a follow-on flow after a screen was generated', () => {
    const out = suggestFollowUps(ctx({
      userPrompt: 'design a login screen',
      tools: [{ name: 'pen_generate_wireframe', success: true }, { name: 'pen_apply_palette', success: true }],
    }));
    expect(out.some((s) => /onboarding flow/i.test(s))).toBe(true);
  });

  it('suggests applying the palette after palette generation', () => {
    const out = suggestFollowUps(ctx({
      userPrompt: 'generate a sunset palette',
      tools: [{ name: 'pen_generate_palette', success: true }],
    }));
    expect(out.some((s) => /apply this palette/i.test(s))).toBe(true);
  });

  it('suggests token extraction when colors exist but no variables', () => {
    const out = suggestFollowUps(ctx({
      shapes: Array.from({ length: 8 }, () => shape({})),
      hasColorVariables: false,
    }));
    expect(out.some((s) => /design tokens/i.test(s))).toBe(true);
  });

  it('never returns duplicates and always fills 3-4 suggestions', () => {
    const out = suggestFollowUps(ctx({
      tools: [{ name: 'pen_generate_user_flow', success: true }],
      shapes: Array.from({ length: 60 }, (_, i) => shape({ name: `l${i}` })),
    }));
    expect(new Set(out).size).toBe(out.length);
    expect(out.length).toBeGreaterThanOrEqual(3);
    expect(out.length).toBeLessThanOrEqual(4);
  });
});

// ---- chat-commands ------------------------------------------------------------

describe('matchCommands', () => {
  it('returns all commands for bare "/"', () => {
    expect(matchCommands('/')).toEqual(CHAT_COMMANDS);
  });

  it('prefix-matches sorted first', () => {
    const out = matchCommands('/ex');
    expect(out.map((c) => c.cmd)).toEqual(['/export-svg', '/export-png', '/export-json']);
  });

  it('returns nothing for non-command input', () => {
    expect(matchCommands('design a login')).toEqual([]);
    expect(matchCommands('')).toEqual([]);
  });

  it('hides the list once the user types arguments', () => {
    expect(matchCommands('/audit my spacing')).toEqual([]);
  });
});

describe('resolveCommand', () => {
  it('resolves a fully-typed command with no args', () => {
    const cmd = CHAT_COMMANDS.find((c) => c.cmd === '/clear')!;
    const r = resolveCommand('/clear', cmd);
    expect(r).not.toBeNull();
    expect(r!.command.run).toBe('clear');
    expect(r!.args).toBe('');
  });

  it('captures trailing free text as args for prompt commands', () => {
    const cmd = CHAT_COMMANDS.find((c) => c.cmd === '/audit')!;
    const r = resolveCommand('/audit focus on contrast', cmd);
    expect(r!.args).toBe('focus on contrast');
  });

  it('resolves an autocomplete prefix to the selected command', () => {
    const cmd = CHAT_COMMANDS.find((c) => c.cmd === '/export-svg')!;
    const r = resolveCommand('/ex', cmd);
    expect(r!.command.cmd).toBe('/export-svg');
    expect(r!.args).toBe('');
  });
});

// ---- prompt-history ------------------------------------------------------------

describe('prompt history', () => {
  beforeEach(() => {
    _resetPromptHistoryForTests();
  });

  it('stores prompts and de-duplicates consecutive repeats', () => {
    pushPromptHistory('design a login');
    pushPromptHistory('design a login');
    pushPromptHistory('make it dark');
    expect(getPromptHistory()).toEqual(['design a login', 'make it dark']);
  });

  it('ArrowUp from live input recalls the newest, then iterates back', () => {
    pushPromptHistory('first');
    pushPromptHistory('second');
    pushPromptHistory('third');
    let cur = -1;
    const up1 = navigateHistory(cur, 'up')!;
    expect(up1.text).toBe('third');
    cur = up1.cursor;
    const up2 = navigateHistory(cur, 'up')!;
    expect(up2.text).toBe('second');
  });

  it('ArrowDown iterates forward and returns to live input', () => {
    pushPromptHistory('only');
    const up = navigateHistory(-1, 'up')!;
    expect(up.text).toBe('only');
    const down = navigateHistory(up.cursor, 'down')!;
    expect(down.cursor).toBe(-1);
    expect(down.text).toBe('');
    expect(navigateHistory(-1, 'down')).toBeNull();
  });

  it('returns null on ArrowUp with empty history', () => {
    expect(navigateHistory(-1, 'up')).toBeNull();
  });
});
