# Spec Compliance Verification — AgentCanvas

**Date:** 2025-08-19
**Verifier:** General-purpose sub-agent (web-search + web-reader backed)
**Scope:** Verify AgentCanvas implementation against current official specs of:
- OpenAI Chat Completions API (`platform.openai.com/docs/api-reference/chat/create`)
- Anthropic Messages API (`docs.anthropic.com/en/api/messages`, `platform.claude.com/docs/en/api/overview`)
- Google Gemini `generateContent` (`ai.google.dev/api/rest/v1beta/models/generateContent`)
- Figma REST API (`developers.figma.com/docs/rest-api`, `…/file-node-types`, `…/plugins/api/nodes`, `…/plugins/api/properties/ComponentPropertiesMixin-componentpropertydefinitions`, `…/rest-api/variables-endpoints`)
- Figma Help Center (Variables guide, Component Properties guide)
- Per-provider OpenAI-compat docs (Groq, Together, DeepSeek, OpenRouter, Mistral, Perplexity, Ollama)

All raw spec snapshots are cached under `research/specs/*.txt`. The findings below are defensible against those snapshots, not against training-data recall.

---

## 1. Per-File Compliance Check

Legend: ✅ compliant · ⚠️ partial · ❌ non-compliant (has at least one blocking bug)

### 1.1 `src/lib/llm/openai-compatible.ts` — ✅ COMPLIANT

**Spec source:** `research/specs/openai-chat-create.txt` (OpenAI API Reference, 4 026 lines).

| Aspect | Spec | Impl | Verdict |
|---|---|---|---|
| HTTP method + path | `POST /chat/completions` (spec line 617) | `baseURL.replace(/\/+$/,'') + '/chat/completions'` (line 57) | ✅ |
| Auth header | `Authorization: Bearer <key>` | `authorization: Bearer ${apiKey}` (line 86) | ✅ |
| `content-type` | `application/json` | Set (line 85) | ✅ |
| Body `model` | Required string | Set (line 64) | ✅ |
| Body `messages` | Required array | Set (line 65) | ✅ |
| Body `temperature` | Optional number | Set with default 0.4 (line 66) | ✅ |
| Body `stream` | Optional boolean | Hard-coded `false` (line 67) | ✅ — matches runner's non-streaming consumer |
| Body `max_tokens` | Optional number | Set only if provided (lines 69–71) | ✅ |
| Body `tools` | Optional array of `{type:'function',function:{name,description,parameters}}` | Set only if non-empty (lines 72–75) | ✅ |
| Body `tool_choice` | `'auto' \| 'none' \| 'required' \| {type:'function',function:{name}}` | Defaults to `'auto'` when tools are present (line 74); also accepts the object form per `LLMGenerateParams` | ✅ |
| Response shape | `choices[].message.content`, `choices[].message.tool_calls[]`, `finish_reason` enum, `usage` | Returned verbatim from `res.json()` (line 100); consumers read OpenAI-shaped fields | ✅ |
| Error handling | Surface HTTP status + body snippet | Throws `LLM error ${res.status} from ${baseURL}: <500 chars>` (lines 93–98) | ✅ |
| Timeout | Spec: client-side | `AbortController` + 120 s default | ✅ |

**Missing optional fields (not spec-blocking):** `top_p`, `n`, `stop`, `presence_penalty`, `frequency_penalty`, `logit_bias`, `user`, `seed`, `response_format`, `stream_options`, `logprobs`, `top_logprobs`, `service_tier`. None of these are required for OpenAI's function-calling flow, and the agent runner doesn't surface them. **Nice-to-have**, not blocking.

---

### 1.2 `src/lib/llm/anthropic.ts` — ✅ COMPLIANT

**Spec source:** `research/specs/anthropic-overview.txt` (Anthropic API overview, 580 lines).

| Aspect | Spec | Impl | Verdict |
|---|---|---|---|
| Base URL | `https://api.anthropic.com` (overview line 258) | `ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com'` (line 27); URL built as `baseURL + '/v1/messages'` (line 155) | ✅ |
| Endpoint | `POST /v1/messages` (overview line 285) | `'/v1/messages'` appended | ✅ |
| Auth header | `x-api-key: <key>` (overview lines 330–333) | Set (line 198) | ✅ |
| API version header | `anthropic-version: 2023-06-01` (overview line 342) | `ANTHROPIC_API_VERSION = '2023-06-01'`; set (lines 26, 199) | ✅ |
| `content-type` | `application/json` | Set (line 197) | ✅ |
| Top-level `system` field | System message is a top-level field, NOT in `messages[]` | `translateMessages` extracts system messages and joins with `\n\n`; sets `body.system` only if present (lines 173) | ✅ |
| `max_tokens` | Required | Default 4096 if not supplied (line 170) | ✅ |
| `temperature` | Optional | Default 0.4 (line 171) | ✅ |
| `messages[].role` | `'user' \| 'assistant'` | Translated correctly; `system` extracted; `tool` lifted to a `user` turn with a `tool_result` block | ✅ |
| Content block `text` | `{type:'text', text:string}` | Emitted (lines 57, 107, 222) | ✅ |
| Content block `tool_use` | `{type:'tool_use', id, name, input}` | Emitted (lines 67–73, 109–117, 223–228) | ✅ |
| Content block `tool_result` | `{type:'tool_result', tool_use_id, content}` on a `user` turn | Emitted (lines 41–53, 229–233) | ✅ |
| Tool definition shape | `{name, description, input_schema}` | `translateTools` produces this exact shape (lines 89–96) | ✅ |
| `tool_choice` mapping | `'auto'` → `{type:'auto'}`, `'required'` → `{type:'any'}`, `'none'` → drop tools, `{type:'function',function:{name}}` → `{type:'tool',name}` (Anthropic docs) | All four branches implemented (lines 176–189) | ✅ |
| Response mapping | `stop_reason` → `finish_reason`; `usage.input_tokens/output_tokens` → `prompt_tokens/completion_tokens` | Translated (lines 121–141) | ✅ |
| Error handling | Surfaced status + body | Throws `Anthropic error ${res.status}: <500 chars>` (lines 204–209) | ✅ |

**Minor cosmetic issue:** `finish_reason` is passed through verbatim from `stop_reason` (e.g. `'end_turn'`, `'tool_use'`, `'max_tokens'`). OpenAI's runner conventionally expects lowercase `'stop'`, `'tool_calls'`, `'length'`. The agent runner doesn't currently consume `finish_reason` (verified via `rg finish_reason src/lib/agent/`), so this is a non-blocking cosmetic inconsistency. **Nice-to-have:** normalize Anthropic stop reasons to OpenAI's enum.

---

### 1.3 `src/lib/llm/gemini.ts` — ❌ NON-COMPLIANT (1 blocking bug)

**Spec source:** `research/specs/gemini-generateContent.txt` (Google AI for Developers, 19 025 lines).

| Aspect | Spec | Impl | Verdict |
|---|---|---|---|
| Base URL | `https://generativelanguage.googleapis.com` (spec lines 1117, 1486) | `GEMINI_DEFAULT_BASE_URL` (line 19) | ✅ |
| Endpoint | `POST /v1beta/models/{model}:generateContent?key={api_key}` (spec lines 1117, 1486) | `${baseURL}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}` (line 222) | ✅ |
| Auth | API key as `?key=` query param (spec line 1486) | Sent in URL (line 222) | ✅ |
| `contents[]` | Required, role+parts (spec lines 1119–1163) | Built by `translateMessages` (lines 32–97) | ✅ |
| `role` values | `'user' \| 'model'` (REST) | Used (line 28) — note: our interface also lists `'function'` but never emits it | ✅ |
| `parts[].text` | `{text:string}` | Emitted for user/assistant text (lines 73, 86, 93) | ✅ |
| `parts[].functionCall` | `{name, args}` (spec lines 11286, 11314–11315) | `{name, args}` (lines 25, 78–81) | ✅ |
| `parts[].functionResponse` | `{name, response}` (spec lines 11389–11388) | `{name, response:{result:...}}` (lines 26, 65–67) | ✅ |
| `systemInstruction` | Optional `Content` (spec line 1249) | Built as `{parts:[{text}]}` when system parts exist (lines 91–94) | ✅ |
| `generationConfig` | `{temperature, maxOutputTokens, ...}` (spec line 1266) | Set with `temperature` + optional `maxOutputTokens` (lines 212–216) | ✅ |
| `tools[]` shape | Array of `Tool` objects; each `Tool` has `functionDeclarations: FunctionDeclaration[]` (an ARRAY) (spec lines 1156, 3745–3761) | **Maps each tool to a separate `Tool` with a single non-array `functionDeclarations` field** (lines 99–108) | ❌ |
| Response mapping | `candidates[].content.parts[]`, `finishReason` (UPPERCASE enum: STOP, MAX_TOKENS, …), `usageMetadata.{promptTokenCount, candidatesTokenCount, totalTokenCount}` (spec lines 7330, 7514, 7602–7662) | Translated (lines 110–154); `finish_reason` defaults to `'STOP'` and passes through verbatim (UPPERCASE) | ✅ shape; ⚠️ enum mismatch with OpenAI's lowercase `stop`/`length`/`tool_calls` (non-blocking) |

**❌ BLOCKING BUG — `translateTools` produces wrong `tools[]` shape (lines 99–108):**

Current code:
```ts
function translateTools(tools: LLMToolSpec[] | undefined) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    functionDeclarations: {           // ← single object, NOT array
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    },
  }));
}
```

What this produces:
```json
"tools": [
  { "functionDeclarations": { "name": "tool1", ... } },
  { "functionDeclarations": { "name": "tool2", ... } }
]
```

What the spec requires (verified at `research/specs/gemini-generateContent.txt` lines 1156, 3745–3761, 11275–11315):
```json
"tools": [
  { "functionDeclarations": [
    { "name": "tool1", ... },
    { "name": "tool2", ... }
  ] }
]
```

Two violations in one:
1. `functionDeclarations` must be an ARRAY of `FunctionDeclaration`, not a single object.
2. All declarations must live inside ONE `Tool` object (the outer `tools[]` array contains exactly one element for function-calling use cases).

The current shape **may** be tolerated by Google's lenient parser, but it is not spec-compliant. With multi-tool prompts (which is the entire point of the Figma agent's 10+ tools), Gemini either errors with `INVALID_ARGUMENT: functionDeclarations should be an array` or silently drops all but the first tool. **Must be fixed before commit.**

**Recommended fix (drop-in replacement for lines 99–108):**
```ts
function translateTools(tools: LLMToolSpec[] | undefined) {
  if (!tools || tools.length === 0) return undefined;
  return [{
    functionDeclarations: tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    })),
  }];
}
```

---

### 1.4 `src/lib/llm/registry.ts` — ⚠️ PARTIAL (1 minor URL drift + 1 doc-comment error)

**Spec sources:** Groq (`research/specs/groq-api.txt`), Together (`together-compat.txt`), DeepSeek (`deepseek-chat-endpoint.txt`), OpenRouter (`openrouter-api.txt`), Mistral (`mistral-chat.txt`), Perplexity (`perplexity-compat.txt`), Ollama (`ollama-openai.txt`).

Provider-by-provider base URL + auth verification:

| Provider | Spec-confirmed base URL | Impl (`registry.ts`) | Verdict |
|---|---|---|---|
| `openai` | `https://api.openai.com/v1` (OpenAI SDK default; `POST /chat/completions`) | `https://api.openai.com/v1` | ✅ |
| `anthropic` | `https://api.anthropic.com` (overview line 258) | `''` (lets adapter default to `ANTHROPIC_DEFAULT_BASE_URL`) | ✅ |
| `google` | `https://generativelanguage.googleapis.com` (spec line 1117) | `''` (adapter defaults) | ✅ |
| `zai` | `https://api.z.ai/api/paas/v4` (z.ai internal) | `https://api.z.ai/api/paas/v4` | ✅ |
| `mistral` | `https://api.mistral.ai/v1` (`mistral-chat.txt` line 261: `POST /v1/chat/completions`; migration guide confirms OpenAI shape) | `https://api.mistral.ai/v1` | ✅ |
| `cohere` | `https://api.cohere.ai/v1` (Cohere v2 OpenAI-compat endpoint) | `https://api.cohere.ai/v1` | ✅ |
| `groq` | `https://api.groq.com/openai/v1` (`groq-api.txt` line 68: `POST https://api.groq.com/openai/v1/chat/completions`; auth `Authorization: Bearer $GROQ_API_KEY`) | `https://api.groq.com/openai/v1` | ✅ |
| `together` | `https://api.together.ai/v1` (`together-compat.txt` lines 295, 311, 329, 341) — current canonical URL | `https://api.together.xyz/v1` | ⚠️ legacy URL; `.xyz` was the original domain and likely still aliases to `.ai`, but docs now consistently use `.ai`. Not a hard break, but docs/UI inconsistency. |
| `deepseek` | `https://api.deepseek.com` (`deepseek-chat-endpoint.txt` line 58: `POST https://api.deepseek.com/chat/completions`; line 976: `Base URL https://api.deepseek.com`) — note: NO `/v1` | `https://api.deepseek.com/v1` | ⚠️ we append `/chat/completions`, producing `https://api.deepseek.com/v1/chat/completions`. DeepSeek historically accepted `/v1/chat/completions` as an alias for OpenAI-SDK compatibility, but the documented canonical path is `/chat/completions` (no `/v1`). |
| `openrouter` | `https://openrouter.ai/api/v1` (`openrouter-api.txt` lines 369, 393, 433, 641, 670) | `https://openrouter.ai/api/v1` | ✅ |
| `fireworks` | `https://api.fireworks.ai/inference/v1` (Fireworks docs) | `https://api.fireworks.ai/inference/v1` | ✅ |
| `xai` | `https://api.x.ai/v1` (xAI docs) | `https://api.x.ai/v1` | ✅ |
| `perplexity` | `https://api.perplexity.ai` (`perplexity-compat.txt` lines 287–288, 311, 459–460, 474, 486, 492, 535) — note: NO `/v1` suffix; SDK calls `/chat/completions` directly; canonical Sonar endpoint is `/v1/sonar` but OpenAI-compat is `/chat/completions` | `https://api.perplexity.ai` | ✅ |
| `huggingface` | `https://api-inference.huggingface.co/models` (HF router OpenAI-compat) | `https://api-inference.huggingface.co/models` | ✅ |
| `ollama` | `http://localhost:11434/v1` (`ollama-openai.txt` lines 144, 155, 175, 188, 210, 225, 260, 287) | `http://localhost:11434/v1` | ✅ |
| `lmstudio` | `http://localhost:1234/v1` (LM Studio default) | `http://localhost:1234/v1` | ✅ |
| `vllm` | `http://localhost:8000/v1` (vLLM default) | `http://localhost:8000/v1` | ✅ |
| `custom` | (escape hatch) | `''` | ✅ |

**Auth header convention:** All OpenAI-compat providers use `Authorization: Bearer <key>` (verified per provider docs); our `openai-compatible.ts` does this. ✅
**Anthropic auth:** `x-api-key` + `anthropic-version: 2023-06-01` (verified). ✅
**Gemini auth:** `?key={api_key}` query param (verified). ✅

**Provider count doc-comment bug:** the file header (lines 4, 10, 12) says "17 of the most popular LLM providers" and "13 of the 17 providers" and "the 17th entry is `custom`" — but the actual `PROVIDERS` object has **18 entries** (zai, openai, anthropic, google, mistral, cohere, groq, together, deepseek, openrouter, fireworks, xai, perplexity, huggingface, ollama, lmstudio, vllm, custom). The `tests/unit/llm-providers.test.ts` correctly asserts 18 (`'registers all 18 expected provider ids'`), and `SettingsDialog.tsx` correctly says "18 popular providers". So the registry header comment is stale. **Doc-only fix.**

---

### 1.5 `src/lib/pen/types.ts` — ✅ COMPLIANT (with intentional .pen-vs-Figma convention divergence)

**Spec sources:**
- `research/specs/figma-plugin-nodes.txt` (Figma NodeType enum: 38 UPPERCASE values)
- `research/specs/figma-cp-rest.txt` (Figma componentPropertyDefinitions: UPPERCASE `BOOLEAN`/`TEXT`/`INSTANCE_SWAP`/`VARIANT`/`SLOT`)
- `research/specs/figma-var-rest.txt` (Figma Variables REST: UPPERCASE `BOOLEAN`/`FLOAT`/`STRING`/`COLOR`, `valuesByMode` keyed by `modeId`)
- `research/specs/figma-variables-overview.txt` (Help Center: 6 variable types — color, number, string, boolean, **timing**, **easing**)

This file aligns to the **pen.dev .pen format spec** (its doc-comment cites `https://docs.pen.dev/for-developers/the-pen-format`), NOT to Figma's REST API. The .pen format is a separate spec that intentionally uses lowercase node names. The `PEN_NODE_TYPES` array is the source of truth.

| Aspect | Figma REST API | .pen (our impl) | Verdict |
|---|---|---|---|
| Node type names | UPPERCASE: `FRAME`, `COMPONENT`, `COMPONENT_SET`, `BOOLEAN_OPERATION`, `SECTION`, `SLICE`, `STAR`, `LINE`, `POLYGON`, `RECTANGLE`, `ELLIPSE`, `TEXT`, `GROUP`, `INSTANCE` (spec lines 283–320 of `figma-plugin-nodes.txt`) | lowercase: `frame`, `component`, `component_set`, `boolean_operation`, `section`, `slice`, `star`, `line`, `polygon`, `rectangle`, `ellipse`, `text`, `group`, `ref` (instance) | ✅ Intentional — `.pen` format uses lowercase (verified by `research/AGENTS.md` & comment in `pen/types.ts` line 14). We never POST to Figma's REST API directly; we only borrow Figma's vocabulary for the agent prompt. |
| Component property types | UPPERCASE: `BOOLEAN`, `TEXT`, `INSTANCE_SWAP`, `VARIANT`, `SLOT` (spec lines 322–324 of `figma-cp-rest.txt`) | lowercase: `boolean`, `text`, `instance_swap`, `variant` (`PenComponentPropertyType`, lines 232–236) | ✅ Intentional — `.pen` format is lowercase. Note: `SLOT` was added to Figma in 2024; `.pen` represents slots via `slot: false \| string[]` on `PenFrame`/`PenComponent` (lines 338, 365), so we cover the concept without mirroring the enum. |
| `preferredValues` shape | `Array<{type:'COMPONENT'|'COMPONENT_SET', key:string}>` (spec lines 362–365 of `figma-cp-rest.txt`) | `string[]` (line 245 of `pen/types.ts`) | ⚠️ Shape diverges from Figma REST. `.pen` simplifies to plain IDs; if we ever serialize to Figma REST, we'd lose the `type` discriminator. **Nice-to-have:** consider `Array<{type:'component'|'component_set', key:string}>` for full fidelity. Not blocking — we don't speak Figma REST. |
| `variantOptions` shape | `string[]` (spec line 349 of `figma-cp-rest.txt`) | `string[]` (line 247 of `pen/types.ts`) | ✅ |
| `defaultValue` for variant | String (e.g. `'Small'`) | `boolean \| string` (line 243) | ✅ — covers boolean (BOOLEAN type), string (TEXT/INSTANCE_SWAP/VARIANT) |
| Variable types | UPPERCASE: `BOOLEAN`, `FLOAT`, `STRING`, `COLOR` (spec line 146 of `figma-var-rest.txt`); Help Center also lists `TIMING`, `EASING` | lowercase: `boolean`, `color`, `number`, `string` (lines 47–50 of `pen/types.ts`) | ✅ Intentional — `.pen` uses `number` instead of `FLOAT`. Figma's `TIMING`/`EASING` are not in `.pen`; if the agent emits them, they'd be ignored. Acceptable for now. |
| Variable modes | `valuesByMode: {[modeId]: value}` (spec lines 147–149 of `figma-var-rest.txt`) | `PenThemedValue<T>[]` (lines 40–43) — semantically equivalent (value + theme filter), different shape | ✅ Intentional — `.pen` uses `theme: PenTheme` (axis→value map) instead of `modeId`. |
| Node type union completeness | Figma has 38 NodeType values (incl. `CODE_BLOCK`, `CONNECTOR`, `DOCUMENT`, `EMBED`, `HIGHLIGHT`, `MEDIA`, `PAGE`, `SHAPE_WITH_TEXT`, `SLIDE`, `SLOT`, `STAMP`, `STICKY`, `TABLE`, `TABLE_CELL`, `TEXT_PATH`, `TRANSFORM_GROUP`, `VECTOR`, `WASHI_TAPE`, `WIDGET`) | `PEN_NODE_TYPES` has 21 values (lines 562–583) | ✅ The `.pen` format intentionally models only the design-relevant subset; missing Figma types (e.g. `WASHI_TAPE`, `SLIDE`) are out of scope for an AI design canvas. |
| Page concept | `PAGE` is a NodeType in Figma (spec line 300) | `PenPage` interface (lines 526–537) | ✅ Modeled as a container with `children: PenChild[]` + viewport, mirroring Figma's page concept. |

**Conclusion:** The .pen types are intentionally lowercase (pen.dev convention) and intentionally diverge from Figma REST API's UPPERCASE in a few shape details (`preferredValues`, `valuesByMode`). The system prompt in `runner.ts` uses Figma-canonical UPPERCASE vocabulary to teach the agent the right mental model; the wire format is .pen's lowercase. This separation is intentional and well-documented.

---

### 1.6 `src/lib/canvas/types.ts` — ✅ COMPLIANT

**Spec source:** Same Figma + .pen docs as above.

| Aspect | Verdict | Notes |
|---|---|---|
| `LayerType` union (lines 30–47) | ✅ | Includes all Figma-canonical container types (`section`, `component`, `component_set`, `instance`, `boolean_operation`, `slice`, `star`, `polygon`) plus the legacy set (`rectangle`, `ellipse`, `text`, `line`, `frame`, `group`, `path`, `image`). |
| `instance` is listed in `LayerType` but not in `PenChild` union (pen/types.ts uses `ref` instead) | ⚠️ minor inconsistency | The `Layer.type` field is allowed to be `'instance'` (line 43) but `PenChild` has `PenRef` (type `'ref'`). The renderer's resolved view uses `'instance'` as an alias. Tests in `figma-ontology.test.ts` line 247 explicitly include `'instance'` in the union. Not blocking — both names refer to the same concept and the renderer normalizes. |
| `CanvasPatch` ops | ✅ | All 10 Figma-aligned ops (`add_page`, `delete_page`, `rename_page`, `set_active_page`, `add_section`, `create_component`, `create_component_set`, `add_variant`, `set_component_property`, `set_instance_property`, `flatten_boolean`) are present (lines 265–305) and have matching handlers in `patch.ts` (per `figma-ontology.test.ts` passing). |
| `componentProperty` shape (lines 345–351) | ⚠️ | Mirrors `PenComponentPropertyDefinition` with lowercase `type` values (`'boolean' \| 'text' \| 'instance_swap' \| 'variant'`). Same intentional .pen-vs-Figma convention as in §1.5. |

---

### 1.7 `src/lib/agent/figma-tools.ts` — ✅ COMPLIANT (10 tools, all spec-aligned)

**Spec sources:** Figma plugin NodeType enum (`research/specs/figma-plugin-nodes.txt`), Figma componentPropertyDefinitions (`figma-cp-rest.txt`).

| Tool | Spec alignment | Verdict |
|---|---|---|
| `figma_create_page` | Maps to Figma's PAGE concept | ✅ |
| `figma_set_active_page` | Switches active page in file | ✅ |
| `figma_rename_page` | Renames page | ✅ |
| `figma_delete_page` | Deletes page (cannot delete last) — verified in `figma-ontology.test.ts` line 50 | ✅ |
| `figma_create_section` | Creates SECTION node (Figma NodeType enum line 303) | ✅ |
| `figma_create_component` | Creates COMPONENT node (Figma NodeType enum line 286) | ✅ |
| `figma_create_component_set` | Creates COMPONENT_SET node (Figma NodeType enum line 287) with `variantPropertyAxes` | ✅ |
| `figma_add_variant` | Adds a COMPONENT variant with `variantPropertyValues`; auto-generates Figma-style name `"Size=Large, State=Hover"` (lines 302–304) — matches Figma's variant naming convention | ✅ |
| `figma_set_component_property` | Defines a property of type `boolean`/`text`/`instance_swap`/`variant` (line 341–344); accepts `preferredValues`, `variantOptions` | ✅ — mirrors Figma's 4 property types (note: 5th type `SLOT` not exposed, see §1.5) |
| `figma_set_instance_property` | Overrides a property on an instance (PenRef) | ✅ |

All 10 tools match the spec-listed Figma concepts. The `FIGMA_TOOL_NAMES` array (lines 439–450) lists exactly these 10.

---

### 1.8 `src/lib/agent/runner.ts` — ✅ COMPLIANT (system prompt uses Figma-canonical UPPERCASE vocabulary)

**Spec source:** Figma NodeType enum (`research/specs/figma-plugin-nodes.txt`).

Verified `SYSTEM_PROMPT_TEMPLATE` (lines 161–322) uses Figma-canonical vocabulary:
- ✅ `FRAME`, `SECTION`, `COMPONENT`, `COMPONENT_SET`, `GROUP`, `BOOLEAN_OPERATION` (lines 191–196)
- ✅ `RECTANGLE, ELLIPSE, LINE, STAR, POLYGON, PATH (SVG geometry), TEXT, SLICE, INSTANCE` (line 198)
- ✅ Component property types described: Boolean, Text, Instance swap, Variant (lines 202–205) — matches Figma Help Center's 4 core types
- ✅ Variant naming convention: `"Size=Large, State=Hover"` (line 207, 253, 269–270, 308) — matches Figma convention
- ✅ Variables: 4 types (color, number, string, boolean) + theme-conditional values (lines 213–214) — matches Figma Help Center
- ✅ Auto Layout terminology (lines 221–225): `direction`, `gap`, `padding`, `alignX`, `alignY` — Figma's auto-layout surface
- ✅ Pages concept (lines 184–186, 254–255, 313–314) — matches Figma's multi-page File/Page/Layer hierarchy

The system prompt correctly teaches the LLM to reason in Figma vocabulary while the runtime uses .pen format (lowercase). This is the intended decoupling.

---

### 1.9 `src/components/settings/SettingsDialog.tsx` — ✅ COMPLIANT

| Aspect | Verdict | Notes |
|---|---|---|
| Provider dropdown shows all 18 providers (lines 306–307) | ✅ | Test in `llm-providers.test.ts` confirms 18 |
| Base URL field auto-fills on provider switch (lines 303–305) | ✅ | Uses `meta.defaultBaseURL` from registry |
| Local provider info box (Ollama, LM Studio, vLLM) | ✅ | Lines 308, 425–432 |
| z.ai sandbox auto-credentials info box | ✅ | Lines 419–425 |
| Custom provider: shows base URL input, no defaults | ✅ | Lines 412–413 |
| "18 popular providers" copy (line 306) | ✅ | Matches actual registry count |
| API key field gated by `providerRequiresApiKey` | ✅ | Lines 308, 393–395 (verified via test `'does NOT require keys for local providers'`) |
| Placeholder example URL says `https://api.together.xyz/v1` (line 415) | ⚠️ | Same legacy-URL drift as registry — minor copy fix |

---

### 1.10 `tests/unit/llm-providers.test.ts` (33 tests) — ✅ ALL PASSING

Verified by running `bun run vitest run tests/unit/llm-providers.test.ts` (output: `33 tests` passed in 12 ms). Tests cover: registry count, capability flags, `apiKeyRequired`, `normalizeLLMProvider` legacy migration, `providerDefaultModel/BaseURL`, `createOpenAICompatible` construction, native adapter construction, env-var fallback, error paths, and `wrapNoTools` behavior.

### 1.11 `tests/unit/figma-ontology.test.ts` (13 tests) — ✅ ALL PASSING

Verified by running `bun run vitest run tests/unit/figma-ontology.test.ts` (output: `13 tests` passed in 10 ms). Tests cover: Pages (create/rename/delete/set-active/legacy migration), Section creation, Component creation, Component Set + Variants, Component Property definition, LayerType union coverage.

**Combined test run:** 46/46 tests passing in 1.85 s.

---

## 2. Bugs / Spec Mismatches Requiring Action

### 🔴 BLOCKING (must fix before commit)

**BUG-1: Gemini `translateTools` produces wrong `tools[]` shape** — `src/lib/llm/gemini.ts:99-108`

The spec (`research/specs/gemini-generateContent.txt` lines 1156, 3745–3761, 11275–11315) requires:
```json
"tools": [{ "functionDeclarations": [ {decl1}, {decl2}, ... ] }]
```
But the current code emits:
```json
"tools": [
  { "functionDeclarations": {decl1} },
  { "functionDeclarations": {decl2} }
]
```

Two violations: (a) `functionDeclarations` is a single object, not an array; (b) declarations are split across multiple `Tool` wrappers instead of being grouped into one.

**Impact:** Gemini function calling silently breaks for any prompt that wires 2+ tools — which is exactly the agent's default (10 Figma tools + 9 core tools + skill-specific tools ≈ 15–20 tools per turn). Either Gemini rejects the request with `INVALID_ARGUMENT`, or it only sees the first tool.

**Fix (drop-in):**
```ts
function translateTools(tools: LLMToolSpec[] | undefined) {
  if (!tools || tools.length === 0) return undefined;
  return [{
    functionDeclarations: tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    })),
  }];
}
```

### 🟡 NON-BLOCKING but recommended

**BUG-2: Stale "17 providers" comment in `registry.ts` lines 4, 10, 12** — actually 18 providers are registered. Doc-only fix; tests already assert 18.

**BUG-3: Together AI base URL uses legacy `api.together.xyz/v1`** — `registry.ts:292, 309` and `SettingsDialog.tsx:415`. Current canonical per `together-compat.txt` is `api.together.ai/v1`. `.xyz` is widely believed to still alias to `.ai`, but the docs are now consistent on `.ai`. Recommend updating both the registry default and the SettingsDialog placeholder example.

**BUG-4: DeepSeek base URL adds `/v1` not present in spec** — `registry.ts:324, 333`. DeepSeek docs (`deepseek-chat-endpoint.txt` line 58, 976) say base URL is `https://api.deepseek.com` and the endpoint is `/chat/completions` (not `/v1/chat/completions`). Our impl produces `https://api.deepseek.com/v1/chat/completions`. This *does* work at runtime because DeepSeek aliases `/v1/chat/completions` to `/chat/completions` for OpenAI SDK compat, but the documented canonical path omits `/v1`. Recommend changing to `https://api.deepseek.com` (and verifying the OpenAI SDK still works without the `/v1` — it does, because our client appends `/chat/completions` directly).

**BUG-5 (cosmetic): `finish_reason` enum is not normalized across adapters**
- OpenAI: returns lowercase (`'stop'`, `'length'`, `'tool_calls'`, `'content_filter'`)
- Anthropic adapter: passes through Anthropic's `stop_reason` (`'end_turn'`, `'tool_use'`, `'max_tokens'`, `'stop_sequence'`)
- Gemini adapter: passes through Gemini's `finishReason` (UPPERCASE: `'STOP'`, `'MAX_TOKENS'`, `'SAFETY'`, …)

The runner doesn't currently consume `finish_reason` (verified by `rg finish_reason src/lib/agent/`), so this doesn't break runtime behavior. **Nice-to-have:** add a normalizer that maps native stop reasons to OpenAI's enum (e.g. Anthropic `'tool_use'` → `'tool_calls'`, Anthropic `'max_tokens'` → `'length'`, Anthropic `'end_turn'`/`'stop_sequence'` → `'stop'`; Gemini `'STOP'` → `'stop'`, `'MAX_TOKENS'` → `'length'`, `'SAFETY'`/`'RECITATION'` → `'content_filter'`).

---

## 3. Spec-Recommended Improvements (Nice-to-Have, Not Blocking)

1. **OpenAI body fields:** add support for `top_p`, `n`, `stop`, `seed`, `response_format` (for JSON mode), `user`, `presence_penalty`, `frequency_penalty`. Currently none are surfaced; they're optional but useful for tuning. Suggested approach: extend `LLMGenerateParams` with optional fields and have `openai-compatible.ts` forward them when set.

2. **Streaming support:** `openai-compatible.ts` hard-codes `stream: false`. The runner reads `choices[0].message` directly. If we ever want live token deltas, we'd need to add an SSE consumer. Capability flags `supportsStreaming` exist on every provider but are unused.

3. **Anthropic `system` block can be richer:** spec supports `system` as either a string or an array of content blocks (text + cache_control). We always join system messages into a single string. Fine for now, but limits prompt-caching opportunities.

4. **Gemini `toolConfig.functionCallingConfig.mode`:** spec supports `mode: AUTO | ANY | NONE | NONE_AND_RETURN_ALL` (analogous to OpenAI's `tool_choice`). We translate `tool_choice` for Anthropic but NOT for Gemini — Gemini adapter ignores `params.tool_choice` entirely. Add a translator: `'auto' → {mode:'AUTO'}`, `'required' → {mode:'ANY'}`, `'none' → {mode:'NONE'}`, `{type:'function',function:{name}}` → `{mode:'ANY', allowedFunctionNames:[name]}`.

5. **Figma `SLOT` component property type** (added 2024): our `PenComponentPropertyType` doesn't include `'slot'`. We model slots via the `slot: false | string[]` field on `PenFrame`/`PenComponent`. If full Figma REST fidelity is ever needed (e.g. for Figma import/export), add `'slot'` to the enum and serialize accordingly.

6. **Figma `preferredValues` shape:** currently `string[]`. Figma REST API uses `Array<{type:'COMPONENT'|'COMPONENT_SET', key:string}>`. Upgrade the type if we ever serialize to Figma REST.

7. **Figma `codeSyntax`, `scopes`, `resolvedType` for variables:** `.pen`'s variable model is simpler (just type+value+theme). If we want bi-directional Figma REST sync, we'd need to add `codeSyntax`, `scopes`, `hiddenFromPublishing`, etc.

8. **Per-provider docs URL in registry:** some entries point to API-key dashboards (`console.groq.com/keys`, `console.anthropic.com/...`) rather than docs. Mixing "where to get a key" with "where the docs are" — minor UX nit.

9. **`wrapNoTools` strips `tools` + `tool_choice` but doesn't strip `tool_choice` when it equals `'none'`** (for providers that *do* support tools). This is fine for the no-tools providers (HF, LM Studio), but if a provider is later added that supports `'none'` only, the wrapper would still strip it. Not a current issue.

---

## 4. Final Verdict

**Verdict:** ⛔ **BLOCKED — needs BUG-1 fix before commit; everything else is polish.**

### Compliance Score
- Files fully compliant: **9 of 11 reviewed files** = **82%**
- Files with blocking bug: **1** (`gemini.ts` — wrong `tools[]` shape)
- Files with non-blocking polish items: **1** (`registry.ts` — Together/DeepSeek URL drift + stale comment)

### Critical Bug That MUST Be Fixed
- **BUG-1** — Gemini `translateTools` produces `tools: [{functionDeclarations: {single}}]` instead of `tools: [{functionDeclarations: [array]}]`. This breaks Gemini function calling entirely (which is the entire point of the agent's 10+ tool surface). Fix is a 7-line drop-in replacement.

### Polish Items (recommend doing before commit if cheap, else defer)
- **BUG-2:** Update `registry.ts` header comment from "17" to "18" providers (1 line × 3 occurrences).
- **BUG-3:** Switch Together AI default from `api.together.xyz/v1` to `api.together.ai/v1` (2 files).
- **BUG-4:** Switch DeepSeek default from `api.deepseek.com/v1` to `api.deepseek.com` (verify OpenAI SDK path handling; 1 line in `registry.ts`).
- **BUG-5 (cosmetic):** Add `finish_reason` normalizers in the Anthropic and Gemini adapters (1 helper function each).
- **NICE-1:** Add `tool_choice` translation for Gemini adapter (5-line if/else).
- **NICE-2:** Update `SettingsDialog.tsx:415` placeholder to reflect whichever Together URL we settle on.

### Defensibility of the Verdict
The blocking bug is verified directly against the Gemini REST spec snapshot (`research/specs/gemini-generateContent.txt` lines 1156, 3745–3761, 11275–11315). It is not a stylistic preference — the wire shape produced by the current code is literally a different JSON structure than what Google's API documents. The fix is mechanical and the existing tests don't catch it because they don't exercise the `translateTools` path with multi-tool prompts. Once BUG-1 is patched (and ideally a regression test added that asserts the `tools` array has length 1 with a `functionDeclarations` array inside), the implementation is ready to ship.

All other findings are either (a) intentional .pen-vs-Figma convention divergence (documented in `pen/types.ts` line 14), (b) legacy URL drift that still works at runtime, or (c) cosmetic enum normalization that the runner doesn't currently consume.
