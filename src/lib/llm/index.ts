// LLM module barrel — re-exports everything the rest of the app needs.

export {
  createLLMClient,
  getProvider,
  getProviderMetadata,
  listProviderIds,
  listProviders,
  registerProvider,
  PROVIDERS,
} from './registry';

export type {
  LLMClient,
  LLMClientFactory,
  LLMGenerateParams,
  LLMMessage,
  LLMProviderCapabilities,
  LLMProviderConfig,
  LLMProviderEntry,
  LLMProviderMetadata,
  LLMResponse,
  LLMToolCall,
  LLMToolSpec,
} from './types';

export { createOpenAICompatible } from './openai-compatible';
export { createAnthropicClient } from './anthropic';
export { createGeminiClient } from './gemini';
