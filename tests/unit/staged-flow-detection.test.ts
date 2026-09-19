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

  // 2026-09-19 (competitor-research round): component counter-signal — a
  // screen-scale word modifying a component head-noun ("login CARD",
  // "checkout MODAL") names a COMPONENT, not a screen. Fully specified
  // component prompts build immediately instead of opening the lo-fi/hi-fi
  // question (live-measured cost of the question: one wasted turn, 16s +
  // 86K tokens, zero canvas output). Quoted strings are content, not
  // structure — a button labeled 'Log in' is not screen-scale vocabulary.
  it.each([
    ['a login form'],
    ['a checkout modal with email and password fields'],
    ['a sign-in button with an apple logo'],
    ['a settings row with a label and a toggle'],
    ['Create a login card: rounded rectangle card with title \'Sign in\', an email input field, a password field, and a full-width primary button labeled \'Log in\''],
  ])('does not fire on component-scale prompts: %s', (prompt) => {
    expect(shouldOfferStagedFlow({ ...base, prompt })).toBe(false);
  });

  // The component counter-signal must NOT swallow genuine screen-scale
  // prompts that happen to mention components: the remaining structural
  // evidence (a bare screen word, or IA structure) still qualifies.
  it.each([
    ['a login screen for the vaultly app'],
    ['a login page with an email input field and a password field'],
    ['design a settings page with a profile section'],
    ['a checkout page with a login card widget'],
  ])('still fires when screen evidence survives the component strip: %s', (prompt) => {
    expect(shouldOfferStagedFlow({ ...base, prompt })).toBe(true);
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
