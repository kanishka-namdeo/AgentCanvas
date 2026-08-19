// LLM provider abstraction — unit tests.

import { describe, it, expect, vi } from 'vitest';
import {
  PROVIDERS,
  listProviders,
  listProviderIds,
  getProvider,
  getProviderMetadata,
  createLLMClient,
} from '@/lib/llm';
import { createOpenAICompatible } from '@/lib/llm/openai-compatible';
import { createAnthropicClient } from '@/lib/llm/anthropic';
import { createGeminiClient } from '@/lib/llm/gemini';
import {
  normalizeLLMProvider,
  providerRequiresApiKey,
  providerDefaultModel,
  providerDefaultBaseURL,
} from '@/lib/settings/types';

describe('LLM provider registry', () => {
  it('registers all 18 expected provider ids', () => {
    const ids = listProviderIds();
    expect(ids.length).toBe(18);
    const expected = [
      'zai', 'openai', 'anthropic', 'google',
      'mistral', 'cohere',
      'groq', 'together', 'deepseek', 'openrouter',
      'fireworks', 'xai', 'perplexity', 'huggingface',
      'ollama', 'lmstudio', 'vllm',
      'custom',
    ];
    for (const id of expected) {
      expect(ids).toContain(id);
    }
  });

  it('every provider has a label, description, and factory', () => {
    for (const [id, entry] of Object.entries(PROVIDERS)) {
      expect(entry.metadata.id, `${id} metadata.id`).toBe(id);
      expect(entry.metadata.label, `${id} label`).toBeTruthy();
      expect(entry.metadata.capabilities, `${id} capabilities`).toBeDefined();
      expect(typeof entry.factory, `${id} factory`).toBe('function');
    }
  });

  it('getProvider throws for unknown ids', () => {
    expect(() => getProvider('nonexistent')).toThrow(/Unknown LLM provider/);
  });

  it('getProviderMetadata returns undefined for unknown ids (vs throwing)', () => {
    expect(getProviderMetadata('nonexistent')).toBeUndefined();
  });

  it('listProviders returns id + metadata for every entry', () => {
    const list = listProviders();
    expect(list.length).toBe(18);
    for (const item of list) {
      expect(item.id).toBeTruthy();
      expect(item.metadata.label).toBeTruthy();
    }
  });
});

describe('provider capability flags', () => {
  it('marks OpenAI/Anthropic/Google as supporting tools + vision', () => {
    for (const id of ['openai', 'anthropic', 'google', 'zai']) {
      const meta = getProviderMetadata(id);
      expect(meta?.capabilities.supportsToolCalling, `${id} tools`).toBe(true);
      expect(meta?.capabilities.supportsVision, `${id} vision`).toBe(true);
    }
  });

  it('marks Hugging Face and LM Studio as NOT supporting tools', () => {
    expect(getProviderMetadata('huggingface')?.capabilities.supportsToolCalling).toBe(false);
    expect(getProviderMetadata('lmstudio')?.capabilities.supportsToolCalling).toBe(false);
  });

  it('marks every OpenAI-compatible provider with openAICompatible=true', () => {
    for (const [id, entry] of Object.entries(PROVIDERS)) {
      if (id === 'anthropic' || id === 'google') {
        expect(entry.metadata.openAICompatible, `${id} should be native`).toBe(false);
      } else {
        expect(entry.metadata.openAICompatible, `${id} should be OpenAI-compat`).toBe(true);
      }
    }
  });
});

describe('apiKeyRequired flag', () => {
  it('requires keys for cloud providers', () => {
    expect(providerRequiresApiKey('openai')).toBe(true);
    expect(providerRequiresApiKey('anthropic')).toBe(true);
    expect(providerRequiresApiKey('google')).toBe(true);
    expect(providerRequiresApiKey('groq')).toBe(true);
    expect(providerRequiresApiKey('together')).toBe(true);
  });

  it('does NOT require keys for local providers', () => {
    expect(providerRequiresApiKey('ollama')).toBe(false);
    expect(providerRequiresApiKey('lmstudio')).toBe(false);
    expect(providerRequiresApiKey('vllm')).toBe(false);
  });

  it('does NOT require a key for z.ai or custom', () => {
    expect(providerRequiresApiKey('zai')).toBe(false);
    expect(providerRequiresApiKey('custom')).toBe(false);
  });
});

describe('normalizeLLMProvider (legacy migration)', () => {
  it('maps zai-auto → zai', () => {
    expect(normalizeLLMProvider('zai-auto')).toBe('zai');
  });

  it('maps zai-key → zai', () => {
    expect(normalizeLLMProvider('zai-key')).toBe('zai');
  });

  it('maps openai-compatible → custom', () => {
    expect(normalizeLLMProvider('openai-compatible')).toBe('custom');
  });

  it('passes through current ids unchanged', () => {
    for (const id of listProviderIds()) {
      expect(normalizeLLMProvider(id)).toBe(id);
    }
  });

  it('falls back to zai for unknown ids', () => {
    expect(normalizeLLMProvider('unknown-future-provider')).toBe('zai');
    expect(normalizeLLMProvider('')).toBe('zai');
    expect(normalizeLLMProvider(null)).toBe('zai');
    expect(normalizeLLMProvider(undefined)).toBe('zai');
  });
});

describe('providerDefaultModel / providerDefaultBaseURL', () => {
  it('returns the OpenAI default model', () => {
    expect(providerDefaultModel('openai')).toBe('gpt-4o');
  });

  it('returns the Anthropic default model', () => {
    expect(providerDefaultModel('anthropic')).toBe('claude-3-5-sonnet-20241022');
  });

  it('returns the OpenAI default base URL', () => {
    expect(providerDefaultBaseURL('openai')).toBe('https://api.openai.com/v1');
  });

  it('returns empty string for the custom provider', () => {
    expect(providerDefaultModel('custom')).toBe('');
    expect(providerDefaultBaseURL('custom')).toBe('');
  });
});

describe('createOpenAICompatible', () => {
  it('produces an LLMClient with chat.completions.create', () => {
    const client = createOpenAICompatible({
      apiKey: 'sk-test',
      baseURL: 'https://api.openai.com/v1',
      model: 'gpt-4o',
    });
    expect(typeof client.chat.completions.create).toBe('function');
  });

  it('throws when baseURL is missing', () => {
    expect(() =>
      createOpenAICompatible({ apiKey: '', baseURL: '', model: 'gpt-4o' }),
    ).toThrow(/baseURL/);
  });

  it('throws when model is missing', () => {
    expect(() =>
      createOpenAICompatible({ apiKey: '', baseURL: 'https://example.com/v1', model: '' }),
    ).toThrow(/model/);
  });
});

describe('native adapter construction', () => {
  it('createAnthropicClient produces a client', () => {
    const client = createAnthropicClient({
      apiKey: 'sk-ant-test',
      model: 'claude-3-5-sonnet-20241022',
    });
    expect(typeof client.chat.completions.create).toBe('function');
  });

  it('createGeminiClient produces a client', () => {
    const client = createGeminiClient({
      apiKey: 'AIza-test',
      model: 'gemini-1.5-pro',
    });
    expect(typeof client.chat.completions.create).toBe('function');
  });
});

describe('createLLMClient (registry)', () => {
  it('constructs an OpenAI-compatible client for the openai provider', async () => {
    const client = await createLLMClient({
      providerId: 'openai',
      apiKey: 'sk-test',
      baseURL: 'https://api.openai.com/v1',
      model: 'gpt-4o',
    });
    expect(typeof client.chat.completions.create).toBe('function');
  });

  it('constructs an Anthropic client', async () => {
    const client = await createLLMClient({
      providerId: 'anthropic',
      apiKey: 'sk-ant-test',
      baseURL: '',
      model: 'claude-3-5-sonnet-20241022',
    });
    expect(typeof client.chat.completions.create).toBe('function');
  });

  it('constructs a Gemini client', async () => {
    const client = await createLLMClient({
      providerId: 'google',
      apiKey: 'AIza-test',
      baseURL: '',
      model: 'gemini-1.5-pro',
    });
    expect(typeof client.chat.completions.create).toBe('function');
  });

  it('falls back to env vars when apiKey is empty (OpenAI-compat)', async () => {
    const prevKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-from-env';
    try {
      const client = await createLLMClient({
        providerId: 'openai',
        apiKey: '',
        baseURL: '',
        model: '',
      });
      expect(typeof client.chat.completions.create).toBe('function');
    } finally {
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevKey;
    }
  });

  it('throws when an OpenAI-compat provider has no baseURL and no default', async () => {
    await expect(
      createLLMClient({
        providerId: 'custom',
        apiKey: '',
        baseURL: '',
        model: 'some-model',
      }),
    ).rejects.toThrow(/base URL/);
  });

  it('throws when no model is provided for a provider with no default', async () => {
    await expect(
      createLLMClient({
        providerId: 'custom',
        apiKey: '',
        baseURL: 'https://example.com/v1',
        model: '',
      }),
    ).rejects.toThrow(/model/);
  });

  it('throws for unknown provider ids', async () => {
    await expect(
      createLLMClient({
        providerId: 'nonexistent',
        apiKey: '',
        baseURL: '',
        model: '',
      }),
    ).rejects.toThrow(/Unknown LLM provider/);
  });
});

describe('wrapNoTools behavior', () => {
  it('strips tools from requests to providers that do not support them', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      text: async () => '',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as any;

    try {
      const client = await createLLMClient({
        providerId: 'huggingface',
        apiKey: 'hf_test',
        baseURL: 'https://example.com/v1',
        model: 'meta-llama/Llama-3-70B',
      });
      await client.chat.completions.create({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'test_tool',
              description: 'test',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
        tool_choice: 'auto',
      } as any);

      const call = fetchMock.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch as any;
    }
  });
});

describe('Gemini adapter — spec compliance regression tests', () => {
  // Regression test for BUG-1 (spec-compliance-verification.md):
  // Gemini's REST spec requires `tools` to be an array of Tool wrappers,
  // each containing a SINGLE `functionDeclarations` ARRAY (not one object
  // per declaration in separate wrappers). The old impl produced the wrong
  // shape and Gemini rejected it for any prompt with 2+ tools.
  it('translateTools groups all declarations into ONE Tool wrapper with a functionDeclarations ARRAY', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      }),
      text: async () => '',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as any;

    try {
      const client = createGeminiClient({
        apiKey: 'AIza-test',
        model: 'gemini-1.5-pro',
      });
      await client.chat.completions.create({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          { type: 'function', function: { name: 'tool1', description: 'd1', parameters: {} } },
          { type: 'function', function: { name: 'tool2', description: 'd2', parameters: {} } },
          { type: 'function', function: { name: 'tool3', description: 'd3', parameters: {} } },
        ],
        tool_choice: 'auto',
      } as any);

      const call = fetchMock.mock.calls[0];
      const body = JSON.parse(call[1].body);
      // tools must be a single-element array containing ONE Tool wrapper.
      expect(Array.isArray(body.tools)).toBe(true);
      expect(body.tools.length).toBe(1);
      // functionDeclarations must be an ARRAY of declaration objects.
      expect(Array.isArray(body.tools[0].functionDeclarations)).toBe(true);
      expect(body.tools[0].functionDeclarations.length).toBe(3);
      expect(body.tools[0].functionDeclarations[0].name).toBe('tool1');
      expect(body.tools[0].functionDeclarations[2].name).toBe('tool3');
      // tool_choice='auto' must translate to toolConfig.functionCallingConfig.mode='AUTO'.
      expect(body.toolConfig).toBeDefined();
      expect(body.toolConfig.functionCallingConfig.mode).toBe('AUTO');
    } finally {
      globalThis.fetch = originalFetch as any;
    }
  });

  it('tool_choice="required" translates to mode=ANY', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      }),
      text: async () => '',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as any;

    try {
      const client = createGeminiClient({ apiKey: 'AIza-test', model: 'gemini-1.5-pro' });
      await client.chat.completions.create({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          { type: 'function', function: { name: 't', description: 'd', parameters: {} } },
        ],
        tool_choice: 'required',
      } as any);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.toolConfig.functionCallingConfig.mode).toBe('ANY');
    } finally {
      globalThis.fetch = originalFetch as any;
    }
  });

  it('tool_choice={function:{name}} translates to mode=ANY + allowedFunctionNames', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      }),
      text: async () => '',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as any;

    try {
      const client = createGeminiClient({ apiKey: 'AIza-test', model: 'gemini-1.5-pro' });
      await client.chat.completions.create({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          { type: 'function', function: { name: 't1', description: 'd', parameters: {} } },
          { type: 'function', function: { name: 't2', description: 'd', parameters: {} } },
        ],
        tool_choice: { type: 'function', function: { name: 't1' } },
      } as any);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.toolConfig.functionCallingConfig.mode).toBe('ANY');
      expect(body.toolConfig.functionCallingConfig.allowedFunctionNames).toEqual(['t1']);
    } finally {
      globalThis.fetch = originalFetch as any;
    }
  });

  it('finishReason is normalized to OpenAI lowercase enum', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'MAX_TOKENS' }],
      }),
      text: async () => '',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as any;

    try {
      const client = createGeminiClient({ apiKey: 'AIza-test', model: 'gemini-1.5-pro' });
      const res = await client.chat.completions.create({
        messages: [{ role: 'user', content: 'hi' }],
      } as any);
      expect(res.choices[0].finish_reason).toBe('length');
    } finally {
      globalThis.fetch = originalFetch as any;
    }
  });
});

describe('Anthropic adapter — finish_reason normalization', () => {
  it('end_turn → stop', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: 'hi' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 3 },
      }),
      text: async () => '',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as any;
    try {
      const client = createAnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-3-5-sonnet-20241022' });
      const res = await client.chat.completions.create({
        messages: [{ role: 'user', content: 'hi' }],
      } as any);
      expect(res.choices[0].finish_reason).toBe('stop');
    } finally {
      globalThis.fetch = originalFetch as any;
    }
  });

  it('tool_use → tool_calls', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'tool_use', id: 'tc1', name: 't', input: { x: 1 } }],
        stop_reason: 'tool_use',
      }),
      text: async () => '',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as any;
    try {
      const client = createAnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-3-5-sonnet-20241022' });
      const res = await client.chat.completions.create({
        messages: [{ role: 'user', content: 'hi' }],
      } as any);
      expect(res.choices[0].finish_reason).toBe('tool_calls');
      expect(res.choices[0].message.tool_calls).toBeDefined();
      expect(res.choices[0].message.tool_calls![0].function.name).toBe('t');
    } finally {
      globalThis.fetch = originalFetch as any;
    }
  });
});
