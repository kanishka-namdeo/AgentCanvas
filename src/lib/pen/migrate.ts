// .pen 2.17 → 3.0 document migration (spec Phase 6, §9.3 / Appendix G §G.1).
//
// DETERMINISTIC + TOTAL:
//   - Every generated id is DERIVED from names (collections `col:<axis>`,
//     variables `var:<key>`, modes `mode:<axis>:<value>`) — no clock, no
//     random — so migration is IDEMPOTENT: migrate(migrate(x)) ≡ migrate(x)
//     (asserted in tests/unit/pen-migration.test.ts).
//   - Never throws on malformed input: unknown enum values pass through, a
//     missing `version` is treated as legacy, missing fields stay missing.
//
// DUAL-CARRY: the migrated document keeps EVERY legacy field (`gap` next to
// `itemSpacing`, `themes` next to `variableCollections`, the `variables`
// `$key` map next to `variableRecords`, …) so the runtime resolver, panels,
// tools, and all pre-existing tests keep reading the legacy spelling
// unchanged. The v3 fields are additive projections consumed by Phase 6
// part 2.
//
// Version policy: 2.x imports migrate-on-read FOREVER (penToCanvas); export
// writes '3.0' (canvasToPen). A document already at >= 3.0 is returned
// as-is (that early return is the idempotence guarantee at the document
// level).

import type {
  PenDocument,
  PenChild,
  PenVariableDef,
  PenVariableCollection,
  PenVariableRecord,
  VariableAlias,
} from './types';
import { PEN_FORMAT_VERSION_V3 } from './types';
import type { CanvasDocument } from '../canvas/types';
import { normalizePenNode, normalizeConstraintsH, normalizeConstraintsV, normalizeVariableType } from './normalize';

/** Any document shape the migration accepts (pen file or live canvas doc). */
export type MigrationInput = PenDocument | CanvasDocument;

/** Is this document already at (or beyond) the v3 format version? */
export function isV3Document(doc: MigrationInput): boolean {
  const v = (doc as { version?: unknown }).version;
  if (typeof v !== 'string' || v.length === 0) return false;
  const major = Number(v.split('.')[0]);
  return Number.isFinite(major) && major >= 3;
}

// ---- Variable migration (G.1 rows 18–19) -----------------------------------

function aliasOrValue(v: unknown): string | number | boolean | VariableAlias {
  if (typeof v === 'string' && v.startsWith('$')) {
    return { type: 'VARIABLE_ALIAS', id: `var:${v.slice(1)}` };
  }
  return v as string | number | boolean;
}

interface VariableMigration {
  collections: PenVariableCollection[];
  records: PenVariableRecord[];
}

/**
 * themes {axis: values[]} + variables {$key: def} → variableCollections +
 * variableRecords. Deterministic: collection/mode ids derive from names;
 * axis order follows `themes` insertion order, then first-seen order for
 * axes referenced only from themed values.
 */
function migrateVariables(
  themes: { [axis: string]: string[] } | undefined,
  variables: { [key: string]: PenVariableDef } | undefined,
): VariableMigration {
  const collections: PenVariableCollection[] = [];
  const records: PenVariableRecord[] = [];
  if (!variables || Object.keys(variables).length === 0) {
    // No variables → no collections (themes alone stay in `themes` —
    // collections model MODE RESOLUTION for variables).
    return { collections, records };
  }

  // Axis → declared values (themes first, then values referenced by themed
  // variables whose axis has no theme declaration).
  const axisValues = new Map<string, string[]>();
  for (const [axis, values] of Object.entries(themes ?? {})) {
    axisValues.set(axis, [...values]);
  }
  const varEntries = Object.entries(variables);
  for (const [, def] of varEntries) {
    if (!Array.isArray(def.value)) continue;
    for (const entry of def.value as Array<{ theme?: Record<string, string> }>) {
      for (const [axis, val] of Object.entries(entry?.theme ?? {})) {
        if (!axisValues.has(axis)) axisValues.set(axis, []);
        const list = axisValues.get(axis)!;
        if (!list.includes(val)) list.push(val);
      }
    }
  }

  const hasAxes = axisValues.size > 0;
  const firstAxis = hasAxes ? [...axisValues.keys()][0] : 'default';
  const collectionId = (axis: string) => `col:${axis}`;
  const modeId = (axis: string, value: string) => `mode:${axis}:${value}`;

  const collectionByAxis = new Map<string, PenVariableCollection>();
  const ensureCollection = (axis: string): PenVariableCollection => {
    let c = collectionByAxis.get(axis);
    if (!c) {
      const values = axisValues.get(axis) ?? [];
      c = {
        id: collectionId(axis),
        name: axis,
        modes: values.map((v) => ({ modeId: modeId(axis, v), name: v })),
        defaultModeId: values.length > 0 ? modeId(axis, values[0]) : modeId(axis, 'default'),
      };
      collectionByAxis.set(axis, c);
      collections.push(c);
    }
    return c;
  };
  if (hasAxes) {
    // Materialize the DECLARED collections (themes order).
    for (const axis of axisValues.keys()) ensureCollection(axis);
  } else {
    // No themes at all → one synthetic singleton collection so every variable
    // has a home (deterministic id).
    ensureCollection('default');
  }

  for (const [key, def] of varEntries) {
    const resolvedType = normalizeVariableType(def.type) as PenVariableRecord['resolvedType'];
    const value = def.value;

    if (!Array.isArray(value)) {
      // Single value → same in every mode of its collection.
      const axis = hasAxes ? firstAxis : 'default';
      const col = ensureCollection(axis);
      const valuesByMode: PenVariableRecord['valuesByMode'] = {};
      for (const m of col.modes) valuesByMode[m.modeId] = aliasOrValue(value) as any;
      records.push({
        id: `var:${key}`,
        name: key,
        variableCollectionId: col.id,
        resolvedType,
        valuesByMode,
      });
      continue;
    }

    // Themed values → valuesByMode keyed by modeId.
    // Collection = first axis referenced by the themed entries (else doc default).
    let axis: string | null = null;
    for (const entry of value as Array<{ theme?: Record<string, string> }>) {
      const keys = Object.keys(entry?.theme ?? {});
      if (keys.length > 0) {
        axis = keys[0];
        break;
      }
    }
    const col = ensureCollection(axis ?? (hasAxes ? firstAxis : 'default'));

    const valuesByMode: PenVariableRecord['valuesByMode'] = {};
    const defaultValue = aliasOrValue((value[0] as { value: unknown })?.value);
    for (const entry of value as Array<{ value: unknown; theme?: Record<string, string> }>) {
      const themeKeys = Object.entries(entry?.theme ?? {});
      if (themeKeys.length === 0) {
        // Theme-less entry = the collection default (last one wins).
        valuesByMode[col.defaultModeId] = aliasOrValue(entry.value) as any;
      } else {
        // Compound themes assign to each constituent mode (approximation of
        // legacy "last matching compound theme wins" — informational during
        // the window; the runtime resolver still reads `themedValues`).
        for (const [a, v] of themeKeys) {
          valuesByMode[modeId(a, v)] = aliasOrValue(entry.value) as any;
        }
      }
    }
    // Cover the collection's remaining modes with the legacy default value.
    for (const m of col.modes) {
      if (!(m.modeId in valuesByMode)) valuesByMode[m.modeId] = defaultValue as any;
    }
    records.push({
      id: `var:${key}`,
      name: key,
      variableCollectionId: col.id,
      resolvedType,
      valuesByMode,
    });
  }

  return { collections, records };
}

// ---- Node migration ----------------------------------------------------------

/**
 * Migrate ONE node: dual-carry v3 population (normalizePenNode) + the
 * value-level canonicalizations that are migration-only (constraint casing →
 * SCREAMING per G.1 row 22; group blend-mode default PASS_THROUGH per row 25).
 * Recurses through `children` with ITSELF (so nested nodes get the
 * migration-only canonicalizations too).
 */
export function migratePenNode(node: PenChild): PenChild {
  const out = normalizePenNode(node) as Record<string, any>;

  // Constraints: lowercase → SCREAMING (G.1 row 22). The resolver's
  // constraint application tolerates both spellings during the window.
  if (out.constraints && typeof out.constraints === 'object' && !Array.isArray(out.constraints)) {
    const c = out.constraints as { horizontal?: string; vertical?: string };
    const next: { horizontal?: string; vertical?: string } = { ...c };
    if (typeof c.horizontal === 'string') next.horizontal = normalizeConstraintsH(c.horizontal);
    if (typeof c.vertical === 'string') next.vertical = normalizeConstraintsV(c.vertical);
    out.constraints = next;
  }

  // Groups default to PASS_THROUGH blending (G.1 row 25) — node-level v3
  // metadata; nothing reads it during the window.
  if (out.type === 'group' && out.blendMode === undefined) {
    out.blendMode = 'PASS_THROUGH';
  }

  // Recurse with the MIGRATION normalizer (normalizePenNode already copied +
  // normalized children; this pass applies the canonicalizations above).
  if (Array.isArray(out.children)) {
    out.children = out.children.map((c: PenChild) => migratePenNode(c));
  }

  return out as PenChild;
}

function migrateChildren(children: PenChild[] | undefined): PenChild[] {
  return (children ?? []).map((c) => migratePenNode(c));
}

// ---- Document migration ------------------------------------------------------

/**
 * Migrate a .pen 2.17 document (or a live CanvasDocument) to the
 * Figma-canonical v3 form. Deterministic, total, idempotent:
 * `migratePenDocument(migratePenDocument(x))` deep-equals
 * `migratePenDocument(x)`. Legacy fields are kept alongside the v3 mirrors
 * (dual-carry) so every legacy reader keeps working unchanged.
 */
export function migratePenDocument<T extends MigrationInput>(doc: T): T {
  if (!doc || typeof doc !== 'object') return doc;
  if (isV3Document(doc)) return doc; // already migrated — the idempotence gate

  const { collections, records } = migrateVariables(doc.themes, doc.variables);
  const children = migrateChildren(doc.children);

  // Multi-page docs: migrate every page's tree. When `children` IS the active
  // page's array (same reference), reuse the migrated array so the mirror
  // relationship survives.
  let pages = doc.pages;
  const activeIndex = doc.activePageIndex ?? -1;
  if (Array.isArray(pages)) {
    pages = pages.map((p, i) => {
      if (!p) return p;
      if (i === activeIndex && doc.children && p.children === doc.children) {
        return { ...p, children };
      }
      return { ...p, children: migrateChildren(p.children) };
    });
  }

  const out: Record<string, unknown> = {
    ...doc,
    version: PEN_FORMAT_VERSION_V3,
    children,
    ...(pages !== undefined ? { pages } : {}),
  };
  if (collections.length > 0) out.variableCollections = collections;
  if (records.length > 0) out.variableRecords = records;
  return out as T;
}
