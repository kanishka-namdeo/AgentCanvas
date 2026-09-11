// Task 2 (designer-workflow-parity, spec §5.1): the system prompt must carry the
// component-first construction rule BEFORE the validator's Rule 8 fires — the agent
// learns the expectation up front, the validator only catches violations.
import { describe, it, expect } from 'vitest';
import { SYSTEM_PROMPT_TEMPLATE, PROMPT_VERSION } from '@/lib/agent/runner-legacy';

describe('component-first prompt rule', () => {
  it('bumps PROMPT_VERSION', () => {
    expect(PROMPT_VERSION).toBe('2026-09-12.1');
  });
  it('carries the >=3 repeated structures rule', () => {
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('3 identical repeated structures');
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('pen_place_component_instance');
  });
});
