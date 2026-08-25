// Unit tests — the Phase 7 shortcut registry (spec §10.3 #1 / Appendix H §H.2).
//
// Invariants:
//   1. Every H.2 'add'/'rebind' row from the task list is present.
//   2. No two actions share the same PRIMARY chord within a scope
//      (conflict detection — R14 mitigation).
//   3. matchShortcut: true/false matrix incl. mac-meta vs win-ctrl platform
//      handling, exact-modifier matching, and alias chords.
//   4. The KeyboardShortcutsDialog renders from the SAME registry
//      (groupShortcutsForDialog is the dialog's data source — no drift).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SHORTCUTS,
  SHORTCUTS_BY_ACTION,
  matchShortcut,
  matchAnyShortcut,
  chordFor,
  findConflicts,
  parseChord,
  canonicalChord,
  currentPlatform,
  resetPlatformCache,
  groupShortcutsForDialog,
} from '@/lib/canvas/shortcuts';

// jsdom has no navigator.platform — the helper falls back to 'win'. We pin
// the platform per test via Object.defineProperty.
function pinPlatform(value: 'mac' | 'win') {
  resetPlatformCache();
  Object.defineProperty(window.navigator, 'platform', {
    value: value === 'mac' ? 'MacIntel' : 'Win32',
    configurable: true,
  });
  Object.defineProperty(window.navigator, 'userAgent', {
    value: value === 'mac' ? 'Mozilla/5.0 (Macintosh)' : 'Mozilla/5.0 (Windows NT 10.0)',
    configurable: true,
  });
}

function keyEvent(init: KeyboardEventInit & { code?: string }): KeyboardEvent {
  const e = new KeyboardEvent('keydown', init);
  if (init.code) {
    Object.defineProperty(e, 'code', { value: init.code, configurable: true });
  }
  return e;
}

describe('shortcut registry — Appendix H §H.2 bindings present', () => {
  const REQUIRED: Array<[action: string, mac: string]> = [
    // Tools
    ['tool.move', 'V'],
    ['tool.hand', 'H'],
    ['tool.scale', 'K'],
    ['tool.frame', 'F'],
    ['tool.section', '⇧S'],
    ['tool.slice', 'S'],
    ['tool.rectangle', 'R'],
    ['tool.ellipse', 'O'],
    ['tool.line', 'L'],
    ['tool.text', 'T'],
    // Structure
    ['group', '⌘G'],
    ['ungroup', '⌘⇧G'],
    ['frame-selection', '⌥⌘G'],
    // Edit
    ['duplicate', '⌘D'],
    ['rename', '⌘R'],
    ['lock', '⌘⇧L'],
    ['hide', '⌘⇧H'],
    // Align + flip
    ['align.left', '⌥A'],
    ['align.top', '⌥W'],
    ['align.bottom', '⌥S'],
    ['align.right', '⌥D'],
    ['align.hcenter', '⌥H'],
    ['align.vcenter', '⌥V'],
    ['flip.h', '⇧H'],
    ['flip.v', '⇧V'],
    // Components
    ['create-component', '⌥⌘K'],
    ['detach-instance', '⌥⌘B'],
    // View
    ['outline-mode', '⌘⇧O'],
    ['pixel-grid', "⌘'"],
    ['snap-to-pixel', "⌘⇧'"],
    // Zoom
    ['zoom.fit', '⇧1'],
    ['zoom.selection', '⇧2'],
    ['zoom.100', '⇧0'],
    // App (existing, now registry-listed)
    ['zen', '⌘\\'],
    ['palette', '⌘K'],
    ['save-checkpoint', '⌘⌥S'],
  ];

  it.each(REQUIRED)('%s registered with mac chord %s', (action, mac) => {
    const def = SHORTCUTS_BY_ACTION.get(action);
    expect(def, `action ${action} must be registered`).toBeDefined();
    expect(def!.mac).toBe(mac);
  });

  it('rebound chords keep the legacy chords as `also` aliases (H.3 #3)', () => {
    expect(SHORTCUTS_BY_ACTION.get('lock')!.also).toContain('⌘L');
    expect(SHORTCUTS_BY_ACTION.get('hide')!.also).toContain('⌘;');
    expect(SHORTCUTS_BY_ACTION.get('create-component')!.also).toContain('⌘⇧C');
  });

  it('every entry carries a win chord and a valid scope', () => {
    for (const def of SHORTCUTS) {
      expect(def.action.length).toBeGreaterThan(0);
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.mac.length).toBeGreaterThan(0);
      expect(def.win.length).toBeGreaterThan(0);
      expect(['canvas', 'app', 'layers']).toContain(def.scope);
    }
  });
});

describe('shortcut registry — conflict detection', () => {
  it('no two actions share a primary chord within a scope (mac + win)', () => {
    const conflicts = findConflicts();
    expect(conflicts).toEqual([]);
  });

  it('findConflicts reports a synthetic collision', () => {
    const bad = [
      ...SHORTCUTS,
      { action: 'fake.duplicate-chord', label: 'Fake', mac: '⌘G', win: 'Ctrl+G', scope: 'canvas' as const },
    ];
    const conflicts = findConflicts(bad);
    expect(conflicts.length).toBeGreaterThanOrEqual(1);
    expect(conflicts[0].actions).toContain('group');
    expect(conflicts[0].actions).toContain('fake.duplicate-chord');
  });

  it('the same chord in DIFFERENT scopes is not a conflict', () => {
    const ok = [
      { action: 'a.one', label: 'One', mac: '⌘J', win: 'Ctrl+J', scope: 'canvas' as const },
      { action: 'a.two', label: 'Two', mac: '⌘J', win: 'Ctrl+J', scope: 'app' as const },
    ];
    expect(findConflicts(ok)).toEqual([]);
  });
});

describe('parseChord / canonicalChord', () => {
  it('parses mac symbol chords', () => {
    expect(parseChord('⌘⇧G')).toEqual({ meta: true, ctrl: false, alt: false, shift: true, key: 'g' });
    expect(parseChord('⌥⌘K')).toEqual({ meta: true, ctrl: false, alt: true, shift: false, key: 'k' });
    expect(parseChord('⇧1')).toEqual({ meta: false, ctrl: false, alt: false, shift: true, key: '1' });
    expect(parseChord("⌘'")).toEqual({ meta: true, ctrl: false, alt: false, shift: false, key: "'" });
  });

  it('parses win-style chords (incl. quote and plus keys)', () => {
    expect(parseChord('Ctrl+Shift+G')).toEqual({ meta: false, ctrl: true, alt: false, shift: true, key: 'g' });
    expect(parseChord('Ctrl+Alt+K')).toEqual({ meta: false, ctrl: true, alt: true, shift: false, key: 'k' });
    expect(parseChord("Ctrl+'")).toEqual({ meta: true && false, ctrl: true, alt: false, shift: false, key: "'" });
    expect(parseChord('Shift++')).toEqual({ meta: false, ctrl: false, alt: false, shift: true, key: '+' });
  });

  it('canonicalChord distinguishes modifier sets', () => {
    expect(canonicalChord('⌘G')).not.toBe(canonicalChord('⌘⇧G'));
    expect(canonicalChord('⌘G')).not.toBe(canonicalChord('⌥⌘G'));
    expect(canonicalChord('H')).not.toBe(canonicalChord('⇧H'));
    expect(canonicalChord('S')).not.toBe(canonicalChord('⇧S'));
  });
});

describe('matchShortcut — platform + modifier matrix', () => {
  beforeEach(() => pinPlatform('mac'));
  afterEach(() => pinPlatform('win'));

  it('mac: meta chord matches metaKey, not ctrlKey', () => {
    const def = SHORTCUTS_BY_ACTION.get('group')!; // ⌘G / Ctrl+G
    expect(matchShortcut(keyEvent({ key: 'g', metaKey: true }), def)).toBe(true);
    expect(matchShortcut(keyEvent({ key: 'g', ctrlKey: true }), def)).toBe(false);
    // Exact modifiers: ⌘⇧G must NOT fire the ⌘G action.
    expect(matchShortcut(keyEvent({ key: 'g', metaKey: true, shiftKey: true }), def)).toBe(false);
  });

  it('win: the same def matches ctrlKey, not metaKey', () => {
    pinPlatform('win');
    const def = SHORTCUTS_BY_ACTION.get('group')!;
    expect(matchShortcut(keyEvent({ key: 'g', ctrlKey: true }), def)).toBe(true);
    expect(matchShortcut(keyEvent({ key: 'g', metaKey: true }), def)).toBe(false);
  });

  it('plain tool keys require NO modifiers (V vs ⌘V vs ⇧V)', () => {
    const move = SHORTCUTS_BY_ACTION.get('tool.move')!;
    expect(matchShortcut(keyEvent({ key: 'v' }), move)).toBe(true);
    expect(matchShortcut(keyEvent({ key: 'v', metaKey: true }), move)).toBe(false);
    expect(matchShortcut(keyEvent({ key: 'V', shiftKey: true }), move)).toBe(false);
  });

  it('⇧S section does not collide with S slice (and vice versa)', () => {
    const section = SHORTCUTS_BY_ACTION.get('tool.section')!;
    const slice = SHORTCUTS_BY_ACTION.get('tool.slice')!;
    expect(matchShortcut(keyEvent({ key: 'S', shiftKey: true }), section)).toBe(true);
    expect(matchShortcut(keyEvent({ key: 'S', shiftKey: true }), slice)).toBe(false);
    expect(matchShortcut(keyEvent({ key: 's' }), slice)).toBe(true);
    expect(matchShortcut(keyEvent({ key: 's' }), section)).toBe(false);
  });

  it('mac ⌥-letters match via event.code (⌥A types "å" on mac layouts)', () => {
    const alignLeft = SHORTCUTS_BY_ACTION.get('align.left')!;
    expect(matchShortcut(keyEvent({ key: 'å', altKey: true, code: 'KeyA' }), alignLeft)).toBe(true);
    expect(matchShortcut(keyEvent({ key: 'a', altKey: true, code: 'KeyA' }), alignLeft)).toBe(true);
    expect(matchShortcut(keyEvent({ key: 'a', code: 'KeyA' }), alignLeft)).toBe(false);
  });

  it('⇧digit chords match via event.code (⇧1 types "!" on US layouts)', () => {
    const fit = SHORTCUTS_BY_ACTION.get('zoom.fit')!;
    expect(matchShortcut(keyEvent({ key: '!', shiftKey: true, code: 'Digit1' }), fit)).toBe(true);
    expect(matchShortcut(keyEvent({ key: '1', shiftKey: true, code: 'Digit1' }), fit)).toBe(true);
    // Unshifted 1 must NOT trigger zoom-fit.
    expect(matchShortcut(keyEvent({ key: '1', code: 'Digit1' }), fit)).toBe(false);
  });

  it('alias chords match (legacy ⌘L lock, ⌘⇧C create-component)', () => {
    const lock = SHORTCUTS_BY_ACTION.get('lock')!;
    expect(matchShortcut(keyEvent({ key: 'l', metaKey: true }), lock)).toBe(true);
    expect(matchShortcut(keyEvent({ key: 'l', metaKey: true, shiftKey: true }), lock)).toBe(true);
    const comp = SHORTCUTS_BY_ACTION.get('create-component')!;
    expect(matchShortcut(keyEvent({ key: 'c', metaKey: true, shiftKey: true }), comp)).toBe(true);
    expect(matchShortcut(keyEvent({ key: 'k', metaKey: true, altKey: true }), comp)).toBe(true);
  });

  it('quote chords: ⌘\' and ⌘⇧\' (shift-quote types "a double quote")', () => {
    const grid = SHORTCUTS_BY_ACTION.get('pixel-grid')!;
    expect(matchShortcut(keyEvent({ key: "'", metaKey: true, code: 'Quote' }), grid)).toBe(true);
    const snap = SHORTCUTS_BY_ACTION.get('snap-to-pixel')!;
    expect(matchShortcut(keyEvent({ key: '"', metaKey: true, shiftKey: true, code: 'Quote' }), snap)).toBe(true);
    expect(matchShortcut(keyEvent({ key: '"', metaKey: true, shiftKey: true, code: 'Quote' }), grid)).toBe(false);
  });

  it('matchAnyShortcut honors the action allowlist', () => {
    const e = keyEvent({ key: 'g', metaKey: true });
    expect(matchAnyShortcut(e, ['group'])?.action).toBe('group');
    expect(matchAnyShortcut(e, ['duplicate'])).toBeNull();
    expect(matchAnyShortcut(e, ['group', 'duplicate'])?.action).toBe('group');
  });
});

describe('chordFor + platform detection', () => {
  it('chordFor returns the platform-appropriate display chord', () => {
    const def = SHORTCUTS_BY_ACTION.get('frame-selection')!;
    expect(chordFor(def, 'mac')).toBe('⌥⌘G');
    expect(chordFor(def, 'win')).toBe('Ctrl+Alt+G');
  });

  it('currentPlatform caches + resetPlatformCache clears', () => {
    pinPlatform('mac');
    expect(currentPlatform()).toBe('mac');
    pinPlatform('win');
    expect(currentPlatform()).toBe('win');
  });
});

describe('KeyboardShortcutsDialog data source = registry (no drift)', () => {
  it('every registry action appears exactly once in the dialog groups', () => {
    const groups = groupShortcutsForDialog();
    const listed = groups.flatMap((g) => g.entries.map((e) => e.action));
    expect(listed.sort()).toEqual([...SHORTCUTS].map((s) => s.action).sort());
  });

  it('groups carry display titles and non-empty entries', () => {
    const groups = groupShortcutsForDialog();
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) {
      expect(g.title.length).toBeGreaterThan(0);
      expect(g.entries.length).toBeGreaterThan(0);
      for (const e of g.entries) expect(e.scope).toBe(g.scope);
    }
  });

  it('filtering the registry before grouping still groups consistently', () => {
    const zoomOnly = SHORTCUTS.filter((s) => s.action.startsWith('zoom.'));
    const groups = groupShortcutsForDialog(zoomOnly);
    expect(groups).toHaveLength(1);
    expect(groups[0].scope).toBe('canvas');
    expect(groups[0].entries.map((e) => e.action)).toContain('zoom.fit');
  });
});

// Phase 7 §H.1 — sidebar tab selection (Appendix H §H.3 deviation #1).
// ⌥1 / ⌥2 select the Layers/Assets tabs INSIDE the left sidebar (Figma's
// own sidebar chords); the top-level panel toggles stay ⌘⇧1/⌘⇧2 (legacy).
describe('sidebar tab-selectors — ⌥1 (Layers) / ⌥2 (Assets)', () => {
  it('panel.layers-tab registered with mac ⌥1 / win Alt+1', () => {
    const def = SHORTCUTS_BY_ACTION.get('panel.layers-tab');
    expect(def, 'panel.layers-tab must be registered').toBeDefined();
    expect(def!.mac).toBe('⌥1');
    expect(def!.win).toBe('Alt+1');
    expect(def!.scope).toBe('app');
  });

  it('panel.assets-tab registered with mac ⌥2 / win Alt+2', () => {
    const def = SHORTCUTS_BY_ACTION.get('panel.assets-tab');
    expect(def, 'panel.assets-tab must be registered').toBeDefined();
    expect(def!.mac).toBe('⌥2');
    expect(def!.win).toBe('Alt+2');
    expect(def!.scope).toBe('app');
  });

  it('⌥1 / ⌥2 do NOT collide with ⇧1 (zoom.fit) / ⇧2 (zoom.selection) — different modifiers', () => {
    const fit = SHORTCUTS_BY_ACTION.get('zoom.fit')!;
    const sel = SHORTCUTS_BY_ACTION.get('zoom.selection')!;
    const layers = SHORTCUTS_BY_ACTION.get('panel.layers-tab')!;
    const assets = SHORTCUTS_BY_ACTION.get('panel.assets-tab')!;
    expect(canonicalChord(layers.mac)).not.toBe(canonicalChord(fit.mac));
    expect(canonicalChord(assets.mac)).not.toBe(canonicalChord(sel.mac));
  });

  it('mac: ⌥1 matches via event.code Digit1 (Alt+digit types alternate glyphs)', () => {
    pinPlatform('mac');
    const layers = SHORTCUTS_BY_ACTION.get('panel.layers-tab')!;
    // Alt+1 on a US mac layout types '¡' — match via physical code.
    expect(matchShortcut(keyEvent({ key: '¡', altKey: true, code: 'Digit1' }), layers)).toBe(true);
    // Alt+1 with key='1' (win layout) should also match.
    expect(matchShortcut(keyEvent({ key: '1', altKey: true, code: 'Digit1' }), layers)).toBe(true);
    // Plain 1 (no Alt) must NOT trigger.
    expect(matchShortcut(keyEvent({ key: '1', code: 'Digit1' }), layers)).toBe(false);
  });

  it('mac: ⌥2 matches via event.code Digit2', () => {
    pinPlatform('mac');
    const assets = SHORTCUTS_BY_ACTION.get('panel.assets-tab')!;
    expect(matchShortcut(keyEvent({ key: '™', altKey: true, code: 'Digit2' }), assets)).toBe(true);
    expect(matchShortcut(keyEvent({ key: '2', altKey: true, code: 'Digit2' }), assets)).toBe(true);
  });

  it('win: Alt+1 / Alt+2 match ctrl-alt (digit via event.code)', () => {
    pinPlatform('win');
    const layers = SHORTCUTS_BY_ACTION.get('panel.layers-tab')!;
    const assets = SHORTCUTS_BY_ACTION.get('panel.assets-tab')!;
    expect(matchShortcut(keyEvent({ key: '1', altKey: true, code: 'Digit1' }), layers)).toBe(true);
    expect(matchShortcut(keyEvent({ key: '2', altKey: true, code: 'Digit2' }), assets)).toBe(true);
  });
});
