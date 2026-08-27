# Design-System Components

UI components for the Design-System Registry.

## Files

- `DesignSystemPicker.tsx` — Modal picker shown when the user clicks
  "Design Systems…" in the View menu. Renders pack list (left) +
  live preview (right) + "Use this pack" CTA.
- `PackShowcase.tsx` — Live preview of components styled with a
  single pack's tokens. Uses an `<iframe srcDoc=...>` so each pack's
  `:root` tokens are perfectly isolated from the host app.

## Why iframe?

Each pack's `tokens.css` uses `:root { ... }`. To preview in the
host AgentCanvas (which has its own `--ac-*` palette), we'd have to
rewrite every `:root` to a wrapper class. The iframe gives us a real
`:root` for free, plus perfect isolation when switching packs.

## Where to mount

`DesignSystemPicker` is mounted in `src/app/page.tsx` (the only
user-visible route). The TopMenuBar (`src/components/canvas/TopMenuBar.tsx`)
has a "Design Systems…" item in the View menu that opens it.
