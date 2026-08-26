# Lucide Icon Integration — Evaluation & Architecture

**Status:** implemented (see "Surfaces touched" below)
**Goal:** pi-agent generated designs place *real Lucide icons* as first-class
`icon` nodes instead of hand-drawing custom icons with `path` polyline nodes.

## 1. Codebase scan — what existed before this change

| # | Surface | File | State before |
|---|---------|------|--------------|
| 1 | `.pen` format | `src/lib/pen/types.ts` | `PenIcon` node type **already spec'd** (`type:'icon'`, `library?: 'lucide'|'feather'|…`, `icon?: name`, `weight?`, `fill?`). `PEN_NODE_TYPES` includes `'icon'`. Nothing downstream consumed it. |
| 2 | Patch layer | `src/lib/canvas/patch.ts` | `library` / `icon` / `weight` already in the `toPenNodePartial` passthrough allowlist — patches carry icon fields unchanged. |
| 3 | Resolver | `src/lib/pen/resolve.ts` | `mapNodeType('icon')` → **`text`** layer; `mapTextContent` emitted the literal placeholder `[icon:lock]`. Icons degraded to placeholder text. |
| 4 | DOM renderer | `src/components/canvas/dom/{DomNode,islands,styleFor}.tsx` | No icon branch. |
| 5 | SVG export | `src/lib/canvas/export.ts` (`shapeToSvg`) | No icon case → empty element. |
| 6 | Server PNG render | `src/lib/canvas/render-to-png.ts` | Default case explicitly listed `icon` as a no-op. |
| 7 | Code export | `src/lib/canvas/serialize.ts` | No icon case → generic box div. |
| 8 | Agent tools | `src/lib/agent/tools.ts` | `pen_create_node` schema had **no `icon` type**. `pen_search_icons` (a misnomer — it *placed*, never searched) drew 34 hand-approximated icons as **degenerate polyline `path` shapes** (curves flattened, multi-contour icons mangled into one connected run with repeated points, e.g. `search` became a blob). |
| 9 | System prompt | `src/lib/agent/runner-legacy.ts` | Zero icon guidance — the agent hand-drew icons with `path` nodes or used emoji glyphs. |
| 10 | Dependency | `package.json` | `lucide-react@1.33.0` installed (2034 icons; every icon file exports raw `__iconNode` element data on a 24×24 viewBox). |

**The "custom icons" problem in one sentence:** the only icon path available to
the agent was `pen_search_icons`'s 34-entry polyline approximation table that
placed mangled `path` nodes — real icon quality was impossible.

## 2. Options evaluated

| Option | Verdict | Why |
|--------|---------|-----|
| **A.** Render `lucide-react` components inside the DOM renderer | ❌ rejected | The server surfaces (resvg PNG render, SVG export, HTML/React/Tailwind code generation) need raw geometry; React components don't cross those boundaries. Dynamic per-name imports also add async behavior to a synchronous resolver pipeline and complicate Turbopack bundling. |
| **B.** Pure-data icon registry generated from lucide's `__iconNode` | ✅ **chosen** | One pure-data registry serves *every* consumer: resolver, DOM islands, SVG export, server PNG render, code serializer, agent tools, and the system prompt. The `.pen` document stays symbolic (`library` + icon name) per the pen.dev spec, so files remain portable and updatable by name. |
| **C.** Fetch icons from a CDN (unpkg lucide static) | ❌ rejected | Runtime network dependency; breaks offline use, server-side determinism, and the agent's VLM critique loop. |

## 3. Chosen architecture

```
node_modules/lucide-react/dist/esm/icons/*.mjs   (2034 icons, __iconNode data)
        │
        ▼  scripts/generate-lucide-registry.ts  (curated allowlist, ~160 icons)
src/lib/icons/lucide-registry.generated.ts      (name → elements + category + keywords)
        │
        ▼  src/lib/icons/index.ts               (public API)
        ├─ getLucideIcon(name)                  exact + tolerant name resolution
        ├─ searchLucideIcons(query, opts)       fuzzy search over names+keywords
        ├─ lucidePromptCatalog()                compact catalog for the system prompt
        └─ lucideIconInnerSvg(name, opts)       server-safe SVG string emitter

Consumers:
  • resolver (resolve.ts)   → icon node → Layer type 'icon' (iconName, iconLibrary)
  • DOM renderer islands    → inline <svg viewBox="0 0 24 24"> island
  • export.ts (SVG)         → <g transform="translate scale"> + lucide elements
  • render-to-png.ts        → same <g> emission (resvg-compatible)
  • serialize.ts (code gen) → inline lucide-style <svg> markup
  • tools.ts                → pen_create_node type:'icon' + pen_search_icons (real search)
  • runner-legacy.ts        → ICON CONTRACT prompt section
  • html-import.ts          → class="lucide lucide-X" <svg> → icon node round-trip
```

**Data model:** a lucide icon is `[tag, attrs][]` (e.g.
`[["rect",{width:18,x:3,y:11,rx:2}],["path",{d:"M7 11V7a5 5 0 0 1 10 0v4"}]`)
plus the standard lucide paint attrs (`viewBox 0 0 24 24`, `fill:"none"`,
`stroke:"currentColor"`, `strokeWidth:2`, round caps/joins). Stroke color comes
from the layer (`stroke` → falls back to `textColor`/`fill`), so icons
participate in the token system (`$color.*` bindings) like any other node.

**Why a curated catalog instead of all 2034 icons:** the registry is imported
by the resolver, which runs on both client and server — a full catalog would
add ~300–400 KB to the client bundle. A curated ~160-icon catalog across 12
categories (≈25 KB) covers essentially every UI the agent draws, keeps the
system prompt compact, and can be regenerated/extended in one command.

## 4. Agent contract (what changed for the model)

1. **`pen_create_node` now accepts `type:"icon"`** with `icon:"lock"`,
   `width`/`height` (default 24), `stroke` (color), `strokeWidth` (default 2).
2. **`pen_search_icons` is now a real search tool**: pass a semantic query
   ("password security", "payment"), get ranked name matches with categories;
   optionally `x`/`y` to place the best match in the same call.
3. **ICON CONTRACT (system prompt)**: never hand-draw icons with `path` nodes;
   never use emoji as icons; place `icon` nodes and recolor via `stroke`.
4. `pen_insert_html` round-trip: inline `<svg class="lucide lucide-lock">`
   markup in pasted HTML converts to a native icon node.

## 5. Regenerating the registry

```bash
bun run scripts/generate-lucide-registry.ts   # or: npx tsx scripts/generate-lucide-registry.ts
```

The script reads the installed `lucide-react` package, extracts `__iconNode`
data for the curated allowlist in `scripts/generate-lucide-registry.ts`, and
rewrites `src/lib/icons/lucide-registry.generated.ts`. Add names to the
`CATEGORIES` table in the script to extend the catalog, then regenerate.
