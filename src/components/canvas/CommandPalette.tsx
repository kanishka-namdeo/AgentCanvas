'use client';

// ⌘K Command Palette — fuzzy-searchable launcher for preset agent prompts.
//
// Replaces the always-visible "6 prompt-group chips + 4 prompt buttons"
// block that previously dominated the AgentPanel's empty state. Now there's
// a single "Ask anything…" trigger that opens this palette; the user types
// a query and matches filter in real time. Selecting a prompt fires
// `promptAgent` and closes the palette.
//
// Keyboard:
//   ⌘K / Ctrl+K  open
//   Esc          close
//   ↑↓           navigate
//   Enter        run selected prompt
//
// Implementation:
//   - Built on `cmdk` (already a dependency, wrapped by @/components/ui/command).
//   - Prompt catalog is mirrored from AgentPanel.tsx's PROMPT_GROUPS so the
//     palette and the chat empty state stay in sync. If the user prefers the
//     old visible-list UX, they can still use the AgentPanel's preset chips.
//   - Custom prompt: if the user types something that doesn't match any
//     preset and hits Enter, we send it as a free-form prompt.

import { useState, useRef } from 'react';
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
  CornerDownLeft, Search,
} from 'lucide-react';

interface PromptGroup {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  prompts: string[];
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
  open, onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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

  // Custom prompt: if the query doesn't match any preset, treat Enter as
  // "send this as a free-form prompt". cmdk handles the Enter key, so we
  // expose a synthetic CommandItem at the top of the list when query is
  // non-empty and not an exact match for any preset.
  const trimmed = query.trim();
  const hasExactMatch = FLAT_PROMPTS.some((p) => p.prompt.toLowerCase() === trimmed.toLowerCase());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="p-0 overflow-hidden max-w-xl gap-0" showCloseButton={false}>
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">
          Search preset prompts or send a custom prompt to the agent.
        </DialogDescription>
        <Command shouldFilter={true} loop>
          <div className="flex items-center gap-2 px-3 border-b ac-border-subtle">
            <Search className="h-3.5 w-3.5 ac-text-4 flex-shrink-0" />
            <CommandInput
              placeholder="Ask the agent to design something…  (Esc to close)"
              value={query}
              onValueChange={setQuery}
              className="h-11 text-[13px] flex-1"
            />
            <kbd className="text-[10px] ac-text-4 px-1.5 py-0.5 rounded border ac-border-default ac-surface-1 font-mono flex-shrink-0">
              ↵
            </kbd>
          </div>
          <CommandList className="max-h-[400px] overflow-y-auto ac-hide-scrollbar">
            <CommandEmpty>
              <div className="px-3 py-6 text-center text-[12px] ac-text-3">
                {trimmed ? (
                  <button
                    onClick={() => runPrompt(trimmed)}
                    className="w-full text-left px-2 py-1.5 rounded hover:ac-surface-1 ac-transition ac-focus-ring"
                  >
                    Send <span className="ac-text-1 font-medium">&ldquo;{trimmed}&rdquo;</span> as a custom prompt
                    <span className="block text-[10px] ac-text-4 mt-0.5">
                      Click or press <kbd className="px-1 py-0.5 rounded ac-surface-2 font-mono">↵</kbd> to send
                    </span>
                  </button>
                ) : (
                  'Start typing to search prompts…'
                )}
              </div>
            </CommandEmpty>

            {/* Free-form prompt (only when there's a query and no exact preset match) */}
            {trimmed && !hasExactMatch && !agentBusy && (
              <CommandGroup heading="Custom prompt">
                <CommandItem
                  value={`${trimmed} — custom`}
                  onSelect={() => runPrompt(trimmed)}
                  className="gap-2 px-3 py-2 cursor-pointer"
                >
                  <CornerDownLeft className="h-3 w-3 ac-text-4 flex-shrink-0" />
                  <span className="text-[12px] ac-text-2 flex-1 truncate">
                    Send <span className="ac-text-1 font-medium">&ldquo;{trimmed}&rdquo;</span>
                  </span>
                  <span className="text-[10px] ac-text-4">custom</span>
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
                  heading={group.label}
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
