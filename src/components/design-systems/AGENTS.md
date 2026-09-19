# AGENTS.md — `src/components/design-systems/`

## Purpose

Design-system UI: the pack picker modal + live pack-preview showcase. Lets the user browse installed design-system packs and inspect what each pack's tokens produce on a real component set, isolated from the host app's own `--ac-*` palette.

## Ownership

- `DesignSystemPicker.tsx` — modal picker mounted in `src/app/app/page.tsx`. Triggered from the AppMenu's View → "Design Systems…" entry. Renders a pack list (left) + live preview (right) + "Use this pack" CTA. Writes the selected pack id to the settings store.
- `PackShowcase.tsx` — live preview of components styled with a single pack's tokens. Uses an `<iframe srcDoc=...>` so each pack's `:root` token block is perfectly isolated from the host app's `--ac-*` palette.

## Local Contracts

- The iframe is not optional: each pack's `tokens.css` uses `:root { ... }`. Previewing inside the host app (which has its own `--ac-*` palette) would require rewriting every `:root` to a wrapper class. The iframe gives a real `:root` for free, plus perfect isolation when switching packs.
- The pack list reads from `src/lib/design-systems/registry.json` — the single source of installed packs + their `importMap`. Do not hardcode pack ids or names in component code.
- `table.tsx` and `avatar.tsx` under `src/components/ui/` are KEPT because `registry.json`'s `importMap` string-references them — deleting them breaks the showcase at build time.

## Work Guidance

- When adding a new pack: register it in `src/lib/design-systems/registry.json` first, then verify both the picker list and the showcase preview render it.
- When changing the picker layout: keep the list-on-left / preview-on-right split — parity with VS Code's extension picker.

## Verification

- `bunx tsc --noEmit` — typecheck.
- `bun run lint` — ESLint.
- Manual: open AppMenu → View → Design Systems…; pick a pack; verify the showcase re-renders inside the iframe without affecting the host chrome; verify "Use this pack" applies the pack tokens to the canvas (via `PackTokensStyle.tsx`).

## Mistakes & Lessons

### Failure Modes

- Check `registry.json`'s `importMap` still resolves every referenced primitive (`table`, `avatar`) before deleting a `src/components/ui/` primitive — the showcase breaks at build time, not runtime.
- Check that any new pack's `tokens.css` uses `:root` (not a wrapper class) — the showcase iframe relies on this for free isolation.
- Check that picker list reads the live registry, not a stale imported snapshot — packs added at runtime must appear without a reload.

### Lessons Learned

- Do not preview packs by overriding the host app's `--ac-*` palette — use the iframe `srcDoc` pattern so each pack's `:root` block is the only one in scope.
- Do not mutate the host DOM to apply a preview pack — only `PackTokensStyle.tsx` injects the active pack into the canvas subtree.

## Child DOX Index

No child AGENTS.md files in this folder.

*Siblings: `../canvas/AGENTS.md` (Canvas UI), `../sessions/AGENTS.md` (Session UI), `../ui/AGENTS.md` (shadcn/ui primitives).*
