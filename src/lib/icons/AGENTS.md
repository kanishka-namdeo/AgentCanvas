# AGENTS.md — `src/lib/icons/`

## Purpose

The Lucide icon library runtime: a curated catalog (194 icons from `lucide-react@1.33.0` `__iconNode` data) plus pure helpers that map an icon NAME to its SVG child elements, search the catalog semantically, emit SVG strings (group + inline) for server-side render paths, and produce the LLM-facing prompt catalog used by `pen_search_icons` + the system prompt's ICON SYSTEM section. The .pen document stays SYMBOLIC — an icon Layer stores only `iconName` + `iconLibrary`; geometry attaches at render time from this registry.

## Ownership

- `lucide-registry.generated.ts` — GENERATED FILE (do not hand-edit). Source: `lucide-react@1.33.0` `__iconNode` data, curated by `scripts/generate-lucide-registry.ts`. Carries `LUCIDE_ICONS` (icon name → `LucideIconElement[]`), `LUCIDE_CATEGORIES`, `LUCIDE_ICON_KEYWORDS`, `LUCIDE_REGISTRY_SOURCE_VERSION`. Header stamps the content hash + icon/element counts so drift is one diff away.
- `index.ts` — the runtime surface (pure functions, SSR-safe, no React import):
  - Constants: `LUCIDE_VIEWBOX` (24), `LUCIDE_DEFAULT_STROKE_WIDTH` (2), `LUCIDE_ICON_NAMES` (sorted), `LUCIDE_ICON_COUNT`.
  - Lookup: `getLucideIcon(raw)` (normalizes spelling → `{ name, elements }`), `lucideIconElements(name)`, `lucideIconCategory(name)`, `lucideCategories()`.
  - Normalize: `normalizeIconName(raw)` — kebab-cases, strips `lucide-` prefix + `-icon` suffix.
  - Search: `searchLucideIcons(query, opts)` — word-level keyword scoring (`IconSearchMatch[]`).
  - Prompt catalog: `lucidePromptCatalog()` — the LLM-facing markdown list injected into the system prompt's ICON SYSTEM section.
  - SVG emitters: `lucideIconGroupSvg(...)` (group wrapper) + `lucideIconInlineSvg(...)` (inline svg string) for the resolver, export, resvg, and serialize paths.

## Local Contracts

- The registry is the single source of truth — never hardcode an icon's SVG path elsewhere. Components and tools reference icons by NAME; geometry is resolved here.
- The generated file is read-only at runtime — never mutate `LUCIDE_ICONS` from feature code; copy via the helper functions (`lucideCategories()` returns a fresh record so callers cannot mutate the registry).
- `LUCIDE_VIEWBOX = 24` and `LUCIDE_DEFAULT_STROKE_WIDTH = 2` are the assumed paint profile for every icon; recolor via `stroke` on the consumer side, not via registry mutation.
- Icon nodes in the canvas document store ONLY `iconName` + `iconLibrary` (`'lucide'`) — the Layer's geometry is derived from `getLucideIcon(name)` at render time, so files stay small and icons stay updatable by name.

## Work Guidance

- After bumping `lucide-react` in `package.json`: regenerate the registry with `npx tsx scripts/generate-lucide-registry.ts` (no package.json script alias; see `docs/lucide-icons.md`), then commit the regenerated `lucide-registry.generated.ts` together with the lockfile bump.
- When adding a new icon to the curated set: edit the generator script's allowlist (NOT the generated file), regenerate, and re-run the loader tests.
- When adding a new consumer of `getLucideIcon` (e.g. a new render path): prefer the SVG-string emitters (`lucideIconGroupSvg` / `lucideIconInlineSvg`) over re-implementing the SVG assembly; the consumer must keep the `LUCIDE_VIEWBOX` and `LUCIDE_DEFAULT_STROKE_WIDTH` profile.
- When the agent's `pen_search_icons` returns "no matches": check the keyword scoring in `searchLucideIcons` — word-level matching means a multi-word query (`"password security"`) scores against each word, not the literal phrase.

## Verification

- `bunx tsc --noEmit` — typecheck.
- `bun run test tests/unit/lucide-icons.test.ts` — registry shape + lookup/search/normalize invariants (when present).
- Manual: prompt the agent "create a login form with a lock icon" → confirm `pen_create_node` accepts `type:"icon"` + `icon:"lock"` and the canvas renders the Lucide glyph.
- Manual: `pen_search_icons("password security")` returns `lock` near the top.
- Content-hash check: the generated file's header (`Content hash: …`) must match a fresh generator run; mismatch means the committed file is stale.

## Mistakes & Lessons

### Failure Modes

- Check `lucide-registry.generated.ts` is regenerated after every `lucide-react` bump — a stale registry ships the OLD icon set under the NEW package version, and the only signal is the content-hash header.
- Check that a new icon is added to the generator script's allowlist, not hand-edited into the generated file — hand-edits are wiped on the next regeneration.
- Check that consumers use `LUCIDE_VIEWBOX = 24` + `LUCIDE_DEFAULT_STROKE_WIDTH = 2` — a different viewbox distorts the glyph; the registry's SVG paths are calibrated to this profile.

### Lessons Learned
- The .pen document stores icon identity symbolically (`iconName` + `iconLibrary`) — never serialize an icon's SVG path into the document. Geometry resolves at render time, so files stay small and icons stay updatable by name across the registry.
- Use `normalizeIconName(raw)` for any user-supplied icon name — it handles `LucideLock`, `lucide-lock`, `lock-icon`, `Lock`, etc., all mapping to `lock`. Without normalization, `pen_create_node({ icon: "LucideLock" })` would silently fail.
- The generator script lives at `scripts/generate-lucide-registry.ts` with NO package.json script alias — call it via `npx tsx scripts/generate-lucide-registry.ts`. Document this in the doc tail when onboarding a new contributor; the alias was intentionally omitted (see `docs/lucide-icons.md`).

## Child DOX Index

No child `AGENTS.md` files. This folder is flat: `index.ts` + `lucide-registry.generated.ts`.

*Parent: `../AGENTS.md` (lib root). Siblings: `../agent/` (Agent layer — owns `pen_search_icons` + `pen_create_node` icon validation), `../canvas/` (Canvas state — owns the icon `Layer` shape + DOM island rendering).*
