# AGENTS.md — `src/app/api/agent/`

## Purpose

The agent run loop and its plugin/approval round-trip endpoints. `/api/agent` is the single server-side entry point for running the LLM agent against a canvas — it streams NDJSON events back to the frontend canvas store. The sibling routes (`answers`, `pending`, `background`, `plans`, `approvals`, `client-responses`) let the browser resolve blocking/background plugin tool calls while a run is in flight.

## Ownership

- `route.ts` — the agent run endpoint. Owns the request/response contract with the frontend canvas store (POST → NDJSON stream). The ONLY server-side consumer of `runAgent()` from `src/lib/agent/runner.ts`.
- `answers/route.ts` — POST: resolves a pending `ask_user_question` tool call (`{toolCallId, answers: string[][], cancelled}`); backed by `resolveAskUserQuestion()` from `src/lib/agent/plugins/ask-user-question`. 400 if `toolCallId` missing.
- `pending/route.ts` — GET: `{ pending: [...] }` list of unanswered `ask_user_question` toolCallIds; backed by `getPendingQuestions()`. Polled by the frontend on reconnect.
- `background/[id]/route.ts` — GET: background-task status by id (404 if unknown); backed by `getBackgroundTaskStatus()` from `src/lib/agent/plugins/background-tasks`. Polled by the `BackgroundTaskList` UI.
- `plans/route.ts` — POST: resolves a pending PLAN-mode approval gate (`{planId, decision: 'build' | 'revise', feedback?}`; feedback required for `revise`) — the `PlanApprovalCard` submits here. GET: `{ pending: [...] }` list of plan ids awaiting a decision (reconnect diagnostics twin of `/pending`); backed by `src/lib/agent/plan-gate.ts`.
- `approvals/route.ts` — POST: resolves a pending destructive-op approval gate (`{toolCallId, decision, edits?}`); backed by the approval-gate plugin's pending map. Same idempotent no-op contract for unknown ids as `plans`.
- `client-responses/route.ts` — POST: resolves the client round-trip pending map (`{toolCallId, kind: 'computed' | 'screenshot', payload}`); backed by `resolveComputedResponse`/`resolveScreenshotResponse` from `src/lib/agent/client-roundtrip.ts`.

## Local Contracts

### `/api/agent` request body

```ts
{
  documentId: string;          // defaults to 'default' if omitted
  prompt: string;              // required — 400 if empty/whitespace; >20,000 chars returns 400
  canvasState: CanvasDocument; // field name is `canvasState`, NOT `canvas`
  selection?: { count: number; names: string[] };
  canvasDelta?: { sinceSeq: number; nodeIds: string[] | null };
  settings?: AgentRunSettings; // falls back to DEFAULT_SETTINGS when omitted
}
```

### `/api/agent` response

- `Content-Type: application/x-ndjson; charset=utf-8`
- `Cache-Control: no-cache, no-transform`
- `X-Accel-Buffering: no`
- Each line is a JSON object with a `type` field: `{ type: 'patch', patch, toolCallId? }` or `{ type: 'agent_event', event }`.
- The route MUST stream events as they arrive — do not buffer the entire run.
- The route MUST close the stream after the runner completes. If the runner throws, emit `{ type: 'agent_event', event: { type: 'agent:error', message } }` and close — do NOT return 500 mid-stream.
- The route is the ONLY server-side consumer of `runAgent()`. Do not call the runner from elsewhere.

### Hardening at the door (all enforced BEFORE the stream starts)

- `Content-Length > 32MB` → 413 (checked before `req.json()`).
- `prompt` empty/whitespace → 400; `prompt` > 20,000 chars → 400.
- `canvasState` shapes > 20,000 → 400 (the snapshot walk is O(n)).
- Selection names bracket-stripped + 120 chars each.
- `canvasDelta.nodeIds` entries ≤ 64 chars.
- Image dataUrls ≤ 7.5M chars (~5.5MB decoded).
- `tryRegisterActiveRun(documentId)` claimed at route scope BEFORE the user_message journal row + BEFORE the stream starts. A second concurrent run on the same document gets a 409 with the active run's preview; a stale (>15min) entry is taken over, not locked forever.

### Round-trip subroutes (`answers`, `pending`, `background`, `plans`, `approvals`, `client-responses`)

- Backed by in-memory plugin state in `src/lib/agent/plugins/` (or `plan-gate.ts` for plans) — NO DB.
- All POSTs are idempotent for unknown ids (no-op, not 500).
- `/api/agent/pending` + `/api/agent/plans` GET are reconnect-diagnostics twins — polled on reconnect so a reload doesn't orphan an unanswered question or pending plan.

### HTTP fallback parity

- The frontend canvas store calls `/api/agent` when the WebSocket connection to `src/lib/canvas/server.ts` (port 3003) is unavailable. Both paths MUST produce identical event shapes — the canvas store does NOT branch on transport. When the WS is available, the store prefers it (lower latency, bidirectional).

## Work Guidance

- When changing the event stream shape: update `route.ts`, `src/lib/agent/runner.ts` (`AgentStreamEvent`), `src/lib/canvas/store.ts` (`_onSync` handler), AND `src/lib/canvas/server.ts` (broadcast). All four are coupled.
- When adding a new plugin that needs a server-resolved round-trip: add the route under this folder, document it here, and wire the in-memory resolver in `src/lib/agent/plugins/`.
- When debugging a stream that hangs: check the runner is actually yielding events (add `console.error` in the runner), check that response headers are set before the first write, check that no proxy between the client and the route is buffering (the dev server does not buffer; production behind Caddy might).

## Verification

- `bunx tsc --noEmit` — typecheck.
- Manual: `curl -N -X POST http://127.0.0.1:3000/api/agent -H 'Content-Type: application/json' -d '{"documentId":"test","prompt":"create a red rectangle","canvasState":{"id":"test","name":"test","viewport":{},"background":"#fff","shapes":[],"tokens":{"colors":[],"textStyles":[]}}}'` — should stream events until `turn_end`. Note the field is `canvasState`, NOT `canvas`.
- Manual: `curl http://127.0.0.1:3000/api/agent/pending` — should return `{ pending: [] }` when no run is active.
- Manual: `curl http://127.0.0.1:3000/api/agent/plans` — should return `{ pending: [] }` when no plan is awaiting.

## Mistakes & Lessons

### Failure Modes

- Check `Content-Length` and the `prompt`/`canvasState` caps BEFORE `req.json()` and BEFORE the stream starts — once the stream is open, you cannot retroactively return a clean 400.
- Check `tryRegisterActiveRun(documentId)` returns `acquired: true` before yielding the first event — a second overlapping run on the same document interleaves journal rows and double-spends tokens.
- Check that all three stream headers (`Content-Type`, `Cache-Control`, `X-Accel-Buffering`) are set on the `Response` before the first write — missing any one lets an upstream proxy buffer the whole run.
- Check that the runner emits `agent:error` (not throws) on internal failure — a thrown exception mid-stream cannot be turned into a clean HTTP response (the client is already reading).
- Check that round-trip subroute POSTs are idempotent for unknown ids — the frontend may replay after a reload, and a 500 on unknown id breaks the auto-heal path.

### Lessons Learned

- Do the one-shot polish pass (`polishOneShotPatch` from `src/lib/canvas/oneshot-polish.ts`) on the accumulated patch BEFORE the final broadcast on empty-canvas turns — without it, the agent's first canvas produced 4px-misaligned shapes and duplicate ids.
- Do reconnect-diagnostics twins for every blocking plugin (`/pending` for `ask_user_question`, `/plans` for plan-mode) — without them, a browser reload orphans an unanswered question or pending plan until the next run.
- Do NOT bubble the gateway's opaque ~24k-token prompt-length rejection as a 500 mid-stream — surface an honest 400 at the door (prompt > 20,000 chars) so the user sees "trim your prompt" instead of a generic crash.

## Child DOX Index

No child AGENTS.md files. Direct children are individual `route.ts` files under subfolders (`answers/`, `pending/`, `background/[id]/`, `plans/`, `approvals/`, `client-responses/`) — each is a single route handler with no subroutes, all documented in the Ownership section above.
