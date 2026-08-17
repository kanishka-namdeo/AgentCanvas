# docs/ README — AgentCanvas Reference Documentation

This directory contains the **authoritative reference documentation** for
AgentCanvas's design ontology, file format, and agentic tool surface. It is
the single source of truth that engineers, AI agents, and contributors should
consult before touching `src/lib/canvas/`, `src/lib/pen/`, or
`src/lib/agent/`.

## Documents

| File | Audience | Purpose |
| --- | --- | --- |
| [`glossary.md`](./glossary.md) | Everyone | Plain-language definitions of every Figma / design-tool term used in the codebase. Read this first. |
| [`figma-ontology.md`](./figma-ontology.md) | Engineers, AI agents | The canonical mapping between Figma's REST/Plugin API node types, traits, paints, effects, and our internal types. Cite this whenever you need to know *what something is called in Figma* and *what we call it here*. |
| [`cross-tool-matrix.md`](./cross-tool-matrix.md) | Engineers, migration authors | Side-by-side comparison of how the same concept is named in Figma, Penpot, Sketch, tldraw, the W3C Design Tokens spec, and our `.pen` format. Use this when designing import/export. |
| [`pen-spec-v2.md`](./pen-spec-v2.md) | Engineers, file-format maintainers | The authoritative .pen v2.0 file-format specification. Mirrors pen.dev where applicable and extends with Figma-aligned ontology (Components, Variants, BooleanOps, Variables/Modes, Constraints). |
| [`tool-catalog.md`](./tool-catalog.md) | AI-agent prompt engineers, tool authors | The complete catalog of agent tools — names, schemas, semantics, examples. The agent's system prompt in `src/lib/agent/runner.ts` is generated from this catalog. |
| [`architecture.md`](./architecture.md) | Engineers | How the runtime pieces fit: Zustand stores, patch pipeline, .pen resolver, agent loop, Socket.IO fanout. Read before refactoring. |

## How these docs are maintained

1. **Source of truth** for the file format is `src/lib/pen/types.ts`.
   If you change a type there, you MUST update `pen-spec-v2.md` in the same
   PR. CI does not enforce this yet — be disciplined.
2. **Source of truth** for the tool surface is `src/lib/agent/tools.ts`.
   If you add/rename/remove a tool, you MUST update `tool-catalog.md`.
3. **Source of truth** for Figma term mapping is the
   `figma/rest-api-spec` OpenAPI YAML cached at
   `research/figma-ontology/openapi-figma.yaml`. If you suspect our
   mapping is stale, re-fetch that file and re-diff.
4. All docs are written in GitHub-flavored Markdown so they render
   inline on github.com. No PDF / DOCX derivatives are kept in this
   folder — generate those on demand from the markdown source.

## Quick links into the spec

- I want to know what a `FrameNode` is in Figma → [`figma-ontology.md#framenode`](./figma-ontology.md#framenode)
- I want to know how `.pen` encodes Auto Layout → [`pen-spec-v2.md#auto-layout`](./pen-spec-v2.md#auto-layout)
- I want to know which tool creates a Component Instance → [`tool-catalog.md#pen_create_instance`](./tool-catalog.md#pen_create_instance)
- I want to know what `alignItems` means in Penpot vs Figma → [`cross-tool-matrix.md#auto-layout`](./cross-tool-matrix.md#auto-layout)
- I want a one-line definition of "Boolean Operation" → [`glossary.md#boolean-operation`](./glossary.md#boolean-operation)
