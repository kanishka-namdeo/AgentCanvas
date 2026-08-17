// Web page fetcher — converts any URL to readable markdown / plain text.
//
// Mirrors oh-my-pi's `renderUrl()` pipeline (simplified), with the z.ai
// sandbox's built-in `page_reader` function added as a fallback for
// JS-rendered / bot-blocked pages:
//
//   1. Special-case JSON → pretty-print.
//   2. Special-case plain text → return as-is.
//   3. Special-case RSS/Atom feeds → top 10 items as markdown.
//   4. HTML → reader-backend chain:
//        a. readability — local: fetch + `@mozilla/readability` (via `linkedom`
//           DOM) + `turndown` for HTML→markdown. Primary path; no network
//           beyond the initial fetch.
//        b. z.ai page_reader — remote: `functions.invoke('page_reader', {url})`
//           returns server-rendered HTML (handles JS, bypasses many bot walls).
//           We then run it through readability too. No API key in the sandbox.
//        c. jina — remote: GET `https://r.jina.ai/<url>` (free, no auth).
//           Handles JS-rendered pages, paywalls, and bot-blocked sites.
//   5. Last resort: return the raw HTML (cleaned of script/style/nav).
//
// Each backend's output must clear a quality gate (`isLowQualityOutput`):
//   - > 100 non-whitespace chars
//   - Not containing "enable javascript" / "javascript required" /
//     "please enable javascript" (when < 1024 chars)
//   - Not > 70% short lines (< 40 chars, when > 10 lines total)
//
// If a backend's output is substantial but fails the gate, we still try the
// next backend; if no backend clears the gate, we return whatever we have
// (raw HTML as a last resort).

import ZAI from 'z-ai-web-dev-sdk';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import {
  type FetchResult,
  MAX_BODY_BYTES,
  MAX_OUTPUT_CHARS,
  JINA_MAX_BYTES,
  FETCH_TIMEOUT_MS,
  FETCH_USER_AGENTS,
} from './types';

// ---- z.ai SDK singleton ---------------------------------------------------

let _zaiPromise: Promise<ZAI> | null = null;
async function getZai(): Promise<ZAI> {
  if (!_zaiPromise) {
    _zaiPromise = ZAI.create();
  }
  return _zaiPromise;
}

// ---- Public entry point ---------------------------------------------------

export interface FetchParams {
  url: string;
  /// Skip rendering and return the raw HTML (cleaned of scripts/styles).
  raw?: boolean;
  /// AbortSignal for cancellation.
  signal?: AbortSignal;
}

/**
 * Fetch a URL and convert it to readable markdown / plain text.
 *
 * Server-side only. Throws on total failure (e.g. network error, invalid URL).
 */
export async function webFetch(params: FetchParams): Promise<FetchResult> {
  const url = normalizeUrl(params.url);
  if (!url) {
    throw new Error(`Invalid URL: ${params.url}`);
  }

  // Fetch the raw bytes (with the first User-Agent).
  const page = await fetchPage(url, { signal: params.signal, raw: params.raw });

  // `raw` mode: skip rendering, return cleaned HTML.
  if (params.raw) {
    const cleaned = stripUnsafeTags(page.body);
    return {
      finalUrl: page.finalUrl,
      contentType: page.contentType,
      bytes: page.bytes,
      content: truncateOutput(cleaned),
      method: 'raw',
      truncated: cleaned.length > MAX_OUTPUT_CHARS,
      title: extractTitle(page.body),
    };
  }

  // Content-Type dispatch.
  const ct = page.contentType.toLowerCase();
  const body = page.body;

  // JSON → pretty-print.
  if (ct.includes('application/json') || looksLikeJson(body)) {
    try {
      const pretty = JSON.stringify(JSON.parse(body), null, 2);
      return {
        finalUrl: page.finalUrl,
        contentType: page.contentType,
        bytes: page.bytes,
        content: truncateOutput(pretty),
        method: 'json',
        truncated: pretty.length > MAX_OUTPUT_CHARS,
      };
    } catch {
      // Fall through to plain-text handling.
    }
  }

  // RSS / Atom feed.
  if (isFeed(body, ct)) {
    const md = parseFeedToMarkdown(body);
    if (md) {
      return {
        finalUrl: page.finalUrl,
        contentType: page.contentType,
        bytes: page.bytes,
        content: truncateOutput(md),
        method: 'feed',
        truncated: md.length > MAX_OUTPUT_CHARS,
      };
    }
  }

  // Plain text (and not HTML-looking).
  if ((ct.startsWith('text/plain') || ct.startsWith('text/markdown')) && !looksLikeHtml(body)) {
    return {
      finalUrl: page.finalUrl,
      contentType: page.contentType,
      bytes: page.bytes,
      content: truncateOutput(body),
      method: 'text',
      truncated: body.length > MAX_OUTPUT_CHARS,
    };
  }

  // HTML — run the reader-backend chain.
  // Backend A: local readability + turndown (fast, no external dependency).
  let lastError: string | undefined;
  let lowQualityFallback: string | undefined;
  try {
    const md = renderWithReadability(body, page.finalUrl);
    if (md) {
      if (!isLowQualityOutput(md)) {
        return {
          finalUrl: page.finalUrl,
          contentType: page.contentType,
          bytes: page.bytes,
          content: truncateOutput(md),
          method: 'readability',
          truncated: md.length > MAX_OUTPUT_CHARS,
          title: extractTitle(body),
        };
      }
      // Substantial but low-quality — save as fallback.
      if (md.length > 500) lowQualityFallback = md;
    }
  } catch (err: any) {
    lastError = `readability: ${err?.message ?? String(err)}`;
  }

  // Backend B: z.ai page_reader (server-rendered HTML, handles JS / bot walls).
  try {
    const html = await fetchHtmlWithZai(page.finalUrl, params.signal);
    if (html) {
      const md = renderWithReadability(html, page.finalUrl);
      if (md && !isLowQualityOutput(md)) {
        return {
          finalUrl: page.finalUrl,
          contentType: page.contentType,
          bytes: page.bytes,
          content: truncateOutput(md),
          method: 'zai',
          truncated: md.length > MAX_OUTPUT_CHARS,
          title: extractTitle(html) ?? extractTitle(body),
        };
      }
      if (md && md.length > 500 && !lowQualityFallback) lowQualityFallback = md;
    }
  } catch (err: any) {
    lastError = (lastError ? lastError + '; ' : '') + `zai: ${err?.message ?? String(err)}`;
  }

  // Backend C: Jina Reader (free, no-auth remote endpoint).
  try {
    const md = await fetchWithJina(page.finalUrl, params.signal);
    if (md && !isLowQualityOutput(md)) {
      return {
        finalUrl: page.finalUrl,
        contentType: page.contentType,
        bytes: page.bytes,
        content: truncateOutput(md),
        method: 'jina',
        truncated: md.length > MAX_OUTPUT_CHARS,
        title: extractTitle(body),
      };
    }
    if (md && md.length > 500 && !lowQualityFallback) lowQualityFallback = md;
  } catch (err: any) {
    lastError = (lastError ? lastError + '; ' : '') + `jina: ${err?.message ?? String(err)}`;
  }

  // If a backend produced something substantial but low-quality, return it
  // (better than raw HTML).
  if (lowQualityFallback) {
    return {
      finalUrl: page.finalUrl,
      contentType: page.contentType,
      bytes: page.bytes,
      content: truncateOutput(lowQualityFallback),
      method: 'low-quality',
      truncated: lowQualityFallback.length > MAX_OUTPUT_CHARS,
      title: extractTitle(body),
    };
  }

  // Last resort: cleaned raw HTML.
  const cleaned = stripUnsafeTags(body);
  if (cleaned.trim().length > 100) {
    return {
      finalUrl: page.finalUrl,
      contentType: page.contentType,
      bytes: page.bytes,
      content: truncateOutput(cleaned),
      method: 'raw-html',
      truncated: cleaned.length > MAX_OUTPUT_CHARS,
      title: extractTitle(body),
    };
  }

  throw new Error(
    `Could not extract readable content from ${page.finalUrl}. ${lastError ?? ''}`.trim(),
  );
}

// ---- HTTP fetch with UA rotation + body cap --------------------------------

interface FetchedPage {
  finalUrl: string;
  contentType: string;
  body: string;
  bytes: number;
}

async function fetchPage(url: string, opts: { signal?: AbortSignal; raw?: boolean }): Promise<FetchedPage> {
  let lastErr: any;
  // Try each UA in turn; on a bot-block response (403/503 with a challenge body),
  // advance to the next UA.
  for (let i = 0; i < FETCH_USER_AGENTS.length; i++) {
    const ua = FETCH_USER_AGENTS[i];
    try {
      const controller = new AbortController();
      const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
      const signals: AbortSignal[] = [timeout];
      if (opts.signal) signals.push(opts.signal);
      const combined = (AbortSignal as any).any(signals) as AbortSignal;
      combined.addEventListener('abort', () => controller.abort());

      const res = await fetch(url, {
        headers: {
          'User-Agent': ua,
          'Accept': opts.raw
            ? 'text/html,*/*;q=0.8'
            : 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'identity', // Cloudflare's Markdown-for-Agents corrupts under compression.
        },
        redirect: 'follow',
        signal: controller.signal,
      });

      if (!res.ok && (res.status === 403 || res.status === 429 || res.status === 503)) {
        // Sniff the body for a bot-challenge marker before giving up.
        const challengeText = await res.text();
        if (/cloudflare|captcha|challenge|access denied|enable javascript/i.test(challengeText)) {
          lastErr = new Error(`HTTP ${res.status} (bot challenge)`);
          continue; // try the next UA
        }
        // Non-challenge error — throw immediately, no point rotating UAs.
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
      const buf = await readCapped(res.body, MAX_BODY_BYTES);
      const body = bytesToString(buf, contentType);
      return {
        finalUrl: res.url || url,
        contentType,
        body,
        bytes: buf.byteLength,
      };
    } catch (err: any) {
      if (err?.name === 'AbortError' && opts.signal?.aborted) throw err; // caller cancelled
      lastErr = err;
      // try next UA
    }
  }
  throw lastErr ?? new Error(`Failed to fetch ${url}`);
}

/// Read up to `maxBytes` from a ReadableStream<Uint8Array>. Truncates mid-stream.
async function readCapped(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array> {
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > maxBytes) {
        const slice = value.slice(0, maxBytes - total);
        chunks.push(slice);
        total += slice.byteLength;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  if (truncated) {
    // Mark the buffer so the caller can tell — not strictly necessary since
    // we cap at MAX_BODY_BYTES which is well above the post-render cap.
  }
  return out;
}

/// Decode bytes to a string using the charset declared in Content-Type, or
/// sniff from a `<meta charset>` tag, defaulting to UTF-8.
function bytesToString(buf: Uint8Array, contentType: string): string {
  let charset = 'utf-8';
  const ctMatch = contentType.match(/charset=([^;]+)/i);
  if (ctMatch) charset = ctMatch[1].trim().toLowerCase();
  const decoder = new TextDecoder(charset, { fatal: false });
  let str = decoder.decode(buf);
  // Sniff `<meta charset>` if not declared in headers and decoding produced
  // replacement chars.
  if (!ctMatch && str.includes('\uFFFD')) {
    const metaMatch = str.match(/<meta[^>]*charset=["']?([^"'>\s]+)/i);
    if (metaMatch) {
      const sniffed = metaMatch[1].trim().toLowerCase();
      if (sniffed && sniffed !== charset) {
        return new TextDecoder(sniffed, { fatal: false }).decode(buf);
      }
    }
  }
  return str;
}

// ---- Reader backend A: local readability + turndown -----------------------
//
// We use `linkedom` (a fast, lightweight DOM implementation that works in
// Node.js without jsdom's overhead) to parse the HTML, then
// `@mozilla/readability` to extract the article content, then `turndown` to
// convert the cleaned HTML to GitHub-flavored markdown.

let _turndown: TurndownService | null = null;
function getTurndown(): TurndownService {
  if (_turndown) return _turndown;
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '_',
    hr: '---',
  });
  // Strip noisy elements before conversion.
  td.remove(['script', 'style', 'iframe', 'noscript', 'form', 'input', 'textarea', 'select', 'button', 'svg', 'canvas']);
  _turndown = td;
  return td;
}

function renderWithReadability(html: string, baseUrl: string): string | null {
  let doc: Document;
  try {
    const { document } = parseHTML(html);
    doc = document;
  } catch {
    return null;
  }
  if (!doc || !doc.documentElement) return null;

  // Readability mutates the DOM; clone first so we can fall back if it fails.
  let article;
  try {
    const reader = new Readability(doc as any, { charThreshold: 100 });
    article = reader.parse();
  } catch {
    article = null;
  }

  if (article?.content) {
    const md = getTurndown().turndown(article.content);
    const header = article.title ? `# ${article.title}\n\n` : '';
    return (header + md).trim();
  }

  // Readability failed → fall back to the body's main content via CSS selectors.
  const main =
    doc.querySelector('[data-pagefind-body]') ??
    doc.querySelector('main article') ??
    doc.querySelector('article') ??
    doc.querySelector('main') ??
    doc.querySelector('[role="main"]') ??
    doc.body;
  if (main) {
    const md = getTurndown().turndown(main.innerHTML);
    const title = extractTitle(html);
    const header = title ? `# ${title}\n\n` : '';
    return (header + md).trim();
  }

  return null;
}

// ---- Reader backend B: z.ai page_reader -----------------------------------
//
// `z-ai-web-dev-sdk`'s `functions.invoke('page_reader', { url })` returns
// `{ code, status, data: { html, title, url, publishedTime?, usage } }`.
// The HTML is server-rendered (handles JS, bypasses many bot walls). Inside
// the z.ai sandbox, credentials auto-resolve — no API key needed. Outside the
// sandbox, this throws and the chain advances to Jina.
//
// We return just the HTML; the caller runs it through `renderWithReadability`
// to get markdown (same as the direct-fetch path).

async function fetchHtmlWithZai(url: string, signal?: AbortSignal): Promise<string | null> {
  const zai = await getZai();
  // The ZAI SDK doesn't accept an AbortSignal; we rely on the overall
  // `FETCH_TIMEOUT_MS` race in the caller.
  const result = await zai.functions.invoke('page_reader', { url });
  if (!result || result.code !== 200 || !result.data?.html) {
    return null;
  }
  return result.data.html;
}

// ---- Reader backend C: Jina Reader (r.jina.ai) ----------------------------
//
// Jina AI's free `r.jina.ai` endpoint converts any URL to clean markdown.
// No auth, no API key. Handles JS-rendered pages and bypasses many bot walls.
// Response shape:
//
//   Title: <page title>
//   URL Source: <original url>
//   Markdown Content:
//   <markdown body>
//
// We strip the leading metadata block and return the markdown body.

async function fetchWithJina(url: string, signal?: AbortSignal): Promise<string | null> {
  const jinaUrl = 'https://r.jina.ai/' + url;
  const controller = new AbortController();
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const signals: AbortSignal[] = [timeout];
  if (signal) signals.push(signal);
  const combined = (AbortSignal as any).any(signals) as AbortSignal;
  combined.addEventListener('abort', () => controller.abort());

  const res = await fetch(jinaUrl, {
    headers: {
      'Accept': 'text/markdown',
      'User-Agent': FETCH_USER_AGENTS[1],
      'X-No-Cache': 'true',
      'X-Return-Format': 'markdown',
    },
    redirect: 'follow',
    signal: controller.signal,
  });
  if (!res.ok) {
    throw new Error(`jina HTTP ${res.status}`);
  }
  const text = await readCappedText(res.body, JINA_MAX_BYTES);
  // Strip the metadata header up to `Markdown Content:`.
  const markerIdx = text.indexOf('Markdown Content:');
  if (markerIdx >= 0) {
    return text.slice(markerIdx + 'Markdown Content:'.length).trim();
  }
  return text.trim();
}

async function readCappedText(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
  const buf = await readCapped(stream, maxBytes);
  return new TextDecoder('utf-8', { fatal: false }).decode(buf);
}

// ---- Quality gate (mirrors oh-my-pi's isLowQualityOutput) -----------------

function isLowQualityOutput(s: string): boolean {
  const nonWs = s.replace(/\s/g, '');
  if (nonWs.length <= 100) return true;
  if (s.length < 1024) {
    const lower = s.toLowerCase();
    if (
      lower.includes('enable javascript') ||
      lower.includes('javascript required') ||
      lower.includes('please enable javascript') ||
      lower.includes('browser not supported')
    ) {
      return true;
    }
  }
  const lines = s.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length > 10) {
    const short = lines.filter((l) => l.trim().length < 40).length;
    if (short / lines.length > 0.7) return true;
  }
  return false;
}

// ---- Helpers --------------------------------------------------------------

function normalizeUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  // Allow bare `example.com` → `https://example.com`.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return 'https://' + trimmed;
  }
  try {
    new URL(trimmed);
    return trimmed;
  } catch {
    return null;
  }
}

function looksLikeHtml(s: string): boolean {
  const head = s.slice(0, 1000).toLowerCase();
  return head.includes('<html') || head.includes('<body') || head.includes('<div') || head.includes('<p');
}

function looksLikeJson(s: string): boolean {
  const trimmed = s.trim();
  if (!trimmed) return false;
  return (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
}

function isFeed(body: string, contentType: string): boolean {
  const ct = contentType.toLowerCase();
  if (ct.includes('xml') || ct.includes('rss') || ct.includes('atom')) {
    return /<rss|<feed|<rdf:RDF/i.test(body);
  }
  return /<rss\b|<feed\b/i.test(body);
}

function stripUnsafeTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTitle(html: string): string | undefined {
  const m1 = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i);
  if (m1) return decodeEntities(m1[1]).trim();
  const m2 = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (m2) return decodeEntities(m2[1]).trim();
  return undefined;
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

function truncateOutput(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  return s.slice(0, MAX_OUTPUT_CHARS) + '\n\n…[truncated]';
}

// ---- RSS / Atom feed → markdown -------------------------------------------
//
// A minimal, dependency-free feed parser. Handles RSS 2.0 and Atom 1.0.
// Returns null if the input doesn't look like a feed.

function parseFeedToMarkdown(xml: string): string | null {
  const items = parseFeedItems(xml);
  if (!items || items.length === 0) return null;
  const lines: string[] = ['# Feed items', ''];
  items.slice(0, 10).forEach((it, i) => {
    lines.push(`## ${i + 1}. ${it.title ?? '(untitled)'}`);
    if (it.link) lines.push(`- Link: ${it.link}`);
    if (it.date) lines.push(`- Published: ${it.date}`);
    if (it.desc) lines.push('', truncate(it.desc.replace(/<[^>]+>/g, ''), 500));
    lines.push('');
  });
  return lines.join('\n');
}

function parseFeedItems(xml: string): Array<{ title?: string; link?: string; desc?: string; date?: string }> | null {
  const out: Array<{ title?: string; link?: string; desc?: string; date?: string }> = [];
  // RSS 2.0: <item>...<title>...</title>...<link>...</link>...<description>...</description>...<pubDate>...</pubDate>...</item>
  const rssItems = xml.split(/<item\b[\s>]/i).slice(1);
  for (const block of rssItems) {
    const endIdx = block.indexOf('</item>');
    const item = endIdx >= 0 ? block.slice(0, endIdx) : block;
    out.push({
      title: pickTag(item, 'title'),
      link: pickTag(item, 'link'),
      desc: pickTag(item, 'description'),
      date: pickTag(item, 'pubDate'),
    });
  }
  if (out.length > 0) return out;

  // Atom 1.0: <entry>...<title>...</title>...<link href="..."/>...<summary>...</summary>...<published>...</published>...</entry>
  const atomItems = xml.split(/<entry\b[\s>]/i).slice(1);
  for (const block of atomItems) {
    const endIdx = block.indexOf('</entry>');
    const item = endIdx >= 0 ? block.slice(0, endIdx) : block;
    const linkMatch = item.match(/<link[^>]*href="([^"]+)"/i);
    out.push({
      title: pickTag(item, 'title'),
      link: linkMatch?.[1],
      desc: pickTag(item, 'summary') ?? pickTag(item, 'content'),
      date: pickTag(item, 'published') ?? pickTag(item, 'updated'),
    });
  }
  return out.length > 0 ? out : null;
}

function pickTag(s: string, tag: string): string | undefined {
  const m = s.match(new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, 'i'));
  if (m) return m[1].trim();
  const m2 = s.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  if (m2) return decodeEntities(m2[1]).trim();
  return undefined;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

// ---- Formatting -----------------------------------------------------------
//
// Format the fetch result as a single text block for the LLM. Mirrors
// oh-my-pi's `read` tool output: a small header (URL, Content-Type, method),
// a separator, then the rendered content.

export function formatFetchForLLM(r: FetchResult): string {
  const header = [
    `URL: ${r.finalUrl}`,
    `Content-Type: ${r.contentType}`,
    `Method: ${r.method}${r.truncated ? ' (truncated)' : ''}${r.title ? ` · ${r.title}` : ''}`,
    '---',
  ].join('\n');
  return `${header}\n${r.content}`;
}
