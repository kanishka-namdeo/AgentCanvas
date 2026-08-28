# Agent Durability Research — Lessons from bolt.new, v0, Lovable, tldraw & OpenHands

**Date:** 2026-08-28
**Method:** 5 parallel research agents — (1) full audit of AgentCanvas's own agent architecture, plus deep-dives into (2) bolt.diy (open-source bolt.new, commit `2e254ac`), (3) v0's leaked system prompts + Vercel AI SDK source, (4) Lovable's leaked agent prompt + tldraw make-real source, (5) OpenHands agent-sdk source (event-sourcing, condenser, resume). Clones preserved under `research-scan/`.

**Goal:** Make AgentCanvas's agent behavior more **durable** (survives failures, resumable), **consistent** (reliable, reproducible output), and **efficient** (tokens, latency, context window).

---

## 1. Executive summary — top 10 recommendations (impact-ordered)

| # | Recommendation | Learned from | Effort |
|---|---|---|---|
| 1 | **Server-side event journal** — write every agent event to SQLite as an append-only log; make runs resumable | OpenHands event sourcing | M |
| 2 | **Boot-time interrupted-run recovery** — on server start, salvage stranded `in_progress` runs with synthetic "interrupted" observations | OpenHands | M |
| 3 | **Server-side Stop + stream watchdog** — wire AbortSignal through the route; 45s no-chunk watchdog with ≤2 retries | bolt.diy + our audit | S |
| 4 | **Tool-call-ID dedup + patch sanitizer** — idempotent patch application; validate shape IDs / clamp coords *before* appending | tldraw + AI SDK | S |
| 5 | **Tool-arg repair loop** — on invalid args, one repair round (error + schema back to model) before giving up | Vercel AI SDK `repairToolCall` | S |
| 6 | **Kill the full-canvas snapshot** — replace with dual-channel context: compact shape digest + selection + off-viewport summary (+ optional screenshot) | tldraw docs/ai + bolt `selectContext` | M |
| 7 | **Condensation for long sessions** — structured rolling summary (CANVAS_STATE / COMPLETED / PENDING), hard trigger on token overflow | OpenHands condenser | M |
| 8 | **Stuck detection + corrective nudge** — hash recent (tool, args, result); error streak → one nudge → stop honestly | OpenHands | S |
| 9 | **Typed NDJSON error events** — `{statusCode, isRetryable, errorType}`; classified client toasts instead of silent failures | bolt.diy | S |
| 10 | **Auto-continue past truncation** — `finishReason: 'length'` → synthetic continue prompt, cap 2 segments | bolt.diy `SwitchableStream` | S |

---

## 2. Where AgentCanvas stands today (audit findings)

**Already strong (keep and double down):**
- Byte-stable ~45K-token system prompt with `PI_CACHE_RETENTION=long` — measured **90–99% prompt-cache hit**; snapshot moved out of the system prompt precisely to keep the prefix stable (`runner-native.ts`, `pi-ai-model-resolver.ts`).
- Mandatory critique loop (max 2 iterations, free validators → text + VLM critics concurrently) already in the production runner.
- Parallel tool emission with sequential mode for mutations; ≤12-call budget; brief pre-generation; 25K tool-result truncation; client-side rAF patch coalescing.
- Endpoint preflight (4s, cached) + one-shot z.ai fallback; `llm-retry.ts` with 5-attempt exponential backoff (legacy path).
- Append-only patch philosophy in the Zustand canvas store.

**Critical gaps found (evidence in the audit):**

*Durability*
- The Prisma `AgentAction` audit table has **zero writers** — dead schema. All DB persistence (sessions/runs/messages) rides on **client fire-and-forget POSTs with silent catches** (`sessions/server-sync.ts`) — a closed tab or server crash mid-run loses everything.
- The pi session is in-memory only; **conversation history never enters the model context** (every turn is a fresh session), so there is nothing to resume from even if we wanted to.
- Server restart mid-run: WS doc re-seeds from last `DocumentSnapshot` — **patches after the last `turn_end` are lost**; DB runs stranded `in_progress`; messages stranded `streaming`.
- No stream watchdog: a hung provider stream hangs the request indefinitely.

*Consistency*
- `stopAgent` aborts only the client fetch — **the server keeps executing and broadcasting patches** (`store.ts:1351`; no AbortSignal wired into `session.prompt`).
- **No tool-call-ID dedup** on the server applier or client `_onSync` — NDJSON replay / double-delivery double-applies patches (append-only means a bad patch lives forever).
- `driveAgent` emits an **unconditional `turn_end`** that can double the runner's authoritative one.
- Canvas serialization is *not* canonically sorted (IDs are fresh UUIDs, order follows patch-application order) — hurts reproducibility and caching.
- No stuck-detection: an agent that repeats the same failing tool call burns its full 30-iteration budget.

*Efficiency*
- **Entire untruncated canvas snapshot in the first user message, every turn** (`runner-legacy.ts:759-905`) — unbounded token growth with node count; also defeats cross-turn caching of that message.
- SDK compaction is **disabled** on the native path (`runner-native.ts:849`); the context manager only exists in the legacy loop.
- One NDJSON line + one socket emit per patch — no server-side batching (only the client renderer coalesces).
- Sub-agent LLM clients + ModelRuntime rebuilt per turn; preflight cache only 60s.

---

## 3. What each app teaches (deep dives with evidence)

### 3.1 bolt.diy — the durability toolkit

Repo: `research-scan/bolt-diy` @ `2e254ac` (Feb 2026).

| Mechanism | What it does | Evidence |
|---|---|---|
| Incremental resumable parser | Keeps per-message `(position, insideArtifact, insideAction)` state; parses only new bytes; partial tags → wait for more | `app/lib/runtime/message-parser.ts` |
| Self-healing output repair | Pattern-matches bare code blocks / shell commands the model emitted outside the XML protocol and rewrites them into synthetic actions — no extra LLM call | `app/lib/runtime/enhanced-message-parser.ts` |
| SwitchableStream auto-continue | On `finishReason === 'length'`, appends partial output + CONTINUE_PROMPT and swaps in a new upstream stream (max 2 segments); client never notices | `app/routes/api.chat.ts`, `switchable-stream.ts` |
| Stream watchdog | 45s inactivity timeout, max 2 retries, `updateActivity()` on every stream part | `app/lib/.server/llm/stream-recovery.ts` |
| Two-stage context pipeline | `createSummary` (rolling summary) + `selectContext` (LLM picks ≤5 relevant files via `<updateContextBuffer>` tags), persisted as message annotations so they survive refresh | `create-summary.ts`, `select-context.ts` |
| History folding + payload elision | Only last 3 messages sent; summary + files move into system prompt; old file bodies elided with `...` | `stream-text.ts` |
| IndexedDB snapshots + rewind | 50ms sampler persists messages during streaming; each turn saves a file snapshot; on reload, pre-snapshot messages are archived and replaced by one synthetic restore artifact; `?rewindTo=` restores any point | `useChatHistory.ts`, `db.ts` |
| Typed error envelope | Server returns `{error, message, statusCode, isRetryable, provider}`; client classifies auth/rate-limit/quota/network into distinct alerts; failed trailing message dropped before next send | `api.chat.ts`, `Chat.client.tsx` |
| ActionRunner | Sequential queue with per-action AbortController + status; suppresses error alerts when replaying historical actions after reload | `action-runner.ts` |
| User-edit deltas | Tracks `#modifiedFiles` (originals); next send injects ONLY user-modified files as a delta artifact, then resets | `files.ts`, `Chat.client.tsx` |

### 3.2 v0 — the consistency playbook

From the leaked v0 agent system prompt (`scripts/research/page-01-v0-prompt.json`):

- **Hard design constraints as law:** "ALWAYS use exactly 3–5 colors total", max 2 font families, line-height 1.4–1.6, semantic tokens only (never raw colors), Tailwind scale not arbitrary values, "never ugly".
- **Plan-first:** `EnterPlanMode` for large builds (plan approved before code), `TodoManager` for multi-step tracking, `AskUserQuestions` to validate assumptions.
- **Mandatory design brief tool** before any design work — generate the visual spec first, then implement against it. *(AgentCanvas already has brief pre-generation — v0 confirms the pattern.)*
- **~12 few-shot "Alignment" examples** showing the exact expected thought/trace format.
- **Self-verification via runtime feedback:** instrument with `console.log("[v0] …")`, read the live debug log, skip stale errors by timestamp, clean up debug statements after.
- **Context economy:** old tool results compressed to "Content omitted to save context" with retrieval paths; MEMORY.md index capped ~200 lines + on-demand topic files; mid-chat automated rule reminders; stop retrying after 2 consecutive sandbox failures.
- **Counter-signal:** when constraints loosen, quality collapses into "stacked blocks with placeholder text" — the constraints ARE the product.

### 3.3 Vercel AI SDK — the tool-loop machinery

Repo: `research-scan/ai-sdk`.

| Mechanism | What it does | Evidence |
|---|---|---|
| `repairToolCall` | On `NoSuchToolError`/`InvalidToolInputError`, repair fn receives (error, messages, tools, schema accessor) and returns a corrected call; if unrepairable, call marked `invalid: true` instead of throwing | `packages/ai/src/generate-text/parse-tool-call.ts:52-94` |
| Errors-as-tool-results | Invalid calls + thrown tools become tool-error outputs sent back to the model — the loop never crashes on one bad call | `execute-tool-call.ts:162-191` |
| `stopWhen` bounded loop | do-while with typed stop conditions; agent default `isStepCount(20)` | `stop-condition.ts`, `tool-loop-agent-settings.ts` |
| `fixJson` / `parsePartialJson` | Linear-time state machine that closes unterminated strings/objects — typed partial tool args while tokens stream | `util/fix-json.ts` |
| Retry honoring `retry-after` | maxRetries 2, 2s initial, only retries 408/409/429/5xx; parses `retry-after-ms`, clamps 0–60s | `util/retry-with-exponential-backoff.ts` |
| Cache-aware tool ordering | Unlisted tools sorted alphabetically — "can improve provider-side caching by keeping tool definitions in a stable order" | `tool-order.ts` |
| Stitchable streams | New step's stream replaces the old without breaking consumers; errors emitted as parts, not rejections | `create-stitchable-stream.ts` |

### 3.4 Lovable — planning discipline

From the leaked agent prompt (`scripts/research/page-02-lovable-agent.json`) + architecture analysis (`page-03-lovable-arch.json`):

- **Ordered required workflow:** context-first → tool review → discussion-default → think & plan → clarify → gather context → implement → verify & conclude. Steps cannot be skipped.
- **THINK & PLAN contract:** restate what the user is ACTUALLY asking; define EXACTLY what will change and what remains untouched; plan a minimal but CORRECT approach.
- **Anti-pitfall checklist:** forbidden failure modes — OVERENGINEERING, SCOPE CREEP, MONOLITHIC FILES, DOING TOO MUCH AT ONCE ("make small, verifiable changes instead of large rewrites"), sequential tool calls that could be combined, reading files already in context, writing without context.
- **Verify-after-each-step:** debugging tools FIRST (console logs, network requests) before examining code; conclude with ≤2-line summary.
- **Error escalation ladder:** try-to-fix (free auto-repair) → investigate from observed behavior → revert to older working version → edit a past message. Every change stays in history and is re-appliable.
- **Governance:** LOVABLE.md policy file + CI layer blocking violations + full audit trail.

### 3.5 tldraw make-real — canvas-agent interplay

Repo: `research-scan/make-real` + tldraw.dev/docs/ai.

- **Provenance hierarchy in the prompt** (the killer lesson): "Code = absolute source of truth... Canvas image = shows user's NEW changes/annotations; Screenshot artifacts = IGNORE these." Prevents the #1 failure of image-in/image-out loops: cross-iteration drift. Production prompt is versioned (`MIGRATION_VERSION = 13`) so prompt updates ship deterministically.
- **Validate-and-rollback:** generated HTML must be ≥100 chars else the created shape is deleted and a categorized toast explains why (rate-limit / token-limit → "select fewer shapes").
- **Determinism:** `temperature: 0, seed: 42` on all providers.
- **Dual-channel canvas context** (tldraw agent docs): viewport screenshot + simplified structured shape data + off-viewport cluster summaries + current selection + recent actions. Each channel covers the other's blindness.
- **Action sanitization layer:** validate, sanitize, and apply — "corrects shape IDs that don't exist, ensures new IDs are unique, normalizes coordinates"; actions apply only when streaming is complete.
- **Comments (not shapes) as the human↔agent channel** — threaded, pinned to shapes, resolvable.

### 3.6 OpenHands — the durability gold standard

Repo: `research-scan/openhands-sdk` (agent-sdk).

| Mechanism | What it does | Evidence |
|---|---|---|
| Immutable event log | Every action/observation = frozen event (UUID, timestamp, `parent_id` tree) persisted as one JSON file per event under flock; in-memory index rebuilt by scanning filenames — crash-safe by construction | `conversation/event_store.py` |
| Resume factory | `ConversationState.create()` opens-or-creates: reads `base_state.json`, rebuilds everything else by replaying the log; `agent.verify()` enforces resume compatibility (tools may be added, never removed) | `conversation/state.py`, `agent/base.py` |
| Restart crash recovery | On boot, `RUNNING` conversations → `ERROR` (resumable); `get_unmatched_actions()` finds tool actions with no observation and appends synthetic "interrupted" error events parented to the orphans | `agent_server/event_service.py:1140-1184` |
| Ownership lease | `owner_lease.json` (owner pid/host, expiry, monotonic generation) prevents split-brain double-running | `conversation_lease.py` |
| Condensation tombstones | Forgetting = a `Condensation` event listing `forgotten_event_ids` + summary; the LLM's `View` is a deterministic projection of the log applying tombstones — replay reproduces the identical context | `event/condenser.py`, `context/view/view.py` |
| LLMSummarizingCondenser | HARD trigger (tokens > min(own max, model limit)) vs SOFT (event count > 80); keeps first `keep_first` events + recent half; summarizes the middle with a cheap LLM; `minimum_progress` guard (must shrink ≥10%); hard context reset retries 5× shrinking payloads ×0.8 | `llm_summarizing_condenser.py` |
| Structured summary prompt | Forced sections: USER_CONTEXT, TASK_TRACKING (exact task IDs/statuses), COMPLETED, PENDING, CURRENT_STATE — the schema is what keeps facts alive across re-summaries | `summarizing_prompt.j2` |
| Classified LLM errors | Retry transient (conn/rate/5xx, 5×, 8-64s backoff) / walk fallback chain / **context overflow → condense instead of failing** | `llm/llm.py`, `fallback_strategy.py` |
| Stuck detector | Hashes recent action→observation pairs; identical repeats or error streaks → one-time corrective nudge, then persisted STUCK status | `conversation/stuck_detector.py` |
| Ephemeral vs durable | Streaming deltas are NEVER persisted (UX-only); reconnecting clients get the final message from history | `event/streaming_delta.py` |

---

## 4. The playbook — mapped to our codebase

### D — Durability

**D1. Make the dead `AgentAction` table a real event journal.**
Add `seq` (monotonic per session), `parentId`, `type` (`action|observation|error|status|condensation`), `payload JSON`. Write from the **server** inside the runner loop (every tool call, result, agent event) — replacing the client fire-and-forget POSTs as the source of truth for runs. Resume = `SELECT ... WHERE seq > ? ORDER BY seq`. *From: OpenHands #1. Files: `src/app/api/agent/route.ts`, `src/lib/agent/runner-native.ts`, `prisma/schema.prisma`.*

**D2. Boot-time interrupted-run recovery.**
In `instrumentation.ts` on server start: find sessions with `status='running'` → mark `error (resumable)`; scan the journal for tool actions without terminal observations; append synthetic "execution interrupted by restart" observations. Clients re-fetch events since their watermark. *From: OpenHands #3.*

**D3. Server-side Stop.**
Wire `AbortSignal` from the route request → `session.prompt()`; emit a terminal `turn_cancelled` event; reconcile with the client's `stopAgent` so a stopped run actually stops server-side. Also fixes the double-`turn_end` from `driveAgent`'s unconditional emit (`canvas/server.ts:270`). *From: our audit + bolt's per-action AbortController.*

**D4. Stream watchdog + typed error events.**
Route handler tracks time-since-last-NDJSON-chunk; >45s → abort + retry the LLM call (≤2), then emit `{type:'error', statusCode, isRetryable, errorType}`. Client renders classified toasts (auth / rate-limit / quota / network) instead of silent failure. *From: bolt #4, #8.*

**D5. Auto-continue past truncation.**
On `finishReason === 'length'` in the pi loop: append partial content + a synthetic "continue" user message and keep piping into the same NDJSON response (cap 2 segments). Large generations stop dying mid-drawing. *From: bolt #3.*

**D6. Persisted snapshots cadence fix.**
Snapshot the canvas at run boundaries (not just turn ends) so a WS-service restart loses at most the in-flight turn — combined with D1's journal, patches become replayable. *From: bolt #7 + OpenHands #2.*

### C — Consistency

**C1. Tool-call-ID dedup + patch sanitizer (the append-only imperative).**
Because patches are append-only, a bad patch can never be edited out — sanitize BEFORE appending: verify referenced shape IDs exist, reject/dedupe duplicate IDs, clamp coordinates/sizes to viewport bounds, normalize variant names. Dedup application by `toolCallId` on both the server applier and client `_onSync` so NDJSON replay is idempotent. *From: tldraw sanitization layer + our audit. Files: `src/lib/canvas/server.ts:260`, `store.ts` `_onSync`, `tools.ts` `executeTool` (extend existing `repairArrayArgs` poka-yoke).*

**C2. Repair-then-report tool-arg loop.**
The pi SDK already converts invalid args into `isError` results — add ONE structured repair round first: send the validation error + the tool's JSON schema back to the model in the same session ("your call failed schema X with error Y — re-emit corrected args"), then fall back to the isError result. *From: AI SDK `repairToolCall`. Files: `runner-native.ts` tool dispatch wrapper.*

**C3. Change/no-change contract + provenance hierarchy.**
Require every multi-step turn to open with a plan that states exactly which shape IDs will change and which will NOT be touched; emit it as an `agent:plan` event (UI can render it). Prompt rule: "canvas state/patch-log = source of truth; screenshots = verification only." Prevents regressions where the agent redesigns untouched regions — the #1 complaint pattern in image-in/image-out loops. *From: Lovable THINK&PLAN + make-real provenance hierarchy.*

**C4. Stuck detection + nudge.**
Hash the last K `(tool, args-hash, result-hash)` tuples; on an identical-failure streak (e.g. 3×), inject one corrective system message ("pen_set_fill failed identically 3× — change approach"), then terminate with a persisted `stuck` status instead of burning all 30 iterations. *From: OpenHands stuck detector. Files: `runner-native.ts` shouldStopAfterTurn.*

**C5. Determinism + prompt versioning.**
(a) Canonically sort the canvas snapshot (by ID) so the same canvas yields identical bytes — better caching + reproducibility; (b) version the system prompt (`PROMPT_VERSION` recorded per session, make-real `MIGRATION_VERSION` pattern) so prompt updates are attributable; (c) `temperature: 0` + fixed seed where the endpoint supports it. *From: make-real CLAUDE.md + our audit (IDs random, order follows patch order).*

**C6. v0-style hard constraints.**
The design-system pack section already moves this direction — tighten to hard limits in the prompt: ≤5 palette colors, ≤2 font families, semantic token bindings only, no placeholder geometry; plus "stop retrying after 2 consecutive identical failures" and a mid-session rule reminder injection for long sessions. Add a handful of few-shot pen_* trace examples (v0's ~12 Alignment examples pattern). *From: v0 prompt.*

### E — Efficiency

**E1. Replace the full-canvas snapshot with dual-channel context.**
Today: ENTIRE untruncated canvas in the first user message every turn — unbounded growth. Replace with: (a) compact spatially-sorted shape digest (id/type/name/bounds/text-only, capped, canonically sorted), (b) current user selection, (c) one-line-per-cluster summary of off-viewport regions, (d) optional viewport screenshot when the task is visual. Fetch full node details on demand via a `pen_read_node` tool (context economy à la v0's "content omitted — retrieve via path"). *From: tldraw dual-channel + bolt `selectContext`. Files: `runner-legacy.ts:759-905` (`canvasSnapshot`).*

**E2. User-edit deltas.**
Track user-made canvas edits since the last agent turn; inject ONLY those as a compact "User Updated Canvas" delta in the next prompt (then reset), instead of forcing the model to diff the full snapshot. *From: bolt #10 `filesToArtifacts`.*

**E3. Condensation for long sessions.**
Structured rolling summary persisted per session: sections CANVAS_STATE (shape IDs + one-liners), COMPLETED, PENDING, DESIGN_DECISIONS (palette/fonts chosen). HARD trigger on token overflow, SOFT on message count; always keep system prompt + first user message + recent half; minimum-progress guard. Store as a `condensation` event so replay reproduces the identical view. *From: OpenHands condenser. Files: port `context-manager.ts` from the legacy loop to the native path — it exists but is unwired (`runner-native.ts:849` disables SDK compaction).*

**E4. Stable tool registration order + cache telemetry.**
Register the 88 tools in fixed (alphabetical) order — provider-side prompt caching keys on stable tool-definition bytes; surface cache-read token counts per turn in the sessions panel (data already flows via `agent:context_update`). *From: AI SDK `toolOrder`. Files: `runner-native.ts` tool assembly.*

**E5. Server-side patch batching.**
Coalesce NDJSON lines + socket emits with a small (16ms) server-side flush window for rapid patch bursts — the client already coalesces renders; the wire should too. *From: our audit; bolt's `createSampler` pattern.*

**E6. Reuse the LLM client / extend preflight cache.**
Cache ModelRuntime + sub-agent LLM clients per (baseUrl, key) instead of rebuilding per turn; extend preflight cache 60s → 300s for healthy endpoints. *From: our audit.*

---

## 5. Prioritized roadmap

**Phase 1 — Quick wins (each ≤ a day, no schema changes):**
C1 sanitizer + toolCallId dedup · D3 server-side Stop + fix double `turn_end` · C4 stuck detection · D4 typed error events · C5a canonical snapshot sort · E4 alphabetical tool order · E6 runtime reuse.

**Phase 2 — The durability core (3–7 days):**
D1 event journal (activate `AgentAction` as the append-only log, server-authoritative) · D2 boot-time recovery + `?afterSeq=` reconnect · D4 watchdog · D5 auto-continue · C2 repair loop · C5b prompt versioning.

**Phase 3 — The efficiency core (1–2 weeks):**
E1 dual-channel context replacing the full snapshot · E3 condensation on the native path · E2 user-edit deltas · C3 change/no-change contract + provenance prompt rules · C6 v0 constraint tightening + few-shot examples.

---

## 6. Sources

- bolt.diy @ `2e254ac` — clone at `research-scan/bolt-diy`
- Vercel AI SDK — clone at `research-scan/ai-sdk`
- tldraw make-real — clone at `research-scan/make-real`; tldraw.dev/docs/ai; tldraw.dev/blog/agents-cant-point
- OpenHands agent-sdk — clone at `research-scan/openhands-sdk`
- v0 + Lovable leaked prompts — local research JSONs under `scripts/research/` (01-v0-system-prompt, page-01-v0-prompt, page-02-lovable-agent, page-03-lovable-arch, 09-v0-leaked, 10-lovable-leaked)
- AgentCanvas audit — Task 2-a subagent brief (see `worklog.md`)
