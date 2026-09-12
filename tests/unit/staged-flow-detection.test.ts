// tests/unit/staged-flow-detection.test.ts
import { describe, it, expect } from 'vitest';
import { shouldOfferStagedFlow } from '@/lib/agent/prompt-intent';

const base = { canvasEmpty: true, mode: 'build' as const, repeatCount: 0, variantDispatchPlanned: false };

describe('shouldOfferStagedFlow', () => {
  it.each([
    ['build me a SaaS dashboard', true],
    ['a login screen for the vaultly app', true],
    ['design a settings page', true],
  ])('fires on screen-scale creation: %s', (prompt, expected) => {
    expect(shouldOfferStagedFlow({ ...base, prompt })).toBe(expected);
  });

  it.each([
    ['make it blue and bigger'],          // edit-reference anaphora
    ['change the button color'],          // edit-shaped
    ['build me a dashboard and a login screen'],  // multi-screen → multitask path
    ['just build it directly, no questions'],     // explicit opt-out
    ['a pricing card'],                   // small artifact, not screen-scale
  ])('does not fire: %s', (prompt) => {
    expect(shouldOfferStagedFlow({ ...base, prompt })).toBe(false);
  });

  it('does not fire on non-empty canvases without explicit new-screen intent', () => {
    expect(shouldOfferStagedFlow({ ...base, canvasEmpty: false, prompt: 'build me a dashboard' })).toBe(false);
    expect(shouldOfferStagedFlow({ ...base, canvasEmpty: false, prompt: 'add a new dashboard screen' })).toBe(true);
  });

  it('does not fire in ask/plan mode, on repeat prompts, or when variants are planned', () => {
    expect(shouldOfferStagedFlow({ ...base, mode: 'plan', prompt: 'build a dashboard' })).toBe(false);
    expect(shouldOfferStagedFlow({ ...base, repeatCount: 2, prompt: 'build a dashboard' })).toBe(false);
    expect(shouldOfferStagedFlow({ ...base, variantDispatchPlanned: true, prompt: 'a pricing page' })).toBe(false);
  });
});
