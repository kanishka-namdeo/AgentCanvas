// Shortcut registry — the single source of truth for every keyboard chord in
// AgentCanvas (spec Phase 7 / Appendix H §H.2).
//
// The registry drives BOTH sides of the wiring:
//   1. the keymap — `matchShortcut(event, def)` is used by the keydown
//      handlers in src/app/page.tsx (app/layers/structure actions) and
//      src/components/canvas/Canvas.tsx (canvas view/zoom/navigation chords);
//   2. the help — KeyboardShortcutsDialog renders straight from SHORTCUTS,
//      so the cheat sheet can never drift from the keymap.
//
// Bindings follow Figma's canonical set (Appendix H §H.2) with the documented
// deviations from §H.3:
//   - panel toggles stay ⌘⇧1/⌘⇧2 (ours; Figma's ⌥1/⌥2/⌥3 are sidebar-internal),
//   - Lock/Hide rebind to ⌘⇧L/⌘⇧H with the legacy ⌘L/⌘; kept as `also` aliases
//     for one release (H.3 #3),
//   - Create component rebinds to ⌥⌘K with ⌘⇧C as a legacy alias.
//
// Chord notation:
//   mac: symbol prefixes — ⌘ meta, ⌥ alt, ⌃ ctrl, ⇧ shift — then the key
//        (e.g. '⌘⇧G', '⌥A', '⇧1', '⌘\'').
//   win: 'Ctrl+Alt+Shift+K' style; '+' separates tokens.
//
// `also` aliases are written in mac notation and auto-translated for Windows
// matching (⌘→Ctrl, ⌥→Alt, ⇧→Shift, ⌃→Ctrl).

export type ShortcutScope = 'canvas' | 'app' | 'layers';

export interface ShortcutDef {
  /// Stable action id (e.g. 'tool.move', 'zoom.fit'). Never rename — the
  /// keymap dispatch and the tests key off these.
  action: string;
  /// Human label (shown in the dialog + tooltips).
  label: string;
  /// Primary chord, mac notation.
  mac: string;
  /// Primary chord, Windows notation.
  win: string;
  /// Where the chord is active / which surface handles it.
  scope: ShortcutScope;
  description?: string;
  /// Secondary chords (legacy aliases during a rebind window). Mac notation.
  also?: string[];
}

// ---- Platform detection ------------------------------------------------------

let cachedPlatform: 'mac' | 'win' | null = null;

/// Current platform for chord display/matching. 'win' is the fallback for
/// every non-Mac environment (Linux included — the Ctrl-style chords apply).
export function currentPlatform(): 'mac' | 'win' {
  if (cachedPlatform) return cachedPlatform;
  if (typeof navigator !== 'undefined') {
    const p = (navigator.platform || '') + ' ' + (navigator.userAgent || '');
    cachedPlatform = /mac|iphone|ipad|ipod/i.test(p) ? 'mac' : 'win';
  } else {
    cachedPlatform = 'win';
  }
  return cachedPlatform;
}

/// Test hook — reset the cached platform (jsdom default is 'win' since
/// navigator.platform is '' there).
export function resetPlatformCache(): void {
  cachedPlatform = null;
}

// ---- Chord parsing -----------------------------------------------------------

export interface ParsedChord {
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /// Normalized key: lowercase letter / digit / named key (Enter, Tab, …).
  key: string;
}

const MAC_SYMBOLS: Record<string, Partial<ParsedChord>> = {
  '⌘': { meta: true },
  '⌥': { alt: true },
  '⌃': { ctrl: true },
  '⇧': { shift: true },
};

/// Translate a mac-notation chord into Windows notation (for `also` aliases).
export function macChordToWin(chord: string): string {
  let out = '';
  let key = '';
  for (const ch of chord) {
    if (ch === '⌘') out += 'Ctrl+';
    else if (ch === '⌥') out += 'Alt+';
    else if (ch === '⌃') out += 'Ctrl+';
    else if (ch === '⇧') out += 'Shift+';
    else key += ch;
  }
  return out + key;
}

/// Parse a chord in either notation into modifiers + normalized key.
export function parseChord(chord: string): ParsedChord {
  const parsed: ParsedChord = { meta: false, ctrl: false, alt: false, shift: false, key: '' };
  // Mac notation: symbol prefix run followed by the key.
  if (/[⌘⌥⌃⇧]/.test(chord)) {
    let key = '';
    for (const ch of chord) {
      const mod = MAC_SYMBOLS[ch];
      if (mod) {
        if (mod.meta) parsed.meta = true;
        if (mod.ctrl) parsed.ctrl = true;
        if (mod.alt) parsed.alt = true;
        if (mod.shift) parsed.shift = true;
      } else {
        key += ch;
      }
    }
    parsed.key = normalizeKey(key);
    return parsed;
  }
  // Windows notation: modifier prefixes ('Ctrl+'/'Alt+'/'Shift+'/'Meta+')
  // followed by the key. Scanned left-to-right (not split on '+') so keys
  // like "'" and '+' survive intact ('Ctrl+''', 'Shift++').
  let rest = chord;
  const modPrefix = /^(ctrl|control|alt|option|shift|meta|cmd|command)\+/i;
  for (;;) {
    const m = modPrefix.exec(rest);
    if (!m) break;
    const lower = m[1].toLowerCase();
    if (lower === 'ctrl' || lower === 'control') parsed.ctrl = true;
    else if (lower === 'alt' || lower === 'option') parsed.alt = true;
    else if (lower === 'shift') parsed.shift = true;
    else parsed.meta = true;
    rest = rest.slice(m[0].length);
  }
  parsed.key = normalizeKey(rest);
  return parsed;
}

function normalizeKey(key: string): string {
  const k = key.trim();
  if (k === 'Esc') return 'escape';
  if (k === 'Del') return 'delete';
  if (k === 'Backspace' || k === '⌫') return 'backspace';
  if (k === 'Plus') return '+';
  if (k === 'Minus' || k === '−') return '-'; // '−' = U+2212 minus sign
  return k.length === 1 ? k.toLowerCase() : k.toLowerCase();
}

/// Canonical comparable form of a chord (conflict detection + tests).
export function canonicalChord(chord: string): string {
  const p = parseChord(chord);
  const mods = [
    p.meta ? 'M' : '',
    p.ctrl ? 'C' : '',
    p.alt ? 'A' : '',
    p.shift ? 'S' : '',
  ].join('');
  return `${mods}:${p.key}`;
}

// ---- Matching ----------------------------------------------------------------

/// Keys that arrive as a DIFFERENT `event.key` when shift is held on a US
/// layout — matched via `event.code` instead (digits, quote, plus/minus).
function keyMatchesEvent(parsed: ParsedChord, e: KeyboardEvent): boolean {
  const key = parsed.key;
  const eventKey = e.key.toLowerCase();
  if (key === eventKey) return true;
  // Letters: accept the physical key (mac ⌥-combos produce dead/alternate
  // glyphs — ⌥A is 'å' — so compare e.code 'KeyA').
  if (/^[a-z]$/.test(key)) return e.code === `Key${key.toUpperCase()}`;
  // Digits: ⇧1 produces '!' on US layouts — compare e.code 'Digit1'.
  if (/^[0-9]$/.test(key)) return e.code === `Digit${key}`;
  // Quote family: ⌘⇧' produces '"' on US layouts.
  if (key === "'") return e.code === 'Quote';
  // Plus/minus/equals family (⇧+ / ⇧− zoom chords).
  if (key === '+' || key === '=') return eventKey === '+' || eventKey === '=' || e.code === 'Equal';
  if (key === '-' || key === '_') return eventKey === '-' || eventKey === '_' || e.code === 'Minus';
  if (key === 'enter') return eventKey === 'enter';
  if (key === 'tab') return eventKey === 'tab';
  if (key === 'backspace' || key === 'delete') return eventKey === 'backspace' || eventKey === 'delete';
  return false;
}

/// Does `e` match the shortcut's primary chord (platform-appropriate) or any
/// of its `also` aliases? Modifier state must match EXACTLY — 'V' never
/// matches ⌘V and ⌘⇧G never matches ⌘G.
export function matchShortcut(e: KeyboardEvent, def: ShortcutDef): boolean {
  const platform = currentPlatform();
  const primary = platform === 'mac' ? def.mac : def.win;
  const chords = [primary, ...(def.also ?? [])];
  for (const chord of chords) {
    // `also` aliases are mac notation — translate when matching on win.
    const candidate = platform === 'mac' || chord === primary ? chord : macChordToWin(chord);
    const parsed = parseChord(candidate);
    if (
      e.metaKey === parsed.meta &&
      e.ctrlKey === parsed.ctrl &&
      e.altKey === parsed.alt &&
      e.shiftKey === parsed.shift &&
      keyMatchesEvent(parsed, e)
    ) {
      return true;
    }
  }
  return false;
}

/// Display chord for a platform (dialog + menu hints).
export function chordFor(def: ShortcutDef, platform: 'mac' | 'win'): string {
  return platform === 'mac' ? def.mac : def.win;
}

/// Find the first shortcut in `shortcuts` (default SHORTCUTS) whose chord
/// matches the event. Convenience for keymap dispatch loops.
export function matchAnyShortcut(
  e: KeyboardEvent,
  actions: readonly string[],
  shortcuts: ShortcutDef[] = SHORTCUTS,
): ShortcutDef | null {
  const allowed = new Set(actions);
  for (const def of shortcuts) {
    if (!allowed.has(def.action)) continue;
    if (matchShortcut(e, def)) return def;
  }
  return null;
}

// ---- Conflict detection (registry invariant, exercised by tests) -------------

export interface ChordConflict {
  platform: 'mac' | 'win';
  scope: ShortcutScope;
  chord: string;
  actions: string[];
}

/// No two actions may bind the same PRIMARY chord within the same scope.
/// Aliases (`also`) are exempt — they intentionally overlap their own action.
export function findConflicts(shortcuts: ShortcutDef[] = SHORTCUTS): ChordConflict[] {
  const conflicts: ChordConflict[] = [];
  for (const platform of ['mac', 'win'] as const) {
    const byScopeChord = new Map<string, string[]>();
    for (const def of shortcuts) {
      const chord = canonicalChord(platform === 'mac' ? def.mac : def.win);
      const mapKey = `${def.scope}|${chord}`;
      const list = byScopeChord.get(mapKey) ?? [];
      list.push(def.action);
      byScopeChord.set(mapKey, list);
    }
    for (const [mapKey, actions] of byScopeChord) {
      if (actions.length > 1) {
        const [scope, chord] = mapKey.split('|');
        conflicts.push({ platform, scope: scope as ShortcutScope, chord, actions });
      }
    }
  }
  return conflicts;
}

// ---- The registry (Appendix H §H.2 'add'/'rebind' rows + existing chords) ----

export const SHORTCUTS: ShortcutDef[] = [
  // --- Tools (H.1 toolbar grouping) ---
  { action: 'tool.move', label: 'Move tool', mac: 'V', win: 'V', scope: 'canvas' },
  { action: 'tool.hand', label: 'Hand tool (hold Space to pan temporarily)', mac: 'H', win: 'H', scope: 'canvas' },
  { action: 'tool.scale', label: 'Scale tool — proportional resize incl. font size', mac: 'K', win: 'K', scope: 'canvas' },
  { action: 'tool.frame', label: 'Frame tool', mac: 'F', win: 'F', scope: 'canvas' },
  { action: 'tool.section', label: 'Section tool', mac: '⇧S', win: 'Shift+S', scope: 'canvas' },
  { action: 'tool.slice', label: 'Slice tool', mac: 'S', win: 'S', scope: 'canvas' },
  { action: 'tool.rectangle', label: 'Rectangle tool', mac: 'R', win: 'R', scope: 'canvas' },
  { action: 'tool.ellipse', label: 'Ellipse tool', mac: 'O', win: 'O', scope: 'canvas' },
  { action: 'tool.line', label: 'Line tool', mac: 'L', win: 'L', scope: 'canvas' },
  { action: 'tool.text', label: 'Text tool', mac: 'T', win: 'T', scope: 'canvas' },

  // --- Structure ---
  { action: 'group', label: 'Group selection', mac: '⌘G', win: 'Ctrl+G', scope: 'canvas' },
  { action: 'ungroup', label: 'Ungroup', mac: '⌘⇧G', win: 'Ctrl+Shift+G', scope: 'canvas' },
  { action: 'frame-selection', label: 'Frame selection', mac: '⌥⌘G', win: 'Ctrl+Alt+G', scope: 'canvas' },

  // --- Edit ---
  { action: 'duplicate', label: 'Duplicate selection', mac: '⌘D', win: 'Ctrl+D', scope: 'canvas' },
  { action: 'lock', label: 'Lock / unlock selection', mac: '⌘⇧L', win: 'Ctrl+Shift+L', scope: 'canvas', also: ['⌘L'] },
  { action: 'hide', label: 'Hide / show selection', mac: '⌘⇧H', win: 'Ctrl+Shift+H', scope: 'canvas', also: ['⌘;'] },
  { action: 'rename', label: 'Rename selected layer (Layers panel)', mac: '⌘R', win: 'Ctrl+R', scope: 'layers' },

  // --- Align / flip (Figma canonical chords) ---
  { action: 'align.left', label: 'Align left', mac: '⌥A', win: 'Alt+A', scope: 'canvas' },
  { action: 'align.top', label: 'Align top', mac: '⌥W', win: 'Alt+W', scope: 'canvas' },
  { action: 'align.bottom', label: 'Align bottom', mac: '⌥S', win: 'Alt+S', scope: 'canvas' },
  { action: 'align.right', label: 'Align right', mac: '⌥D', win: 'Alt+D', scope: 'canvas' },
  { action: 'align.hcenter', label: 'Align horizontal centers', mac: '⌥H', win: 'Alt+H', scope: 'canvas' },
  { action: 'align.vcenter', label: 'Align vertical centers', mac: '⌥V', win: 'Alt+V', scope: 'canvas' },
  { action: 'flip.h', label: 'Flip horizontal', mac: '⇧H', win: 'Shift+H', scope: 'canvas' },
  { action: 'flip.v', label: 'Flip vertical', mac: '⇧V', win: 'Shift+V', scope: 'canvas' },

  // --- Components ---
  { action: 'create-component', label: 'Create component', mac: '⌥⌘K', win: 'Ctrl+Alt+K', scope: 'canvas', also: ['⌘⇧C'] },
  { action: 'detach-instance', label: 'Detach instance', mac: '⌥⌘B', win: 'Ctrl+Alt+B', scope: 'canvas' },

  // --- View options ---
  { action: 'outline-mode', label: 'Toggle outline mode', mac: '⌘⇧O', win: 'Ctrl+Shift+O', scope: 'canvas' },
  { action: 'pixel-grid', label: 'Toggle pixel grid', mac: '⌘\'', win: "Ctrl+'", scope: 'canvas' },
  { action: 'snap-to-pixel', label: 'Toggle snap to pixel grid', mac: '⌘⇧\'', win: "Ctrl+Shift+'", scope: 'canvas' },

  // --- Zoom ---
  { action: 'zoom.in', label: 'Zoom in', mac: '⇧+', win: 'Shift++', scope: 'canvas' },
  { action: 'zoom.out', label: 'Zoom out', mac: '⇧−', win: 'Shift+-', scope: 'canvas' },
  { action: 'zoom.fit', label: 'Zoom to fit', mac: '⇧1', win: 'Shift+1', scope: 'canvas' },
  { action: 'zoom.selection', label: 'Zoom to selection', mac: '⇧2', win: 'Shift+2', scope: 'canvas' },
  { action: 'zoom.100', label: 'Zoom to 100%', mac: '⇧0', win: 'Shift+0', scope: 'canvas' },

  // --- Hierarchy navigation ---
  { action: 'nav.child', label: 'Select first child (enter container)', mac: 'Enter', win: 'Enter', scope: 'canvas' },
  { action: 'nav.parent', label: 'Select parent', mac: '⇧Enter', win: 'Shift+Enter', scope: 'canvas' },
  { action: 'nav.sibling-next', label: 'Select next sibling', mac: 'Tab', win: 'Tab', scope: 'canvas' },
  { action: 'nav.sibling-prev', label: 'Select previous sibling', mac: '⇧Tab', win: 'Shift+Tab', scope: 'canvas' },

  // --- Canvas interaction modifiers (documented, not keymap-dispatched) ---
  { action: 'deep-select', label: 'Deep select — click through the ancestor chain', mac: '⌘+click', win: 'Ctrl+click', scope: 'canvas' },
  { action: 'nested-marquee', label: 'Nested marquee — select descendants of intersecting containers', mac: '⌘+drag', win: 'Ctrl+drag', scope: 'canvas' },

  // --- App-level (existing chords, now registry-listed) ---
  { action: 'zen', label: 'Toggle zen / hide UI', mac: '⌘\\', win: 'Ctrl+\\', scope: 'app' },
  { action: 'palette', label: 'Open command palette', mac: '⌘K', win: 'Ctrl+K', scope: 'app' },
  { action: 'save-checkpoint', label: 'Save a version-history checkpoint', mac: '⌘⌥S', win: 'Ctrl+Alt+S', scope: 'app' },
  { action: 'undo', label: 'Undo', mac: '⌘Z', win: 'Ctrl+Z', scope: 'app' },
  { action: 'redo', label: 'Redo', mac: '⌘⇧Z', win: 'Ctrl+Shift+Z', scope: 'app' },
  { action: 'copy', label: 'Copy selection', mac: '⌘C', win: 'Ctrl+C', scope: 'app' },
  { action: 'cut', label: 'Cut selection', mac: '⌘X', win: 'Ctrl+X', scope: 'app' },
  { action: 'paste', label: 'Paste (with +24 offset)', mac: '⌘V', win: 'Ctrl+V', scope: 'app' },
  { action: 'paste-in-place', label: 'Paste in place', mac: '⌘⇧V', win: 'Ctrl+Shift+V', scope: 'app' },
  { action: 'select-all', label: 'Select all layers', mac: '⌘A', win: 'Ctrl+A', scope: 'app' },
  { action: 'shortcuts-dialog', label: 'Open the keyboard shortcuts cheat sheet', mac: '⌘/', win: 'Ctrl+/', scope: 'app', also: ['⌃⇧?'] },
  { action: 'toggle-left-panel', label: 'Toggle left panel', mac: '⌘⇧1', win: 'Ctrl+Shift+1', scope: 'app', also: ['⌘1'] },
  { action: 'toggle-right-panel', label: 'Toggle right panel', mac: '⌘⇧2', win: 'Ctrl+Shift+2', scope: 'app', also: ['⌘2'] },
  { action: 'delete', label: 'Delete selection', mac: '⌫', win: 'Del', scope: 'canvas' },
];

/// action id → def lookup (keymap dispatch + tests).
export const SHORTCUTS_BY_ACTION: ReadonlyMap<string, ShortcutDef> = new Map(
  SHORTCUTS.map((def) => [def.action, def]),
);

// ---- Dialog grouping -----------------------------------------------------------

export interface ShortcutDialogGroup {
  /// Display name for the group ('Canvas', 'Application', 'Layers').
  title: string;
  scope: ShortcutScope;
  entries: ShortcutDef[];
}

/// Group the registry for the KeyboardShortcutsDialog — the dialog renders
/// EXACTLY this (no hand-maintained table, so help can never drift).
export function groupShortcutsForDialog(shortcuts: ShortcutDef[] = SHORTCUTS): ShortcutDialogGroup[] {
  const titles: Record<ShortcutScope, string> = { canvas: 'Canvas', app: 'Application', layers: 'Layers' };
  const order: ShortcutScope[] = ['canvas', 'layers', 'app'];
  const groups: ShortcutDialogGroup[] = order.map((scope) => ({ title: titles[scope], scope, entries: [] }));
  for (const def of shortcuts) {
    const group = groups.find((g) => g.scope === def.scope);
    if (group) group.entries.push(def);
  }
  return groups.filter((g) => g.entries.length > 0);
}
