// Server-side loader for the Design-System Registry.
//
// Reads `registry.json` from disk at startup (and caches in memory),
// resolves a pack's tokens.css content on demand, and exposes simple
// typed accessors. Used by the API routes in
// `src/app/api/design-systems/`.
//
// NOTE: This module is server-only. It uses `fs` and `path`, which
// are not available in the browser. The client uses the API routes
// to fetch pack data instead.

import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cache } from 'react';
import type {
  DesignSystemPack,
  DesignSystemRegistry,
  PackDetail,
  PackSummary,
} from './types';

// ── Path resolution ──────────────────────────────────────────────────
// ESM-safe path to this module's directory. Works in both `next dev`
// and `next build` because Next.js bundles server modules as ESM.
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = join(MODULE_DIR, 'registry.json');
const PACKS_DIR = join(MODULE_DIR, 'packs');

// ── Registry cache ───────────────────────────────────────────────────
// `cache()` from React 19 wraps the function so the same registry is
// reused across concurrent requests in a single render pass. We
// additionally memoize on a module-level variable so it survives
// across renders (the registry is read-only at runtime).
let _registryCache: DesignSystemRegistry | null = null;

/** Load and parse the registry.json file. Cached. */
export const loadRegistry = cache(async (): Promise<DesignSystemRegistry> => {
  if (_registryCache) return _registryCache;
  const raw = await readFile(REGISTRY_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as DesignSystemRegistry;
  // Basic shape check — for a full schema check, the agent would run
  // `ajv` against `_registry.schema.json`, but here we just trust
  // the in-repo source.
  if (!parsed.packs || !Array.isArray(parsed.packs)) {
    throw new Error('Invalid registry: missing `packs` array');
  }
  if (!parsed.defaultPack || !parsed.packs.some((p) => p.name === parsed.defaultPack)) {
    throw new Error(`Invalid registry: defaultPack "${parsed.defaultPack}" not in packs`);
  }
  _registryCache = parsed;
  return parsed;
});

// ── Pack accessors ───────────────────────────────────────────────────

/**
 * Get a list of pack summaries (metadata only — no tokens, no samples).
 * Used for the picker UI's initial render.
 */
export async function listPacks(): Promise<PackSummary[]> {
  const registry = await loadRegistry();
  return registry.packs.map((p) => ({
    name: p.name,
    version: p.version,
    description: p.description,
    palette: p.palette,
    fontStack: p.fontStack,
    bestFor: p.bestFor,
    isDefault: p.name === registry.defaultPack,
  }));
}

/**
 * Get the full detail for a single pack — including raw tokens.css
 * content, dependencies, import map, and sample component snippets.
 * Throws if `name` is not in the registry.
 */
export async function getPackDetail(name: string): Promise<PackDetail> {
  const registry = await loadRegistry();
  const pack = registry.packs.find((p) => p.name === name);
  if (!pack) {
    throw new Error(`Pack not found: ${name}`);
  }
  const tokensPath = join(PACKS_DIR, pack.name, pack.tokens);
  if (!existsSync(tokensPath)) {
    throw new Error(`tokens.css not found for pack "${pack.name}" at ${tokensPath}`);
  }
  const tokensCss = await readFile(tokensPath, 'utf-8');
  return {
    name: pack.name,
    version: pack.version,
    description: pack.description,
    palette: pack.palette,
    fontStack: pack.fontStack,
    bestFor: pack.bestFor,
    isDefault: pack.name === registry.defaultPack,
    dependencies: pack.dependencies,
    importMap: pack.importMap,
    sampleComponents: pack.sampleComponents,
    tokensCss,
  };
}

/**
 * Get a single pack's raw tokens.css content only. Cheaper than
 * `getPackDetail` — used when the agent just needs the CSS to inject
 * into globals.css.
 */
export async function getPackTokens(name: string): Promise<string> {
  const registry = await loadRegistry();
  const pack = registry.packs.find((p) => p.name === name);
  if (!pack) {
    throw new Error(`Pack not found: ${name}`);
  }
  const tokensPath = join(PACKS_DIR, pack.name, pack.tokens);
  return readFile(tokensPath, 'utf-8');
}

/** Get the default pack's full detail. */
export async function getDefaultPack(): Promise<PackDetail> {
  const registry = await loadRegistry();
  return getPackDetail(registry.defaultPack);
}

/** Get a single pack entry (without tokens). Used internally. */
export async function getPack(name: string): Promise<DesignSystemPack | undefined> {
  const registry = await loadRegistry();
  return registry.packs.find((p) => p.name === name);
}

/** True if the named pack exists in the registry. */
export async function hasPack(name: string): Promise<boolean> {
  const registry = await loadRegistry();
  return registry.packs.some((p) => p.name === name);
}

// ── Health check (for tests + agent dependency verification) ─────────

/**
 * Walk the registry and verify every referenced tokens.css file exists
 * on disk. Returns a list of issues; empty array = healthy.
 */
export async function verifyRegistry(): Promise<string[]> {
  const issues: string[] = [];
  const registry = await loadRegistry();
  for (const pack of registry.packs) {
    const tokensPath = join(PACKS_DIR, pack.name, pack.tokens);
    if (!existsSync(tokensPath)) {
      issues.push(`Pack "${pack.name}": tokens.css missing at ${tokensPath}`);
      continue;
    }
    const stats = await stat(tokensPath);
    if (stats.size === 0) {
      issues.push(`Pack "${pack.name}": tokens.css is empty`);
    }
    // Verify every sampleComponent has non-empty code.
    for (const sc of pack.sampleComponents) {
      if (!sc.code || sc.code.trim().length === 0) {
        issues.push(`Pack "${pack.name}": sample component "${sc.name}" has empty code`);
      }
    }
  }
  return issues;
}
