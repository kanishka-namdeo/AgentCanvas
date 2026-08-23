// LLM provider registry.
//
// The registry is a static Map<providerId, LLMProviderEntry> pre-populated
// with 28 of the most popular LLM providers (27 named + 1 generic 'custom'
// escape hatch). Each entry has:
//
//   metadata  — display name, docs URL, default base URL, popular models,
//               capability flags, etc. (consumed by the Settings UI)
//   factory   — async (config) => LLMClient (called by runner.ts)
//
// 23 of the 28 providers are OpenAI-API-compatible and share one factory
// (`openAICompatibleFactory`). 3 providers (Anthropic, Google Gemini, z.ai)
// have native adapters. The 17th entry is `custom` — a user-supplied
// OpenAI-compatible endpoint with no preset defaults (escape hatch for
// niche providers).

import type {
  LLMClient, LLMClientFactory, LLMProviderEntry, LLMProviderConfig, LLMProviderMetadata,
} from './types';
import { createOpenAICompatible } from './openai-compatible';
import { createAnthropicClient } from './anthropic';
import { createGeminiClient } from './gemini';

// Re-export types for convenience.
export type {
  LLMClient, LLMClientFactory, LLMProviderEntry, LLMProviderConfig, LLMProviderMetadata,
  LLMMessage, LLMToolSpec, LLMResponse, LLMGenerateParams,
  LLMProviderCapabilities,
} from './types';

// ---- Factory helpers -------------------------------------------------------

function openAICompatibleFactory(meta: LLMProviderMetadata): LLMClientFactory {
  return async (config: LLMProviderConfig): Promise<LLMClient> => {
    let apiKey = config.apiKey;
    if (!apiKey) {
      for (const envVar of meta.apiKeyEnvVars) {
        const val = process.env[envVar];
        if (val) { apiKey = val; break; }
      }
    }

    const baseURL = config.baseURL || meta.defaultBaseURL;
    const model = config.model || meta.defaultModel;

    if (!baseURL) {
      throw new Error(
        `Provider "${meta.id}" needs a base URL. Set it in Settings → LLM provider → API base URL, ` +
        `or set the corresponding env var.`,
      );
    }
    if (!model) {
      throw new Error(
        `Provider "${meta.id}" needs a model name. Set it in Settings → LLM provider → Model.`,
      );
    }

    const inner = createOpenAICompatible({ apiKey: apiKey ?? '', baseURL, model });
    if (meta.capabilities.supportsToolCalling) {
      return inner;
    }
    return wrapNoTools(inner);
  };
}

function wrapNoTools(inner: LLMClient): LLMClient {
  return {
    chat: {
      completions: {
        create: async (params) => {
          const { tools: _tools, tool_choice: _tc, ...rest } = params;
          void _tools; void _tc;
          return inner.chat.completions.create(rest);
        },
      },
    },
  };
}

// ---- Capability presets ---------------------------------------------------

const CAPS_FULL: LLMProviderMetadata['capabilities'] = {
  supportsToolCalling: true,
  supportsStreaming: true,
  supportsVision: true,
};

const CAPS_NO_VISION: LLMProviderMetadata['capabilities'] = {
  supportsToolCalling: true,
  supportsStreaming: true,
  supportsVision: false,
};

const CAPS_TOOLS_OK: LLMProviderMetadata['capabilities'] = {
  supportsToolCalling: true,
  supportsStreaming: true,
  supportsVision: false,
};

const CAPS_NO_TOOLS: LLMProviderMetadata['capabilities'] = {
  supportsToolCalling: false,
  supportsStreaming: true,
  supportsVision: false,
};

// ---- Provider metadata definitions -----------------------------------------

export const PROVIDERS: Record<string, LLMProviderEntry> = {
  zai: {
    metadata: {
      id: 'zai', label: 'z.ai (GLM)',
      description: 'Auto-resolves credentials inside the z.ai sandbox. Outside, set ZAI_API_KEY.',
      docsUrl: 'https://docs.z.ai',
      apiKeyEnvVars: ['ZAI_API_KEY'],
      defaultBaseURL: 'https://api.z.ai/api/paas/v4',
      defaultModel: 'glm-5.3',
      popularModels: ['glm-5.3', 'glm-5.2', 'glm-5.2-highspeed', 'glm-5-turbo', 'glm-4.7', 'glm-4.6', 'glm-4.5', 'glm-4.5-air', 'glm-4.5-flash'],
      openAICompatible: true,
      capabilities: CAPS_FULL,
      apiKeyRequired: false,
    },
    factory: openAICompatibleFactory({
      id: 'zai', label: 'z.ai', description: '', docsUrl: '',
      apiKeyEnvVars: ['ZAI_API_KEY'],
      defaultBaseURL: 'https://api.z.ai/api/paas/v4',
      defaultModel: 'glm-5.3',
      popularModels: [],
      openAICompatible: true,
      capabilities: CAPS_FULL,
      apiKeyRequired: false,
    }),
  },

  openai: {
    metadata: {
      id: 'openai', label: 'OpenAI',
      description: 'GPT-4o, GPT-4 Turbo, o1, o3-mini. The reference implementation.',
      docsUrl: 'https://platform.openai.com/api-keys',
      apiKeyEnvVars: ['OPENAI_API_KEY'],
      defaultBaseURL: 'https://api.openai.com/v1',
      defaultModel: 'gpt-4o',
      popularModels: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4.1', 'gpt-4.1-mini', 'o1', 'o1-mini', 'o3-mini'],
      openAICompatible: true,
      capabilities: CAPS_FULL,
      apiKeyRequired: true,
    },
    factory: openAICompatibleFactory({
      id: 'openai', label: 'OpenAI', description: '', docsUrl: '',
      apiKeyEnvVars: ['OPENAI_API_KEY'],
      defaultBaseURL: 'https://api.openai.com/v1',
      defaultModel: 'gpt-4o',
      popularModels: [],
      openAICompatible: true,
      capabilities: CAPS_FULL,
      apiKeyRequired: true,
    }),
  },

  anthropic: {
    metadata: {
      id: 'anthropic', label: 'Anthropic (Claude)',
      description: 'Claude 3.5 Sonnet, Haiku, Opus. Native API (not OpenAI-compatible).',
      docsUrl: 'https://console.anthropic.com/settings/keys',
      apiKeyEnvVars: ['ANTHROPIC_API_KEY'],
      defaultBaseURL: '',
      defaultModel: 'claude-3-5-sonnet-20241022',
      popularModels: [
        'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022',
        'claude-3-opus-20240229', 'claude-3-sonnet-20240229', 'claude-3-haiku-20240307',
      ],
      openAICompatible: false,
      capabilities: CAPS_FULL,
      apiKeyRequired: true,
    },
    factory: async (config: LLMProviderConfig): Promise<LLMClient> => {
      let apiKey = config.apiKey;
      if (!apiKey) apiKey = process.env.ANTHROPIC_API_KEY ?? '';
      return createAnthropicClient({
        apiKey,
        baseURL: config.baseURL || undefined,
        model: config.model || 'claude-3-5-sonnet-20241022',
      });
    },
  },

  google: {
    metadata: {
      id: 'google', label: 'Google Gemini',
      description: 'Gemini 1.5 Pro / Flash. Native API (not OpenAI-compatible).',
      docsUrl: 'https://aistudio.google.com/app/apikey',
      apiKeyEnvVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
      defaultBaseURL: '',
      defaultModel: 'gemini-1.5-pro',
      popularModels: ['gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-1.5-flash-8b', 'gemini-2.0-flash-exp'],
      openAICompatible: false,
      capabilities: CAPS_FULL,
      apiKeyRequired: true,
    },
    factory: async (config: LLMProviderConfig): Promise<LLMClient> => {
      let apiKey = config.apiKey;
      if (!apiKey) {
        apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? '';
      }
      return createGeminiClient({
        apiKey,
        baseURL: config.baseURL || undefined,
        model: config.model || 'gemini-1.5-pro',
      });
    },
  },

  mistral: {
    metadata: {
      id: 'mistral', label: 'Mistral AI',
      description: 'Mistral Large, Codestral, Mixtral. EU-hosted.',
      docsUrl: 'https://console.mistral.ai/api-keys',
      apiKeyEnvVars: ['MISTRAL_API_KEY'],
      defaultBaseURL: 'https://api.mistral.ai/v1',
      defaultModel: 'mistral-large-latest',
      popularModels: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest', 'codestral-latest', 'open-mixtral-8x22b', 'open-mistral-7b'],
      openAICompatible: true,
      capabilities: CAPS_TOOLS_OK,
      apiKeyRequired: true,
    },
    factory: openAICompatibleFactory({
      id: 'mistral', label: 'Mistral', description: '', docsUrl: '',
      apiKeyEnvVars: ['MISTRAL_API_KEY'],
      defaultBaseURL: 'https://api.mistral.ai/v1',
      defaultModel: 'mistral-large-latest',
      popularModels: [],
      openAICompatible: true,
      capabilities: CAPS_TOOLS_OK,
      apiKeyRequired: true,
    }),
  },

  cohere: {
    metadata: {
      id: 'cohere', label: 'Cohere',
      description: 'Command R+, Command R, Aya. OpenAI-compatible endpoint.',
      docsUrl: 'https://dashboard.cohere.com/api-keys',
      apiKeyEnvVars: ['COHERE_API_KEY'],
      defaultBaseURL: 'https://api.cohere.ai/v1',
      defaultModel: 'command-r-plus',
      popularModels: ['command-r-plus', 'command-r', 'command', 'command-light', 'aya-23-8B', 'aya-23-35B'],
      openAICompatible: true,
      capabilities: CAPS_TOOLS_OK,
      apiKeyRequired: true,
    },
    factory: openAICompatibleFactory({
      id: 'cohere', label: 'Cohere', description: '', docsUrl: '',
      apiKeyEnvVars: ['COHERE_API_KEY'],
      defaultBaseURL: 'https://api.cohere.ai/v1',
      defaultModel: 'command-r-plus',
      popularModels: [],
      openAICompatible: true,
      capabilities: CAPS_TOOLS_OK,
      apiKeyRequired: true,
    }),
  },

  groq: {
    metadata: {
      id: 'groq', label: 'Groq',
      description: 'Llama, Mixtral, Gemma on LPUs — extremely fast inference.',
      docsUrl: 'https://console.groq.com/keys',
      apiKeyEnvVars: ['GROQ_API_KEY'],
      defaultBaseURL: 'https://api.groq.com/openai/v1',
      defaultModel: 'llama-3.3-70b-versatile',
      popularModels: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'llama-3.1-70b-versatile', 'mixtral-8x7b-32768', 'gemma2-9b-it'],
      openAICompatible: true,
      capabilities: CAPS_TOOLS_OK,
      apiKeyRequired: true,
    },
    factory: openAICompatibleFactory({
      id: 'groq', label: 'Groq', description: '', docsUrl: '',
      apiKeyEnvVars: ['GROQ_API_KEY'],
      defaultBaseURL: 'https://api.groq.com/openai/v1',
      defaultModel: 'llama-3.3-70b-versatile',
      popularModels: [],
      openAICompatible: true,
      capabilities: CAPS_TOOLS_OK,
      apiKeyRequired: true,
    }),
  },

  together: {
    metadata: {
      id: 'together', label: 'Together AI',
      description: 'Hosted open models — Llama, Qwen, DeepSeek, Stable Diffusion.',
      docsUrl: 'https://api.together.ai/settings/api-keys',
      apiKeyEnvVars: ['TOGETHER_API_KEY'],
      defaultBaseURL: 'https://api.together.ai/v1',
      defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      popularModels: [
        'meta-llama/Llama-3.3-70B-Instruct-Turbo',
        'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo',
        'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
        'Qwen/Qwen2.5-72B-Instruct-Turbo',
        'deepseek-ai/DeepSeek-V3',
        'deepseek-ai/DeepSeek-R1',
      ],
      openAICompatible: true,
      capabilities: CAPS_TOOLS_OK,
      apiKeyRequired: true,
    },
    factory: openAICompatibleFactory({
      id: 'together', label: 'Together AI', description: '', docsUrl: '',
      apiKeyEnvVars: ['TOGETHER_API_KEY'],
      defaultBaseURL: 'https://api.together.ai/v1',
      defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      popularModels: [],
      openAICompatible: true,
      capabilities: CAPS_TOOLS_OK,
      apiKeyRequired: true,
    }),
  },

  deepseek: {
    metadata: {
      id: 'deepseek', label: 'DeepSeek',
      description: 'DeepSeek-V3 / R1 — strong reasoning at low cost.',
      docsUrl: 'https://platform.deepseek.com/api_keys',
      apiKeyEnvVars: ['DEEPSEEK_API_KEY'],
      defaultBaseURL: 'https://api.deepseek.com/v1',
      defaultModel: 'deepseek-chat',
      popularModels: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder'],
      openAICompatible: true,
      capabilities: CAPS_TOOLS_OK,
      apiKeyRequired: true,
    },
    factory: openAICompatibleFactory({
      id: 'deepseek', label: 'DeepSeek', description: '', docsUrl: '',
      apiKeyEnvVars: ['DEEPSEEK_API_KEY'],
      defaultBaseURL: 'https://api.deepseek.com/v1',
      defaultModel: 'deepseek-chat',
      popularModels: [],
      openAICompatible: true,
      capabilities: CAPS_TOOLS_OK,
      apiKeyRequired: true,
    }),
  },

  openrouter: {
    metadata: {
      id: 'openrouter', label: 'OpenRouter',
      description: 'Single API for 200+ models from all major providers.',
      docsUrl: 'https://openrouter.ai/keys',
      apiKeyEnvVars: ['OPENROUTER_API_KEY'],
      defaultBaseURL: 'https://openrouter.ai/api/v1',
      defaultModel: 'openai/gpt-4o',
      popularModels: [
        'openai/gpt-4o', 'openai/gpt-4o-mini', 'openai/o1', 'openai/o3-mini',
        'anthropic/claude-3.5-sonnet', 'anthropic/claude-3.5-haiku',
        'google/gemini-pro-1.5', 'meta-llama/llama-3.3-70b-instruct',
        'deepseek/deepseek-chat', 'mistralai/mistral-large',
        'qwen/qwen-2.5-72b-instruct', 'x-ai/grok-2',
      ],
      openAICompatible: true,
      capabilities: CAPS_FULL,
      apiKeyRequired: true,
    },
    factory: openAICompatibleFactory({
      id: 'openrouter', label: 'OpenRouter', description: '', docsUrl: '',
      apiKeyEnvVars: ['OPENROUTER_API_KEY'],
      defaultBaseURL: 'https://openrouter.ai/api/v1',
      defaultModel: 'openai/gpt-4o',
      popularModels: [],
      openAICompatible: true,
      capabilities: CAPS_FULL,
      apiKeyRequired: true,
    }),
  },

  fireworks: {
    metadata: {
      id: 'fireworks', label: 'Fireworks AI',
      description: 'Fast serverless inference for Llama, Qwen, DeepSeek, Mixtral.',
      docsUrl: 'https://fireworks.ai/account/api-keys',
      apiKeyEnvVars: ['FIREWORKS_API_KEY'],
      defaultBaseURL: 'https://api.fireworks.ai/inference/v1',
      defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
      popularModels: [
        'accounts/fireworks/models/llama-v3p3-70b-instruct',
        'accounts/fireworks/models/llama-v3p1-405b-instruct',
        'accounts/fireworks/models/qwen2p5-72b-instruct',
        'accounts/fireworks/models/deepseek-v3',
        'accounts/fireworks/models/deepseek-r1',
      ],
      openAICompatible: true,
      capabilities: CAPS_TOOLS_OK,
      apiKeyRequired: true,
    },
    factory: openAICompatibleFactory({
      id: 'fireworks', label: 'Fireworks AI', description: '', docsUrl: '',
      apiKeyEnvVars: ['FIREWORKS_API_KEY'],
      defaultBaseURL: 'https://api.fireworks.ai/inference/v1',
      defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
      popularModels: [],
      openAICompatible: true,
      capabilities: CAPS_TOOLS_OK,
      apiKeyRequired: true,
    }),
  },

  xai: {
    metadata: {
      id: 'xai', label: 'xAI (Grok)',
      description: 'Grok-2, Grok-2-Vision, Grok-beta from xAI.',
      docsUrl: 'https://console.x.ai',
      apiKeyEnvVars: ['XAI_API_KEY'],
      defaultBaseURL: 'https://api.x.ai/v1',
      defaultModel: 'grok-2-latest',
      popularModels: ['grok-2-latest', 'grok-2', 'grok-2-vision-latest', 'grok-beta', 'grok-vision-beta'],
      openAICompatible: true,
      capabilities: CAPS_FULL,
      apiKeyRequired: true,
    },
    factory: openAICompatibleFactory({
      id: 'xai', label: 'xAI', description: '', docsUrl: '',
      apiKeyEnvVars: ['XAI_API_KEY'],
      defaultBaseURL: 'https://api.x.ai/v1',
      defaultModel: 'grok-2-latest',
      popularModels: [],
      openAICompatible: true,
      capabilities: CAPS_FULL,
      apiKeyRequired: true,
    }),
  },

  perplexity: {
    metadata: {
      id: 'perplexity', label: 'Perplexity',
      description: 'sonar-pro, sonar-reasoning — online models with built-in search.',
      docsUrl: 'https://docs.perplexity.ai/getting-started-guided-tour/getting-started-with-the-api',
      apiKeyEnvVars: ['PERPLEXITY_API_KEY', 'PPLX_API_KEY'],
      defaultBaseURL: 'https://api.perplexity.ai',
      defaultModel: 'sonar-pro',
      popularModels: ['sonar-pro', 'sonar', 'sonar-reasoning', 'sonar-reasoning-pro', 'sonar-deep-research', 'llama-3.1-sonar-large-128k-online'],
      openAICompatible: true,
      capabilities: CAPS_TOOLS_OK,
      apiKeyRequired: true,
    },
    factory: openAICompatibleFactory({
      id: 'perplexity', label: 'Perplexity', description: '', docsUrl: '',
      apiKeyEnvVars: ['PERPLEXITY_API_KEY', 'PPLX_API_KEY'],
      defaultBaseURL: 'https://api.perplexity.ai',
      defaultModel: 'sonar-pro',
      popularModels: [],
      openAICompatible: true,
      capabilities: CAPS_TOOLS_OK,
      apiKeyRequired: true,
    }),
  },

  huggingface: {
    metadata: {
      id: 'huggingface', label: 'Hugging Face',
      description: 'Inference API for 200k+ community models. Tool support varies.',
      docsUrl: 'https://huggingface.co/settings/tokens',
      apiKeyEnvVars: ['HF_TOKEN', 'HUGGINGFACE_API_KEY'],
      defaultBaseURL: 'https://api-inference.huggingface.co/models',
      defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
      popularModels: [
        'meta-llama/Llama-3.3-70B-Instruct',
        'meta-llama/Meta-Llama-3.1-70B-Instruct',
        'mistralai/Mistral-7B-Instruct-v0.3',
        'Qwen/Qwen2.5-72B-Instruct',
        'deepseek-ai/DeepSeek-V3',
      ],
      openAICompatible: true,
      capabilities: CAPS_NO_TOOLS,
      apiKeyRequired: true,
    },
    factory: openAICompatibleFactory({
      id: 'huggingface', label: 'Hugging Face', description: '', docsUrl: '',
      apiKeyEnvVars: ['HF_TOKEN', 'HUGGINGFACE_API_KEY'],
      defaultBaseURL: 'https://api-inference.huggingface.co/models',
      defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
      popularModels: [],
      openAICompatible: true,
      capabilities: CAPS_NO_TOOLS,
      apiKeyRequired: true,
    }),
  },

  // ── Tier 2.5: Recently popular inference platforms (added 2025) ────────
  novita: {
    metadata: {
      id: 'novita', label: 'Novita AI',
      description: 'Cheap Llama / Qwen / DeepSeek inference. OpenAI-compatible.',
      docsUrl: 'https://novita.ai/get-key',
      apiKeyEnvVars: ['NOVITA_API_KEY'],
      defaultBaseURL: 'https://api.novita.ai/v3/openai',
      defaultModel: 'meta-llama/llama-3.1-70b-instruct',
      popularModels: [
        'meta-llama/llama-3.1-70b-instruct',
        'meta-llama/llama-3.1-8b-instruct',
        'deepseek/deepseek-v3-0324',
        'deepseek/deepseek-r1',
        'qwen/qwen2.5-72b-instruct',
      ],
      openAICompatible: true,
      capabilities: CAPS_TOOLS_OK,
      apiKeyRequired: true,
    },
    factory: openAICompatibleFactory({
      id: 'novita', label: 'Novita AI', description: '', docsUrl: '',
      apiKeyEnvVars: ['NOVITA_API_KEY'],
      defaultBaseURL: 'https://api.novita.ai/v3/openai',
      defaultModel: 'meta-llama/llama-3.1-70b-instruct',
      popularModels: [],
      openAICompatible: true,
      capabilities: CAPS_TOOLS_OK,
      apiKeyRequired: true,
    }),
  },

  hyperbolic: {
    metadata: {
      id: 'hyperbolic', label: 'Hyperbolic',
      description: 'Cheap GPU inference for Llama, Qwen, DeepSeek. OpenAI-compatible.',
      docsUrl: 'https://app.hyperbolic.xyz/settings',
      apiKeyEnvVars: ['HYPERBOLIC_API_KEY'],
      defaultBaseURL: 'https://api.hyperbolic.xyz/v1',
      defaultModel: 'meta-llama/Meta-Llama-3.1-70B-Instruct',
      popularModels: [
        'meta-llama/Meta-Llama-3.1-70B-Instruct',
        'meta-llama/Meta-Llama-3.1-405B-Instruct',
        'deepseek-ai/DeepSeek-V3',
        'Qwen/Qwen2.5-72B-Instruct',
      ],
      openAICompatible: true,
      capabilities: CAPS_TOOLS_OK,
      apiKeyRequired: true,
    },
    factory: openAICompatibleFactory({
      id: 'hyperbolic', label: 'Hyperbolic', description: '', docsUrl: '',
      apiKeyEnvVars: ['HYPERBOLIC_API_KEY'],
      defaultBaseURL: 'https://api.hyperbolic.xyz/v1',
      defaultModel: 'meta-llama/Meta-Llama-3.1-70B-Instruct',
      popularModels: [],
      openAICompatible: true,
      capabilities: CAPS_TOOLS_OK,
      apiKeyRequired: true,
    }),
  },

  chutes: {
    metadata: {
      id: 'chutes', label: 'Chutes AI',
      description: 'Router-style access to 100+ open models. OpenAI-compatible.',
      docsUrl: 'https://chutes.ai/app/settings',
      apiKeyEnvVars: ['CHUTES_API_KEY'],
      defaultBaseURL: 'https://api.chutes.ai/v1',
      defaultModel: 'chutes/Llama-3.1-70B',
      popularModels: [
        'chutes/Llama-3.1-70B',
        'chutes/Llama-3.1-8B',
        'deepseek-ai/DeepSeek-V3',
        'Qwen/Qwen2.5-72B-Instruct',
      ],
      openAICompatible: true,
      capabilities: CAPS_TOOLS_OK,
      apiKeyRequired: true,
    },
    factory: openAICompatibleFactory({
      id: 'chutes', label: 'Chutes AI', description: '', docsUrl: '',
      apiKeyEnvVars: ['CHUTES_API_KEY'],
      defaultBaseURL: 'https://api.chutes.ai/v1',
      defaultModel: 'chutes/Llama-3.1-70B',
      popularModels: [],
      openAICompatible: true,
      capabilities: CAPS_TOOLS_OK,
      apiKeyRequired: true,
    }),
  },

  sambanova: {
    metadata: {
      id: 'sambanova', label: 'SambaNova',
      description: 'Fast inference for Llama / Qwen / DeepSeek. Free tier available.',
      docsUrl: 'https://cloud.sambanova.ai/apis',
      apiKeyEnvVars: ['SAMBANOVA_API_KEY'],
      defaultBaseURL: 'https://api.sambanova.ai/v1',
      defaultModel: 'Meta-Llama-3.1-70B-Instruct',
      popularModels: [
        'Meta-Llama-3.1-70B-Instruct',
        'Meta-Llama-3.1-405B-Instruct',
        'Meta-Llama-3.1-8B-Instruct',
        'DeepSeek-R1',
        'Qwen2.5-72B-Instruct',
      ],
      openAICompatible: true,
      capabilities: CAPS_TOOLS_OK,
      apiKeyRequired: true,
    },
    factory: openAICompatibleFactory({
      id: 'sambanova', label: 'SambaNova', description: '', docsUrl: '',
      apiKeyEnvVars: ['SAMBANOVA_API_KEY'],
      defaultBaseURL: 'https://api.sambanova.ai/v1',
      defaultModel: 'Meta-Llama-3.1-70B-Instruct',
      popularModels: [],
      openAICompatible: true,
      capabilities: CAPS_TOOLS_OK,
      apiKeyRequired: true,
    }),
  },

  cerebras: {
    metadata: {
      id: 'cerebras', label: 'Cerebras',
      description: 'Fastest inference — Llama 3.1 70B at 450 tok/s. OpenAI-compatible.',
      docsUrl: 'https://cloud.cerebras.ai',
      apiKeyEnvVars: ['CEREBRAS_API_KEY'],
      defaultBaseURL: 'https://api.cerebras.ai/v1',
      defaultModel: 'llama3.1-70b',
      popularModels: ['llama3.1-70b', 'llama3.1-8b', 'llama-3.3-70b', 'qwen2.5-72b'],
      openAICompatible: true,
      capabilities: CAPS_TOOLS_OK,
      apiKeyRequired: true,
    },
    factory: openAICompatibleFactory({
      id: 'cerebras', label: 'Cerebras', description: '', docsUrl: '',
      apiKeyEnvVars: ['CEREBRAS_API_KEY'],
      defaultBaseURL: 'https://api.cerebras.ai/v1',
      defaultModel: 'llama3.1-70b',
      popularModels: [],
      openAICompatible: true,
      capabilities: CAPS_TOOLS_OK,
      apiKeyRequired: true,
    }),
  },

  deepinfra: {
    metadata: {
      id: 'deepinfra', label: 'Deep Infra',
      description: 'Serverless inference for 100+ open models. OpenAI-compatible.',
      docsUrl: 'https://deepinfra.com/dash/api_keys',
      apiKeyEnvVars: ['DEEPINFRA_API_KEY'],
      defaultBaseURL: 'https://api.deepinfra.com/v1/openai',
      defaultModel: 'meta-llama/Meta-Llama-3-70B-Instruct',
      popularModels: [
        'meta-llama/Meta-Llama-3-70B-Instruct',
        'meta-llama/Meta-Llama-3.1-70B-Instruct',
        'deepseek-ai/DeepSeek-V3',
        'Qwen/Qwen2.5-72B-Instruct',
      ],
      openAICompatible: true,
      capabilities: CAPS_TOOLS_OK,
      apiKeyRequired: true,
    },
    factory: openAICompatibleFactory({
      id: 'deepinfra', label: 'Deep Infra', description: '', docsUrl: '',
      apiKeyEnvVars: ['DEEPINFRA_API_KEY'],
      defaultBaseURL: 'https://api.deepinfra.com/v1/openai',
      defaultModel: 'meta-llama/Meta-Llama-3-70B-Instruct',
      popularModels: [],
      openAICompatible: true,
      capabilities: CAPS_TOOLS_OK,
      apiKeyRequired: true,
    }),
  },

  siliconflow: {
    metadata: {
      id: 'siliconflow', label: 'SiliconFlow',
      description: 'Cheap serverless inference for 200+ models. OpenAI-compatible.',
      docsUrl: 'https://siliconflow.cn/ustudio',
      apiKeyEnvVars: ['SILICONFLOW_API_KEY'],
      defaultBaseURL: 'https://api.siliconflow.cn/v1',
      defaultModel: 'deepseek-ai/DeepSeek-V3',
      popularModels: [
        'deepseek-ai/DeepSeek-V3',
        'deepseek-ai/DeepSeek-R1',
        'Qwen/Qwen2.5-72B-Instruct',
        'meta-llama/Meta-Llama-3.1-70B-Instruct',
      ],
      openAICompatible: true,
      capabilities: CAPS_TOOLS_OK,
      apiKeyRequired: true,
    },
    factory: openAICompatibleFactory({
      id: 'siliconflow', label: 'SiliconFlow', description: '', docsUrl: '',
      apiKeyEnvVars: ['SILICONFLOW_API_KEY'],
      defaultBaseURL: 'https://api.siliconflow.cn/v1',
      defaultModel: 'deepseek-ai/DeepSeek-V3',
      popularModels: [],
      openAICompatible: true,
      capabilities: CAPS_TOOLS_OK,
      apiKeyRequired: true,
    }),
  },

  aimlapi: {
    metadata: {
      id: 'aimlapi', label: 'AI/ML API',
      description: 'Single API for 100+ models including GPT-4, Claude, Llama. OpenAI-compatible.',
      docsUrl: 'https://aimlapi.com/app/keys',
      apiKeyEnvVars: ['AIML_API_KEY', 'AIMLAPI_API_KEY'],
      defaultBaseURL: 'https://api.aimlapi.com/v1',
      defaultModel: 'gpt-4o-mini',
      popularModels: [
        'gpt-4o-mini', 'gpt-4o', 'claude-3-5-sonnet-20241022',
        'meta-llama/Meta-Llama-3.1-70B-Instruct', 'deepseek-ai/DeepSeek-V3',
      ],
      openAICompatible: true,
      capabilities: CAPS_TOOLS_OK,
      apiKeyRequired: true,
    },
    factory: openAICompatibleFactory({
      id: 'aimlapi', label: 'AI/ML API', description: '', docsUrl: '',
      apiKeyEnvVars: ['AIML_API_KEY', 'AIMLAPI_API_KEY'],
      defaultBaseURL: 'https://api.aimlapi.com/v1',
      defaultModel: 'gpt-4o-mini',
      popularModels: [],
      openAICompatible: true,
      capabilities: CAPS_TOOLS_OK,
      apiKeyRequired: true,
    }),
  },

  atoma: {
    metadata: {
      id: 'atoma', label: 'Atoma',
      description: 'Decentralized inference — pay per token. OpenAI-compatible.',
      docsUrl: 'https://atoma.network/dashboard',
      apiKeyEnvVars: ['ATOMA_API_KEY'],
      defaultBaseURL: 'https://api.atoma.network/v1',
      defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
      popularModels: [
        'meta-llama/Llama-3.3-70B-Instruct',
        'meta-llama/Llama-3.1-70B-Instruct',
        'deepseek-ai/DeepSeek-V3',
      ],
      openAICompatible: true,
      capabilities: CAPS_TOOLS_OK,
      apiKeyRequired: true,
    },
    factory: openAICompatibleFactory({
      id: 'atoma', label: 'Atoma', description: '', docsUrl: '',
      apiKeyEnvVars: ['ATOMA_API_KEY'],
      defaultBaseURL: 'https://api.atoma.network/v1',
      defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
      popularModels: [],
      openAICompatible: true,
      capabilities: CAPS_TOOLS_OK,
      apiKeyRequired: true,
    }),
  },

  inception: {
    metadata: {
      id: 'inception', label: 'Inception',
      description: 'Diffusion-based LLM inference. OpenAI-compatible.',
      docsUrl: 'https://inceptionlabs.ai',
      apiKeyEnvVars: ['INCEPTION_API_KEY'],
      defaultBaseURL: 'https://api.inceptionlabs.ai/v1',
      defaultModel: 'mercury-coder-small',
      popularModels: ['mercury-coder-small', 'mercury-coder'],
      openAICompatible: true,
      capabilities: CAPS_NO_TOOLS,
      apiKeyRequired: true,
    },
    factory: openAICompatibleFactory({
      id: 'inception', label: 'Inception', description: '', docsUrl: '',
      apiKeyEnvVars: ['INCEPTION_API_KEY'],
      defaultBaseURL: 'https://api.inceptionlabs.ai/v1',
      defaultModel: 'mercury-coder-small',
      popularModels: [],
      openAICompatible: true,
      capabilities: CAPS_NO_TOOLS,
      apiKeyRequired: true,
    }),
  },

  ollama: {
    metadata: {
      id: 'ollama', label: 'Ollama (local)',
      description: 'Run Llama, Mistral, Qwen locally. Tool support depends on the model.',
      docsUrl: 'https://ollama.com/download',
      apiKeyEnvVars: [],
      defaultBaseURL: 'http://localhost:11434/v1',
      defaultModel: 'llama3.1',
      popularModels: ['llama3.1', 'llama3.1:70b', 'qwen2.5', 'qwen2.5:32b', 'mistral-nemo', 'gemma2', 'phi3', 'deepseek-r1', 'codellama'],
      openAICompatible: true,
      capabilities: CAPS_TOOLS_OK,
      apiKeyRequired: false,
    },
    factory: openAICompatibleFactory({
      id: 'ollama', label: 'Ollama', description: '', docsUrl: '',
      apiKeyEnvVars: [],
      defaultBaseURL: 'http://localhost:11434/v1',
      defaultModel: 'llama3.1',
      popularModels: [],
      openAICompatible: true,
      capabilities: CAPS_TOOLS_OK,
      apiKeyRequired: false,
    }),
  },

  lmstudio: {
    metadata: {
      id: 'lmstudio', label: 'LM Studio (local)',
      description: 'Local OpenAI-compatible server. Load any GGUF model.',
      docsUrl: 'https://lmstudio.ai',
      apiKeyEnvVars: [],
      defaultBaseURL: 'http://localhost:1234/v1',
      defaultModel: 'local-model',
      popularModels: ['local-model'],
      openAICompatible: true,
      capabilities: CAPS_NO_TOOLS,
      apiKeyRequired: false,
    },
    factory: openAICompatibleFactory({
      id: 'lmstudio', label: 'LM Studio', description: '', docsUrl: '',
      apiKeyEnvVars: [],
      defaultBaseURL: 'http://localhost:1234/v1',
      defaultModel: 'local-model',
      popularModels: [],
      openAICompatible: true,
      capabilities: CAPS_NO_TOOLS,
      apiKeyRequired: false,
    }),
  },

  vllm: {
    metadata: {
      id: 'vllm', label: 'vLLM (self-hosted)',
      description: 'Run vLLM server with any HuggingFace model. OpenAI-compatible.',
      docsUrl: 'https://docs.vllm.ai',
      apiKeyEnvVars: ['VLLM_API_KEY'],
      defaultBaseURL: 'http://localhost:8000/v1',
      defaultModel: '',
      popularModels: [],
      openAICompatible: true,
      capabilities: CAPS_TOOLS_OK,
      apiKeyRequired: false,
    },
    factory: openAICompatibleFactory({
      id: 'vllm', label: 'vLLM', description: '', docsUrl: '',
      apiKeyEnvVars: ['VLLM_API_KEY'],
      defaultBaseURL: 'http://localhost:8000/v1',
      defaultModel: '',
      popularModels: [],
      openAICompatible: true,
      capabilities: CAPS_TOOLS_OK,
      apiKeyRequired: false,
    }),
  },

  custom: {
    metadata: {
      id: 'custom', label: 'Custom (OpenAI-compatible)',
      description: 'Any OpenAI-compatible endpoint not in the list. Set base URL + model + key manually.',
      docsUrl: '',
      apiKeyEnvVars: [],
      defaultBaseURL: '',
      defaultModel: '',
      // Suggested in the Settings UI; kimi-k2-5 is the app's default endpoint model.
      popularModels: ['kimi-k2-5'],
      openAICompatible: true,
      capabilities: CAPS_TOOLS_OK,
      apiKeyRequired: false,
    },
    factory: openAICompatibleFactory({
      id: 'custom', label: 'Custom', description: '', docsUrl: '',
      apiKeyEnvVars: [],
      defaultBaseURL: '',
      defaultModel: '',
      popularModels: [],
      openAICompatible: true,
      capabilities: CAPS_TOOLS_OK,
      apiKeyRequired: false,
    }),
  },
};

// ---- Public API ------------------------------------------------------------

export function getProvider(id: string): LLMProviderEntry {
  const entry = PROVIDERS[id];
  if (!entry) {
    throw new Error(
      `Unknown LLM provider "${id}". Valid options: ${Object.keys(PROVIDERS).join(', ')}`,
    );
  }
  return entry;
}

export function getProviderMetadata(id: string): LLMProviderMetadata | undefined {
  return PROVIDERS[id]?.metadata;
}

export function listProviderIds(): string[] {
  return Object.keys(PROVIDERS);
}

export function listProviders(): Array<{ id: string; metadata: LLMProviderMetadata }> {
  return Object.entries(PROVIDERS).map(([id, entry]) => ({
    id,
    metadata: entry.metadata,
  }));
}

export async function createLLMClient(config: LLMProviderConfig): Promise<LLMClient> {
  const entry = getProvider(config.providerId);
  return entry.factory(config);
}

export function registerProvider(id: string, entry: LLMProviderEntry): void {
  PROVIDERS[id] = entry;
}
