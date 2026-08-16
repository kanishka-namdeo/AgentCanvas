// Web search — zero-config, no-API-key providers.
//
// Implements a sequential-fallback chain of four free search engines,
// modelled on oh-my-pi's `SEARCH_PROVIDER_ORDER` for the credential-free
// path, with the z.ai sandbox's built-in `web_search` function prepended
// as the primary (it auto-resolves credentials inside the sandbox and
// gives Google-quality results with zero configuration).
//
// The chain is:
//
//   1. z.ai `web_search` (via z-ai-web-dev-sdk) — sandbox-native, best
//      quality, no API key needed inside the z.ai sandbox. Outside the
//      sandbox it falls through to the public scrapers below.
//   2. DuckDuckGo (HTML POST) — simple, reliable, no bot defense on most IPs.
//   3. Startpage (form-flow POST, proxies Google's index) — higher quality,
//      but tighter bot defense; needs an `sc` token lifted from the home page.
//   4. Jina AI Search (https://s.jina.ai/<query>) — free public endpoint,
//      no auth, returns clean text/markdown with embedded search results.
//
// Each provider returns a normalized `SearchResponse`. If a provider throws
// or returns zero results, we advance to the next. If every provider fails,
// we return a response with `error` set and `results: []` — the agent sees
// a legible error message rather than a thrown exception.
//
// All network access happens server-side (this module is imported only from
// `src/lib/agent/tools.ts`, which runs in the Next.js API route).

import ZAI from 'z-ai-web-dev-sdk';
import {
  type SearchResponse,
  type SearchSource,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  SEARCH_PROVIDER_TIMEOUT_MS,
  FETCH_USER_AGENTS,
} from './types';

// ---- z.ai SDK singleton ---------------------------------------------------
//
// The runner already creates a ZAI instance for the LLM; we cache one here
// too so the web tools don't re-authenticate on every call. `ZAI.create()`
// is cheap (it just resolves credentials from the env) and idempotent.

let _zaiPromise: Promise<ZAI> | null = null;
async function getZai(): Promise<ZAI> {
  if (!_zaiPromise) {
    _zaiPromise = ZAI.create();
  }
  return _zaiPromise;
}

// ---- Public entry point ---------------------------------------------------

export interface SearchParams {
  query: string;
  /// Max results to return (default 8, hard cap 30).
  limit?: number;
  /// Optional recency filter — passes through to engines that support it.
  recency?: 'day' | 'week' | 'month' | 'year';
  /// AbortSignal so the agent runner can cancel an in-flight search.
  signal?: AbortSignal;
}

/**
 * Run a web search across the no-API-key provider chain.
 *
 * Tries each provider in order; the first one that returns ≥1 result wins.
 * On total failure, returns `{ provider: 'none', results: [], error }`.
 */
export async function webSearch(params: SearchParams): Promise<SearchResponse> {
  const query = params.query.trim();
  if (!query) {
    return { provider: 'none', results: [], error: 'Empty query' };
  }
  const limit = clamp(params.limit ?? DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);

  const failures: string[] = [];

  // 1. z.ai web_search — primary (sandbox-native, best quality, no API key).
  try {
    const r = await withTimeout(searchZai(query, limit, params.recency, params.signal), SEARCH_PROVIDER_TIMEOUT_MS, params.signal);
    if (r.results.length > 0) return r;
    failures.push(`zai: ${r.error ?? 'no results'}`);
  } catch (err: any) {
    failures.push(`zai: ${err?.message ?? String(err)}`);
  }

  // 2. DuckDuckGo — fallback (most reliable public scraper, least bot defense).
  try {
    const r = await withTimeout(searchDuckDuckGo(query, limit, params.recency, params.signal), SEARCH_PROVIDER_TIMEOUT_MS, params.signal);
    if (r.results.length > 0) return r;
    failures.push(`duckduckgo: ${r.error ?? 'no results'}`);
  } catch (err: any) {
    failures.push(`duckduckgo: ${err?.message ?? String(err)}`);
  }

  // 3. Startpage — fallback (Google-index quality, tighter bot defense).
  try {
    const r = await withTimeout(searchStartpage(query, limit, params.recency, params.signal), SEARCH_PROVIDER_TIMEOUT_MS, params.signal);
    if (r.results.length > 0) return r;
    failures.push(`startpage: ${r.error ?? 'no results'}`);
  } catch (err: any) {
    failures.push(`startpage: ${err?.message ?? String(err)}`);
  }

  // 4. Jina AI Search — final fallback (free public endpoint, no auth).
  try {
    const r = await withTimeout(searchJina(query, limit, params.signal), SEARCH_PROVIDER_TIMEOUT_MS, params.signal);
    if (r.results.length > 0) return r;
    failures.push(`jina: ${r.error ?? 'no results'}`);
  } catch (err: any) {
    failures.push(`jina: ${err?.message ?? String(err)}`);
  }

  return {
    provider: 'none',
    results: [],
    error: `All search providers failed: ${failures.join('; ')}`,
  };
}

// ---- Provider 0: z.ai web_search (primary) -------------------------------
//
// `z-ai-web-dev-sdk`'s `functions.invoke('web_search', { query, num, recency_days })`
// returns `SearchFunctionResultItem[]` with `{ url, name, snippet, host_name,
// rank, date, favicon }`. Inside the z.ai sandbox, credentials auto-resolve
// from the environment — no API key needed. Outside the sandbox, this will
// throw and the chain advances to the public scrapers.

async function searchZai(
  query: string,
  limit: number,
  recency: SearchParams['recency'],
  signal?: AbortSignal,
): Promise<SearchResponse> {
  const zai = await getZai();
  const args: { query: string; num: number; recency_days?: number } = {
    query,
    num: limit,
  };
  if (recency) {
    const days = recency === 'day' ? 1 : recency === 'week' ? 7 : recency === 'month' ? 30 : 365;
    args.recency_days = days;
  }
  // The ZAI SDK doesn't accept an AbortSignal directly; we rely on the
  // outer `withTimeout` wrapper to race this call.
  const items = await zai.functions.invoke('web_search', args);
  if (!Array.isArray(items)) {
    return { provider: 'zai', results: [], error: 'non-array response' };
  }
  const results: SearchSource[] = items.slice(0, limit).map((it) => ({
    title: (it.name || '').trim(),
    url: (it.url || '').trim(),
    snippet: (it.snippet || '').trim() || undefined,
    publishedDate: (it.date || '').trim() || undefined,
    engine: 'zai',
  })).filter((r) => r.title && r.url);
  if (results.length === 0) {
    return { provider: 'zai', results, error: 'no results returned' };
  }
  return { provider: 'zai', results };
}

// ---- Provider 1: DuckDuckGo HTML ------------------------------------------
//
// POST https://html.duckduckgo.com/html/ with `application/x-www-form-urlencoded`
// body `q=<query>&kl=us-en`. The response is a minimal HTML page whose result
// blocks follow a stable structure:
//
//   <div class="result ...">
//     <a class="result__a" href="//duckduckgo.com/l/?uddg=<encoded-url>">title</a>
//     <a class="result__snippet">snippet text</a>
//     <span class="result__url">example.com</span>
//   </div>
//
// We parse with regex (no DOM dependency, fast, resilient to whitespace
// changes). DuckDuckGo occasionally returns an `anomaly-modal` body when it
// throttles a datacenter IP — we detect that and throw so the chain advances.

async function searchDuckDuckGo(
  query: string,
  limit: number,
  recency: SearchParams['recency'],
  signal?: AbortSignal,
): Promise<SearchResponse> {
  const body = new URLSearchParams();
  body.set('q', query);
  body.set('kl', 'us-en');
  if (recency) body.set('df', recency === 'day' ? 'd' : recency === 'week' ? 'w' : recency === 'month' ? 'm' : 'y');
  body.set('b', '');

  const res = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': FETCH_USER_AGENTS[0],
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    },
    body: body.toString(),
    signal,
    redirect: 'follow',
  });

  if (!res.ok) {
    throw new Error(`duckduckgo HTTP ${res.status}`);
  }
  const html = await res.text();

  // Bot-challenge detection (oh-my-pi uses the same heuristic).
  if (html.includes('anomaly-modal') || html.includes('anomaly.js')) {
    throw new Error('duckduckgo rate-limited (anomaly modal)');
  }

  const results = parseDuckDuckGoHtml(html, limit);
  if (results.length === 0) {
    return { provider: 'duckduckgo', results, error: 'no results parsed' };
  }
  return { provider: 'duckduckgo', results };
}

/**
 * Parse DuckDuckGo's HTML result page. Exported for unit testing.
 *
 * Strategy: split the page on `<div class="result` to isolate result blocks,
 * then within each block pull out the `<a class="result__a" href="...">title</a>`
 * and the `<a class="result__snippet">snippet</a>`.
 */
export function parseDuckDuckGoHtml(html: string, limit: number): SearchSource[] {
  const blocks = html.split(/<div class="result\b/).slice(1);
  const out: SearchSource[] = [];
  for (const block of blocks) {
    if (out.length >= limit) break;
    // The first `<a class="result__a" href="...">` is the title link.
    const linkMatch = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const rawHref = linkMatch[1];
    const url = unwrapDdgRedirect(rawHref);
    if (!url || !/^https?:\/\//i.test(url)) continue;
    const title = stripTags(decodeEntities(linkMatch[2])).trim();
    if (!title) continue;

    // Snippet can be in <a class="result__snippet"> or <div class="result__snippet">.
    const snipMatch = block.match(/<(?:a|div|span)[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/i);
    const snippet = snipMatch ? stripTags(decodeEntities(snipMatch[1])).trim() : undefined;

    out.push({ title, url, snippet, engine: 'duckduckgo' });
  }
  return out;
}

/// DuckDuckGo wraps result URLs in a redirect: `//duckduckgo.com/l/?uddg=<encoded>`.
/// Unwrap it; fall back to the raw href if it's already a direct URL.
function unwrapDdgRedirect(href: string): string | undefined {
  // Normalize leading `//` to `https://`.
  const full = href.startsWith('//') ? 'https:' + href : href;
  const m = full.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return undefined;
    }
  }
  return full;
}

// ---- Provider 2: Startpage ------------------------------------------------
//
// Startpage proxies Google's index but fronts it with a form that requires
// a hidden `sc` anti-bot token. The flow is:
//   1. GET https://www.startpage.com/ to retrieve the home page HTML.
//   2. Extract `<input type="hidden" name="sc" value="...">` from the form.
//   3. POST https://www.startpage.com/sp/search with `query=<q>` + `sc=<token>`.
//   4. Parse the result page — result blocks are `<div class="result">` with
//      `<a class="result-link" href="...">title</a>` and `<p class="description">snippet</p>`.
//
// If the home page returns a captcha shell (`component---src-pages-captcha`),
// we bail and let the chain advance.

async function searchStartpage(
  query: string,
  limit: number,
  recency: SearchParams['recency'],
  signal?: AbortSignal,
): Promise<SearchResponse> {
  // Step 1: fetch the home page to lift the `sc` token.
  const homeRes = await fetch('https://www.startpage.com/', {
    headers: {
      'User-Agent': FETCH_USER_AGENTS[0],
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    },
    signal,
    redirect: 'follow',
  });
  if (!homeRes.ok) {
    throw new Error(`startpage home HTTP ${homeRes.status}`);
  }
  const homeHtml = await homeRes.text();
  if (homeHtml.includes('component---src-pages-captcha')) {
    throw new Error('startpage captcha shell');
  }
  // The form posts to /sp/search and includes name="query" + name="sc".
  const scMatch = homeHtml.match(/<input[^>]*name="sc"[^>]*value="([^"]+)"/i);
  const scToken = scMatch?.[1] ?? '';

  // Step 2: POST the search form.
  const form = new URLSearchParams();
  form.set('query', query);
  form.set('sc', scToken);
  if (recency) form.set('with_date', recency === 'day' ? 'd' : recency === 'week' ? 'w' : recency === 'month' ? 'm' : 'y');
  form.set('cat', 'web');
  form.set('pl', 'opensearch');

  const searchRes = await fetch('https://www.startpage.com/sp/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': FETCH_USER_AGENTS[0],
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Referer': 'https://www.startpage.com/',
    },
    body: form.toString(),
    signal,
    redirect: 'follow',
  });
  if (!searchRes.ok) {
    throw new Error(`startpage search HTTP ${searchRes.status}`);
  }
  const html = await searchRes.text();
  if (html.includes('component---src-pages-captcha') || html.includes('/en/errors/')) {
    throw new Error('startpage captcha challenge');
  }

  const results = parseStartpageHtml(html, limit);
  if (results.length === 0) {
    return { provider: 'startpage', results, error: 'no results parsed' };
  }
  return { provider: 'startpage', results };
}

/**
 * Parse Startpage's HTML result page. Exported for unit testing.
 *
 * Result blocks: `<div class="result">` containing
 *   `<a class="result-link" href="https://...">title</a>` and
 *   `<p class="description">snippet</p>`.
 */
export function parseStartpageHtml(html: string, limit: number): SearchSource[] {
  const blocks = html.split(/<div[^>]*class="[^"]*\bresult\b[^"]*"/).slice(1);
  const out: SearchSource[] = [];
  for (const block of blocks) {
    if (out.length >= limit) break;
    const linkMatch = block.match(/<a[^>]*class="[^"]*result-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const url = linkMatch[1];
    if (!url || !/^https?:\/\//i.test(url)) continue;
    // Skip Startpage's own self-links.
    if (/startpage\.com/i.test(url)) continue;
    const title = stripTags(decodeEntities(linkMatch[2])).trim();
    if (!title) continue;

    const snipMatch = block.match(/<p[^>]*class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snipMatch ? stripTags(decodeEntities(snipMatch[1])).trim() : undefined;

    out.push({ title, url, snippet, engine: 'startpage' });
  }
  return out;
}

// ---- Provider 3: Jina AI Search (s.jina.ai) ------------------------------
//
// Jina AI operates a free, no-auth search endpoint at `https://s.jina.ai/<query>`.
// It returns a plain-text/markdown page with `Title:`, `URL Source:`, and
// `Markdown Content:` headers followed by a numbered list of results.
//
// This is the most resilient fallback — no bot defense, no form tokens — but
// it adds an external network hop and is rate-limited on the free tier.
// We use it only when DuckDuckGo and Startpage both fail.

async function searchJina(query: string, limit: number, signal?: AbortSignal): Promise<SearchResponse> {
  const url = 'https://s.jina.ai/' + encodeURIComponent(query);
  const res = await fetch(url, {
    headers: {
      'Accept': 'text/plain',
      'User-Agent': FETCH_USER_AGENTS[1],
      'X-No-Cache': 'true',
    },
    signal,
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`jina search HTTP ${res.status}`);
  }
  const text = await res.text();
  const results = parseJinaSearch(text, limit);
  if (results.length === 0) {
    return { provider: 'jina', results, error: 'no results parsed' };
  }
  return { provider: 'jina', results };
}

/**
 * Parse the text response from `s.jina.ai/<query>`.
 *
 * The response looks like:
 *
 *   Title: <query>
 *   URL Source: https://s.jina.ai/<query>
 *   Markdown Content:
 *   1. [Title One](https://example.com/page1)
 *      snippet text...
 *   2. [Title Two](https://example.com/page2)
 *      ...
 *
 * We extract the numbered list and pair each title link with the following
 * indented snippet text.
 */
export function parseJinaSearch(text: string, limit: number): SearchSource[] {
  // Drop everything before the "Markdown Content:" header.
  const markerIdx = text.indexOf('Markdown Content:');
  const body = markerIdx >= 0 ? text.slice(markerIdx + 'Markdown Content:'.length) : text;

  // Match numbered list items: `N. [Title](url)` optionally followed by
  // indented snippet text on subsequent lines until the next numbered item.
  const itemRegex = /(?:^|\n)\s*\d+\.\s*\[([^\]]*)\]\(([^)]+)\)([\s\S]*?)(?=\n\s*\d+\.\s*\[|$)/g;
  const out: SearchSource[] = [];
  let m: RegExpExecArray | null;
  while ((m = itemRegex.exec(body)) !== null && out.length < limit) {
    const title = stripTags(decodeEntities(m[1])).trim();
    const url = m[2].trim();
    if (!title || !url || !/^https?:\/\//i.test(url)) continue;
    const snippet = m[3] ? m[3].replace(/^\s+/, '').split(/\n\s*\n/)[0].trim() : undefined;
    out.push({
      title,
      url,
      snippet: snippet ? truncate(snippet, 300) : undefined,
      engine: 'jina',
    });
  }
  return out;
}

// ---- Formatting -----------------------------------------------------------
//
// Format the search results as a single text block for the LLM. Matches
// oh-my-pi's `formatForLLM()` shape:
//
//   Found N results via <provider>:
//
//   [1] <title>
//       <url>
//       <snippet (truncated to 240 chars)>
//
//   [2] ...

export function formatSearchForLLM(res: SearchResponse): string {
  if (res.results.length === 0) {
    return `No web search results found.${res.error ? ` (${res.error})` : ''}`;
  }
  const header = `Found ${res.results.length} result${res.results.length === 1 ? '' : 's'} via ${res.provider}:`;
  const lines = res.results.map((r, i) => {
    const title = r.title || '(untitled)';
    const url = r.url;
    const snip = r.snippet ? truncate(r.snippet, 240) : '';
    const age = r.publishedDate ? ` (${r.publishedDate})` : '';
    return `[${i + 1}] ${title}${age}\n    ${url}${snip ? '\n    ' + snip : ''}`;
  });
  return [header, '', ...lines].join('\n');
}

// ---- Shared utilities -----------------------------------------------------

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, '') // drop all tags
    .replace(/\s+/g, ' '); // collapse whitespace
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)));
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Race a promise against a hard timeout. Composes the caller's AbortSignal
 * (if any) with `AbortSignal.timeout` so a stalled TCP connection cannot
 * hang the chain. Mirrors oh-my-pi's `withHardTimeout`.
 */
async function withTimeout<T>(p: Promise<T>, ms: number, externalSignal?: AbortSignal): Promise<T> {
  const timeoutSignal = AbortSignal.timeout(ms);
  const signals: AbortSignal[] = [timeoutSignal];
  if (externalSignal) signals.push(externalSignal);
  const combined = (AbortSignal as any).any(signals) as AbortSignal;

  return new Promise<T>((resolve, reject) => {
    combined.addEventListener('abort', () => {
      reject(new Error(combined.reason?.message ?? `timeout after ${ms}ms`));
    });
    p.then(resolve, reject);
  });
}
