# Integration Map — Cursor-style Modes (Ask / Plan / Build) + Smarter Critique Cadence

Task 5-b research report. RESEARCH-ONLY — no code modified. Every claim carries a `file:line` citation.
Repo state: post Task-3 audit batch + Task-4 stress-test fixes (PROMPT_VERSION `2026-08-30.1`, runner-native.ts = 2139 lines).

---

## 1. Agent request flow end-to-end

### 1.1 Client → API payload (two paths, one shape)

**Composer submit** — `src/components/canvas/AgentPanel.tsx`
- `AgentPanel()` at AgentPanel.tsx:648; input state at :660; `promptAgent` selector at :651; `queuePrompt` at :698.
- `submit()` at AgentPanel.tsx:1025 — merges canvas selection ∪ `@mentions` into `selection` (:1035-1044), parses slash-commands (:1045-1085, single source `parseCommandInput`), image-only fallback prompt (:1089), **queues while busy** (:1104-1106), else `promptAgent(promptText, images, selection)` at AgentPanel.tsx:1111.
- Slash-command prompt shortcuts (`/audit`, `/dark`, …) route through `executeCommand()` (AgentPanel.tsx:753-830) → `promptAgent(prompt)` at :764.

**Store send action** — `src/lib/canvas/store.ts`
- Type: `promptAgent: (text, images?, selection?) => void` at store.ts:414-418 (same for `queuePrompt` :428-432).
- Implementation `promptAgent` at store.ts:1660:
  - creates/uses session (:1668-1675), `startRun(sessionId, text, 'user_message', resolvedModel)` (:1681-1683), `appendUserMessage` + `appendAssistantMessage` (:1687-1688), mirrors both into live `turns` (:1691-1720).
  - **`const settings = agentRunSettings(useSettings.getState())` at store.ts:1729** — the ONLY injection point for run settings on the client. Active design-system pack appended at store.ts:1736-1739 (`settings.pack`).
  - **WS path** (primary): `socket.emit('client', { type: 'agent:prompt', documentId, prompt: text, settings, images?, selection?, sessionId, runId, userMessageId, assistantMessageId })` at store.ts:1740-1757.
  - **HTTP fallback**: `fetch('/api/agent', { body: { documentId, prompt, canvasState, settings, images?, selection?, sessionId, runId, userMessageId, assistantMessageId } })` at store.ts:1767-1784.

**Settings payload type** — `src/lib/settings/types.ts`
- `AgentRunSettings` interface at settings/types.ts:221-273. Fields today: `temperature, maxIterations, planFirst, thinkingLevel, defaultPalette, approvalMode, alwaysAllowTools, skillSelectionMode, llmProvider, apiKey, modelName, apiBaseUrl, enabledPlugins?, mcpServers?, maxDesignCritiqueIterations?` (:258), `pack?` (:272).
- Extractor `agentRunSettings(s: AppSettings)` at settings/types.ts:299-321 — **hardcodes `maxDesignCritiqueIterations: 2` at :319** (not a UI knob).
- `AppSettings` persisted to localStorage key `agentcanvas.settings.v1` (settings/store.ts:35, version 4 at :36, migrate :51).

**WS server leg** — `src/lib/canvas/server.ts`
- Socket handler `case 'agent:prompt'` at server.ts:303 → `driveAgent(documentId, prompt, settings, images, selection, identity)` (:305, signature :451-462).
- `driveAgent` computes `canvasDelta` (server.ts:537-541) and POSTs to `http://127.0.0.1:3000/api/agent` with body `{ documentId, prompt, canvasState, canvasDelta?, settings, images, selection, sessionId?, runId?, userMessageId?, assistantMessageId? }` (server.ts:546-575). **A `mode` field must be added HERE too (server.ts:562-574) or WS runs will drop it.**

### 1.2 API route

`src/app/api/agent/route.ts` — `POST` at route.ts:34.
- Body parsing: `documentId`/`prompt`/`canvasState` :36-49; **settings re-extraction (field-by-field, unknown fields ignored) at route.ts:54-87** ← a `mode` field needs an entry here; `images` :99-111; `selection` :115-123; `canvasDelta` :131-142; turn identity `sessionId/runId/userMessageId/assistantMessageId` :173-182.
- `registerActiveRun` :183-187 (visibility for `/api/documents/[id]/agent/status`).
- Journals `agent:user_message` at run start: route.ts:194-200.
- Watchdog: `WATCHDOG_MS = 120_000` route.ts:215, `ABORT_GRACE_MS = 30_000` :226, interval :229-274 (⚠ 2-min zero-output kill — relevant to Plan-mode approval pauses; ask/approval blocks today can exceed it, see §3.6).
- `emitTurnFinalAndClose()` :315-359 (single `agent:turn_final` + synthetic terminal + unregister).
- **Runner invocation** at route.ts:361-370: `runAgent({ documentId, prompt, canvas, settings, images, selection, canvasDelta?, signal })`.

### 1.3 Runner entry

- `runAgent(opts)` at src/lib/agent/runner.ts:49-58 — delegates to `runAgentLegacy` when `opts.llm` injected (tests), else **`runAgentNative` (production)**.
- `AgentRunOptions` at src/lib/agent/runner-types.ts:64-98: `{ documentId, prompt, canvas, llm?, signal?, settings?, images?, selection?, canvasDelta? }`. **A `mode` would either be a new optional field here or (recommended) a new `AgentRunSettings` field — the settings object already flows through every leg (client store → WS/HTTP → route → runner) untouched, whereas a top-level body field would need plumbing at store.ts:1741/1770, server.ts:562, route.ts:54-87, runner-types.ts:64.**

---

## 2. runner-native.ts structure (src/lib/agent/runner-native.ts)

### 2.1 Head
- `runAgentNative(opts)` at runner-native.ts:221. Settings destructured :225-244: temperature :225, maxIterations :226, planFirst :227, thinkingLevel :228, defaultPalette :229, skillSelectionMode :230, approvalMode :239, `seedAlwaysAllow` :244. **This block is where `mode` would be read (`const mode = settings?.mode ?? 'build'`).**
- `normalizeCanvas` :247. **Edit-vs-create anchor: `turnStartShapeIds` / `turnStartShapeNames` captured at :255-258** (shapes existing at turn start = user's prior deliverables).
- Per-run flags: `hasGeneratedBrief` :262, `inCritiqueReprrompt` :263.
- `CanvasToolContext` closure `ctx` :265-273 (`ctx.applyPatch` mutates the runner-local `canvas` :269-272).
- `buildConversationHistory(documentId)` :125-174 — replays journaled `agent:user_message`/`agent:turn_final` pairs (caps: 6 turns :121, 1200 chars/msg :122, 6000 total :123); reads journal via `getJournalEvents(documentId, 0, 400)` :129.

### 2.2 Tool assembly (lines 278-654)
- `wrapToolsWithPriorContentGuard(createCanvasTools(ctx))` :278-282 (prior-content guard armed by `inCritiqueReprrompt`).
- `createPenTools` :283, `createFigmaTools` :284, **`getEnabledPluginTools(settings)` :289**, `getEnabledPluginToolNames(settings)` :301.
- `allTools = applyToolAliases([...canvasTools, ...penTools, ...figmaTools, ...pluginTools])` :295-300.
- `subAgentLLM` built via `buildSubAgentLLMClient(settings)` :307-315 (provider-aware client for ALL sub-agents + classifier fallback).
- Classification: `classifyIntent({ prompt, canvasShapeCount: canvas.shapes.length, llm: subAgentLLM, signal })` :331-340; manual skill mode → `multi` :321-328; error fallback `multi` :342-348. `activeCategory` :355.
- **Tool filter** :374-391 — `structuralCategories` :374 (primary + secondaries), `includePenFileTools` (wireframe|multi) :375, `allowedToolNames` Set :376-381 (category allowlists ∪ secondaries ∪ PEN/FIGMA ∪ plugin names), alias exclusion :389-391 → `filteredTools`. **This is the single choke point to gate mutating tools per mode (e.g. Ask = read-only tools only).**
- Brief-first gate: `isDesignRequest` regex :409-412, `shouldEnforceBrief` :413; `preGeneratedBriefPromise` kicked off un-awaited :476-498 (races classification+research; 40s timeout :486-487); `GATED_TOOL_NAMES` (11 mutating construction tools) :511-523; execute-wrapper layer `enforcementWrappedTools` :528-571 (rejects with `brief_required_first` :553-561; sets `hasGeneratedBrief` on the brief tool :536-546).
- Approval gate wrap `approvalWrappedTools` :599-622 (only when `approvalMode === 'destructive'`; wraps `DESTRUCTIVE_TOOLS`; blocks on `requestApproval` :614).
- `orderedTools = [...applyExecutionModes(approvalWrappedTools)].sort(alpha)` :640-642 (deterministic tool-schema order for prompt caching; sequential execution for canvas mutations via tool-execution-mode.ts:69-77).
- Emits `agent:skill_selected` :645-654 (category, confidence, method, toolCount → UI SkillChip).

### 2.3 Plan / research / prompt assembly
- Plan: `generatePlan({ prompt, classification, llm: undefined, signal })` :661-670 (keyword-only on native — LLM planner not wired); `agent:plan` event :672-684.
- Web research: `needsWebResearch` :694-696; `dispatchWebResearchSubAgent` :708-713; events :699-726; pure-research prompts return early :730-738.
- Brief joined :744-750 (sets `hasGeneratedBrief`).
- **System prompt** = `buildSystemPrompt(skillMetadata, skillBody, /*planSection*/ '', canvas, defaultPalette, planFirst, settings?.pack, /*includeSnapshot*/ false)` :815-824 (template in runner-legacy.ts:116-745; `buildSystemPrompt` runner-legacy.ts:1107-1129; `buildPlanFirstSection` :1081-1091; EDIT TURNS section at runner-legacy.ts:633).
- **Per-turn sections ride the FIRST USER MESSAGE** (cache stability, P6): `planSection`+`fileSkillsSection`+`memorySection` :765-797; `conversationHistorySection` :808-813; `selectionNote` :888-890; `packReminder` :897-899; `snapshotSection` (delta vs full :920-923); `promptVersionSection` :928; `briefSection` :929-931; `variantNudge` :935-937; assembled `userMessage` :942-944. **Plan-mode output would be injected/appended here (or replace the session.prompt payload below).**
- Image attachments → pi `ImageContent` :955-967; `userMessageWithAttachments` :947.

### 2.4 Main loop
- Attempt loop `for (let attempt = 0; attempt < 2; attempt++)` :1063 (primary + bounded z.ai-sandbox fallback).
- `createAgentSession({ model, modelRuntime, thinkingLevel, noTools: 'all', customTools: orderedTools, tools: orderedTools.map(name), resourceLoader, sessionManager: inMemory, settingsManager: inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 2 } }) })` :1114-1133.
- `registerActiveSession(documentId, session)` :1138 (steer registry — src/lib/agent/active-sessions.ts:33/49).
- maxIterations budget hack `shouldStopAfterTurn` :1151-1168 (+ stuck detector tracker :999-1024, feed :1305-1334, `agent:stuck` :1319-1330).
- `subscribeAndTranslate` :1187-1190 (src/lib/agent/agent-session-translator.ts).
- `agent:model_info` :1200-1211. Plugin state: `setEventSink` :1224-1226; `setTodoActiveSession`/`setGoalActiveSession`/`setBackgroundTaskActiveSession`/`setSubagentActiveLLM`/`setSubagentActiveCanvas` :1227-1231.
- `session.prompt(userMessageWithAttachments, { expandPromptTemplates: false, images })` :1247-1254; drain loop :1286-1361 (**per-attempt `agent:turn_end` WITHHELD** :1292-1302 so the critique phase doesn't idle the client).
- Fallback decision :1428-1507; auto-continue on `stopReason === 'length'` :1519-1599.
- Defensive tail: `designTurnNeverDrew` :2102-2105; silent-failure `agent:error` :2106-2120; single authoritative `agent:message_end` :2121-2123, `agent:turn_cancelled` :2129-2131, `agent:turn_end` :2135-2137. Outer `finally` disposes session :2062-2081.

### 2.5 Critique loop (lines 1601-2061) — full detail in §6

### 2.6 Turn-type detection (create vs edit) — all existing signals
| Signal | Where | Use |
|---|---|---|
| `turnStartShapeIds` (shapes at turn start) | runner-native.ts:255-258 | prior-content guard :278-282; new-shape scoping :1668; scope note :1895-1900 |
| `newShapesForCritique = shapes − turnStartShapeIds` | runner-native.ts:1668 | **pure edit turns (0 new shapes) skip the critique loop entirely** :1669 |
| `canvasShapeCount` | classifier.ts:165-181 | empty canvas + no keywords → `wireframe` :174-180; populated → `multi` :165-173 |
| `isEdit` regex (darker/lighter/move/rename/change…) | runner-native.ts:451 (inside `isAmbiguousCreation` :443-453) | keeps edit turns out of variant-exploration |
| `expectsCanvasOutput = isDesignRequest && !QUESTIONISH_PROMPT` | runner-native.ts:470-474 | text-only retry guard + `designTurnNeverDrew` :2102-2105 |
| `isDesignRequest` regex | runner-native.ts:409-412 | brief-first gate :413 |
| EDIT TURNS prompt section | runner-legacy.ts:633 | system-prompt guidance for populated canvases |
| `isWireframeRequest` regex | runner-native.ts:1674-1677 | skips critique on lo-fi requests |

### 2.7 Subagent dispatch points
- design-brief pre-gen: runner-native.ts:477-497 (`dispatchDesignBriefSubAgent`, subagents/design-brief.ts).
- web-research: :708-713 (subagents/web-research.ts).
- design-critic (text): :1736-1743 → `dispatchDesignCriticSubAgent({ task, canvas, originalPrompt, llm, priorShapeIds })` (subagents/design-critic.ts:108; prior-scoping serializer :204-223; SCORE parse runner-native.ts:1787-1791).
- design-critic-vlm: :1750-1759 → `dispatchDesignCriticVlmSubAgent` (subagents/design-critic-vlm.ts:106-108; returns `critique: VlmCritique` + `screenshotSource: 'client'|'server'`; client-screenshot round-trip via `awaitClientResponse` from client-roundtrip.ts, gate `hasSink()`).
- variant-generator: reached via the `pen_generate_variants` TOOL (tools.ts) using `getActiveLLM()` (plugins/subagents.ts:181-183) — nudged by `variantNudge` runner-native.ts:935-937.
- plugin subagents (reviewer/oracle/worker): plugins/subagents.ts:187-235/237-278/280-320 — default OFF (plugins/index.ts:124-139, `defaultEnabled: false` at :137).

### 2.8 Env/flags/params gating behavior today
- `process.env.PI_CACHE_RETENTION ||= 'long'` runner-native.ts:836 (prompt caching).
- `settings.maxIterations` → toolCallBudget :1154-1163.
- `settings.approvalMode` :239 + wrap :599-622.
- `settings.skillSelectionMode === 'manual'` :321-328.
- `settings.maxDesignCritiqueIterations` (default 2) :1646; `=== 0` disables loop :1649.
- `settings.pack` → system fragment :822 + reminder :897-899.
- `settings.enabledPlugins` → plugin tools :289/301 (plugins/index.ts:148-155).
- `opts.canvasDelta` :920-923; `opts.selection` :888; `opts.images` :955.
- `maxCritiqueIterations > 0 && session && !wasAborted()` :1649.

---

## 3. Existing mode-like machinery (what already behaves like a mode)

1. **Slash commands** — src/lib/agent/chat-commands.ts: `CHAT_COMMANDS` :28-49 (`kind: 'action' | 'prompt'`); autocomplete + submit-time resolution `parseCommandInput` :144-157; executed in AgentPanel `executeCommand` :753-830. A `/plan`, `/ask`, `/build` command could flip a mode flag client-side — but there is NO persistent mode state today.
2. **@-mentions** — src/lib/agent/chat-mentions.ts: `extractMentionedLayerIds` :114-140; targeting chip + merged selection AgentPanel.tsx:1034-1044.
3. **ApprovalMode (settings)** — settings/types.ts:47-58 ('destructive' | 'review' | 'off'), consumed runner-native.ts:239/:599-622; UI Select in SettingsDialog.tsx:321-323. **This is the closest precedent: a per-run behavioral setting that changes tool gating.**
4. **skillSelectionMode (settings)** — settings/types.ts:161-165 ('auto' | 'manual') → runner-native.ts:321-328 (manual pins 'multi'). Precedent for "user overrides automatic routing".
5. **Classifier categories gate tools** — skills/registry.ts:51 `SKILLS` (wireframe :54, layout :256, styling :357, inspect :436, export :503, web_research :555, vector :618); `getToolNamesForCategory` :708; `ALL_TOOL_NAMES` :724; `CORE_TOOL_NAMES` :36-47; runner filter :374-391. A mode is naturally an ORTHOGONAL axis: category picks ergonomic tools, mode picks read-only vs plan vs full.
6. **Brief-first gate** — runner-native.ts:511-571 (execute-wrapper rejecting mutating tools until brief exists). Same wrapper pattern would enforce Ask-mode read-only.
7. **ask_user_question tool** — plugins/ask-user-question.ts:115-199 (default ON, plugins/index.ts:72); blocks on a promise resolved by POST /api/agent/answers (:39); 5-min timeout :35; shared registry `awaitPendingUserAnswers` :64-75 also used by goal_interview (goal-list-loop-audit.ts:117-120). **Ask mode can lean on this.**
8. **approval-gate** — plugins/approval-gate.ts: `DESTRUCTIVE_TOOLS` :40-49; `requestApproval` :166-186 (blocks via `agent:approval_request` event + `/api/agent/approvals`); 5-min deny-timeout :89; `alwaysAllowTools` persistence settings/types.ts:106-111. **Plan approval can copy this exact block-resolve pattern (event + route + pending map).**
9. **Watchdog** — route.ts:215/229-274: kills the run after 120s of NO STREAM OUTPUT. Plan-approval pauses (and today's ask_user/approval blocks) emit nothing while waiting → risk of watchdog kill mid-pause; keepalive events or pause-aware watchdog needed (prior audit 2-c S6 noted the same class of bug).
10. **Steer + queue** — mid-turn steering (store.ts steerAgent → active-sessions.ts:49 `steerActiveSession`; SteerInput UI AgentPanel.tsx:2455) and queued prompts (Cursor-3 default, store.ts:428-438, QueueChips AgentPanel.tsx:614) — both are "input behaves differently depending on run state" precedents.
11. **Subagents plugin profiles** (reviewer/oracle/worker) — plugins/subagents.ts; an "oracle" second-opinion dispatch already exists :237-278 — conceptually Plan-mode material.
12. **planFirst (settings)** — plan-preamble toggle, system prompt only (runner-legacy.ts:1081-1091, substituted :1119). No interactive plan object; the `Plan` type (skills/types.ts:100-117) is keyword-derived and non-interactive.

---

## 4. UI panel (where the mode selector goes)

- **AgentPanel** src/components/canvas/AgentPanel.tsx:648. Composer container :1249; targeting chip :1256-1276; slash menu :1278-1317; mention menu :1321-1349; textarea :1391-1494; **action row :1505-1598** — left cluster: canvas-snapshot button :1524-1532, paperclip :1535-1543, divider :1546, `ModelContextStatus` :1547-1553 (wraps `ModelSwitcher` at :281 — src/components/canvas/ModelSwitcher.tsx:138, custom popover w/ `handleSelect` :193-205 calling `setSetting`), thinking-level cycle button :1554-1569 (a working example of a one-click state cycler using `useSettings().set`). Right: keyboard hint :1574-1576, Send/Queue button :1577-1597.
  **→ A mode selector belongs in this action row (left cluster, next to the thinking-level button :1554) — a small 3-state toggle (Ask/Plan/Build) or dropdown; per-turn state should live in settings store (persisted like thinkingLevel) or canvas store (per-session like agentBusy).**
- Streaming event rendering: `TurnBubble` :1609 (memoized); `SubAgentsCard` :444-493 (driven by `turn.subAgents`, reducer store.ts:3118-3156); `CritiqueRow` :498-546 (`turn.critique`, store.ts:2653-2676; ChatTurn.critique type store.ts:119-128); `SkillChip` :550; `PlanCard` :397 (turn.plan, store.ts:3079); `BusyRow` :567; `ToolCallsCluster` :2235; `DiffSummaryCard` :2061. **A plan-approval card would slot next to SubAgentsCard/CritiqueRow inside TurnBubble (:1808/:1921 area) — needs a new ChatTurn field + a new SyncEvent + a new `_onSync` case.**
- Available primitives: shadcn `Select` (src/components/ui/select.tsx; used by SettingsDialog.tsx:303-304, 321-323), `ToggleGroup` (src/components/ui/toggle-group.tsx), `Toggle` (toggle.tsx), `DropdownMenu`, `Tabs`, `Switch`, `Popover`. ModelSwitcher is hand-rolled popover (no shadcn Select) — the mode selector can use the lighter ToggleGroup pattern for 3 fixed states.
- PluginUI :1151 renders ask-user dialog + approval dialog (approval dialog state store.ts:3293; ask store.ts:3281). Plan approval can reuse PluginUI's dialog mounting pattern.

---

## 5. Session / persistence (where mode + plan-approval state can persist)

**Prisma schema** — prisma/schema.prisma:
- `Session` :187-220 (documentId :190, title, status, tags JSON :210 — **no metadata column; adding `mode` would be a schema migration, OR ride existing JSON fields**).
- `SessionMessage` :223-248 — `role` ('user'|'assistant') :228, `content` :230, `status` :232, `error` :234, `runId` :236, `diffSummary` (JSON string) :241. **A `mode` per message could be persisted inside a JSON column like diffSummary, or as a new column.**
- `SessionRun` :276-300 — `prompt` :281, `status` :283, `toolCalls` JSON :289, token/cost :291-296.
- `AgentEvent` journal :128-151 — `type` :140 ('patch' | 'agent:*' — mirrors SyncEvent verbatim), `payload` (JSON SyncEvent) :144, per-document monotonic `seq` :133. **The journal payload is schema-free: appending `mode` to the `agent:user_message` payload (route.ts:194-200) and/or a new `agent:plan_approved` event type persists WITHOUT any Prisma migration.** Writers: `journalAgentEvent` (event-journal.ts:166) + `appendSyntheticJournalEvent` (:190); reader `getJournalEvents` (:208).
- `DocumentSnapshot` :306-346 (turn_end/fork/restore/manual/server sources :318-319) — plan-approval restore points could snapshot before applying a plan.
- Client localStorage mirror: sessions/types.ts `Message` :162-195 (images :173, selection :176, patchOps :181, feedback :189 — **no mode field**); `appendUserMessage` sessions/store.ts:1008-1058 (server sync payload `{ role, content, status, runId, messageId }` :1043-1047 — text-only); `appendAssistantMessage` :1060-1091; `finalizeAssistantMessage` :1106+; `startRun` :775+.
- Conversation replay: `buildConversationHistory` runner-native.ts:125-174 reads journal `agent:user_message`/`agent:turn_final` rows (:136-146) — **a mode-aware history would also skip/annotate Ask turns here**.
- Client event application: store.ts `_onSync` cases — `agent:user_message` :2448, `agent:turn_final` :2482, `agent:critique` :2653, `agent:skill_selected` :3059, `agent:plan` :3079, `agent:plan_step_update` :3099, `agent:subagent_dispatch` :3118, `agent:subagent_result` :3135, `agent:ask_user_question` :3281, `agent:approval_request` :3293. New events (e.g. `agent:plan_proposed`, `agent:plan_approved`) need: SyncEvent union entry (canvas/types.ts:529+, e.g. critique at :675), `_onSync` case, ChatTurn field, TurnBubble render.
- Run registry (in-memory): src/lib/canvas/run-registry.ts via route.ts:183.

---

## 6. Critique cadence today (exact behavior)

**When it fires** — runner-native.ts:1646-2061, entered when `maxCritiqueIterations > 0 && session && !wasAborted()` (:1649). `maxCritiqueIterations = settings?.maxDesignCritiqueIterations ?? 2` (:1646; hardcoded 2 at settings/types.ts:319).

**Per iteration** (:1650-2060):
1. Abort check :1653; canvas snapshot :1656.
2. **Skip: empty canvas** :1660.
3. **Skip: no NEW shapes (pure edit turns)** — `newShapesForCritique = shapesForCritique.filter(s => !turnStartShapeIds.has(s.id))`, `if (newShapesForCritique.length === 0) break` :1668-1669. (Edit turns with ≥1 new shape still get full critique, scoped to new shapes + `relaxMinCount: true` :1684-1686.)
4. **Skip: wireframe/low-fi request** regex :1674-1677.
5. FREE validation gate first: `validateCanvasBeforeComplete(newShapesForCritique, { relaxMinCount: true })` :1683-1686 (src/lib/agent/validators.ts).
6. `smallCleanEdit = validation.ok && newShapes < 8` :1699 → **skips the VLM critic entirely** (:1748-1749 `Promise.resolve(null)`), text critic only.
7. Critic dispatch cards emitted (UI no-dead-air fix) :1726-1731; **critique-phase event sink installed** :1722-1725 (lets the VLM critic's `agent:screenshot_request` reach the browser for a REAL client screenshot — audit 2-c S2).
8. Both critics run CONCURRENTLY :1733-1769: text critic (1 LLM call, ~10-15s) + VLM critic (PNG render + 1 vision LLM call, ~10-20s); results drained :1779-1781; sink restored :1783.
9. Text score parsed :1787-1791 (≥7 low, ≥4 medium, else high); text `subagent_result` :1795-1809; VLM result + `subagent_result` :1810-1815.
10. `defects` merged (validation reasons + non-low text + non-low VLM top-5) :1818-1825; **`agent:critique` event** :1831-1843 → store.ts:2653 → CritiqueRow (AgentPanel.tsx:498).
11. Exit `allClear` (validation.ok AND text low AND vlm low/absent) :1846-1853; last-iteration break :1857.
12. **Fix turn**: intro message events :1861-1870; `shapeSummaries` (new shapes only, ≤40) :1878-1891; prior-scope guard note :1895-1900; canonical `fixMessage` :1913-1933; `inCritiqueReprrompt = true` :1945 (disables brief gate + arms prior-content guard); **REUSES the main pi session** `session.prompt(fixMessage)` :1973 (context preserved — Task 7-e Fix 3); own event queue + sink :1952-1967; `inCritiqueReprrompt = false` in finally :2011.
13. Bail-outs: fix produced no output :2019-2027; text-only no-op fix — `noOpFixAttempts >= 2` stops the loop :2029-2047.

**Cost accounting per design turn** (worst case, default 2 iterations): 2× (text critic + VLM critic + fix-turn full agent loop) + brief sub-agent + variant explorer (ambiguous creations) + main loop ≤ maxIterations — i.e. ≥5-6 extra LLM calls minimum, ~2.5-13.5 min/turn (Task-4 stress-test results.md documented the wall-clock).

**What gates it**: settings knob (:1646), abort (:1653), empty canvas (:1660), pure-edit (:1668-1669), lo-fi (:1674-1677), smallCleanEdit VLM skip (:1699), allClear (:1846), no-op counter (:2038), no-output (:2019).

**subagent_reviewer plugin**: default OFF (plugins/index.ts:124-139) — the runner loop is the single critique authority; user can still enable reviewer/oracle/worker in Settings (duplicating critique — audit 2-c S3/S4).

**How results reach the UI**: `agent:critique` → store ChatTurn.critique (:2653-2676) → CritiqueRow AgentPanel.tsx:498-546 (iter count, defect list, VLM score chip, "defects fixed" summary); critic dispatch/result → SubAgentsCard :444-493; fix-turn text streams into the same assistant turn.

---

## 7. Tests (patterns new tests should match)

| File | Covers | Pattern to copy |
|---|---|---|
| tests/integration/runner.test.ts (756L) | runAgent end-to-end via **MockLLM scripts** (drives the LEGACY runner — runner.ts:50-54; native path is production-only) | Scripted completions `{ content } | { tool_calls } | { throw }` per iteration; assert full event sequence + final canvas; `makeDoc`/`makeShape` fixtures :36-65 |
| tests/unit/agentic-workflows.test.ts (377L) | pen_recommend_components, pattern-memory | `makeHarness()` ctx + `executeTool(tools, name, args)` :28-89 |
| tests/unit/agent-performance-package.test.ts (300L) | applyExecutionModes :242-277, buildSystemPrompt includeSnapshot :281-300 | Pure-function assertions on prompt sections + executionMode flags |
| tests/unit/registry.test.ts (125L) | skill allowlist registration | `expect(SKILLS.wireframe?.allowedTools).toContain(...)` :29-60 — the pattern for asserting mode allowlists |
| tests/unit/todo-batch-variants.test.ts (401L) | todo plugin batching :36, variant-generator :181/:270/:311 | Plugin + subagent pure-function tests incl. wall-clock budget |
| tests/unit/multi-screen-turns.test.ts (652L) | prior-content placement, patch streaming, translator | Harness + `translateAgentSessionEvent` assertions :98-120 — the pattern for new SyncEvent round-trips |
| tests/unit/audit-2026-08-30.test.ts (528L) | every Task-3 fix | **Source-scan pattern**: extract template literal from runner source and assert it only names registered tools :106-150; `registeredToolNames()` :78-85; `visibleToolNamesFor(category)` mirrors runner gating :87-102; prompt-contradiction checks :502 |
| tests/unit/stress-test-2026-08-30.test.ts (373L) | Task-4 fixes | Composite-tool patch propagation :69; static source scan "no tool calls ctx.applyPatch without surfacing the patch" :353 — the pattern for gating invariant tests |
| tests/unit/chat-parity.test.ts | store reducers | `agent:critique` reducer :298, queueing :375, editUserTurn :414 — the pattern for new `_onSync` cases (plan events) |
| tests/unit/approval-gate.test.ts + agent-diff-approval.test.ts | approval flow, diff cards | Pending-map resolve/timeout tests :150-253 — the pattern for plan-approval resolution tests |

Vitest; unit tests under tests/unit (jsdom via tests/setup.ts), integration under tests/integration. New mode tests should follow: (a) registry/allowlist membership (registry.test.ts style), (b) runner source invariants (audit-test style), (c) store reducer events (chat-parity style), (d) MockLLM loop behavior (integration/runner style, noting it exercises the LEGACY path — mode gating added only in runner-native needs unit-level tests or a native-path harness).

---

## 8. Recommended integration points (summary)

1. **Mode field flow**: add `mode?: 'ask' | 'plan' | 'build'` to `AgentRunSettings` (settings/types.ts:221-273) + extract in `agentRunSettings()` (:299-321) → flows automatically through store.ts:1729/1741/1770 → server.ts:567 → route.ts:54-87 (add one validation line) → runner-native.ts:225-244 (read it). Also persist per-message via journal payload (route.ts:194-200) — zero Prisma migration.
2. **Tool gating per mode**: runner-native.ts:374-391 (filter — Ask = read-only set, e.g. PARALLEL_SAFE_TOOL_NAMES ∪ reads), :528-571 (brief-gate wrapper pattern for enforcement), :599-622 (approval wrapper pattern for Build-mode gating).
3. **Critique cadence per mode**: the entry gate at runner-native.ts:1649-1677 — skip entirely in Ask; run once-only / on-demand in Plan (e.g. after plan approval); keep bounded loop in Build. `maxDesignCritiqueIterations` is already a per-run knob (:1646) — make it mode-derived instead of hardcoded (settings/types.ts:319).
4. **Plan approval persistence**: new SyncEvent types (canvas/types.ts:529+, following :636 approval_request / :623 ask_user_question) + pending-map module copying approval-gate.ts:73-186 + resolve route beside /api/agent/approvals + `_onSync` case + ChatTurn field + TurnBubble card. Watchdog interplay: emit keepalive or pause the 120s watchdog (route.ts:215/229-274) while a plan approval is pending.
5. **Mode selector UI**: AgentPanel action row :1505-1569 (next to thinking-level cycler :1554), ToggleGroup/Select primitives; per-session state in canvas store or persisted in settings (thinkingLevel precedent :658-659/:1554-1569).
6. **Ask mode**: lean on ask_user_question plugin (ask-user-question.ts:115-199, default-on), text critic as advisor; suppress `expectsCanvasOutput` retry heuristics (runner-native.ts:470-474) and the brief gate (:476-498) for question turns.
