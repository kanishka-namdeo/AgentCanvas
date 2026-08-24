// Context management — uses the pi-agent SDK's standalone compaction functions
// to prevent context overflow on long conversations.
//
// The SDK provides:
//   - estimateTokens(message): number — quick token estimate for a single message
//   - shouldCompact(contextTokens, contextWindow, settings): boolean
//   - DEFAULT_COMPACTION_SETTINGS: { enabled, reserveTokens, keepRecentTokens }
//
// We use these to:
//   1. Track token consumption per turn (surfaced to the UI)
//   2. Detect when compaction is needed
//   3. Implement a lightweight compaction that summarizes old tool results
//      (The SDK's full compact() requires a model + apiKey — too heavy for
//       standalone use. Instead, we truncate old tool results in-place,
//       keeping the most recent ones intact.)

import { estimateTokens, DEFAULT_COMPACTION_SETTINGS } from '@earendil-works/pi-coding-agent';

export { DEFAULT_COMPACTION_SETTINGS };

type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/// Estimate the total token count for a message array.
/// Uses the SDK's estimateTokens() which does a char/4 heuristic per message.
export function calculateContextTokens(messages: Array<{ role: MessageRole; content: string; tool_calls?: any[] }>): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(msg as any);
  }
  return total;
}

/// Check if the context is approaching the model's limit and needs compaction.
/// Uses the SDK's shouldCompact() heuristic: compact when
///   contextTokens > contextWindow - reserveTokens
export function shouldCompact(contextTokens: number, contextWindow: number = 128_000): boolean {
  return contextTokens > contextWindow - DEFAULT_COMPACTION_SETTINGS.reserveTokens;
}

/// Lightweight in-place compaction: summarize old tool results by truncating
/// them to a short summary. Keeps the most recent `keepRecent` messages intact.
///
/// This is a simpler alternative to the SDK's full compact() (which requires
/// an LLM call to generate a summary). For tool-heavy design turns, most of
/// the context is tool results (pen_list_shapes output, etc.) that can be
/// safely truncated once the agent has seen them.
///
/// @param messages The full message array (system + user + assistant + tool)
/// @param keepRecent Number of recent messages to keep intact (default 8)
/// @returns The compacted message array + the number of tokens saved
export function compactToolResults(
  messages: Array<{ role: MessageRole; content: string; tool_calls?: any[]; tool_call_id?: string }>,
  keepRecent: number = 8,
): { messages: typeof messages; tokensSaved: number } {
  if (messages.length <= keepRecent + 1) {
    return { messages, tokensSaved: 0 };
  }

  const beforeTokens = calculateContextTokens(messages);
  const result = [...messages];

  // Keep the system message (index 0) + the last `keepRecent` messages intact.
  // Compact everything in between by truncating tool results.
  const startIdx = 1; // skip system
  const endIdx = result.length - keepRecent;

  for (let i = startIdx; i < endIdx; i++) {
    const msg = result[i];
    if (msg.role === 'tool' && msg.content.length > 200) {
      // Truncate old tool results to a short summary.
      const truncated = msg.content.slice(0, 150) + '\n…[compacted — full result omitted]';
      result[i] = { ...msg, content: truncated };
    }
    // Also truncate very long assistant messages (but keep tool_calls intact)
    if (msg.role === 'assistant' && msg.content && msg.content.length > 500 && !msg.tool_calls) {
      const truncated = msg.content.slice(0, 200) + '\n…[compacted]';
      result[i] = { ...msg, content: truncated };
    }
  }

  const afterTokens = calculateContextTokens(result);
  return { messages: result, tokensSaved: beforeTokens - afterTokens };
}

/// Format a token count for display in the UI.
/// Example: 45200 → "45.2K", 128000 → "128K"
export function formatTokens(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}K`;
  }
  return String(tokens);
}
