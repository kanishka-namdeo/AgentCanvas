'use client';

// ⌘K Command Palette — commands + preset prompts in one launcher
// (UI-audit round 2).
//
// Round 1 made this a PROMPT-ONLY palette: typing "zoom" yielded just
// "Send 'zoom' custom". The round-2 audit found that meant the palette
// could NOT absorb any of the menubar's duties — every Figma-class tool
// puts commands in ⌘K. Now the palette layers THREE result kinds:
//
//   1. COMMANDS (File / Edit / View / Insert / Object / Panels / Help) —
//      supplied by page.tsx (which owns all the callbacks + refs), executed
//      on Enter, shortcut hints shown from the live registry.
//   2. PRESET PROMPTS — the scenario catalog (unchanged), sent directly.
//   3. FREE-FORM TEXT — routed into the chat composer (prefill + focus)
//      instead of direct-send: the composer is the richer surface
//      (attachments, @mentions, /commands), so the user reviews before
//      sending. This also fixed the round-1 duplication where the palette
//      and the composer were two parallel text-entry surfaces that both
//      fired `promptAgent`.
//
// Keyboard: ⌘K open · Esc close · ↑↓ navigate · Enter run.

import { useState, useRef, type ComponentType } from 'react';
import { useCanvasStore } from '@/lib/canvas/store';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Dialog, DialogContent, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import {
  Smartphone, GitBranch, LayoutDashboard, Palette, Activity, Layers,
  CornerDownLeft, Search, Terminal,
} from 'lucide-react';

interface PromptGroup {
  id: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  prompts: string[];
}

/// One executable app command. `run` is a no-args closure built in
/// page.tsx where every callback/ref lives.
export interface PaletteCommand {
  id: string;
  label: string;
  group: string;
  icon?: ComponentType<{ className?: string }>;
  shortcut?: string;
  keywords?: string;
  danger?: boolean;
  run: () => void;
}

// Mirrors PROMPT_GROUPS in AgentPanel.tsx. Kept here so the palette is
// self-contained (no cross-file imports that would re-render the chat).
const PROMPT_GROUPS: PromptGroup[] = [
  {
    id: 'designs',
    label: 'Designs',
    icon: Smartphone,
    prompts: [
      'Design a high-fidelity mobile login screen with logo, email/password fields, and a sign-in button.',
      'Build a modern mobile dashboard with stat cards, a chart, shadows, and a tab bar.',
      'Make a polished web landing page with a gradient hero, features section, and CTA.',
      'Design a web pricing page with three tiers, the middle one featured, with shadows and real content.',
    ],
  },
  {
    id: 'flows',
    label: 'User Flows',
    icon: GitBranch,
    prompts: [
      'Generate a 3-step onboarding user flow (welcome → permissions → done).',
      'Create an ecommerce flow: browse → product → cart → checkout.',
      'Design a signup funnel: landing → signup → verify → dashboard.',
    ],
  },
  {
    id: 'diagrams',
    label: 'Diagrams',
    icon: LayoutDashboard,
    prompts: [
      'Draw a flowchart with these steps: Idea, Research, Design, Build, Ship.',
      'Make a mindmap with "Product Strategy" at the center and 5 branches: Users, Market, Tech, Revenue, Risks.',
    ],
  },
  {
    id: 'design-systems',
    label: 'Design Systems',
    icon: Palette,
    prompts: [
      'Generate a triadic palette from #0ea5e9 and apply it to all shapes.',
      'Create a monochromatic palette from #16a34a, save it as tokens, and apply to existing shapes.',
      'Audit my design for consistency issues and report findings.',
    ],
  },
  {
    id: 'analysis',
    label: 'Analysis',
    icon: Activity,
    prompts: [
      'Fill every text shape with realistic placeholder copy about "project management".',
      'Audit my design for color contrast and alignment issues, then report findings.',
      'Organize my layers — rename and re-order them by reading order.',
    ],
  },
  {
    id: 'layers',
    label: 'Layers & Layout',
    icon: Layers,
    prompts: [
      'Align all selected shapes to the left.',
      'Distribute these shapes evenly horizontally.',
      'Group all the stat cards into one group.',
      'Apply horizontal Auto Layout with 8px gap to the selected frame.',
    ],
  },
];

// Flatten the catalog for ⌘K — each item knows its group for display.
type FlatPrompt = { prompt: string; groupLabel: string; groupId: string };
const FLAT_PROMPTS: FlatPrompt[] = PROMPT_GROUPS.flatMap((g) =>
  g.prompts.map((p) => ({ prompt: p, groupLabel: g.label, groupId: g.id })),
);

export function CommandPalette({
  open,
  onOpenChange,
  commands = [],
  onRouteToComposer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /// App commands (page.tsx owns the callbacks). Empty = prompt-only mode.
  commands?: PaletteCommand[];
  /// Free-form text hand-off — page.tsx wires it to the composer prefill
  /// event. Falls back to direct-send when omitted.
  onRouteToComposer?: (text: string) => void;
}) {
  const promptAgent = useCanvasStore((s) => s.promptAgent);
  const agentBusy = useCanvasStore((s) => s.agentBusy);
  const [query, setQuery] = useState('');

  // Reset the query every time the palette opens so the user starts fresh.
  // Using a ref-comparison pattern (React team's recommended approach for
  // "adjust state when a prop changes" — see react.dev/learn/you-might-not-need-an-effect).
  const previousOpen = useRef(open);
  // eslint-disable-next-line react-hooks/refs
  if (previousOpen.current !== open) {
    // eslint-disable-next-line react-hooks/refs
    previousOpen.current = open;
    if (open) setQuery('');
  }

  const runPrompt = (text: string) => {
    if (!text.trim() || agentBusy) return;
    promptAgent(text.trim());
    onOpenChange(false);
  };

  const routeToComposer = (text: string) => {
    if (!text.trim()) return;
    if (onRouteToComposer) onRouteToComposer(text.trim());
    else runPrompt(text);
    onOpenChange(false);
  };

  // Custom prompt: if the query doesn't match any preset, treat Enter as
  // "hand this text to the composer". cmdk handles the Enter key, so we
  // expose a synthetic CommandItem at the top of the list when query is
  // non-empty and not an exact match for any preset.
  const trimmed = query.trim();
  const hasExactMatch = FLAT_PROMPTS.some((p) => p.prompt.toLowerCase() === trimmed.toLowerCase());

  // Commands grouped by their `group` field, filtered by the query (cmdk
  // filters CommandItems natively via value; we pre-filter groups so empty
  // groups don't render headings).
  const commandGroups = commands.length
    ? [...new Set(commands.map((c) => c.group))].map((group) => ({
        group,
        items: commands.filter((c) => c.group === group),
      }))
    : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="p-0 overflow-hidden max-w-xl gap-0" showCloseButton={false}>
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">
          Search commands and preset prompts, or draft a prompt for the agent.
        </DialogDescription>
        <Command shouldFilter={true} loop>
          <div className="flex items-center gap-2 px-3 border-b ac-border-subtle">
            <Search className="h-3.5 w-3.5 ac-text-4 flex-shrink-0" />
            <CommandInput
              placeholder="Search commands, or ask the agent to design something…  (Esc to close)"
              value={query}
              onValueChange={setQuery}
              className="h-11 text-[13px] flex-1"
            />
            <kbd className="text-[10px] ac-text-4 px-1.5 py-0.5 rounded border ac-border-default ac-surface-1 font-mono flex-shrink-0">
              ↵
            </kbd>
          </div>
          <CommandList className="max-h-[420px] overflow-y-auto ac-hide-scrollbar">
            <CommandEmpty>
              <div className="px-3 py-6 text-center text-[12px] ac-text-3">
                {trimmed ? (
                  <button
                    onClick={() => routeToComposer(trimmed)}
                    className="w-full text-left px-2 py-1.5 rounded hover:ac-surface-1 ac-transition ac-focus-ring"
                  >
                    Draft <span className="ac-text-1 font-medium">&ldquo;{trimmed}&rdquo;</span> in the chat composer
                    <span className="block text-[10px] ac-text-4 mt-0.5">
                      Click or press <kbd className="px-1 py-0.5 rounded ac-surface-2 font-mono">↵</kbd> — review, attach, then send
                    </span>
                  </button>
                ) : (
                  'Start typing to search commands and prompts…'
                )}
              </div>
            </CommandEmpty>

            {/* App commands — layered ABOVE prompts (Figma ⌘K is command-first) */}
            {commandGroups.map(({ group, items }) => (
              <CommandGroup
                key={group}
                heading={group}
                className="text-[10px] ac-text-4 uppercase tracking-wide font-medium"
              >
                {items.map((c) => {
                  const Icon = c.icon ?? Terminal;
                  return (
                    <CommandItem
                      key={c.id}
                      value={`${c.label} ${c.keywords ?? ''} ${c.group}`}
                      onSelect={() => {
                        onOpenChange(false);
                        c.run();
                      }}
                      className={`gap-2 px-3 py-2 cursor-pointer ${c.danger ? 'ac-text-danger' : ''}`}
                    >
                      <Icon className="h-3 w-3 ac-text-3 flex-shrink-0" />
                      <span className={`text-[12px] flex-1 truncate ${c.danger ? '' : 'ac-text-1'}`}>{c.label}</span>
                      {c.shortcut && (
                        <span className="text-[10px] ac-text-4 font-mono flex-shrink-0">{c.shortcut}</span>
                      )}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}

            {/* Free-form hand-off (only when there's a query and no exact
                preset match). Rendered AFTER the command groups so matching
                commands outrank the fallback (UI-audit round 2 verification:
                typing "re" selected the draft option over "Insert rectangle"). */}
            {trimmed && !hasExactMatch && (
              <CommandGroup heading="Custom prompt">
                <CommandItem
                  value={`${trimmed} — custom`}
                  onSelect={() => routeToComposer(trimmed)}
                  className="gap-2 px-3 py-2 cursor-pointer"
                >
                  <CornerDownLeft className="h-3 w-3 ac-text-4 flex-shrink-0" />
                  <span className="text-[12px] ac-text-2 flex-1 truncate">
                    Draft <span className="ac-text-1 font-medium">&ldquo;{trimmed}&rdquo;</span>
                  </span>
                  <span className="text-[10px] ac-text-4">in composer</span>
                </CommandItem>
              </CommandGroup>
            )}

            {PROMPT_GROUPS.map((group) => {
              const Icon = group.icon;
              const filtered = group.prompts.filter((p) =>
                p.toLowerCase().includes(trimmed.toLowerCase()),
              );
              if (filtered.length === 0) return null;
              return (
                <CommandGroup
                  key={group.id}
                  heading={`Prompt · ${group.label}`}
                  className="text-[10px] ac-text-4 uppercase tracking-wide font-medium"
                >
                  {filtered.map((prompt) => (
                    <CommandItem
                      key={prompt}
                      value={prompt}
                      onSelect={() => runPrompt(prompt)}
                      disabled={agentBusy}
                      className="gap-2 px-3 py-2 cursor-pointer aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
                    >
                      <Icon className="h-3 w-3 ac-text-3 flex-shrink-0" />
                      <span className="text-[12px] ac-text-1 flex-1 line-clamp-2 leading-snug">
                        {prompt}
                      </span>
                      <CornerDownLeft className="h-3 w-3 ac-text-4 flex-shrink-0 opacity-0 group-aria-selected:opacity-100" />
                    </CommandItem>
                  ))}
                </CommandGroup>
              );
            })}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
