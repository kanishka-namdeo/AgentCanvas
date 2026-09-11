# Designer Workflow Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the agent a designer-grade process: staged lo-fi → approval → hi-fi for screen-scale creation, variant runner-ups parked on an Explorations page with a chat promote card, and component-first construction for repeated structures.

**Architecture:** All three features reuse existing machinery. The staged flow reuses the PLAN-mode approval gate (`plan-gate.ts` + `PlanApprovalCard` + `POST /api/agent/plans`) with a `kind: 'layout'` discriminator. Variant parking rides the existing patch stream (`add_subtree` gains a page target) and the existing client-driven `document:restore` broadcast path for promote. Component-first is a system-prompt rule plus one deterministic validator rule with template exemption.

**Tech Stack:** TypeScript, Next.js App Router, Zustand, Vitest (bun), pi-coding-agent SDK (`defineTool`, `Type` from `@earendil-works/pi-ai`).

**Spec:** `docs/superpowers/specs/2026-09-12-designer-workflow-parity-design.md` (research-grounded §9)

## Global Constraints

- Patch applier `applyPatchToCanvas` is PURE and NULL-SAFE — it must never throw on agent data; all numeric fields coerced with `Number()` (`src/lib/canvas/AGENTS.md` patch contract).
- Tool-schema byte budget: total serialized registry stays ~43k chars; new tools use compact schemas + `see pen_create_node` pointers (`src/lib/agent/AGENTS.md`).
- No tool renames/removals; all SyncEvent changes ADDITIVE (new variants, optional payload fields).
- System prompt stays byte-stable (cacheable prefix): staged-flow + component-first text goes in `SYSTEM_PROMPT_TEMPLATE` (bump `PROMPT_VERSION`) or first-user-message sections — never per-turn system prompt churn.
- Every new SyncEvent kind needs: type in `src/lib/canvas/types.ts`, a `_onSync` case in `src/lib/canvas/store.ts`, and a forwarding case in `src/app/api/agent/route.ts`.
- Test runner: `bunx vitest run <file>` per file, `bun run test` full suite; typecheck `bunx tsc --noEmit`.
- Commits: one per task, conventional-commit style (`feat:`, `test:`, `docs:`).

---

## Surface Coverage Map

Every surface the three features touch, and where it's handled:

| Surface | Change | Task |
|---|---|---|
| `src/lib/agent/validators.ts` + runner flags | Rule 8 + template/component-tool exemptions | 1 |
| `src/lib/agent/runner-legacy.ts` prompt | Component-first rule, PROMPT_VERSION | 2 |
| `src/lib/canvas/patch.ts` | `add_subtree`/`bulk_add` page target + targeted write-back | 3 |
| `src/lib/agent/tools.ts` + `variant-parking.ts` | Runner-up parking patches + thumbnails + alternatives event emit | 4 |
| `src/lib/canvas/types.ts` SyncEvents | `agent:alternatives_parked` + `kind` on `agent:plan_proposed` | 5, 10 |
| `src/lib/canvas/store.ts` `_onSync` | Both event cases + card-state sanitization | 5, 10 |
| `src/app/api/agent/route.ts` | Forwarding cases for both events | 5 |
| `src/components/canvas/AgentPanel.tsx` | `AlternativesCard` + `PlanApprovalCard` layout kind | 5, 10 |
| `src/lib/sessions/types.ts` + sessions store | **Persist `alternatives` on assistant messages** — `Message` (sessions/types.ts:163-196) has the `patchOps` extras precedent; write via a session-store method called from the `_onSync` case (the `appendAssistantText` pattern, store.ts:814-818), restore in `_syncTurnsFromSession` (store.ts:2856-2899). Card survives reload/session-switch; `planProposal` stays live-buffer-only | 5 |
| `src/lib/canvas/variant-promote.ts` + promote route | Pure swap + `POST /api/documents/[id]/variants/promote` | 6 |
| `src/lib/canvas/run-registry.ts` | **No change** — the read-only `getActiveRun(documentId): ActiveRunInfo \| null` already exists (run-registry.ts:90-92); the route's 409 check uses it directly | 6 |
| `src/lib/canvas/journal-fold.ts` + event journal | `variant_promote` fold case (inside `foldTail`'s else-if chain after `document_restore`, journal-fold.ts:220-276) + tombstones for removed ids. `AgentEvent.type` is a PLAIN STRING (prisma/schema.prisma:137) — no migration. `variant_promote` rows are auto-skipped by catch-up (journal-catchup.ts:225-236 dispatches only `agent:`-prefixed rows) | 6 |
| `src/lib/agent/event-journal.ts` | Add `agent:alternatives_parked` to `JOURNALED_AGENT_EVENT_TYPES` (event-journal.ts:34-69) so reconnecting clients replay the card via journal-catchup | 5 |
| Prisma schema | **No migration** — the journal table's `type` is a plain string column; verified in Task 6 | — |
| `src/lib/agent/prompt-intent.ts` | `shouldOfferStagedFlow` | 7 |
| `src/lib/agent/layout-gate.ts` + `plan-gate.ts` | `submit_layout_approval` tool, lo-fi allowlist, `kind` discriminator | 8 |
| `src/lib/agent/runner-native.ts` + `modes.ts` | Staged detection/directive/toolset/execution-session; **force-include `ask_user_question`** — `isOneShotBuildTurn = mode === 'build' && turnStartShapeIds.size === 0` (runner-native.ts:605) is TRUE on staged turns (build + empty canvas), so `ONE_SHOT_DROP_TOOLS` (line 600, includes `ask_user_question`) WOULD strip the staged ask's vehicle; the slimming gate must become `isOneShotBuildTurn && stagedFlow !== 'lofi'` | 9 |
| `src/components/canvas/LayersPanel.tsx` | **No code change** — already renders the pages surface; Task 11 verifies the Explorations page appears and switches there | 11 |
| Client undo / turn-diff | **No change** — off-page adds don't enter `document.shapes` (active-page derived), so no viewport reveal; diff chips may show parking creates (desirable) | — |
| Export (`pen_export_pen`, copy-as-code) | **No change** — parked sections export with their page; noted in DOX | 11 |
| Settings | **No change** — per user decision, no staged-flow toggle | — |
| DOX + eval | All affected AGENTS.md files + staged eval scenario | 11 |

---

### Task 1: Repeated-structure validator rule (spec §5.2)

**Files:**
- Modify: `src/lib/agent/validators.ts`
- Modify: `src/lib/agent/runner-native.ts` (thread exemption flags at the 3 `validateCanvasBeforeComplete` call sites: lines ~1448, ~2794, ~2832)
- Test: `tests/unit/repeated-structure-validator.test.ts`

**Interfaces:**
- Produces: `structuralSignature(node: Layer, depth?: number): string` and option `repeatedStructures?: { usedTemplateGeneration: boolean; componentToolsVisible: boolean }` on `validateCanvasBeforeComplete`'s `opts`. A turn trips the new rule only when ≥3 siblings share one signature, none is a ref/component instance, AND `!usedTemplateGeneration && componentToolsVisible`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/repeated-structure-validator.test.ts
import { describe, it, expect } from 'vitest';
import { validateCanvasBeforeComplete } from '@/lib/agent/validators';
import type { Layer } from '@/lib/canvas/types';

let seq = 0;
function frame(name: string, x: number, opts?: { parentId?: string; componentId?: string }): Layer {
  return {
    id: `f${++seq}`, type: 'frame', name, x, y: 100, width: 200, height: 120,
    fill: '#ffffff', ...(opts?.parentId ? { parentId: opts.parentId } : {}),
    ...(opts?.componentId ? { componentId: opts.componentId } : {}),
  } as Layer;
}

describe('repeatedStructureWithoutComponents', () => {
  const opts = { relaxMinCount: true, repeatedStructures: { usedTemplateGeneration: false, componentToolsVisible: true } };

  it('fires on 3 identical non-ref siblings', () => {
    const shapes = [frame('KPI Card', 0), frame('KPI Card', 220), frame('KPI Card', 440), frame('Sidebar', 660)];
    const result = validateCanvasBeforeComplete(shapes, opts);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes('repeated structures') && r.includes('component'))).toBe(true);
  });

  it('passes with 2 identical siblings (below threshold)', () => {
    const shapes = [frame('KPI Card', 0), frame('KPI Card', 220)];
    expect(validateCanvasBeforeComplete(shapes, opts).ok).toBe(true);
  });

  it('exempts component instances (refs)', () => {
    const shapes = [frame('KPI Card', 0, { componentId: 'c1' }), frame('KPI Card', 220, { componentId: 'c1' }), frame('KPI Card', 440, { componentId: 'c1' })];
    expect(validateCanvasBeforeComplete(shapes, opts).ok).toBe(true);
  });

  it('exempts template-generated turns', () => {
    const shapes = [frame('Card', 0), frame('Card', 220), frame('Card', 440)];
    expect(validateCanvasBeforeComplete(shapes, { relaxMinCount: true, repeatedStructures: { usedTemplateGeneration: true, componentToolsVisible: true } }).ok).toBe(true);
  });

  it('exempts when component tools were not visible', () => {
    const shapes = [frame('Card', 0), frame('Card', 220), frame('Card', 440)];
    expect(validateCanvasBeforeComplete(shapes, { relaxMinCount: true, repeatedStructures: { usedTemplateGeneration: false, componentToolsVisible: false } }).ok).toBe(true);
  });

  it('ignores text content and fills in the signature', () => {
    const a = frame('KPI Card', 0); (a as any).fill = '#ff0000';
    const b = frame('KPI Card', 220); (b as any).fill = '#00ff00';
    const shapes = [a, b, frame('KPI Card', 440)];
    expect(validateCanvasBeforeComplete(shapes, opts).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/unit/repeated-structure-validator.test.ts`
Expected: FAIL — TS error, unknown option / no repeated-structures reason.

- [ ] **Step 3: Implement in validators.ts**

Add the rule as Rule 8 (depth-limited signature over SIBLING GROUPS — group shapes by `parentId ?? 'root'`, compare signatures within each group; ≥3 sharing one signature and none with `componentId` fires):

```ts
export function structuralSignature(node: Layer, depth = 4): string {
  const childIds = new Set(shapes.map((s) => (s as any).parentId).filter(Boolean));
  void childIds; // signature is computed per-group in repeatedStructures()
  const childrenOf = (id: string) => shapes.filter((s) => (s as any).parentId === id);
  const walk = (n: Layer, d: number): string => {
    const kids = d <= 0 ? [] : childrenOf(n.id).sort((a, b) => a.x - b.x || a.y - b.y);
    return `${n.type}(${kids.map((k) => walk(k, d - 1)).join(',')})`;
  };
  return walk(node, depth);
}
```

(Put the sibling-grouping inside `validateCanvasBeforeComplete`: group by parent, map each group member through `structuralSignature` with the group's member list, bucket by signature.) Failure reason text: `"${count} repeated structures with identical layout (${sigPreview}) — build ONE component (figma_create_component or pen_convert_to_component) and place instances (pen_place_component_instance) instead of duplicating bespoke subtrees. Restyle the main component; instances inherit."` Guard: skip entirely when `opts?.repeatedStructures` is absent (default-off for existing callers/tests) or when the exemption flags say so.

- [ ] **Step 4: Thread the flags in runner-native.ts**

At each of the three call sites (~1448, ~2794, ~2832) pass `repeatedStructures: { usedTemplateGeneration: <generatorCallsThisTurn > 0>, componentToolsVisible: <turnToolNames has figma_create_component or pen_convert_to_component> }`. Track `generatorCallsThisTurn` with a `let` reset at prompt start, incremented where tool_call_end events for `pen_generate_wireframe` / `pen_create_card_grid` / `pen_create_landing_page` / `pen_create_table` are already observed (grep `tool_call_end` handling in runner-native.ts — the translator path already sees these; increment in the same place `agentAddedShapesThisTurn`-style bookkeeping happens).

- [ ] **Step 5: Run tests to verify they pass**

Run: `bunx vitest run tests/unit/repeated-structure-validator.test.ts && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Full suite green, commit**

Run: `bun run test` → green.
```bash
git add src/lib/agent/validators.ts src/lib/agent/runner-native.ts tests/unit/repeated-structure-validator.test.ts
git commit -m "feat(validator): repeated-structure check drives component-first construction"
```

---

### Task 2: Component-first system-prompt rule + PROMPT_VERSION bump (spec §5.1)

**Files:**
- Modify: `src/lib/agent/runner-legacy.ts` (PROMPT_VERSION line 115 → `'2026-09-12.1'`; DESIGN PRINCIPLES at line ~942; COMPONENT RECIPES at line ~604)
- Test: `tests/unit/component-first-prompt.test.ts`

**Interfaces:**
- Consumes: nothing. Produces: prompt text later tasks' docs reference.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/component-first-prompt.test.ts
import { describe, it, expect } from 'vitest';
import { SYSTEM_PROMPT_TEMPLATE, PROMPT_VERSION } from '@/lib/agent/runner-legacy';

describe('component-first prompt rule', () => {
  it('bumps PROMPT_VERSION', () => {
    expect(PROMPT_VERSION).toBe('2026-09-12.1');
  });
  it('carries the >=3 repeated structures rule', () => {
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('3 identical repeated structures');
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('pen_place_component_instance');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `bunx vitest run tests/unit/component-first-prompt.test.ts` → FAIL.

- [ ] **Step 3: Implement** — In DESIGN PRINCIPLES add:

```
- COMPONENT-FIRST RULE: when a screen contains >=3 identical repeated structures (KPI cards,
  list rows, nav items, table rows), build ONE component (figma_create_component or
  pen_convert_to_component) and place INSTANCES (pen_place_component_instance) instead of
  duplicating bespoke subtrees. Style the main component once; instances inherit — follow-up
  restyles then propagate everywhere. Place instances inside the screen's auto-layout flow.
```

Bump `PROMPT_VERSION` to `'2026-09-12.1'`.

- [ ] **Step 4: Verify** — test passes; `bun run test` stays green (prompt-snapshot tests may pin the old version — update them to the new version, they exist under `tests/unit/`, grep `PROMPT_VERSION`).
- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/runner-legacy.ts tests/unit/component-first-prompt.test.ts
git commit -m "feat(prompt): component-first construction rule (PROMPT_VERSION 2026-09-12.1)"
```

---

### Task 3: `add_subtree` / `bulk_add` page target (spec §4.1 patch layer)

**Files:**
- Modify: `src/lib/canvas/patch.ts` (`add_subtree` case at line ~255, `bulk_add` at ~246, pages write-back at ~1014-1025)
- Test: `tests/unit/subtree-page-target.test.ts`

**Interfaces:**
- Consumes: `CanvasPatch.pageName` / `CanvasPatch.pageId` (already in `types.ts:500-501`, used by page ops via `findPageIndex`).
- Produces: patches `{ op:'add_subtree', shape, pageName:'Explorations' }` insert into the NAMED page, not the active one. Spec refinement (document in DOX): an unknown `pageName` AUTO-CREATES the page (deterministic id `page-<slug>`) instead of hard-erroring — the applier is null-safe by contract; the hard error lives in the tool layer (Task 4 emits `add_page` first, so auto-create is a defense, never the happy path).

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/subtree-page-target.test.ts
import { describe, it, expect } from 'vitest';
import { applyPatchToCanvas, emptyDocument } from '@/lib/canvas/patch';

const subtree = { id: 'root1', type: 'frame', name: 'Variant A', x: 0, y: 0, width: 100, height: 80, children: [] };

describe('add_subtree page target', () => {
  it('inserts into the named page when it is not active', () => {
    const doc = emptyDocument();
    doc.pages = [{ id: 'p1', name: 'Page 1', children: [] }, { id: 'p2', name: 'Explorations', children: [] }];
    doc.activePageIndex = 0;
    const next = applyPatchToCanvas(doc as any, { op: 'add_subtree', shape: subtree, pageName: 'Explorations' } as any);
    expect(next.pages![1].children).toHaveLength(1);
    expect(next.children).toHaveLength(0); // active page untouched
    expect(next.pages![1].children[0].id).toBe('root1');
  });

  it('auto-creates the page for an unknown name (defense, never the happy path)', () => {
    const doc = emptyDocument();
    const next = applyPatchToCanvas(doc as any, { op: 'add_subtree', shape: subtree, pageName: 'Explorations' } as any);
    const page = next.pages!.find((p) => p.name === 'Explorations');
    expect(page).toBeTruthy();
    expect(page!.children).toHaveLength(1);
    expect(next.children).toHaveLength(0);
  });

  it('behaves byte-identically to today when no pageName is given', () => {
    const doc = emptyDocument();
    const next = applyPatchToCanvas(doc as any, { op: 'add_subtree', shape: subtree } as any);
    expect(next.children).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `bunx vitest run tests/unit/subtree-page-target.test.ts` → FAIL (all inserts go to active page).

- [ ] **Step 3: Implement in patch.ts**

In the `add_subtree` (and `bulk_add`) cases, before `insertNode`: resolve `const targetIdx = patch.pageName || patch.pageId ? findPageIndex(next.pages ?? [], patch) : -1`. If a target page resolved AND it is not the active page: build the node (`normalizeSubtree`/`normalizeToNode` as today), then `next.pages = next.pages!.map((p,i) => i === targetIdx ? { ...p, children: insertNode(p.children, node, null) } : p)`; ALSO auto-create when `findPageIndex` returns -1 but a name was given (push `{ id: 'page-<lowercased-slug>', name: patch.pageName!, children: [node] }`); leave `next.children` untouched. Keep a local `let targetWriteBackIndex: number | null = null` set in these cases; in the D1 write-back block (~1014), write `next.children` into `targetWriteBackIndex ?? activeIndex` (when the target IS the active page, behavior is byte-identical to today).

- [ ] **Step 4: Run tests to verify they pass** — `bunx vitest run tests/unit/subtree-page-target.test.ts && bun run test` (patch-coalesce/property tests must stay green — they never pass pageName).
- [ ] **Step 5: Commit**

```bash
git add src/lib/canvas/patch.ts tests/unit/subtree-page-target.test.ts
git commit -m "feat(patch): add_subtree/bulk_add honor a pageName/pageId target page"
```

---

### Task 4: Variant parking + thumbnails (spec §4.1/§4.2)

**Files:**
- Create: `src/lib/agent/variant-parking.ts` (PURE patch builder — unit-testable)
- Modify: `src/lib/agent/tools.ts` (`pen_generate_variants` execute, ~line 1448, after the winner patch is emitted)
- Test: `tests/unit/variant-parking.test.ts`

**Interfaces:**
- Consumes: `VariantSpec { direction, spec, warningCount, nodeCount, png?: Buffer }`, `VariantJudgeResult { winnerIndex, scores, ... }` from `variant-generator.ts`; `CanvasPatch` with the Task 3 page target.
- Produces: `buildParkingPatches(args: { doc: CanvasDocument; variants: VariantSpec[]; judge: VariantJudgeResult | null; winnerIndex: number; mainDesignName?: string }): { patches: CanvasPatch[]; parked: Array<{ id: string; label: string; score: number; thumbnail?: string }> }`. `parked[].id` = the section node id (the promote route's key). Thumbnails = `data:image/png;base64,…` when `png` exists and `png.length <= 150_000`, else omitted.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/variant-parking.test.ts
import { describe, it, expect } from 'vitest';
import { buildParkingPatches } from '@/lib/agent/variant-parking';
import { applyPatchToCanvas, emptyDocument } from '@/lib/canvas/patch';

const spec = (name: string) => ({ id: `v-${name}`, type: 'frame', name, x: 0, y: 0, width: 400, height: 300, children: [] });
const variants = [
  { direction: 'A', spec: spec('A'), warningCount: 0, nodeCount: 5 },
  { direction: 'B', spec: spec('B'), warningCount: 0, nodeCount: 5 },
  { direction: 'C', spec: spec('C'), warningCount: 0, nodeCount: 5 },
];
const judge = { winnerIndex: 0, scores: [8, 7, 6], reason: 'ok', method: 'vlm' as const };

describe('buildParkingPatches', () => {
  it('emits add_page + one labeled section per runner-up', () => {
    const doc = emptyDocument() as any;
    const { patches, parked } = buildParkingPatches({ doc, variants, judge, winnerIndex: 0 });
    expect(patches[0].op).toBe('add_page');
    expect(patches[0].pageName).toBe('Explorations');
    const sectionPatches = patches.filter((p) => p.op === 'add_subtree');
    expect(sectionPatches).toHaveLength(2);
    expect(sectionPatches.every((p) => (p as any).pageName === 'Explorations')).toBe(true);
    expect(parked.map((p) => p.label)).toEqual(['Variant B — 7', 'Variant C — 6']);
    expect(parked.every((p) => p.id.length > 0)).toBe(true);
  });

  it('applies cleanly to a document (runner-ups land off the active page)', () => {
    let doc = emptyDocument() as any;
    const { patches } = buildParkingPatches({ doc, variants, judge, winnerIndex: 0 });
    for (const p of patches) doc = applyPatchToCanvas(doc, p as any);
    expect(doc.children).toHaveLength(0);
    expect(doc.pages.find((p: any) => p.name === 'Explorations').children).toHaveLength(2);
  });

  it('prunes oldest parked sections FIFO at 5', () => {
    let doc = emptyDocument() as any;
    // Pre-fill 4 parked sections + add 2 more => 6 total => prune to 5.
    for (let i = 0; i < 4; i++) doc = applyPatchToCanvas(doc, { op: 'add_page', pageName: 'Explorations' } as any);
    doc.pages = doc.pages.filter((p: any, i: number) => i === 0 || p.name === 'Explorations');
    doc.pages.find((p: any) => p.name === 'Explorations').children = Array.from({ length: 4 }, (_, i) => ({ id: `old${i}`, type: 'section', name: `Old ${i}`, children: [spec(`old${i}`)] }));
    const { patches } = buildParkingPatches({ doc, variants: variants.slice(0, 2), judge, winnerIndex: 0 });
    const removePatches = patches.filter((p) => p.op === 'remove');
    expect(removePatches).toHaveLength(1); // 4 + 2 = 6 > 5 → drop the oldest
    expect((removePatches[0] as any).shapeIds).toEqual(['old0']);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `bunx vitest run tests/unit/variant-parking.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `variant-parking.ts`**

Pure module. Runner-up wrap: `{ id: newId(), type: 'section', name: \`Variant ${letter} — ${Math.round(score)}\`, x: 0, y: 0, width: 0, height: 0, children: [normalizedSpecRoot] }` (letter = 'B'/'C'/'D'… by index; spec root gets a fresh id to avoid colliding with the applied winner). `add_page` patch emitted first: `{ op: 'add_page', pageName: 'Explorations' }` (the existing page op creates only when missing — verify in patch.ts `add_page` case; if it unconditionally appends, guard by reading `doc.pages` first and emitting `add_page` only when absent). FIFO prune: existing parked sections = Explorations page's children (via `findPageIndex`-equivalent scan in the pure module — accept `doc` as argument); after adding K new, remove `(existing + K) - 5` oldest via `{ op:'remove', shapeIds:[oldestIds] }` patches. Return `parked` metadata.

- [ ] **Step 4: Wire into `pen_generate_variants`**

In tools.ts after the winner patch is emitted: call `buildParkingPatches({ doc: ctx.getDocument(), variants: result.variants, judge: result.judge, winnerIndex: result.judge.winnerIndex })`; emit each patch through the same sink the winner used. **Set `patch.summary` on every parking patch** (e.g. `"Parked variant B on the Explorations page"`) — `add_subtree` is in `CREATE_OPS` (turn-diff.ts:59) so parking shows as diff chips, and the summary is what the chip renders (`patchToOpRecord` uses `patch.summary || patch.op`). Build `alternatives` with thumbnails (`result.variants[i].png` → base64, 150KB cap) and emit `emitEvent({ type: 'agent:alternatives_parked', page: 'Explorations', pageId, sections: parked.map(p => p.label), alternatives, toolCallId })` — `emitEvent` from `./plugins/event-bus` flows to the stream automatically (the runner's sink at runner-native.ts:2039-2041 wraps every emitted SyncEvent as `{kind:'agent_event'}`; journaling rides `JOURNALED_AGENT_EVENT_TYPES`, added in Task 5). `pageId` = the Explorations page's id read from `ctx.getDocument()` after the `add_page` patch. Append a one-line note to the tool result text: "2 runner-up variants parked on the Explorations page."

- [ ] **Step 5: Verify + commit**

`bunx vitest run tests/unit/variant-parking.test.ts && bunx tsc --noEmit && bun run test`
```bash
git add src/lib/agent/variant-parking.ts src/lib/agent/tools.ts tests/unit/variant-parking.test.ts
git commit -m "feat(variants): park runner-up designs on the Explorations page with thumbnails"
```

---

### Task 5: `agent:alternatives_parked` event + PromoteCard UI (spec §4.3)

**Files:**
- Modify: `src/lib/canvas/types.ts` (SyncEvent union near line 704; ChatTurn alternatives field near `planProposal`; ClientEvent unchanged — restore reuse)
- Modify: `src/lib/canvas/store.ts` (`_onSync` case near line 3432; new `promoteAlternative` action near `restoreSnapshot` at ~2786; `_syncTurnsFromSession` restore at ~2856)
- Modify: `src/lib/sessions/types.ts` + `src/lib/sessions/store.ts` (persist `alternatives` on assistant `Message` — the `patchOps` extras precedent)
- Modify: `src/lib/agent/event-journal.ts` (`JOURNALED_AGENT_EVENT_TYPES` += `agent:alternatives_parked`, line ~34-69)
- Modify: `src/app/api/agent/route.ts` (forwarding case — mirror `agent:plan_proposed`)
- Modify: `src/components/canvas/AgentPanel.tsx` (new `AlternativesCard` + render next to `<PlanApprovalCard>` at line ~2295)
- Test: `tests/unit/alternatives-parked-event.test.ts`

**Interfaces:**
- Event: `{ type: 'agent:alternatives_parked'; page: string; pageId?: string; sections: string[]; alternatives: Array<{ id: string; label: string; score: number; thumbnail?: string }>; toolCallId?: string }`.
- Store: `ChatTurn.alternatives?: { page: string; pageId?: string; alternatives: Array<{ id; label; score; thumbnail? }>; status: 'idle' | 'promoting' | 'promoted' }`. **Persistence contract:** `planProposal` lives only in the live turns buffer (verified: `Message` in sessions/types.ts:163-196 has no planProposal; `_syncTurnsFromSession` at store.ts:2856-2899 doesn't restore it), but the alternatives card MUST survive reload and session switches (spec §4.3: "the card persists in the transcript") — add `alternatives?` to `Message` (same extras pattern as `patchOps`), write it from the `_onSync` case via a new session-store method `attachAlternatives(messageId, alternatives)` (the `appendAssistantText` mirroring pattern at store.ts:814-818), and restore it in `_syncTurnsFromSession`. Test: a rebuilt transcript (switch away + back) still carries the card.
- **Promotion goes through a store action, never a component socket emit** (the `restoreSnapshot` pattern, store.ts:2786-2854 — components can't emit `document:restore` directly; busy guards + session sync live in the action). New action `promoteAlternative(sectionId)`: refuses while `agentBusy` (toast via `toastBusyStructure`), POSTs `/api/documents/${documentId}/variants/promote`, on ok sets `document` + emits `socket.emit('client', { type: 'document:restore', documentId, document } satisfies ClientEvent)` (exact shape from restoreSnapshot, store.ts:2822-2828), and updates the turn's `alternatives.status`. 409 → `toast.warning('A design run is active', …)`.
- Journaling: add `'agent:alternatives_parked'` to `JOURNALED_AGENT_EVENT_TYPES` (event-journal.ts:34-69) — journal-catchup's `replayRow` auto-dispatches journaled `agent:`-prefixed rows (journal-catchup.ts:225-236), so a reconnecting client replays the card with no extra plumbing.
- Card: `AlternativesCard({ alternatives })` — thumbnail (or gray placeholder), label, score, "Use this" per row + one "View on canvas" button that calls `sendPatch({ op: 'set_active_page', pageId, summary: 'Viewing parked designs' })` (the LayersPanel page-switch pattern, LayersPanel.tsx:1061). Promote handler calls `useCanvasStore.getState().promoteAlternative(alt.id)`. Markup matches PlanApprovalCard's token classes (`rounded-md border ac-border-subtle ac-surface-1`, `ac-text-1/2/3`, sonner toasts).

- [ ] **Step 1: Write the failing test** — store-level: dispatch a synthetic `agent:alternatives_parked` event through the store's `_onSync` (follow the pattern in existing store tests for `agent:plan_proposed`, grep `tests/unit` for `plan_proposed` to find the harness); assert the last assistant turn gains `alternatives` with sanitized fields; a second identical event is idempotent by `toolCallId`. Plus a persistence test: after `_syncTurnsFromSession` rebuild, the card state survives (session-store round-trip).
- [ ] **Step 2: Run to verify it fails** — `bunx vitest run tests/unit/alternatives-parked-event.test.ts` → FAIL.
- [ ] **Step 3: Implement** — types + store case (sanitize: `safeText` labels, numeric scores, drop non-string thumbnails; attach to last assistant turn like `planProposal` + session-store `attachAlternatives` mirror) + `_syncTurnsFromSession` restore + `promoteAlternative` store action (restoreSnapshot pattern) + route forwarding case (copy the `agent:plan_proposed` forwarding branch verbatim, change the kind) + `JOURNALED_AGENT_EVENT_TYPES` addition + `AlternativesCard` in AgentPanel.tsx (render at ~2295; disable buttons while `status === 'promoting'`; 409 → "a design run is active" toast).
- [ ] **Step 4: Verify** — `bunx vitest run tests/unit/alternatives-parked-event.test.ts && bunx tsc --noEmit && bun run test`.
- [ ] **Step 5: Commit**

```bash
git add src/lib/canvas/types.ts src/lib/canvas/store.ts src/app/api/agent/route.ts src/components/canvas/AgentPanel.tsx tests/unit/alternatives-parked-event.test.ts
git commit -m "feat(ui): alternatives-parked event + promote card with Use-this action"
```

---

### Task 6: Promote route + `variant_promote` journal row + fold case (spec §4.3)

**Files:**
- Create: `src/lib/canvas/variant-promote.ts` (PURE swap)
- Create: `src/app/api/documents/[id]/variants/promote/route.ts`
- Modify: `src/lib/canvas/journal-fold.ts` (fold case inside `foldTail`'s else-if chain, after `document_restore`, lines ~220-276)
- Test: `tests/unit/variant-promote.test.ts`

**Interfaces:**
- Produces: `swapVariantWithMain(doc: CanvasDocument, sectionId: string): { document: CanvasDocument; payload: VariantPromotePayload } | null` where `VariantPromotePayload = { parkedSectionIds: string[]; promotedRootId: string; previousMainSectionId: string; previousMainTree: unknown }`. Route: `POST /api/documents/[id]/variants/promote` body `{ sectionId }` → 409 when a run is active, 404 when the section isn't parked, else `{ ok: true, document }`. Fold: `row.type === 'variant_promote'` replays the payload into the document.

- [ ] **Step 1: Write the failing test** — three tests: (a) pure swap moves the parked variant to the main page root and wraps the previous main design as a labeled section appended to Explorations; (b) `hydrateDocumentFromJournal` on a temp SQLite journal containing a `variant_promote` row reproduces the swapped document (follow the existing user-patch-journal/journal-fold temp-SQLite test pattern — raw `CREATE TABLE` + `process.env.DATABASE_URL` at module scope); (c) route returns 409 with a registered active run and 404 with an unknown sectionId (mock `@/lib/canvas/run-registry` the way route tests mock statically-imported deps — see the TEST-STRATEGY WARNING in `src/lib/canvas/AGENTS.md`).
- [ ] **Step 2: Run to verify it fails** — `bunx vitest run tests/unit/variant-promote.test.ts` → FAIL.
- [ ] **Step 3: Implement the pure swap** — find the parked section (Explorations page, by section id); extract its single child (the variant root); position it where the CURRENT main design's root sat (first root of the active page: copy its x/y); active page children = `[variantRoot]`; Explorations children = remaining parked sections + `{ type:'section', name:'Previous — applied design', children: [oldMainRoot] }`; return the payload for the journal row.
- [ ] **Step 4: Implement the route** — `POST`: read `params.id`; `getActiveRun(documentId) !== null` → 409 "a design run is active" (the read-only check ALREADY EXISTS — run-registry.ts:90-92; do NOT claim the run slot); `const fold = await hydrateDocumentFromJournal(documentId)` (returns `FoldHydration { document, tombstones, baseSeq, foldedThroughSeq, … }`, journal-fold.ts:78-87 — use `fold.document`); `swapVariantWithMain`; `appendSyntheticJournalEvent(documentId, 'variant_promote', undefined, payload)` (event-journal.ts:226 — signature is `(documentId, type, toolCallId, payload)`); return `{ ok: true, document }`. Body validation mirrors the plans route (string checks, 400s). **Schema: verified** — `AgentEvent.type` is a plain String column (prisma/schema.prisma:137); no migration. **Double-journal note:** the client's subsequent `document:restore` emission journals its own `document_restore` row AFTER the `variant_promote` row; the fold replays both — the swap case must be idempotent (restore lands last carrying the identical final state). `variant_promote` rows are auto-skipped by catch-up replay (journal-catchup.ts:225-236 only dispatches `agent:`-prefixed rows) — no catch-up change needed.
- [ ] **Step 5: Implement the fold case** — in journal-fold.ts's `foldTail` loop, add an `else if (row.type === 'variant_promote')` branch after the `document_restore` branch: load the payload, apply it via `applyVariantPromotePayload(doc, payload)` imported from variant-promote.ts (shared with the route so fold and route can't drift), and ADD the removed ids (parked section + previous main root subtree) to the `tombstones` set (mirroring `trackPatchTombstones` semantics; the following `document_restore` row, when present, clears them — both orders stay correct).
- [ ] **Step 6: Verify + commit**

`bunx vitest run tests/unit/variant-promote.test.ts && bunx tsc --noEmit && bun run test`
```bash
git add src/lib/canvas/variant-promote.ts src/app/api/documents src/lib/canvas/journal-fold.ts tests/unit/variant-promote.test.ts
git commit -m "feat(promote): variant swap route + durable variant_promote journal row"
```

---

### Task 7: `shouldOfferStagedFlow` detection (spec §3.1)

**Files:**
- Modify: `src/lib/agent/prompt-intent.ts`
- Test: `tests/unit/staged-flow-detection.test.ts`

**Interfaces:**
- Produces: `shouldOfferStagedFlow(input: { prompt: string; canvasEmpty: boolean; mode: AgentMode; repeatCount?: number; variantDispatchPlanned: boolean }): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/staged-flow-detection.test.ts
import { describe, it, expect } from 'vitest';
import { shouldOfferStagedFlow } from '@/lib/agent/prompt-intent';

const base = { canvasEmpty: true, mode: 'build' as const, repeatCount: 0, variantDispatchPlanned: false };

describe('shouldOfferStagedFlow', () => {
  it.each([
    ['build me a SaaS dashboard', true],
    ['a login screen for the vaultly app', true],
    ['design a settings page', true],
  ])('fires on screen-scale creation: %s', (prompt, expected) => {
    expect(shouldOfferStagedFlow({ ...base, prompt })).toBe(expected);
  });

  it.each([
    ['make it blue and bigger'],          // edit-reference anaphora
    ['change the button color'],          // edit-shaped
    ['build me a dashboard and a login screen'],  // multi-screen → multitask path
    ['just build it directly, no questions'],     // explicit opt-out
    ['a pricing card'],                   // small artifact, not screen-scale
  ])('does not fire: %s', (prompt) => {
    expect(shouldOfferStagedFlow({ ...base, prompt })).toBe(false);
  });

  it('does not fire on non-empty canvases without explicit new-screen intent', () => {
    expect(shouldOfferStagedFlow({ ...base, canvasEmpty: false, prompt: 'build me a dashboard' })).toBe(false);
    expect(shouldOfferStagedFlow({ ...base, canvasEmpty: false, prompt: 'add a new dashboard screen' })).toBe(true);
  });

  it('does not fire in ask/plan mode, on repeat prompts, or when variants are planned', () => {
    expect(shouldOfferStagedFlow({ ...base, mode: 'plan', prompt: 'build a dashboard' })).toBe(false);
    expect(shouldOfferStagedFlow({ ...base, repeatCount: 2, prompt: 'build a dashboard' })).toBe(false);
    expect(shouldOfferStagedFlow({ ...base, variantDispatchPlanned: true, prompt: 'a pricing page' })).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `bunx vitest run tests/unit/staged-flow-detection.test.ts` → FAIL.
- [ ] **Step 3: Implement** — pure predicate in prompt-intent.ts. Reuse `CONCRETE_ARTIFACT` for the screen-scale gate: fire only when the prompt matches a SCREEN_SCALE regex (`/\b(dashboard|landing|screen|page|home|settings|profile|onboarding|checkout|login|sign-?in|inbox|pricing)\b/i` PLUS a multi-section signal — either ≥2 distinct CONCRETE_ARTIFACT matches or an IA word (`sidebar|topbar|nav|table|chart|hero|grid|cards`)). Opt-out regex: `/\b(don'?t ask|no questions|directly|straight to (hi-?fi|design)|just build|skip the wireframe)\b/i`. Multi-screen: reuse `detectMultitaskPrompt(prompt).heuristic` from modes.ts (import is fine — modes.ts is import-pure) → exclusion. All other conditions are the input flags.
- [ ] **Step 4: Verify + commit**

`bunx vitest run tests/unit/staged-flow-detection.test.ts && bunx tsc --noEmit`
```bash
git add src/lib/agent/prompt-intent.ts tests/unit/staged-flow-detection.test.ts
git commit -m "feat(intent): screen-scale staged-flow detection helper"
```

---

### Task 8: `submit_layout_approval` gate tool + lo-fi allowlist (spec §3.3)

**Files:**
- Create: `src/lib/agent/layout-gate.ts`
- Modify: `src/lib/agent/plan-gate.ts` (`kind?: 'plan' | 'layout'` on `PlanProposalInput` + both emit sites)
- Test: `tests/unit/layout-gate.test.ts`

**Interfaces:**
- Produces: `SUBMIT_LAYOUT_APPROVAL_TOOL_NAME = 'submit_layout_approval'`; `submitLayoutApprovalTool` (defineTool, same shape as `submitPlanTool` — parameters: `title`, `summary`, `steps[]` (the layout sections, 1-12), `openQuestions?`); `LOFI_EXCLUDED_TOOL_NAMES: ReadonlySet<string>` (pen_apply_design_system, pen_apply_typography, pen_apply_palette, pen_set_variable, pen_set_variable_modes, pen_set_shadow, pen_set_gradient, pen_set_blur, pen_bulk_update_by_filter, pen_find_replace, pen_bake_layout); `lofiToolNames(): string[]` = `getToolNamesForCategory('wireframe')` minus LOFI set, plus `ask_user_question` + `submit_layout_approval`. Plan-gate: `PlanProposalInput.kind?: 'plan' | 'layout'`; `agent:plan_proposed` payload carries `kind` (additive; store default 'plan').

- [ ] **Step 1: Write the failing test** — mirror `tests/unit/modes-2026-08-30.test.ts` patterns: (a) `submitLayoutApprovalTool` registered only via runner source invariant (string assert on runner-native.ts containing `submitLayoutApprovalTool`); (b) gate behavior: call the tool's execute with a stubbed `submitPlanProposal` (vi.mock `./plan-gate`) asserting 'revise' returns the feedback text and 'build' records the approved layout; (c) `lofiToolNames()` excludes every name in LOFI_EXCLUDED and includes `pen_generate_wireframe` + `ask_user_question` + `submit_layout_approval`.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — `layout-gate.ts` mirrors plan-tools.ts verbatim in structure (tool description: "Submit your completed LO-FI LAYOUT for approval (staged design flow only). The user sees a Layout approval card: 'Apply hi-fi' upgrades the approved skeleton to the finished design; 'Revise layout' returns their feedback. Call it ONCE the gray-box layout is on the canvas and structurally complete — sections, hierarchy, placement — with NO palette/typography applied."). The tool's 'build' branch calls `recordApprovedPlan({...proposal, kind: 'layout'})` (the shared approved-slot is fine — the runner discriminates by `kind`). Heartbeat + wording copied from plan-tools.ts with PLAN→LAYOUT substitutions.
- [ ] **Step 4: Verify + commit**

`bunx vitest run tests/unit/layout-gate.test.ts && bunx tsc --noEmit && bun run test`
```bash
git add src/lib/agent/layout-gate.ts src/lib/agent/plan-gate.ts tests/unit/layout-gate.test.ts
git commit -m "feat(gate): submit_layout_approval tool + lo-fi toolset allowlist"
```

---

### Task 9: Runner staged-flow wiring (spec §3.2–3.5)

**Files:**
- Modify: `src/lib/agent/runner-native.ts`
- Modify: `src/lib/agent/modes.ts` (add `stagedFlowSection(kind)` message-section helper next to `modeSectionFor`)
- Test: `tests/unit/staged-flow-runner.test.ts`

**Interfaces:**
- Consumes: Task 7 detection, Task 8 gate/allowlist, existing approved-plan execution block (runner-native.ts ~2531-2611).
- Produces: build-mode run with `stagedFlow: 'lofi' | 'direct'` resolved at run start; `agent:plan_proposed` events carry `kind:'layout'` during the lo-fi phase; after drain, a `kind:'layout'` approval spawns the hi-fi execution session.

- [ ] **Step 1: Write the failing test** — source-invariant tests (the modes-2026-08-30 pattern asserts on runner-native.ts source text, since the native loop needs a live SDK): assert the source contains (a) the `shouldOfferStagedFlow` call, (b) `lofiToolNames()` in the toolset assembly, (c) the layout-kind branch calling `consumeApprovedPlan`, (d) the hi-fi instruction string "Apply the hi-fi pass to this approved structure". Plus a unit test for `stagedFlowSection('lofi')` text (mentions ask_user_question + the two options).
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** —

  a. **Detection** (after the variant-dispatch decision exists, before the brief race at ~756): `const stagedFlow = shouldOfferStagedFlow({ prompt, canvasEmpty: normalizedCanvas-is-empty, mode, repeatCount, variantDispatchPlanned }) ? 'lofi' : 'direct'`.
  b. **Directive injection**: when `'lofi'`, append `stagedFlowSection('lofi')` in the first-user-message assembly (runner-native.ts:1699-1727 — insertion order: slot it next to `variantNudge`, i.e. `... + briefSection + variantNudge + stagedSection + conversationHistorySection + ...`). The section instructs the agent to FIRST call `ask_user_question` with exactly two options ("Lo-fi layout first (recommended)" / "Straight to hi-fi"), and — only after a lo-fi choice — build the gray-box skeleton and call `submit_layout_approval`; if the user picks hi-fi, proceed as a normal build turn.
  b2. **ask_user_question availability guard (verified surface gap):** `isOneShotBuildTurn = mode === 'build' && turnStartShapeIds.size === 0` (runner-native.ts:605) is TRUE on staged turns (build mode + empty canvas is exactly the staged trigger), so `ONE_SHOT_DROP_TOOLS` (line 600, which includes `ask_user_question`) WOULD strip the ask's vehicle. Change the slimming gate (line 623-625) to `isOneShotBuildTurn && stagedFlow !== 'lofi'`, and keep `ask_user_question` in the lo-fi allowlist unconditionally. Directive fallback line: "if ask_user_question is somehow unavailable, ask the question in plain text and end your turn; do not generate before the user replies."
  c. **Lo-fi toolset**: build `stagedLoFiTools` AFTER `turnTools` (~628) and BEFORE `buildToolsForPlanMode` (~633) — same filtering shape as `buildToolsForPlanMode` (runner-native.ts:633-643: intersect `allTools` against `lofiToolNames()` minus aliases), then wrap with `planCompletionBlocker` (the blocker + its application point are at runner-native.ts:1124-1148 and 1156-1158; apply it to the staged tools exactly like the plan-mode branch). `ask_user_question` rides `pluginToolNames` (always included at line ~554-561) — the b2 guard keeps it through the one-shot filter.
  d. **Execution session**: the approved-plan consumption gate at runner-native.ts:2537 (`const approvedPlan = mode === 'plan' && !wasAborted() && !lastPromptError ? consumeApprovedPlan(runStartedAt) : null`) extends to `... || stagedFlow === 'lofi'`. The gate's `kind` discriminates the message: for `kind === 'layout'`, reuse the SAME second-session flow (identical `createAgentSession` options at 2562-2576 and drain loop at 2614-2661 — `execOrderedTools` is already the full build toolset, NOT wrapped by the blocker) with the first message (2597-2609 pattern): "APPROVED LAYOUT — ..." + summary/steps + the instruction: "Apply the hi-fi pass to this approved structure. Do not change the information architecture, layout skeleton, or section ordering — upgrade fidelity only (palette, typography, spacing, shadows, real content, components)." The lo-fi phase's `canvasSnapshot` section rides the exec message unchanged, so the builder sees the approved skeleton on the canvas.
  e. **Revise**: no runner change needed — the gate returns feedback into the lo-fi session (same as submit_plan revise). **Event flow**: the gate tool's `emitEvent` calls reach the stream via the existing sink (runner-native.ts:2039-2041) — no new wiring.

- [ ] **Step 4: Verify + commit**

`bunx vitest run tests/unit/staged-flow-runner.test.ts && bunx tsc --noEmit && bun run test`
```bash
git add src/lib/agent/runner-native.ts src/lib/agent/modes.ts tests/unit/staged-flow-runner.test.ts
git commit -m "feat(runner): staged lo-fi → approval → hi-fi flow on screen-scale creation"
```

---

### Task 10: PlanApprovalCard layout kind + plans route acceptance (spec §3.4)

**Files:**
- Modify: `src/lib/canvas/types.ts` (`agent:plan_proposed` payload: optional `kind?: 'plan' | 'layout'`)
- Modify: `src/lib/canvas/store.ts` (`planProposal` gains `kind`, default 'plan'; ~line 3454)
- Modify: `src/components/canvas/AgentPanel.tsx` (`PlanApprovalCard` at line 627: when `kind === 'layout'` render the header "Layout approval" and buttons "Apply hi-fi" / "Revise layout"; same POST to `/api/agent/plans`)
- Test: extend `tests/unit/alternatives-parked-event.test.ts` (or a new `tests/unit/layout-approval-card.test.ts`) — store test asserting `kind` round-trips and defaults to 'plan'.

- [ ] **Step 1: Write failing store test → Step 2: verify FAIL → Step 3: implement (payload passthrough + UI label/button text) → Step 4: `bunx vitest run ... && bun run test` green → Step 5: Commit**

```bash
git add src/lib/canvas/types.ts src/lib/canvas/store.ts src/components/canvas/AgentPanel.tsx tests/unit
git commit -m "feat(ui): layout-approval flavor of the plan approval card"
```

---

### Task 11: Eval scenario, verification sweep, DOX pass (spec §6–§8)

**Files:**
- Modify: `scripts/agent-eval/` (add `staged-dashboard` scenario mirroring `dashboard-hifi` — assert the turn produces an `agent:plan_proposed` with `kind:'layout'` before any styling-tool call, and completes after approval)
- Modify (DOX): `src/lib/agent/AGENTS.md`, `src/lib/agent/subagents/AGENTS.md`, `src/lib/canvas/AGENTS.md`, `src/components/canvas/AGENTS.md`, `src/app/api/AGENTS.md`, `docs/AGENTS.md` (spec row), spec status → Implemented
- Test: full suite + eval

- [ ] **Step 1: Run the full verification sweep** — `bunx tsc --noEmit && bun run lint && bun run test && bun run scripts/eval-agent.ts` (classifier gate ≥80% — the new helper is not classifier-routed, must stay 95%) `&& bun run scripts/measure-tool-cost.ts` (registry budget ~43k chars — `submit_layout_approval` must keep it there).
- [ ] **Step 2: Agent-eval** — `bun scripts/agent-eval/run-eval.ts` with the new scenario (requires the configured LLM endpoint; if the BETA endpoint is rate-limited, record the attempt and run the MockLLM-trajectory unit coverage instead — never curl the endpoint directly per the LLM Endpoint Access Policy).
- [ ] **Step 3: Manual visual pass** — dev server + browser: staged ask → lo-fi → revise → approve → hi-fi; variant run → card → promote → swap back (the visual-test.sh pattern). **Plus two surface verifications (both pre-verified by code audit — confirm visually):** (a) the LayersPanel pages column (LayersPanel.tsx:1023-1122) lists the Explorations page, switches via `set_active_page`, and parked `section` nodes render with their dashed-border + label-chip treatment (styleFor.ts:368-372, resolve.ts:1527); (b) parking patches appear as readable diff chips using their `patch.summary` text (turn-diff.ts `CREATE_OPS` includes `add_subtree`), and `pen_export_pen` includes the Explorations page with parked sections (acceptable, note in the canvas DOX — no code change).
- [ ] **Step 4: DOX pass** — per the spec §7 list: agent/AGENTS.md (staged flow section under Local Contracts + tool counts 104→105), subagents/AGENTS.md (parking), canvas/AGENTS.md (page-target patch op, variant_promote fold row, alternatives_parked SyncEvent, document the restore-path reuse for promote broadcast), components/canvas/AGENTS.md (AlternativesCard + card kind), api/AGENTS.md (promote route), docs/AGENTS.md unchanged unless scope rows shift; spec front-matter Status → Implemented.
- [ ] **Step 5: Commit**

```bash
git add scripts/agent-eval docs src src/lib src/components src/app
git commit -m "feat(eval)+docs: staged-flow eval scenario and DOX pass for designer-workflow-parity"
```

---

## Self-Review Notes

- **Spec coverage:** §3.1→Task 7, §3.2–3.3→Tasks 8–9, §3.4→Tasks 8–10, §3.5→Task 9; §4.1→Tasks 3–4, §4.2→Task 4, §4.3→Tasks 5–6; §5.1→Task 2, §5.2→Task 1; §6 invariants→Tasks 1–10 guards; §7→Task 11; §8 table distributed per task. No gaps.
- **Deliberate deviations from spec wording (record in Task 11 DOX):** (1) unknown pageName auto-creates instead of applier hard-error — the applier is null-safe by contract; the hard error lives in the tool layer which pre-creates the page. (2) Promote broadcast reuses the client-driven `document:restore` path (emitted by the new `promoteAlternative` store action — components never emit socket events directly) instead of a new broadcast reason; that path journals its own `document_restore` row, so the `variant_promote` row is the semantic audit record and the fold case must be idempotent against it. (3) `variant_promote` persists as a journal ROW (fold replays it), satisfying the spec's durability requirement.
- **Type consistency:** `PlanProposalInput.kind` used by Tasks 8/9/10; `parked[].id` (Task 4) is the `sectionId` the card (Task 5) POSTs and the route (Task 6) resolves; `lofiToolNames()` defined Task 8, consumed Task 9; `pageId` rides the parking event (Task 4) into the card's "View on canvas" action (Task 5).
- **Deep-dive verification (2026-09-12, four parallel Explore agents):** all integration anchors in Tasks 5/6/9 were traced against the actual code — session mirroring (`appendAssistantText` pattern, `Message` type, `_syncTurnsFromSession`), tool assembly order + one-shot slimming trigger + approved-plan second-session flow + event-bus sink, journal schema/catch-up filters/fold chain/run-registry reads, and the UI render sites/pages column/reveal/diff-chip/section-rendering facts. Two plan assumptions were corrected by the audit: the one-shot slimming WOULD have stripped `ask_user_question` on staged turns (now guarded), and `getActiveRun` already exists (no run-registry change).
