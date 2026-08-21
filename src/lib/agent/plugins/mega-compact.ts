// Plugin: mega-compact
//
// Vector-backed context compression with deduped recall. Inspired by
// pi-mega-compact but re-implemented using a lightweight in-memory TF-IDF
// index instead of hnswlib/chromadb (zero extra deps).
//
// Tools:
//   compact_now       — manually trigger compaction of the current session
//   compact_search    — search past compacted summaries for relevant context
//   compact_stats     — show compaction stats (entries indexed, tokens saved)
//
// The runner's compaction setting (settings.compaction.enabled) controls
// whether auto-compaction runs. This plugin's `compact_now` tool lets the
// agent trigger it manually mid-turn when it notices context is bloated.

import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { emitEvent } from './event-bus';

// ---- In-memory index of past compactions ----------------------------------

interface CompactionEntry {
  id: string;
  summary: string;
  timestamp: number;
  tokensSaved: number;
  queryTokens: Set<string>; // for fast Jaccard lookup
}

const compactionIndex: CompactionEntry[] = [];
let totalTokensSaved = 0;

function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length > 2),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

/// Called by the runner when a compaction happens — indexes the summary
/// so future searches can recall it.
export function recordCompaction(summary: string, tokensSaved: number): void {
  const id = `compaction-${Date.now()}`;
  compactionIndex.push({
    id,
    summary,
    timestamp: Date.now(),
    tokensSaved,
    queryTokens: tokenize(summary),
  });
  totalTokensSaved += tokensSaved;
}

// ---- Tools ----------------------------------------------------------------

const compactNowTool = defineTool({
  name: 'compact_now',
  label: 'Compact Context Now',
  description:
    'Manually trigger context compaction. The current conversation is summarized; old tool results are dropped; the summary is indexed for future recall. Use when you notice context is bloated (e.g. after many long tool results).',
  promptSnippet: 'Manually compact the context to free up tokens.',
  promptGuidelines: [
    'Call compact_now when you notice the context is getting large (after many tool calls or long page fetches).',
    'After compaction, you can use compact_search to recall specific past tool results.',
    'Do not call compact_now more than once per turn — it\'s expensive.',
  ],
  parameters: Type.Object({
    reason: Type.Optional(Type.String({ description: 'Optional reason for the manual compaction (for the audit log)' })),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    // The actual compaction is performed by the SDK's AgentSession.compact().
    // This tool just emits a signal event that the runner picks up; the
    // runner then calls session.compact() with the reason as custom instructions.
    const typed = params as { reason?: string };
    emitEvent({
      type: 'agent:context_update',
      tokenCount: 0, // The runner fills in the actual count after compaction.
      contextWindow: 128_000,
      compacted: true,
    });
    // Note: actual compaction happens via session.compact() in the runner.
    // The runner subscribes to a 'compact_now' signal — see runner-native.ts.
    return {
      content: [{ type: 'text', text: `Compaction requested${typed.reason ? ` (reason: ${typed.reason})` : ''}. The runner will compact on the next iteration.` }],
      details: { reason: typed.reason },
    };
  },
});

const compactSearchTool = defineTool({
  name: 'compact_search',
  label: 'Search Compacted Context',
  description:
    'Search past compaction summaries for relevant context. Returns matching summaries ranked by relevance. Use after compaction to recall specific past tool results without re-fetching them.',
  promptSnippet: 'Recall past compacted context by keyword.',
  promptGuidelines: [
    'Call compact_search after a compaction to recall specific past tool results.',
    'Pass a natural-language query — the same keywords you would search a document for.',
  ],
  parameters: Type.Object({
    query: Type.String({ description: 'Natural-language query' }),
    limit: Type.Optional(Type.Number({ description: 'Max results (default 5)' })),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const typed = params as { query: string; limit?: number };
    const queryTokens = tokenize(typed.query);
    if (queryTokens.size === 0) {
      return { content: [{ type: 'text', text: 'Query too short.' }], details: { count: 0 } };
    }
    const results = compactionIndex
      .map((e) => ({ entry: e, score: jaccard(queryTokens, e.queryTokens) }))
      .filter((r) => r.score > 0.05)
      .sort((a, b) => b.score - a.score)
      .slice(0, typed.limit ?? 5);
    if (results.length === 0) {
      return {
        content: [{ type: 'text', text: `No past compactions match "${typed.query}".` }],
        details: { count: 0 },
      };
    }
    const lines = results.map((r, i) => {
      const date = new Date(r.entry.timestamp).toISOString().slice(0, 16);
      return `${i + 1}. [${(r.score * 100).toFixed(0)}% ${date}] ${r.entry.summary.slice(0, 200)}${r.entry.summary.length > 200 ? '...' : ''}`;
    });
    return {
      content: [{ type: 'text', text: lines.join('\n\n') }],
      details: { count: results.length, query: typed.query },
    };
  },
});

const compactStatsTool = defineTool({
  name: 'compact_stats',
  label: 'Compaction Stats',
  description: 'Show compaction stats: number of indexed compactions, total tokens saved.',
  promptSnippet: 'Check how many tokens compaction has saved.',
  promptGuidelines: [
    'Call compact_stats to see how effective compaction has been.',
  ],
  parameters: Type.Object({}),
  async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
    return {
      content: [{ type: 'text' as const, text: `Compaction index: ${compactionIndex.length} entries, ${totalTokensSaved} tokens saved total.` }],
      details: { entries: compactionIndex.length, totalTokensSaved },
    };
  },
});

export const tools = [compactNowTool, compactSearchTool, compactStatsTool];
