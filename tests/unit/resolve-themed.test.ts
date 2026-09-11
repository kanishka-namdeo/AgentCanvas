// Tests for empty themed value array guard (Task 10 fix).
// Verifies that resolveThemedValue returns empty string for empty arrays.

import { describe, it, expect } from 'vitest';
import { resolveThemedValue } from '@/lib/pen/resolve';
import type { PenVariableDef, PenTheme } from '@/lib/pen/types';

function stringVar(value: PenVariableDef extends never ? never : unknown): PenVariableDef {
  return { type: 'string', value } as PenVariableDef;
}

describe('resolveThemedValue', () => {
  const defaultTheme: PenTheme = {};

  it('returns the value for a single-value definition', () => {
    const def = stringVar('#ff0000');

    expect(resolveThemedValue(def, defaultTheme)).toBe('#ff0000');
  });

  it('returns the value for a numeric single-value definition', () => {
    const def: PenVariableDef = { type: 'number', value: 42 };

    expect(resolveThemedValue(def, defaultTheme)).toBe(42);
  });

  it('returns the value for a boolean single-value definition', () => {
    const def: PenVariableDef = { type: 'boolean', value: true };

    expect(resolveThemedValue(def, defaultTheme)).toBe(true);
  });

  it('returns the first value when no theme matches', () => {
    const def = stringVar([
      { value: '#ff0000' },
      { value: '#00ff00', theme: { mode: 'dark' } },
    ]);

    expect(resolveThemedValue(def, defaultTheme)).toBe('#ff0000');
  });

  it('returns the matching theme value when theme matches', () => {
    const def = stringVar([
      { value: '#ff0000' },
      { value: '#00ff00', theme: { mode: 'dark' } },
    ]);

    const darkTheme: PenTheme = { mode: 'dark' };
    expect(resolveThemedValue(def, darkTheme)).toBe('#00ff00');
  });

  it('returns the LAST matching theme value when multiple themes match', () => {
    const def = stringVar([
      { value: '#ff0000' },
      { value: '#00ff00', theme: { mode: 'dark' } },
      { value: '#0000ff', theme: { mode: 'dark' } },
    ]);

    const darkTheme: PenTheme = { mode: 'dark' };
    expect(resolveThemedValue(def, darkTheme)).toBe('#0000ff');
  });

  it('returns empty string for empty themed value array (Task 10 fix)', () => {
    const def = stringVar([]);

    expect(resolveThemedValue(def, defaultTheme)).toBe('');
  });

  it('returns empty string for empty array regardless of theme', () => {
    const def = stringVar([]);

    const darkTheme: PenTheme = { mode: 'dark' };
    expect(resolveThemedValue(def, darkTheme)).toBe('');
  });
});
