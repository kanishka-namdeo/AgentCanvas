# Design-System Registry

Opinionated, named, ready-to-use design-system packs for agent-driven
UI generation in AgentCanvas.

## Why this exists

When the agent generates UI without a pinned design language, it
invents a palette, picks fonts by feel, and hardcodes spacing. Each
regeneration drifts. This registry gives the agent a small set of
fully-formed packs to pick from — every pack is a folder of
W3C-aligned CSS tokens (3 layers: primitive → semantic → component)
plus a `registry.json` entry telling the agent exactly what to
import.

**Iron rule**: no hardcoded colors, spacing, or typography —
everything goes through `var(--*)` from `tokens.css`.

## Folder structure

```
src/lib/design-systems/
├── types.ts                # TypeScript types (Pack, Registry, etc.)
├── registry.json           # Index of all packs, defaultPack field
├── loader.ts               # Server-side loader (fs + cache)
├── agent-helper.ts         # buildDesignSystemQuestion() for ask_user_question
├── index.ts                # Public exports
└── packs/
    ├── shadcn-default/      # Indigo, neutral, editorial
    │   └── tokens.css
    ├── vercel-geist/       # Black/white, monochrome, square corners
    │   └── tokens.css
    ├── mantine-default/   # Warm gray, enterprise
    │   └── tokens.css
    ├── radix-themes/      # Indigo on cool gray, soft tinted panels
    │   └── tokens.css
    └── tailwind-catalyst/ # Zinc neutrals, ink-black buttons, 8px radii
        └── tokens.css
```

## API

| Endpoint | Method | Returns |
|----------|--------|---------|
| `/api/design-systems` | GET | `PackSummary[]` (name, palette, fonts, tags, isDefault) |
| `/api/design-systems/[name]` | GET | `PackDetail` (above + dependencies, importMap, sampleComponents, tokensCss) |
| `/api/design-systems/[name]/tokens` | GET | `text/css` — raw tokens.css |

## How the agent uses it

```
User: "Build me a SaaS dashboard"
  ↓
Agent: calls `ask_user_question` with options from
       `buildDesignSystemQuestion()` (shadcn/ui / Vercel Geist / Mantine /
       Radix Themes / Tailwind Catalyst)
  ↓
User picks: Vercel Geist
  ↓
Agent loads:
  1. src/lib/design-systems/packs/vercel-geist/tokens.css → injects into globals
  2. registry.json → packs[vercel-geist] → importMap, fontStack, dependencies
  3. Verifies `geist`, `tailwindcss` installed; if missing → fallback to
     shadcn-default with a warning
  ↓
Agent generates Dashboard.tsx:
  - Every className references var(--color-bg), var(--color-border-default), etc.
  - Zero hardcoded hex values
  - Uses importMap: `import { Button } from 'geist/button'`
```

## Adding a new pack

1. Create `src/lib/design-systems/packs/<pack-name>/tokens.css` with
   the three-layer structure (primitive → semantic → component).
2. Add a new entry to `registry.json` with palette, dependencies,
   importMap, fontStack, sampleComponents.
3. Re-run `bun run test src/__tests__/design-systems.test.ts` to
   verify the loader picks it up.
4. Cap: 7 packs max. Archive low-usage to `design-systems/_archived/`.

## References

- W3C Design Tokens spec v2025.10 (stable Oct 28, 2025):
  https://www.w3.org/community/design-tokens/
- Vercel "AI-powered prototyping with design systems" (Aug 2025):
  https://vercel.com/blog/ai-prototyping-design-systems
- "Agentic Design Systems: The Complete Guide" (IDS):
  https://www.intodesignsystems.com/agentic-design-systems-the-complete-guide
- Shreyas Prakash "My agentic engineering workflow":
  https://shreyasprakash.com/post/agentic-engineering-workflow
- kaelig.fr "Building design system components with agent teams" (Apr 2026)
