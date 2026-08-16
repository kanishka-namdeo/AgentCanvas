// Shared types for the web search + web fetch subsystem.
//
// This module is browser-safe (no DOM, no fetch) — it only declares types
// that are consumed by both the agent tools (server-side) and the runner.
//
// Design references:
//   - oh-my-pi (https://github.com/can1357/oh-my-pi) — provider chain, fallback
//     semantics, result ranking, and the `SearchSource` shape.
//   - Pi Agent SDK `AgentToolResult` — content blocks + details object.

/**
 * A single search result. Mirrors oh-my-pi's `SearchSource`.
 */
export interface SearchSource {
  /// Result title (plain text, HTML entities decoded).
  title: string;
  /// Canonical, fully-qualified URL (decodes redirects like
  /// `//duckduckgo.com/l/?uddg=...`).
  url: string;
  /// Short snippet describing the result. May be HTML-truncated.
  snippet?: string;
  /// ISO date string or relative like "2d ago", if the engine exposed it.
  publishedDate?: string;
  /// Which engine produced this result (for debugging / dedup ranking).
  engine?: string;
}

/**
 * Normalized search response returned by every provider.
 */
export interface SearchResponse {
  /// Which engine ultimately produced the results.
  provider: string;
  /// Ordered list of results (best first).
  results: SearchSource[];
  /// If every provider failed, the human-readable error chain.
  error?: string;
}

/**
 * Result of fetching a URL and converting it to readable text.
 */
export interface FetchResult {
  /// The URL we ended up at (after redirects).
  finalUrl: string;
  /// The Content-Type the server returned.
  contentType: string;
  /// How many bytes the raw body was (before truncation).
  bytes: number;
  /// The readable markdown / plain text extracted from the page.
  content: string;
  /// Which backend produced `content` — "readability" | "jina" | "raw" | "text" | "json".
  method: string;
  /// True if the content was truncated to fit the char budget.
  truncated: boolean;
  /// Optional page title (extracted from <title> or og:title).
  title?: string;
}

/// Hard ceiling on post-render output (matches oh-my-pi's MAX_OUTPUT_CHARS).
export const MAX_OUTPUT_CHARS = 500_000;

/// Hard ceiling on the raw HTTP body (matches oh-my-pi's MAX_BYTES = 50 MiB).
export const MAX_BODY_BYTES = 50 * 1024 * 1024;

/// Cap on Jina Reader responses (matches oh-my-pi's JINA_READER_MAX_BYTES).
export const JINA_MAX_BYTES = 2 * 1024 * 1024;

/// Default number of search results to return when `limit` is omitted.
export const DEFAULT_SEARCH_LIMIT = 8;

/// Max number of search results any provider will return.
export const MAX_SEARCH_LIMIT = 30;

/// Default overall timeout for a single search provider (ms).
export const SEARCH_PROVIDER_TIMEOUT_MS = 12_000;

/// Default overall timeout for a single fetch attempt (ms).
export const FETCH_TIMEOUT_MS = 20_000;

/// User-Agent strings we rotate through to dodge naive bot blocks.
/// (Same 3 UAs oh-my-pi uses for `loadPage`.)
export const FETCH_USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (compatible; TextBot/1.0; +https://example.com/bot)',
  'curl/8.0',
] as const;
