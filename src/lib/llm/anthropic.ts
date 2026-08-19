// Anthropic Claude native adapter.
//
// Anthropic's API differs from OpenAI's in three places that matter for us:
//
//   1. System message is a top-level `system` field, NOT a message in the
//      `messages` array. We pull the system message out before sending.
//   2. Tool calls come back as `content` blocks with `type: 'tool_use'`,
//      not as `tool_calls`. We translate them to the OpenAI shape so the
//      runner doesn't need a second code path.
//   3. Tool results come IN as `content` blocks with `type: 'tool_result'`
//      on a `user`-role message. We translate OpenAI-style `role: 'tool'`
//      messages into this format.
//
// We use the `messages` API (not the deprecated `completions` one) at
// `https://api.anthropic.com/v1/messages`. Auth is via the
// `x-api-key` header (NOT `Authorization: Bearer`), and the API version
// is pinned via `anthropic-version: 2023-06-01`.
//
// Tool definitions are translated from OpenAI's `{type:'function',function:{...}}`
// shape to Anthropic's `{name, description, input_schema}` shape.

import type {
  LLMClient, LLMGenerateParams, LLMMessage, LLMResponse, LLMToolSpec,
} from './types';

const ANTHROPIC_API_VERSION = '2023-06-01';
const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_DEFAULT_MODEL = 'claude-3-5-sonnet-20241022';

function translateMessages(
  messages: LLMMessage[],
): { system?: string; messages: AnthropicMessage[] } {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemParts.push(msg.content);
      continue;
    }
    if (msg.role === 'tool') {
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: msg.tool_call_id ?? '',
            content: msg.content,
          },
        ],
      });
      continue;
    }
    if (msg.role === 'assistant') {
      const content: AnthropicContentBlock[] = [];
      if (msg.content) {
        content.push({ type: 'text', text: msg.content });
      }
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          let parsedArgs: unknown = {};
          try {
            parsedArgs = JSON.parse(tc.function.arguments || '{}');
          } catch {
            parsedArgs = {};
          }
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: parsedArgs,
          });
        }
      }
      if (content.length > 0) {
        out.push({ role: 'assistant', content });
      }
      continue;
    }
    out.push({ role: 'user', content: msg.content });
  }

  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    messages: out,
  };
}

function translateTools(tools: LLMToolSpec[] | undefined) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

function translateResponse(anthropic: AnthropicResponse): LLMResponse {
  const textParts: string[] = [];
  const toolCalls: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }> = [];

  for (const block of anthropic.content ?? []) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }

  return {
    choices: [
      {
        message: {
          content: textParts.length > 0 ? textParts.join('\n') : null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
        // Normalize Anthropic's stop_reason to OpenAI's finish_reason enum:
        //   end_turn        → stop
        //   max_tokens      → length
        //   tool_use        → tool_calls
        //   stop_sequence   → stop
        //   (anything else) → stop
        finish_reason: normalizeAnthropicStopReason(anthropic.stop_reason),
      },
    ],
    usage: anthropic.usage
      ? {
          prompt_tokens: anthropic.usage.input_tokens,
          completion_tokens: anthropic.usage.output_tokens,
          total_tokens:
            (anthropic.usage.input_tokens ?? 0) +
            (anthropic.usage.output_tokens ?? 0),
        }
      : undefined,
  };
}

/// Map Anthropic's stop_reason to OpenAI's finish_reason enum.
function normalizeAnthropicStopReason(reason: string | undefined): string {
  switch (reason) {
    case 'end_turn': return 'stop';
    case 'max_tokens': return 'length';
    case 'tool_use': return 'tool_calls';
    case 'stop_sequence': return 'stop';
    default: return 'stop';
  }
}

export interface AnthropicClientOptions {
  apiKey: string;
  baseURL?: string;
  model: string;
  timeoutMs?: number;
}

export function createAnthropicClient(opts: AnthropicClientOptions): LLMClient {
  const apiKey = opts.apiKey;
  const baseURL = (opts.baseURL || ANTHROPIC_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = opts.model || ANTHROPIC_DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const url = baseURL + '/v1/messages';

  return {
    chat: {
      completions: {
        create: async (params: LLMGenerateParams): Promise<LLMResponse> => {
          if (!apiKey) {
            throw new Error(
              'Anthropic requires an API key. Set ANTHROPIC_API_KEY in your .env or in Settings.',
            );
          }
          const { system, messages } = translateMessages(params.messages);
          const body: Record<string, unknown> = {
            model,
            messages,
            max_tokens: params.max_tokens ?? 4096,
            temperature: params.temperature ?? 0.4,
          };
          if (system) body.system = system;
          const tools = translateTools(params.tools);
          if (tools) body.tools = tools;
          if (params.tool_choice) {
            if (params.tool_choice === 'auto') {
              body.tool_choice = { type: 'auto' };
            } else if (params.tool_choice === 'required') {
              body.tool_choice = { type: 'any' };
            } else if (params.tool_choice === 'none') {
              delete body.tools;
            } else if (typeof params.tool_choice === 'object') {
              body.tool_choice = {
                type: 'tool',
                name: params.tool_choice.function.name,
              };
            }
          }

          const controller = new AbortController();
          const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const res = await fetch(url, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': ANTHROPIC_API_VERSION,
              },
              body: JSON.stringify(body),
              signal: controller.signal,
            });
            if (!res.ok) {
              const text = await res.text().catch(() => '');
              throw new Error(
                `Anthropic error ${res.status}: ${text.slice(0, 500)}`,
              );
            }
            const json = (await res.json()) as AnthropicResponse;
            return translateResponse(json);
          } finally {
            clearTimeout(timeoutHandle);
          }
        },
      },
    },
  };
}

// ---- Anthropic wire types (subset) ----
interface AnthropicTextBlock { type: 'text'; text: string }
interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}
interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}
type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicResponse {
  id?: string;
  type?: string;
  role?: string;
  content?: AnthropicContentBlock[];
  model?: string;
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}
