// Tests for the skill registry — verifies the Figma-hierarchy tools
// (pen_reparent_shape, pen_set_constraints) are correctly registered in the
// skill allowedTools lists and in ALL_TOOL_NAMES so the runner actually
// exposes them to the LLM.
//
// Background: when pen_reparent_shape was first added to tools.ts, it was
// registered in the `createCanvasTools()` return array but NOT in any skill's
// allowedTools, NOT in CORE_TOOL_NAMES, and NOT in ALL_TOOL_NAMES. The
// runner's `filterToolSpecs` filters by `getToolNamesForCategory(activeCategory)`
// — so the LLM in any skill mode never even saw pen_reparent_shape. This
// manifested as the LLM calling pen_update_shape with a `parent` arg
// (intuitively correct), which the update patch applier silently DROPPED,
// causing the agent to claim success while no reparent actually happened.
//
// These tests guard against the same regression: if a new tool is added to
// tools.ts, it MUST also be registered in the relevant skill's allowedTools
// and in ALL_TOOL_NAMES, or the LLM will never see it.

import { describe, it, expect } from 'vitest';
import {
  SKILLS,
  ALL_TOOL_NAMES,
  CORE_TOOL_NAMES,
  getToolNamesForCategory,
} from '@/lib/agent/skills/registry';
import type { SkillCategory } from '@/lib/agent/skills';

describe('registry: Figma-hierarchy tool registration', () => {
  it('pen_reparent_shape is in wireframe.allowedTools (for post-gen refinement)', () => {
    expect(SKILLS.wireframe?.allowedTools).toContain('pen_reparent_shape');
  });

  it('pen_reparent_shape is in layout.allowedTools (natural home)', () => {
    expect(SKILLS.layout?.allowedTools).toContain('pen_reparent_shape');
  });

  it('pen_set_constraints is in layout.allowedTools', () => {
    expect(SKILLS.layout?.allowedTools).toContain('pen_set_constraints');
  });

  it('pen_reparent_shape is in ALL_TOOL_NAMES (multi-skill fallback)', () => {
    expect(ALL_TOOL_NAMES).toContain('pen_reparent_shape');
  });

  it('pen_set_constraints is in ALL_TOOL_NAMES (multi-skill fallback)', () => {
    expect(ALL_TOOL_NAMES).toContain('pen_set_constraints');
  });

  it('wireframe mode exposes pen_reparent_shape via getToolNamesForCategory', () => {
    const tools = getToolNamesForCategory('wireframe');
    expect(tools).toContain('pen_reparent_shape');
    // Also verify core tools are included.
    for (const coreTool of CORE_TOOL_NAMES) {
      expect(tools).toContain(coreTool);
    }
  });

  it('layout mode exposes both pen_reparent_shape and pen_set_constraints', () => {
    const tools = getToolNamesForCategory('layout');
    expect(tools).toContain('pen_reparent_shape');
    expect(tools).toContain('pen_set_constraints');
  });

  it('multi mode exposes both Figma-hierarchy tools', () => {
    const tools = getToolNamesForCategory('multi');
    expect(tools).toContain('pen_reparent_shape');
    expect(tools).toContain('pen_set_constraints');
  });

  it('every skill\'s allowedTools only references tools that exist in ALL_TOOL_NAMES', () => {
    // This catches the inverse regression: a skill references a tool that
    // no longer exists in tools.ts. (ALL_TOOL_NAMES is the canonical list
    // maintained alongside tools.ts; if a skill references a tool not in
    // ALL_TOOL_NAMES, the LLM will see the tool spec in the filter pass
    // but executeTool will return "Unknown tool" when the LLM calls it.)
    for (const [cat, skill] of Object.entries(SKILLS)) {
      if (!skill) continue;
      for (const toolName of skill.allowedTools) {
        expect(ALL_TOOL_NAMES).toContain(toolName);
      }
    }
  });
});

describe('registry: layout skill keywords include hierarchy triggers', () => {
  it('layout keywords include "move" (so "move X into Y" triggers layout as secondary)', () => {
    expect(SKILLS.layout?.keywords).toContain('move');
  });

  it('layout keywords include "reparent"', () => {
    expect(SKILLS.layout?.keywords).toContain('reparent');
  });

  it('layout keywords include "container"', () => {
    expect(SKILLS.layout?.keywords).toContain('container');
  });

  it('layout keywords include "into"', () => {
    expect(SKILLS.layout?.keywords).toContain('into');
  });

  it('layout keywords include "constraints"', () => {
    expect(SKILLS.layout?.keywords).toContain('constraints');
  });
});
