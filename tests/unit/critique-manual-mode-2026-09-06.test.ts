// Design critique invocation mode — 2026-09-06 regression tests.
//
// The design-critic subagents (text + VLM, runner-native.ts critique loop +
// runner-legacy.ts mirror) previously fired COMPULSORILY on every
// complexity-eligible build turn. The new DesignCritiqueMode setting makes
// invocations manual by default:
//   'manual' (default) — critics fire ONLY on explicit user intent
//                        (/critique or a critique/polish prompt)
//   'auto'              — the adaptive complexity ladder (old behavior)
//   'off'               — critics never dispatch (hard kill-switch)
//
// Coverage follows the established patterns (modes-2026-08-30.test.ts):
// pure-function gate assertions, settings-threading, route/runner source-scan
// invariants, store reducer behavior, and UI source-scan invariants.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  shouldRunCritics,
  promptRequestsCritique,
  normalizeDesignCritiqueMode,
  DESIGN_CRITIQUE_MODES,
  type CriticGateInput,
} from '@/lib/agent/modes';
import {
  agentRunSettings,
  DEFAULT_SETTINGS,
  type AppSettings,
} from '@/lib/settings/types';
import { CHAT_COMMANDS } from '@/lib/agent/chat-commands';
import { useCanvasStore } from '@/lib/canvas/store';
import { useSessionStore } from '@/lib/sessions';
import type { CanvasDocument, Shape, SyncEvent } from '@/lib/canvas/types';

// ---- Helpers -----------------------------------------------------------------

const REPO = join(process.cwd(), 'src');
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');

/// A small clean build turn — the auto ladder would SKIP the critics.
const smallCleanTurn: CriticGateInput = {
  newShapeCount: 4,
  validationReasonCount: 0,
  freshDocument: false,
  promptWantsCritique: false,
};

/// A big build turn — the auto ladder would RUN the critics.
const bigTurn: CriticGateInput = {
  newShapeCount: 20,
  validationReasonCount: 0,
  freshDocument: false,
  promptWantsCritique: false,
};

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

function seedStreamingAssistantTurn() {
  useCanvasStore.setState((s) => ({
    turns: [
      ...s.turns,
      { id: 'u1', role: 'user', text: 'build a dashboard', toolCalls: [], streaming: false },
      { id: 'a1', role: 'assistant', text: '', toolCalls: [], streaming: true, startedAt: Date.now() },
    ],
    agentBusy: true,
  }));
}

beforeEach(() => {
  resetStore();
});

// ---- 1. Pure gate: shouldRunCritics with invocation modes -------------------------

describe('shouldRunCritics — design critique invocation mode', () => {
  it('manual mode (the default) does NOT auto-fire critics on a big turn', () => {
    const d = shouldRunCritics({ ...bigTurn, critiqueMode: 'manual' });
    expect(d.runCritics).toBe(false);
    // 'manual_mode' (not 'small_clean_turn') — the auto ladder WOULD have
    // fired; the UI uses this reason to offer the /critique escape hatch.
    expect(d.skipReason).toBe('manual_mode');
  });

  it('manual mode does not auto-fire on validator failures or fresh docs either', () => {
    expect(shouldRunCritics({
      ...smallCleanTurn, validationReasonCount: 3, critiqueMode: 'manual',
    }).runCritics).toBe(false);
    expect(shouldRunCritics({
      ...smallCleanTurn, freshDocument: true, newShapeCount: 12, critiqueMode: 'manual',
    }).runCritics).toBe(false);
  });

  it('manual mode fires critics when the prompt itself asks (explicit user intent)', () => {
    const d = shouldRunCritics({ ...smallCleanTurn, promptWantsCritique: true, critiqueMode: 'manual' });
    expect(d.runCritics).toBe(true);
    expect(d.skipReason).toBeUndefined();
    // The /critique command's expanded prompt must trip the intent detector.
    const cmd = CHAT_COMMANDS.find((c) => c.cmd === '/critique');
    expect(cmd).toBeDefined();
    expect(promptRequestsCritique(cmd!.run)).toBe(true);
    expect(promptRequestsCritique('please polish this and make it beautiful')).toBe(true);
    expect(promptRequestsCritique('a login screen with email and password fields')).toBe(false);
  });

  it('manual mode on a small clean turn keeps the small-turn skip reason (nothing held back)', () => {
    const d = shouldRunCritics({ ...smallCleanTurn, critiqueMode: 'manual' });
    expect(d.runCritics).toBe(false);
    expect(d.skipReason).toBe('small_clean_turn');
    // 1-2 validator issues → validator-only repair, same as auto.
    expect(shouldRunCritics({ ...smallCleanTurn, validationReasonCount: 2, critiqueMode: 'manual' }).skipReason)
      .toBe('small_turn_validators_only');
  });

  it('off mode never fires critics — even an explicit /critique ask is refused', () => {
    const d = shouldRunCritics({ ...bigTurn, promptWantsCritique: true, critiqueMode: 'off' });
    expect(d.runCritics).toBe(false);
    expect(d.skipReason).toBe('critique_disabled');
    expect(shouldRunCritics({ ...bigTurn, critiqueMode: 'off' }).skipReason).toBe('critique_disabled');
  });

  it('auto mode preserves the adaptive ladder exactly', () => {
    expect(shouldRunCritics({ ...bigTurn, critiqueMode: 'auto' }).runCritics).toBe(true);
    expect(shouldRunCritics({ ...smallCleanTurn, critiqueMode: 'auto' }).runCritics).toBe(false);
    expect(shouldRunCritics({ ...smallCleanTurn, critiqueMode: 'auto' }).skipReason).toBe('small_clean_turn');
    expect(shouldRunCritics({ ...bigTurn, promptWantsCritique: true, critiqueMode: 'auto' }).runCritics).toBe(true);
  });

  it('absent mode → off (critics disabled by default)', () => {
    expect(shouldRunCritics({ ...bigTurn }).runCritics).toBe(false);
    expect(shouldRunCritics({ ...bigTurn }).skipReason).toBe('critique_disabled');
    // Even explicit prompts don't override 'off' mode
    expect(shouldRunCritics({ ...bigTurn, promptWantsCritique: true }).runCritics).toBe(false);
  });
});

// ---- 2. Normalizer + mode union ---------------------------------------------------

describe('normalizeDesignCritiqueMode', () => {
  it('accepts the three valid modes and defaults everything else to off', () => {
    for (const m of DESIGN_CRITIQUE_MODES) {
      expect(normalizeDesignCritiqueMode(m)).toBe(m);
    }
    expect(normalizeDesignCritiqueMode(undefined)).toBe('off');
    expect(normalizeDesignCritiqueMode(null)).toBe('off');
    expect(normalizeDesignCritiqueMode('always')).toBe('off');
    expect(normalizeDesignCritiqueMode(42)).toBe('off');
  });
});

// ---- 3. Settings threading (client store → request body) --------------------------

describe('settings threading — designCritiqueMode', () => {
  it('the product default is off (critics disabled unless user opts in)', () => {
    expect(DEFAULT_SETTINGS.designCritiqueMode).toBe('off');
  });

  it('agentRunSettings passes the mode through', () => {
    const auto = { ...DEFAULT_SETTINGS, designCritiqueMode: 'auto' } as AppSettings;
    expect(agentRunSettings(auto).designCritiqueMode).toBe('auto');
    const off = { ...DEFAULT_SETTINGS, designCritiqueMode: 'off' } as AppSettings;
    expect(agentRunSettings(off).designCritiqueMode).toBe('off');
  });

  it('pre-2026-09-06 persisted blobs (field absent) resolve to off', () => {
    const legacyBlob = { ...DEFAULT_SETTINGS } as AppSettings;
    delete (legacyBlob as Partial<AppSettings>).designCritiqueMode;
    expect(agentRunSettings(legacyBlob).designCritiqueMode).toBe('off');
  });
});

// ---- 4. Route + runner source-scan invariants (audit-test style) ------------------

describe('route / runner wiring (source invariants)', () => {
  const routeSrc = read(join('app', 'api', 'agent', 'route.ts'));
  const runnerSrc = read('lib/agent/runner-native.ts');
  const legacySrc = read('lib/agent/runner-legacy.ts');

  it('the route allowlist validates designCritiqueMode (manual | auto | off)', () => {
    expect(routeSrc).toContain('designCritiqueMode');
    expect(routeSrc).toMatch(/body\.settings\.designCritiqueMode === 'manual'/);
    expect(routeSrc).toMatch(/body\.settings\.designCritiqueMode === 'auto'/);
    expect(routeSrc).toMatch(/body\.settings\.designCritiqueMode === 'off'/);
  });

  it('runner-native normalizes the mode and feeds it into the critic gate', () => {
    expect(runnerSrc).toContain('normalizeDesignCritiqueMode(settings?.designCritiqueMode)');
    expect(runnerSrc).toMatch(/critiqueMode: designCritiqueMode,/);
  });

  it("runner-native stays silent when critics are 'off' (no per-turn skip row)", () => {
    expect(runnerSrc).toMatch(/criticGate\.skipReason !== 'critique_disabled'/);
  });

  it('runner-legacy mirrors the mode gate before running its critique loop', () => {
    expect(legacySrc).toContain('normalizeDesignCritiqueMode(settings?.designCritiqueMode)');
    expect(legacySrc).toMatch(/critiqueModeAllows/);
    expect(legacySrc).toMatch(/!injectedLlm && critiqueModeAllows/);
  });
});

// ---- 5. Store reducer: the new skip reasons land on the turn ----------------------

describe('canvas store — critique_skipped with mode reasons', () => {
  it("'manual_mode' lands on the last assistant turn (idempotent)", () => {
    seedStreamingAssistantTurn();
    useCanvasStore.getState()._onSync({
      type: 'agent:critique_skipped', reason: 'manual_mode', savedLlmCalls: 3,
    } as SyncEvent);
    const turns = useCanvasStore.getState().turns;
    const t = turns[turns.length - 1] as any;
    expect(t.critiqueSkipped).toEqual({ reason: 'manual_mode', savedLlmCalls: 3 });
    // Redelivery (socket + journal replay overlap) is a no-op.
    useCanvasStore.getState()._onSync({
      type: 'agent:critique_skipped', reason: 'manual_mode', savedLlmCalls: 3,
    } as SyncEvent);
    expect((turns[turns.length - 1] as any).critiqueSkipped).toEqual({ reason: 'manual_mode', savedLlmCalls: 3 });
  });

  it("'critique_disabled' is storable too (defensive — the runner stays silent in off mode)", () => {
    seedStreamingAssistantTurn();
    useCanvasStore.getState()._onSync({
      type: 'agent:critique_skipped', reason: 'critique_disabled', savedLlmCalls: 3,
    } as SyncEvent);
    const turns = useCanvasStore.getState().turns;
    expect((turns[turns.length - 1] as any).critiqueSkipped.reason).toBe('critique_disabled');
  });
});

// ---- 6. UI source-scan invariants -------------------------------------------------

describe('UI wiring (source invariants)', () => {
  const settingsSrc = read(join('components', 'settings', 'SettingsDialog.tsx'));
  const panelSrc = read(join('components', 'canvas', 'AgentPanel.tsx'));

  it('Settings → Agent exposes the three-option Design critique picker', () => {
    expect(settingsSrc).toContain('label="Design critique"');
    expect(settingsSrc).toMatch(/set\('designCritiqueMode'/);
    expect(settingsSrc).toMatch(/<SelectItem value="manual"/);
    expect(settingsSrc).toMatch(/<SelectItem value="auto"/);
    expect(settingsSrc).toMatch(/<SelectItem value="off"/);
  });

  it('the settings picker defaults persisted blobs without the field to off', () => {
    expect(settingsSrc).toMatch(/s\.designCritiqueMode \?\? 'off'/);
  });

  it("AgentPanel maps the new skip reasons (manual_mode / critique_disabled)", () => {
    expect(panelSrc).toMatch(/skipped\.reason === 'manual_mode'/);
    expect(panelSrc).toMatch(/skipped\.reason === 'critique_disabled'/);
    // The manual-mode row advertises the /critique escape hatch.
    expect(panelSrc).toMatch(/run \/critique to review/);
  });
});
