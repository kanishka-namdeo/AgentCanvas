// Onboarding store tests — verifies the first-time-user flow state machine.
//
// Covers:
//   - Default state (hasCompleted=false on first load)
//   - complete() marks hasCompleted + selectedTemplateId
//   - skip() marks hasCompleted + skipped
//   - reset() returns to default (for "Replay onboarding")
//   - ONBOARDING_TEMPLATES has 6 entries with all required fields

import { describe, it, expect, beforeEach } from 'vitest';
import { useOnboarding, ONBOARDING_TEMPLATES } from '@/lib/onboarding/store';

describe('useOnboarding store', () => {
  beforeEach(() => {
    // Reset to default state before each test.
    useOnboarding.getState().reset();
  });

  it('starts with hasCompleted=false (first-time user)', () => {
    const state = useOnboarding.getState();
    expect(state.hasCompleted).toBe(false);
    expect(state.skipped).toBe(false);
    expect(state.completedAt).toBeNull();
    expect(state.selectedTemplateId).toBeNull();
  });

  it('complete() marks onboarding as completed with the selected template', () => {
    useOnboarding.getState().complete('login-screen');
    const state = useOnboarding.getState();
    expect(state.hasCompleted).toBe(true);
    expect(state.skipped).toBe(false);
    expect(state.completedAt).toBeTypeOf('number');
    expect(state.selectedTemplateId).toBe('login-screen');
  });

  it('complete() without a template sets selectedTemplateId to null', () => {
    useOnboarding.getState().complete();
    const state = useOnboarding.getState();
    expect(state.hasCompleted).toBe(true);
    expect(state.selectedTemplateId).toBeNull();
  });

  it('skip() marks onboarding as skipped (not completed)', () => {
    useOnboarding.getState().skip();
    const state = useOnboarding.getState();
    expect(state.hasCompleted).toBe(true);
    expect(state.skipped).toBe(true);
    expect(state.completedAt).toBeTypeOf('number');
    expect(state.selectedTemplateId).toBeNull();
  });

  it('reset() returns to the default state (for Replay onboarding)', () => {
    useOnboarding.getState().complete('dashboard');
    expect(useOnboarding.getState().hasCompleted).toBe(true);
    useOnboarding.getState().reset();
    const state = useOnboarding.getState();
    expect(state.hasCompleted).toBe(false);
    expect(state.skipped).toBe(false);
    expect(state.completedAt).toBeNull();
    expect(state.selectedTemplateId).toBeNull();
  });
});

describe('ONBOARDING_TEMPLATES', () => {
  it('has exactly 10 templates', () => {
    expect(ONBOARDING_TEMPLATES).toHaveLength(10);
  });

  it('every template has all required fields', () => {
    for (const t of ONBOARDING_TEMPLATES) {
      expect(t.id).toBeTypeOf('string');
      expect(t.id.length).toBeGreaterThan(0);
      expect(t.label).toBeTypeOf('string');
      expect(t.description).toBeTypeOf('string');
      expect(t.prompt).toBeTypeOf('string');
      expect(t.prompt.length).toBeGreaterThan(20);
      expect(['Fast', 'Standard', 'Detailed']).toContain(t.tier);
      expect(t.gradient).toBeTypeOf('string');
      expect(t.gradient).toMatch(/^from-[a-z]+-\d+\s+to-[a-z]+-\d+$/);
    }
  });

  it('template ids are unique', () => {
    const ids = ONBOARDING_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not use forbidden gradient classes (from-violet-500 / to-fuchsia-500)', () => {
    // Design-consistency test forbids these raw palette classes.
    for (const t of ONBOARDING_TEMPLATES) {
      expect(t.gradient).not.toMatch(/from-violet-500/);
      expect(t.gradient).not.toMatch(/to-fuchsia-500/);
    }
  });

  it('has a mix of tier badges (Fast/Standard/Detailed)', () => {
    const tiers = new Set(ONBOARDING_TEMPLATES.map((t) => t.tier));
    expect(tiers.size).toBeGreaterThanOrEqual(2);
  });
});
