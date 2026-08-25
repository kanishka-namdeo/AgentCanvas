# R2 Research: Figma's Agent-Facing Tooling Surfaces

**Task ID:** R2 · **Type:** Web research (no project code touched)
**Scope:** Figma Dev Mode MCP Server, Semantic Layer, Figma Make, First Draft, Figma AI canvas features, REST API, Code Connect — as a reference for aligning our canvas-app agent tools with Figma's conventions.
**Method:** ~20 targeted web searches + ~20 full-page fetches (developers.figma.com, help.figma.com, figma.com/blog, corroborating community sources). Raw JSON snapshots saved alongside this file (`r2-*.json`).

> **Dating note:** Figma's tooling evolves fast. Sources fetched reflect documentation current to early–mid 2026. Tool names below are spelled exactly as they appear in the official "Tools and prompts" page (developers.figma.com/docs/figma-mcp-server/tools-and-prompts).

---

## 1. Figma Dev Mode MCP Server — overview & timeline

| Date | Event |
|---|---|
| Jun 4, 2025 | Beta launch of "Dev Mode MCP server" (blog: *Introducing our MCP server*). Desktop-app-only, local server, "three tools… one for code, another for images, and a third for variable definitions" (+ `get_metadata`). Available to any Dev or Full seat. |
| H2 2025 | Remote server at `https://mcp.figma.com/mcp` (HTTP transport + OAuth) becomes the recommended path; tool renames: `get_code` → `get_design_context` (confirmed by Figma forum staff reply, Oct 2025), `get_image` → `get_screenshot`; Code Connect map tools added. |
| Feb–Mar 2026 | Code-to-canvas (`generate_figma_design`) generalizes; write-to-canvas via `use_figma` announced (*Agents, meet the Figma canvas*, Mar 24, 2026); skills ecosystem launched. |
| May 20, 2026 | First-party Figma design agent on the canvas (left rail); First Draft folded into it. |

### 1.1 Hosting models

- **Remote server (recommended):** Figma-hosted endpoint **`https://mcp.figma.com/mcp`** using streamable **HTTP** transport (not stdio). Setup per client:
  - Claude Code: `claude mcp add --transport http figma https://mcp.figma.com/mcp` (or plugin `claude plugin install figma@claude-plugins-official`)
  - Codex: `codex mcp add figma --url https://mcp.figma.com/mcp`
  - VS Code `mcp.json`: `{"servers":{"figma":{"url":"https://mcp.figma.com/mcp","type":"http"}}}`
  - Cursor: deep-link install; Xcode 27 beta: plugin or GitHub `figma/mcp-server-guide`
  - **OAuth flow:** client → `/mcp` → "Authenticate" → browser "Allow Access" → token cached by client. Remote server available on **all seats and plans**; only clients listed in the Figma MCP Catalog may connect (waitlist for new clients).
  - Remote-only tools are marked "(remote only)" in the tool table below.
- **Desktop server (local, org/enterprise niche):** Runs inside the Figma desktop app; enable via Figma menu → Preferences → *Enable Dev Mode MCP Server* (requires Dev/Full seat on paid plans, Dev Mode on, file open). Local endpoints: **`http://127.0.0.1:3845/sse`** (original SSE) and current **`http://127.0.0.1:3845/mcp`**. **Selection-based prompting only works with the desktop server** (agent reads the user's current selection); the remote server is **link-based** — user must paste a frame/layer URL, from which the client extracts the `node-id`.

### 1.2 Node-ID selection requirement (both modes)

Official guidance: "Getting design context and code from files is link-based… Right-click a frame or layer → *Copy link to selection*… Your client won't be able to navigate to the URL, but it will extract the node ID that is required for the MCP server to identify which object to return information about." The agent never crawls the whole file by default; scope is always a node (`fileKey` + `nodeId`, e.g. `9:2`). `get_metadata` without a nodeId returns the document's page list (id + name) so the agent can drill down; invalid nodeIds also return the page list as a recovery path.

---

## 2. MCP tool inventory (current official list)

All spellings verified against developers.figma.com "Tools and prompts" (fetched this session). "(remote only)" = remote server only. Desktop = both unless noted.

### 2.1 Core read/context tools

| Tool | Key inputs | Output | When an agent should call it |
|---|---|---|---|
| `get_design_context` | `fileKey`, `nodeId` (required); `clientLanguages`, `clientFrameworks` (optional telemetry/telemetry-style params, e.g. `"dart"`, `"flutter"`); desktop variant historically accepted `clientName` (e.g. `"cursor"`) | **4-part response:** (1) reference code — React + Tailwind + TS intermediate representation with `data-name`/`data-node-id` attributes and `var(--token,fallback)` values; (2) screenshot of node; (3) embedded system prompt instructing the model to convert to target stack; (4) asset URLs (images/SVG, valid ~7 days). Code Connect mappings and variable code syntax are woven into the code output | Primary design→code tool. Call after `get_metadata` to drill into a specific subtree. Framework customization is via prompt ("generate in Vue / plain HTML+CSS / iOS") or Code Connect `clientFrameworks` |
| `get_metadata` | `nodeId` (optional) | Sparse **XML** outline: layer IDs, names, types, position, sizes. Without nodeId → page list (id+name) | First call for large/unknown files; cheap scaffold to pick nodeIds before calling `get_design_context`. Explicitly recommended for very large designs to control context size |
| `get_screenshot` | node/selection; `enableBase64Response` for inline base64 | PNG render of the selection (single node) | "Use when you need to visually inspect a design." Recommended ON by default (only disable for token limits). Preserves layout fidelity |
| `get_variable_defs` | nodeId | Variables + styles used in the selection (colors, spacing, typography) incl. names and values; surfaces variable **code syntax** if authored | Token fidelity: get exact token names (not raw hex) so generated code uses the design system |
| `get_code_connect_map` | selection; remote: `clientFrameworks`, `clientLanguages` | Map of instance nodeId → `{componentName, source, snippet, snippetImports, snippetNestedFunctions, version (source: Code Connect UI vs CLI), label (framework, e.g. React)}`; includes nested mapped components | Reuse real codebase components instead of generating look-alikes |
| `get_image` *(legacy name, June 2025 beta; now `get_screenshot`)* | nodeId | Rendered image of node (held in memory for the model) | Historical; renamed |
| `get_code` *(legacy name, June 2025 beta; renamed Oct 2025)* | `nodeId`, `clientLanguages` (e.g. `"kotlin"`), `clientFrameworks` (e.g. `"android,compose"`), `clientName` (e.g. `"cursor"`) | Code representation of node | Historical; renamed to `get_design_context` |

### 2.2 Write / create tools

| Tool | Notes |
|---|---|
| `use_figma` (remote only) | **General-purpose write tool**: create, edit, delete, inspect objects in Figma Design (pages, frames, components, variants, variables, styles, text, images), FigJam (boards, stickies, sections, connectors, shapes, tables, code blocks), Figma Slides (slides, layouts, text, images). Checks design system / existing content before creating from scratch. Free during beta; will become usage-based paid. Best used with skills: `figma-use`, `figma-use-figjam`, `figma-use-slides`. Works toward Plugin API parity (image support + custom fonts noted as next) |
| `generate_figma_design` (remote only, select clients) | **Code → canvas**: sends live web UI (production/staging/localhost) as design layers to new files, existing files, or clipboard. Capture toolbar: entire screen / select element / open file. Respects seat type; new files land in team drafts; needs edit perms for existing files. Exempt from standard MCP rate limits |
| `create_new_file` (remote only) | Blank Figma Design / FigJam / Figma Slides file in user's drafts ("create a new Figma file called 'Homepage Redesign'") |
| `generate_diagram` (remote only) | FigJam diagram from Mermaid syntax or natural language (agent synthesizes Mermaid). Types: flowchart, Gantt, state, sequence, architecture, ERD. New or existing FigJam file |
| `download_assets` (remote only) | Rendered exports (PNG/JPG/SVG/PDF, honors export settings, ~4096px cap at scale 1, defaultFormat/defaultScale 0.01–4x) **and** raw source images (original binaries, capped 20/call, `rawImagesTruncated` flag). Up to 20 nodes/call. Temporary URLs. Use to *deliver/transfer* assets (vs `get_screenshot` to *see*) |
| `upload_assets` (remote only) | Upload PNG/JPG/GIF/WebP (max 10MB each) into a file; as fill to a given node or as new frames. Pair with `download_assets` raw mode for cross-file transfer |

### 2.3 Design-system / library tools

| Tool | Notes |
|---|---|
| `get_libraries` (remote only) | Libraries subscribed by the file + available to add (community UI kits, org libraries) with name, library key, description, source type. Used with `search_design_system` |
| `search_design_system` (remote only) | Text search across connected libraries for components, variables, styles — "reuse existing design system elements rather than creating new ones from scratch" |
| `get_figjam` | FigJam diagram metadata as XML (like `get_metadata`) **plus screenshots** of nodes — e.g. turn architecture whiteboards into code context |
| `get_motion_context` | Keyframe animation data for animated selections: inventory of animated nodes, keyframe tracks with easing curves, pre-computed CSS `@keyframes` and motion.dev snippets, timeline coordination hints. `recursive: true` for descendants. Call after `get_design_context` with the same node id |
| `get_shader_effect` / `get_shader_fill` | Retrieve shader (effect/fill) by ID from `list_shader_*`; returns name, description, version, source-file manifest (filename, bytes, uri). Optional `version` = 40-char commit SHA |
| `list_shader_effects` / `list_shader_fills` | List shaders in the authenticated account library (id, name, description; `nextCursor` pagination) |
| `whoami` (remote only) | Authenticated user identity: email, plans, seat type per plan — lets agents check write permissions before acting |

### 2.4 Code Connect round-trip tools

| Tool | Notes |
|---|---|
| `add_code_connect_map` | Adds mapping nodeId → code component (improves design-to-code quality) |
| `get_code_connect_suggestions` | Figma-prompted tool call to suggest component mappings |
| `send_code_connect_mappings` | Figma-prompted confirmation of suggested mappings (after `get_code_connect_suggestions`) |
| `get_context_for_code_connect` (remote only) | Structured component metadata (properties w/ types, variant options, descendant instance/text tree with property references) for generating Code Connect templates. Intended for the `figma-code-connect` skill, not direct user invocation |

### 2.5 Figma Weave tools (media-generation workflows; separate Weave credits)

`weave_list_tools`, `weave_get_tool_inputs` (recipeId, optional version → inputs contract), `weave_upload_asset` (image/video/audio/3D → hosted URL), `weave_run_tool` (recipeId, inputs[{nodeId,value}], numberOfRuns 1–10, `acknowlededCost` gate → runIds; gating statuses `inputs_required` / `cost_confirmation_required`), `weave_get_tool_run_output` (poll run status RUNNING/COMPLETED/FAILED/CANCELED), `weave_cancel_tool_run`.

### 2.6 MCP prompt (not a tool)

- `create_design_system_rules` — server-provided **prompt** that generates a rules file so agents translate designs into codebase-aware frontend code (aligns design system + tech stack). Distinct from chat prompts; client support varies.

**Confidence:** tool names/descriptions = **High** (verbatim from official docs). `get_design_context` input schema = **Medium-High** (community reverse-engineering corroborated by official hints about `clientFrameworks`/`clientLanguages` params and docs note that these don't change output format). Legacy `get_code` body params = **Medium** (one dated community capture).

---

## 3. The "Semantic Layer" in Dev Mode MCP

**What it is.** Not a separate tool — a *preparatory discipline on the design file* that determines the quality of MCP output. Figma's docs ("Structure your Figma file for better code") and the Sept 2025 blog (*Why you should care about design context*) direct designers to:

1. **Use components** for anything repeated (buttons, cards, inputs, nav).
2. **Link components to real code with Code Connect** — "the #1 way to get consistent component reuse in code. Without it, the model is guessing."
3. **Use Figma variables as tokens** (spacing, color, radius, typography).
4. **Use clear, semantic names** for layers/components — replace `Frame1268`/`Group5` with `CardContainer`, `ProductImage`, `CTA_Button`. "This helps the model understand what it's working with, and what functionality it should have."
5. **Use Auto Layout** (communicates responsive intent; avoids absolute positioning).
6. **Use annotations** for behavior that visuals can't convey.
7. **Use dev resources** (links attached to layers).

**How it changes `get_code`/`get_design_context` output.** Figma's own A/B narrative ("poor / better / best" card example) shows the mechanism:
- Semantic layer names flow into the reference code as `data-name="EmailInput"` attributes and become the basis for component names (`function SocialButton(...)`) and CSS class names.
- Variable bindings flow into Tailwind arbitrary values as `bg-[var(--primary,#3b82f6)]` — token name + fallback value, so agents preserve tokens.
- Components + Code Connect collapse whole subtrees into real imports (`import { Button } from "components/Button"`).
- Auto Layout maps to `flex flex-col` / `gap-[16px]` instead of `absolute left-[24px] top-[476px]`.
- Figma's AI **Rename layers** feature exists specifically to produce this semantic layer cheaply ("Organize your file by giving all your layers meaningful names with a click").

**How agents use it.** The MCP server treats the semantic layer as *design intent metadata*: a screenshot alone would force the agent to guess ("a red rectangle" → which token?); variables tell it the exact token (`--brand-main`); Code Connect tells it the exact file path to import. Figma's blog: "Figma knows which specific token is used… Even better, if you have provided code syntax in Figma for that variable, the Figma MCP server can provide that exact code to the LLM."

---

## 4. Figma Make — prompt-to-app agent (2025)

**Product.** Announced Config 2025 (May 7, 2025): "prompt-to-app capability… from concept to functional prototype in just a few prompts." Prompt-to-code (not prompt-to-layers): generates a **working React web app** (Anthropic Claude Sonnet 4 at launch) inside a Figma Make file. Full seats on paid plans (others can try).

**Interface / loop model (documented):**
- Two primary areas: **AI chat** (prompt box; attach designs via + → *Attach design* by pasting a Figma URL, paste frames/components directly, add images/files; web search & URL fetch for grounding) and **preview** (running app) with a **code view**.
- **Agentic conversation:** front-load the first prompt (task, context, key design elements, expected behaviors, constraints); iterate with small follow-up prompts; break complex builds into per-element code folders.
- **Point-and-edit / edit tool:** select an element in the preview, then edit via toolbar (color, radius, spacing, typography) or prompt; newer Make adds a properties panel and **annotations** anchored to elements. `go to source` button jumps from element to its code; code edits reflect in preview instantly.
- **Checkpoints = version history:** every AI and manual edit is tracked; versions can be **previewed, favorited, or restored** (figma.com/make). This is Make's safety net — agent writes are always recoverable, no branches needed.
- **Code/design duality:** copy a preview snapshot **as design layers** into Figma Design for team iteration; Make → MCP lets coding agents pull Make code resources as context when moving prototype → production. Make kits can import npm packages, library variables/styles, and guidelines; templates set team guardrails. Optional backend for state/auth/secrets; publish to a URL or custom domain.
- **Skill guidance for agents:** the docs' skill set includes Make-oriented flows (e.g., `figma-generate-library` to create components from a codebase; Make resources surfaced to MCP clients).
- 2026 positioning: Design agent (canvas) generates design layers → send to Make for code-backed behavior → embed back in Design; or start in Make, copy frames to Design, iterate, send back.

**Note on "Agent tab":** current official docs describe Make as chat + preview + code; an explicit "Agent tab" UI element could **not** be confirmed in official sources (the term "Agent" in Figma docs refers to the separate May 2026 canvas agent). Treat "Make = conversational agent with checkpoints" as the accurate model.

## 5. First Draft (2024) — prompt-to-design

- Launched Config 2024 (June 2024) as **"Make Designs"**; temporarily disabled July 2024 (generated mocks too closely resembled existing apps); reintroduced Sept 24, 2024 as **First Draft**.
- **Mechanism:** off-the-shelf models (OpenAI GPT-4, Amazon Titan) + **Figma-built proprietary design system context** (mobile/desktop libraries of component "stacks"/building blocks) + user prompt. The AI *selects, arranges, and customizes library components* — it composes from a constrained kit, not free-form generation. Trained on no customer content.
- **Flow:** toolbar **Actions → First Draft** → pick library (four: wireframe, basic/higher-fidelity site/app libraries; auto-chosen if omitted) → prompt → **Make it** → theme thumbnails under the prompt → **Make changes** (prompt-based theme/content/structure edits + style sliders for color, border radius, spacing, typography; light/dark toggle). Output lands **as an editable frame on the canvas** — fully native Figma layers, editable like any design once Actions closes.
- Strong for common web/mobile patterns; weak outside them (book layouts, flyers). Cannot use your own design system (roadmap noted Material 3 proof-of-concept).
- **May 20, 2026:** First Draft folded into the Figma design agent ("re-prompting, deeper iteration, automated bulk edits, and live feedback").

## 6. Figma AI canvas features (Figma Design, via Actions menu)

| Feature | One-line purpose |
|---|---|
| First Draft | Prompt → editable wireframe/design composed from Figma libraries (now agent) |
| Find assets and designs (Visual Search) | Find designs across team/org/Community from a partial design, screenshot, or description |
| Rename layers (AI layer naming) | Batch-assign meaningful semantic layer names — directly feeds MCP codegen quality |
| Replace text/content | Swap placeholder or duplicate text with unique, realistic content |
| Rewrite/translate/shorten text (Auto translate) | Change tone, translate languages, fit text to bounds |
| Make prototypes (Add interactions) | Turn static designs into interactive prototypes via prompt |
| Make and edit images | Generate/edit images from a written prompt |
| Remove background | Isolate an image's main subject |
| Boost resolution | Upscale/sharpen low-res images |
| Expand images | Extend imagery beyond original borders (generative fill) |
| Isolate and erase objects | Select area → isolate as new layer or erase |
| Vectorize images | Raster → editable vector layers |
| Suggest Auto Layout | Add auto-layout structure to frames (Make prep guidance) |
| (2026) Figma design agent | Canvas-native agent: parallel prompts from any layer, bulk edits, design-system-aware generation (@-mention tokens/components), works while you edit |

Agent-adjacent: Rename layers, Suggest Auto Layout, Visual Search, annotations, and dev resources are all **context producers** for the MCP pipeline; the agent itself is the consumer/producer of edits.

## 7. REST API — agent-relevant endpoints (base `https://api.figma.com`, OAuth2 or access tokens)

| Endpoint | Purpose |
|---|---|
| `GET /v1/files/:key` | Full file JSON (node tree; supports `branch_data`, `since_version`, plugin/sharedPluginData params) |
| `GET /v1/files/:key/nodes?ids=` | Fetch specific nodes only — the REST analogue of node-scoped MCP reads |
| `GET /v1/images/:key?ids=&format=&scale=` | Server-render node exports (PNG/JPG/SVG/PDF) → temporary URLs |
| `GET /v1/files/:key/images` | Image fills: lists image fill refs + URLs for images used in file |
| `GET/POST /v1/files/:key/comments`, `DELETE /v1/files/:key/comments/:id` | Read/create/delete comments (mention fragments supported) |
| `GET /v1/files/:key/versions` | Version history metadata |
| `GET /v1/me` | Authenticated user |
| `GET /v1/teams/:team_id/projects`, `GET /v1/projects/:id/files` | Project/file discovery |
| `GET /v1/files/:key/components`, `GET /v1/components/:key` | Published components (library assets) |
| `GET /v1/files/:key/styles`, `GET /v1/styles/:key` | Published styles |
| Variables API | `GET /v1/files/:key/variables/local`, `GET …/variables/published`, `POST /v1/files/:key/variables` (create/update/delete variable collections & modes) |
| Dev Resources API | Manage dev resources attached to nodes (links surfaced in Dev Mode & webhooks) |
| Webhooks V2 | `POST/GET/PUT/DELETE /v2/webhooks` (no UI; API-only) |

**Webhook event types:** `PING`, `FILE_UPDATE` (fires after ~30 min edit inactivity — *not* per keystroke), `FILE_DELETE`, `FILE_VERSION_UPDATE` (named version created), `LIBRARY_PUBLISH` (per-asset-type events with created/modified/deleted components, styles, variables), `FILE_COMMENT` (comment create/resolve, fragments + mentions), `DEV_MODE_STATUS_UPDATE` (per-layer status NONE/READY_FOR_DEV/COMPLETED with node_id + related dev-resource links).

## 8. Code Connect (Dev Mode)

- Purpose: bridge codebase ↔ Dev Mode so Dev Mode and MCP show **true-to-production snippets** instead of autogenerated guesses. Org/Enterprise, Dev or Full seat. Two flavors: **CLI** (template files recommended) and **UI** (GitHub-linked, one-to-many mappings: one Figma component → React + SwiftUI + Compose + Vue implementations; framework labels like `React`).
- **Template files** (`.figma.ts`, framework-agnostic): `// url=https://www.figma.com/file/…/Button?node-id=123` header; `figma.selectedInstance`; `figma.code` template with prop bindings — `instance.getEnum('Size', {Large:'large',…})`, `instance.getBoolean('Disabled')`, `instance.getString('Text Content')`; `imports: ['import { Button } from "components/Button"']`; `id`. Legacy framework-specific parsers exist for React, HTML/Web Components, SwiftUI, Jetpack Compose, Storybook.
- MCP interplay: `get_code_connect_map` / `add_code_connect_map` / suggestions flow let agents **read and write** mappings; `clientFrameworks` on the remote server selects which framework's mappings are returned. For our reverse direction (canvas → code), Code Connect is Figma's answer to "make the canvas carry the code's identity."

## 9. Ten design principles for canvas-agent tools (distilled from Figma's choices)

1. **Scope every read to a node the user chose.** Figma requires selection (desktop) or a pasted link (remote) before any context leaves the file — the agent never ingests whole files by default. Prevents context blowup and anchors intent.
2. **Ship narrow, purpose-built tools, not one god-tool.** Screenshot, metadata, variables, code, motion, shaders, libraries are separate tools the model composes; each maps to a *type of context* ("the context we exclude is just as important as what we provide").
3. **Triangulate: code + image + structure.** `get_design_context` returns reference code AND a screenshot AND a system prompt AND asset URLs — "a screenshot combined with Figma's code outputs performs better than either on their own."
4. **Make the cheap outline the entry point.** `get_metadata` (sparse XML, or a page list with no nodeId) lets the agent navigate huge files incrementally, with built-in recovery paths (invalid id → page list).
5. **Bind tokens, don't hardcode values.** Variables surface as `var(--token, fallback)`; a screenshot of "red" is ambiguous, `--brand-main` is not. Preserve variable names through every transform.
6. **Let the file itself carry semantics.** Layer names, components, auto layout, annotations, and dev resources are first-class agent inputs; provide cheap tools (AI rename, suggest auto layout) that improve the semantic layer.
7. **Prefer reuse over generation.** `search_design_system` / `get_libraries` / Code Connect push agents to *find and import* existing components before creating new ones; `use_figma` "will first check your design system or existing file content before creating anything from scratch."
8. **Make agent writes recoverable and permission-aware.** Make checkpoints (preview/favorite/restore every AI edit), drafts-folder destinations for new files, `whoami` seat checks, OAuth-scoped remote access, and cost gates (`cost_confirmation_required`) before paid actions.
9. **Keep a bidirectional loop between canvas and code.** `generate_figma_design` (code→canvas) + `get_design_context` (canvas→code) + `use_figma` (agent edits) close the loop; design the round-trip, not one direction.
10. **Encode conventions as portable skills/rules, not prompts users retype.** MCP `create_design_system_rules` prompt, Make kits, and markdown skills (e.g. `/figma-use`) package workflow + conventions; the platform keeps tools generic and lets instructions specialize behavior — with self-healing loops (screenshot → compare → fix) built on real structure.

---

## Sources

**Official — developers.figma.com**
1. Tools and prompts (full tool list): https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts
2. Figma MCP Server Introduction: https://developers.figma.com/docs/figma-mcp-server
3. Set up the remote server (recommended): https://developers.figma.com/docs/figma-mcp-server/remote-server-installation
4. Structure your Figma file for better code: https://developers.figma.com/docs/figma-mcp-server/structure-figma-file
5. Code Connect Introduction: https://developers.figma.com/docs/code-connect/
6. Webhooks — Events: https://developers.figma.com/docs/rest-api/webhooks-events
7. REST API overview (base URL, endpoint groups): https://www.figma.com/developers/api ; Variables endpoints: https://developers.figma.com/docs/rest-api/variables-endpoints

**Official — help.figma.com**
8. Guide to the Figma MCP server: https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Figma-MCP-server
9. Explore Figma Make: https://help.figma.com/hc/en-us/articles/31304412302231-Explore-Figma-Make
10. Use First Draft with Figma AI: https://help.figma.com/hc/en-us/articles/23955143044247-Use-First-Draft-with-Figma-AI
11. Use AI tools in Figma Design: https://help.figma.com/hc/en-us/articles/23870272542231-Use-AI-tools-in-Figma-Design

**Official — figma.com/blog & marketing**
12. Introducing our MCP server (Jun 4, 2025): https://www.figma.com/blog/introducing-figma-mcp-server
13. Why you should care about design context (Sep 24, 2025): https://www.figma.com/blog/why-you-should-care-about-design-context
14. Agents, meet the Figma canvas (Mar 24, 2026): https://www.figma.com/blog/the-figma-canvas-is-now-open-to-agents
15. Building frontend UIs with Codex and Figma (Feb 26, 2026): https://www.figma.com/blog/introducing-codex-to-figma
16. The Figma design agent is here (May 20, 2026): https://www.figma.com/blog/the-figma-agent-is-here
17. Building a better First Draft for designers (Sep 24, 2024): https://www.figma.com/blog/figma-ai-first-draft
18. Config 2025 recap (Figma Make): https://www.figma.com/blog/config-2025-recap
19. 8 essential tips for using Figma Make (Jun 10, 2025): https://www.figma.com/blog/8-ways-to-build-with-figma-make
20. Figma Make product page (version history): https://www.figma.com/make

**Corroborating community**
21. get_code → get_design_context rename (Figma Forum staff): https://forum.figma.com/report-a-problem-6/figma-mcp-get-code-worked-good-but-get-design-context-doesn-t-work-at-all-46400
22. get_code request body (nodeId/clientLanguages/clientFrameworks/clientName): https://medium.com/@shubhambhama/connect-figma-to-cursor-ai-with-mcp-in-5-minutes-0c4794537fa3
23. get_design_context params & 4-part output: https://zenn.dev/yokkomystery/articles/932cacd7728188
24. Desktop server local endpoints 127.0.0.1:3845/sse & /mcp: https://haniwaman.com/figma-dev-mode-mcp ; https://github.com/github/copilot-cli/issues/2790 ; https://forum.cursor.com/t/160495
25. Figma MCP server-guide skills repo: https://github.com/figma/mcp-server-guide
