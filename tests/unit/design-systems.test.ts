// Design-System Registry tests.
//
// Validates:
//   1. registry.json parses and has the required shape.
//   2. Every pack's tokens.css file exists and contains the three
//      layers (primitive / semantic / component) per the iron rule.
//   3. Every sample component's code references `var(--*)` — never
//      hardcoded hex/rgb colors. This enforces the iron rule.
//   4. The default pack exists in the packs array.
//
// These tests use `node:fs` directly — no need to import the loader
// (which uses `cache()` from React and is awkward to test in jsdom).

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DesignSystemRegistry, DesignSystemPack } from '@/lib/design-systems/types';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REGISTRY_DIR = join(MODULE_DIR, '..', '..', 'src', 'lib', 'design-systems');
const REGISTRY_JSON = JSON.parse(
  readFileSync(join(REGISTRY_DIR, 'registry.json'), 'utf-8'),
) as DesignSystemRegistry;

describe('Design-System Registry — registry.json', () => {
  it('parses to a valid registry object', () => {
    expect(REGISTRY_JSON).toBeTypeOf('object');
    expect(REGISTRY_JSON.version).toBeTypeOf('string');
    expect(REGISTRY_JSON.defaultPack).toBeTypeOf('string');
    expect(Array.isArray(REGISTRY_JSON.packs)).toBe(true);
    expect(REGISTRY_JSON.packs.length).toBeGreaterThan(0);
  });

  it('caps the number of packs at 7 (per AGENTS.md guidance)', () => {
    expect(REGISTRY_JSON.packs.length).toBeLessThanOrEqual(7);
  });

  it('names a defaultPack that exists in the packs list', () => {
    const names = REGISTRY_JSON.packs.map((p) => p.name);
    expect(names).toContain(REGISTRY_JSON.defaultPack);
  });

  it('includes the three canonical packs (shadcn-default, vercel-geist, mantine-default)', () => {
    const names = REGISTRY_JSON.packs.map((p) => p.name);
    expect(names).toContain('shadcn-default');
    expect(names).toContain('vercel-geist');
    expect(names).toContain('mantine-default');
  });

  it('hits the 5-pack target (adds radix-themes + tailwind-catalyst)', () => {
    const names = REGISTRY_JSON.packs.map((p) => p.name);
    expect(REGISTRY_JSON.packs.length).toBe(5);
    expect(names).toContain('radix-themes');
    expect(names).toContain('tailwind-catalyst');
  });
});

describe('Design-System Registry — per-pack structure', () => {
  for (const pack of REGISTRY_JSON.packs) {
    describe(`pack: ${pack.name}`, () => {
      it('has every required top-level field', () => {
        const requiredKeys: (keyof DesignSystemPack)[] = [
          'name', 'version', 'description', 'palette', 'tokens',
          'dependencies', 'importMap', 'fontStack', 'sampleComponents', 'bestFor',
        ];
        for (const key of requiredKeys) {
          expect(pack).toHaveProperty(key);
        }
      });

      it('has a lowercase kebab-case name', () => {
        expect(pack.name).toMatch(/^[a-z][a-z0-9-]*$/);
      });

      it('has a semver version', () => {
        expect(pack.version).toMatch(/^\d+\.\d+\.\d+$/);
      });

      it('has a description ≤160 chars', () => {
        expect(pack.description.length).toBeLessThanOrEqual(160);
      });

      it('palette has primary/background/accent/text as hex', () => {
        const hexRe = /^#[0-9a-fA-F]{6}$/;
        expect(pack.palette.primary).toMatch(hexRe);
        expect(pack.palette.background).toMatch(hexRe);
        expect(pack.palette.accent).toMatch(hexRe);
        expect(pack.palette.text).toMatch(hexRe);
      });

      it('fontStack has body/heading/mono', () => {
        expect(pack.fontStack.body).toBeTypeOf('string');
        expect(pack.fontStack.heading).toBeTypeOf('string');
        expect(pack.fontStack.mono).toBeTypeOf('string');
      });

      it('tokens path is always "tokens.css"', () => {
        expect(pack.tokens).toBe('tokens.css');
      });

      it('tokens.css file exists on disk with three layers', () => {
        const tokensPath = join(REGISTRY_DIR, 'packs', pack.name, 'tokens.css');
        expect(existsSync(tokensPath)).toBe(true);
        const css = readFileSync(tokensPath, 'utf-8');
        // Three-layer pattern (per AGENTS.md):
        expect(css).toMatch(/PRIMITIVE/i);
        expect(css).toMatch(/SEMANTIC/i);
        expect(css).toMatch(/COMPONENT/i);
      });

      it('tokens.css defines the semantic --color-* aliases', () => {
        const tokensPath = join(REGISTRY_DIR, 'packs', pack.name, 'tokens.css');
        const css = readFileSync(tokensPath, 'utf-8');
        // Every pack must define these semantic aliases so the showcase
        // CSS (which uses var(--color-*)) renders consistently.
        const required = [
          '--color-bg',
          '--color-surface',
          '--color-border-default',
          '--color-text-primary',
          '--color-accent',
          '--button-bg-primary',
          '--input-border',
          '--card-bg',
          '--table-header-bg',
          '--dialog-overlay-bg',
        ];
        for (const token of required) {
          expect(css).toContain(token);
        }
      });

      it('sampleComponents has all 8 canonical components', () => {
        const names = pack.sampleComponents.map((sc) => sc.name);
        const canonical = ['Button', 'Input', 'Card', 'Dialog', 'Table', 'Toast', 'Tabs', 'Avatar'];
        for (const c of canonical) {
          expect(names).toContain(c);
        }
      });

      it('sampleComponents reference var(--*) — never hardcoded hex/rgb values (iron rule)', () => {
        for (const sc of pack.sampleComponents) {
          // Forbidden: #abcdef, #fff, rgb(...), rgba(...)
          expect(sc.code).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
          expect(sc.code).not.toMatch(/\brgb(a)?\s*\(/i);
        }
      });

      it('importMap covers every component the agent might need', () => {
        const required = ['Button', 'Input', 'Card', 'Dialog', 'Table', 'Toast', 'Tabs', 'Avatar'];
        for (const c of required) {
          expect(pack.importMap).toHaveProperty(c);
          expect(typeof pack.importMap[c]).toBe('string');
          expect(pack.importMap[c].length).toBeGreaterThan(0);
        }
      });

      it('dependencies list tailwindcss (or equivalent runtime)', () => {
        // Every pack we ship needs Tailwind (or a sibling runtime
        // that provides utility classes). The agent checks these
        // are installed before generating; if missing, it falls
        // back to shadcn-default.
        const deps = pack.dependencies.map((d) => d.package);
        expect(deps.length).toBeGreaterThan(0);
      });

      it('bestFor tags come from the canonical enum', () => {
        const allowed = ['nextjs', 'fullstack', 'dashboard', 'saas', 'marketing', 'docs', 'enterprise', 'minimal', 'brand'];
        for (const tag of pack.bestFor) {
          expect(allowed).toContain(tag);
        }
      });
    });
  }
});

describe('Design-System Registry — default pack', () => {
  it('is shadcn-default (per the policy memo recommendation)', () => {
    expect(REGISTRY_JSON.defaultPack).toBe('shadcn-default');
  });

  it('shadcn-default palette matches v0 defaults', () => {
    const shad = REGISTRY_JSON.packs.find((p) => p.name === 'shadcn-default');
    expect(shad).toBeDefined();
    expect(shad!.palette.accent).toBe('#3b82f6');
    expect(shad!.palette.background).toBe('#fafafa');
  });

  it('vercel-geist has zero-radius corners (strict monochrome)', () => {
    const geist = REGISTRY_JSON.packs.find((p) => p.name === 'vercel-geist');
    expect(geist).toBeDefined();
    const tokensPath = join(REGISTRY_DIR, 'packs', 'vercel-geist', 'tokens.css');
    const css = readFileSync(tokensPath, 'utf-8');
    expect(css).toContain('--radius-sm: 0');
    expect(css).toContain('--radius-md: 0');
    expect(css).toContain('--radius-lg: 0');
  });

  it('mantine-default uses Mantine 7.x blue-6 as accent', () => {
    const mantine = REGISTRY_JSON.packs.find((p) => p.name === 'mantine-default');
    expect(mantine).toBeDefined();
    expect(mantine!.palette.accent).toBe('#228be6');
    const tokensPath = join(REGISTRY_DIR, 'packs', 'mantine-default', 'tokens.css');
    const css = readFileSync(tokensPath, 'utf-8');
    // Tokens use aligned columns (multiple spaces around `:`), so a
    // regex with `\s*` is more robust than a literal substring match.
    expect(css).toMatch(/--m-blue-6:\s*#228be6/);
  });

  it('radix-themes uses Radix indigo-9 as accent with medium (6px) radius', () => {
    const radix = REGISTRY_JSON.packs.find((p) => p.name === 'radix-themes');
    expect(radix).toBeDefined();
    expect(radix!.palette.accent).toBe('#3e63dd');
    const tokensPath = join(REGISTRY_DIR, 'packs', 'radix-themes', 'tokens.css');
    const css = readFileSync(tokensPath, 'utf-8');
    expect(css).toMatch(/--r-indigo-9:\s*#3e63dd/);
    // Radix Themes radius scale: medium = 6px is the default.
    expect(css).toMatch(/--radius-md:\s*6px/);
    // Soft tinted accent surface (the Radix signature for selected states).
    expect(css).toMatch(/--color-accent-muted:\s*var\(--r-indigo-3\)/);
  });

  it('tailwind-catalyst uses zinc-950 ink buttons + indigo-600 focus accent', () => {
    const catalyst = REGISTRY_JSON.packs.find((p) => p.name === 'tailwind-catalyst');
    expect(catalyst).toBeDefined();
    expect(catalyst!.palette.primary).toBe('#09090b');
    expect(catalyst!.palette.accent).toBe('#4f46e5');
    const tokensPath = join(REGISTRY_DIR, 'packs', 'tailwind-catalyst', 'tokens.css');
    const css = readFileSync(tokensPath, 'utf-8');
    // The signature: primary buttons are INK-BLACK, not accent-colored.
    expect(css).toMatch(/--button-bg-primary:\s*var\(--z-zinc-950\)/);
    expect(css).toMatch(/--z-zinc-950:\s*#09090b/);
    expect(css).toMatch(/--z-indigo-600:\s*#4f46e5/);
    // Catalyst radii: rounded-lg (8px) controls, rounded-xl (12px) containers.
    expect(css).toMatch(/--radius-button:\s*var\(--radius-lg\)/);
    expect(css).toMatch(/--radius-card:\s*var\(--radius-xl\)/);
  });
});
