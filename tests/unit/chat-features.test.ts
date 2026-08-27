// Unit tests for the chat-UX feature modules added in the research-driven
// feature pass:
//   - src/lib/agent/followups.ts     (contextual follow-up suggestions)
//   - src/lib/agent/chat-commands.ts (slash-command registry + matching)
//   - src/lib/agent/prompt-history.ts (terminal-style prompt recall)

import { describe, it, expect, beforeEach } from 'vitest';
import { suggestFollowUps, type FollowUpContext } from '../../src/lib/agent/followups';
import {
  matchCommands,
  resolveCommand,
  parseCommandInput,
  resolvePackName,
  CHAT_COMMANDS,
} from '../../src/lib/agent/chat-commands';
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

// ---- /pick-pack ---------------------------------------------------------------

describe('/pick-pack command registration', () => {
  it('registers /pick-pack as an instant client-side action with args', () => {
    const cmd = CHAT_COMMANDS.find((c) => c.cmd === '/pick-pack');
    expect(cmd).toBeDefined();
    expect(cmd!.kind).toBe('action');
    expect(cmd!.run).toBe('pick-pack');
    expect(cmd!.args).toBe(true);
  });

  it('parses fully-typed /pick-pack with an argument', () => {
    const r = parseCommandInput('/pick-pack geist');
    expect(r.kind).toBe('exact');
    if (r.kind === 'exact') {
      expect(r.command.cmd).toBe('/pick-pack');
      expect(r.args).toBe('geist');
    }
  });

  it('autocompletes the /pi prefix to /pick-pack first', () => {
    const out = matchCommands('/pi');
    expect(out[0]!.cmd).toBe('/pick-pack');
  });
});

// The registry's 5 packs — the same summaries GET /api/design-systems returns.
const PACK_FIXTURES = [
  { name: 'shadcn-default' },
  { name: 'vercel-geist' },
  { name: 'mantine-default' },
  { name: 'radix-themes' },
  { name: 'tailwind-catalyst' },
];

describe('resolvePackName (fuzzy /pick-pack resolution)', () => {
  it('resolves exact names case-insensitively', () => {
    expect(resolvePackName('vercel-geist', PACK_FIXTURES)).toBe('vercel-geist');
    expect(resolvePackName('Radix-Themes', PACK_FIXTURES)).toBe('radix-themes');
  });

  it('resolves suffix shortcuts (geist → vercel-geist)', () => {
    expect(resolvePackName('geist', PACK_FIXTURES)).toBe('vercel-geist');
  });

  it('resolves substring shortcuts (radix, catalyst)', () => {
    expect(resolvePackName('radix', PACK_FIXTURES)).toBe('radix-themes');
    expect(resolvePackName('catalyst', PACK_FIXTURES)).toBe('tailwind-catalyst');
  });

  it('resolves dash-word synonyms (shadcn, tailwind, mantine)', () => {
    expect(resolvePackName('shadcn', PACK_FIXTURES)).toBe('shadcn-default');
    expect(resolvePackName('tailwind', PACK_FIXTURES)).toBe('tailwind-catalyst');
    expect(resolvePackName('mantine', PACK_FIXTURES)).toBe('mantine-default');
  });

  it('resolves short prefixes of dash-words (ver → vercel-geist)', () => {
    // 'ver' is ≥3 chars and prefix-matches the 'vercel' word.
    expect(resolvePackName('ver', PACK_FIXTURES)).toBe('vercel-geist');
  });

  it('returns null for unknown or empty args', () => {
    expect(resolvePackName('', PACK_FIXTURES)).toBeNull();
    expect(resolvePackName('   ', PACK_FIXTURES)).toBeNull();
    expect(resolvePackName('windows-95', PACK_FIXTURES)).toBeNull();
  });

  it('returns null when the pack list is empty (still loading)', () => {
    expect(resolvePackName('geist', [])).toBeNull();
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

describe('parseCommandInput (submit-time resolution)', () => {
  it('plain text is not a command', () => {
    expect(parseCommandInput('design a login screen')).toEqual({ kind: 'none' });
    expect(parseCommandInput('')).toEqual({ kind: 'none' });
  });

  it('bare "/" is its own kind (menu open, nothing runnable)', () => {
    expect(parseCommandInput('/')).toEqual({ kind: 'bare' });
    expect(parseCommandInput('  /  ')).toEqual({ kind: 'bare' });
  });

  it('fully-typed command with NO args resolves exactly', () => {
    const r = parseCommandInput('/clear');
    expect(r).toEqual({ kind: 'exact', command: CHAT_COMMANDS.find((c) => c.cmd === '/clear'), args: '' });
  });

  it('BUGFIX: fully-typed command WITH args resolves exactly (was rejected as unknown)', () => {
    const r = parseCommandInput('/audit focus on contrast');
    expect(r.kind).toBe('exact');
    if (r.kind === 'exact') {
      expect(r.command.cmd).toBe('/audit');
      expect(r.command.kind).toBe('prompt');
      expect(r.args).toBe('focus on contrast');
    }
  });

  it('an exact command wins over prefix candidates', () => {
    // '/copy' is exact even though '/clear' would… not match, but proves ordering.
    const r = parseCommandInput('/copy');
    expect(r.kind).toBe('exact');
  });

  it('untyped prefix yields candidates for the highlighted menu item', () => {
    const r = parseCommandInput('/ex');
    expect(r.kind).toBe('candidates');
    if (r.kind === 'candidates') {
      expect(r.commands.map((c) => c.cmd)).toEqual(['/export-svg', '/export-png', '/export-json']);
    }
  });

  it('unknown slash input is flagged (not silently a prompt)', () => {
    expect(parseCommandInput('/definitely-not-a-command')).toEqual({ kind: 'unknown' });
    // with args too
    expect(parseCommandInput('/nope some args')).toEqual({ kind: 'unknown' });
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
