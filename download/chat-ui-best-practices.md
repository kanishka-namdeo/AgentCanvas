# Modern Chat UI Best Practices — Research Brief (2026)

Synthesized from 5 web searches (shadcn June 2026 chat components, assistant-ui architecture, SetProduct "Designing AI chat interfaces" (May 2026), WCAG 2.5.8 Target Size, NN/g touch-targets, Tailwind drawer / bottom-sheet patterns, CopilotKit tool-rendering). Cross-referenced against the local AgentCanvas audit (`download/chat-ui-audit.md`, 71 findings).

---

## TL;DR — Top 12 Rules

1. **Minimum text size on the chat panel is 11px** (text-[11px]). Anything below (`text-[9px]`, `text-[10px]`, `text-[8px]`) is below the readability floor and must be either bumped up or hidden behind an explicit "details" affordance.
2. **Hover-only action reveals are an anti-pattern on touch**. Always pair `group-hover:opacity-100` with `focus-within:opacity-100` AND make the action discoverable on touch (`sm:opacity-0 sm:group-hover:opacity-100`, persistent on mobile).
3. **Minimum tap target = 24×24 CSS px (WCAG 2.5.8 AA), 44×44px preferred for primary actions** (Apple HIG). All icon buttons must be at least `h-6 w-6` (24px) — never `h-5` or smaller for tappable controls.
4. **Action button rows: max 3 inline, rest in a "⋯" overflow menu**. `gap-1` (4px) minimum, never `gap-0.5` (2px).
5. **Tool-call cards: render as a branded card with collapsed summary by default** — name + status + duration only. Args JSON hidden behind an expander with `max-h-48 overflow-y-auto`. Never raw JSON inline. (CopilotKit pattern, shadcn `Message` multi-part pattern.)
6. **Code blocks (`<pre>`): always `max-h-64 overflow-y-auto`**. Copy button sticky-top-right, `pr-12` reserved. No unbounded vertical expansion of the conversation.
7. **Density rules must be viewport-gated**. Compact density should auto-disable below `md` (768px); mobile always uses comfortable density regardless of user setting.
8. **Chat panel responsive sizing**: desktop side panel min 360px / 24% viewport; mobile uses a drawer / bottom-sheet / full-screen chat — never a squeezed 256px column.
9. **Status header rows: max 3 clusters visible** (model / context / connection). Anything more belongs in a tooltip or dropdown. Use `flex-wrap` + `min-w-0` on the row, `flex-shrink-0` on icons.
10. **Long-text safety on flex children**: every `flex-1` child whose text might be long MUST carry `min-w-0` + `truncate` (or `line-clamp-*`). Long unbroken strings (URLs, JSON, base64) MUST be wrapped with `break-all` / `overflow-wrap-anywhere`.
11. **Streaming UX**: reserve min-height for streaming block, fade-in new tokens, auto-scroll only when user is at bottom; show "Jump to latest" pill when scrolled up.
12. **Mobile chat panel**: side panel ≥ `md` (768px), drawer/sheet below. The composer is sticky-bottom with `min-h-[44px]` and auto-grow up to `max-h-[200px]`.

---

## 1. Message Row Anatomy

Reference apps (ChatGPT, Claude.ai, Cursor, v0.dev, bolt.new, Linear AI) converge on:
- **Header row**: avatar (28-32px) + name (12-13px, medium weight) + relative time (11px, muted) ONLY. Model badge inline ONLY for assistant, never for user.
- **Body**: text bubble, `max-w-prose` (65ch), `prose` styling, `text-sm` (14px) body, `text-[13px]` for compact.
- **Footer**: action row (copy / regenerate / etc.), `gap-1`, persistent on touch, hover on desktop.
- **NO inline metadata avalanche**: tokens, latency, cost, temperature live in a hover/expand tooltip, NOT in the visible row.

shadcn's June 2026 release (`Message`, `Bubble`, `Attachment`, `Marker`, `MessageScroller`) codifies this exact structure. The `Message` component has `MessagePart`s — text, reasoning, tool-call — each rendered independently so the message can mix types without crowding one row.

Audit violations: `AgentPanel.tsx` L1127-1170 (6+ clusters on header), L1900-1923 (turn footer at 9px with tool count + duration + tokens), `SessionHeader.tsx` L194-234 (5+ meta items at 10px).

---

## 2. Tool Call Rendering

Best-practice model (CopilotKit, shadcn `Message` parts, Vercel AI SDK):
- **Default (collapsed)**: branded card with icon + tool name (mono 11px) + status badge + duration (10px). 1 line, ~32px tall.
- **Click to expand**: shows result + truncated args preview (`max-h-32`, line-clamp-3) + "Show full args" / "Show full result" buttons.
- **Full args** open a modal or `<pre>` with `max-h-80 overflow-y-auto`.
- **Never raw JSON inline** — it pushes the conversation vertically and horizontally.

Audit violations: `AgentPanel.tsx` L2356 (no `max-h-*`), `Markdown.tsx` L38 (no `max-h-*`), `RunHistoryPanel.tsx` L745 (no `max-h-*`).

---

## 3. Reasoning / Thinking Traces

Best practice (Claude.ai, OpenAI o1, ChatGPT):
- **Default collapsed** ("Thinking… 12s" → click to expand).
- **Streaming expanded** is OK but auto-collapse once the final answer starts streaming.
- **Height-capped**: `max-h-40 overflow-y-auto` even when expanded.
- **Visual differentiation**: italic, muted text, subtle border / background tint.
- **Reserve min-height** while streaming to prevent layout shift.

Audit violations: `AgentPanel.tsx` L363 (`max-h-40` ✓ but auto-expanded by default during streaming — floods the chat).

---

## 4. Action Button Hygiene

- **Max 3 inline buttons**. Extras go in a "⋯" menu (Radix `DropdownMenu`).
- **Gap-1 minimum** (4px), never `gap-0.5` (2px).
- **Icon buttons min 24×24px** (`h-6 w-6` minimum, `p-1` outer + `h-4 w-4` icon = 24-32px target).
- **Persistent on touch, hover on desktop**: `opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100`.
- **Always include `focus-within`** so keyboard users can reveal the actions.

Audit violations: `AgentPanel.tsx` L1834-1889 (`gap-0.5`, hover-only), L1733-1766 (hover-only, no focus-within on parent).

---

## 5. Responsive Chat Panel

- **Desktop (≥ 1024px)**: side panel, `min-w-[360px]` / `min-w-[24vw]`, resizable, default ~28-32%.
- **Tablet (768-1023px)**: side panel with smaller min (300px), or overlay drawer.
- **Mobile (< 768px)**: bottom-sheet or full-screen chat. v0/bolt use full-screen chat with a "back to canvas" affordance; ChatGPT mobile uses bottom-sheet composer.
- **Tailwind v4 recipe**: `flex-col md:flex-row`, with chat as `hidden md:flex` side panel + `fixed inset-0 z-50 flex md:hidden` drawer that slides up.

Audit violations: `page.tsx` L858-895 (`minSize='20%'` desktop = 256px), no drawer pattern on mobile.

---

## 6. Composer (Input) Density

- **Sticky bottom** (`sticky bottom-0`).
- **Textarea auto-grow**: `min-h-[44px]` (WCAG min), `max-h-[200px]` (don't push the conversation off-screen).
- **Max 3 inline actions**: attach (left) / send (right) / stop (replaces send while running). Extras (model picker, tools toggle, queue) in a "⋯" menu.
- **Send button disabled state** when input is empty.
- **No double-padding**: container `p-2`, action row inside `px-1 pt-1`, no second border.

Audit violations: `AgentPanel.tsx` L1453 (`max-h-[120px]` too restrictive), L1287+L1537 (double-padding), L1551 (`gap-0.5` between attach buttons).

---

## 7. Metadata & Badges

- **Max 2 badges visible inline** on a message row (e.g. model + duration).
- **Full detail on hover/expand** via tooltip (Radix `Tooltip`).
- **Badge text min 10px**, height min 18px (`h-5`).
- **Avoid nested flex clusters** inside one row — each cluster adds visual noise.

Audit violations: `AgentPanel.tsx` L263-316 (`ModelContextStatus` — 4 nested clusters), L1136-1138 (`60+ tools` badge at `h-4` with 10px text).

---

## 8. Streaming UX

- **Reserve min-height** for the streaming block (`min-h-[2rem]` or pre-allocate the avatar + 2 lines).
- **Fade-in new tokens** (`animate-in fade-in`).
- **Auto-scroll only when user is at bottom** (within ~80px of the bottom).
- **"Jump to latest" pill** when scrolled up, `absolute bottom-3 right-3`.
- **Cursor / typing indicator** at the end of the stream while waiting for tokens.

Audit partial compliance: L1275 jump-to-latest pill ✓, but no min-height reservation on streaming blocks.

---

## 9. Long Content Handling

- **Code blocks**: `max-h-64 overflow-y-auto ac-hide-scrollbar`, `text-[11px]` minimum, `whitespace-pre-wrap break-all` for non-wrap-safe content. Copy button sticky-top-right.
- **Tool args**: collapsed by default, expand reveals `max-h-48` preview, full view in modal.
- **Long agent replies**: `prose prose-sm max-w-none`, no manual `max-w-prose` cap on the chat panel (chat is already narrow).
- **Tables**: `overflow-x-auto` wrapper, `text-[11px]` minimum, sticky header.
- **Inline code**: `px-1 py-0.5 rounded text-[11px]` (was 10px — bump).

---

## 10. Tailwind v4 Cheat Sheet

```css
/* Chat panel min width safety */
.min-w-chat { min-width: min(24vw, 360px); }

/* Flex long-text safety */
.flex-text-safe { @apply min-w-0 flex-1 truncate; }

/* Icon button min tap target */
.tap-target { @apply h-6 w-6 inline-flex items-center justify-center; }

/* Action row hover/touch pattern (Radix-friendly) */
.action-row { @apply flex items-center gap-1; }
.action-row > button {
  @apply h-6 w-6 p-1 rounded;
  /* mobile: persistent */
  @apply opacity-100;
  /* desktop: hover-reveal with keyboard fallback */
  @apply sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100;
  @apply sm:transition-opacity;
}

/* Compact density viewport gate */
@media (min-width: 768px) {
  [data-density="compact"] .text-xs { font-size: 11px; }
  /* etc. */
}

/* Code block max height */
.code-block { @apply max-h-64 overflow-y-auto ac-hide-scrollbar; }
```

---

## References

- shadcn/ui — "June 2026 - Components for Chat Interfaces" — https://ui.shadcn.com/docs/changelog/2026-06-chat-components — New `Message`, `Bubble`, `Attachment`, `Marker`, `MessageScroller` primitives; multi-part assistant messages (text + reasoning + tool-call).
- shadcn/ui — "AI SDK helpers" — https://ui.shadcn.com/docs/helpers/ai-sdk — Pattern for rendering assistant messages with multiple parts (text, reasoning, tool calls) using `writer`.
- assistant-ui — "Architecture" — https://www.assistant-ui.com/docs/architecture — Runtime provider + stylable chat primitives built on shadcn; the canonical "build-your-own ChatGPT" library.
- SetProduct — "Designing AI chat interfaces: Anatomy, patterns, pitfalls" (May 2026) — https://www.setproduct.com/blog/ai-chat-interface-ui-design — Full guide: message states, streaming, mobile vs desktop layouts, accessibility, anti-patterns.
- CopilotKit — "Tool Call Rendering" — https://docs.copilotkit.ai/langgraph-python/generative-ui/tool-rendering — "Instead of showing raw JSON, register a React component that draws a branded card for the call (arguments, live status, and the eventual result)."
- AG-UI Protocol — "Tools" — https://docs.ag-ui.com/concepts/tools — JSON Schema for tool args; events for tool-call start / args / end.
- W3C WAI — "Understanding SC 2.5.8: Target Size (Minimum) (Level AA)" — https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html — Min 24×24 CSS px with spacing; AA conformance.
- Zac Dickerson — "Size matters! Accessibility and Touch Targets" — https://medium.com/@zacdicko/size-matters-accessibility-and-touch-targets-56e942adc0cc — Apple 44×44px min; 8dp/16px spacing between targets.
- Smart Interface Design Patterns — "Mobile Accessibility Target Sizes Cheatsheet" — https://smart-interface-design-patterns.com/articles/accessible-tap-target-sizes — 27×27px for content links, 44×44px for icons.
- NN/g — "Touch Targets on Touchscreens" — https://www.nngroup.com/articles/touch-target-size — 1cm (~38px) min, larger for primary actions.
- Medium — "Mobile doesn't have hover, dude!" — https://medium.com/design-bootcamp/mobile-doesnt-have-hover-dude-b37e8e0b586e — Hover is a desktop-only affordance; mobile needs alternative reveals.
- UX Planet — "Hover Effect in UI Design: Tips & Tricks" — https://uxplanet.org/hover-effect-in-ui-design-tips-tricks-9c91d1a2bf22 — "Since hover effects won't work on touch devices, ensure important content is accessible without hover actions on mobile."
- NN/g — "Bottom Sheets: Definition and UX Guidelines" — https://www.nngroup.com/articles/bottom-sheet — Bottom sheet is the standard mobile pattern for contextual details / controls.
- Material.io — "Sheets: bottom" — https://m2.material.io/components/sheets-bottom — Modal bottom sheets as alternative to inline menus / dialogs on mobile.
- Tailwind CSS — "Drawers" — https://tailwindcss.com/plus/ui-blocks/application-ui/overlays/drawers — Side-panel drawer primitives.
- Starting Point UI — "Tailwind CSS Drawer" — https://startingpointui.com/components/drawer — "Side drawers drag horizontally, and below the `--breakpoint-` drawer theme token they render as the bottom sheet."
- Balsamiq — "17 button design best practices" — https://balsamiq.com/blog/button-design-best-practices — Button structure, copy, flow.
- LogRocket — "Designing button states" — https://blog.logrocket.com/ux-design/designing-button-states — Hover, focus, active, disabled state design.
