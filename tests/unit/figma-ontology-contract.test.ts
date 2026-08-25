// Figma ontology contract test (spec §10.2 #1) — the FREEZE GUARD.
//
// The enum tables in src/lib/pen/figma-ontology.ts are the vocabulary
// authority for .pen v3. This test pins them:
//   1. every table's values are unique and sorted-stable (deterministic order),
//   2. every alias maps to a CANONICAL member of its domain (no dangling
//      aliases pointing outside the frozen vocabulary),
//   3. alias maps are injective within a domain except the DOCUMENTED merges
//      (FIGMA_ALIAS_MERGES),
//   4. the whole ontology is snapshot-frozen — any vocabulary drift fails CI
//      with a diff.

import { describe, it, expect } from 'vitest';
import {
  FIGMA_LAYOUT_MODE,
  FIGMA_AXIS_ALIGN,
  FIGMA_LAYOUT_SIZING,
  FIGMA_LAYOUT_POSITIONING,
  FIGMA_PAINT_TYPE,
  FIGMA_SCALE_MODE,
  FIGMA_EFFECT_TYPE,
  FIGMA_TEXT_AUTO_RESIZE,
  FIGMA_CONSTRAINT_H,
  FIGMA_CONSTRAINT_V,
  FIGMA_VARIABLE_TYPE,
  FIGMA_COMPONENT_PROPERTY_TYPE,
  FIGMA_BLEND_MODE,
  FIGMA_TEXT_ALIGN,
  FIGMA_ALIGN_KIND,
  FIGMA_ENUM_DOMAINS,
  FIGMA_ENUM_ALIASES,
  FIGMA_ALIAS_MERGES,
  normalizeEnum,
  isCanonicalEnum,
} from '@/lib/pen/figma-ontology';

const TABLES = {
  FIGMA_LAYOUT_MODE,
  FIGMA_AXIS_ALIGN,
  FIGMA_LAYOUT_SIZING,
  FIGMA_LAYOUT_POSITIONING,
  FIGMA_PAINT_TYPE,
  FIGMA_SCALE_MODE,
  FIGMA_EFFECT_TYPE,
  FIGMA_TEXT_AUTO_RESIZE,
  FIGMA_CONSTRAINT_H,
  FIGMA_CONSTRAINT_V,
  FIGMA_VARIABLE_TYPE,
  FIGMA_COMPONENT_PROPERTY_TYPE,
  FIGMA_BLEND_MODE,
  FIGMA_TEXT_ALIGN,
  FIGMA_ALIGN_KIND,
} as const;

describe('figma-ontology contract — canonical tables', () => {
  it('every table is registered in FIGMA_ENUM_DOMAINS (and nothing else is)', () => {
    expect(Object.keys(FIGMA_ENUM_DOMAINS).sort()).toEqual([
      'alignKind', 'axisAlign', 'blendMode', 'componentPropertyType', 'constraintsH',
      'constraintsV', 'effectType', 'layoutMode', 'layoutPositioning', 'layoutSizing',
      'paintType', 'scaleMode', 'textAlign', 'textAutoResize', 'variableType',
    ]);
  });

  it.each(Object.entries(TABLES))('%s values are unique', (_name, table) => {
    const values = [...table];
    expect(new Set(values).size).toBe(values.length);
  });

  it.each(Object.entries(TABLES))('%s order is sorted-stable (frozen)', (_name, table) => {
    // Snapshot the order itself — reordering is a vocabulary change.
    expect([...table]).toMatchSnapshot();
  });

  it('REST spellings: enum values are SCREAMING_SNAKE', () => {
    for (const [domain, table] of Object.entries(FIGMA_ENUM_DOMAINS)) {
      for (const value of table) {
        expect(value, `${domain}.${value}`).toMatch(/^[A-Z][A-Z0-9_]*$/);
      }
    }
  });

  it('key canonical members are present (spot-check against Appendix G)', () => {
    expect([...FIGMA_LAYOUT_MODE]).toContain('NONE');
    expect([...FIGMA_LAYOUT_MODE]).toContain('GRID'); // reserved
    expect([...FIGMA_AXIS_ALIGN]).toContain('SPACE_BETWEEN');
    expect([...FIGMA_AXIS_ALIGN]).toContain('SPACE_AROUND');
    expect([...FIGMA_LAYOUT_SIZING]).toEqual(['FIXED', 'HUG', 'FILL']);
    expect([...FIGMA_LAYOUT_POSITIONING]).toEqual(['AUTO', 'ABSOLUTE']);
    expect([...FIGMA_CONSTRAINT_H]).toContain('LEFT_RIGHT');
    expect([...FIGMA_CONSTRAINT_V]).toContain('TOP_BOTTOM');
    expect([...FIGMA_PAINT_TYPE]).toContain('GRADIENT_DIAMOND');
    expect([...FIGMA_SCALE_MODE]).toContain('TILE');
    expect([...FIGMA_VARIABLE_TYPE]).toContain('FLOAT');
    expect([...FIGMA_COMPONENT_PROPERTY_TYPE]).toContain('SLOT');
    expect([...FIGMA_BLEND_MODE]).toContain('PASS_THROUGH');
    expect([...FIGMA_TEXT_ALIGN]).toContain('JUSTIFIED');
    expect([...FIGMA_ALIGN_KIND]).toContain('TIDY');
  });
});

describe('figma-ontology contract — alias tables', () => {
  it('every alias target IS a canonical member of its domain', () => {
    for (const [domain, aliases] of Object.entries(FIGMA_ENUM_ALIASES)) {
      const canonical = FIGMA_ENUM_DOMAINS[domain as keyof typeof FIGMA_ENUM_DOMAINS] as readonly string[];
      for (const [legacy, target] of Object.entries(aliases)) {
        expect(
          canonical.includes(target),
          `${domain}: alias ${legacy} → ${target} (not a canonical member)`,
        ).toBe(true);
      }
    }
  });

  it('alias maps are injective per domain except documented merges', () => {
    const documented = new Set(Object.values(FIGMA_ALIAS_MERGES).flat());
    for (const [domain, aliases] of Object.entries(FIGMA_ENUM_ALIASES)) {
      const seen = new Map<string, string>();
      for (const [legacy, target] of Object.entries(aliases)) {
        if (seen.has(target)) {
          const first = seen.get(target)!;
          const merged =
            documented.has(legacy) && documented.has(first) &&
            Object.values(FIGMA_ALIAS_MERGES).some(
              (m) => m.includes(legacy) && m.includes(first),
            );
          expect(
            merged,
            `${domain}: ${first} and ${legacy} both → ${target} (undocumented merge)`,
          ).toBe(true);
        } else {
          seen.set(target, legacy);
        }
      }
    }
  });

  it('documented merges are real (both members exist in the alias table)', () => {
    for (const [key, members] of Object.entries(FIGMA_ALIAS_MERGES)) {
      const [domain, canonical] = key.split(':');
      const aliases = FIGMA_ENUM_ALIASES[domain as keyof typeof FIGMA_ENUM_ALIASES];
      for (const m of members) {
        expect(aliases[m], `${domain}.${m}`).toBe(canonical);
      }
    }
  });

  it('every domain has an alias table (possibly empty)', () => {
    expect(Object.keys(FIGMA_ENUM_ALIASES).sort()).toEqual(Object.keys(FIGMA_ENUM_DOMAINS).sort());
  });
});

describe('figma-ontology contract — normalizeEnum', () => {
  it('canonical values pass through unchanged', () => {
    expect(normalizeEnum('layoutMode', 'VERTICAL')).toBe('VERTICAL');
    expect(normalizeEnum('constraintsH', 'LEFT_RIGHT')).toBe('LEFT_RIGHT');
    expect(normalizeEnum('blendMode', 'PASS_THROUGH')).toBe('PASS_THROUGH');
  });

  it('legacy aliases map to canonical', () => {
    expect(normalizeEnum('layoutMode', 'vertical')).toBe('VERTICAL');
    expect(normalizeEnum('layoutSizing', 'fit_content')).toBe('HUG');
    expect(normalizeEnum('axisAlign', 'space_between')).toBe('SPACE_BETWEEN');
  });

  it('unknown values return null (total, never throws)', () => {
    expect(normalizeEnum('layoutMode', 'diagonal')).toBeNull();
    expect(normalizeEnum('layoutMode', 42)).toBeNull();
    expect(normalizeEnum('layoutMode', undefined)).toBeNull();
    expect(normalizeEnum('layoutMode', null)).toBeNull();
  });

  it('isCanonicalEnum distinguishes canonical from alias', () => {
    expect(isCanonicalEnum('layoutMode', 'NONE')).toBe(true);
    expect(isCanonicalEnum('layoutMode', 'none')).toBe(false);
    expect(isCanonicalEnum('alignKind', 'TIDY')).toBe(true);
    expect(isCanonicalEnum('alignKind', 'center_h')).toBe(false);
  });
});

describe('figma-ontology contract — full ontology snapshot (the freeze guard)', () => {
  it('the serialized ontology is byte-stable', () => {
    const snapshot = JSON.stringify(
      {
        domains: FIGMA_ENUM_DOMAINS,
        aliases: FIGMA_ENUM_ALIASES,
        merges: FIGMA_ALIAS_MERGES,
      },
      null,
      2,
    );
    // Any vocabulary change (value added/removed/reordered, alias edited)
    // changes this snapshot and must be a deliberate, reviewed act.
    expect(snapshot).toMatchSnapshot();
  });
});
