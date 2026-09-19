# AGENTS.md — `src/lib/design-systems/`

## Purpose

Opinionated, named, ready-to-use design-system packs for agent-driven UI generation. The agent picks a fully-formed pack instead of inventing palette/typography/spacing on each regeneration — every pack is a folder of W3C-aligned CSS tokens (3 layers: primitive → semantic → component) plus a `registry.json` entry telling the agent exactly what to import.

## Ownership

- `types.ts` — TypeScript types (`Pack`, `Registry`, pack detail / summary shapes, `PackSummary`, `PackDetail`).
- `registry.json` — Index of all packs + the `defaultPack` field. Each entry: id, label, palette, dependencies, importMap, fontStack, sampleComponents, tags.
- `loader.ts` — server-side loader (fs + cache): reads + parses `registry.json` + each pack's `tokens.css`.
- `agent-helper.ts` — `buildDesignSystemQuestion()` — emits the `ask_user_question` payload that lists the packs.
- `index.ts` — public exports.
- `packs/` — five ready-to-use packs, each a single `tokens.css`:
  - `shadcn-default/` — Indigo, neutral, editorial.
  - `vercel-geist/` — Black/white, monochrome, square corners.
  - `mantine-default/` — Warm gray, enterprise.
  - `radix-themes/` — Indigo on cool gray, soft tinted panels.
  - `tailwind-catalyst/` — Zinc neutrals, ink-black buttons, 8px radii.

## Local Contracts

### Iron rule

No hardcoded colors, spacing, or typography in agent-generated code — everything goes through `var(--*)` from a pack's `tokens.css`. The agent's per-className guidance requires `var(--color-bg)`, `var(--color-border-default)`, etc.; zero hardcoded hex values.

### Folder structure

```
src/lib/design-systems/
├── types.ts                # TypeScript types (Pack, Registry, etc.)
├── registry.json           # Index of all packs, defaultPack field
├── loader.ts               # Server-side loader (fs + cache)
├── agent-helper.ts         # buildDesignSystemQuestion() for ask_user_question
├── index.ts                # Public exports
└── packs/
    ├── shadcn-default/      └── tokens.css
    ├── vercel-geist/         └── tokens.css
    ├── mantine-default/      └── tokens.css
    ├── radix-themes/         └── tokens.css
    └── tailwind-catalyst/    └── tokens.css
```

### HTTP API

| Endpoint | Method | Returns |
|----------|--------|---------|
| `/api/design-systems` | GET | `PackSummary[]` (name, palette, fonts, tags, isDefault) |
| `/api/design-systems/[name]` | GET | `PackDetail` (above + dependencies, importMap, sampleComponents, tokensCss) |
| `/api/design-systems/[name]/tokens` | GET | `text/css` — raw tokens.css |

### Agent usage flow

1. User asks "Build me a SaaS dashboard" → agent calls `ask_user_question` with options from `buildDesignSystemQuestion()`.
2. User picks a pack → agent loads `packs/<name>/tokens.css` + the matching `registry.json` entry (importMap, fontStack, dependencies).
3. Agent verifies font/dep packages are installed; falls back to `shadcn-default` with a warning when missing.
4. Generated `Dashboard.tsx` references only `var(--*)` tokens + uses the `importMap` imports — zero hardcoded hex.

## Work Guidance

- Adding a new pack: create `packs/<pack-name>/tokens.css` with the three-layer structure (primitive → semantic → component), add a `registry.json` entry (palette, dependencies, importMap, fontStack, sampleComponents), and re-run the loader test.
- Cap is 7 packs max — archive low-usage packs to `design-systems/_archived/` before exceeding it.
- Token files are CSS-only — no JS, no `@import` of remote URLs, no font `<link>` tags.

## Verification

- `bun run test tests/unit/design-systems.test.ts` — verifies the loader picks up every pack listed in `registry.json` + token shape invariants.
- Manual: `GET /api/design-systems` returns the 5 packs; `GET /api/design-systems/vercel-geist` returns the tokens.css inline.
- Manual: prompt the agent to build a dashboard → confirm the generated JSX uses only `var(--*)` references.

## Mistakes & Lessons

### Failure Modes

- Check that the agent's generated className references `var(--*)` from `tokens.css` — a hardcoded hex value in a regenerated component means a pack entry is missing or the system-prompt token guidance drifted.
- Check the pack cap (7 max) before adding a new pack — exceeding the cap without archiving breaks the loader contract test.

### Lessons Learned

- Run `tests/unit/design-systems.test.ts` after adding a pack — the loader test catches missing `registry.json` entries and malformed token files; the test is the only guard against silent drift.
- Do not duplicate token values across packs — each pack owns its palette end-to-end; cross-pack copy/paste creates divergence the next time one pack is updated.

## References

- W3C Design Tokens spec v2025.10 (stable Oct 28, 2025): https://www.w3.org/community/design-tokens/
- Vercel "AI-powered prototyping with design systems" (Aug 2025): https://vercel.com/blog/ai-prototyping-design-systems
- "Agentic Design Systems: The Complete Guide" (IDS): https://www.intodesignsystems.com/agentic-design-systems-the-complete-guide
- Shreyas Prakash "My agentic engineering workflow": https://shreyasprakash.com/post/agentic-engineering-workflow
- kaelig.fr "Building design system components with agent teams" (Apr 2026)

## Child DOX Index

No child AGENTS.md files. The `packs/` folder is a flat collection of single-file pack directories; it has no separate contract.
