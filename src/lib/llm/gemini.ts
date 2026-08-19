// Google Gemini native adapter (v1beta).
//
// Gemini's API uses a different request/response shape:
//
//   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
//   ?key={api_key}
//
// The body uses `contents` (not `messages`), `parts` for multi-modal input,
// and `functionDeclarations` for tools. Tool calls come back as
// `functionCall` parts; tool results go in as `functionResponse` parts on a
// `user`-role turn.
//
// This adapter translates the OpenAI message/tool shape to/from Gemini's.

import type {
  LLMClient, LLMGenerateParams, LLMMessage, LLMResponse, LLMToolSpec,
} from './types';

const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
const GEMINI_DEFAULT_MODEL = 'gemini-1.5-pro';

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: unknown };
  functionResponse?: { name: string; response: unknown };
}
interface GeminiContent {
  role: 'user' | 'model' | 'function';
  parts: GeminiPart[];
}

function translateMessages(
  messages: LLMMessage[],
): { systemInstruction?: { parts: GeminiPart[] }; contents: GeminiContent[] } {
  const systemParts: string[] = [];
  const contents: GeminiContent[] = [];

  let pendingToolResults: GeminiPart[] = [];

  function flushToolResults() {
    if (pendingToolResults.length > 0) {
      contents.push({ role: 'user', parts: pendingToolResults });
      pendingToolResults = [];
    }
  }

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemParts.push(msg.content);
      continue;
    }
    if (msg.role === 'tool') {
      let name = 'tool';
      let response: unknown = msg.content;
      try {
        const parsed = JSON.parse(msg.content);
        if (parsed && typeof parsed === 'object' && '_name' in parsed) {
          name = (parsed as { _name: string })._name;
          delete (parsed as { _name?: string })._name;
          response = parsed;
        }
      } catch {
        // not JSON — keep name='tool'
      }
      pendingToolResults.push({
        functionResponse: { name, response: { result: response } },
      });
      continue;
    }
    flushToolResults();
    if (msg.role === 'assistant') {
      const parts: GeminiPart[] = [];
      if (msg.content) parts.push({ text: msg.content });
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          let args: unknown = {};
          try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* keep {} */ }
          parts.push({
            functionCall: { name: tc.function.name, args },
          });
        }
      }
      if (parts.length > 0) contents.push({ role: 'model', parts });
      continue;
    }
    contents.push({ role: 'user', parts: [{ text: msg.content }] });
  }
  flushToolResults();

  return {
    systemInstruction:
      systemParts.length > 0
        ? { parts: [{ text: systemParts.join('\n\n') }] }
        : undefined,
    contents,
  };
}

function translateTools(tools: LLMToolSpec[] | undefined) {
  if (!tools || tools.length === 0) return undefined;
  // Per the Gemini REST spec (v1beta generateContent), `tools` is an array of
  // `Tool` wrappers, and EACH Tool wraps its declarations in a single
  // `functionDeclarations` ARRAY (not a single object). The previous
  // implementation split each declaration into its own Tool wrapper with a
  // single object, which Gemini rejects when 2+ tools are present.
  // Correct shape:
  //   "tools": [{ "functionDeclarations": [ {decl1}, {decl2}, ... ] }]
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      })),
    },
  ];
}

function translateResponse(gemini: GeminiResponse): LLMResponse {
  const textParts: string[] = [];
  const toolCalls: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }> = [];

  let tcIdx = 0;
  for (const cand of gemini.candidates ?? []) {
    for (const part of cand.content?.parts ?? []) {
      if (part.text) textParts.push(part.text);
      if (part.functionCall) {
        tcIdx += 1;
        toolCalls.push({
          id: `gemini-tc-${Date.now()}-${tcIdx}`,
          type: 'function',
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args ?? {}),
          },
        });
      }
    }
  }

  return {
    choices: [
      {
        message: {
          content: textParts.length > 0 ? textParts.join('\n') : null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
        // Normalize Gemini's UPPERCASE finishReason to OpenAI's lowercase
        // finish_reason enum (stop/length/tool_calls/content_filter).
        finish_reason: normalizeGeminiFinishReason(gemini.candidates?.[0]?.finishReason),
      },
    ],
    usage: gemini.usageMetadata
      ? {
          prompt_tokens: gemini.usageMetadata.promptTokenCount,
          completion_tokens: gemini.usageMetadata.candidatesTokenCount,
          total_tokens: gemini.usageMetadata.totalTokenCount,
        }
      : undefined,
  };
}

/// Map Gemini's UPPERCASE finishReason enum to OpenAI's lowercase finish_reason.
/// Gemini: STOP, MAX_TOKENS, SAFETY, RECITATION, OTHER
/// OpenAI: stop, length, tool_calls, content_filter
function normalizeGeminiFinishReason(reason: string | undefined): string {
  switch (reason) {
    case 'STOP': return 'stop';
    case 'MAX_TOKENS': return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
      return 'content_filter';
    default: return 'stop';
  }
}

export interface GeminiClientOptions {
  apiKey: string;
  baseURL?: string;
  model: string;
  timeoutMs?: number;
}

export function createGeminiClient(opts: GeminiClientOptions): LLMClient {
  const apiKey = opts.apiKey;
  const baseURL = (opts.baseURL || GEMINI_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = opts.model || GEMINI_DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? 120_000;

  return {
    chat: {
      completions: {
        create: async (params: LLMGenerateParams): Promise<LLMResponse> => {
          if (!apiKey) {
            throw new Error(
              'Google Gemini requires an API key. Set GEMINI_API_KEY or GOOGLE_API_KEY in your .env or in Settings.',
            );
          }
          const toolNameById = new Map<string, string>();
          for (const m of params.messages) {
            if (m.role === 'assistant' && m.tool_calls) {
              for (const tc of m.tool_calls) {
                toolNameById.set(tc.id, tc.function.name);
              }
            }
          }
          const taggedMessages = params.messages.map((m) => {
            if (m.role === 'tool' && m.tool_call_id) {
              const name = toolNameById.get(m.tool_call_id) || 'tool';
              return {
                ...m,
                content: JSON.stringify({ _name: name, result: m.content }),
              };
            }
            return m;
          });
          const { systemInstruction, contents } = translateMessages(
            taggedMessages.map((m) => {
              if (m.role === 'tool') {
                try {
                  const parsed = JSON.parse(m.content) as { result?: string; _name?: string };
                  if (parsed && typeof parsed === 'object') {
                    return { ...m, content: parsed.result ?? m.content };
                  }
                } catch { /* keep original */ }
              }
              return m;
            }),
          );

          const body: Record<string, unknown> = {
            contents,
            generationConfig: {
              temperature: params.temperature ?? 0.4,
              ...(params.max_tokens ? { maxOutputTokens: params.max_tokens } : {}),
            },
          };
          if (systemInstruction) body.systemInstruction = systemInstruction;
          const tools = translateTools(params.tools);
          if (tools) body.tools = tools;
          // Translate OpenAI tool_choice to Gemini's toolConfig.functionCallingConfig.mode:
          //   'auto'      → AUTO     (model decides whether to call a function)
          //   'required'  → ANY      (model must call at least one function)
          //   'none'      → NONE     (suppress function calling)
          //   {function:  → specific tool name (Gemini supports mode: 'ANY' + allowedFunctionNames)
          if (params.tool_choice && tools) {
            const tc = params.tool_choice;
            if (tc === 'auto') {
              body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
            } else if (tc === 'required') {
              body.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
            } else if (tc === 'none') {
              body.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
            } else if (typeof tc === 'object' && tc.function?.name) {
              body.toolConfig = {
                functionCallingConfig: {
                  mode: 'ANY',
                  allowedFunctionNames: [tc.function.name],
                },
              };
            }
          }

          const url =
            `${baseURL}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
          const controller = new AbortController();
          const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const res = await fetch(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
              signal: controller.signal,
            });
            if (!res.ok) {
              const text = await res.text().catch(() => '');
              throw new Error(
                `Gemini error ${res.status}: ${text.slice(0, 500)}`,
              );
            }
            const json = (await res.json()) as GeminiResponse;
            return translateResponse(json);
          } finally {
            clearTimeout(timeoutHandle);
          }
        },
      },
    },
  };
}

// ---- Gemini wire types (subset) ----
interface GeminiResponse {
  candidates?: Array<{
    content?: { parts: GeminiPart[] };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}
