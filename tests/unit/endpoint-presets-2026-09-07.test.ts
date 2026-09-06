// Endpoint presets (BETA) — 2026-09-07 regression tests.
//
// The BETA endpoint (owner-configured, 2026-09-07: kimi-k2-5 behind a
// pinggy tunnel, key '123456') is stored IN APP CODE as a named
// OpenAI-compatible preset — `src/lib/llm/endpoint-presets.ts`. These
// tests pin:
//   1. the preset's exact shape (values must not drift silently),
//   2. endpointPresetPatch / matchesEndpointPreset semantics,
//   3. UI wiring — SettingsDialog renders the presets row from the module,
//   4. barrel exports from '@/lib/llm',
//   5. source-scan invariants that enforce the DURABLE ACCESS RULE (root
//      AGENTS.md "LLM Endpoint Access Policy"): the e2e script must import
//      the preset from app code and must NOT embed the endpoint URL (no
//      out-of-app invocation path), and the root AGENTS.md must carry the
//      rule so future agents inherit it.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BETA_ENDPOINT,
  ENDPOINT_PRESETS,
  getEndpointPreset,
  endpointPresetPatch,
  matchesEndpointPreset,
} from '@/lib/llm/endpoint-presets';
import {
  BETA_ENDPOINT as BETA_FROM_BARREL,
  ENDPOINT_PRESETS as PRESETS_FROM_BARREL,
  endpointPresetPatch as patch_FROM_BARREL,
} from '@/lib/llm';
import { DEFAULT_SETTINGS, agentRunSettings, type AppSettings } from '@/lib/settings/types';

const ROOT = process.cwd();
const readSrc = (rel: string) => readFileSync(join(ROOT, 'src', rel), 'utf8');
const readRoot = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

// ---- 1. Preset shape ----------------------------------------------------------

describe('BETA endpoint preset shape', () => {
  it('is the first (and currently only) code-resident preset', () => {
    expect(ENDPOINT_PRESETS.length).toBeGreaterThanOrEqual(1);
    expect(ENDPOINT_PRESETS[0]).toBe(BETA_ENDPOINT);
  });

  it('pins the owner-supplied values exactly (2026-09-07 directive)', () => {
    expect(BETA_ENDPOINT).toMatchObject({
      id: 'beta',
      label: 'BETA',
      provider: 'custom',
      baseURL: 'https://irhnglwoxe.a.pinggy.link/v1',
      apiKey: '123456',
      defaultModel: 'kimi-k2-5',
    });
    expect(BETA_ENDPOINT.description.length).toBeGreaterThan(20);
  });

  it('baseURL is a well-formed OpenAI-compatible /v1 URL', () => {
    expect(BETA_ENDPOINT.baseURL).toMatch(/^https:\/\/.+\/v1$/);
    expect(BETA_ENDPOINT.baseURL.endsWith('/')).toBe(false);
  });

  it('getEndpointPreset finds by id and rejects unknown ids', () => {
    expect(getEndpointPreset('beta')).toBe(BETA_ENDPOINT);
    expect(getEndpointPreset('nope')).toBeUndefined();
  });
});

// ---- 2. Patch + match semantics -------------------------------------------------

describe('endpointPresetPatch', () => {
  it('produces the four custom-provider fields with the preset values', () => {
    expect(endpointPresetPatch(BETA_ENDPOINT)).toEqual({
      llmProvider: 'custom',
      apiKey: '123456',
      modelName: 'kimi-k2-5',
      apiBaseUrl: 'https://irhnglwoxe.a.pinggy.link/v1',
    });
  });

  it('patches cleanly over the z.ai default settings', () => {
    const next: AppSettings = { ...DEFAULT_SETTINGS, ...endpointPresetPatch(BETA_ENDPOINT) };
    expect(normalize(next.llmProvider)).toBe('custom');
    expect(next.apiBaseUrl).toBe(BETA_ENDPOINT.baseURL);
    // The run-settings extractor (client → POST /api/agent body) must carry
    // the preset fields through untouched.
    const run = agentRunSettings(next);
    expect(run.llmProvider).toBe('custom');
    expect(run.apiBaseUrl).toBe(BETA_ENDPOINT.baseURL);
    expect(run.modelName).toBe(BETA_ENDPOINT.defaultModel);
    expect(run.apiKey).toBe(BETA_ENDPOINT.apiKey);
  });
});

function normalize(id: string): string {
  // Local import-free mirror of normalizeLLMProvider's custom branch to
  // avoid a circular import in this assertion file.
  return id === 'openai-compatible' ? 'custom' : id;
}

describe('matchesEndpointPreset', () => {
  it('matches only the exact four-field configuration', () => {
    const exact = endpointPresetPatch(BETA_ENDPOINT);
    expect(matchesEndpointPreset(exact, BETA_ENDPOINT)).toBe(true);
    expect(matchesEndpointPreset({ ...exact, apiKey: 'other' }, BETA_ENDPOINT)).toBe(false);
    expect(matchesEndpointPreset({ ...exact, modelName: 'gpt-4o' }, BETA_ENDPOINT)).toBe(false);
    expect(matchesEndpointPreset({ ...exact, apiBaseUrl: 'https://elsewhere/v1' }, BETA_ENDPOINT)).toBe(false);
    expect(matchesEndpointPreset({ ...exact, llmProvider: 'zai' }, BETA_ENDPOINT)).toBe(false);
  });

  it('treats missing/undefined fields and nullish input as non-matching', () => {
    expect(matchesEndpointPreset(undefined, BETA_ENDPOINT)).toBe(false);
    expect(matchesEndpointPreset(null, BETA_ENDPOINT)).toBe(false);
    expect(matchesEndpointPreset({}, BETA_ENDPOINT)).toBe(false);
    // Partial: right URL but nothing else — not active.
    expect(matchesEndpointPreset({ apiBaseUrl: BETA_ENDPOINT.baseURL }, BETA_ENDPOINT)).toBe(false);
  });

  it('default settings (z.ai sandbox) never light the BETA chip', () => {
    expect(matchesEndpointPreset(DEFAULT_SETTINGS, BETA_ENDPOINT)).toBe(false);
  });
});

// ---- 3. Barrel exports ----------------------------------------------------------

describe('llm barrel re-exports the preset module', () => {
  it('@/lib/llm exposes the same objects', () => {
    expect(BETA_FROM_BARREL).toBe(BETA_ENDPOINT);
    expect(PRESETS_FROM_BARREL).toBe(ENDPOINT_PRESETS);
    expect(patch_FROM_BARREL(BETA_ENDPOINT)).toEqual(endpointPresetPatch(BETA_ENDPOINT));
  });
});

// ---- 4. UI wiring -----------------------------------------------------------------

describe('SettingsDialog preset chips (source-scan)', () => {
  const dialog = readSrc('components/settings/SettingsDialog.tsx');

  it('imports the preset module and renders chips from ENDPOINT_PRESETS', () => {
    expect(dialog).toContain('ENDPOINT_PRESETS');
    expect(dialog).toContain('endpointPresetPatch');
    expect(dialog).toContain('matchesEndpointPreset');
    // Chips apply the patch through the store's patch() — atomic multi-field.
    expect(dialog).toContain('patchSettings(endpointPresetPatch(preset))');
  });

  it('renders the preset label + an active-state indicator', () => {
    expect(dialog).toContain('{preset.label}');
    expect(dialog).toContain('aria-pressed={active}');
  });
});

// ---- 5. Durable access rule (DOX) --------------------------------------------------

describe('durable no-direct-invocation rule (source-scan)', () => {
  const e2e = readFileSync(join(ROOT, 'scripts', 'verify-beta-endpoint.ts'), 'utf8');

  it('the e2e script imports the preset from app code, not hardcoded values', () => {
    expect(e2e).toContain("from '@/lib/llm/endpoint-presets'");
    expect(e2e).toContain('endpointPresetPatch');
  });

  it('the e2e script never embeds the endpoint URL or key — no out-of-app invocation path', () => {
    expect(e2e).not.toContain('pinggy.link');
    expect(e2e).not.toContain("'123456'");
    // All endpoint interaction is via the app's own HTTP surface.
    expect(e2e).toContain("/api/models");
    expect(e2e).toContain("/api/agent");
  });

  it('the preset module documents the access rule for future readers', () => {
    const module = readSrc('lib/llm/endpoint-presets.ts');
    expect(module).toContain('NEVER be invoked directly');
  });

  it('the root AGENTS.md records the durable rule (project-wide, all future events)', () => {
    const dox = readRoot('AGENTS.md');
    expect(dox).toContain('LLM Endpoint Access Policy');
    expect(dox).toContain('never be invoked directly');
    // The rule must name the preset so future agents can resolve it.
    expect(dox).toContain('endpoint-presets');
  });
});
