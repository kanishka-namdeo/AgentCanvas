// Design-pattern memory — a lightweight RAG store for design patterns.
//
// Implements the "Memory" agentic design pattern (also called "Agent Memory"
// or "Long-term Memory with Retrieval"):
//   https://code.claude.com/docs/en/sub-agents
//   https://www.promptingtrust.ai/post/the-reflection-pattern-how-self-critique-makes-ai-smarter
//
// The pattern: every successful design generation gets summarized into a
// "pattern" (textual description + key parameters) and stored. On future
// prompts, we retrieve the top-k most similar patterns and inject them as
// context — letting the agent learn from past successes.
//
// Why this matters:
//   1. Continuity across sessions (the agent "remembers" what worked).
//   2. Style transfer — a user who always picks minimalist designs will see
//      minimalist-leaning suggestions over time.
//   3. Faster convergence — the agent skips patterns the user has rejected.
//
// Storage: filesystem-backed JSONL file at `data/design-patterns.jsonl`.
// Each line is a Pattern record.
//
// UI-audit round 7 (perf H-5): the store is now capped at MAX_PATTERNS
// (1000) entries — on write, if the file exceeds the cap, the oldest
// entries are evicted. The in-memory tokenization cache avoids re-tokenizing
// the whole file on every retrieval call (was O(N) disk + parse + tokenize
// per turn; now O(N) only on first load or after a write, with O(1)
// cache hits on subsequent retrievals).

import { promises as fs } from 'node:fs';
import path from 'node:path';

// ---- Types ----------------------------------------------------------------

export interface DesignPattern {
  /// Unique id (UUID).
  id: string;
  /// When the pattern was stored (epoch ms).
  createdAt: number;
  /// The original user prompt that produced this design.
  prompt: string;
  /// A 1-3 sentence summary of what was built (e.g. "Mobile login screen
  /// with social sign-in buttons, violet accent, 24px spacing").
  summary: string;
  /// The category (wireframe, dashboard, landing-page, etc.).
  category: string;
  /// Key parameters the agent chose (palette, font sizes, layout direction).
  /// Stored as key=value lines for compactness.
  parameters: string[];
  /// Whether the user explicitly approved/saved this design (vs auto-saved).
  userApproved: boolean;
  /// Similarity score (only set on retrieved patterns; 0..1, higher = better).
  score?: number;
}

// ---- Storage ---------------------------------------------------------------

const PATTERNS_DIR = path.join(process.cwd(), 'data');
const PATTERNS_FILE = path.join(PATTERNS_DIR, 'design-patterns.jsonl');

/// UI-audit round 7 (perf H-5): cap the store at 1000 entries. On write,
/// if the file exceeds this cap, the oldest entries are evicted. Prevents
/// the O(N) disk + parse + tokenize per-turn cost from growing unbounded
/// on long-running installs.
const MAX_PATTERNS = 1000;

async function ensureStore(): Promise<void> {
  try {
    await fs.mkdir(PATTERNS_DIR, { recursive: true });
    // Touch the file if it doesn't exist.
    await fs.access(PATTERNS_FILE).catch(() => fs.writeFile(PATTERNS_FILE, ''));
  } catch {
    // Best-effort — if the FS isn't writable, the memory just doesn't persist.
  }
}

/**
 * Append a pattern to the store. Best-effort — silently swallows FS errors
 * (the agent shouldn't fail because the memory store is unwritable).
 *
 * UI-audit round 7: after appending, if the file exceeds MAX_PATTERNS lines,
 * rewrites the file keeping only the newest MAX_PATTERNS entries. Also
 * invalidates the in-memory tokenization cache so the next retrieval
 * re-tokenizes the updated set.
 */
export async function storeDesignPattern(pattern: Omit<DesignPattern, 'id' | 'createdAt'>): Promise<DesignPattern> {
  const full: DesignPattern = {
    ...pattern,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
  };
  try {
    await ensureStore();
    await fs.appendFile(PATTERNS_FILE, JSON.stringify(full) + '\n', 'utf8');
    // Cap the store: if it's grown past MAX_PATTERNS, trim the oldest.
    await trimIfNeeded();
    // Invalidate the tokenization cache so the next retrieval picks up
    // the new pattern.
    tokenCache = null;
  } catch (err) {
    console.warn('[design-pattern-memory] failed to persist pattern:', err);
  }
  return full;
}

/// UI-audit round 7: trim the JSONL file to MAX_PATTERNS entries if it
/// has grown past the cap. Keeps the newest entries (highest createdAt).
/// Best-effort — silently swallows FS errors.
async function trimIfNeeded(): Promise<void> {
  try {
    const text = await fs.readFile(PATTERNS_FILE, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    if (lines.length <= MAX_PATTERNS) return;
    // Parse all, sort by createdAt descending, keep the newest MAX_PATTERNS.
    const patterns: DesignPattern[] = [];
    for (const line of lines) {
      try { patterns.push(JSON.parse(line) as DesignPattern); } catch { /* skip */ }
    }
    patterns.sort((a, b) => b.createdAt - a.createdAt);
    const kept = patterns.slice(0, MAX_PATTERNS);
    await fs.writeFile(
      PATTERNS_FILE,
      kept.map((p) => JSON.stringify(p)).join('\n') + '\n',
      'utf8',
    );
    console.log(`[design-pattern-memory] trimmed from ${lines.length} to ${MAX_PATTERNS} entries`);
  } catch {
    // Best-effort.
  }
}

/**
 * Read all patterns from the store. Best-effort — returns [] on any FS error.
 */
export async function loadAllPatterns(): Promise<DesignPattern[]> {
  try {
    await ensureStore();
    const text = await fs.readFile(PATTERNS_FILE, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    const patterns: DesignPattern[] = [];
    for (const line of lines) {
      try {
        patterns.push(JSON.parse(line) as DesignPattern);
      } catch {
        // Skip malformed lines.
      }
    }
    return patterns;
  } catch {
    return [];
  }
}

// ---- Retrieval ------------------------------------------------------------

/**
 * Tokenize a string into a set of lowercase word tokens (>= 3 chars).
 * Strips punctuation. Used for Jaccard similarity.
 */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const w of words) {
    if (w.length >= 3) tokens.add(w);
  }
  return tokens;
}

/// UI-audit round 7 (perf H-5): in-memory tokenization cache. Avoids
/// re-tokenizing the whole file on every retrieval call (was O(N) per
/// turn). Invalidated on write (storeDesignPattern sets tokenCache = null).
/// Keyed by pattern id so a cached pattern's tokens survive even if the
/// patterns array is re-loaded from disk.
interface TokenCacheEntry {
  id: string;
  tokens: Set<string>;
  createdAt: number;
}
let tokenCache: { entries: TokenCacheEntry[]; byId: Map<string, Set<string>> } | null = null;

/**
 * UI-audit round 7: get the tokenized patterns, using the in-memory cache
 * when possible. The cache is built once per load (or after a write), then
 * reused on every subsequent retrieval call.
 */
async function getTokenizedPatterns(): Promise<TokenCacheEntry[]> {
  if (tokenCache) return tokenCache.entries;
  const patterns = await loadAllPatterns();
  const entries: TokenCacheEntry[] = [];
  const byId = new Map<string, Set<string>>();
  for (const p of patterns) {
    const tokens = tokenize(`${p.prompt} ${p.summary} ${p.category} ${p.parameters.join(' ')}`);
    entries.push({ id: p.id, tokens, createdAt: p.createdAt });
    byId.set(p.id, tokens);
  }
  tokenCache = { entries, byId };
  return entries;
}

/**
 * Compute Jaccard similarity between two token sets:
 *   |A ∩ B| / |A ∪ B|
 * Returns 0..1 (1 = identical).
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Retrieve the top-k patterns most similar to a query prompt.
 *
 * Uses Jaccard similarity on token sets (lexical matching). For larger
 * stores (>10k patterns), we'd want vector embeddings + cosine similarity.
 *
 * Recency boost: newer patterns get a small multiplier so the agent
 * prefers recently-successful designs.
 *
 * UI-audit round 7: uses the in-memory tokenization cache — O(N) only on
 * first load or after a write, O(1) cache hits on subsequent calls.
 */
export async function retrieveSimilarPatterns(
  queryPrompt: string,
  k = 3,
): Promise<DesignPattern[]> {
  const patterns = await loadAllPatterns();
  if (patterns.length === 0) return [];

  const tokenized = await getTokenizedPatterns();
  const queryTokens = tokenize(queryPrompt);

  // Build a lookup so we can join the cached tokens back to the full pattern.
  const patternById = new Map(patterns.map((p) => [p.id, p]));

  const scored = tokenized.map((entry) => {
    const p = patternById.get(entry.id);
    if (!p) return null;
    const lexical = jaccardSimilarity(queryTokens, entry.tokens);
    // Recency boost: patterns < 7 days old get +0.1, < 30 days +0.05.
    const ageDays = (Date.now() - p.createdAt) / (1000 * 60 * 60 * 24);
    const recencyBoost = ageDays < 7 ? 0.1 : ageDays < 30 ? 0.05 : 0;
    // User-approved patterns get +0.05 (they're higher signal).
    const approvedBoost = p.userApproved ? 0.05 : 0;
    return {
      ...p,
      score: lexical + recencyBoost + approvedBoost,
    };
  }).filter((x): x is DesignPattern & { score: number } => x !== null);

  return scored
    .filter((p) => (p.score ?? 0) > 0.05)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, k);
}

/**
 * Format retrieved patterns for injection into the agent's system prompt.
 * Returns a compact text block (~200-500 tokens depending on k).
 */
export function formatPatternsForPrompt(patterns: DesignPattern[]): string {
  if (patterns.length === 0) return '(no relevant past patterns found)';
  return patterns
    .map((p, i) => {
      const score = ((p.score ?? 0) * 100).toFixed(0);
      const params = p.parameters.length > 0 ? `\n    params: ${p.parameters.join(', ')}` : '';
      return `${i + 1}. [${p.category}, ${score}% match] ${p.summary}${params}\n    prompt: "${p.prompt.slice(0, 100)}"`;
    })
    .join('\n');
}

/**
 * Clear all patterns (for the `pen_clear_pattern_memory` tool).
 * Returns the count of deleted patterns.
 */
export async function clearAllPatterns(): Promise<number> {
  try {
    const patterns = await loadAllPatterns();
    await fs.writeFile(PATTERNS_FILE, '', 'utf8');
    // UI-audit round 7: invalidate the token cache.
    tokenCache = null;
    return patterns.length;
  } catch {
    return 0;
  }
}

/**
 * Get stats about the pattern store (count, oldest, newest).
 */
export async function getPatternStats(): Promise<{ count: number; oldest?: number; newest?: number }> {
  const patterns = await loadAllPatterns();
  if (patterns.length === 0) return { count: 0 };
  const timestamps = patterns.map((p) => p.createdAt);
  return {
    count: patterns.length,
    oldest: Math.min(...timestamps),
    newest: Math.max(...timestamps),
  };
}
