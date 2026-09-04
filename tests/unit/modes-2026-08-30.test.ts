// Modes 2026-08-30 regression tests — Cursor-style modes (Build / Ask / Plan),
// the multitask executor's detection + decomposition, the plan-approval gate,
// and the adaptive critique ladder. Mirrors the audit/stress-test test
// patterns: pure-function assertions on modes.ts, allowlist membership
// (registry.test.ts style), source-scan invariants on the runner/route
// (audit-2026-08-30.test.ts style), store reducers (chat-parity style), and
// the plan-gate pending-map flow (approval-gate.test.ts style).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AGENT_MODES,
  MODE_METADATA,
  normalizeAgentMode,
  modeToolAllowlist,
  modeSectionFor,
  shouldRunCritics,
  promptRequestsCritique,
  detectMultitaskPrompt,
  ASK_MODE_TOOL_NAMES,
  PLAN_MODE_TOOL_NAMES,
  CRITIC_PATH_ESTIMATED_LLM_CALLS,
} from '@/lib/agent/modes';
import { PARALLEL_SAFE_TOOL_NAMES } from '@/lib/agent/tool-execution-mode';
import { agentRunSettings, DEFAULT_SETTINGS, type AppSettings } from '@/lib/settings/types';
import { CHAT_COMMANDS } from '@/lib/agent/chat-commands';
import {
  submitPlanProposal,
  resolvePlanProposal,
  recordApprovedPlan,
  consumeApprovedPlan,
  resetPlanGate,
  getPendingPlanProposals,
  hasApprovedPlanSince,
} from '@/lib/agent/plan-gate';
import { useCanvasStore } from '@/lib/canvas/store';
import { useSessionStore } from '@/lib/sessions';
import type { CanvasDocument, Shape, SyncEvent } from '@/lib/canvas/types';

// ---- Helpers -----------------------------------------------------------------

const REPO = join(process.cwd(), 'src');
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');

/// Canonical MUTATING tool names — every one is a registered pen_* mutator
/// (verified against tools.ts / pen-tools.ts in audit 2-b). If a mode
/// allowlist ever contains one of these, the mode's read-only contract is
/// broken at the registry level.
const MUTATING_TOOL_SAMPLES = [
  'pen_create_node',
  'pen_create_subtree',
  'pen_update_node',
  'pen_bulk_update_by_filter',
  'pen_delete_nodes',
  'pen_clear',
  'pen_set_variable',
  'pen_set_variables',
  'pen_apply_palette',
  'pen_apply_design_system',
  'pen_insert_html',
  'pen_generate_wireframe',
  'pen_set_shadow',
  'figma_create_page',
];

function makeShape(id: string, name: string, type = 'rectangle'): Shape {
  return {
    id, type, name, x: 0, y: 0, width: 100, height: 100,
    rotation: 0, opacity: 1, fill: '#ccc', stroke: '#000', strokeWidth: 0,
    radius: 0, fontSize: 16, textColor: '#000', parentId: null, zIndex: 0,
    locked: false, visible: true, autoLayout: null, tokenBinding: null,
    componentId: null, points: null, closed: false, src: null, radii: null,
    gradient: null, shadow: null, blur: 0, maskId: null, constraints: null,
  } as unknown as Shape;
}

function makeDoc(shapes: Shape[] = []): CanvasDocument {
  return {
    id: 'test-doc', name: 'Test', background: '#ffffff', version: '2.17',
    children: shapes as any, viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes, tokens: { colors: [], textStyles: [] },
  } as CanvasDocument;
}

function resetStore(doc: CanvasDocument = makeDoc([])) {
  useCanvasStore.setState({
    document: doc, selectedIds: [], agentHighlightIds: [], socket: null,
    connected: false, viewerCount: 1, turns: [], agentBusy: false,
    queuedPrompts: [], documentId: 'test-doc', activeSessionId: null,
  });
  useSessionStore.setState({
    sessions: {}, runs: {}, messages: {}, toolCalls: {}, snapshots: {},
    activeSessionByDoc: {},
  });
}

function lastTurn() {
  const turns = useCanvasStore.getState().turns;
  return turns[turns.length - 1];
}

function seedStreamingAssistantTurn() {
  useCanvasStore.setState((s) => ({
    turns: [
      ...s.turns,
      { id: 'u1', role: 'user', text: 'plan a fintech app', toolCalls: [], streaming: false },
      { id: 'a1', role: 'assistant', text: '', toolCalls: [], streaming: true, startedAt: Date.now() },
    ],
    agentBusy: true,
  }));
}

beforeEach(() => {
  resetPlanGate();
  resetStore();
});

// ---- 1. Mode allowlists: structural enforcement -------------------------------

describe('modes: read-only allowlists', () => {
  it('ASK mode contains ZERO mutating tools (registry-level enforcement)', () => {
    for (const name of MUTATING_TOOL_SAMPLES) {
      expect(ASK_MODE_TOOL_NAMES.has(name), `ASK mode must not contain ${name}`).toBe(false);
    }
  });

  it('PLAN mode contains ZERO mutating tools — only submit_plan is added', () => {
    for (const name of MUTATING_TOOL_SAMPLES) {
      expect(PLAN_MODE_TOOL_NAMES.has(name), `PLAN mode must not contain ${name}`).toBe(false);
    }
    expect(PLAN_MODE_TOOL_NAMES.has('submit_plan')).toBe(true);
    // PLAN is a strict superset of ASK.
    for (const name of ASK_MODE_TOOL_NAMES) {
      expect(PLAN_MODE_TOOL_NAMES.has(name)).toBe(true);
    }
  });

  it('every ASK tool is a verified non-mutator (PARALLEL_SAFE) or an interaction plugin', () => {
    const interactionTools = new Set([
      'ask_user_question',
      'todo_create', 'todo_update', 'todo_add', 'todo_remove', 'todo_list',
      'memory_read', 'memory_search', 'scratchpad',
    ]);
    for (const name of ASK_MODE_TOOL_NAMES) {
      const ok = PARALLEL_SAFE_TOOL_NAMES.has(name) || interactionTools.has(name);
      expect(ok, `ASK tool "${name}" is neither PARALLEL_SAFE nor an interaction plugin`).toBe(true);
    }
  });

  it('ASK/PLAN can actually READ the canvas (the mode is useful, not lobotomized)', () => {
    for (const readTool of ['pen_get_metadata', 'pen_find_nodes', 'pen_get_screenshot', 'pen_search_icons']) {
      expect(ASK_MODE_TOOL_NAMES.has(readTool), `ASK mode must keep ${readTool}`).toBe(true);
    }
    expect(ASK_MODE_TOOL_NAMES.has('ask_user_question')).toBe(true);
  });

  it('modeToolAllowlist: build = no filter, ask = ask set, plan = plan set', () => {
    expect(modeToolAllowlist('build')).toBeUndefined();
    expect(modeToolAllowlist('ask')).toBe(ASK_MODE_TOOL_NAMES);
    expect(modeToolAllowlist('plan')).toBe(PLAN_MODE_TOOL_NAMES);
  });
});

// ---- 2. Mode type + prompt sections --------------------------------------------

describe('modes: normalizeAgentMode + sections', () => {
  it('normalizeAgentMode passes valid modes and defaults everything else to build', () => {
    expect(normalizeAgentMode('build')).toBe('build');
    expect(normalizeAgentMode('ask')).toBe('ask');
    expect(normalizeAgentMode('plan')).toBe('plan');
    expect(normalizeAgentMode(undefined)).toBe('build');
    expect(normalizeAgentMode('agent')).toBe('build');
    expect(normalizeAgentMode(42)).toBe('build');
  });

  it('AGENT_MODES covers exactly the three modes with UI metadata', () => {
    expect([...AGENT_MODES].sort()).toEqual(['ask', 'build', 'plan']);
    for (const m of AGENT_MODES) {
      expect(MODE_METADATA[m].label.length).toBeGreaterThan(0);
      expect(MODE_METADATA[m].description.length).toBeGreaterThan(10);
    }
  });

  it('modeSectionFor: build is empty (byte-identical pre-mode prompt); ask/plan state the contract', () => {
    expect(modeSectionFor('build')).toBe('');
    expect(modeSectionFor('ask')).toMatch(/READ-ONLY/i);
    expect(modeSectionFor('ask')).toMatch(/\/build/i);
    expect(modeSectionFor('plan')).toMatch(/submit_plan/);
    expect(modeSectionFor('plan')).toMatch(/READ-ONLY/i);
  });
});

// ---- 3. Adaptive critique gate ---------------------------------------------------

describe('modes: adaptive critique gate (shouldRunCritics)', () => {
  const base = {
    newShapeCount: 6,
    validationReasonCount: 0,
    freshDocument: false,
    promptWantsCritique: false,
  };

  it('small clean edit on a populated canvas → skip (small_clean_turn)', () => {
    const d = shouldRunCritics(base);
    expect(d.runCritics).toBe(false);
    expect(d.skipReason).toBe('small_clean_turn');
  });

  it('small turn with 1-2 validator issues → skip critics, validator-only repair', () => {
    const d = shouldRunCritics({ ...base, validationReasonCount: 2 });
    expect(d.runCritics).toBe(false);
    expect(d.skipReason).toBe('small_turn_validators_only');
  });

  it('>= CRITIC violations (3) → critics run even on a small turn', () => {
    const d = shouldRunCritics({ ...base, validationReasonCount: 3 });
    expect(d.runCritics).toBe(true);
  });

  it('>= 20 new nodes (big build) → critics run', () => {
    const d = shouldRunCritics({ ...base, newShapeCount: 20 });
    expect(d.runCritics).toBe(true);
  });

  it('fresh document with >= 8 nodes → critics run (substantial first screen)', () => {
    expect(shouldRunCritics({ ...base, freshDocument: true, newShapeCount: 8 }).runCritics).toBe(true);
    // trivial element on an empty canvas → still skipped
    expect(shouldRunCritics({ ...base, freshDocument: true, newShapeCount: 7 }).runCritics).toBe(false);
  });

  it('prompt asking for critique/polish forces critics regardless of size', () => {
    const d = shouldRunCritics({ ...base, promptWantsCritique: true });
    expect(d.runCritics).toBe(true);
  });

  it('promptRequestsCritique matches the /critique command text and polish asks', () => {
    const critiqueCmd = CHAT_COMMANDS.find((c) => c.cmd === '/critique');
    expect(critiqueCmd).toBeDefined();
    expect(promptRequestsCritique(critiqueCmd!.run)).toBe(true);
    expect(promptRequestsCritique('please polish this design and make it beautiful')).toBe(true);
    expect(promptRequestsCritique('audit my design for contrast issues')).toBe(true);
    expect(promptRequestsCritique('a login screen with email and password fields')).toBe(false);
  });

  it('the skip notice carries an honest saved-call estimate', () => {
    expect(CRITIC_PATH_ESTIMATED_LLM_CALLS).toBeGreaterThanOrEqual(2);
  });
});

// ---- 4. Multitask detection -------------------------------------------------------

describe('modes: detectMultitaskPrompt', () => {
  it('explicit /multitask prefix always routes to the executor + strips the prefix', () => {
    const d = detectMultitaskPrompt('/multitask build a 4-screen checkout flow');
    expect(d.explicit).toBe(true);
    expect(d.heuristic).toBe(true);
    expect(d.effectivePrompt).toBe('build a 4-screen checkout flow');
  });

  it('counted multi-screen asks heuristically route (no explicit prefix)', () => {
    const d = detectMultitaskPrompt('Build a 3 screen onboarding flow for a fitness app');
    expect(d.explicit).toBe(false);
    expect(d.heuristic).toBe(true);
    expect(d.effectivePrompt).toBe('Build a 3 screen onboarding flow for a fitness app');
  });

  it('screen lists heuristically route', () => {
    expect(detectMultitaskPrompt('Create the login screen and the dashboard screen for our SaaS').heuristic).toBe(true);
  });

  it('ordinary single-screen asks do NOT route', () => {
    expect(detectMultitaskPrompt('Make a login screen with email and password').heuristic).toBe(false);
    expect(detectMultitaskPrompt('Make the cards darker').heuristic).toBe(false);
    expect(detectMultitaskPrompt('What do you think about my pricing page?').heuristic).toBe(false);
  });
});

// ---- 5. Settings plumbing ----------------------------------------------------------

describe('settings: agentMode flows into AgentRunSettings.mode', () => {
  const settings = (over: Partial<AppSettings>): AppSettings => ({ ...DEFAULT_SETTINGS, ...over });

  it('defaults to build when agentMode is absent (pre-mode blobs)', () => {
    expect(agentRunSettings(settings({})).mode).toBe('build');
  });

  it('follows the sticky composer mode', () => {
    expect(agentRunSettings(settings({ agentMode: 'ask' })).mode).toBe('ask');
    expect(agentRunSettings(settings({ agentMode: 'plan' })).mode).toBe('plan');
  });

  it('DEFAULT_SETTINGS pins build (pre-mode behavior preserved)', () => {
    expect(DEFAULT_SETTINGS.agentMode).toBe('build');
  });
});

// ---- 6. Plan approval gate ----------------------------------------------------------

describe('plan-gate: pending map + resolve + approved-plan handoff', () => {
  afterEach(() => { resetPlanGate(); });

  it('submitPlanProposal blocks until resolvePlanProposal decides', async () => {
    const decisionPromise = submitPlanProposal({
      planId: 'plan-1',
      title: 'T',
      summary: 'S',
      steps: [{ step: 1, description: 'a' }, { step: 2, description: 'b' }],
    });
    expect(getPendingPlanProposals()).toContain('plan-1');
    resolvePlanProposal('plan-1', 'build');
    const decision = await decisionPromise;
    expect(decision.decision).toBe('build');
    expect(getPendingPlanProposals()).toHaveLength(0);
  });

  it('revise decisions carry the feedback', async () => {
    const decisionPromise = submitPlanProposal({
      planId: 'plan-2', title: 'T', summary: 'S',
      steps: [{ step: 1, description: 'a' }, { step: 2, description: 'b' }],
    });
    resolvePlanProposal('plan-2', 'revise', 'make it mobile-first');
    const decision = await decisionPromise;
    expect(decision.decision).toBe('revise');
    expect(decision.feedback).toBe('make it mobile-first');
  });

  it('resolving an unknown planId is a no-op (idempotent POSTs)', () => {
    expect(() => resolvePlanProposal('never-existed', 'build')).not.toThrow();
  });

  it('consumeApprovedPlan: single-shot, timestamp-guarded against stale approvals', () => {
    recordApprovedPlan({ planId: 'p', title: 'T', summary: 'S', steps: [{ step: 1, description: 'a' }] });
    // A run that started AFTER the approval was recorded must NOT consume it
    // (resolvedAt < runStartedAt).
    expect(consumeApprovedPlan(Date.now() + 60_000)).toBeNull();
    // A run that started BEFORE the approval consumes it — exactly once.
    const plan = consumeApprovedPlan(Date.now() - 60_000);
    expect(plan?.planId).toBe('p');
    expect(consumeApprovedPlan(Date.now() - 60_000)).toBeNull();
  });
});

// ---- 7. Store reducers (chat-parity style) -----------------------------------------

describe('store: mode event reducers', () => {
  it('agent:plan_proposed attaches a pending PlanApprovalCard to the assistant turn', () => {
    seedStreamingAssistantTurn();
    useCanvasStore.getState()._onSync({
      type: 'agent:plan_proposed',
      planId: 'plan-9',
      title: 'Fintech onboarding',
      summary: 'Three screens, dark premium.',
      steps: [
        { step: 1, description: 'Welcome screen' },
        { step: 2, description: 'KYC form' },
      ],
      openQuestions: ['Mobile-first assumed'],
    } as SyncEvent);
    const t = lastTurn() as any;
    expect(t.planProposal).toBeDefined();
    expect(t.planProposal.planId).toBe('plan-9');
    expect(t.planProposal.status).toBe('pending');
    expect(t.planProposal.steps).toHaveLength(2);
    expect(t.planProposal.openQuestions).toEqual(['Mobile-first assumed']);
  });

  it('agent:plan_resolved settles the card (approved / revising with feedback)', () => {
    seedStreamingAssistantTurn();
    useCanvasStore.getState()._onSync({
      type: 'agent:plan_proposed',
      planId: 'plan-10', title: 'T', summary: 'S',
      steps: [{ step: 1, description: 'a' }, { step: 2, description: 'b' }],
    } as SyncEvent);
    useCanvasStore.getState()._onSync({
      type: 'agent:plan_resolved',
      planId: 'plan-10',
      decision: 'revise',
      feedback: 'add a paywall screen',
    } as SyncEvent);
    const t = lastTurn() as any;
    expect(t.planProposal.status).toBe('revising');
    expect(t.planProposal.feedback).toBe('add a paywall screen');

    useCanvasStore.getState()._onSync({
      type: 'agent:plan_resolved', planId: 'plan-10', decision: 'build',
    } as SyncEvent);
    expect((lastTurn() as any).planProposal.status).toBe('approved');
  });

  it('agent:plan_resolved for an unrelated planId does not touch the card', () => {
    seedStreamingAssistantTurn();
    useCanvasStore.getState()._onSync({
      type: 'agent:plan_proposed',
      planId: 'plan-11', title: 'T', summary: 'S',
      steps: [{ step: 1, description: 'a' }, { step: 2, description: 'b' }],
    } as SyncEvent);
    useCanvasStore.getState()._onSync({
      type: 'agent:plan_resolved', planId: 'other-plan', decision: 'build',
    } as SyncEvent);
    expect((lastTurn() as any).planProposal.status).toBe('pending');
  });

  it('agent:critique_skipped records the visible saving once', () => {
    seedStreamingAssistantTurn();
    useCanvasStore.getState()._onSync({
      type: 'agent:critique_skipped', reason: 'small_clean_turn', savedLlmCalls: 3,
    } as SyncEvent);
    const t = lastTurn() as any;
    expect(t.critiqueSkipped).toEqual({ reason: 'small_clean_turn', savedLlmCalls: 3 });
    // Redelivery (socket + journal replay overlap) is a no-op.
    useCanvasStore.getState()._onSync({
      type: 'agent:critique_skipped', reason: 'small_clean_turn', savedLlmCalls: 3,
    } as SyncEvent);
    expect((lastTurn() as any).critiqueSkipped).toEqual({ reason: 'small_clean_turn', savedLlmCalls: 3 });
  });
});

// ---- 8. Chat commands ---------------------------------------------------------------

describe('chat-commands: mode + multitask + critique commands', () => {
  it('registers /ask /plan /build as action commands', () => {
    for (const cmd of ['/ask', '/plan', '/build']) {
      const found = CHAT_COMMANDS.find((c) => c.cmd === cmd);
      expect(found, `${cmd} must be registered`).toBeDefined();
      expect(found!.kind).toBe('action');
    }
  });

  it('registers /multitask (action, args) and /critique (prompt)', () => {
    const mt = CHAT_COMMANDS.find((c) => c.cmd === '/multitask');
    expect(mt?.kind).toBe('action');
    expect(mt?.args).toBe(true);
    const critique = CHAT_COMMANDS.find((c) => c.cmd === '/critique');
    expect(critique?.kind).toBe('prompt');
  });
});

// ---- 9. Runner / route source-scan invariants (audit-test style) -------------------

describe('runner-native source invariants (mode enforcement)', () => {
  const runnerSrc = read('lib/agent/runner-native.ts');
  const routeSrc = read(join('app', 'api', 'agent', 'route.ts'));

  it('reads the mode from settings and normalizes it', () => {
    expect(runnerSrc).toContain('normalizeAgentMode(settings?.mode)');
  });

  it('enforces the mode at tool-registry assembly (modeToolAllowlist)', () => {
    expect(runnerSrc).toContain('modeToolAllowlist(mode)');
    expect(runnerSrc).toContain("categoryAllowedToolNames.delete(name)");
  });

  it('registers submit_plan ONLY in plan mode', () => {
    expect(runnerSrc).toMatch(/mode === 'plan' \? \[submitPlanTool/);
  });

  it('gates the brief-first contract, canvas-output expectation, and variant nudge to build mode', () => {
    expect(runnerSrc).toContain("isDesignRequest(prompt) && mode === 'build'");
    expect(runnerSrc).toContain("mode === 'build' && isDesignRequest(prompt)");
    expect(runnerSrc).toMatch(/isAmbiguousCreation && mode === 'build'/);
  });

  it('the critique loop is mode-gated (critiqueEligible) and complexity-gated (shouldRunCritics)', () => {
    expect(runnerSrc).toContain('critiqueEligible');
    expect(runnerSrc).toContain('shouldRunCritics(');
    expect(runnerSrc).toContain('agent:critique_skipped');
  });

  it('the multitask path is build-mode only and yields patches through the route', () => {
    expect(runnerSrc).toMatch(/mode === 'build' && \(multitaskDetection\.explicit \|\| multitaskDetection\.heuristic\)/);
    expect(runnerSrc).toContain("yield { kind: 'patch', patch }");
  });

  it('the plan-execution phase swaps to the build toolset after approval', () => {
    expect(runnerSrc).toContain('consumeApprovedPlan(runStartedAt)');
    expect(runnerSrc).toContain('execOrderedTools');
    expect(runnerSrc).toContain('planExecuted = true');
  });

  it('the /api/agent route extracts + validates the mode field', () => {
    expect(routeSrc).toContain("body.settings.mode === 'ask'");
  });

  it('the route journals the mode on agent:user_message (forensics)', () => {
    expect(routeSrc).toContain('mode: settings.mode');
  });
});

// ---- 10. submit_plan tool behavior (approval handshake) ------------------------------

describe('submit_plan tool: approval handshake', () => {
  it('rejects plans with fewer than 2 steps (ExitPlanMode discipline)', async () => {
    const { submitPlanTool } = await import('@/lib/agent/plan-tools');
    const execute = (submitPlanTool as any).execute as (
      toolCallId: string, params: any, signal?: any, onUpdate?: any, ctx?: any,
    ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

    const result = await execute('tc-1', {
      title: 'Too small',
      summary: 'One step only',
      steps: [{ step: 1, description: 'do everything' }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/at least 2 concrete steps/i);
  });

  it('returns APPROVED + records the plan for the runner when the user builds', async () => {
    const { submitPlanTool } = await import('@/lib/agent/plan-tools');
    const execute = (submitPlanTool as any).execute as (
      toolCallId: string, params: any, signal?: any, onUpdate?: any, ctx?: any,
    ) => Promise<{ content: Array<{ type: string; text: string }>; details?: any }>;

    const plan = {
      title: 'Fintech onboarding',
      summary: '3 screens, mobile-first.',
      steps: [
        { step: 1, description: 'Welcome screen with value props' },
        { step: 2, description: 'KYC form' },
        { step: 3, description: 'Success screen' },
      ],
    };
    const startedBefore = Date.now() - 1_000;
    const promise = execute('tc-2', plan);
    // Let the tool reach the blocked gate, then approve via the route path.
    await new Promise((r) => setTimeout(r, 25));
    expect(getPendingPlanProposals()).toContain('tc-2');
    resolvePlanProposal('tc-2', 'build');
    const result = await promise;
    expect(result.content[0].text).toMatch(/PLAN APPROVED/i);
    expect(result.details.decision).toBe('build');
    // The runner's consumption contract: the approved plan is available once,
    // newer than the run start.
    const approved = consumeApprovedPlan(startedBefore);
    expect(approved?.title).toBe('Fintech onboarding');
    expect(approved?.steps).toHaveLength(3);
    expect(consumeApprovedPlan(startedBefore)).toBeNull();
  });

  it('returns the user feedback on revise decisions', async () => {
    const { submitPlanTool } = await import('@/lib/agent/plan-tools');
    const execute = (submitPlanTool as any).execute as (
      toolCallId: string, params: any, signal?: any, onUpdate?: any, ctx?: any,
    ) => Promise<{ content: Array<{ type: string; text: string }>; details?: any }>;

    const promise = execute('tc-3', {
      title: 'T', summary: 'S',
      steps: [{ step: 1, description: 'a' }, { step: 2, description: 'b' }],
    });
    await new Promise((r) => setTimeout(r, 25));
    resolvePlanProposal('tc-3', 'revise', 'go mobile-first');
    const result = await promise;
    expect(result.content[0].text).toMatch(/go mobile-first/i);
    expect(result.details.decision).toBe('revise');
  });
});

// ---- 11. Multitask decomposition (mock LLM) -----------------------------------------

describe('multitask: decomposeMultitaskPrompt', () => {
  it('parses a decomposition from an LLM completion (fences + noise tolerated)', async () => {
    const { decomposeMultitaskPrompt } = await import('@/lib/agent/subagents/multitask');
    const mockLlm = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{
              message: {
                content:
                  'Sure, here is the decomposition:\n```json\n' +
                  JSON.stringify({
                    sharedStyle: 'Dark premium: #0b0f1a background, one cyan accent.',
                    tasks: [
                      { title: 'Login', prompt: 'Login screen with email + password and social auth buttons' },
                      { title: 'Dashboard', prompt: 'Dashboard with 4 KPI cards, a line chart, and a table' },
                      { title: 'Settings', prompt: 'Settings screen with profile card and toggles list' },
                    ],
                  }) +
                  '\n```\nDone.',
              },
            }],
          }),
        },
      },
    };
    const decomposition = await decomposeMultitaskPrompt('3 screens for a SaaS', mockLlm as any);
    expect(decomposition).not.toBeNull();
    expect(decomposition!.tasks).toHaveLength(3);
    expect(decomposition!.sharedStyle).toContain('Dark premium');
    expect(decomposition!.tasks[0].title).toBe('Login');
  });

  it('returns null for <2 parseable tasks (runner falls back to the single-agent path)', async () => {
    const { decomposeMultitaskPrompt } = await import('@/lib/agent/subagents/multitask');
    const mockLlm = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: 'I cannot decompose this.' } }],
          }),
        },
      },
    };
    expect(await decomposeMultitaskPrompt('a button', mockLlm as any)).toBeNull();
  });

  it('returns null when the LLM call throws', async () => {
    const { decomposeMultitaskPrompt } = await import('@/lib/agent/subagents/multitask');
    const mockLlm = {
      chat: { completions: { create: async () => { throw new Error('endpoint down'); } } },
    };
    expect(await decomposeMultitaskPrompt('anything', mockLlm as any)).toBeNull();
  });
});

// ---- 12. Ask-mode routing: canvas-anchored questions go to inspect ----------

describe('classifier: canvas-anchored-question override (Ask-mode routing)', () => {
  it('routes "what is on my canvas?" to inspect, never web_research', async () => {
    const { classifyIntent } = await import('@/lib/agent/classifier');
    const result = await classifyIntent({ prompt: 'What is currently on my canvas? Describe anything that exists.', canvasShapeCount: 0 });
    expect(result.category).toBe('inspect');
    expect(result.secondaryCategories).not.toContain('web_research');
  });

  it('routes "analyze my design" to inspect even with research-ish phrasing', async () => {
    const { classifyIntent } = await import('@/lib/agent/classifier');
    const result = await classifyIntent({ prompt: 'Can you research my design and check what palette this screen uses?', canvasShapeCount: 12 });
    expect(result.category).toBe('inspect');
    expect(result.secondaryCategories).not.toContain('web_research');
  });

  it('genuine research prompts (no canvas reference) still route to web_research', async () => {
    const { classifyIntent } = await import('@/lib/agent/classifier');
    const result = await classifyIntent({ prompt: 'What is new in web design trends 2026?', canvasShapeCount: 0 });
    expect(result.category).toBe('web_research');
  });
});

// ---- 13. Runner: failed web research must not dead-end the turn ---------------

describe('runner source invariant: research failure falls through', () => {
  it('the early-return path requires subAgentResult.success', () => {
    const src = read('lib/agent/runner-native.ts');
    expect(src).toMatch(/activeCategory === 'web_research' && !classification\.recommendPlan\) \{\s*\n\s*if \(subAgentResult\.success\)/);
    // And the failure branch drops the summary + falls through.
    expect(src).toContain('web research unavailable — proceeding without it');
  });
});

// Build-intent guard for the classifier override (polite phrasing ≠ question).
describe('classifier: build-intent guard', () => {
  it('"can you build me a dashboard on my canvas" stays a build route (not inspect)', async () => {
    const { classifyIntent } = await import('@/lib/agent/classifier');
    const result = await classifyIntent({ prompt: 'Can you build me a dashboard on my canvas?', canvasShapeCount: 0 });
    expect(result.category).not.toBe('inspect');
  });
});

// ---- 14. Stress-test round 3: plan-mode post-approval hard stop -------------------
//
// Live-verified failure (2026-08-30 plan-mode E2E through the gateway): after
// "Build it", the model kept executing INSIDE the read-only planning session
// (todo spam + pen_insert_html/pen_create_node "Tool not found" for ~3
// minutes), and a giant exec-session tool call was then killed by the stream
// watchdog because toolcall_delta events never reached the wire. These tests
// pin the three fixes: (a) hasApprovedPlanSince + the runner's planning-session
// tool blocker, (b) submit_plan's hard-stop result text, (c) the translator's
// toolcall_delta → tool_progress watchdog feed.

describe('plan-gate: hasApprovedPlanSince (post-approval blocker input)', () => {
  beforeEach(() => resetPlanGate());

  it('is false with no approval, true after one newer than the run start', () => {
    const runStartedAt = Date.now();
    expect(hasApprovedPlanSince(runStartedAt)).toBe(false);
    recordApprovedPlan({
      planId: 'tc-block-1', title: 'T', summary: 'S',
      steps: [{ step: 1, description: 'a' }, { step: 2, description: 'b' }],
    });
    expect(hasApprovedPlanSince(runStartedAt)).toBe(true);
    // Stale run starts (a previous run) must NOT see this approval.
    expect(hasApprovedPlanSince(Date.now() + 1)).toBe(false);
  });

  it('clears once the runner consumes the approved plan', () => {
    const runStartedAt = Date.now() - 1_000;
    recordApprovedPlan({
      planId: 'tc-block-2', title: 'T', summary: 'S',
      steps: [{ step: 1, description: 'a' }, { step: 2, description: 'b' }],
    });
    expect(consumeApprovedPlan(runStartedAt)?.planId).toBe('tc-block-2');
    expect(hasApprovedPlanSince(runStartedAt)).toBe(false);
  });
});

describe('submit_plan: approved result is a hard stop (no in-session execution)', () => {
  it('tells the model NOT to execute, create todos, or call tools', async () => {
    const { submitPlanTool } = await import('@/lib/agent/plan-tools');
    const execute = (submitPlanTool as any).execute as (
      toolCallId: string, params: any, signal?: any, onUpdate?: any, ctx?: any,
    ) => Promise<{ content: Array<{ type: string; text: string }>; details?: any }>;

    const promise = execute('tc-stop-1', {
      title: 'T', summary: 'S',
      steps: [{ step: 1, description: 'a' }, { step: 2, description: 'b' }],
    });
    await new Promise((r) => setTimeout(r, 25));
    resolvePlanProposal('tc-stop-1', 'build');
    const result = await promise;
    const text = result.content[0].text;
    // The old text ("switching to Build mode now") invited in-session
    // execution — the new text must forbid every escape hatch explicitly.
    expect(text).toMatch(/PLANNING SESSION COMPLETE/i);
    expect(text).toMatch(/do NOT execute any steps/i);
    expect(text).toMatch(/do NOT create todos/i);
    expect(text).toMatch(/do NOT call any more tools/i);
    expect(text).toMatch(/end your turn/i);
    expect(text).not.toMatch(/switching to Build mode now/i);
  });
});

describe('runner source invariants: post-approval tool blocker', () => {
  it('wraps the PLANNING toolset with planCompletionBlocker (plan mode only)', () => {
    const src = read('lib/agent/runner-native.ts');
    expect(src).toMatch(
      /mode === 'plan' \? planCompletionBlocker\(filteredTools\) : filteredTools/,
    );
    // The blocker consults the gate scoped to THIS run.
    expect(src).toMatch(/hasApprovedPlanSince\(runStartedAt\)/);
    // The blocker's error result is a terminal stop instruction.
    expect(src).toContain('PLANNING SESSION COMPLETE — the plan was approved');
  });

  it('does NOT wrap the EXEC toolset (execOrderedTools must stay unblocked)', () => {
    const src = read('lib/agent/runner-native.ts');
    // The exec assembly call takes buildToolsForPlanMode directly.
    expect(src).toMatch(
      /execOrderedTools: ToolDefinition\[\] \| null = buildToolsForPlanMode\s*\n\s*\? assembleOrderedTools\(buildToolsForPlanMode\)/,
    );
  });
});

describe('translator: toolcall_delta feeds the stream watchdog', () => {
  it('emits throttled agent:tool_progress with tool name + KB while composing tool args', async () => {
    const { translateAgentSessionEvent, createTranslatorState } = await import(
      '@/lib/agent/agent-session-translator'
    );
    const state = createTranslatorState();
    // Open a message so the UI state machine is balanced.
    translateAgentSessionEvent({ type: 'message_start' } as any, state);

    const delta = (deltaText: string, name: string) => ({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_delta',
        contentIndex: 0,
        delta: deltaText,
        partial: { content: [{ type: 'toolCall', id: 'call-1', name, arguments: {} }] },
      },
    }) as any;

    // First delta emits immediately with the tool name.
    const first = translateAgentSessionEvent(delta('x'.repeat(600), 'pen_create_subtree'), state);
    const progress1 = first.filter((e) => (e as any).event?.type === 'agent:tool_progress');
    expect(progress1).toHaveLength(1);
    expect((progress1[0] as any).event.text).toContain('pen_create_subtree');
    expect((progress1[0] as any).event.text).toMatch(/0\.\d KB/);

    // Immediate second delta is throttled away (no wire spam).
    const second = translateAgentSessionEvent(delta('y'.repeat(200), 'pen_create_subtree'), state);
    expect(second.filter((e) => (e as any).event?.type === 'agent:tool_progress')).toHaveLength(0);

    // A >2s-old throttle window emits again with accumulated bytes (fake the
    // clock by checking the map indirectly: force an emit by using a NEW
    // toolCall id, which has fresh throttle state).
    const third = translateAgentSessionEvent({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_delta',
        contentIndex: 1,
        delta: 'z'.repeat(2048),
        partial: { content: [null, { type: 'toolCall', id: 'call-2', name: 'pen_insert_html', arguments: {} }] },
      },
    } as any, state);
    const progress3 = third.filter((e) => (e as any).event?.type === 'agent:tool_progress');
    expect(progress3).toHaveLength(1);
    expect((progress3[0] as any).event.text).toContain('pen_insert_html');
    expect((progress3[0] as any).event.text).toMatch(/2\.0 KB/);

    // text_delta still translates to message_delta (regression guard).
    const text = translateAgentSessionEvent({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
    } as any, state);
    expect(text.some((e) => (e as any).event?.type === 'agent:message_delta')).toBe(true);
  });
});

describe('modes: plan hint surfaces the saved-LLM-calls estimate', () => {
  it('MODE_METADATA.plan.hint mentions the estimate; constant defined once in modes.ts', async () => {
    const mod = await import('@/lib/agent/modes');
    expect(MODE_METADATA.plan.hint).toContain(String(mod.PLAN_MODE_SAVED_LLM_CALLS_ESTIMATE));
    // plan-tools re-exports the same constant (import-pure modes module owns it).
    const planTools = await import('@/lib/agent/plan-tools');
    expect(planTools.PLAN_MODE_SAVED_LLM_CALLS_ESTIMATE).toBe(mod.PLAN_MODE_SAVED_LLM_CALLS_ESTIMATE);
  });
});

// ---- 16. Legacy-runner mode-blindness guard (audit follow-up) ----------------

describe('runner-legacy: mode-blindness guard', () => {
  it('throws LOUDLY for non-build modes (the legacy loop has no mode gating)', async () => {
    const { runAgentLegacy } = await import('@/lib/agent/runner-legacy');
    for (const mode of ['ask', 'plan'] as const) {
      const gen = runAgentLegacy({
        documentId: 'doc',
        prompt: 'hello',
        canvas: {} as any,
        settings: { mode } as any,
      });
      await expect(gen.next()).rejects.toThrow(/mode-blind.*runner-native\.ts/);
    }
  });

  it('build mode and absent mode keep the legacy path usable (tests rely on it)', async () => {
    const { runAgentLegacy } = await import('@/lib/agent/runner-legacy');
    // Minimal valid doc (integration/runner.test.ts makeDoc style) + a mock
    // LLM whose text-only response ends the turn after one iteration.
    const doc = {
      id: 'test-doc', name: 'Test', background: '#ffffff', version: '2.17',
      children: [], viewport: { zoom: 1, panX: 0, panY: 0 },
      shapes: [], tokens: { colors: [], textStyles: [] },
    } as any;
    const doneLlm = {
      chat: {
        completions: {
          create: async () => ({ choices: [{ message: { content: 'Done.', tool_calls: undefined } }] }),
        },
      },
    } as any;

    const drain = async (opts: Record<string, unknown>): Promise<string[]> => {
      const types: string[] = [];
      for await (const ev of runAgentLegacy(opts as any)) {
        if ((ev as any).kind === 'agent_event') types.push((ev as any).event.type);
      }
      return types;
    };

    // Absent mode → defaults to build behavior, runs to completion.
    const absent = await drain({ documentId: 'd1', prompt: 'hello', canvas: doc, llm: doneLlm });
    expect(absent).toContain('agent:turn_end');
    // Explicit build mode → equally fine (the guard must not over-fire).
    const build = await drain({
      documentId: 'd1', prompt: 'hello', canvas: doc, llm: doneLlm,
      settings: { mode: 'build' } as any,
    });
    expect(build).toContain('agent:turn_end');
  });
});

// ---- 17. GET /api/agent/plans — pending-plan diagnostics endpoint --------------

describe('GET /api/agent/plans: pending-plan diagnostics', () => {
  it('the route wires getPendingPlanProposals into a GET handler (no longer a dead export)', async () => {
    const routeSrc = read(join('app', 'api', 'agent', 'plans', 'route.ts'));
    expect(routeSrc).toContain('getPendingPlanProposals');
    expect(routeSrc).toMatch(/export async function GET/);
    // Twin contract with /api/agent/pending (same { pending: [...] } shape).
    expect(routeSrc).toContain('JSON.stringify({ pending: getPendingPlanProposals() })');
  });

  it('getPendingPlanProposals lists live pending plan ids', async () => {
    resetPlanGate();
    expect(getPendingPlanProposals()).toEqual([]);
    const decision = submitPlanProposal({
      planId: 'plan-diag-1',
      title: 'T',
      summary: 'S',
      steps: [{ step: 1, description: 'one' }],
    });
    try {
      expect(getPendingPlanProposals()).toEqual(['plan-diag-1']);
    } finally {
      resolvePlanProposal('plan-diag-1', 'build');
      await decision;
    }
    expect(getPendingPlanProposals()).toEqual([]);
  });
});
