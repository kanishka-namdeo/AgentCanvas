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

/// Render a mac-notation chord for the CURRENT platform — context-menu
/// hints, command-palette `shortcut:` strings, empty-state <kbd> caps.
/// Windows/Linux users see "Ctrl+X" instead of a ⌘ glyph (interaction
/// consistency pass: hints must match the chord that actually fires).
/// Non-modifier symbols that have a Windows spelling are translated too
/// (⎋ → Esc, ⌫ → Backspace); everything else passes through unchanged.
const WIN_SYMBOLS: Record<string, string> = { '⎋': 'Esc', '⌫': 'Backspace', '⌥': 'Alt', '⌘': 'Ctrl' };
export function platformChord(macChord: string): string {
  if (currentPlatform() === 'mac') return macChord;
  // Collect flags first so output order is canonical (Ctrl, Alt, Shift)
  // regardless of the source notation order ('⌥⌘K' and '⌘⌥K' both →
  // 'Ctrl+Alt+K').
  let ctrl = false;
  let alt = false;
  let shift = false;
  let key = '';
  for (const ch of macChord) {
    if (ch === '⌘' || ch === '⌃') ctrl = true;
    else if (ch === '⌥') alt = true;
    else if (ch === '⇧') shift = true;
    else key += ch;
  }
  const winKey = WIN_SYMBOLS[key] ?? key;
  return `${ctrl ? 'Ctrl+' : ''}${alt ? 'Alt+' : ''}${shift ? 'Shift+' : ''}${winKey}`;
}

// ---- Focus-scope helpers (interaction-surface consistency pass) -----------
// Grounded in WAI-ARIA APG "Developing a Keyboard Interface":
//   - Tab/Shift+Tab move focus BETWEEN components (the tab ring);
//   - arrow keys move focus INSIDE composite widgets;
//   - menus/dialogs own Escape while they are open;
//   - single-character shortcuts must not collide with composite-widget
//     keys (menu typeahead) or text entry (WCAG 2.1.4).

/// True when the event target is a surface whose OWN key handling must win:
/// browser-native typing semantics (⌘Z undoes typing, arrows move the caret,
/// Enter inserts a newline, Escape closes a native select popup).
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target) return false;
  const el = target as HTMLElement;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

const COMPOSITE_WIDGET_SELECTOR = [
  'input', 'textarea', 'select',
  '[contenteditable="true"]', '[contenteditable=""]',
  '[role="slider"]', '[role="spinbutton"]', '[role="listbox"]',
  '[role="menu"]', '[role="menubar"]', '[role="tablist"]',
  '[role="combobox"]', '[role="tree"]', '[role="grid"]',
  '[role="option"]', '[role="menuitem"]', '[role="menuitemradio"]',
  '[role="tab"]', '[role="treeitem"]', '[data-radix-collection-item]'
].join(',');

/// True when focus is inside a composite widget (Radix sliders/selects/
/// menus/tabs, the Layers tree, native form controls…). Single-character
/// canvas shortcuts and the arrow-key nudge must NOT fire in this state —
/// the widget consumes those keys (APG: arrows move focus inside
/// composites; letters are menu typeahead), and firing both corrupts both
/// interactions (the "nudge while adjusting a slider" double-fire).
export function inCompositeWidget(target: EventTarget | null): boolean {
  if (!target) return false;
  const el = target as HTMLElement;
  if (typeof el.closest !== 'function') return false;
  try {
    return !!el.closest(COMPOSITE_WIDGET_SELECTOR);
  } catch {
    return false;
  }
}

/// True while a Radix floating layer is open (DropdownMenu / ContextMenu /
/// Popover / Menubar content all portal into `[data-radix-popper-
/// content-wrapper]`). Those layers own Escape (close) and printable keys
/// (typeahead) — window-level handlers must stand down (the old Escape
/// handler only knew Radix *dialogs*, so closing a context menu during a
/// live agent run ALSO stopped the agent).
export function menuLayerOpen(): boolean {
  if (typeof document === 'undefined') return false;
  return !!document.querySelector('[data-radix-popper-content-wrapper]');
}

/// True when DOM focus is on the canvas surface — a shape node, the world
/// layer, or the body fallback ("nothing focused" after clicking the
/// background). In this state the canvas-surface keys may act: Tab/⇧Tab
/// cycle siblings, Enter descends / edits text, Space enables grab-pan.
/// When focus is on ANY chrome control (button, input, menu item, tree
/// row) the CONTROL owns the key instead: Tab moves focus along the tab
/// ring (restores keyboard reachability of the toolbar/panels — was a
/// global Tab hijack = effective keyboard trap), Enter activates the
/// focused button, Space presses it.
export function inCanvasKeyScope(target: EventTarget | null): boolean {
  if (typeof document === 'undefined' || !target) return false;
  // Window-targeted events = "no specific element focused" — the body
  // fallback. Identified by self-reference (target.window === target), which
  // is cross-realm safe: real browsers, the vitest jsdom sandbox (where the
  // module-visible `window` is globalThis while synthetic events dispatch on
  // the REAL jsdom window — two distinct objects), and globalThis itself
  // (globalThis.window === globalThis) all pass.
  const t = target as { window?: unknown };
  if (t.window === target) return true;
  if (target === document || target === document.body || target === document.documentElement) return true;
  const el = target as HTMLElement;
  if (typeof el.closest !== 'function') return false;
  try {
    return !!el.closest('[data-node-type], [data-ac-world], [data-empty-bg="true"]');
  } catch {
    return false;
  }
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
  // `also` aliases: ⌘+ / ⌘− / ⌘0 keep the CANVAS zoom responding to the
  // browser's page-zoom chords (Figma parity — the app owns zoom, the page
  // must not shrink). ⌘= is the unshifted plus on US layouts; ⌘⇧+ is the
  // shifted form (the '+' key physically requires Shift there).
  { action: 'zoom.in', label: 'Zoom in', mac: '⇧+', win: 'Shift++', scope: 'canvas', also: ['⌘⇧+', '⌘='] },
  { action: 'zoom.out', label: 'Zoom out', mac: '⇧−', win: 'Shift+-', scope: 'canvas', also: ['⌘−', '⌘-'] },
  { action: 'zoom.fit', label: 'Zoom to fit', mac: '⇧1', win: 'Shift+1', scope: 'canvas' },
  { action: 'zoom.selection', label: 'Zoom to selection', mac: '⇧2', win: 'Shift+2', scope: 'canvas' },
  { action: 'zoom.100', label: 'Zoom to 100%', mac: '⇧0', win: 'Shift+0', scope: 'canvas', also: ['⌘0'] },

  // --- Hierarchy navigation ---
  { action: 'nav.child', label: 'Select first child (enter container)', mac: 'Enter', win: 'Enter', scope: 'canvas' },
  { action: 'nav.parent', label: 'Select parent', mac: '⇧Enter', win: 'Shift+Enter', scope: 'canvas' },
  { action: 'nav.sibling-next', label: 'Select next sibling', mac: 'Tab', win: 'Tab', scope: 'canvas' },
  { action: 'nav.sibling-prev', label: 'Select previous sibling', mac: '⇧Tab', win: 'Shift+Tab', scope: 'canvas' },

  // --- Z-order (was ad-hoc in page.tsx — now registry-dispatched) ---
  { action: 'bring-forward', label: 'Bring forward', mac: '⌘]', win: 'Ctrl+]', scope: 'canvas' },
  { action: 'bring-to-front', label: 'Bring to front', mac: '⌘⇧]', win: 'Ctrl+Shift+]', scope: 'canvas' },
  { action: 'send-backward', label: 'Send backward', mac: '⌘[', win: 'Ctrl+[', scope: 'canvas' },
  { action: 'send-to-back', label: 'Send to back', mac: '⌘⇧[', win: 'Ctrl+Shift+[', scope: 'canvas' },

  // --- Canvas interaction modifiers (documented, not keymap-dispatched) ---
  { action: 'deep-select', label: 'Deep select — click through the ancestor chain', mac: '⌘+click', win: 'Ctrl+click', scope: 'canvas' },
  { action: 'nested-marquee', label: 'Nested marquee — select descendants of intersecting containers', mac: '⌘+drag', win: 'Ctrl+drag', scope: 'canvas' },
  { action: 'duplicate-drag', label: 'Duplicate by dragging (original reverts)', mac: '⌥+drag', win: 'Alt+drag', scope: 'canvas' },
  { action: 'pan-space-drag', label: 'Hold Space and drag to pan (temporary hand tool)', mac: 'Space+drag', win: 'Space+drag', scope: 'canvas' },
  { action: 'measure-hold', label: 'Hold ⌥ and hover a layer to measure distances', mac: '⌥ (hold)', win: 'Alt (hold)', scope: 'canvas' },
  { action: 'nudge', label: 'Nudge selection — arrows move 1px, ⇧+arrows 10px', mac: 'Arrow keys', win: 'Arrow keys', scope: 'canvas' },
  { action: 'auto-layout.apply', label: 'Apply auto-layout to the selected frame/group', mac: 'A', win: 'A', scope: 'canvas' },
  { action: 'tool.pen', label: 'Pen tool — routes to the chat (path prompts)', mac: 'P', win: 'P', scope: 'canvas' },

  // --- App-level (existing chords, now registry-listed) ---
  { action: 'file.new-session', label: 'New chat / session', mac: '⌘N', win: 'Ctrl+N', scope: 'app' },
  { action: 'file.import', label: 'Open .pen file', mac: '⌘O', win: 'Ctrl+O', scope: 'app' },
  { action: 'file.export', label: 'Export as .pen', mac: '⌘E', win: 'Ctrl+E', scope: 'app' },
  { action: 'zen', label: 'Toggle zen / hide UI', mac: '⌘\\', win: 'Ctrl+\\', scope: 'app' },
  { action: 'palette', label: 'Open command palette', mac: '⌘K', win: 'Ctrl+K', scope: 'app' },
  { action: 'save-checkpoint', label: 'Save a version-history checkpoint', mac: '⌘⌥S', win: 'Ctrl+Alt+S', scope: 'app', also: ['⌘S'] },
  { action: 'chat.scroll-up', label: 'Scroll the chat panel up', mac: '⌘↑', win: 'Ctrl+Up', scope: 'app' },
  { action: 'chat.scroll-down', label: 'Scroll the chat panel down', mac: '⌘↓', win: 'Ctrl+Down', scope: 'app' },
  { action: 'undo', label: 'Undo', mac: '⌘Z', win: 'Ctrl+Z', scope: 'app' },
  { action: 'redo', label: 'Redo', mac: '⌘⇧Z', win: 'Ctrl+Shift+Z', scope: 'app' },
  { action: 'copy', label: 'Copy selection', mac: '⌘C', win: 'Ctrl+C', scope: 'app' },
  { action: 'cut', label: 'Cut selection', mac: '⌘X', win: 'Ctrl+X', scope: 'app' },
  { action: 'paste', label: 'Paste (with +24 offset)', mac: '⌘V', win: 'Ctrl+V', scope: 'app' },
  { action: 'paste-in-place', label: 'Paste in place', mac: '⌘⇧V', win: 'Ctrl+Shift+V', scope: 'app' },
  { action: 'select-all', label: 'Select all layers', mac: '⌘A', win: 'Ctrl+A', scope: 'app' },
  { action: 'shortcuts-dialog', label: 'Open the keyboard shortcuts cheat sheet', mac: '⌘/', win: 'Ctrl+/', scope: 'app' },
  { action: 'toggle-left-panel', label: 'Toggle left panel', mac: '⌘⇧1', win: 'Ctrl+Shift+1', scope: 'app', also: ['⌘1'] },
  { action: 'toggle-right-panel', label: 'Toggle right panel', mac: '⌘⇧2', win: 'Ctrl+Shift+2', scope: 'app', also: ['⌘2'] },
  // --- Sidebar tab selection (Appendix H §H.3 deviation #1) ---
  // Figma's ⌥1/⌥2/⌥3 select the Layers/Assets/Templates tabs INSIDE the
  // left sidebar. Our top-level panel toggles stay ⌘⇧1/⌘⇧2 (legacy muscle
  // memory); these chords switch the LayersPanel's internal Tabs (the
  // Layers tree ↔ the Assets component grid).
  { action: 'panel.layers-tab', label: 'Switch left sidebar to Layers tab', mac: '⌥1', win: 'Alt+1', scope: 'app' },
  { action: 'panel.assets-tab', label: 'Switch left sidebar to Assets tab', mac: '⌥2', win: 'Alt+2', scope: 'app' },
  { action: 'delete', label: 'Delete selection', mac: '⌫', win: 'Del / Backspace', scope: 'canvas' },
];

// NOTE (registry contract): pointer/arrow-gesture entries (deep-select,
// nested-marquee, duplicate-drag, pan-space-drag, nudge, measure-hold) are
// documented like Figma's cheat sheet documents gestures — they are not
// keymap-dispatched, they exist so the help surface and reality stay in
// sync.

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
