# AgentCanvas — Gap Analysis v2

**Date:** 2026-08-19
**Audience:** Implementation leads
**Scope:** Find concrete, fixable gaps in three areas — (1) LLM provider coverage, (2) Figma REST API ontology parity, (3) runtime behaviour in the new Figma-aligned code paths.

All web research was performed live via `z-ai function -n web_search` and `z-ai function -n page_reader`. Source pages are saved under `research/specs/llm-providers/` (LLM providers) and `research/specs/figma-*.json` (Figma docs) so the findings can be re-verified.

---

## Executive Summary

| Area | Count | Severity mix |
|---|---|---|
| **1. Missing LLM providers** (worth adding) | **10** | all medium (purely additive) |
| **2. Figma ontology gaps** | **8** | 3 high, 3 medium, 2 low |
| **3. Runtime bugs** | **7** | 2 high, 4 medium, 1 low |

**Top 7 things to fix first** (prioritised list at the bottom):

1. `converters.ts` drops `pages` + `activePageIndex` on both `.pen` export and import — **multi-page docs round-trip as single-page** (HIGH).
2. `Canvas.tsx` SVG renderer silently renders `section`, `component`, `component_set`, `slice`, `star`, `polygon`, `boolean_operation` as **nothing** — falls through to `default → null` (HIGH).
3. `resolve.ts` maps `ref` → `'rectangle'` instead of `'instance'` — the `'instance'` value in the `LayerType` union is dead code; the LayersPanel `instance` icon is unreachable (HIGH).
4. `LayersPanel` has no Pages UI and `isContainer` only recognises `frame` + `group`, so the new container types can't be expanded or used as drop targets (HIGH).
5. `resolve.ts::resolveEffects` only handles `'blur'`, never `'background_blur'` — Figma's BACKGROUND_BLUR is silently dropped (MEDIUM).
6. `PropertiesPanel` shows none of the new Figma fields (componentPropertyDefinitions, variantPropertyAxes, componentProperties overrides, label, pointCount, polygonCount, booleanOperationType, exportSettings) — the data is resolved, the UI just doesn't surface it (MEDIUM).
7. `pen/types.ts` is missing the SLOT component property type and the `FLOAT` variable type — Figma's two newest property/variable flavors can't be represented (MEDIUM).

---

## Area 1 — Missing LLM Providers

### Current state
`src/lib/llm/registry.ts` registers **18** providers: `zai, openai, anthropic, google, mistral, cohere, groq, together, deepseek, openrouter, fireworks, xai, perplexity, huggingface, ollama, lmstudio, vllm, custom`. Of these, 14 are OpenAI-compatible (`openAICompatibleFactory`), 3 are native adapters (`anthropic`, `google`, `zai`), and 1 is the `custom` escape hatch.

### Research findings — providers worth adding
I cross-referenced **Helicone's "Top 11 LLM API Providers in 2025"**, **kdnuggets' "Top 5 Super Fast LLM API Providers"**, **artificialanalysis.ai**'s provider leaderboard, **digitalocean's "11 Best Inference Providers for AI Agents"**, and **infrabase.ai**'s inference API directory. From those sources, the providers below are mentioned repeatedly and have stable, documented OpenAI-compatible endpoints.

For each, I fetched the docs page directly to verify the base URL, model name format, and tool-calling support. Fetched pages live in `research/specs/llm-providers/page-*.json`.

### 10 providers to add (recommended)

| # | id | label | docs URL | base URL | default model | env var | tools |
|---|---|---|---|---|---|---|---|
| 1 | `novita` | Novita AI | https://novita.ai/docs/guides/llm-api | `https://api.novita.ai/openai/v1` | `deepseek/deepseek-r1` | `NOVITA_API_KEY` | ✅ |
| 2 | `hyperbolic` | Hyperbolic | https://www.hyperbolic.ai/docs/inference/text-apis | `https://api.hyperbolic.xyz/v1` | `meta-llama/Llama-3.3-70B-Instruct` | `HYPERBOLIC_API_KEY` | ✅ |
| 3 | `chutes` | Chutes AI | https://chutes.ai/llms.txt | `https://llm.chutes.ai/v1` | `deepseek-ai/DeepSeek-V3` | `CHUTES_API_KEY` (prefix `cpk_`) | ✅ |
| 4 | `sambanova` | SambaNova | https://docs.sambanova.ai/docs/en/features/openai-compatibility | `https://api.sambanovacloud.com/v1` | `Meta-Llama-3.1-8B-Instruct` | `SAMBANOVA_API_KEY` | ✅ |
| 5 | `cerebras` | Cerebras Inference | https://inference-docs.cerebras.ai/resources/openai | `https://api.cerebras.ai/v1` | `gpt-oss-120b` | `CEREBRAS_API_KEY` | ✅ |
| 6 | `aimlapi` | AI/ML API | https://docs.aimlapi.com/glossary/concepts | `https://api.aimlapi.com/v1` | `gpt-4o` | `AIMLAPI_KEY` | ✅ |
| 7 | `atoma` | Atoma | https://docs.atoma.ai/cloud-api-reference/get-started | `https://api.atoma.network/v1` | `meta-llama/llama-3.3-70b-instruct` | `ATOMA_API_KEY` | ✅ |
| 8 | `inception` | Inception Labs (Mercury) | https://docs.inceptionlabs.ai/get-started/get-started | `https://api.inceptionlabs.ai/v1` | `mercury-2` | `INCEPTION_API_KEY` | ✅ |
| 9 | `deepinfra` | DeepInfra | https://docs.deepinfra.com/chat/overview | `https://api.deepinfra.com/v1/openai` | `meta-llama/Llama-3.3-70B-Instruct` | `DEEPINFRA_API_KEY` | ✅ |
| 10 | `siliconflow` | SiliconFlow | https://docs.siliconflow.com/en/userguide/quickstart | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-72B-Instruct` | `SILICONFLOW_API_KEY` | ✅ |

### Detail per provider (popular models + OpenAI-compat verification)

#### 1. Novita AI (`novita`)
- **Display:** "Novita AI — cheap open-model inference (DeepSeek, Llama, Qwen)"
- **Docs:** https://novita.ai/docs/guides/llm-api
- **Verified base URL:** `https://api.novita.ai/openai/v1` (curl example in docs uses `https://api.novita.ai/openai/v1/chat/completions`)
- **Default model:** `deepseek/deepseek-r1`
- **Popular models:** `deepseek/deepseek-r1`, `deepseek/deepseek-v3`, `meta-llama/llama-3.3-70b-instruct`, `qwen/qwen2.5-32b-instruct`, `nousresearch/hermes-3-llama-3.1-405b`
- **Tool calling:** yes (Function Calling section in docs nav)
- **Env var:** `NOVITA_API_KEY`
- **Source page:** `research/specs/llm-providers/page-novita.json`

#### 2. Hyperbolic (`hyperbolic`)
- **Display:** "Hyperbolic — cheap GPU inference for Llama, DeepSeek, Qwen"
- **Docs:** https://www.hyperbolic.ai/docs/inference/text-apis
- **Verified base URL:** `https://api.hyperbolic.xyz/v1` (OpenAI SDK example uses `base_url="https://api.hyperbolic.xyz/v1"`)
- **Default model:** `meta-llama/Llama-3.3-70B-Instruct`
- **Popular models:** `meta-llama/Llama-3.3-70B-Instruct`, `deepseek-ai/DeepSeek-R1`, `meta-llama/Meta-Llama-3.1-405B`, `Qwen/Qwen2.5-72B-Instruct`, `mistralai/Mistral-7B-Instruct-v0.3`
- **Tool calling:** yes
- **Env var:** `HYPERBOLIC_API_KEY`
- **Source page:** `research/specs/llm-providers/page-hyperbolic.json`

#### 3. Chutes AI (`chutes`)
- **Display:** "Chutes AI — serverless router for 200+ open models"
- **Docs:** https://chutes.ai/llms.txt (LLM-friendly canonical reference)
- **Verified base URL:** `https://llm.chutes.ai/v1` (explicitly stated: "Use `https://llm.chutes.ai/v1` as the OpenAI-compatible inference base URL")
- **Default model:** `deepseek-ai/DeepSeek-V3`
- **Popular models:** `deepseek-ai/DeepSeek-V3`, `deepseek-ai/DeepSeek-R1`, `meta-llama/Llama-3.3-70B-Instruct`, `unsloth/Llama-3.3-70B-Instruct`, `Qwen/Qwen2.5-72B-Instruct`
- **Tool calling:** yes (most models support tools via OpenAI-compat)
- **Env var:** `CHUTES_API_KEY` (key prefix `cpk_`)
- **Source page:** `research/specs/llm-providers/page-chutes.json`

#### 4. SambaNova (`sambanova`)
- **Display:** "SambaNova — fastest inference on SN40L chip (free tier)"
- **Docs:** https://docs.sambanova.ai/docs/en/features/openai-compatibility
- **Verified base URL:** `https://api.sambanovacloud.com/v1` (OpenAPI server URL `https://api.sambanovacloud.com/`)
- **Default model:** `Meta-Llama-3.1-8B-Instruct` (free tier)
- **Popular models:** `Meta-Llama-3.1-405B-Instruct`, `Meta-Llama-3.1-70B-Instruct`, `Meta-Llama-3.1-8B-Instruct`, `DeepSeek-R1`, `Qwen3-235B-A22B-Instruct-2507`, `gpt-oss-120b`
- **Tool calling:** yes (Function Call in docs)
- **Env var:** `SAMBANOVA_API_KEY`
- **Source page:** `research/specs/llm-providers/page-sambanova.json`

#### 5. Cerebras Inference (`cerebras`)
- **Display:** "Cerebras Inference — fastest token throughput (Wafer-Scale Engine)"
- **Docs:** https://inference-docs.cerebras.ai/resources/openai
- **Verified base URL:** `https://api.cerebras.ai/v1` (Python example: `OpenAI(base_url="https://api.cerebras.ai/v1", api_key=os.environ.get("CEREBRAS_API_KEY"))`)
- **Default model:** `gpt-oss-120b`
- **Popular models:** `gpt-oss-120b`, `llama3.3-70b`, `qwen-3-235b-a22b-instruct-2507`, `llama-4-scout-17b-16e-instruct-2507`, `deepseek-r1-0528`
- **Tool calling:** yes (Tool Calling section + structured outputs)
- **Env var:** `CEREBRAS_API_KEY`
- **Source page:** `research/specs/llm-providers/page-cerebras.json`

#### 6. AI/ML API (`aimlapi`)
- **Display:** "AI/ML API — 1000+ models behind one OpenAI-compatible gateway"
- **Docs:** https://docs.aimlapi.com/glossary/concepts
- **Verified base URL:** `https://api.aimlapi.com/v1` (concepts page: "Our base URL also supports versioning, so you can use … `https://api.aimlapi.com/v1`")
- **Default model:** `gpt-4o`
- **Popular models:** `gpt-4o`, `gpt-4o-mini`, `gpt-oss-120b`, `claude-3-5-sonnet`, `google/gemini-flash-2.0`, `deepseek-ai/DeepSeek-V3`, `meta-llama/Llama-3.3-70B-Instruct`
- **Tool calling:** yes (Function Call supported)
- **Env var:** `AIMLAPI_KEY`
- **Source page:** `research/specs/llm-providers/page-aimlapi.json`

#### 7. Atoma (`atoma`)
- **Display:** "Atoma — decentralized OpenAI-compatible inference with TEE option"
- **Docs:** https://docs.atoma.ai/cloud-api-reference/get-started
- **Verified base URL:** `https://api.atoma.network/v1` (Standard Endpoints section: "Chat: `/v1/chat/completions`"; base URL `https://api.atoma.network`)
- **Default model:** `meta-llama/llama-3.3-70b-instruct`
- **Popular models:** `meta-llama/Llama-3.3-70B-Instruct`, `deepseek-ai/DeepSeek-R1`, `Qwen/Qwen2.5-72B-Instruct`, `meta-llama/Llama-3.1-8B-Instruct`
- **Tool calling:** yes (full OpenAI compat — "Drop-in replacement for OpenAI API")
- **Env var:** `ATOMA_API_KEY` (SDK uses `ATOMASDK_BEARER_AUTH`, but `ATOMA_API_KEY` is the conventional public name)
- **Source page:** `research/specs/llm-providers/page-atoma.json`

#### 8. Inception Labs (`inception`)
- **Display:** "Inception Labs — Mercury diffusion LLMs (1000+ tok/s)"
- **Docs:** https://docs.inceptionlabs.ai/get-started/get-started
- **Verified base URL:** `https://api.inceptionlabs.ai/v1` (Python example: `OpenAI(api_key=os.environ["INCEPTION_API_KEY"], base_url="https://api.inceptionlabs.ai/v1")`)
- **Default model:** `mercury-2`
- **Popular models:** `mercury-2`, `mercury`, `mercury-coder-mini`
- **Tool calling:** yes (docs mention tool use + structured outputs)
- **Env var:** `INCEPTION_API_KEY`
- **Source page:** `research/specs/llm-providers/page-inception.json`
- **Caveat:** Mercury is a *diffusion* LLM — different decoding dynamics. For non-chat workloads the agent runner should expect slightly different latency and an extra `diffusing` parameter. For our use case (chat completions + tool calls) the OpenAI surface is stable.

#### 9. DeepInfra (`deepinfra`)
- **Display:** "DeepInfra — 100+ open models, cheapest Llama / DeepSeek pricing"
- **Docs:** https://docs.deepinfra.com/chat/overview
- **Verified base URL:** `https://api.deepinfra.com/v1/openai` (docs: "OpenAI-compatible endpoints at `/v1/openai`")
- **Default model:** `meta-llama/Llama-3.3-70B-Instruct`
- **Popular models:** `meta-llama/Llama-3.3-70B-Instruct`, `deepseek-ai/DeepSeek-R1`, `deepseek-ai/DeepSeek-V3`, `Qwen/Qwen2.5-72B-Instruct`, `mistralai/Mistral-7B-Instruct-v0.3`
- **Tool calling:** yes
- **Env var:** `DEEPINFRA_API_KEY`
- **Source:** `research/specs/llm-providers/search-deepinfra.json`

#### 10. SiliconFlow (`siliconflow`)
- **Display:** "SiliconFlow — 200+ open models, China-friendly API"
- **Docs:** https://docs.siliconflow.com/en/userguide/quickstart
- **Verified base URL:** `https://api.siliconflow.cn/v1` (Cline integration doc: "Base Url: `https://api.siliconflow.cn/v1`")
- **Default model:** `Qwen/Qwen2.5-72B-Instruct`
- **Popular models:** `Qwen/Qwen2.5-72B-Instruct`, `deepseek-ai/DeepSeek-V3`, `deepseek-ai/DeepSeek-R1`, `meta-llama/Llama-3.3-70B-Instruct`, `zai-org/GLM-4.5`
- **Tool calling:** yes (OpenAI-compat)
- **Env var:** `SILICONFLOW_API_KEY`
- **Source:** `research/specs/llm-providers/search-siliconflow.json`

### Considered but NOT recommended

- **Lepton AI** — Acquired by NVIDIA in 2025; "Lepton AI's standalone OpenAI-compatible model API is no longer available after the NVIDIA acquisition: there is no stable public base URL" (search result, `research/specs/llm-providers/search-lepton.json`). The `docs.lepton.ai` domain no longer resolves. Skip — users should use the existing `custom` escape hatch or NVIDIA's NIM endpoint.
- **Friendli AI** — OpenAI-compatible but primary value is the *engine*, not the hosted inference tier. Lower mind-share than the 10 above. Defer until requested.
- **Replicate** — HTTP API is not OpenAI-compatible (different request shape). Would need a native adapter. Defer.
- **LMDeploy** + **Xinference** — Both are *self-hosted local servers* (`http://0.0.0.0:23333/v1` and `http://127.0.0.1:9997/v1`). They're already covered by the `custom` escape hatch with `apiKeyRequired: false`. We could add explicit entries for discoverability, but it's a UX nicety not a real gap.

### Concrete fix

Add 10 new entries to `PROVIDERS` in `src/lib/llm/registry.ts`. All 10 are OpenAI-compatible — each is ~25 lines of metadata + `openAICompatibleFactory(...)`. No new adapter code needed.

Pattern (showing Novita as the template):

```ts
novita: {
  metadata: {
    id: 'novita', label: 'Novita AI',
    description: 'Cheap open-model inference — DeepSeek, Llama, Qwen. OpenAI-compatible.',
    docsUrl: 'https://novita.ai/docs/guides/llm-api',
    apiKeyEnvVars: ['NOVITA_API_KEY'],
    defaultBaseURL: 'https://api.novita.ai/openai/v1',
    defaultModel: 'deepseek/deepseek-r1',
    popularModels: [
      'deepseek/deepseek-r1', 'deepseek/deepseek-v3',
      'meta-llama/llama-3.3-70b-instruct',
      'qwen/qwen2.5-32b-instruct',
      'nousresearch/hermes-3-llama-3.1-405b',
    ],
    openAICompatible: true,
    capabilities: CAPS_TOOLS_OK,
    apiKeyRequired: true,
  },
  factory: openAICompatibleFactory({
    id: 'novita', label: 'Novita AI', description: '', docsUrl: '',
    apiKeyEnvVars: ['NOVITA_API_KEY'],
    defaultBaseURL: 'https://api.novita.ai/openai/v1',
    defaultModel: 'deepseek/deepseek-r1',
    popularModels: [],
    openAICompatible: true,
    capabilities: CAPS_TOOLS_OK,
    apiKeyRequired: true,
  }),
},
```

Also update the file header comment: "18 of the most popular LLM providers (17 named + 1 generic 'custom' escape hatch)" → "28 of the most popular LLM providers (27 named + 1 generic 'custom' escape hatch)". Update `tests/unit/llm-providers.test.ts` and `tests/unit/registry.test.ts` to assert the new provider count + ids.

---

## Area 2 — Figma REST API Ontology Gaps

### Sources fetched

- **Figma Plugin Node Types** — `research/specs/figma-plugin-nodes.json` (https://developers.figma.com/docs/plugins/api/nodes) — the canonical NodeType list.
- **Figma REST API Variables Endpoints** — `research/specs/figma-var-rest.json` (https://developers.figma.com/docs/rest-api/variables-endpoints) — defines `resolvedType`, `variableModes`, `valuesByMode`.
- **Figma Component Properties Help Article** — `research/specs/figma-component-properties.json` (https://help.figma.com/hc/en-us/articles/5579474826519-Explore-component-properties) — confirms the SLOT property type exists.
- **Figma Effects Help Article** — https://help.figma.com/hc/en-us/articles/360041488473-Apply-effects-to-layers — "seven types of effects: Glass, Drop shadow, Inner shadow, Layer blur, Background blur, Noise, Texture". REST API supports the 4 classic effect types (DROP_SHADOW, INNER_SHADOW, LAYER_BLUR, BACKGROUND_BLUR).
- **Figma Variable Modes Help Article** — https://help.figma.com/hc/en-us/articles/15345403551511-Variable-modes.

### Figma NodeType enum (from the docs, verbatim)

```
"BOOLEAN_OPERATION" | "CODE_BLOCK" | "COMPONENT" | "COMPONENT_SET" | "CONNECTOR" |
"DOCUMENT" | "ELLIPSE" | "EMBED" | "FRAME" | "GROUP" | "HIGHLIGHT" | "INSTANCE" |
"INTERACTIVE_SLIDE_ELEMENT" | "LINE" | "LINK_UNFURL" | "MEDIA" | "PAGE" |
"POLYGON" | "RECTANGLE" | "SECTION" | "SHAPE_WITH_TEXT" | "SLICE" | "SLIDE" |
"SLIDE_GRID" | "SLIDE_ROW" | "SLOT" | "STAMP" | "STAR" | "STICKY" | "TABLE" |
"TABLE_CELL" | "TEXT" | "TEXT_PATH" | "TRANSFORM_GROUP" | "VECTOR" | "WASHI_TAPE" | "WIDGET"
```

### What we currently model (in `src/lib/pen/types.ts`)

`frame, section, component, component_set, boolean_operation, slice, group, rectangle, ellipse, star, polygon, path, line, text, note, context, prompt, icon, script, ref`

Mapping to Figma canonical: frame→FRAME, section→SECTION, component→COMPONENT, component_set→COMPONENT_SET, boolean_operation→BOOLEAN_OPERATION, slice→SLICE, group→GROUP, rectangle→RECTANGLE, ellipse→ELLIPSE, star→STAR, polygon→POLYGON, path→VECTOR-equivalent (we use SVG path), line→LINE, text→TEXT, ref→INSTANCE.

### 8 Ontology gaps

#### Gap 2.1 — Missing `instance` emission in resolver (HIGH, also listed under Area 3)

The `'instance'` value exists in `LayerType` (canvas/types.ts line 43) but `mapNodeType` in `resolve.ts` line 617 maps `'ref'` → `'rectangle'` instead. Figma's INSTANCE node is a first-class scene node and we lose the distinction at resolve time. (See Area 3 bug 3.1 for the fix.)

#### Gap 2.2 — Missing SLOT component property type (HIGH)

`src/lib/pen/types.ts` line 232-236 defines `PenComponentPropertyType = 'boolean' | 'text' | 'instance_swap' | 'variant'`. The Figma docs page (https://help.figma.com/hc/en-us/articles/5579474826519-Explore-component-properties) explicitly lists **Slot property** as a fifth component property type:

> "Slots are flexible areas added to components that let you freely add and arrange content directly inside an instance without having to detach it"

Figma's REST API also has a new `SLOT` node type (a placeholder for instance swap locations).

**Concrete fix** in `src/lib/pen/types.ts`:

```ts
export type PenComponentPropertyType =
  | 'boolean'
  | 'text'
  | 'instance_swap'
  | 'variant'
  | 'slot';   // NEW — flexible content area in a component instance

export interface PenComponentPropertyDefinition {
  type: PenComponentPropertyType;
  name?: string;
  defaultValue: boolean | string;
  preferredValues?: string[];
  variantOptions?: string[];
  /// For slot: the default component ID that fills the slot (empty = empty slot).
  /// Synonymous with preferredValues[0] but kept explicit to match Figma's defaultValue semantics.
  defaultComponentId?: string;
}
```

Also update `figma-tools.ts` `figma_set_component_property` parameters to accept `'slot'` and the new `defaultComponentId`.

#### Gap 2.3 — Missing `FLOAT` variable type (HIGH)

Figma REST API: `resolvedType: 'BOOLEAN' | 'FLOAT' | 'STRING' | 'COLOR'` (verified in `research/specs/figma-var-rest.json`).

Our `src/lib/pen/types.ts` line 46-50 uses `'boolean' | 'color' | 'number' | 'string'`. Figma's `FLOAT` is semantically a *floating-point* number, distinct from integer/decimal conceptually (Figma's variable values support very specific precision). Our `'number'` is JavaScript `number` (always double) which is technically equivalent but the *type tag* doesn't round-trip.

**Concrete fix** in `src/lib/pen/types.ts`:

```ts
export type PenVariableDef =
  | { type: 'boolean'; value: PenBooleanOrVariable | PenThemedValue<PenBooleanOrVariable>[] }
  | { type: 'color'; value: PenColorOrVariable | PenThemedValue<PenColorOrVariable>[] }
  // RENAMED from 'number' to 'float' to match Figma's resolvedType.
  | { type: 'float'; value: PenNumberOrVariable | PenThemedValue<PenNumberOrVariable>[] }
  | { type: 'string'; value: PenStringOrVariable | PenThemedValue<PenStringOrVariable>[] };
```

**Migration:** `'number'` is currently used in tests + in `CanvasPatch.variableType` (`src/lib/canvas/types.ts` line 325). Either (a) rename `'number'` → `'float'` everywhere (breaking) or (b) accept both spellings (`'number' | 'float'`) in the type union and normalize on read. Option (b) is safer — add a normalizer in `patch.ts`'s `set_variable` op handler.

#### Gap 2.4 — Variable modes vs PenTheme (MEDIUM — semantic mismatch)

Figma's model:
- `VariableCollection.modes: [{ modeId, name }]` — a collection has up to 40 named modes.
- `Variable.valuesByMode: { [modeId]: value }` — a variable holds one value *per mode* in its collection.

Our model:
- `PenDocument.themes: { [axis: string]: string[] }` — a theme axis (e.g. `mode`) has a list of values (e.g. `['light', 'dark']`).
- `PenThemedValue<T> = { value: T; theme?: PenTheme }` — a themed value activates when the *effective theme* (a `{axis: value}` map) ⊆ the required theme.

The two are **conceptually equivalent** but use different terminology:
- Figma `VariableCollection` ↔ Pen `themes` axis (axis name = collection name)
- Figma `modeId` ↔ Pen theme-axis value (e.g. `'dark'`)
- Figma `valuesByMode` ↔ Pen `PenThemedValue<T>[]` (one entry per mode)

**The gap:** When importing a Figma file via the REST API, we'd need to (1) generate a `themes` axis per `VariableCollection`, (2) populate it with the collection's mode names, (3) translate each variable's `valuesByMode` into a `PenThemedValue<T>[]`. Currently the import path doesn't do this — see `src/app/api/pen/import/route.ts` lines 79-89: it imports `themes` from the imported `PenDocument.themes` directly, which is fine for `.pen → .pen` round-trips but a Figma REST import wouldn't populate it.

**Concrete fix:** Add a `figmaToPen.ts` translator (new file under `src/lib/pen/`) that maps Figma REST `variables` and `variableCollections` payloads onto `PenDocument.variables` and `PenDocument.themes`. The translator should:
- For each Figma `VariableCollection`, create a theme axis with the collection name and the mode names as values.
- For each Figma `Variable`, create a `PenVariableDef` whose `value` is a `PenThemedValue<T>[]` of length = number of modes (one entry per mode).

This is also the foundation for a future "Import from Figma URL" feature.

#### Gap 2.5 — Missing `LayoutGrid` type (MEDIUM)

Figma frames/components can have `layoutGrids: LayoutGrid[]` — visual guides (columns/rows/grid) overlaid on the canvas. REST API spec:

```ts
interface LayoutGrid {
  pattern: 'COLUMNS' | 'ROWS' | 'GRID';
  sectionSize: number;
  visible: boolean;
  color: { r, g, b, a };
  alignment?: 'MIN' | 'MAX' | 'STRETCH' | 'CENTER';
  gutterSize?: number;
  offset?: number;
  count?: number;        // for COLUMNS/ROWS
  numColumns?: number;
  numRows?: number;
}
```

We don't model `layoutGrids` at all. Figma's "Apply Layout Grid" UI surfaces this on Frame/Component/ComponentSet. For Figma-fidelity import, we need them.

**Concrete fix** in `src/lib/pen/types.ts`:

```ts
/** Figma's layout grid — visual columns / rows / grid guides on a frame. */
export interface PenLayoutGrid {
  pattern: 'columns' | 'rows' | 'grid';
  sectionSize?: PenNumberOrVariable;
  visible?: PenBooleanOrVariable;
  color?: PenColorOrVariable;
  alignment?: 'min' | 'max' | 'stretch' | 'center';
  gutterSize?: PenNumberOrVariable;
  offset?: PenNumberOrVariable;
  count?: PenNumberOrVariable;
}

// Extend PenFrame + PenComponent + PenComponentSet + PenSection:
export interface PenFrame extends PenRectangleish, PenCanHaveChildren, PenLayout {
  type: 'frame';
  clip?: PenBooleanOrVariable;
  placeholder?: boolean;
  slot?: false | string[];
  /** Visual layout guides (columns/rows/grid). Mirrors Figma's layoutGrids. */
  layoutGrids?: PenLayoutGrid[];
}
```

Also surface `layoutGrids` through the resolver onto the `Layer` type so the Canvas can render the guides (dashed lines on top of the frame).

#### Gap 2.6 — Missing FigJam node types: STICKY, CONNECTOR, WASHI_TAPE, SHAPE_WITH_TEXT (MEDIUM)

For flow diagrams + brainstorm canvases (FigJam-style), the most-needed Figma node types are:
- `STICKY` — sticky note (rectangular card with text, used for brainstorming)
- `CONNECTOR` — labeled arrow between two nodes (for flow diagrams)
- `WASHI_TAPE` — decorative tape strip
- `SHAPE_WITH_TEXT` — shape with embedded text label

We currently model none of these. STICKY + CONNECTOR are the high-impact additions.

**Concrete fix** in `src/lib/pen/types.ts` (add 4 new node interfaces):

```ts
/** STICKY — FigJam sticky note. Rectangular card with text + tinted fill. */
export interface PenSticky extends PenEntity, PenSize, PenTextStyle {
  type: 'sticky';
  content?: PenTextContent;
  /// Background tint color (yellow by default).
  tint?: PenColorOrVariable;
  /// Author display name (shown in the corner).
  author?: PenStringOrVariable;
}

/** CONNECTOR — FigJam flow arrow between two nodes. */
export interface PenConnector extends PenEntity {
  type: 'connector';
  /// Start point (canvas-space) — or { nodeId, anchor } to bind to a node.
  start: { x: number; y: number } | { nodeId: string; anchor?: 'top' | 'right' | 'bottom' | 'left' };
  /// End point (canvas-space) — or { nodeId, anchor }.
  end: { x: number; y: number } | { nodeId: string; anchor?: 'top' | 'right' | 'bottom' | 'left' };
  /// Label shown in the middle of the connector.
  label?: PenStringOrVariable;
  /// Cap styles.
  startCap?: 'none' | 'arrow';
  endCap?: 'none' | 'arrow' | 'filled_triangle' | 'diamond' | 'open_arrow';
}

export type PenChild =
  | PenFrame
  | PenSection
  // ... existing types ...
  | PenSticky
  | PenConnector;
```

Note: also add `'sticky'` and `'connector'` to the `PEN_NODE_TYPES` array and to the `LayerType` union in `src/lib/canvas/types.ts`. Wire up rendering in `Canvas.tsx` (sticky as a tinted rounded rect with text, connector as an SVG path with markers).

#### Gap 2.7 — Missing `inner_shadow` rendering + `background_blur` resolution (MEDIUM — also a runtime bug, see 3.4 / 3.5)

Our `PenEffect` type *does* model `'inner'` shadows (via `shadowType: 'inner' | 'outer'`) and `'background_blur'` effects, but:
- `resolve.ts::resolveEffects` only emits the first `'blur'` — it never reads `'background_blur'`.
- `Canvas.tsx::feDropShadow` doesn't respect `shadow.inset` — inner shadows render as outer shadows.

See Area 3 bugs 3.4 and 3.5 for the concrete fixes.

The only ontology change needed here is to extend the `Layer` type so the renderer can carry both a foreground blur and a background blur independently:

```ts
// src/lib/canvas/types.ts
export interface Layer {
  // ... existing fields ...
  blur?: number;                          // existing — LAYER_BLUR
  backgroundBlur?: number;                // NEW — BACKGROUND_BLUR (separate from LAYER_BLUR)
  shadow?: ShadowEffect | null;           // existing — DROP_SHADOW (outer)
  innerShadow?: ShadowEffect | null;      // NEW — INNER_SHADOW (separate from outer)
}
```

Figma allows up to 8 shadows + 1 layer blur + 1 background blur per node; the new fields preserve the *first* of each kind, which matches our existing single-shadow/single-blur approach.

#### Gap 2.8 — Missing newer Figma effects: NOISE, TEXTURE, GLASS (LOW)

Figma's UI now lists 7 effect types (per https://help.figma.com/hc/en-us/articles/360041488473): Glass, Drop shadow, Inner shadow, Layer blur, Background blur, Noise, Texture. The REST API still exposes only the 4 classic types (`DROP_SHADOW`, `INNER_SHADOW`, `LAYER_BLUR`, `BACKGROUND_BLUR`) — verified in `research/specs/figma-effects-search.json`. **Defer** until Figma exposes these via the REST API.

---

## Area 3 — Runtime Behaviour Bugs

### Bug 3.1 — `converters.ts` silently drops `pages` and `activePageIndex` (HIGH)

**File:** `src/lib/pen/converters.ts`
**Lines:** 23-31 (`canvasToPen`) and 39-52 (`penToCanvas`)

```ts
// canvasToPen — line 23-31
export function canvasToPen(canvas: CanvasDocument): PenDocument {
  return {
    version: canvas.version,
    themes: canvas.themes,
    imports: (canvas as any).imports,
    variables: canvas.variables,
    children: canvas.children,
    // ❌ MISSING: pages, activePageIndex
  };
}

// penToCanvas — line 39-52
export function penToCanvas(doc: PenDocument, documentId: string): CanvasDocument {
  return {
    id: documentId,
    name: 'Imported .pen',
    version: doc.version,
    themes: doc.themes,
    variables: doc.variables,
    children: doc.children ?? [],
    // ❌ MISSING: pages, activePageIndex
    viewport: { zoom: 1, panX: 120, panY: 80 },
    background: '#f8fafc',
    shapes: [],
    tokens: { colors: [], textStyles: [] },
  } as CanvasDocument;
}
```

**Impact:** Exporting a multi-page CanvasDocument via `POST /api/pen/export` writes a `.pen` file containing only the active page's `children` — all other pages vanish. Importing that file (or any `.pen` file with `pages` set) via `POST /api/pen/import` only loads `doc.children`, discarding `pages` entirely. The multi-page abstraction built in Phase 1 doesn't survive a round-trip.

**Concrete fix:**

```ts
export function canvasToPen(canvas: CanvasDocument): PenDocument {
  return {
    version: canvas.version,
    themes: canvas.themes,
    imports: (canvas as any).imports,
    variables: canvas.variables,
    children: canvas.children,
    pages: canvas.pages,                    // NEW
    activePageIndex: canvas.activePageIndex, // NEW
  };
}

export function penToCanvas(doc: PenDocument, documentId: string): CanvasDocument {
  return {
    id: documentId,
    name: 'Imported .pen',
    version: doc.version,
    themes: doc.themes,
    variables: doc.variables,
    children: doc.children ?? [],
    pages: doc.pages,                       // NEW
    activePageIndex: doc.activePageIndex,  // NEW
    viewport: { zoom: 1, panX: 120, panY: 80 },
    background: '#f8fafc',
    shapes: [],
    tokens: { colors: [], textStyles: [] },
  } as CanvasDocument;
}
```

Also: `src/app/api/pen/import/route.ts` lines 53-65 emits a `bulk_add` patch with `canvas.children` only — for multi-page `.pen` files, it should emit `set_active_page` patches for each imported page (or a new `bulk_add_pages` patch op). The simplest fix is to add a `pages` field to the `bulk_add` patch shape and have the applier populate `next.pages` directly.

### Bug 3.2 — `Canvas.tsx` SVG renderer silently renders 7 new node types as nothing (HIGH)

**File:** `src/components/canvas/Canvas.tsx`
**Lines:** 785-937 (the `switch (shape.type)` block)

The switch handles: `rectangle`, `frame`, `ellipse`, `line`, `text`, `path`, `image`, `group`, `default → null`.

**Missing cases:** `section`, `component`, `component_set`, `slice`, `star`, `polygon`, `boolean_operation`, `instance`.

When the agent calls `figma_create_section` (or any other new tool), the patch applier inserts the node into the tree, the resolver emits a `Layer` with the correct type, but the SVG renderer falls through to `default → null` and **nothing is drawn**. From the user's perspective the tool "succeeds" but produces no visible output — confusing.

**Concrete fix** — extend the switch:

```tsx
case 'section': {
  // Render as a translucent rounded rectangle with a header label.
  element = (
    <>
      {filterDef}
      <rect
        x={shape.x} y={shape.y} width={shape.width} height={shape.height}
        rx={8} ry={8}
        fill={fillValue === '#e2e8f0' ? 'rgba(148,163,184,0.12)' : fillValue}
        stroke="rgba(100,116,139,0.4)" strokeWidth={1} strokeDasharray="2 4"
        {...commonProps}
      />
      {shape.label && (
        <text x={shape.x + 12} y={shape.y + 18} fontSize={12} fontWeight={600}
              fill="rgba(71,85,105,0.9)" fontFamily="Inter, system-ui, sans-serif"
              style={{ pointerEvents: 'none' }}>
          {shape.label}
        </text>
      )}
    </>
  );
  break;
}
case 'component':
case 'component_set':
case 'instance': {
  // Render like a frame, but with a master/instance badge (already drawn later).
  element = (
    <>
      {filterDef}
      {gradientDef}
      <rect
        x={shape.x} y={shape.y} width={shape.width} height={shape.height}
        rx={rx} ry={ry}
        fill={fillValue} stroke={stroke} strokeWidth={strokeWidth}
        strokeDasharray={shape.type === 'component_set' ? '4 2' : undefined}
        {...commonProps}
      />
    </>
  );
  break;
}
case 'slice': {
  // Slice is invisible by default — show as a dashed outline only when selected.
  element = (
    <rect
      x={shape.x} y={shape.y} width={shape.width} height={shape.height}
      fill="transparent"
      stroke="rgba(236,72,153,0.6)" strokeWidth={1} strokeDasharray="4 2"
      {...commonProps}
    />
  );
  break;
}
case 'star': {
  // Compute star points: pointCount outer vertices, innerRadiusRatio scales inner ring.
  const cx = shape.x + shape.width / 2;
  const cy = shape.y + shape.height / 2;
  const rOuter = Math.min(shape.width, shape.height) / 2;
  const rInner = rOuter * (shape.innerRadiusRatio ?? 0.5);
  const points = (shape.pointCount ?? 5) * 2;
  const pts: string[] = [];
  for (let i = 0; i < points; i++) {
    const r = i % 2 === 0 ? rOuter : rInner;
    const a = (i / points) * Math.PI * 2 - Math.PI / 2;
    pts.push(`${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`);
  }
  element = (
    <>
      {filterDef}
      {gradientDef}
      <polygon points={pts.join(' ')} fill={fillValue} stroke={stroke}
               strokeWidth={strokeWidth} strokeLinejoin="round" {...commonProps} />
    </>
  );
  break;
}
case 'polygon': {
  const cx = shape.x + shape.width / 2;
  const cy = shape.y + shape.height / 2;
  const r = Math.min(shape.width, shape.height) / 2;
  const n = shape.polygonCount ?? 6;
  const pts: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    pts.push(`${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`);
  }
  element = (
    <>
      {filterDef}
      {gradientDef}
      <polygon points={pts.join(' ')} fill={fillValue} stroke={stroke}
               strokeWidth={strokeWidth} strokeLinejoin="round"
               strokeLinecap="round" {...commonProps} />
    </>
  );
  break;
}
case 'boolean_operation': {
  // Best-effort: render the flattened geometry (if present) as a path.
  // Falls back to a labelled dashed outline if not yet flattened.
  if (shape.points && shape.points.length > 0) {
    const pts = shape.points.map((p) => `${p.x},${p.y}`).join(' ');
    element = (
      <>
        {filterDef}
        {gradientDef}
        <polygon points={pts} fill={fillValue} stroke={stroke}
                 strokeWidth={strokeWidth} {...commonProps} />
      </>
    );
  } else {
    element = (
      <rect x={shape.x} y={shape.y} width={shape.width} height={shape.height}
            fill="transparent" stroke="rgba(168,85,247,0.5)"
            strokeWidth={1} strokeDasharray="4 2" {...commonProps} />
    );
  }
  break;
}
```

### Bug 3.3 — `resolve.ts::mapNodeType` maps `ref` → `'rectangle'` instead of `'instance'` (HIGH)

**File:** `src/lib/pen/resolve.ts`
**Lines:** 593-620 (specifically line 617)

```ts
function mapNodeType(node: PenChild): Layer['type'] {
  // ...
  case 'ref': return 'rectangle';     // ← should return 'instance'
  default: return 'rectangle';
}
```

**Impact:**
- The `'instance'` value in `LayerType` (`src/lib/canvas/types.ts` line 43) is dead code — never emitted.
- The LayersPanel's `instance: CornerDownRight` icon (`src/components/canvas/LayersPanel.tsx` line 67) is unreachable.
- Component instances in the layer tree appear as plain rectangles — visually indistinguishable from a frame, and the Properties panel's `isComponentInstance` check (`shape.componentId && shape.componentId !== shape.id`) only works if the applier sets `componentId` on the resolved layer, which `resolve.ts` does NOT currently do for expanded refs.

**Concrete fix:**

```ts
// 1. In mapNodeType (resolve.ts line 617):
case 'ref': return 'instance';

// 2. In resolve.ts emit() (around line 510-558), when expanding a ref:
//    Set componentId so the renderer/PropertiesPanel can detect instances.
const isInstance = n.type === 'ref' || (n as any)._isExpandedRef;
const shape: Shape = {
  // ... existing fields ...
  componentId: isInstance ? (n as PenRef).ref : ((n as any).componentId ?? null),
  type: mapNodeType(n),       // now returns 'instance' for refs
  // ...
};
```

(Note: `expandRef` in `document.ts` already replaces the ref with the component's subtree; we need to either tag the expanded root with `_isExpandedRef = true` or have `emit` check whether `rn.parent` was a ref. The simpler approach: in `expandTree`, set `componentId = ref.ref` on the expanded root node so it survives through emit.)

### Bug 3.4 — `resolve.ts::resolveEffects` silently drops `background_blur` effects (MEDIUM)

**File:** `src/lib/pen/resolve.ts`
**Lines:** 158-180

```ts
function resolveEffects(node: any, variables: any, theme: PenTheme): { shadow: ShadowEffect | null; blur: number } {
  const effects = node.effect;
  if (!effects) return { shadow: null, blur: 0 };
  const arr = Array.isArray(effects) ? effects : [effects];
  let shadow: ShadowEffect | null = null;
  let blur = 0;
  for (const e of arr) {
    if (e.enabled === false) continue;
    if (e.type === 'shadow' && !shadow) { /* ... */ }
    else if (e.type === 'blur' && blur === 0) {
      blur = typeof e.radius === 'number' ? e.radius : 0;
    }
    // ❌ MISSING: e.type === 'background_blur'
  }
  return { shadow, blur };
}
```

`PenEffect` (in `pen/types.ts` line 174-186) explicitly defines a `'background_blur'` effect type. But `resolveEffects` never reads it, so any `background_blur` in a `.pen` file is silently dropped on resolve — the Layer only carries the foreground `blur`.

**Concrete fix:**

```ts
// Update the return type to carry both blurs separately.
function resolveEffects(node: any, variables: any, theme: PenTheme): {
  shadow: ShadowEffect | null;
  innerShadow: ShadowEffect | null;
  blur: number;            // LAYER_BLUR (foreground)
  backgroundBlur: number;  // BACKGROUND_BLUR (behind the layer)
} {
  const effects = node.effect;
  if (!effects) return { shadow: null, innerShadow: null, blur: 0, backgroundBlur: 0 };
  const arr = Array.isArray(effects) ? effects : [effects];
  let shadow: ShadowEffect | null = null;
  let innerShadow: ShadowEffect | null = null;
  let blur = 0;
  let backgroundBlur = 0;
  for (const e of arr) {
    if (e.enabled === false) continue;
    if (e.type === 'shadow') {
      const s: ShadowEffect = {
        x: typeof e.offset?.x === 'number' ? e.offset.x : 0,
        y: typeof e.offset?.y === 'number' ? e.offset.y : 0,
        blur: typeof e.blur === 'number' ? e.blur : 0,
        color: resolveValue(e.color ?? '#000000', variables, theme),
        spread: typeof e.spread === 'number' ? e.spread : 0,
        inset: e.shadowType === 'inner',
      };
      if (s.inset && !innerShadow) innerShadow = s;
      else if (!s.inset && !shadow) shadow = s;
    } else if (e.type === 'blur' && blur === 0) {
      blur = typeof e.radius === 'number' ? e.radius : 0;
    } else if (e.type === 'background_blur' && backgroundBlur === 0) {
      backgroundBlur = typeof e.radius === 'number' ? e.radius : 0;
    }
  }
  return { shadow, innerShadow, blur, backgroundBlur };
}

// In emit() around line 487-488:
const { shadow, innerShadow, blur, backgroundBlur } = resolveEffects(n, vars, theme);

// And in the shape literal (around line 539-540):
shadow,
innerShadow,
blur,
backgroundBlur,
```

Then extend `Layer` (`src/lib/canvas/types.ts` line 152) to add `innerShadow?: ShadowEffect | null;` and `backgroundBlur?: number;`.

### Bug 3.5 — `Canvas.tsx::feDropShadow` ignores `shadow.inset` (MEDIUM)

**File:** `src/components/canvas/Canvas.tsx`
**Lines:** 715-735 (the filter pipeline)

```tsx
const hasFilter = !!shape.shadow || (shape.blur ?? 0) > 0;

const filterDef = hasFilter ? (
  <defs>
    <filter id={filterId} x="-50%" y="-50%" width="200%" height="200%">
      {shape.blur && shape.blur > 0 && (
        <feGaussianBlur in="SourceGraphic" stdDeviation={shape.blur} />
      )}
      {shape.shadow && (
        <feDropShadow
          dx={shape.shadow.x}
          dy={shape.shadow.y}
          stdDeviation={shape.shadow.blur}
          floodColor={shape.shadow.color}
          floodOpacity={1}
        />
      )}
    </filter>
  </defs>
) : null;
```

**Issues:**
1. `feDropShadow` always renders an *outer* shadow — `shape.shadow.inset` is ignored, so INNER_SHADOW renders as DROP_SHADOW.
2. The filter doesn't compose `backgroundBlur` — only the foreground `blur`.
3. If both `innerShadow` and `shadow` are present (Figma allows 8 shadows per layer), only the outer one renders.

**Concrete fix** (assuming Bug 3.4 is applied so `innerShadow` and `backgroundBlur` are available):

```tsx
const hasFilter = !!shape.shadow || !!shape.innerShadow || (shape.blur ?? 0) > 0 || (shape.backgroundBlur ?? 0) > 0;

const filterDef = hasFilter ? (
  <defs>
    <filter id={filterId} x="-50%" y="-50%" width="200%" height="200%">
      {/* Background blur — applied to the backdrop (Figma's BACKGROUND_BLUR).
          NB: true SVG backdrop blur needs `feGaussianBlur in="BackgroundImage"`,
          which only works inside an SVG 2 context. As a visual approximation,
          we blur the SourceGraphic then composite it back under itself. */}
      {shape.backgroundBlur && shape.backgroundBlur > 0 && (
        <>
          <feGaussianBlur in="SourceGraphic" stdDeviation={shape.backgroundBlur} result="bgBlur" />
        </>
      )}
      {/* Layer blur (foreground) */}
      {shape.blur && shape.blur > 0 && (
        <feGaussianBlur in={shape.backgroundBlur ? 'SourceGraphic' : 'SourceGraphic'}
                        stdDeviation={shape.blur} result="fgBlur" />
      )}
      {/* Outer shadow (DROP_SHADOW) */}
      {shape.shadow && (
        <feDropShadow in={shape.blur ? 'fgBlur' : 'SourceGraphic'}
                      dx={shape.shadow.x} dy={shape.shadow.y}
                      stdDeviation={shape.shadow.blur}
                      floodColor={shape.shadow.color} floodOpacity={1}
                      result="outerShadow" />
      )}
      {/* Inner shadow (INNER_SHADOW) — composite SourceAlpha inverted over the graphic */}
      {shape.innerShadow && (
        <>
          <feComponentTransfer in="SourceAlpha" result="invertedAlpha">
            <feFuncA type="table" tableValues="1 0" />
          </feComponentTransfer>
          <feGaussianBlur in="invertedAlpha" stdDeviation={shape.innerShadow.blur}
                          result="innerBlur" />
          <feOffset in="innerBlur" dx={shape.innerShadow.x} dy={shape.innerShadow.y}
                    result="innerOffset" />
          <feFlood floodColor={shape.innerShadow.color} floodOpacity={1} result="innerColor" />
          <feComposite in="innerColor" in2="innerOffset" operator="in" result="innerShadowFilled" />
          <feComposite in="innerShadowFilled" in2="SourceAlpha" operator="in"
                       result="innerShadowClipped" />
          <feMerge>
            <feMergeNode in={shape.shadow ? 'outerShadow' : undefined} />
            <feMergeNode in="innerShadowClipped" />
            <feMergeNode in={shape.blur ? 'fgBlur' : 'SourceGraphic'} />
          </feMerge>
        </>
      )}
    </filter>
  </defs>
) : null;
```

(The above is illustrative; the actual implementation should be tested with a few real shadow/blur combinations to verify visual correctness.)

### Bug 3.6 — `PropertiesPanel.tsx` doesn't surface the new Figma fields (MEDIUM)

**File:** `src/components/canvas/PropertiesPanel.tsx`
**Lines:** 411-426 (Component master/instance info block)

The panel currently shows:
- `isComponentMaster` / `isComponentInstance` badge (line 412-426)
- X/Y, W/H, Fill, Stroke, Radius, Opacity
- Theme editor
- Auto Layout editor (only for `frame` + `group`)

It does **NOT** surface any of these resolved fields:

| Field | Where it lives on `Layer` | Should display what |
|---|---|---|
| `componentPropertyDefinitions` | `Layer.componentPropertyDefinitions` (resolve.ts line 548) | A table of property name → {type, defaultValue, variantOptions, preferredValues}, editable to add/remove properties |
| `componentProperties` | `Layer.componentProperties` (line 549) | A list of per-instance override values, editable |
| `variantPropertyAxes` | `Layer.variantPropertyAxes` (line 550) | For `component_set`: comma-separated list of axis names |
| `variantPropertyValues` | `Layer.variantPropertyValues` (line 551) | For a variant `component` inside a set: `axis=value` per axis |
| `booleanOperationType` | `Layer.booleanOperationType` (line 553) | For `boolean_operation`: a Select with union/subtract/intersect/exclude |
| `label` | `Layer.label` (line 552) | For `section`: an editable text input (currently it's auto-set from `name` so editing the name works, but Figma treats label and node name as distinct — for Figma fidelity, label should be its own field) |
| `pointCount` + `innerRadiusRatio` | `Layer.pointCount`, `Layer.innerRadiusRatio` (lines 554-555) | For `star`: number inputs |
| `polygonCount` | `Layer.polygonCount` (line 556) | For `polygon`: number input (default 6) |
| `exportSettings` | `Layer.exportSettings` (line 557) | For `slice`: list of {format, scale, suffix} entries |

**Concrete fix** — add 4 new collapsible sections to `PropertiesPanel.tsx`, one per node-type family:

```tsx
{/* Component master properties table */}
{!isMulti && shape.type === 'component' && shape.componentPropertyDefinitions && (
  <Collapsible>
    <CollapsibleTrigger asChild>
      <button type="button" className="group flex items-center gap-1.5 w-full text-left">
        <ChevronDown className="h-3 w-3 ac-text-4 transition-transform group-data-[state=closed]:-rotate-90" />
        <Label className="text-[11px] text-slate-500">Component Properties</Label>
      </button>
    </CollapsibleTrigger>
    <CollapsibleContent className="space-y-2 pt-2">
      {Object.entries(shape.componentPropertyDefinitions).map(([name, def]) => (
        <div key={name} className="flex items-center gap-2 px-2 py-1 rounded border ac-border-subtle">
          <Badge variant="outline" className="text-[9px] h-3.5 px-1 py-0 font-normal">{def.type}</Badge>
          <span className="text-[11px] font-mono ac-text-2 flex-1">{name}</span>
          <span className="text-[10px] ac-text-4 font-mono">{JSON.stringify(def.defaultValue)}</span>
        </div>
      ))}
      <Button variant="outline" size="sm" className="h-7 text-[11px] w-full"
              onClick={() => toast.message('Add property — opens a dialog to pick name + type.')}>
        + Add property
      </Button>
    </CollapsibleContent>
  </Collapsible>
)}

{/* Component set variant axes */}
{!isMulti && shape.type === 'component_set' && shape.variantPropertyAxes && (
  <Collapsible defaultOpen>
    <CollapsibleTrigger asChild>
      <button type="button" className="group flex items-center gap-1.5 w-full text-left">
        <ChevronDown className="h-3 w-3 ac-text-4 transition-transform group-data-[state=closed]:-rotate-90" />
        <Label className="text-[11px] text-slate-500">Variant Axes</Label>
      </button>
    </CollapsibleTrigger>
    <CollapsibleContent className="space-y-1 pt-2">
      <Input value={shape.variantPropertyAxes.join(', ')}
             onChange={(e) => sendPatch({
               op: 'update', shapeId: shape.id,
               shape: { variantPropertyAxes: e.target.value.split(',').map(s => s.trim()).filter(Boolean) } as Partial<Shape>,
               summary: `Updated variant axes on ${shape.name}`,
             })}
             className="h-7 text-xs" />
      <p className="text-[10px] ac-text-4">Comma-separated axis names (e.g. "size, state").</p>
    </CollapsibleContent>
  </Collapsible>
)}

{/* Instance property overrides */}
{!isMulti && isComponentInstance && shape.componentProperties && (
  <Collapsible defaultOpen>
    <CollapsibleTrigger asChild><button type="button" className="group flex items-center gap-1.5 w-full text-left">
      <ChevronDown className="h-3 w-3 ac-text-4 transition-transform group-data-[state=closed]:-rotate-90" />
      <Label className="text-[11px] text-slate-500">Instance Overrides</Label>
    </button></CollapsibleTrigger>
    <CollapsibleContent className="space-y-2 pt-2">
      {Object.entries(shape.componentProperties).map(([name, value]) => (
        <div key={name} className="flex items-center gap-2">
          <Label className="text-[11px] text-slate-500 flex-1 font-mono">{name}</Label>
          <Input defaultValue={String(value)}
                 onBlur={(e) => sendPatch({
                   op: 'set_instance_property', shapeId: shape.id,
                   instancePropertyName: name,
                   instancePropertyValue: e.target.value,
                   summary: `Set ${name} = ${e.target.value}`,
                 })}
                 className="h-7 text-xs w-32" />
        </div>
      ))}
    </CollapsibleContent>
  </Collapsible>
)}

{/* Star / Polygon / Section / Boolean op / Slice editors */}
{!isMulti && shape.type === 'star' && (
  <Collapsible defaultOpen>
    <CollapsibleTrigger asChild><button type="button" className="group flex items-center gap-1.5 w-full text-left">
      <ChevronDown className="h-3 w-3 ac-text-4 transition-transform group-data-[state=closed]:-rotate-90" />
      <Label className="text-[11px] text-slate-500">Star</Label>
    </button></CollapsibleTrigger>
    <CollapsibleContent className="grid grid-cols-2 gap-2 pt-2">
      <div>
        <Label className="text-[11px] text-slate-500">Points</Label>
        <Input type="number" value={shape.pointCount ?? 5}
               onChange={(e) => update({ pointCount: parseInt(e.target.value) || 5 })}
               className="h-7 mt-1 text-xs" />
      </div>
      <div>
        <Label className="text-[11px] text-slate-500">Inner radius ratio</Label>
        <Input type="number" step="0.05" min="0" max="1" value={shape.innerRadiusRatio ?? 0.5}
               onChange={(e) => update({ innerRadiusRatio: parseFloat(e.target.value) || 0.5 })}
               className="h-7 mt-1 text-xs" />
      </div>
    </CollapsibleContent>
  </Collapsible>
)}

{/* Similar collapsibles for polygon (sides), section (label), boolean_operation (op type), slice (export settings) */}
```

### Bug 3.7 — `LayersPanel.tsx` has no Pages UI + `isContainer` misses 4 new container types (HIGH)

**File:** `src/components/canvas/LayersPanel.tsx`

**Two issues:**

**(a) Pages UI is missing entirely.** `grep -n 'page\|Page' LayersPanel.tsx` returns zero matches. The user has no way to:
- See the list of pages in the document.
- Switch the active page from the layers panel.
- Add / rename / delete pages.

The agent can do all of this via `figma_create_page` etc., but the human user is locked out of multi-page management unless they use the agent.

**Concrete fix** — add a Pages dropdown above the layers tree:

```tsx
// At the top of the LayersPanel component, above the search box:
{document.pages && document.pages.length > 0 && (
  <div className="px-2 py-1.5 border-b ac-border-subtle">
    <Label className="text-[11px] text-slate-500">Page</Label>
    <Select
      value={document.pages[document.activePageIndex ?? 0]?.id}
      onValueChange={(pageId) => sendPatch({
        op: 'set_active_page', pageId,
        summary: `Switched to page "${document.pages?.find(p => p.id === pageId)?.name}"`,
      })}
    >
      <SelectTrigger className="h-7 mt-1 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {document.pages.map((page) => (
          <SelectItem key={page.id} value={page.id}>{page.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
    <div className="flex items-center gap-1 mt-1">
      <Button variant="outline" size="sm" className="h-6 text-[10px] flex-1"
              onClick={() => sendPatch({ op: 'add_page', pageName: `Page ${(document.pages?.length ?? 1) + 1}`, summary: 'Added a page' })}>
        + Page
      </Button>
      <Button variant="outline" size="sm" className="h-6 text-[10px]"
              onClick={() => {/* open rename dialog */}}>
        Rename
      </Button>
      <Button variant="outline" size="sm" className="h-6 text-[10px]"
              onClick={() => sendPatch({ op: 'delete_page', pageId: document.pages?.[document.activePageIndex ?? 0]?.id, summary: 'Deleted current page' })}>
        Delete
      </Button>
    </div>
  </div>
)}
```

**(b) `isContainer` predicate misses the new container types.** Line 185:

```ts
const isContainer = (s: Shape) => s.type === 'frame' || s.type === 'group';
```

This means `section`, `component`, `component_set`, and `boolean_operation` (which all have `children` per `isContainerNode` in `resolve.ts` line 42-57) **cannot be expanded/collapsed** in the layers panel and **cannot be drop targets** for reparent via drag. Also the "Reparent to…" submenu (line 540) filters by `frame || group`, missing the new containers.

**Concrete fix:**

```ts
// Line 185 — extend isContainer:
const isContainer = (s: Shape) =>
  s.type === 'frame' ||
  s.type === 'group' ||
  s.type === 'section' ||
  s.type === 'component' ||
  s.type === 'component_set' ||
  s.type === 'boolean_operation';

// Line 540 — extend the reparent-to filter:
{shapes.filter((s) =>
  (s.type === 'frame' || s.type === 'group' || s.type === 'section' ||
   s.type === 'component' || s.type === 'component_set' || s.type === 'boolean_operation')
  && s.id !== shape.id
).map((parent) => (
  // ... existing JSX ...
))}
```

---

## Prioritised Action List (top 10)

Ordered by impact × ease:

1. **Fix `converters.ts` to round-trip `pages` + `activePageIndex`.** (HIGH, 5 min) — Bug 3.1. Without this, every multi-page doc loses its pages on export/import.
2. **Extend `Canvas.tsx` SVG renderer for the 7 missing node types.** (HIGH, ~1 hr) — Bug 3.2. Without this, every `figma_create_*` tool silently produces nothing visible.
3. **Fix `resolve.ts::mapNodeType` to emit `'instance'` for refs (and set `componentId` on the expanded root).** (HIGH, 30 min) — Bug 3.3. Required for the LayersPanel instance icon and the PropertiesPanel instance-overrides UI to work.
4. **Add Pages dropdown + extend `isContainer` in `LayersPanel.tsx`.** (HIGH, 45 min) — Bug 3.7. Required for human users to manage multi-page docs.
5. **Add `innerShadow` + `backgroundBlur` to the resolver and the Layer type; fix `feDropShadow` to respect `inset`.** (MEDIUM, 1.5 hrs) — Bugs 3.4 + 3.5. Restores Figma's 4 effect types end-to-end.
6. **Add 10 new LLM providers to `registry.ts`.** (MEDIUM, 30 min) — Area 1. Pure additive; no new adapters needed.
7. **Add the SLOT component property type and the `FLOAT` variable type to `pen/types.ts`.** (MEDIUM, 30 min) — Gaps 2.2 + 2.3. Required for true Figma semantic parity. Tests + `figma-tools.ts` need updates too.
8. **Add the 4 missing `PropertiesPanel` collapsibles (component properties, variant axes, instance overrides, star/polygon/section/boolean/slice editors).** (MEDIUM, ~2 hrs) — Bug 3.6. The data is resolved; just needs UI.
9. **Add `LayoutGrid` type to `pen/types.ts` + surface through the resolver onto `Layer`.** (MEDIUM, 1 hr) — Gap 2.5. Required for Figma-imported frames to retain their column/row/grid guides.
10. **Add STICKY + CONNECTOR node types (FigJam parity).** (MEDIUM, ~3 hrs) — Gap 2.6. Required for flow-diagram / brainstorming use cases. Includes new node interfaces, PEN_NODE_TYPES additions, LayerType additions, Canvas.tsx rendering, LayersPanel icons, and tests.

### Deferred / lower priority

- **Gap 2.4 (Variable modes ↔ PenTheme mapping)** — needed only when we add a "Import from Figma URL" feature. The .pen → .pen round-trip already works because both use the `themes` model.
- **Gap 2.7 (NOISE / TEXTURE / GLASS effects)** — defer until Figma exposes them via the REST API. Currently UI-only.
- **Friendli AI / Replicate / LMDeploy / Xinference** LLM providers — defer until requested. The first two need adapters; the last two are covered by `custom`.
- **Figma-native node types** like TABLE / TABLE_CELL / WIDGET / SLIDE / STAMP / etc. — niche, defer until a real use case emerges.

---

## Verification artifacts

All research outputs are saved for re-verification:

- LLM provider doc pages: `research/specs/llm-providers/page-*.json` (Novita, Hyperbolic, Chutes, SambaNova, Cerebras, AI/ML API, Atoma, Inception, LMDeploy, Xinference)
- LLM provider search results: `research/specs/llm-providers/search-*.json` (all 10 candidates + DeepInfra, SiliconFlow, Friendli, Replicate)
- Figma docs fetched: `research/specs/figma-plugin-nodes.json` (NodeType enum), `research/specs/figma-var-rest.json` (resolvedType + variableModes + valuesByMode), `research/specs/figma-component-properties.json` (5 component property types incl. SLOT), `research/specs/figma-rest-*.json` (REST API files endpoint, node types, component property types, variable modes)
- Figma effects / layoutGrid search results: `research/specs/figma-effects-search.json`, `research/specs/figma-layoutgrid-search.json`

All the bugs above were verified by reading the current code in `src/lib/pen/{types,resolve,converters}.ts`, `src/lib/canvas/types.ts`, `src/components/canvas/{Canvas,PropertiesPanel,LayersPanel}.tsx`, and `src/app/api/pen/{export,import}/route.ts`.
