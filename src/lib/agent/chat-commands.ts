// chat-commands.ts — slash-command registry for the agent chat input.
//
// Typing '/' in the chat opens an autocomplete of quick actions: canvas
// utilities (clear/undo/redo/export), app actions (new chat), and prompt
// shortcuts (pre-written agent prompts). The Lovable/Slack pattern — zero
// mouse travel for common operations.
//
// Pure data + match logic; the AgentPanel owns execution.

export interface ChatCommand {
  /// What the user types: '/clear'
  cmd: string;
  /// Shown in the autocomplete list.
  label: string;
  /// Short explanation shown next to the label.
  hint: string;
  /// Execution kind:
  ///   'action' — run a named client-side action (handled by the panel)
  ///   'prompt' — send the text after the command to the agent
  kind: 'action' | 'prompt';
  /// For 'action': the action id the panel dispatches.
  /// For 'prompt': the prompt template ('{args}' replaced with user args).
  run: string;
  /// Supports trailing free-text arguments?
  args?: boolean;
}

export const CHAT_COMMANDS: ChatCommand[] = [
  // --- Design system (client-side, instant) ---
  // e.g. `/pick-pack geist` — fuzzy-resolves to vercel-geist and pins it
  // for all subsequent agent generations this session.
  { cmd: '/pick-pack', label: '/pick-pack', hint: 'Pin a design-system pack (e.g. /pick-pack geist)', kind: 'action', run: 'pick-pack', args: true },
  // --- Canvas utilities (client-side, instant) ---
  { cmd: '/clear', label: '/clear', hint: 'Erase the canvas (undoable)', kind: 'action', run: 'clear' },
  { cmd: '/undo', label: '/undo', hint: 'Undo the last canvas change', kind: 'action', run: 'undo' },
  { cmd: '/redo', label: '/redo', hint: 'Redo the last undone change', kind: 'action', run: 'redo' },
  { cmd: '/new', label: '/new', hint: 'Start a new chat session', kind: 'action', run: 'new-chat' },
  { cmd: '/select-all', label: '/select-all', hint: 'Select every layer', kind: 'action', run: 'select-all' },
  // --- Exports (client-side, instant) ---
  { cmd: '/export-svg', label: '/export-svg', hint: 'Download the canvas as SVG', kind: 'action', run: 'export-svg' },
  { cmd: '/export-png', label: '/export-png', hint: 'Download the canvas as PNG (2x)', kind: 'action', run: 'export-png' },
  { cmd: '/export-json', label: '/export-json', hint: 'Download the .pen document as JSON', kind: 'action', run: 'export-json' },
  // --- Prompt shortcuts (sent to the agent) ---
  { cmd: '/audit', label: '/audit', hint: 'Ask the agent to audit the design', kind: 'prompt', run: 'Audit my design for color contrast, alignment, spacing, and consistency issues, then fix the blockers.', args: true },
  { cmd: '/dark', label: '/dark', hint: 'Ask the agent for a dark-mode variant', kind: 'prompt', run: 'Create a polished dark-mode variant of the current design. Keep the layout identical, remap colors to a dark palette, and place it to the right of the original.', args: true },
  { cmd: '/icons', label: '/icons', hint: 'Ask the agent to add lucide icons', kind: 'prompt', run: 'Add appropriate lucide icons to navigation items, buttons, and status indicators across the design.', args: true },
  { cmd: '/copy', label: '/copy', hint: 'Ask the agent to write realistic copy', kind: 'prompt', run: 'Replace every placeholder text with realistic, domain-appropriate copy.', args: true },
  { cmd: '/organize', label: '/organize', hint: 'Ask the agent to organize layers', kind: 'prompt', run: 'Organize the layers: group related layers, rename them clearly, and tidy the z-order.', args: true },
];

/// Filter commands by the current input token. Returns matching commands
/// sorted by prefix-match quality. Empty input starting with '/' returns all.
export function matchCommands(input: string): ChatCommand[] {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return [];
  if (trimmed.includes(' ')) return []; // typing args — hide the list
  const q = trimmed.slice(1).toLowerCase();
  const all = CHAT_COMMANDS;
  if (!q) return all;
  const starts = all.filter((c) => c.cmd.slice(1).startsWith(q));
  const contains = all.filter((c) => !c.cmd.slice(1).startsWith(q) && c.cmd.slice(1).includes(q));
  return [...starts, ...contains];
}

/// Max commands rendered in the autocomplete menu at once.
export const COMMAND_MENU_LIMIT = 8;

// ---- pick-pack resolution --------------------------------------------------

/// Minimal shape needed to resolve a pack argument. `PackSummary` from
/// `@/lib/design-systems/types` satisfies this structurally.
export interface PackRef {
  name: string;
  description?: string;
}

/// Resolve a free-text `/pick-pack` argument to a registry pack name.
/// Pure + synchronous so it is trivially testable and runs identically
/// on the client (the panel passes the pack list from useDesignSystems).
///
/// Match order (first hit wins, case-insensitive):
///   1. exact name            ('vercel-geist')
///   2. name endsWith arg     ('geist'  → vercel-geist)
///   3. name includes arg     ('radix'  → radix-themes)
///   4. fuzzy: arg matches ANY of the name's dash-words or the pack's
///      human label synonyms ('catalyst' → tailwind-catalyst)
///
/// Returns null when nothing matches or the arg is empty.
export function resolvePackName(arg: string, packs: PackRef[]): string | null {
  const q = arg.trim().toLowerCase();
  if (!q) return null;

  // 1. exact
  const exact = packs.find((p) => p.name.toLowerCase() === q);
  if (exact) return exact.name;

  // 2. endsWith — the natural shortcut: 'geist' → 'vercel-geist'
  const ends = packs.find((p) => p.name.toLowerCase().endsWith(q));
  if (ends) return ends.name;

  // 3. includes — 'radix' → 'radix-themes', 'catalyst' → 'tailwind-catalyst'
  const incl = packs.find((p) => p.name.toLowerCase().includes(q));
  if (incl) return incl.name;

  // 4. synonym words — 'tailwind' → tailwind-catalyst, 'shadcn' → shadcn-default
  const words = (p: PackRef) => p.name.toLowerCase().split('-');
  const syn = packs.find((p) => words(p).some((w) => w === q || (q.length >= 3 && w.startsWith(q))));
  if (syn) return syn.name;

  return null;
}

/// Resolve input + selected command into an execution plan.
/// Returns null when input isn't a command.
export function resolveCommand(input: string, selected: ChatCommand): { command: ChatCommand; args: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;
  // The input may be a prefix of the selected command (autocomplete), or the
  // full command plus arguments.
  const rest = trimmed.startsWith(selected.cmd) ? trimmed.slice(selected.cmd.length) : '';
  const args = rest.replace(/^\s+/, '');
  return { command: selected, args };
}

/// Parse raw input into a command execution decision. This is the single
/// source of truth for submit-time command resolution — the UI must NOT
/// re-derive it (previous inline logic rejected fully-typed commands with
/// arguments, e.g. `/audit focus on contrast`, because matchCommands hides
/// once a space is present).
///
///   'hello'                       → { kind: 'none' }     (plain prompt)
///   '/'                           → { kind: 'bare' }     (menu open, nothing to run)
///   '/clear'                      → { kind: 'exact', args: '' }
///   '/audit fix contrast'         → { kind: 'exact', args: 'fix contrast' }
///   '/cl'                         → { kind: 'candidates', commands: [/clear] }
///   '/nope'                       → { kind: 'unknown' }
export type ParsedCommandInput =
  | { kind: 'none' }
  | { kind: 'bare' }
  | { kind: 'unknown' }
  | { kind: 'exact'; command: ChatCommand; args: string }
  | { kind: 'candidates'; commands: ChatCommand[] };

export function parseCommandInput(input: string): ParsedCommandInput {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return { kind: 'none' };
  if (trimmed === '/') return { kind: 'bare' };
  const firstToken = trimmed.split(/\s+/)[0];
  // Fully-typed command (with or without arguments) wins over autocomplete.
  const exact = CHAT_COMMANDS.find((c) => c.cmd === firstToken);
  if (exact) {
    return { kind: 'exact', command: exact, args: trimmed.slice(firstToken.length).trim() };
  }
  const candidates = matchCommands(trimmed);
  if (candidates.length > 0) return { kind: 'candidates', commands: candidates };
  return { kind: 'unknown' };
}
