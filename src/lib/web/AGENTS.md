# AGENTS.md — `src/lib/web/`

## Purpose

The web search + web fetch subsystem: a zero-config, no-API-key fallback chain for searching the web and fetching page content as readable markdown/plain text. Designed to work inside the z.ai sandbox (where credentials auto-resolve) and outside (via public scrapers). The agent tools `web_search` and `web_fetch` (in `src/lib/agent/tools.ts`) are thin wrappers around this module.

## Ownership

- `search.ts` — `webSearch(params: SearchParams): Promise<SearchResponse>`. Sequential fallback chain of 4 providers:
  1. **z.ai `web_search`** — sandbox-native, best quality, auto-resolves credentials via `z-ai-web-dev-sdk`.
  2. **DuckDuckGo (HTML POST)** — `https://html.duckduckgo.com/html/`, regex parsing, most reliable public scraper.
  3. **Startpage (form-flow POST)** — proxies Google's index, requires `sc` token from home page, tighter bot defense.
  4. **Jina AI Search** — `https://s.jina.ai/<query>`, free public endpoint, no auth, returns markdown.
  First provider returning ≥1 result wins. On total failure, returns `{ provider: 'none', results: [], error }`.
- `fetch.ts` — `webFetch(params: FetchParams): Promise<FetchResult>`. Multi-backend reader pipeline:
  1. Content-Type dispatch: JSON → pretty-print, RSS/Atom → markdown feed, plain text → return as-is.
  2. **HTML → readability chain (3 backends)**:
     a. **Local readability** — `linkedom` DOM + `@mozilla/readability` + `turndown` (HTML→markdown). Primary path.
     b. **z.ai `page_reader`** — server-rendered HTML via `z-ai-web-dev-sdk`, handles JS/bot walls. Then readability.
     c. **Jina Reader** — `https://r.jina.ai/<url>`, free no-auth, handles JS/paywalls/bot-blocks.
  3. **Quality gate** (`isLowQualityOutput`) — each backend's output must clear: >100 non-ws chars, no "enable javascript" when <1024 chars, not >70% short lines. Low-quality but substantial output saved as fallback.
  4. **Last resort**: cleaned raw HTML (scripts/styles/iframes stripped).
- `types.ts` — Shared types: `SearchSource`, `SearchResponse`, `FetchResult`, `SearchParams`, `FetchParams`, plus constants (`MAX_OUTPUT_CHARS=500k`, `MAX_BODY_BYTES=50MiB`, `JINA_MAX_BYTES=2MiB`, `DEFAULT_SEARCH_LIMIT=8`, `MAX_SEARCH_LIMIT=30`, `SEARCH_PROVIDER_TIMEOUT_MS=12s`, `FETCH_TIMEOUT_MS=20s`, `FETCH_USER_AGENTS[3]`). Browser-safe (no DOM/fetch).

## Local Contracts

### Search Contract (`search.ts`)
- **Input**: `SearchParams { query, limit?, recency?, signal? }`. `recency`: 'day' | 'week' | 'month' | 'year'.
- **Output**: `SearchResponse { provider, results: SearchSource[], error? }`. `SearchSource`: `{ title, url, snippet?, publishedDate?, engine? }`.
- **Provider chain order is fixed** — do not reorder without parent-level decision (z.ai is sandbox-primary, DuckDuckGo is most reliable public).
- **Timeout**: each provider capped at `SEARCH_PROVIDER_TIMEOUT_MS` (12s) via `withTimeout` (races `AbortSignal.timeout` + caller's `signal`).
- **Error accumulation**: failures from each provider concatenated into final `error` string.
- **DuckDuckGo parsing**: regex-based on stable HTML structure (`<div class="result">` blocks). Detects `anomaly-modal` bot challenge.
- **Startpage flow**: 2-step — GET home page → extract `sc` token → POST `/sp/search` with token. Detects captcha shell.
- **Jina Search**: simple GET `https://s.jina.ai/<encoded-query>`, parses numbered markdown list.
- **LLM formatting**: `formatSearchForLLM(res)` → human-readable block with numbered results (matches oh-my-pi shape).

### Fetch Contract (`fetch.ts`)
- **Input**: `FetchParams { url, raw?, signal? }`. `raw=true` skips rendering, returns cleaned HTML.
- **Output**: `FetchResult { finalUrl, contentType, bytes, content, method, truncated, title? }`. `method`: 'readability' | 'zai' | 'jina' | 'raw' | 'text' | 'json' | 'feed' | 'raw-html' | 'low-quality'.
- **HTTP fetch**: UA rotation (3 UAs), body cap `MAX_BODY_BYTES` (50MiB) via stream reader, charset detection (header → meta tag → UTF-8), bot-challenge detection (403/429/503 + challenge markers).
- **Readability backend**: `linkedom` parse → `@mozilla/readability` (charThreshold=100) → `turndown` (GFM, strips script/style/iframe/noscript/form/input/textarea/select/button/svg/canvas). Falls back to CSS selectors if readability fails.
- **z.ai page_reader**: `functions.invoke('page_reader', {url})` → returns server-rendered HTML → readability.
- **Jina Reader**: GET `https://r.jina.ai/<url>` → strips metadata header → markdown body.
- **Quality gate** (`isLowQualityOutput`): mirrors oh-my-pi. If all backends fail gate but one produced >500 chars, returns as 'low-quality'. If nothing >100 chars, throws.
- **Feed parsing**: RSS 2.0 (`<item>`) + Atom 1.0 (`<entry>`) → top 10 items as markdown.
- **LLM formatting**: `formatFetchForLLM(r)` → header (URL, Content-Type, Method, Title) + separator + content.

### Types Contract (`types.ts`)
- Pure TypeScript — no runtime code. Safe to import from browser code (agent tools run server-side but types are shared).
- All response shapes mirror oh-my-pi / Pi Agent SDK conventions for compatibility.

## Work Guidance

- When adding a new search provider: add it to the chain in `search.ts` (respecting priority order), add parsing function, update `SEARCH_PROVIDER_TIMEOUT_MS` if needed, add to `formatSearchForLLM` if engine-specific formatting needed.
- When adding a new fetch backend: add it to the HTML chain in `fetch.ts` (after readability, before Jina, or as new last resort), implement quality gate compliance, add `method` literal to `FetchResult.method` type.
- When debugging search/fetch failures: check `dev.log` for provider error chain. The error message includes all attempted providers.
- The z.ai SDK singleton (`getZai()`) is shared between search and fetch — caches the `ZAI.create()` promise.
- **Do not add API keys** to this module — the design is explicitly zero-config. The z.ai sandbox auto-resolves; outside the sandbox, the public scrapers are the fallback.
- When changing `SearchSource` / `FetchResult` shapes: update `src/lib/agent/tools.ts` tool result formatting accordingly.

## Verification

- `bunx tsc --noEmit` — typecheck.
- `bun run test` — unit tests may cover parsing functions (exported for testing: `parseDuckDuckGoHtml`, `parseStartpageHtml`, `parseJinaSearch`).
- Manual: in the app, use the agent with a prompt requiring web search — verify results stream back.
- Manual: use the agent with a prompt requiring web fetch — verify readable markdown returns.
- `bun run scripts/eval-agent.ts` — includes web_research skill eval prompts.

## Child DOX Index

No child `AGENTS.md` files. This folder is flat: `search.ts`, `fetch.ts`, `types.ts`.

*Siblings: `../agent/AGENTS.md` (Agent layer), `../canvas/AGENTS.md` (Canvas state), `../sessions/AGENTS.md` (Session persistence), `../settings/AGENTS.md` (Settings store), `../pen/AGENTS.md` (.pen format), `../llm/AGENTS.md` (LLM provider registry).*