# Task 6-e — Round 2: OpenHands + LibreChat client/server event delivery & multi-turn reconnect catch-up

Date: 2026-08-28 (sandbox). Sources read locally (verified byte-identical to upstream @main where checked):

- OpenHands main app: `research-scan/openhands` (working tree == github.com/OpenHands/OpenHands@main; md5-verified on 3 files)
- OpenHands agent-server/SDK: `research-scan/openhands-sdk` == github.com/OpenHands/software-agent-sdk@main (repo renamed; raw fetch HTTP 200)
- LibreChat: raw fetches of danny-avila/LibreChat@main into this dir (messages-route.js, abortMiddleware.js, GenerationJobManager.ts, useResumableSSE.ts, useResumeOnLoad.ts, BaseClient.js, message-schema.ts, message-methods.ts, agents-chat-route.js)

## OpenHands delivery (Q1)

REST (agent-server):
- GET /api/conversations/{id}/events/search — page_id (keyset = event id), limit<=100, kind/source/body, sort_order TIMESTAMP|TIMESTAMP_DESC, timestamp__gte/__lt → {items, next_page_id}  [event_router.py:65]
- GET .../events/count [event_router.py:139]; GET .../events/{event_id}; batch GET ?event_ids=; POST .../events (send message, run flag)
- GET /api/conversations/{id}/agent_final_response → last FinishAction text / last MessageEvent text, "" if none [conversation_router.py:161]
- Keyset impl: O(1) id→index on append-only EventLog; disk order == chronological; lazy index walk, no sort [event_service.py:456-538]

WebSocket: /api/sockets/events/{conversation_id} [sockets.py:226]
- resend_mode=all|since (+after_timestamp; deprecated resend_all); replay via page_iterator(timestamp__gte=...)
- first-message auth {"type":"auth","session_api_key"}, 10s timeout; socket doubles as command channel (Message → send_message(run=True))
- docstring: "REST fetches historical events and WebSocket handles events after a specific point"

Frontend (OpenHands app):
- useConversationHistory: React Query, REST tail page sort=TIMESTAMP_DESC limit=50 reversed; refetchOnMount:"always" (batched multi-turn catch-up), refetchOnWindowFocus/Reconnect:false (WS since replay covers), retry:1, gcTime 30m [use-conversation-history.ts:30-98]
- WS gated on first REST page (isPending) → subscribe resend_mode='since' + after_timestamp = last REST event ts; fallback 'all' [conversation-websocket-context.tsx:359-400, 963-1002]
- use-websocket.ts: backoff 1s→30s cap +30% jitter, handshake watchdog, WeakSet reconnect-allowed
- use-event-store.ts: dedup by id Set O(1); out-of-order → full re-sort when new ts < last ts; deltas merge by position (no id)

## Q2 resume
- Run executes server-side; WS disconnect only unsubscribes [sockets.py:382-383]
- Refresh → REST tail refetch + WS since replay; execution_status IDLE/RUNNING/WAITING_FOR_CONFIRMATION/FINISHED/PAUSED/ERROR/STUCK in ConversationInfo + replayed state events
- No persisted client cursor; anchor = latest REST page last ts; at-least-once + dedup
- Terminal to offline client: terminal events persisted in events.jsonl; mount tail page includes them; + agent_final_response endpoint
- Cloud mode split: history on App API (survives sandbox); live endpoints via cloud-proxy on runtime sandbox [event-service.api.ts:18-38]

## Q3 identity/persistence
- Event: id UUID, timestamp ISO, source, parent_id (tree; siblings share parent) [sdk/event/base.py:24-38]
- Persistence: per-conversation dir: events.jsonl + metadata.json on local FS; append-only immutable; NO retention/compaction (condenser is LLM-context only)

## LibreChat (Q4)
- Classic: user message saved up-front [BaseClient.js:826]; response saved at END via terminal CAS (beforeResponsePersistence; unfinished:false) [BaseClient.js:1130-1148]
- Abort: partial saved with finish_reason 'incomplete' + final SSE event [abortMiddleware.js:106-216]; error w/ partial>5 chars → same path; else error msg (shouldSaveMessage only if user msg persisted) [abortMiddleware.js:239-323]
- Agents protocol v2: POST start → streamId; GET EventSource /api/agents/chat/stream/:streamId; nav closes SSE but does NOT abort; only stop button aborts [useResumableSSE.ts:716-724]
- GenerationJobManager: earlyEventBuffer ≤5000 events/8MB; durable chunk log (Redis); resumeClaimedGeneration; resume snapshot frontier (monotonic local seq); TERMINAL_PERSISTENCE_TIMEOUT_MS=30s durable-pending reconciliation; TERMINAL_PUBLICATION_RECONNECT_ERROR; idempotency claim TTL 25h [GenerationJobManager.ts:119-146, 4211-4238]
- Reconnect: server sends `sync` w/ aggregatedContent snapshot (skipBufferReplay after sync); replayEvents for run steps [GJM:4225-4227, 7200-7282]
- useResumeOnLoad: on load/navigation useStreamStatus(conversationId)+useActiveJobs(5s poll) → build submission from resumeState → resubscribe existing stream; handles external runs (other tab) [useResumeOnLoad.ts:234-353]
- Branching: Message {messageId, parentMessageId, conversationId}; unique (messageId,user,tenantId); siblingIdx per parent in client; restoreResumeBranch on resume; TTL index for temp chats (retention)
- Hydration: GET /api/messages/:conversationId (all messages, canonical); getMessagesByCursor keyset (createdAt, limit+1) [message-methods.ts:2335]
