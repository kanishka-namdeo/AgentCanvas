// Tests for `buildDesignSystemQuestion()` — the helper that builds
// the `ask_user_question` spec for picking a design-system pack.
//
// We mock `listPacks` so the test doesn't hit the filesystem.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the loader BEFORE importing the helper.
vi.mock('@/lib/design-systems/loader', () => ({
  listPacks: vi.fn(),
}));

import { listPacks } from '@/lib/design-systems/loader';
import { buildDesignSystemQuestion } from '@/lib/design-systems/agent-helper';
import type { PackSummary } from '@/lib/design-systems/types';

const mockPacks: PackSummary[] = [
  {
    name: 'shadcn-default',
    version: '1.0.0',
    description: 'Indigo, neutral, editorial. v0 defaults.',
    palette: { primary: '#1e3a5f', background: '#fafafa', accent: '#3b82f6', text: '#0a0a0a' },
    fontStack: { body: 'Inter', heading: 'Inter', mono: 'JetBrains Mono' },
    bestFor: ['nextjs', 'fullstack', 'dashboard'],
    isDefault: true,
  },
  {
    name: 'vercel-geist',
    version: '1.0.0',
    description: 'Black, white, ultra-minimalist. Strict monochrome.',
    palette: { primary: '#000000', background: '#ffffff', accent: '#0070f3', text: '#111111' },
    fontStack: { body: 'Geist Sans', heading: 'Geist Sans', mono: 'Geist Mono' },
    bestFor: ['minimal', 'brand', 'nextjs'],
    isDefault: false,
  },
  {
    name: 'mantine-default',
    version: '1.0.0',
    description: 'Warm gray, dense, feature-rich. Enterprise dashboards.',
    palette: { primary: '#1a1b1e', background: '#fafafa', accent: '#228be6', text: '#1a1b1e' },
    fontStack: { body: 'Inter', heading: 'Inter', mono: 'JetBrains Mono' },
    bestFor: ['enterprise', 'dashboard', 'fullstack'],
    isDefault: false,
  },
  {
    name: 'radix-themes',
    version: '1.0.0',
    description: 'Indigo accent on cool gray, soft tinted panels.',
    palette: { primary: '#3e63dd', background: '#fcfcfd', accent: '#3e63dd', text: '#2a2e37' },
    fontStack: { body: 'Inter', heading: 'Inter', mono: 'Roboto Mono' },
    bestFor: ['nextjs', 'fullstack', 'saas'],
    isDefault: false,
  },
  {
    name: 'tailwind-catalyst',
    version: '1.0.0',
    description: 'Zinc neutrals, ink-black buttons, 8px radii.',
    palette: { primary: '#09090b', background: '#fafafa', accent: '#4f46e5', text: '#09090b' },
    fontStack: { body: 'Inter', heading: 'Inter', mono: 'ui-monospace' },
    bestFor: ['fullstack', 'saas', 'minimal'],
    isDefault: false,
  },
];

describe('buildDesignSystemQuestion', () => {
  beforeEach(() => {
    vi.mocked(listPacks).mockResolvedValue(mockPacks);
  });

  it('returns a single question with one option per pack', async () => {
    const q = await buildDesignSystemQuestion();
    expect(q.options).toHaveLength(mockPacks.length);
    expect(q.multiSelect).toBe(false);
    expect(q.header).toBe('Design system');
    expect(q.question.length).toBeGreaterThan(0);
  });

  it('marks the default pack with "(Recommended)" suffix', async () => {
    const q = await buildDesignSystemQuestion();
    const defaultOption = q.options.find((o) => o.label.includes('(Recommended)'));
    expect(defaultOption).toBeDefined();
    expect(defaultOption!.label).toContain('shadcn/ui');
  });

  it('humanifies pack names (shadcn-default → shadcn/ui)', async () => {
    const q = await buildDesignSystemQuestion();
    const labels = q.options.map((o) => o.label);
    expect(labels.some((l) => l.includes('shadcn/ui'))).toBe(true);
    expect(labels.some((l) => l.includes('Vercel Geist'))).toBe(true);
    expect(labels.some((l) => l.includes('Mantine'))).toBe(true);
    expect(labels.some((l) => l.includes('Radix Themes'))).toBe(true);
    expect(labels.some((l) => l.includes('Tailwind Catalyst'))).toBe(true);
  });

  it('includes palette hint and best-for tags in each option description', async () => {
    const q = await buildDesignSystemQuestion();
    const shadOption = q.options.find((o) => o.label.includes('shadcn/ui'));
    expect(shadOption).toBeDefined();
    expect(shadOption!.description).toContain('#1e3a5f');
    expect(shadOption!.description).toContain('#3b82f6');
    expect(shadOption!.description).toContain('nextjs');
  });

  it('puts the default pack first (per ask-user-question guideline)', async () => {
    const q = await buildDesignSystemQuestion();
    expect(q.options[0].label).toContain('(Recommended)');
  });

  it('returns at least 2 options (ask_user_question requires ≥2)', async () => {
    const q = await buildDesignSystemQuestion();
    expect(q.options.length).toBeGreaterThanOrEqual(2);
  });

  it('every option has both label and description', async () => {
    const q = await buildDesignSystemQuestion();
    for (const opt of q.options) {
      expect(opt.label.length).toBeGreaterThan(0);
      expect(opt.description).toBeDefined();
      expect(opt.description!.length).toBeGreaterThan(0);
    }
  });
});

describe('DESIGN_SYSTEM_SYSTEM_PROMPT_FRAGMENT', () => {
  it('is a non-empty string that mentions the iron rule', async () => {
    const { DESIGN_SYSTEM_SYSTEM_PROMPT_FRAGMENT } = await import('@/lib/design-systems/agent-helper');
    expect(DESIGN_SYSTEM_SYSTEM_PROMPT_FRAGMENT.length).toBeGreaterThan(200);
    expect(DESIGN_SYSTEM_SYSTEM_PROMPT_FRAGMENT).toMatch(/var\(--/i);
    expect(DESIGN_SYSTEM_SYSTEM_PROMPT_FRAGMENT).toMatch(/ask_user_question/i);
    expect(DESIGN_SYSTEM_SYSTEM_PROMPT_FRAGMENT).toMatch(/fall\s+back/i);
  });
});
