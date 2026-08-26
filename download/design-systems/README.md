# Design System Registry

Opinionated, named, ready-to-use design-system packs for agent-driven UI generation.

## Why this exists

When an agent generates a UI without a pinned design language, it invents a palette, picks fonts by feel, and hardcodes spacing values. Each regeneration drifts. This registry fixes that by giving the agent a small set of fully-formed design-system packs to pick from — every pack is a folder of W3C-aligned CSS tokens plus a `registry.json` entry that tells the agent exactly what to import.

**The iron rule (per kaelig.fr agent-team pattern):** no hardcoded colors, spacing, or typography — everything goes through CSS custom properties from `tokens.css`.

## Folder structure

```
design-systems/
├── _registry.schema.json     # JSON Schema for a pack entry
├── registry.json             # Index of all packs, defaultPack field
├── README.md                 # This file
├── shadcn-default/
│   └── tokens.css            # Three layers: primitive → semantic → component
├── vercel-geist/
│   └── tokens.css
└── mantine-default/
    └── tokens.css
```

## The three token layers

Each `tokens.css` follows the Shreyas Prakash pattern (three layers):

1. **Primitive** — raw values, no semantic meaning. e.g. `--indigo-500: #3b82f6`.
2. **Semantic** — role-bound aliases. e.g. `--color-accent: var(--indigo-500)`.
3. **Component** — component-scoped. e.g. `--button-bg-primary: var(--color-accent)`.

The agent only ever references layer 2 (semantic) or layer 3 (component) in generated code. Layer 1 (primitive) exists so a pack maintainer can re-skin the entire system by editing one block.

## How the agent uses it

```
User: "Build me a SaaS dashboard"
  ↓
Agent: AskUserQuestion → "Which design system?"
  Options: shadcn-default, vercel-geist, mantine-default
  ↓
User picks: vercel-geist
  ↓
Agent loads:
  1. design-systems/vercel-geist/tokens.css      → injects into app/globals.css
  2. registry.json → packs[vercel-geist]        → knows importMap, fontStack, dependencies
  3. Verifies dependencies (geist, tailwindcss) installed; if missing, falls back to shadcn-default
  ↓
Agent generates Dashboard.tsx:
  - Every className references var(--color-bg), var(--color-border-default), var(--radius-button)
  - Zero hardcoded hex values
  - Uses importMap: `import { Button } from 'geist/button'`
```

## Adding a new pack

1. Create `design-systems/<pack-name>/tokens.css` with the three-layer structure.
2. Add a new entry to `registry.json` with palette, dependencies, importMap, fontStack, sampleComponents.
3. Validate against `_registry.schema.json` (use `ajv` or any JSON Schema validator).
4. Cap: registry holds 7 packs max. Archive low-usage to `design-systems/_archived/`.

## Versioning

Each pack entry has its own semver. Bump when:
- **major**: token names renamed or removed (breaks generated code).
- **minor**: new tokens added (non-breaking).
- **patch**: value-only changes (e.g. `--color-accent` from #3b82f6 to #2563eb).

## References

- W3C Design Tokens spec (v2025.10, stable Oct 28, 2025): https://www.w3.org/community/design-tokens/
- Vercel "AI-powered prototyping with design systems" (Aug 2025): https://vercel.com/blog/ai-prototyping-design-systems
- "Agentic Design Systems: The Complete Guide" (IDS): https://www.intodesignsystems.com/agentic-design-systems-the-complete-guide
- Shreyas Prakash "My agentic engineering workflow": https://shreyasprakash.com/post/agentic-engineering-workflow
- kaelig.fr "Building design system components with agent teams" (Apr 2026)
