// Web research sub-agent — runs web_search + web_fetch in an isolated context.
//
// This is the Tier 2 "sub-agent" pattern from the Claude Code architecture:
//   https://code.claude.com/docs/en/sub-agents
//
// The Claude Code rule of thumb: "if a task touches more than about 5 files,
// isolate it in a subagent." Translating to our domain: if a sub-task will
// produce many intermediate tool-result tokens (e.g. multiple web_fetch calls
// each returning 10-50K chars of page content), run it in a separate LLM
// context so those tokens don't pollute the main canvas-agent's context.
//
// The sub-agent:
//   1. Takes a research task (the user's web-related query).
//   2. Makes its own LLM calls with ONLY web_search + web_fetch tools.
//   3. Does 1-3 searches + 1-4 fetches (capped to prevent runaway).
//   4. Returns a synthesized SUMMARY (not the raw page content) to the
//      main agent.
//
// The main agent then uses the summary to inform its design work, without
// ever seeing the 50K+ tokens of raw page content that the sub-agent
// consumed.

import ZAI from 'z-ai-web-dev-sdk';
import { webSearch, formatSearchForLLM } from '../../web/search';
import { webFetch, formatFetchForLLM } from '../../web/fetch';
import type { SubAgentResult, SubAgentParams } from '../skills/types';
import type { LLMClient } from '../runner';
import { callLLMWithRetry } from '../llm-retry';

// ---- Sub-agent system prompt ----------------------------------------------
//
// This prompt is SEPARATE from the main agent's system prompt. It only knows
// about web research — not canvas tools. This keeps the sub-agent focused
// and its context lean.

const SUBAGENT_SYSTEM_PROMPT = `You are a web research assistant. Your job is to find current information on the web and return a clear, synthesized summary.

You have two tools:
- web_search: search the web for results (title, URL, snippet, date)
- web_fetch: fetch a specific URL and get its content as markdown

=== STRATEGY ===
1. Start with web_search to find relevant sources.
2. If you need more detail, call web_fetch on the 1-2 most relevant URLs.
3. Do NOT fetch more than 3 pages — synthesize from what you have.
4. After gathering information, write a concise summary (200-500 words) of your findings.

=== OUTPUT FORMAT ===
After your research, end your response with a line starting with "SUMMARY:" followed by your synthesized findings. This summary will be passed to the main design agent, so include all key facts, data points, names, and specifics that would be useful for design work.

Example:
SUMMARY: Based on research from [sources], the key 2025 SaaS dashboard trends are:
- Minimalist data viz with clean charts
- Card-based layouts with ample whitespace
- ...etc

Keep the summary focused and factual. Do not include raw page content — only the extracted insights.`;

// ---- Public API ------------------------------------------------------------

/**
 * Dispatch the web research sub-agent.
 *
 * The sub-agent runs in its own LLM context with only web_search + web_fetch
 * tools. It returns a synthesized summary that the main agent can use without
 * the intermediate page content polluting its context.
 */
export async function dispatchWebResearchSubAgent(
  params: SubAgentParams,
): Promise<SubAgentResult> {
  let toolCallCount = 0;

  try {
    // Create a fresh ZAI client for the sub-agent (separate context).
    const zai = (await ZAI.create()) as unknown as LLMClient;

    // The sub-agent's tool specs (only web tools).
    const subAgentTools = [
      {
        type: 'function' as const,
        function: {
          name: 'web_search',
          description:
            'Search the web for current information. Returns numbered results with title, URL, snippet, and publish date.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Natural-language search query' },
              recency: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: 'Optional recency filter' },
            },
            required: ['query'],
          },
        },
      },
      {
        type: 'function' as const,
        function: {
          name: 'web_fetch',
          description:
            'Fetch a specific URL and return its content as readable markdown. Handles HTML, JSON, RSS feeds, and JS-rendered pages.',
          parameters: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'The URL to fetch (https://example.com/page)' },
            },
            required: ['url'],
          },
        },
      },
    ];

    // Sub-agent message history (starts fresh — no canvas context).
    const messages: Array<{
      role: 'system' | 'user' | 'assistant' | 'tool';
      content: string;
      tool_calls?: any[];
      tool_call_id?: string;
    }> = [
      { role: 'system', content: SUBAGENT_SYSTEM_PROMPT },
      { role: 'user', content: params.task },
    ];

    let finalSummary = '';
    const MAX_SUBAGENT_ITERATIONS = 6; // Cap: 1-2 searches + 1-3 fetches + 1 summary

    for (let iter = 0; iter < MAX_SUBAGENT_ITERATIONS; iter++) {
      const completion = await callLLMWithRetry(
        zai as any,
        {
          messages: messages as any,
          tools: subAgentTools,
          tool_choice: 'auto',
          temperature: 0.3,
        },
        { maxRetries: 3, baseDelayMs: 3000 },
      );

      const msg = completion?.choices?.[0]?.message;
      if (!msg) break;

      // Check for the summary marker.
      if (msg.content) {
        const summaryMatch = msg.content.match(/SUMMARY:\s*([\s\S]+)/i);
        if (summaryMatch) {
          finalSummary = summaryMatch[1].trim();
          break;
        }
        // If no tool calls and no summary, treat the content as the summary.
        if (!msg.tool_calls || msg.tool_calls.length === 0) {
          finalSummary = msg.content.trim();
          break;
        }
      }

      // No tool calls → we're done (the content is the answer).
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        finalSummary = msg.content?.trim() || 'No results found.';
        break;
      }

      // Append the assistant message.
      messages.push({
        role: 'assistant',
        content: msg.content ?? '',
        tool_calls: msg.tool_calls.map((tc: any) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.function.name, arguments: tc.function.arguments },
        })),
      });

      // Execute each tool call.
      for (const tc of msg.tool_calls) {
        toolCallCount++;
        let args: any;
        try {
          args = JSON.parse(tc.function.arguments || '{}');
        } catch {
          args = {};
        }

        let resultText: string;
        try {
          if (tc.function.name === 'web_search') {
            const results = await webSearch({
              query: args.query,
              recency: args.recency,
              signal: params.signal,
            });
            resultText = formatSearchForLLM(results);
          } else if (tc.function.name === 'web_fetch') {
            const result = await webFetch({
              url: args.url,
              signal: params.signal,
            });
            resultText = formatFetchForLLM(result);
          } else {
            resultText = `Unknown tool: ${tc.function.name}`;
          }
        } catch (err: any) {
          resultText = `Tool error: ${err?.message ?? String(err)}`;
        }

        // Cap the result text to prevent context bloat in the sub-agent too.
        const MAX_RESULT_CHARS = 15_000;
        if (resultText.length > MAX_RESULT_CHARS) {
          resultText = resultText.slice(0, MAX_RESULT_CHARS) + '\n\n…[truncated for sub-agent context]';
        }

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: resultText,
        });
      }
    }

    // If we exhausted iterations without a summary, synthesize one.
    if (!finalSummary) {
      // Collect all tool results and create a brief summary.
      const toolResults = messages
        .filter((m) => m.role === 'tool')
        .map((m) => m.content)
        .join('\n\n');
      finalSummary = synthesizeSummary(toolResults, params.task);
    }

    return {
      summary: finalSummary,
      toolCalls: toolCallCount,
      success: true,
    };
  } catch (err: any) {
    return {
      summary: `Web research failed: ${err?.message ?? String(err)}`,
      toolCalls: toolCallCount,
      success: false,
      error: err?.message ?? String(err),
    };
  }
}

// ---- Summary synthesis (fallback) -----------------------------------------

function synthesizeSummary(toolResults: string, task: string): string {
  // A lightweight extraction: find the first few search result titles/snippets.
  const lines = toolResults.split('\n').filter((l) => l.trim());
  const resultLines = lines.filter((l) => /^\[\d+\]/.test(l.trim()));

  if (resultLines.length === 0) {
    return `Research completed for: "${task}". No specific results were extracted. The search may have returned no results or the pages were inaccessible.`;
  }

  const top = resultLines.slice(0, 5).join('\n');
  return `Based on web research for "${task}", here are the key findings:\n\n${top}\n\nUse this information to inform your design work.`;
}
