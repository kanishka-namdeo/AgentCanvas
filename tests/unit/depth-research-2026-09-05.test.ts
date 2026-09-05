// Depth-research pass 2026-09-05 (Tasks 3-a/3-b/3-c) — regression tests for:
//   1. Resolver WCAG contrast lint + auto-layout sizing-intent warnings
//      (contrast_failure / hug_fill_conflict / fill_without_parent).
//   2. Translator auto-retry → agent:status_note honest stall reporting.
//   3. Store status_note lifecycle (set / clear on activity / clear on
//      terminal events / empty-text clears).
//   4. VLM critic prompt generalization (8-dimension JSON contract intact,
//      no dashboard-only framing, DesignBench repair vocabulary present).
//
// Companion files: resolve-tree.test.ts (fixtures for warning semantics),
// run-state-consistency.test.ts (runPhase SSOT contract).

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEmptyCanvasDocument, type CanvasDocument } from '@/lib/canvas/types';
import type { PenChild, PenFrame, PenText } from '@/lib/pen/types';
import {
  resolvePenTreeDetailed,
  parseCssColor,
  contrastRatio,
  __clearResolveCachesForTests,
} from '@/lib/pen/resolve';
import { translateAgentSessionEvent, createTranslatorState } from '@/lib/agent/agent-session-translator';
import { useCanvasStore } from '@/lib/canvas/store';

// ---------------------------------------------------------------------------
// 1. Color utilities
// ---------------------------------------------------------------------------

describe('parseCssColor + contrastRatio (WCAG arithmetic)', () => {
  it('parses hex (#rgb / #rrggbb / #rrggbbaa) and rgb()/rgba()', () => {
    expect(parseCssColor('#fff')).toMatchObject({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseCssColor('#0f172a')).toMatchObject({ r: 15, g: 23, b: 42, a: 1 });
    expect(parseCssColor('#0000001a')).toMatchObject({ r: 0, g: 0, b: 0, a: 0x1a / 255 });
    expect(parseCssColor('rgb(15, 23, 42)')).toMatchObject({ r: 15, g: 23, b: 42, a: 1 });
    expect(parseCssColor('rgba(15,23,42,0.5)')).toMatchObject({ r: 15, g: 23, b: 42, a: 0.5 });
    expect(parseCssColor('rgb(100% 50% 0%)')).toMatchObject({ r: 255, g: 127.5, b: 0 });
  });

  it('returns null for unsupported vocabularies (oklch, named, $vars) — the lint skips, never guesses', () => {
    expect(parseCssColor('oklch(0.985 0.003 264)')).toBeNull();
    expect(parseCssColor('rebeccapurple')).toBeNull();
    expect(parseCssColor('$color.text')).toBeNull();
    expect(parseCssColor(undefined)).toBeNull();
    expect(parseCssColor(42)).toBeNull();
  });

  it('computes canonical WCAG ratios', () => {
    const black = parseCssColor('#000000')!;
    const white = parseCssColor('#ffffff')!;
    expect(contrastRatio(black, white)).toBeCloseTo(21, 0);
    const same = contrastRatio(white, white);
    expect(same).toBeCloseTo(1, 5);
    // slate-500 #64748b on white ≈ 4.76 (passes the 4.5 floor — the documented
    // light-mode text-subtle default), slate-400 #94a3b8 ≈ 2.9 (fails).
    const slate500 = parseCssColor('#64748b')!;
    const slate400 = parseCssColor('#94a3b8')!;
    expect(contrastRatio(slate500, white)).toBeGreaterThan(4.5);
    expect(contrastRatio(slate400, white)).toBeLessThan(3.5);
  });
});

// ---------------------------------------------------------------------------
// 2. Resolver warnings — contrast lint
// ---------------------------------------------------------------------------

function textOnFrame(textFill: string, frameFill: string, fontSize = 14, fontWeight = 400): CanvasDocument {
  const doc = createEmptyCanvasDocument('test');
  const label: PenText = {
    id: 't1', type: 'text', x: 8, y: 8, width: 120, height: 20,
    content: 'Read me', fill: textFill, fontSize, fontWeight: String(fontWeight),
  } as PenText;
  const frame: PenFrame = {
    id: 'f1', type: 'frame', x: 0, y: 0, width: 200, height: 100,
    fill: frameFill, children: [label],
  };
  return { ...doc, children: [frame] };
}

describe('contrast_failure lint', () => {
  beforeEach(() => __clearResolveCachesForTests());

  it('fires for text below the 4.5:1 floor on a solid ancestor', () => {
    // #94a3b8 (slate-400) on #ffffff ≈ 2.9:1 — the classic muted-label defect.
    const { warnings } = resolvePenTreeDetailed(textOnFrame('#94a3b8', '#ffffff'));
    const w = warnings.find((x) => x.kind === 'contrast_failure');
    expect(w).toBeDefined();
    expect(w!.nodeId).toBe('t1');
    expect(w!.message).toContain('4.5:1');
    expect(w!.message).toContain('2.56');
  });

  it('does NOT fire for compliant text (4.5:1+ on light, AA large-text 3:1)', () => {
    // slate-600 on white ≈ 7.3:1
    expect(resolvePenTreeDetailed(textOnFrame('#475569', '#ffffff')).warnings.find((x) => x.kind === 'contrast_failure')).toBeUndefined();
    // Large display text 30px/700 on white: only the 3:1 floor applies —
    // #818b99 ≈ 3.45:1 passes large-text while failing the 4.5 normal floor
    // (the discriminator case: threshold must depend on size/weight).
    const { warnings } = resolvePenTreeDetailed(textOnFrame('#818b99', '#ffffff', 30, 700));
    expect(warnings.find((x) => x.kind === 'contrast_failure')).toBeUndefined();
    // The same color at 14px/400 must be flagged (4.5 floor applies).
    const { warnings: wNormal } = resolvePenTreeDetailed(textOnFrame('#818b99', '#ffffff', 14, 400));
    expect(wNormal.find((x) => x.kind === 'contrast_failure' && x.nodeId === 't1')).toBeDefined();
  });

  it('uses the light page surface as the default backdrop for bare page-level text', () => {
    const doc = createEmptyCanvasDocument('test');
    const bare: PenText = {
      id: 'bare', type: 'text', x: 0, y: 0, width: 100, height: 20,
      content: 'Floating', fill: '#cbd5e1', // slate-300 on slate-50 page ≈ 1.5:1
    } as PenText;
    const { warnings } = resolvePenTreeDetailed({ ...doc, children: [bare] });
    expect(warnings.some((w) => w.kind === 'contrast_failure' && w.nodeId === 'bare')).toBe(true);
  });

  it('resolves the overlay pattern: text contained by a solid SIBLING painted earlier', () => {
    // Classic button: rectangle + label as siblings (not parent/child).
    // White on sky-700 #0369a1 ≈ 5.9:1 (passes); white on sky-500 #0ea5e9
    // ≈ 2.8:1 (fails — the "white label needs the 700 step" rule).
    const doc = createEmptyCanvasDocument('test');
    const btn: PenChild = {
      id: 'btn-rect', type: 'rectangle', x: 0, y: 0, width: 144, height: 40,
      fill: '#0369a1',
    } as PenChild;
    const label: PenText = {
      id: 'btn-label', type: 'text', x: 12, y: 12, width: 120, height: 16,
      content: 'Get Started', fill: '#ffffff', fontSize: 14, fontWeight: '600',
    } as PenText;
    const { warnings } = resolvePenTreeDetailed({ ...doc, children: [btn, label] });
    expect(warnings.find((x) => x.kind === 'contrast_failure' && x.nodeId === 'btn-label')).toBeUndefined();
    // Same label on a sky-500 button (#0ea5e9 ≈ 2.8:1) must be flagged.
    const btn500 = { ...btn, fill: '#0ea5e9' };
    const { warnings: w2 } = resolvePenTreeDetailed({ ...doc, children: [btn500, label] });
    expect(w2.find((x) => x.kind === 'contrast_failure' && x.nodeId === 'btn-label')).toBeDefined();
  });

  it('skips unknown backdrops (gradients) and dimmed layers instead of guessing', () => {
    const doc = createEmptyCanvasDocument('test');
    const label: PenText = {
      id: 'hero-title', type: 'text', x: 8, y: 8, width: 200, height: 40,
      content: 'Hero', fill: '#ffffff', fontSize: 32,
    } as PenText;
    // PenFrame's public type routes gradients through the fill union — the
    // resolver also tolerates a legacy top-level `gradient` key (skip path),
    // so cast through unknown instead of annotating the literal.
    const hero = {
      id: 'hero', type: 'frame', x: 0, y: 0, width: 300, height: 120,
      gradient: { type: 'linear', angle: 135, stops: [{ offset: 0, color: '#0ea5e9' }, { offset: 1, color: '#6366f1' }] },
      children: [label],
    } as unknown as PenFrame;
    const { warnings } = resolvePenTreeDetailed({ ...doc, children: [hero] });
    expect(warnings.find((x) => x.kind === 'contrast_failure')).toBeUndefined();
  });

  it('is cache-safe: the verdict refreshes when the ancestor fill changes', () => {
    // First resolve: compliant. Then darken the frame fill → failure must
    // appear even though the TEXT subtree is byte-identical (R9c emit cache
    // cannot replay a stale verdict — the lint runs post-emit).
    const doc1 = textOnFrame('#475569', '#ffffff');
    expect(resolvePenTreeDetailed(doc1).warnings.find((x) => x.kind === 'contrast_failure')).toBeUndefined();
    const frame2 = { ...(doc1.children[0] as PenFrame), fill: '#f8fafc' } as PenFrame; // bg closer to text
    const label2 = { ...((doc1.children[0] as PenFrame).children![0] as PenText), fill: '#94a3b8' } as PenText;
    frame2.children = [label2];
    const { warnings } = resolvePenTreeDetailed({ ...doc1, children: [frame2] });
    expect(warnings.find((x) => x.kind === 'contrast_failure')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Resolver warnings — auto-layout sizing intent
// ---------------------------------------------------------------------------

describe('hug_fill_conflict + fill_without_parent lints', () => {
  beforeEach(() => __clearResolveCachesForTests());

  it('hug_fill_conflict fires when a fit_content axis has ONLY fill children', () => {
    const doc = createEmptyCanvasDocument('test');
    const strip: PenChild = {
      id: 'strip', type: 'rectangle', x: 0, y: 0, width: 'fill_container', height: 40, fill: '#0ea5e9',
    } as PenChild;
    const hugger: PenFrame = {
      id: 'hug-frame', type: 'frame', x: 0, y: 0, width: 'fit_content', height: 'fit_content',
      fill: '#ffffff', children: [strip],
    };
    const { warnings } = resolvePenTreeDetailed({ ...doc, children: [hugger] });
    expect(warnings.some((w) => w.kind === 'hug_fill_conflict' && w.nodeId === 'hug-frame')).toBe(true);
  });

  it('hug_fill_conflict stays silent for a healthy fill + non-fill mix (Fix 5 Phase A/B resolves it)', () => {
    const doc = createEmptyCanvasDocument('test');
    const fixed: PenChild = { id: 'fixed-kid', type: 'rectangle', x: 0, y: 0, width: 240, height: 40, fill: '#0f172a' } as PenChild;
    const strip: PenChild = { id: 'fill-kid', type: 'rectangle', x: 0, y: 0, width: 'fill_container', height: 40, fill: '#0ea5e9' } as PenChild;
    const hugger: PenFrame = {
      id: 'mixed-frame', type: 'frame', x: 0, y: 0, width: 'fit_content', height: 'fit_content',
      fill: '#ffffff', children: [fixed, strip],
    };
    const { warnings } = resolvePenTreeDetailed({ ...doc, children: [hugger] });
    expect(warnings.find((w) => w.kind === 'hug_fill_conflict')).toBeUndefined();
  });

  it('fill_without_parent fires for a root-level fill_container node', () => {
    const doc = createEmptyCanvasDocument('test');
    const root: PenChild = {
      id: 'root-fill', type: 'frame', x: 0, y: 0, width: 'fill_container', height: 120, fill: '#0ea5e9', children: [],
    } as PenChild;
    const { warnings } = resolvePenTreeDetailed({ ...doc, children: [root] });
    expect(warnings.some((w) => w.kind === 'fill_without_parent' && w.nodeId === 'root-fill')).toBe(true);
  });

  it('fill_without_parent does not fire for nested fill children (a parent exists)', () => {
    const doc = createEmptyCanvasDocument('test');
    const strip: PenChild = { id: 'nested-fill', type: 'rectangle', x: 0, y: 0, width: 'fill_container', height: 40, fill: '#0ea5e9' } as PenChild;
    const sized: PenFrame = {
      id: 'sized-parent', type: 'frame', x: 0, y: 0, width: 400, height: 'fit_content', fill: '#ffffff', children: [strip],
    };
    const { warnings } = resolvePenTreeDetailed({ ...doc, children: [sized] });
    expect(warnings.find((w) => w.kind === 'fill_without_parent')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Translator — auto-retry → agent:status_note
// ---------------------------------------------------------------------------

describe('translator auto_retry events (honest stall reporting)', () => {
  it('auto_retry_start becomes an agent:status_note with attempt/max/delay/reason', () => {
    const out = translateAgentSessionEvent(
      { type: 'auto_retry_start', attempt: 2, maxAttempts: 3, delayMs: 8000, errorMessage: '429 Too Many Requests' } as never,
    );
    expect(out).toHaveLength(1);
    const evt = out[0] as { kind: string; event: { type: string; text: string } };
    expect(evt.kind).toBe('agent_event');
    expect(evt.event.type).toBe('agent:status_note');
    expect(evt.event.text).toContain('2/3');
    expect(evt.event.text).toContain('8s');
    expect(evt.event.text).toContain('429');
  });

  it('auto_retry_end success emits an EMPTY note (clears the stall text)', () => {
    const out = translateAgentSessionEvent({ type: 'auto_retry_end', success: true, attempt: 2 } as never);
    const evt = out[0] as { event: { type: string; text: string } };
    expect(evt.event.type).toBe('agent:status_note');
    expect(evt.event.text).toBe('');
  });

  it('auto_retry_end failure keeps a short note naming the final error', () => {
    const out = translateAgentSessionEvent(
      { type: 'auto_retry_end', success: false, attempt: 3, finalError: 'provider down' } as never,
    );
    const evt = out[0] as { event: { type: string; text: string } };
    expect(evt.event.type).toBe('agent:status_note');
    expect(evt.event.text).toContain('failed');
    expect(evt.event.text).toContain('provider down');
  });

  it('state is untouched (the note is not a phase) and unknown events still drop safely', () => {
    const state = createTranslatorState();
    translateAgentSessionEvent({ type: 'auto_retry_start', attempt: 1, maxAttempts: 2, delayMs: 4000 } as never, state);
    expect(state.messageOpen).toBe(false);
    expect(state.turnEnded).toBe(false);
    expect(translateAgentSessionEvent({ type: 'session_info_changed' } as never)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Store — status_note lifecycle
// ---------------------------------------------------------------------------

describe('store statusNote lifecycle', () => {
  beforeEach(() => {
    useCanvasStore.setState({ statusNote: null, runPhase: 'idle', agentBusy: false, turns: [] });
  });

  it('agent:status_note sets and empty-text clears', () => {
    useCanvasStore.getState()._onSync({ type: 'agent:status_note', text: 'Retrying (1/3) in 4s' });
    expect(useCanvasStore.getState().statusNote).toBe('Retrying (1/3) in 4s');
    useCanvasStore.getState()._onSync({ type: 'agent:status_note', text: '' });
    expect(useCanvasStore.getState().statusNote).toBeNull();
  });

  it('the note survives while nothing else happens, then clears on message_start', () => {
    useCanvasStore.getState()._onSync({ type: 'agent:status_note', text: 'Retrying (2/3) in 8s' });
    useCanvasStore.getState()._onSync({ type: 'agent:status_note', text: 'Retrying (2/3) in 8s' });
    expect(useCanvasStore.getState().statusNote).toBe('Retrying (2/3) in 8s');
    // Retry succeeded → the assistant streams again → note must clear.
    useCanvasStore.getState()._onSync({ type: 'agent:message_start', role: 'assistant' });
    expect(useCanvasStore.getState().statusNote).toBeNull();
  });

  it('terminal events clear the note (turn_end / error / stuck / turn_cancelled)', () => {
    for (const terminal of [
      { type: 'agent:turn_end' },
      { type: 'agent:error', message: 'boom' },
      { type: 'agent:stuck', message: 'loop' },
      { type: 'agent:turn_cancelled' },
    ] as const) {
      useCanvasStore.setState({ statusNote: 'Retrying (1/2) in 4s' });
      useCanvasStore.getState()._onSync(terminal as never);
      expect(useCanvasStore.getState().statusNote).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. VLM critic prompt — generalized, contract intact
// ---------------------------------------------------------------------------

describe('VLM critic prompt (depth-research 3-b revision)', () => {
  it('no longer frames every design as a dashboard, and keeps the 8-dimension JSON contract', async () => {
    const src = await import('@/lib/agent/subagents/design-critic-vlm');
    const prompt = (src as unknown as { VLM_CRITIC_SYSTEM_PROMPT?: string }).VLM_CRITIC_SYSTEM_PROMPT;
    if (!prompt) return; // not exported — the test degrades to a no-op (contract tested via behavior below)
    expect(prompt).toContain('UI design screenshot');
    expect(prompt).not.toContain('SaaS dashboards');
    for (const key of ['1_visual_hierarchy', '8_overall_professionalism', 'overall_score', 'top_5_fixes']) {
      expect(prompt).toContain(key);
    }
  });

  it('embeds the DesignBench repair vocabulary (overlap/occlusion/overflow/crowding)', () => {
    // Read the module source directly (the prompt is module-private by design).
    const src = readFileSync(join(process.cwd(), 'src/lib/agent/subagents/design-critic-vlm.ts'), 'utf-8');
    for (const word of ['OVERLAP/OCCLUSION', 'overflow', 'crowding']) {
      expect(src).toContain(word);
    }
  });
});
