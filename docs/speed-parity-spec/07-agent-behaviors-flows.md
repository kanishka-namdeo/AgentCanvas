# 07 — Agent Behaviors & Flows

> **Scope:** Changes to the agent's runtime behaviors — the brief pre-generation race, the critique loop, the fallback ladder, sub-agent dispatch, and the per-turn message assembly. These are the runtime decisions that govern WHEN expensive things happen.

---

## The behavior surface today

Per the pipeline map (Task ID 2), the pi-agent's per-turn flow is:

1. **Intent classification** (`runner-native.ts:429-452`) — keyword pass first, LLM fallback on low confidence.
2. **Brief pre-generation race** (`runner-native.ts:702-724`) — 25s timeout, joined before user-message assembly.
3. **Web-research sub-agent** (`runner-native.ts:945-1110`) — dispatched + awaited serially before main loop when triggered.
4. **System prompt + canvas snapshot build** (`runner-legacy.ts:1528`) — ~45K-token static prefix.
5. **User message assembly** (`runner-native.ts:1545-1579`) — system meta + prompt + brief + conversation history + snapshot + per-turn sections.
6. **Attempt loop** (`runner-native.ts:1700-2217`) — up to 4 attempts; each attempt = `session.prompt()` + SDK event drain.
7. **Stuck detector** (`runner-native.ts:1638-1663`) — 3 consecutive identical-signature failures → stop.
8. **Fallback ladder** (`runner-native.ts:2041-2213`) — same-provider rate-limit backoff → z.ai sandbox swap → legacy 8s net.
9. **Auto-continue past truncation** (`runner-native.ts:2229-2309`) — bounded to 2 continuation segments.
10. **PLAN-mode execution phase** (`runner-native.ts:2321-2467`) — disposes planning session, creates new exec session.
11. **Adaptive critique loop** (`runner-native.ts:2537-3016`) — 0-2 iterations; each iteration = text critic + VLM critic (concurrent) + fix-turn re-prompt.

Each of these behaviors has a tier-blind default that wastes wall-clock on the trivial tier.

---

## Change 1: Narrow `shouldEnforceBrief` (P0)

**File:** `src/lib/agent/runner-native.ts:600-602, 702-724, 1146-1152, 1553-1555`.

**Current behavior:**

```ts
const shouldEnforceBrief = isDesignRequest(prompt) && mode === 'build'
  && turnStartShapeIds.size === 0
  && !clarifyOnEmptyCanvas;
```

`isDesignRequest` at L579-582 is a keyword regex: `/\b(design|dashboard|landing\s*page|app|ui|build|create|make|draw|scaffold|layout|interface|website|page|screen)\b/`.

The false-positive rate is high: `draw|create|make` are extremely common verbs that match trivial prompts ("draw a red rectangle", "add a bold heading", "create a 240x120 button").

**Change:**

```ts
const shouldEnforceBrief = isMultiSectionDesignRequest(prompt) && mode === 'build'
  && turnStartShapeIds.size === 0
  && !clarifyOnEmptyCanvas;

// New predicate — requires multi-section signal
function isMultiSectionDesignRequest(prompt: string): boolean {
  if (prompt.split(/\s+/).length < 12) return false; // skip trivial prompts
  const multiSectionKeywords = /\b(dashboard|landing\s*page|kanban|pricing\s*(section|page)?|app|website|page|screen|onboarding|flow|wizard|checkout|signup|navbar|sidebar|hero\s*section|footer|grid|table|chart)\b/;
  return multiSectionKeywords.test(prompt);
}
```

**Impact:** Trivial prompts skip the brief sub-agent entirely → ~7s saved on trivial-tier TTFT.

**Risk:** A multi-section prompt that's < 12 words would skip the brief. Examples that would be affected:

- "design a dashboard" (3 words) — would skip brief. Model improvises palette.
- "make a kanban" (3 words) — would skip brief.
- "build a landing page" (4 words) — would skip brief.

**Mitigation:** The model can still call `pen_generate_design_brief` as its first tool call. The brief tool itself stays available — only the pre-generation race is gated.

**Test:** Add `tests/unit/trivial-tier-brief-skip.test.ts`:

- Assert "draw a red rectangle" → `shouldEnforceBrief === false`.
- Assert "add a bold heading" → `shouldEnforceBrief === false`.
- Assert "create a 240x120 button" → `shouldEnforceBrief === false`.
- Assert "design a high-fidelity analytics dashboard with 4 KPI cards" → `shouldEnforceBrief === true`.
- Assert "design a marketing landing page for an AI tool" → `shouldEnforceBrief === true`.

---

## Change 2: Lower brief timeout 25s → 12s (P0)

**File:** `src/lib/agent/runner-native.ts:712-713`.

**Current:** `const preGeneratedBriefPromise = (async () => dispatchDesignBriefSubAgent(...))()` raced against `Promise.race([briefPromise, timeoutPromise(25_000)])`.

**Change:** Lower the timeout to 12s. The brief is best-effort; the tool-layer gate at L760-804 is the recovery path.

**Impact:** Worst-case brief wait drops 25s → 12s on slow endpoints. Real brief success time on most providers is 3-8s; 12s leaves a 50% safety margin.

**Risk:** A genuinely slow endpoint that takes 13s for the brief would lose it. Mitigation: the tool-layer gate (`runner-native.ts:760-804`) still enforces brief-first for non-trivial design requests — the model can call `pen_generate_design_brief` directly if the pre-gen failed.

---

## Change 3: Tier-aware `maxIterations` (P0)

**File:** `src/lib/agent/runner-native.ts:278, 1793, 2365`.

**Current:** `const maxIterations = settings?.maxIterations ?? 20` (overridden to 30 in speed-bench).

**Change:** Tier-aware defaults:

```ts
const TIER_MAX_ITERATIONS = {
  trivial: 4,
  simple: 8,
  multi: 14,
  complex: 24,
  enterprise: 32,
};

const maxIterations = settings?.maxIterations
  ?? TIER_MAX_ITERATIONS[classifierResult.tier]
  ?? 20;
```

**Impact:** Bounds worst-case turn wall-clock per tier. Trivial tier can't spiral into 78-call runaway (the original Agent Performance Package motivation). The hard cap is a backstop for runaway model behavior.

**Risk:** A complex prompt misclassified as trivial would lose the iteration budget. Mitigation: the trivial-tier classifier requires `prompt < 12 words AND no design keyword` — both conditions must hold. A multi-section design keyword in the prompt pushes it out of trivial.

---

## Change 4: Tier-aware `maxCritiqueIterations` (P0)

**File:** `src/lib/agent/runner-native.ts:2520`.

**Current:** `const maxCritiqueIterations = settings?.maxDesignCritiqueIterations ?? 2`.

**Change:** Tier-aware defaults:

```ts
const TIER_MAX_CRITIQUE_ITERATIONS = {
  trivial: 0,
  simple: 1,
  multi: 2,
  complex: 2,
  enterprise: 2,
};

const maxCritiqueIterations = settings?.maxDesignCritiqueIterations
  ?? TIER_MAX_CRITIQUE_ITERATIONS[classifierResult.tier]
  ?? 2;
```

**Impact:** Belt-and-suspenders on the `shouldRunCritics` gate. Trivial tier short-circuits the FREE deterministic validation gate's iteration count too.

**Risk:** A complex prompt misclassified as simple would lose the second critique iteration. Mitigation: the deterministic Gate 0 (`validateCanvasBeforeComplete` at L2608) still runs every build turn regardless of mode — it surfaces defects even when critics don't fire.

---

## Change 5: Drop legacy 8s net for z.ai rate-limit-shaped failures (P0)

**File:** `src/lib/agent/runner-native.ts:2213`.

**Current:** The legacy 8s net fires on `(!sawActivity || diedMidStream || textOnlyDesignTurn) && !didFallback && (providerId === 'zai' || currentModel.usedFallback === true) && (!rateLimitSignature)`. The 8s sleep + same-model retry.

**Change:** Skip the 8s sleep when the failure IS rate-limit-shaped (the 20s+45s backoff tier at L2068-2106 already handled that):

```ts
// Before:
if (!sawActivity && !rateLimitSignature) {
  await sleep(8000); // legacy 8s net
  // ... retry same model ...
}

// After:
if (!sawActivity && !rateLimitSignature) {
  // Skip the 8s sleep for z.ai sandbox — it's the auto-credential fallback,
  // and a same-model retry on a dead endpoint rarely recovers.
  if (providerId !== 'zai' && !currentModel.usedFallback) {
    await sleep(8000);
  }
  // ... retry same model ...
}
```

**Impact:** Removes 8s of dead time on z.ai rate-limited turns. Observed in 3 of 9 completed speed-bench scenarios (`agent:error` events).

**Risk:** A non-rate-limit empty response on z.ai loses the 8s recovery sleep. Mitigation: keep the existing `!rateLimitSignature` predicate — the change only skips the 8s sleep for the rate-limit-shaped case (which was already handled by the backoff tier).

---

## Change 6: Skip VLM critic client-screenshot round-trip for ≤20-shape canvases (P0)

**File:** `src/lib/agent/subagents/design-critic-vlm.ts:140-146`.

**Current:** Every critic dispatch sends `agent:screenshot_request` and waits up to 3s for a client-side `html-to-image` capture. On timeout, falls back to `renderCanvasToPng` (server-side resvg, now in a child process per `src/lib/canvas/render-to-png.ts:22,102`).

**Change:** For canvases with ≤20 shapes, skip the client round-trip and go straight to resvg:

```ts
const canvasShapeCount = ctx.canvas.shapes.length;
const useClientScreenshot = canvasShapeCount > 20;
const screenshotPromise = useClientScreenshot
  ? requestClientScreenshot(ctx)  // 3s timeout
  : renderCanvasToPng(ctx.canvas.shapes, 1440, 900);  // server-side, ~200ms
```

**Impact:** Saves 3s per critic dispatch on small canvases. Real impact bounded by how often the critic fires on small canvases (default `designCritiqueMode='manual'` means critics only fire on `/critique` keyword, which is rare on trivial-tier).

**Risk:** The resvg approximation diverged from the real DOM on 100% of mandatory critic runs (per the Audit 2-c S2 note). Mitigation: keep the `screenshotSource: 'client' | 'server'` telemetry so users see when the critic judged the approximation. The canvasSnapshot's measured-bounds already threads real browser sizes into the resolver, so resvg's geometry is more accurate now than when S2 was filed.

---

## Change 7: Lower classifier LLM-fallback retry budget (P1)

**File:** `src/lib/agent/classifier.ts:321`.

**Current:** `callLLMWithRetry(subAgentLLM, classifyPrompt, { maxRetries: 3, baseDelayMs: 3000 })`.

**Change:** `callLLMWithRetry(subAgentLLM, classifyPrompt, { maxRetries: 1, baseDelayMs: 1500 })`.

**Impact:** Worst-case ambiguous-prompt TTFT drops 18s → ~5s on slow endpoints. Real classifier LLM-call success time is 3-8s; 1 retry with 1.5s backoff leaves a 50% safety margin.

**Risk:** A genuinely ambiguous prompt that the keyword pass can't route would fall through to the 'multi' safe fallback at L87-93 — which loads all skills. That's existing behavior; the proposal just makes it happen faster.

---

## Change 8: Parallelize web-research with main loop (P2)

**File:** `src/lib/agent/runner-native.ts:945-1110`.

**Current:** Web-research is dispatched + awaited serially before user-message assembly. If web-research is needed, the main loop doesn't start until it finishes.

**Change:** Dispatch web-research as a background promise. Start the main loop on the bare prompt immediately. If web-research returns in time (within the first main-loop iteration), inject the summary as a `agent:tool_progress`-style event mid-turn. If it doesn't return in time, let the main loop finish without it.

```ts
// Before:
const webResearchResult = await dispatchWebResearchSubAgent(...);
const webResearchSection = webResearchResult ? formatWebResearch(webResearchResult) : '';
const userMessage = buildUserMessage({ ..., webResearchSection });

// After:
const webResearchPromise = dispatchWebResearchSubAgent(...);
const userMessage = buildUserMessage({ ..., webResearchSection: '' }); // start without it
// ... start main loop ...
// In the attempt loop, poll the promise:
if (!webResearchInjected && (await Promise.race([webResearchPromise, Promise.resolve(null)]))) {
  const result = await webResearchPromise;
  // Inject as a follow-up message via session.steer()
  session.steer({ type: 'user_message', text: `[WEB RESEARCH RESULT — apply to current design if relevant:]\n${formatWebResearch(result)}` });
  webResearchInjected = true;
}
```

**Impact:** Web-research adds 30-90s of serial wall-clock when triggered. Parallelizing eliminates this for the common case (research returns in time).

**Risk:** The agent's first iteration may make design decisions without web research context. If the research contradicts those decisions, the agent has to redo work. Mitigation: web-research is rare (only when classifier routes to `web_research` category); for design prompts, the classifier doesn't route there.

---

## Change 9: Cache `pen_get_computed` per turn (P2)

**File:** `src/lib/agent/client-roundtrip.ts` (add LRU), `src/lib/canvas/patch.ts` (add invalidation hook).

**Current:** Every `pen_get_computed` call goes through a 2s client round-trip. The model often calls `pen_get_computed` for the same node multiple times in one turn (especially after mutations).

**Change:** Add per-turn LRU keyed by `(nodeId, turnId)` with 5s TTL. A mutation invalidates the entry.

```ts
// In client-roundtrip.ts:
const computedCache = new Map<string, { value: ComputedResult; expiresAt: number }>();

export async function getComputed(nodeId: string, turnId: string, ctx: ToolContext): Promise<ComputedResult | null> {
  const key = `${turnId}:${nodeId}`;
  const cached = computedCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  const value = await requestClientComputed(ctx, nodeId); // 2s timeout
  if (value) {
    computedCache.set(key, { value, expiresAt: Date.now() + 5000 });
  }
  return value;
}

// In patch.ts applyPatchToCanvas — invalidate on mutation:
export function applyPatchToCanvas(canvas, patch) {
  // ... existing apply logic ...
  invalidateComputedCache(patch.targetNodeIds);
  return nextCanvas;
}
```

**Impact:** Reduces 2-4 redundant 2s round-trips per complex turn to 1. Saves 4-8s on complex-tier turns where the model re-reads nodes after mutations.

**Risk:** Cached value may be stale if the mutation didn't invalidate the right entry. Mitigation: invalidate by parent path, not just exact node id (a parent's mutation affects children).

---

## Change 10: Make rate-limit backoff user-visible (P2)

**File:** `src/lib/agent/runner-native.ts:2068-2106` (heartbeat), `src/components/canvas/AgentPanel.tsx` (UI banner).

**Current:** The rate-limit backoff tier emits `agent:tool_progress` heartbeats every ≤20s. The UI surfaces these as generic tool-progress events.

**Change:** Surface the heartbeat as a prominent "Rate-limited — retrying in Ns" banner. The existing `06-retry-banner-rate-limit.png` in `download/progressive-disclosure/` shows the UI already has this affordance — wire the heartbeat event to it.

**Impact:** Doesn't speed up the turn, eliminates the perceived-latency penalty. Per the perceived-latency research (`03-industry-parity-targets.md`), "a 3-second streaming response often feels faster than a 1-second batch response."

**Risk:** None — UI change only.

---

## Summary of changes (priority-ordered)

| # | Change | File | Complexity | P-level | Expected Δ |
|---|---|---|---|---|---|
| 1 | Narrow `shouldEnforceBrief` predicate | `runner-native.ts:600-602` | S | P0 | trivial-shape TTFT 10.6s → ~3-4s |
| 2 | Lower brief timeout 25s → 12s | `runner-native.ts:712-713` | S | P0 | worst-case brief wait 25s → 12s |
| 3 | Tier-aware `maxIterations` | `runner-native.ts:278` | S | P0 | bounds worst-case turn wall-clock per tier |
| 4 | Tier-aware `maxCritiqueIterations` | `runner-native.ts:2520` | S | P0 | belt-and-suspenders on critique gate |
| 5 | Drop legacy 8s net for z.ai rate-limit failures | `runner-native.ts:2213` | S | P0 | removes 8s of dead time on z.ai |
| 6 | Skip VLM critic client-screenshot for ≤20-shape canvases | `design-critic-vlm.ts:140-146` | S | P0 | saves 3s per critic dispatch on small canvases |
| 7 | Lower classifier LLM-fallback retry budget | `classifier.ts:321` | S | P1 | worst-case ambiguous-prompt TTFT 18s → ~5s |
| 8 | Parallelize web-research with main loop | `runner-native.ts:945-1110` | M | P2 | eliminates 30-90s serial wait when triggered |
| 9 | Cache `pen_get_computed` per turn | `client-roundtrip.ts`, `patch.ts` | M | P2 | saves 4-8s per complex turn on redundant reads |
| 10 | Make rate-limit backoff user-visible | `runner-native.ts`, `AgentPanel.tsx` | S | P2 | eliminates perceived-latency penalty |
