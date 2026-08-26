// Unit tests for the model-catalog pure helpers + API-route dispatch shape.
//
// The network-touching parts (endpoint /models fetch, ZAI.create() probe,
// ModelRuntime catalog read) are integration-level and covered by the E2E
// browser verification; here we lock down the parsing/enrichment logic that
// is easy to regress.

import { describe, it, expect } from 'vitest';
import {
  parseModelsResponse,
  toSummary,
  buildCatalogIndex,
  endpointModelsFromIds,
} from '@/lib/agent/model-catalog';
import type { Model, Api } from '@earendil-works/pi-ai';

function fakeModel(partial: Partial<Model<Api>>): Model<Api> {
  return {
    id: 'test-model',
    name: 'Test Model',
    api: 'openai-completions',
    provider: 'zai',
    baseUrl: 'https://example.test/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 32768,
    ...partial,
  } as Model<Api>;
}

// ---- parseModelsResponse --------------------------------------------------------

describe('parseModelsResponse', () => {
  it('parses the canonical OpenAI { data: [{ id }] } shape', () => {
    const ids = parseModelsResponse({
      object: 'list',
      data: [
        { id: 'kimi-k2-5', object: 'model' },
        { id: 'glm-5.3', object: 'model' },
      ],
    });
    expect(ids).toEqual(['kimi-k2-5', 'glm-5.3']);
  });

  it('parses a bare string array (some proxies do this)', () => {
    expect(parseModelsResponse(['llama-3', 'qwen-max'])).toEqual(['llama-3', 'qwen-max']);
  });

  it('parses { models: [...] } variants', () => {
    expect(parseModelsResponse({ models: [{ id: 'm1' }, { id: 'm2' }] })).toEqual(['m1', 'm2']);
    expect(parseModelsResponse({ models: ['m1'] })).toEqual(['m1']);
  });

  it('parses { data: ["id"] } (string entries in data)', () => {
    expect(parseModelsResponse({ data: ['a', 'b'] })).toEqual(['a', 'b']);
  });

  it('dedupes ids', () => {
    expect(parseModelsResponse({ data: [{ id: 'x' }, { id: 'x' }] })).toEqual(['x']);
  });

  it('returns [] for unrecognized shapes and skips non-string ids', () => {
    expect(parseModelsResponse(null)).toEqual([]);
    expect(parseModelsResponse({})).toEqual([]);
    expect(parseModelsResponse({ data: [{ object: 'model' }, 42, { id: '' }] })).toEqual([]);
    expect(parseModelsResponse('string')).toEqual([]);
  });

  it('handles null items and non-object bodies gracefully', () => {
    expect(parseModelsResponse({ data: [null, { id: 'ok' }] })).toEqual(['ok']);
  });
});

// ---- toSummary --------------------------------------------------------------------

describe('toSummary', () => {
  it('maps a pi-ai catalog Model to the wire summary', () => {
    const s = toSummary(fakeModel({
      id: 'glm-5.3', name: 'GLM 5.3', contextWindow: 1_000_000, maxTokens: 131_072,
      reasoning: true, input: ['text', 'image'],
    }));
    expect(s).toEqual({
      id: 'glm-5.3', name: 'GLM 5.3', contextWindow: 1_000_000,
      maxTokens: 131_072, reasoning: true, input: ['text', 'image'],
    });
  });

  it('falls back to the id when the catalog name is empty', () => {
    expect(toSummary(fakeModel({ id: 'x', name: '' })).name).toBe('x');
  });
});

// ---- buildCatalogIndex + endpointModelsFromIds --------------------------------------

describe('catalog enrichment of endpoint model ids', () => {
  const catalog = [
    fakeModel({ id: 'glm-5.3', contextWindow: 1_000_000, reasoning: true }),
    fakeModel({ id: 'gpt-4o', contextWindow: 128_000, input: ['text', 'image'] }),
    fakeModel({ id: 'gpt-4o', provider: 'openai', contextWindow: 128_000 }), // dup id — first wins
  ];
  const idx = buildCatalogIndex(catalog);

  it('indexes by model id with first-occurrence priority', () => {
    expect(idx.size).toBe(2);
    expect(idx.get('gpt-4o')?.provider).toBe('zai'); // the FIRST gpt-4o in the list
  });

  it('enriches matching endpoint ids with catalog metadata (fromCatalog=true)', () => {
    const out = endpointModelsFromIds(['glm-5.3'], idx);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 'glm-5.3',
      contextWindow: 1_000_000,
      reasoning: true,
      fromCatalog: true,
    });
  });

  it('returns null window metadata for unknown endpoint models', () => {
    const out = endpointModelsFromIds(['niche-proxy-model'], idx);
    expect(out[0]).toMatchObject({
      id: 'niche-proxy-model',
      contextWindow: null,
      maxTokens: null,
      fromCatalog: false,
    });
  });

  it('mixes known and unknown ids in order', () => {
    const out = endpointModelsFromIds(['unknown-1', 'gpt-4o'], idx);
    expect(out.map((m) => m.id)).toEqual(['unknown-1', 'gpt-4o']);
    expect(out.map((m) => m.fromCatalog)).toEqual([false, true]);
  });

  it('caps the endpoint list to prevent huge payloads', () => {
    const ids = Array.from({ length: 200 }, (_, i) => `m-${i}`);
    const out = endpointModelsFromIds(ids, idx);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out[0]?.id).toBe('m-0'); // keeps the first entries, drops the tail
  });
});
