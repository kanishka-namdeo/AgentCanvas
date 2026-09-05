// Visual design-consistency pass (2026-09-06) — regression tests.
//
// Grounded in the standards digest for this pass (research cached under
// scripts/research/design-std/):
//   - shadcn/ui Theming (current): semantic tokens, dark mode = same tokens
//     overridden under `.dark`, radius derived from one --radius primitive,
//   - W3C DTCG Design Tokens Format 2025.10 (first stable): role-based
//     semantic naming; raw values in component code are an anti-pattern,
//   - WCAG 2.2 1.4.11 / 1.4.3: non-text UI >= 3:1, text >= 4.5:1,
//   - S. Walter (dense data UI): 8px type is below the dense-UI floor;
//     9px only for auxiliary micro-badges,
//   - 4px/8pt baseline grid: spacing from the scale, not arbitrary px.
//
// The contract (src/components/AGENTS.md "Visual-recipe consistency"):
//   ONE recipe per semantic role. kbd chips = .ac-kbd; overline labels =
//   .ac-label; brand mark = .ac-brand-gradient; guide red =
//   DEFAULT_GUIDE_COLOR single source; measure overlay = tokens; no raw
//   color literals / literal var() fallbacks in app chrome; micro-type
//   floor 9px; SettingsDialog headings 13px.
//
// Static source scan (same approach as the sizing/interaction passes):
// component files are read directly, so the contract is enforced without
// needing to mount every panel.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const COMPONENT_DIRS = [
  join(ROOT, 'src', 'components'),
  join(ROOT, 'src', 'app', 'page.tsx'),
];

/// Recursively collect .tsx/.ts source files under a path (app chrome only).
function collectSources(dir: string, out: string[] = []): string[] {
  const st = statSync(dir);
  if (st.isFile()) {
    if (['.tsx', '.ts'].includes(extname(dir))) out.push(dir);
    return out;
  }
  for (const name of readdirSync(dir)) {
    if (name === 'AGENTS.md' || name.startsWith('.')) continue;
    collectSources(join(dir, name), out);
  }
  return out;
}

const sources = COMPONENT_DIRS.flatMap((p) => {
  try {
    return collectSources(p);
  } catch {
    return [];
  }
});
const sourceText = () => Object.fromEntries(sources.map((f) => [f, readFileSync(f, 'utf8')]));

const globalsCss = readFileSync(join(ROOT, 'src', 'app', 'globals.css'), 'utf8');

describe('design tokens: globals.css contract', () => {
  it('defines the .ac-kbd utility with the full key-chip recipe', () => {
    expect(globalsCss).toMatch(/\.ac-kbd\s*\{/);
    const block = globalsCss.match(/\.ac-kbd\s*\{[^}]+\}/)![0];
    expect(block).toContain('font-size: 10px');
    expect(block).toContain('var(--ac-text-tertiary)');
    expect(block).toContain('var(--ac-surface-2)');
    expect(block).toContain('var(--ac-border-subtle)');
    expect(block).toContain('var(--font-geist-mono)');
    expect(block).toContain('border-radius: 4px');
  });

  it('defines the .ac-label overline recipe (10px semibold uppercase)', () => {
    expect(globalsCss).toMatch(/\.ac-label\s*\{/);
    const block = globalsCss.match(/\.ac-label\s*\{[^}]+\}/)![0];
    expect(block).toContain('font-size: 10px');
    expect(block).toContain('font-weight: 600');
    expect(block).toContain('text-transform: uppercase');
    expect(block).toContain('var(--ac-text-quaternary)');
  });

  it('defines the brand gradient tokens + utility (both modes stable)', () => {
    expect(globalsCss).toMatch(/--ac-brand-from:\s*oklch\(0\.606 0\.25 292\.717\)/);
    expect(globalsCss).toMatch(/--ac-brand-to:\s*oklch\(0\.667 0\.295 327\.153\)/);
    expect(globalsCss).toMatch(/\.ac-brand-gradient\s*\{/);
    const block = globalsCss.match(/\.ac-brand-gradient\s*\{[\s\S]*?\n  \}/)![0];
    expect(block).toContain('linear-gradient');
    expect(block).toContain('var(--ac-brand-from)');
    expect(block).toContain('var(--ac-brand-to)');
    // Brand tokens are defined exactly once (root) — the mark never inverts.
    expect(globalsCss.match(/--ac-brand-from:/g)).toHaveLength(1);
  });

  it('defines --ac-canvas-measure in BOTH light and dark palettes', () => {
    expect(globalsCss).toMatch(/--ac-canvas-measure:\s*oklch\(0\.55 0\.21 25\)/);
    // The .dark block (second :root section is light) must redefine it.
    const darkIdx = globalsCss.toLowerCase().indexOf('dark-mode variant');
    expect(darkIdx).toBeGreaterThan(0);
    const darkBlock = globalsCss.slice(darkIdx);
    expect(darkBlock).toMatch(/--ac-canvas-measure:\s*oklch\(0\.75 0\.16 25\)/);
  });

  it('keeps the shadcn radius ladder derived from one --radius primitive', () => {
    expect(globalsCss).toMatch(/--radius-sm:\s*calc\(var\(--radius\) - 4px\)/);
    expect(globalsCss).toMatch(/--radius-lg:\s*var\(--radius\)/);
  });
});

describe('one recipe per role: kbd chips', () => {
  it('every <kbd> in app chrome uses .ac-kbd (no hand-composed recipes)', () => {
    const files = sourceText();
    const offenders: string[] = [];
    for (const [file, text] of Object.entries(files)) {
      for (const m of text.matchAll(/<kbd\b([^>]*)>/g)) {
        if (!m[1].includes('ac-kbd')) {
          offenders.push(`${file.split('src/')[1]}: <kbd${m[1].trim()}>`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('kbd consumers keep only layout classes next to .ac-kbd', () => {
    const files = sourceText();
    for (const [file, text] of Object.entries(files)) {
      for (const m of text.matchAll(/<kbd\b[^>]*className="([^"]*)"/g)) {
        const extras = m[1]
          .replace('ac-kbd', '')
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        const allowed = ['flex-shrink-0', 'ml-1', 'hidden', 'md:inline', 'self-start'];
        const bad = extras.filter((c) => !allowed.includes(c));
        if (bad.length > 0) {
          expect.fail(`${file}: kbd carries non-layout classes: ${bad.join(', ')}`);
        }
      }
    }
  });
});

describe('one recipe per role: overline labels', () => {
  it('no 9px uppercase overline recipes remain (converged to .ac-label)', () => {
    const files = sourceText();
    const offenders: string[] = [];
    for (const [file, text] of Object.entries(files)) {
      if (/text-\[9px\][^"]*(uppercase|tracking-wide)/.test(text)) {
        offenders.push(file.split('src/')[1]);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no hand-composed 10/11px overline recipes remain anywhere (role = .ac-label)', () => {
    const files = sourceText();
    const offenders: string[] = [];
    // Overline shape = 10px semibold uppercase tracking + ac-text-4 (the old
    // dominant recipe). Field labels (font-medium) and 11px panel TITLES
    // (ac-text-2) are different roles and stay hand-composed.
    for (const [file, text] of Object.entries(files)) {
      if (/text-\[10px\] font-semibold uppercase tracking-wide ac-text-4/.test(text)) {
        offenders.push(file.split('src/')[1]);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('micro-typography floor', () => {
  it('no 8px text anywhere in app chrome (dense-UI floor is 9px)', () => {
    const files = sourceText();
    const offenders: string[] = [];
    for (const [file, text] of Object.entries(files)) {
      if (/text-\[8px\]/.test(text)) offenders.push(file.split('src/')[1]);
    }
    expect(offenders).toEqual([]);
  });

  it('SettingsDialog section headings stay on the 13px contract (no 14px)', () => {
    const text = readFileSync(join(ROOT, 'src/components/settings/SettingsDialog.tsx'), 'utf8');
    expect(text).not.toMatch(/text-\[14px\]/);
    const headings = text.match(/<h2 className="([^"]*)"/g) ?? [];
    expect(headings.length).toBeGreaterThanOrEqual(7);
    for (const h of headings) {
      expect(h).toContain('text-[13px]');
      expect(h).not.toContain('mb-1.5');
    }
  });
});

describe('color: tokens only in app chrome', () => {
  it('no raw violet/fuchsia gradient palette classes remain', () => {
    const files = sourceText();
    const offenders: string[] = [];
    for (const [file, text] of Object.entries(files)) {
      if (/from-violet-500|to-fuchsia-500/.test(text)) {
        offenders.push(file.split('src/')[1]);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('guide red #f24822 exists ONLY as DEFAULT_GUIDE_COLOR in dom/Guides.tsx', () => {
    const files = sourceText();
    for (const [file, text] of Object.entries(files)) {
      if (file.endsWith('dom/Guides.tsx')) continue;
      expect(text, `${file} re-types the guide-red literal`).not.toContain('#f24822');
    }
    const guides = readFileSync(
      join(ROOT, 'src/components/canvas/dom/Guides.tsx'),
      'utf8',
    );
    expect(guides).toContain("export const DEFAULT_GUIDE_COLOR = '#f24822'");
  });

  it('Canvas and Rulers consume DEFAULT_GUIDE_COLOR (single source)', () => {
    const canvas = readFileSync(join(ROOT, 'src/components/canvas/Canvas.tsx'), 'utf8');
    const rulers = readFileSync(join(ROOT, 'src/components/canvas/Rulers.tsx'), 'utf8');
    expect(canvas).toContain('DEFAULT_GUIDE_COLOR');
    expect(canvas).toMatch(/import \{ Guides, DEFAULT_GUIDE_COLOR \}/);
    expect(rulers).toContain('DEFAULT_GUIDE_COLOR');
    expect(rulers).toMatch(/import \{ DEFAULT_GUIDE_COLOR \} from '\.\/dom\/Guides'/);
  });

  it('no literal var(--ac-*) fallbacks in app chrome (globals always loads)', () => {
    const files = sourceText();
    const offenders: string[] = [];
    for (const [file, text] of Object.entries(files)) {
      for (const m of text.matchAll(/var\(--ac-[a-z-]+,\s*(?:#|hsl\(|rgb\(|oklch\()/g)) {
        offenders.push(`${file.split('src/')[1]}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('MeasureOverlay is token-driven (no #ff6b6b / white-pill / raw font stack)', () => {
    const text = readFileSync(
      join(ROOT, 'src/components/canvas/dom/MeasureOverlay.tsx'),
      'utf8',
    );
    expect(text).not.toContain('#ff6b6b');
    expect(text).not.toContain('fill="#ffffff"');
    expect(text).toContain("var(--ac-canvas-measure)");
    expect(text).toContain("var(--ac-canvas-bg)");
    expect(text).toContain('var(--font-geist-mono)');
  });
});

describe('spacing: 4px grid', () => {
  it('no arbitrary p-[Npx] paddings in app chrome (shadcn primitives exempt)', () => {
    const files = sourceText();
    const offenders: string[] = [];
    for (const [file, text] of Object.entries(files)) {
      if (file.includes(join('src', 'components', 'ui'))) continue; // shadcn upstream
      if (/\bp-\[\d+(?:\.\d+)?px\]/.test(text)) {
        offenders.push(file.split('src/')[1]);
      }
    }
    expect(offenders).toEqual([]);
  });
});
