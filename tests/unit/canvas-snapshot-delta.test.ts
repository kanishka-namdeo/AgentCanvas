// Tests for canvasSnapshotDelta (Phase C, R9a — delta LLM context).
//
// The digest replaces the full canvasSnapshot in the runner's first user
// message when the server computed which nodes changed since the last
// settled turn (journal-fold watermark). Contract under test:
//   - globals ALWAYS survive (variables, collections, text styles,
//     background, pages) — the model keeps its palette/placement context;
//   - changed nodes keep the FULL field line (same vocabulary as
//     canvasSnapshot — shape-line.ts guarantees byte-parity);
//   - unchanged subtrees collapse to one navigation line with a
//     pen_get_metadata expansion pointer and the hidden-descendant count;
//   - an unchanged node BETWEEN the root and a changed descendant stays
//     visible (collapsed) so the tree path is navigable;
//   - the multi-screen placement line survives (the "second prompt"
//     contract — regression-guarded for the full snapshot too);
//   - warnings are scoped to changed ids;
//   - byte-determinism across calls (prefix-cache/reproducibility rule).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { canvasSnapshot, canvasSnapshotDelta } from '@/lib/agent/runner-legacy';
import { __resetClientRoundtripForTests } from '@/lib/agent/client-roundtrip';
import type { CanvasDocument, Shape } from '@/lib/canvas/types';
import type { PenFrame, PenText } from '@/lib/pen/types';

function makeShape(id: string, over: Partial<Shape> = {}): Shape {
  return {
    id,
    type: 'text',
    name: id,
    x: 320, y: 88, width: 100, height: 100,
    rotation: 0, opacity: 1,
    fill: '#0f172a', stroke: '#000', strokeWidth: 0,
    radius: 0, fontSize: 16, textColor: '#000',
    parentId: null, zIndex: 0,
    locked: false, visible: true,
    autoLayout: null, tokenBinding: null, componentId: null,
    points: null, closed: false, src: null, radii: null,
    gradient: null, shadow: null, blur: 0, maskId: null,
    constraints: null,
    ...over,
  } as Shape;
}

function makeDoc(id: string, shapes: Shape[]): CanvasDocument {
  return {
    id,
    name: 'Delta Doc',
    background: '#ffffff',
    version: '2.17',
    children: [],
    viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes,
    tokens: { colors: [], textStyles: [] },
  };
}

beforeEach(() => {
  __resetClientRoundtripForTests();
});

afterEach(() => {
  __resetClientRoundtripForTests();
});

describe('canvasSnapshotDelta (R9a delta LLM context)', () => {
  const frame = (id: string, over: Partial<Shape> = {}) =>
    makeShape(id, { type: 'frame', width: 375, height: 812, ...over });

  it('keeps changed nodes FULL-detail (same line vocabulary as the full snapshot)', () => {
    const doc = makeDoc('delta-doc', [
      frame('login', { x: 200, y: 50, zIndex: 2 }),
      makeShape('email', { parentId: 'login', text: 'Email', zIndex: 1 }),
      frame('dash', { x: 655, y: 50, zIndex: 1 }),
    ]);
    const digest = canvasSnapshotDelta(doc, ['email']);

    const emailLine = digest.split('\n').find((l) => l.includes('email'))!;
    // Full vocabulary: fill + characters — exactly what the full snapshot
    // emits for this shape (shape-line.ts is the shared formatter).
    expect(emailLine).toContain('fill=');
    expect(emailLine).toContain('characters="Email"');
    expect(emailLine).toContain('(in frame "login")');
    // The full snapshot's line for the same node is byte-identical apart
    // from indentation (both render at the same depth here).
    const full = canvasSnapshot(doc);
    const fullLine = full.split('\n').find((l) => l.includes('email'))!;
    expect(emailLine).toBe(fullLine);
  });

  it('collapses unchanged subtrees to ONE line with an expansion pointer + descendant count', () => {
    const doc = makeDoc('delta-doc', [
      frame('login', { x: 200, y: 50, zIndex: 2 }),
      makeShape('email', { parentId: 'login', zIndex: 2 }),
      makeShape('password', { parentId: 'login', zIndex: 1 }),
      frame('dash', { x: 655, y: 50, zIndex: 1 }),
    ]);
    const digest = canvasSnapshotDelta(doc, ['dash']);

    const loginLine = digest.split('\n').find((l) => l.includes('login'))!;
    expect(loginLine).toContain('+2 descendants, unchanged');
    expect(loginLine).toContain('pen_get_metadata("login", {detail:true})');
    // The collapsed subtree's children are NOT rendered.
    expect(digest.split('\n').some((l) => l.includes('email'))).toBe(false);
    expect(digest.split('\n').some((l) => l.includes('password'))).toBe(false);
  });

  it('keeps an unchanged ancestor visible (collapsed) when a descendant changed', () => {
    const doc = makeDoc('delta-doc', [
      frame('login', { x: 200, y: 50, zIndex: 2 }),
      makeShape('email', { parentId: 'login', zIndex: 2 }),
    ]);
    const digest = canvasSnapshotDelta(doc, ['email']);

    const loginLine = digest.split('\n').find((l) => l.includes('login'))!;
    expect(loginLine).toContain('frame "login"');
    // No "+N descendants" suffix on the pass-through node — its children ARE
    // shown below, indented deeper.
    expect(loginLine).not.toContain('descendants, unchanged');
    const lines = digest.split('\n');
    const loginIdx = lines.findIndex((l) => l.includes('login'));
    const emailIdx = lines.findIndex((l) => l.includes('email'));
    expect(emailIdx).toBeGreaterThan(loginIdx);
    expect(lines[emailIdx].startsWith('    ')).toBe(true); // deeper indent than login
  });

  it('ALWAYS keeps the globals: variables, collections, text styles, background, placement', () => {
    const doc = makeDoc('delta-doc', [
      frame('login', { x: 200, y: 50, zIndex: 2 }),
      frame('dash', { x: 655, y: 50, width: 375, height: 812, zIndex: 1 }),
    ]);
    doc.variables = { 'color.primary': { type: 'color', value: '#0ea5e9' } };
    doc.themes = { mode: ['light', 'dark'] };
    doc.tokens = {
      colors: [],
      textStyles: [{ key: 'body', fontSize: 16, fontWeight: 400, lineHeight: 1.5, color: '#0f172a', name: 'Body' }],
    };
    const digest = canvasSnapshotDelta(doc, []);

    expect(digest).toContain('- Background: #ffffff');
    expect(digest).toContain('• $color.primary (color) = #0ea5e9');
    expect(digest).toContain('• mode: modes=[light, dark]');
    expect(digest).toContain('• body 16px/400 #0f172a (Body)');
    // Multi-screen placement contract survives delta mode.
    expect(digest).toContain('place the NEXT screen frame at (1110,50)');
  });

  it('reports the changed count and mode banner', () => {
    const doc = makeDoc('delta-doc', [
      frame('login', { zIndex: 2 }),
      makeShape('email', { parentId: 'login', zIndex: 1 }),
    ]);
    const digest = canvasSnapshotDelta(doc, ['login', 'email', 'ghost-id-was-deleted']);
    expect(digest).toContain('Changed since the last turn: 2 node(s)');
    expect(digest).toContain('DELTA MODE');
    // Deleted ids (changed then removed) simply don't resolve.
    expect(digest).not.toContain('ghost-id-was-deleted');
  });

  it('scopes resolve warnings to changed ids only', () => {
    // Warnings come from resolvePenTreeDetailed over the PEN tree
    // (doc.children) — an undefined $variable fill on the frame. The changed
    // set covers the frame → the warning rides the digest; empty changed set
    // → no warnings section (unchanged degradation was reported in an
    // earlier full snapshot; global changes fall back to full mode).
    const doc = makeDoc('delta-doc', []);
    const penText: PenText = { id: 'email', type: 'text', x: 0, y: 0, width: 100, height: 20, content: 'Email' };
    const penFrame: PenFrame = {
      id: 'login', type: 'frame', x: 200, y: 50, width: 375, height: 812,
      fill: '$missing-var', children: [penText],
    };
    doc.children = [penFrame];
    doc.shapes = [
      makeShape('login', { type: 'frame', x: 200, y: 50, width: 375, height: 812, zIndex: 1, fill: '$missing-var' }),
      makeShape('email', { parentId: 'login', zIndex: 1 }),
    ];

    const digest = canvasSnapshotDelta(doc, ['login']);
    expect(digest).toContain('unresolved_variable');
    expect(digest).toContain('changed nodes only');

    const digest2 = canvasSnapshotDelta(doc, []);
    expect(digest2).not.toContain('Resolve warnings');
  });

  it('collapses EVERYTHING (no full lines) when nothing changed', () => {
    const doc = makeDoc('delta-doc', [
      frame('login', { zIndex: 2 }),
      makeShape('email', { parentId: 'login', text: 'Email', zIndex: 1 }),
    ]);
    const digest = canvasSnapshotDelta(doc, []);
    expect(digest).toContain('Changed since the last turn: 0 node(s)');
    // No full-detail field vocabulary anywhere in the tree section.
    expect(digest).not.toContain('characters="Email"');
    expect(digest).toContain('+1 descendants, unchanged');
  });

  it('handles the empty canvas (same guard line as the full snapshot)', () => {
    const digest = canvasSnapshotDelta(makeDoc('delta-doc', []), []);
    expect(digest).toContain('(empty)');
    expect(digest).toContain('canvas is empty — place the first screen frame around (200, 50)');
  });

  it('is byte-deterministic across calls (prefix-cache / reproducibility rule)', () => {
    const doc = makeDoc('delta-doc', [
      frame('login', { zIndex: 2 }),
      makeShape('email', { parentId: 'login', zIndex: 1 }),
      frame('dash', { x: 655, y: 50, zIndex: 0 }),
    ]);
    const a = canvasSnapshotDelta(doc, ['email']);
    const b = canvasSnapshotDelta(doc, ['email']);
    expect(a).toBe(b);
  });

  it('accepts a Set as well as an array (server passes either)', () => {
    const doc = makeDoc('delta-doc', [frame('login'), makeShape('email', { parentId: 'login' })]);
    expect(canvasSnapshotDelta(doc, new Set(['email']))).toBe(canvasSnapshotDelta(doc, ['email']));
  });
});
