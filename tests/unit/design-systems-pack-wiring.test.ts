// Tests for the design-system pack → system-prompt wiring.
//
// Verifies:
// 1. `buildSystemPrompt()` with no `packName` produces no design-system
//    section (backward-compat with the existing test suite + legacy callers).
// 2. `buildSystemPrompt()` with a `packName` appends the pack-specific
//    section, including the human label + the canonical CSS variable list.
// 3. The pack section enforces the iron rule: never hardcode hex / px / font
//    when a `var(--*)` exists.
// 4. Unknown pack names still produce a section (uses the raw name as the
//    human label, tagline empty — non-fatal).

import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, SYSTEM_PROMPT_TEMPLATE } from '@/lib/agent/runner-legacy';
import type { CanvasDocument } from '@/lib/canvas/types';

function emptyCanvas(): CanvasDocument {
  return {
    id: 'test',
    name: 'Test',
    version: '2.17',
    children: [],
    variables: undefined,
    themes: undefined,
    background: '#ffffff',
    viewport: { zoom: 1, panX: 0, panY: 0 },
    shapes: [],
    tokens: { colors: [], textStyles: [] },
  };
}

describe('buildSystemPrompt — design-system pack wiring', () => {
  describe('without a pack (legacy behavior)', () => {
    const prompt = buildSystemPrompt(
      '(skill metadata)',
      '(skill body)',
      '',
      emptyCanvas(),
      'slate',
      false,
    );

    it('does not include the design-system pack section', () => {
      expect(prompt).not.toContain('DESIGN-SYSTEM PACK');
      expect(prompt).not.toContain('user-pinned');
    });

    it('still includes the existing template content', () => {
      // The canvas snapshot footer is appended after the template.
      expect(prompt).toContain('(skill metadata)');
      expect(prompt).toContain('(skill body)');
    });
  });

  describe('with packName="shadcn-default"', () => {
    const prompt = buildSystemPrompt(
      '',
      '',
      '',
      emptyCanvas(),
      'slate',
      false,
      'shadcn-default',
    );

    it('appends a "DESIGN-SYSTEM PACK" section', () => {
      expect(prompt).toContain('DESIGN-SYSTEM PACK');
      expect(prompt).toContain('user-pinned');
    });

    it('uses the human-readable pack label (shadcn/ui)', () => {
      expect(prompt).toContain('"shadcn/ui" design-system pack');
    });

    it('lists the semantic color CSS variables the agent should use', () => {
      expect(prompt).toContain('var(--color-bg)');
      expect(prompt).toContain('var(--color-accent)');
      expect(prompt).toContain('var(--color-text-primary)');
      expect(prompt).toContain('var(--color-border-default)');
    });

    it('lists the radius / spacing / typography variables', () => {
      // The radius list enumerates the named component radii (button / card / input / pill).
      expect(prompt).toContain('var(--radius-card)');
      // Spacing uses range notation — `var(--space-0) … var(--space-20)`.
      expect(prompt).toContain('var(--space-0)');
      expect(prompt).toContain('var(--space-20)');
      // Fonts + type scale enumerated by name.
      expect(prompt).toContain('var(--font-sans)');
      expect(prompt).toContain('var(--text-sm)');
    });

    it('lists the component-scoped variables (button / input)', () => {
      expect(prompt).toContain('var(--button-bg-primary)');
      expect(prompt).toContain('var(--input-bg)');
    });

    it('includes the iron rule telling the agent not to hardcode hex', () => {
      expect(prompt).toContain('NEVER hardcode a hex color');
      expect(prompt).toContain('var(--color-*)');
    });

    it('tells the agent the pack tokens.css is already injected', () => {
      expect(prompt).toContain('ALREADY INJECTED');
      expect(prompt).toContain('tokens.css');
    });
  });

  describe('with packName="vercel-geist"', () => {
    const prompt = buildSystemPrompt('', '', '', emptyCanvas(), 'mono', false, 'vercel-geist');

    it('uses the human label "Vercel Geist"', () => {
      expect(prompt).toContain('"Vercel Geist" design-system pack');
    });

    it('includes the strict monochrome / zero-radius tagline', () => {
      expect(prompt).toContain('monochrome');
      expect(prompt).toContain('zero rounded corners');
    });
  });

  describe('with packName="mantine-default"', () => {
    const prompt = buildSystemPrompt('', '', '', emptyCanvas(), 'slate', false, 'mantine-default');

    it('uses the human label "Mantine"', () => {
      expect(prompt).toContain('"Mantine" design-system pack');
    });
  });

  describe('with packName="radix-themes"', () => {
    const prompt = buildSystemPrompt('', '', '', emptyCanvas(), 'slate', false, 'radix-themes');

    it('uses the human label "Radix Themes"', () => {
      expect(prompt).toContain('"Radix Themes" design-system pack');
    });

    it('includes the cool-gray / soft tinted panels tagline', () => {
      expect(prompt).toContain('cool gray');
      expect(prompt).toContain('soft tinted');
    });

    it('tells the agent to prefer tinted accent surfaces over heavy shadows', () => {
      expect(prompt).toContain('var(--color-accent-muted)');
    });
  });

  describe('with packName="tailwind-catalyst"', () => {
    const prompt = buildSystemPrompt('', '', '', emptyCanvas(), 'slate', false, 'tailwind-catalyst');

    it('uses the human label "Tailwind Catalyst"', () => {
      expect(prompt).toContain('"Tailwind Catalyst" design-system pack');
    });

    it('overrides the primary-button rule: ink-black, not accent-colored', () => {
      expect(prompt).toContain('INK-BLACK');
      expect(prompt).toContain('zinc-950');
    });

    it('keeps indigo scoped to links / focus rings / selected states', () => {
      expect(prompt).toContain('focus rings');
    });
  });

  describe('with an unknown packName', () => {
    const prompt = buildSystemPrompt('', '', '', emptyCanvas(), 'slate', false, 'radix-tailwind');

    it('falls back to the raw pack name as the human label', () => {
      expect(prompt).toContain('"radix-tailwind" design-system pack');
    });

    it('still includes the canonical CSS variable list', () => {
      // Same list as for known packs — we have no special tagline but
      // the variable enumeration is pack-agnostic.
      expect(prompt).toContain('var(--color-accent)');
      expect(prompt).toContain('var(--button-bg-primary)');
    });
  });

  describe('AgentRunSettings type', () => {
    it('exposes a `pack` field', async () => {
      // Import the type via the settings module — the field's presence
      // is what we're verifying; runtime value is just `undefined`.
      const mod = await import('@/lib/settings/types');
      expect(typeof mod).toBe('object');
      // Compile-time check: this assignment must typecheck (we'd get a
      // tsc error before this test ever ran if `pack` wasn't declared).
      const s: import('@/lib/settings/types').AgentRunSettings = {
        temperature: 0.4,
        maxIterations: 20,
        planFirst: true,
        thinkingLevel: 'high',
        defaultPalette: 'slate',
        approvalMode: 'destructive',
        alwaysAllowTools: [],
        skillSelectionMode: 'auto',
        llmProvider: 'zai',
        apiKey: '',
        modelName: '',
        apiBaseUrl: '',
        pack: 'shadcn-default',
      };
      expect(s.pack).toBe('shadcn-default');
    });
  });
});

// Suppress the unused-import warning for SYSTEM_PROMPT_TEMPLATE — we
// keep it imported to verify the template is exported (the runner
// re-exports it via the public entry point).
void SYSTEM_PROMPT_TEMPLATE;
