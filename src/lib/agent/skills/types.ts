// Skill system types — progressive disclosure architecture for the pi agent.
//
// This implements the Anthropic Agent Skills standard (also adopted by Manus):
//   https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
//   https://manus.im/blog/manus-skills
//
// Progressive disclosure has three levels:
//   Level 1 (always loaded): skill name + description (~100 tokens each).
//     Loaded at startup so the model knows what skills exist and can decide
//     which to activate.
//   Level 2 (loaded on activation): the skill's full instructions body
//     (<5k tokens). Loaded when the skill is selected (either by the intent
//     classifier or by the model itself requesting it).
//   Level 3 (loaded on demand): detailed reference files, examples, or
//     sub-procedures. Loaded only when the body references them.
//
// This file declares the Level 1 + Level 2 types. Level 3 is not needed at
// our scale (we have 7 skills, each self-contained).

import type { CanvasDocument } from '../../canvas/types';

// ---- Skill category --------------------------------------------------------
//
// Each skill maps to a coherent task domain. The intent classifier routes
// the user's prompt to one of these categories.

export type SkillCategory =
  | 'wireframe'    // Generate screens / wireframes from descriptions
  | 'layout'       // Arrange, align, organize existing shapes
  | 'styling'      // Recolor, restyle, apply effects
  | 'inspect'      // Audit, analyze, inspect the canvas (read-only)
  | 'export'       // Export to code / SVG / PNG / JSON
  | 'web_research' // Search the web, fetch pages
  | 'vector'       // Paths, boolean ops, masks
  | 'multi';       // Ambiguous / multi-domain → load all skills

// ---- Skill definition ------------------------------------------------------

export interface Skill {
  /// Unique identifier (matches SkillCategory for the 7 primary skills).
  id: string;

  /// Human-readable name shown in prompts and UI.
  name: string;

  /// Level 1 metadata — always loaded (~100 tokens). Must say WHAT the skill
  /// does and WHEN to use it, so the model (or the intent classifier) can
  /// select it accurately. Mirrors the Anthropic Agent Skills `description`
  /// frontmatter contract.
  description: string;

  /// Level 2 body — loaded on activation. The full task-specific instructions:
  /// tool recommendations, argument guidance, scenario playbook, common
  /// pitfalls. Must be under 5,000 tokens.
  body: string;

  /// The tool names this skill exposes. When the skill is active, only these
  /// tools (plus the always-loaded core tools) are visible to the LLM.
  /// This is the Tier 1 "routing to tool subset" mechanism.
  allowedTools: string[];

  /// Keywords / regex patterns the intent classifier uses to detect this skill.
  /// The classifier does a case-insensitive match against the user's prompt.
  keywords: string[];

  /// Whether this skill is read-only (doesn't mutate the canvas).
  /// Used by the runner to allow safe parallel skill activation.
  readOnly?: boolean;

  /// Whether this skill should be dispatched to a sub-agent instead of run
  /// inline. Currently only `web_research` uses this (the clearest context-
  /// pollution case per the Claude Code "5+ files = subagent" rule).
  useSubAgent?: boolean;
}

// ---- Intent classification result -----------------------------------------

export interface ClassificationResult {
  /// The primary skill category selected.
  category: SkillCategory;

  /// Secondary categories that might also be relevant (e.g. a prompt that
  /// asks to "research then design" needs both web_research + wireframe).
  secondaryCategories: SkillCategory[];

  /// How the classification was made — for debugging and telemetry.
  method: 'keyword' | 'llm' | 'fallback';

  /// Confidence 0..1. Below a threshold, the runner falls back to 'multi'
  /// (all skills loaded).
  confidence: number;

  /// Whether the classifier recommends a planning phase (multi-step tasks).
  recommendPlan: boolean;
}

// ---- Plan module types -----------------------------------------------------

export interface PlanStep {
  /// 1-indexed step number.
  step: number;
  /// What to do in this step.
  description: string;
  /// Which skill category this step uses.
  skill: SkillCategory;
  /// Status — updated as execution proceeds.
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
}

export interface Plan {
  steps: PlanStep[];
  /// The original user prompt this plan addresses.
  prompt: string;
  /// When the plan was created.
  createdAt: number;
}

// ---- Sub-agent types -------------------------------------------------------

export interface SubAgentResult {
  /// The synthesized summary returned to the main agent.
  summary: string;
  /// How many tool calls the sub-agent made (for telemetry).
  toolCalls: number;
  /// Whether the sub-agent succeeded.
  success: boolean;
  /// Optional error message.
  error?: string;
}

export interface SubAgentParams {
  /// The task to perform.
  task: string;
  /// The canvas state at dispatch time (read-only context).
  canvas: CanvasDocument;
  /// Optional abort signal.
  signal?: AbortSignal;
}
