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
// Each line is a Pattern record. The store is append-only (records never
// get deleted; they age out by recency_weight).
//
// Retrieval: simple lexical similarity (Jaccard on token sets) — good
// enough for our scale (hundreds of patterns, not millions). For larger
// stores we'd swap in a vector DB (e.g. hnswlib or chromadb).

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
  } catch (err) {
    console.warn('[design-pattern-memory] failed to persist pattern:', err);
  }
  return full;
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
 */
export async function retrieveSimilarPatterns(
  queryPrompt: string,
  k = 3,
): Promise<DesignPattern[]> {
  const patterns = await loadAllPatterns();
  if (patterns.length === 0) return [];

  const queryTokens = tokenize(queryPrompt);

  const scored = patterns.map((p) => {
    const patternTokens = tokenize(`${p.prompt} ${p.summary} ${p.category} ${p.parameters.join(' ')}`);
    const lexical = jaccardSimilarity(queryTokens, patternTokens);
    // Recency boost: patterns < 7 days old get +0.1, < 30 days +0.05.
    const ageDays = (Date.now() - p.createdAt) / (1000 * 60 * 60 * 24);
    const recencyBoost = ageDays < 7 ? 0.1 : ageDays < 30 ? 0.05 : 0;
    // User-approved patterns get +0.05 (they're higher signal).
    const approvedBoost = p.userApproved ? 0.05 : 0;
    return {
      ...p,
      score: lexical + recencyBoost + approvedBoost,
    };
  });

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
